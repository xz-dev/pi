#!/usr/bin/env python3
# SPDX-License-Identifier: BSD-3-Clause
"""Host-safe regression checks: synthetic records/ELF text, never Linux fixtures."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
from unittest.mock import MagicMock, patch
import unittest

spec = importlib.util.spec_from_file_location('actions_vm', Path(__file__).with_name('actions-vm.py'))
vm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vm)
guest_spec = importlib.util.spec_from_file_location('actions_guest', Path(__file__).with_name('actions-guest.py'))
guest = importlib.util.module_from_spec(guest_spec)
guest_spec.loader.exec_module(guest)


class Records(unittest.TestCase):
    def setUp(self):
        self.request = dict(host_boot_id='host', source='commit', target='exact-target')
        self.test = dict(kind='test', mode='cgroup', binary='test-binary', test='case',
                         verdict='pass', status=0, membership=True, rescue=False, leftovers=[])
        self.records = [dict(kind='boot', boot_id='guest'), self.test,
                        dict(kind='complete', total=1, failed=0,
                             results=[['cgroup', 'test-binary', 'case', 'pass', 0]],
                             leftover_root_groups=[]),
                        dict(kind='provider-complete', source='commit', target='exact-target', oom_kills=0)]

    def test_complete_native_run(self):
        vm.validate(self.records, self.request, 0)

    def test_fail_closed_boundaries(self):
        for change in ['host', 'missing-boot', 'missing-test', 'missing-complete',
                       'missing-provider', 'duplicate-complete', 'inventory', 'failure',
                       'rescue', 'leftovers', 'membership', 'oom', 'source', 'target']:
            with self.subTest(change=change):
                records = copy.deepcopy(self.records)
                if change == 'host':
                    records[0]['boot_id'] = 'host'
                elif change.startswith('missing-'):
                    index = {'missing-boot': 0, 'missing-test': 1,
                             'missing-complete': 2, 'missing-provider': 3}[change]
                    records.pop(index)
                elif change == 'duplicate-complete':
                    records.append(records[2])
                elif change == 'inventory':
                    records[2]['total'] += 1
                elif change == 'failure':
                    records[2]['failed'] = 1
                elif change == 'rescue':
                    records[1]['rescue'] = True
                elif change == 'leftovers':
                    records[1]['leftovers'] = ['orphan']
                elif change == 'membership':
                    records[1]['membership'] = False
                elif change == 'oom':
                    records[3]['oom_kills'] = 1
                else:
                    records[3][change] = 'mismatch'
                with self.assertRaises(ValueError):
                    vm.validate(records, self.request, 0)

    def test_ordinary_requires_both_modes_and_excludes_hazard(self):
        self.request['mode'] = 'ci'
        with self.assertRaisesRegex(ValueError, 'ordinary suites require both modes'):
            vm.validate(self.records, self.request, 0)
        fallback = dict(self.test, mode='fallback')
        self.records.insert(2, fallback)
        self.records[3]['total'] = 2
        self.records[3]['results'].append(['fallback', 'test-binary', 'case', 'pass', 0])
        vm.validate(self.records, self.request, 0)
        self.test['binary'] = 'hazard-123'
        with self.assertRaisesRegex(ValueError, 'must exclude the hazard'):
            vm.validate(self.records, self.request, 0)

    def test_hazard_accepts_only_the_single_ignored_regression(self):
        self.request['mode'] = 'hazard'
        name = 'rolling_deep_wide_without_cgroup_survives_no_descriptor_shortcut'
        self.test.update(binary='hazard-123', test=name)
        self.records[2]['results'] = [['cgroup', 'hazard-123', name, 'pass', 0]]
        vm.validate(self.records, self.request, 0)
        self.records.insert(2, dict(self.test, test='other_case'))
        with self.assertRaisesRegex(ValueError, 'only its single ignored regression'):
            vm.validate(self.records, self.request, 0)

    def test_nonzero_exit_is_not_a_pass(self):
        with self.assertRaises(ValueError):
            vm.validate(self.records, self.request, 7)


class ToolchainConfiguration(unittest.TestCase):
    def test_all_musl_targets_use_native_cc_and_keep_static_flags(self):
        for arch in ['x86_64', 'aarch64', 'riscv64gc']:
            target = f'{arch}-unknown-linux-musl'
            key = target.upper().replace('-', '_')
            with self.subTest(target=target):
                with (patch.dict(guest.os.environ, {'PATH': '/usr/bin', 'HOME': '/guest/root'}, clear=True),
                      patch.object(guest.subprocess, 'check_output', return_value='/official-rust') as probe):
                    guest.toolchain(target)
                    self.assertEqual(guest.os.environ[f'CARGO_TARGET_{key}_LINKER'], 'cc')
                    self.assertNotIn('rust-lld', guest.os.environ[f'CARGO_TARGET_{key}_LINKER'])
                    self.assertEqual(guest.os.environ[f'CARGO_TARGET_{key}_RUSTFLAGS'],
                                     '-C target-feature=+crt-static -C link-self-contained=yes')
                    probe.assert_not_called()

    def test_gnu_linker_and_flags_are_unchanged(self):
        for arch in ['x86_64', 'aarch64', 'riscv64gc']:
            target = f'{arch}-unknown-linux-gnu'
            key = target.upper().replace('-', '_')
            initial = {'PATH': '/usr/bin', 'HOME': '/guest/root',
                       f'CARGO_TARGET_{key}_LINKER': 'existing-gnu-linker',
                       f'CARGO_TARGET_{key}_RUSTFLAGS': 'existing-gnu-flags'}
            with self.subTest(target=target):
                with (patch.dict(guest.os.environ, initial, clear=True),
                      patch.object(guest.subprocess, 'check_output') as probe):
                    guest.toolchain(target)
                    expected = 'riscv64-linux-gnu-gcc' if arch == 'riscv64gc' else 'existing-gnu-linker'
                    self.assertEqual(guest.os.environ[f'CARGO_TARGET_{key}_LINKER'], expected)
                    self.assertEqual(guest.os.environ[f'CARGO_TARGET_{key}_RUSTFLAGS'], 'existing-gnu-flags')
                    probe.assert_not_called()


class GuestBuildBoundary(unittest.TestCase):
    def test_hazard_and_ordinary_inventories_are_disjoint_no_run_builds(self):
        def artifact(name, kind):
            return dict(reason='compiler-artifact', executable=f'/guest/{name}',
                        profile=dict(test=True), target=dict(kind=[kind]))
        built = '\n'.join(json.dumps(row) for row in [artifact('normal-123', 'test'),
                                                      artifact('hazard-456', 'test'),
                                                      artifact('fixture-789', 'example')])
        for hazard, expected in [(False, ['/guest/normal-123']), (True, ['/guest/hazard-456'])]:
            with self.subTest(hazard=hazard):
                with (patch.object(guest, 'call') as build,
                      patch.object(guest.subprocess, 'check_output', return_value=built) as compile_tests,
                      patch.object(guest, 'inspect_abi')):
                    self.assertEqual(guest.inventory('x86_64-unknown-linux-gnu', 'dev', hazard), expected)
                self.assertIn('--bins', build.call_args.args)
                self.assertIn('--examples', build.call_args.args)
                self.assertIn('--no-run', compile_tests.call_args.args[0])

    def test_gnu_riscv_loader_float_abi_and_glibc_ceiling(self):
        valid = 'Machine: RISC-V\nFlags: double-float ABI\n/lib/ld-linux-riscv64-lp64d.so.1\nName: GLIBC_2.39\n'
        with (patch.object(guest.subprocess, 'check_output', return_value=valid), patch('builtins.print')):
            guest.inspect_abi(Path('/synthetic/executable'), 'riscv64gc-unknown-linux-gnu')
        for invalid in [valid.replace('2.39', '2.40'), valid.replace('double-float ABI', 'soft-float ABI'),
                        valid.replace('lp64d.so.1', 'lp64.so.1')]:
            with self.subTest(invalid=invalid):
                with patch.object(guest.subprocess, 'check_output', return_value=invalid):
                    with self.assertRaises(RuntimeError):
                        guest.inspect_abi(Path('/synthetic/executable'), 'riscv64gc-unknown-linux-gnu')

    def test_musl_must_be_fully_static(self):
        for suffix in ['NEEDED libc.so', 'INTERP /lib/ld-musl-riscv64.so.1']:
            with patch.object(guest.subprocess, 'check_output', return_value='RISC-V double-float ABI ' + suffix):
                with self.assertRaisesRegex(RuntimeError, 'not fully static'):
                    guest.inspect_abi(Path('/synthetic/executable'), 'riscv64gc-unknown-linux-musl')


class NetworkBoundary(unittest.TestCase):
    def test_remove_only_this_vms_non_loopback_ssh_forward(self):
        identity = dict(args=[b'qemu-system-x86_64', b'-monitor',
                              b'tcp:127.0.0.1:4444,server,nowait'])
        required = {('127.0.0.1', 4444), ('127.0.0.1', 2222)}
        connection = MagicMock()
        connection.__enter__.return_value = connection
        connection.recv.side_effect = [b'(qemu) ', b'host forwarding rule removed\r\n(qemu) ']
        with (patch.object(vm, 'listeners', side_effect=[required | {('192.0.2.1', 2222)}, required]),
              patch.object(vm, 'check_identity') as identity_check,
              patch.object(vm.subprocess, 'check_output', return_value='hostname 127.0.0.1\nport 2222\n'),
              patch.object(vm.subprocess, 'run') as ssh,
              patch.object(vm.socket, 'create_connection', return_value=connection)):
            vm.loopback_only(identity, 'ubuntu')
        connection.sendall.assert_called_once_with(b'hostfwd_remove tcp:192.0.2.1:2222\n')
        identity_check.assert_called_once_with(identity)
        self.assertEqual(ssh.call_args.args[0][-1], 'true')

    def test_reject_non_loopback_control_before_monitor_access(self):
        identity = dict(args=[b'qemu-system-x86_64', b'-monitor',
                              b'tcp:127.0.0.1:4444,server,nowait'])
        with (patch.object(vm.subprocess, 'check_output', return_value='hostname 192.0.2.1\nport 2222\n'),
              patch.object(vm.socket, 'create_connection') as connection):
            with self.assertRaises(RuntimeError):
                vm.loopback_only(identity, 'ubuntu')
        connection.assert_not_called()

    def test_unexpected_provider_socket_fails_without_broad_removal(self):
        identity = dict(args=[b'qemu-system-x86_64', b'-monitor',
                              b'tcp:127.0.0.1:4444,server,nowait'])
        connection = MagicMock()
        connection.__enter__.return_value = connection
        connection.recv.return_value = b'(qemu) '
        bound = {('127.0.0.1', 4444), ('127.0.0.1', 2222), ('0.0.0.0', 5900)}
        with (patch.object(vm, 'listeners', return_value=bound),
              patch.object(vm.subprocess, 'check_output', return_value='hostname 127.0.0.1\nport 2222\n'),
              patch.object(vm.socket, 'create_connection', return_value=connection)):
            with self.assertRaises(RuntimeError):
                vm.loopback_only(identity, 'ubuntu')
        connection.sendall.assert_not_called()


class UbuntuMirror(unittest.TestCase):
    def test_runner_mirrorlist_and_guest_sources_keep_suites_components_and_signing(self):
        cases = {
            'apt-mirrors.txt': 'http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\nhttps://archive.ubuntu.com/ubuntu/\tpriority:2\n',
            'apt-mirrors-security.txt': 'https://security.ubuntu.com/ubuntu/\n',
            'sources.list': 'deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] http://archive.ubuntu.com/ubuntu noble main universe\n',
            'sources.list.d/ubuntu.sources': 'Types: deb\nURIs: http://ports.ubuntu.com/ubuntu-ports/\nSuites: noble noble-updates noble-security\nComponents: main universe\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n',
            'sources.list.d/vendor.list': 'deb [signed-by=/vendor/key] https://packages.microsoft.com/ubuntu/24.04/prod noble main\n',
        }
        with tempfile.TemporaryDirectory(prefix='procward-apt-mirror-') as directory:
            root = Path(directory)
            for name, contents in cases.items():
                path = root / 'etc/apt' / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(contents)
            script = Path(__file__).with_name('ubuntu-apt-mirror.sh')
            subprocess.run(['sh', str(script), str(root)], check=True)
            first = {}
            for name, original in cases.items():
                actual = (root / 'etc/apt' / name).read_text()
                expected = original
                for host in ['azure.archive', 'archive', 'security']:
                    expected = expected.replace(f'http://{host}.ubuntu.com/ubuntu/', 'https://mirror.csclub.uwaterloo.ca/ubuntu/')
                    expected = expected.replace(f'https://{host}.ubuntu.com/ubuntu/', 'https://mirror.csclub.uwaterloo.ca/ubuntu/')
                expected = expected.replace('http://archive.ubuntu.com/ubuntu ', 'https://mirror.csclub.uwaterloo.ca/ubuntu/ ')
                expected = expected.replace('http://ports.ubuntu.com/ubuntu-ports/', 'https://mirror.csclub.uwaterloo.ca/ubuntu-ports/')
                self.assertEqual(actual, expected)
                first[name] = actual
            subprocess.run(['sh', str(script), str(root)], check=True)
            self.assertEqual({name: (root / 'etc/apt' / name).read_text() for name in cases}, first)

    def test_absent_apt_files_do_not_create_or_replace_configuration(self):
        with tempfile.TemporaryDirectory(prefix='procward-apt-empty-') as directory:
            subprocess.run(['sh', str(Path(__file__).with_name('ubuntu-apt-mirror.sh')), directory], check=True)
            self.assertEqual(list(Path(directory).iterdir()), [])


if __name__ == '__main__':
    unittest.main()
