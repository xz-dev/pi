#!/usr/bin/env python3
# SPDX-License-Identifier: BSD-3-Clause
"""Provider startup/configuration; test verdicts remain in the shared vm-guest.py."""
import hashlib
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path.cwd()
REQUEST = ROOT / '.procward-vm-request.json'
MANIFEST = Path('/run/procward-vm/manifest.json')


def call(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def proof():
    request = json.loads(REQUEST.read_text())
    boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    if not request['host_boot_id'] or boot == request['host_boot_id'] or os.getuid() != 0:
        raise RuntimeError('provider requires root in a separate guest kernel')
    if subprocess.check_output(['git', '-c', f'safe.directory={ROOT}', 'rev-parse', 'HEAD'], text=True).strip() != request['source']:
        raise RuntimeError('guest source commit mismatch')
    for name, expected in request['files'].items():
        if hashlib.sha256((ROOT / name).read_bytes()).hexdigest() != expected:
            raise RuntimeError(f'guest source mismatch: {name}')
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    # This is created in the independently booted guest, never installed on the host.
    MANIFEST.write_text(json.dumps(request))
    os.environ['PROCWARD_VM_HOST_BOOT_ID'] = request['host_boot_id']
    return request


def toolchain(target):
    os.environ['PATH'] = str(Path.home() / '.cargo/bin') + ':' + os.environ['PATH']
    os.environ['RUSTUP_HOME'] = str(Path.home() / '.rustup')
    os.environ['CARGO_HOME'] = str(Path.home() / '.cargo')
    key = target.upper().replace('-', '_')
    if 'musl' in target:
        os.environ[f'CARGO_TARGET_{key}_RUSTFLAGS'] = '-C target-feature=+crt-static -C link-self-contained=yes'
        # The native driver supplies musl/GCC library paths for HOST build scripts.
        os.environ[f'CARGO_TARGET_{key}_LINKER'] = 'cc'
    elif target.startswith('riscv64'):
        os.environ[f'CARGO_TARGET_{key}_LINKER'] = 'riscv64-linux-gnu-gcc'
    # No emulator/container runner: these are official native target tools/binaries.
    os.environ.pop(f'CARGO_TARGET_{key}_RUNNER', None)
    os.environ['CARGO_NET_OFFLINE'] = 'true'
    for key in list(os.environ):
        if key.startswith('GITHUB_'):
            del os.environ[key]


def inspect_abi(binary, target):
    details = subprocess.check_output(['readelf', '-h', '-l', '-d', '--version-info', str(binary)], text=True)
    if target.startswith('riscv64') and ('RISC-V' not in details or 'double-float ABI' not in details):
        raise RuntimeError(f'wrong RISC-V machine/ABI: {binary}')
    if 'musl' in target:
        if 'NEEDED' in details or 'INTERP' in details:
            raise RuntimeError(f'official musl executable is not fully static: {binary}')
        print(f'ABI {binary}: {target}, fully static', flush=True)
    else:
        loader = {'x86_64': '/lib64/ld-linux-x86-64.so.2',
                  'aarch64': '/lib/ld-linux-aarch64.so.1',
                  'riscv64gc': '/lib/ld-linux-riscv64-lp64d.so.1'}[target.split('-')[0]]
        versions = [tuple(int(part or 0) for part in match)
                    for match in re.findall(r'GLIBC_(\d+)\.(\d+)(?:\.(\d+))?', details)]
        # Ubuntu 24.04's original native/cross sysroot is glibc 2.39. Native
        # guest builds must not silently raise that release ABI requirement.
        if loader not in details or not versions or max(versions) > (2, 39, 0):
            raise RuntimeError(f'GNU loader/glibc requirement exceeds the original Ubuntu ABI: {binary}')
        print(f'ABI {binary}: loader={loader}, max GLIBC={max(versions)}', flush=True)


def inventory(target, profile, hazard):
    call('cargo', 'build', '--locked', '--offline', '--profile', profile,
         '--target', target, '--bins', '--examples')
    built = subprocess.check_output(['cargo', 'test', '--locked', '--offline', '--profile', profile,
                                     '--target', target, '--all-targets', '--no-run', '--message-format=json'], text=True)
    binaries = []
    for line in built.splitlines():
        item = json.loads(line)
        if (item.get('reason') == 'compiler-artifact' and item.get('executable')
                and item['profile']['test'] and 'example' not in item['target']['kind']
                and Path(item['executable']).name.startswith('hazard-') == hazard):
            binaries.append(item['executable'])
    if not binaries:
        raise RuntimeError('no matching guest test executables')
    folder = 'debug' if profile == 'dev' else profile
    for binary in [ROOT / 'target' / target / folder / 'procward',
                   ROOT / 'target' / target / folder / 'examples/fixture']:
        inspect_abi(binary, target)
    return sorted(set(binaries))


def isolate_network():
    # Keep only loopback and the provider's SSH control/transfer channel. No DNS,
    # package mirror, metadata endpoint, host service, or new guest-originated flow.
    peer = str(ipaddress.ip_address(os.environ['SSH_CONNECTION'].split()[0]))
    family = 'ip6' if ':' in peer else 'ip'
    rules = f'''table inet procward_test {{
 chain input {{ type filter hook input priority -10; policy drop;
   iifname "lo" accept
   {family} saddr {peer} tcp dport 22 accept
 }}
 chain output {{ type filter hook output priority -10; policy drop;
   oifname "lo" accept
   {family} daddr {peer} tcp sport 22 ct state established accept
 }}
 chain forward {{ type filter hook forward priority -10; policy drop; }}
}}
'''
    call('nft', '-f', '-', input=rules, text=True)
    call('nft', 'list', 'table', 'inet', 'procward_test')


def oom_kills():
    return int(dict(line.split() for line in Path('/proc/vmstat').read_text().splitlines())['oom_kill'])


def main():
    request = proof()
    target, mode = request['target'], request['mode']
    hazard = mode == 'hazard'
    profile = 'dist' if mode == 'release' else ('release' if target.startswith('riscv64') else 'dev')
    if sys.argv[1] == 'prepare':
        if sys.argv[2:] != [target, mode]:
            raise RuntimeError('workflow/request target or mode mismatch')
        expected_arch = target.split('-')[0].replace('riscv64gc', 'riscv64')
        if os.uname().machine != expected_arch:
            raise RuntimeError('wrong guest architecture (no ABI emulation permitted here)')
        installer = '/var/tmp/procward-rustup.sh'
        call('curl', '--proto', '=https', '--tlsv1.2', '-fsSL', 'https://sh.rustup.rs', '-o', installer)
        call('sh', installer, '-y', '--profile', 'minimal', '--default-host', target,
             '--default-toolchain', 'stable', '--no-modify-path')
        toolchain(target)
        call('rustc', '-vV')
        host = subprocess.check_output(['rustc', '-vV'], text=True).split('host: ')[1].splitlines()[0]
        if host != target:
            raise RuntimeError(f'official target mismatch: {host} != {target}')
        env = dict(os.environ, CARGO_NET_OFFLINE='false')
        call('cargo', 'fetch', '--locked', '--target', target, env=env)
        if mode == 'release':
            call('python3', '.github/scripts/build-dist.py', target, '--measure')
            os.environ['CARGO_PROFILE_DIST_OPT_LEVEL'] = (ROOT / 'artifacts' / target / 'opt-level').read_text()
        executables = inventory(target, profile, hazard)
        (MANIFEST.parent / 'executables.json').write_text(json.dumps(executables))
        return
    if sys.argv[1:] != ['run']:
        raise RuntimeError('expected prepare or run')
    toolchain(target)
    # Configure only the proved, disposable guest. A missing controller is a
    # provisioning failure, never credit for a cgroup-available suite.
    cgroup = Path('/sys/fs/cgroup')
    if not (cgroup / 'cgroup.controllers').exists():
        call('mount', '-t', 'cgroup2', 'none', str(cgroup))
    available = set((cgroup / 'cgroup.controllers').read_text().split())
    if not {'pids', 'memory'} <= available:
        raise RuntimeError('guest requires unified cgroup v2 with pids/memory controllers')
    (cgroup / 'cgroup.subtree_control').write_text('+pids +memory')
    Path('/proc/sys/kernel/pid_max').write_text('4096')
    mem_kib = int(Path('/proc/meminfo').read_text().split('MemTotal:')[1].split()[0])
    if os.cpu_count() != 2 or not 1_800_000 <= mem_kib <= 2_097_152:
        raise RuntimeError('provider did not apply the fixed 2CPU/2GiB budget')
    isolate_network()
    before = oom_kills()
    if mode == 'ci':
        # Dev-profile warm rebuild plus summary artifacts; seconds on a hot cache.
        call('python3', '.github/scripts/build-dist.py', target)
    # All heavy builds (the release measurement pass and its dist-profile
    # inventory compile) finished inside the separately sized setup phase; the
    # runtime deadline bounds test execution, exactly as it does for hazard.
    executables = json.loads((MANIFEST.parent / 'executables.json').read_text())
    manifest = dict(request, executables=executables, modes=['cgroup'] if hazard else ['cgroup', 'fallback'],
                    hazard=hazard,
                    filters=['rolling_deep_wide_without_cgroup_survives_no_descriptor_shortcut'] if hazard else [],
                    skip=[], test_budget=5 if hazard else 60, cwd=str(ROOT))
    MANIFEST.write_text(json.dumps(manifest))
    # A fresh run must not inherit a previous run's records.
    open('/tmp/procward-vm-records.log', 'w').close()
    spec = importlib.util.spec_from_file_location('guest', ROOT / 'ci/vm-guest.py')
    guest = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(guest)
    # The shared driver emits its boot/test/complete records and exits zero only
    # after every selected case. An exception/nonzero exit cannot reach packaging.
    try:
        guest.main()
    except SystemExit as error:
        if error.code not in (None, 0):
            raise
    if oom_kills() != before:
        raise RuntimeError('guest OOM kill during runtime')
    if mode == 'release':
        call('python3', '.github/scripts/build-dist.py', target, '--package')
        for name in ['procward', 'procward-debug']:
            inspect_abi(ROOT / 'artifacts' / target / name, target)
    guest.emit(request['nonce'], kind='provider-complete', source=request['source'], target=target,
               oom_kills=oom_kills() - before, native=True, mode=mode)


if __name__ == '__main__':
    main()
