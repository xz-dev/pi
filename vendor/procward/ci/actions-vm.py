#!/usr/bin/env python3
# SPDX-License-Identifier: BSD-3-Clause
"""Copy-only vmactions host boundary. Never executes a Linux product on the host."""
import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import subprocess
import sys

REQUEST = Path('.procward-vm-request.json')


def source_files():
    names = subprocess.check_output(['git', 'ls-files', '-z']).decode().split('\0')
    return {name: hashlib.sha256(Path(name).read_bytes()).hexdigest()
            for name in names if name}


def validate(records, request, status):
    boots = [r for r in records if r.get('kind') == 'boot']
    tests = [r for r in records if r.get('kind') == 'test']
    done = [r for r in records if r.get('kind') == 'complete']
    stages = [r for r in records if r.get('kind') == 'provider-complete']
    if status or len(boots) != 1 or boots[0]['boot_id'] == request['host_boot_id']:
        raise ValueError('VM failed or separate-kernel boot proof missing')
    if len(done) != 1 or len(stages) != 1 or not tests:
        raise ValueError('missing test/provider completion')
    if request.get('mode') == 'hazard':
        if (len(tests) != 1 or tests[0]['mode'] != 'cgroup'
                or not tests[0]['binary'].startswith('hazard-')
                or tests[0]['test'] != 'rolling_deep_wide_without_cgroup_survives_no_descriptor_shortcut'):
            raise ValueError('hazard VM must run only its single ignored regression')
    elif request.get('mode') in ('ci', 'release'):
        if ({r['mode'] for r in tests} != {'cgroup', 'fallback'}
                or any(r['binary'].startswith('hazard-') for r in tests)):
            raise ValueError('ordinary suites require both modes and must exclude the hazard')
    reported = [[r['mode'], r['binary'], r['test'], r['verdict'], r['status']] for r in tests]
    if done[0]['results'] != reported or done[0]['total'] != len(tests):
        raise ValueError('inconsistent test inventory/completion')
    if (done[0]['failed'] or done[0].get('leftover_root_groups')
            or any(r['verdict'] not in ('pass', 'not-applicable') or r['rescue']
                   or r['leftovers'] or not r['membership'] or r['status'] != 0 for r in tests)):
        raise ValueError('guest test failure/rescue/leftovers')
    stage = stages[0]
    if (stage['source'] != request['source'] or stage['target'] != request['target']
            or stage['oom_kills'] != 0):
        raise ValueError('source/target mismatch or guest OOM')


def vm_processes(data_dir):
    """Bind the watchdog to this action's QEMU, not other jobs/process names."""
    owned = []
    for proc in Path('/proc').glob('[0-9]*'):
        try:
            args = (proc / 'cmdline').read_bytes().split(b'\0')
            if (args and Path(os.fsdecode(args[0])).name.startswith('qemu-system-')
                    and any(data_dir.encode() in arg for arg in args)):
                start = (proc / 'stat').read_text().rsplit(')', 1)[1].split()[19]
                fd = os.pidfd_open(int(proc.name))
                # Rebind after opening: a reused PID/cmdline cannot authorize us.
                identity = dict(fd=fd, pid=int(proc.name), start=start, args=args)
                try:
                    check_identity(identity)
                except Exception:
                    os.close(fd)
                    raise
                owned.append(identity)
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
    if len(owned) != 1:
        for identity in owned:
            os.close(identity['fd'])
        raise RuntimeError('expected exactly one provider QEMU in the dedicated data-dir')
    return owned


def check_identity(identity):
    signal.pidfd_send_signal(identity['fd'], 0)
    proc = Path('/proc') / str(identity['pid'])
    start = (proc / 'stat').read_text().rsplit(')', 1)[1].split()[19]
    args = (proc / 'cmdline').read_bytes().split(b'\0')
    fdinfo = Path(f'/proc/self/fdinfo/{identity["fd"]}').read_text().splitlines()
    if (start != identity['start'] or args != identity['args']
            or f'Pid:\t{identity["pid"]}' not in fdinfo):
        raise RuntimeError('provider process identity changed')


def listeners(identity):
    check_identity(identity)
    inodes = set()
    for fd in (Path('/proc') / str(identity['pid']) / 'fd').iterdir():
        try:
            link = os.readlink(fd)
        except FileNotFoundError:
            continue
        if link.startswith('socket:['):
            inodes.add(link[8:-1])
    result = set()
    for filename, family in [('tcp', socket.AF_INET), ('tcp6', socket.AF_INET6)]:
        for line in (Path('/proc/net') / filename).read_text().splitlines()[1:]:
            fields = line.split()
            if fields[3] != '0A' or fields[9] not in inodes:
                continue
            address, port = fields[1].split(':')
            raw = bytes.fromhex(address)
            raw = b''.join(raw[i:i + 4][::-1] for i in range(0, len(raw), 4))
            result.add((socket.inet_ntop(family, raw), int(port, 16)))
    check_identity(identity)
    return result


def loopback_only(identity, provider):
    """Remove this VM's extra SSH forwards through its already-local HMP monitor."""
    args = [os.fsdecode(arg) for arg in identity['args']]
    monitor = args[args.index('-monitor') + 1].split(',')[0].split(':')
    if len(monitor) != 3 or monitor[:2] != ['tcp', '127.0.0.1']:
        raise RuntimeError('provider monitor is not a supported loopback TCP endpoint')
    monitor_port = int(monitor[2])
    config = dict(line.split(None, 1) for line in subprocess.check_output(
        ['ssh', '-G', provider], text=True, stderr=subprocess.DEVNULL).splitlines() if ' ' in line)
    if config['hostname'] != '127.0.0.1':
        raise RuntimeError('provider SSH adapter must use loopback')
    ssh_port = int(config['port'])
    before = listeners(identity)
    if not {('127.0.0.1', monitor_port), ('127.0.0.1', ssh_port)} <= before:
        raise RuntimeError('bound provider lacks its own loopback SSH/monitor listeners')
    with socket.create_connection(('127.0.0.1', monitor_port), timeout=10) as connection:
        def prompt():
            response = b''
            while not response.endswith(b'(qemu) '):
                chunk = connection.recv(4096)
                if not chunk or len(response) > 65536:
                    raise RuntimeError('provider monitor response missing/oversized')
                response += chunk
            return response.decode(errors='replace')
        prompt()
        for address, port in before:
            if not ipaddress.ip_address(address).is_loopback:
                # Only the known SSH forwards are mutable. Unexpected listeners
                # require a provider review, not a broad socket/process kill.
                if port != ssh_port:
                    raise RuntimeError(f'unexpected non-loopback provider listener: {address}:{port}')
                check_identity(identity)
                command = f'hostfwd_remove tcp:{address}:{port}'
                connection.sendall((command + '\n').encode())
                response = prompt()
                if 'not found' in response.lower() or 'error' in response.lower():
                    raise RuntimeError('provider refused SSH forward removal')
    after = listeners(identity)
    if (not {('127.0.0.1', monitor_port), ('127.0.0.1', ssh_port)} <= after
            or any(not ipaddress.ip_address(address).is_loopback for address, _ in after)):
        raise RuntimeError('provider listeners are not loopback-only after removal')
    subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', provider, 'true'],
                   check=True, timeout=20)
    print('Provider loopback-only listener verification passed', sorted(after), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    prepare = sub.add_parser('prepare')
    prepare.add_argument('target')
    prepare.add_argument('mode', choices=['ci', 'release', 'hazard'])
    run = sub.add_parser('run')
    run.add_argument('provider', choices=['ubuntu', 'alpine'])
    run.add_argument('timeout', type=int)
    run.add_argument('data_dir')
    args = parser.parse_args()
    if args.command == 'prepare':
        subprocess.run(['git', 'diff', '--exit-code', 'HEAD'], check=True)
        request = dict(nonce=secrets.token_hex(16),
                       host_boot_id=Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
                       source=subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
                       files=source_files(), target=args.target, mode=args.mode)
        REQUEST.write_text(json.dumps(request, indent=2) + '\n')
        return
    if args.timeout <= 0:
        parser.error('timeout must be positive')
    request = json.loads(REQUEST.read_text())
    pidfds = vm_processes(os.path.abspath(args.data_dir))
    output = Path('artifacts') / request['target']
    output.mkdir(parents=True, exist_ok=True)
    log = output / 'vm-console.txt'
    status = None
    try:
        loopback_only(pidfds[0], args.provider)
        # vmactions must first reach SSH and copy source. Remove its extra binds
        # immediately afterwards, before our packages/toolchain/build setup.
        packages = ('apk add --no-cache python3 curl ca-certificates build-base binutils git bash nftables'
                    if args.provider == 'alpine' else
                    'sh "$GITHUB_WORKSPACE/ci/ubuntu-apt-mirror.sh" && '
                    'apt-get update && apt-get install -y --no-install-recommends python3 curl ca-certificates gcc libc6-dev binutils git nftables')
        setup = (f'test "$(cat /proc/sys/kernel/random/boot_id)" != "{request["host_boot_id"]}" '
                 f'&& test "$(id -u)" = 0 && {packages} '
                 f'&& cd "$GITHUB_WORKSPACE" && python3 ci/actions-guest.py prepare {request["target"]} {request["mode"]}')
        # Setup (packages + build + packaging) is transport, not product deadline;
        # it is sized per target/mode: release builds with measurement run 1.5-2x
        # the dev build, and emulated riscv64 doubles again.
        release = request['mode'] == 'release'
        setup_budget = (7200 if release else 3600) if request['target'].startswith('riscv64') \
            else (7200 if release else 2700)
        subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', args.provider, setup],
                       check=True, timeout=setup_budget)
        check_identity(pidfds[0])
        # The deadline bounds only the runtime command itself. Transport/handshake
        # setup is not product deadline: the guest enforces the per-case budget
        # (5s for hazard) with its own hard cgroup.kill timeout, so a stuck case
        # can never exceed it even when this host budget is larger.
        with log.open('wb') as stream:
            try:
                status = subprocess.run(
                    ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', args.provider,
                     'cd "$GITHUB_WORKSPACE" && python3 ci/actions-guest.py run'],
                    stdout=stream, stderr=subprocess.STDOUT, timeout=args.timeout).returncode
            except subprocess.TimeoutExpired:
                raise RuntimeError('HOST WATCHDOG RESCUE: VM runtime deadline exceeded')
        records = []
        prefix = 'PROCWARD-VM ' + request['nonce'] + ' '

        def harvest(source):
            found = []
            for line in source.splitlines():
                print(line)
                if line.startswith(prefix):
                    records.append(json.loads(line[len(prefix):]))
                    found.append(line)
            return found

        # The redirected stream can miss final records when the SSH channel closes
        # right after the guest prints them. The guest also persists the same lines
        # to a durable log; prefer that authoritative copy once the VM is done.
        harvested = harvest(log.read_text(errors='replace'))
        guest_log = output / 'vm-guest-records.log'
        with guest_log.open('wb') as stream:
            subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
                            args.provider, 'cat /tmp/procward-vm-records.log'],
                           stdout=stream, check=False, timeout=60)
        replay = guest_log.read_text(errors='replace')
        if len(replay.splitlines()) > len(harvested):
            records.clear()
            harvest(replay)
        (output / 'vm-results.json').write_text(json.dumps(records, indent=2) + '\n')
        validate(records, request, status)
        # Read only an explicit, flat list. Never copy the guest workspace back.
        names = ['summary.md', 'measurements.json', 'dependencies.txt', 'opt-level']
        if request['mode'] == 'release':
            names += ['procward', 'procward-debug',
                      f"procward-{request['target']}.zip", f"procward-{request['target']}-debug.zip"]
        if request['mode'] != 'hazard':
            for name in names:
                with (output / name).open('wb') as stream:
                    subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
                                    args.provider, f'cat "$GITHUB_WORKSPACE/artifacts/{request["target"]}/{name}"'],
                                   stdout=stream, check=True, timeout=60)
    finally:
        # Close the VM even on success; an SSH disconnect is not a process-tree teardown.
        for identity in pidfds:
            fd = identity['fd']
            try:
                check_identity(identity)
                signal.pidfd_send_signal(fd, signal.SIGKILL)
            except ProcessLookupError:
                pass
            finally:
                os.close(fd)
        if log.exists() and status is None:
            print(log.read_text(errors='replace'), file=sys.stderr)


if __name__ == '__main__':
    main()
