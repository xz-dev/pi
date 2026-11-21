#!/usr/bin/env python3
# SPDX-License-Identifier: BSD-3-Clause
# Runs prebuilt Linux test executables inside a disposable full-system virtme/QEMU guest.
# The host only builds and inspects; every integration test runs in the guest. The guest sees
# the host root read-only over 9p (--force-9p sets readonly=on), has no network and uses
# tmpfs scratch. A hard host watchdog kills the whole VM process group. Pass needs the guest's
# boot record (boot ID different from the host) and a completion record for this run's nonce
# with every test accounted for; VM death, timeout or a missing record is failure.
#
#   ci/vm-test.py --kernel <installed kernel version or image> [--mode cgroup|fallback ...]
#                 [--filter SUBSTRING ...] [--skip SUBSTRING ...] [--timeout SECONDS]
#                 [--repo DIR] [--target-dir DIR] [--out DIR] [--selftest ok|exit7|hang]
import argparse, ctypes, json, os, secrets, shutil, signal, subprocess, sys, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))


def fail(message):
    print(f"VM-TEST FAILED: {message}", file=sys.stderr)
    sys.exit(1)


def inventory(repo, target_dir):
    env = dict(os.environ, CARGO_TARGET_DIR=target_dir)
    subprocess.run(["cargo", "build", "--locked", "--offline", "--bins", "--examples"],
                   cwd=repo, env=env, check=True)
    built = subprocess.run(
        ["cargo", "test", "--locked", "--offline", "--all-targets", "--no-run",
         "--message-format=json"],
        cwd=repo, env=env, check=True, stdout=subprocess.PIPE).stdout.decode()
    executables = []
    for line in built.splitlines():
        message = json.loads(line)
        if (message.get("reason") == "compiler-artifact" and message.get("executable")
                and message["profile"]["test"] and "example" not in message["target"]["kind"]):
            executables.append(message["executable"])
    if not executables:
        fail("cargo produced no test executables")
    return sorted(set(executables))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--kernel", default=os.environ.get("PROCWARD_VM_KERNEL"))
    parser.add_argument("--virtme", default=os.environ.get("PROCWARD_VM_VIRTME", "virtme-run"))
    parser.add_argument("--mode", action="append", choices=["cgroup", "fallback"])
    parser.add_argument("--filter", action="append", default=[])
    parser.add_argument("--skip", action="append", default=[])
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--test-budget", type=int, default=60)
    parser.add_argument("--repo", default=os.path.dirname(HERE))
    parser.add_argument("--target-dir", default=None)
    parser.add_argument("--out", default="/var/tmp/procward-vm")
    parser.add_argument("--selftest", choices=["ok", "exit7", "hang"])
    parser.add_argument("--hazard", action="store_true",
                        help="run only the real adversarial regression in its own 10s VM")
    args = parser.parse_args()
    if args.hazard:
        if args.selftest or args.mode:
            parser.error("--hazard uses its own VM; do not combine it with --selftest or --mode")
        args.timeout = min(args.timeout, 10)
        args.test_budget = min(args.test_budget, 5)
    if args.timeout <= 0 or args.test_budget <= 0:
        parser.error("VM and test timeouts must be positive")
    repo = os.path.abspath(args.repo)
    target_dir = os.path.abspath(args.target_dir or os.path.join(repo, "target"))
    # Fail closed: no guessed kernel and no missing launcher.
    if not args.kernel:
        fail("no kernel: pass --kernel or set PROCWARD_VM_KERNEL")
    virtme = shutil.which(args.virtme)
    if not virtme:
        fail(f"virtme launcher {args.virtme!r} not found")
    nonce = secrets.token_hex(8)
    run = os.path.join(os.path.abspath(args.out), f"run-{nonce}")
    export = os.path.join(run, "export")
    os.makedirs(export)
    executables = [] if args.selftest else inventory(repo, target_dir)
    if not args.selftest:
        executables = [binary for binary in executables
                       if os.path.basename(binary).startswith("hazard-") == args.hazard]
        if not executables:
            fail("no matching test executables")
    with open("/proc/sys/kernel/random/boot_id") as handle:
        host_boot = handle.read().strip()
    manifest = {
        "nonce": nonce,
        "host_boot_id": host_boot,
        "executables": executables,
        "modes": args.mode or (["cgroup"] if args.hazard else ["cgroup", "fallback"]),
        "hazard": args.hazard,
        "filters": args.filter,
        "skip": args.skip,
        "test_budget": args.test_budget,
        "cwd": repo,
        "selftest": args.selftest,
    }
    with open(os.path.join(export, "manifest.json"), "w") as handle:
        json.dump(manifest, handle, indent=1)
    shutil.copy(os.path.join(HERE, "vm-guest.py"), os.path.join(export, "vm-guest.py"))
    command = [
        virtme, "--kimg", args.kernel, "--mods", "use", "--force-9p", "--force-initramfs",
        "--cpus", "2", "--memory", "2G", "--user", "root",
        # Read-only exports; /var/tmp and /run are guest tmpfs, so name them explicitly.
        f"--rodir=/run/procward-vm={export}",
        "--script-sh", "python3 /run/procward-vm/vm-guest.py", "--show-boot-console",
    ]
    for path in sorted(set((repo, target_dir))):
        if path.startswith(("/var/tmp/", "/tmp/", "/run/")):
            command.insert(-3, f"--rodir={path}={path}")
    env = dict(os.environ, TMPDIR=os.path.join(run, "tmp"),
               XDG_CACHE_HOME=os.path.join(os.path.abspath(args.out), "cache"))
    os.makedirs(env["TMPDIR"])
    # This runner reaps every orphan of the VM launcher (QEMU may outlive virtme-run).
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:
        fail("host runner could not become a subreaper")
    log_path = os.path.join(run, "console.txt")
    print(f"VM-TEST run {nonce}: {' '.join(command)}", flush=True)
    started = time.monotonic()
    console_path = os.path.join(run, "kernel-console.txt")
    # Keep boot console/stderr separate from the guest's structured stdout. QEMU can
    # interleave writes from distinct serial channels even within one JSON record.
    with open(log_path, "wb") as log, open(console_path, "wb") as console_log:
        vm = subprocess.Popen(command, cwd=run, env=env, stdin=subprocess.DEVNULL,
                              stdout=subprocess.PIPE, stderr=console_log,
                              start_new_session=True)

        def copy():
            for chunk in iter(lambda: vm.stdout.read1(65536), b""):
                log.write(chunk)
                log.flush()

        reader = threading.Thread(target=copy, daemon=True)
        reader.start()
        try:
            code = vm.wait(timeout=args.timeout)
            watchdog = False
        except subprocess.TimeoutExpired:
            watchdog = True
            code = None
            # The live, unreaped session leader still binds this process-group ID.
            os.killpg(vm.pid, signal.SIGKILL)
            vm.wait()
        # Reap/kill only our unreaped adopted children, never a stale group ID after
        # the original leader exited. Newly orphaned helpers are adopted here too.
        while True:
            with open("/proc/thread-self/children") as children:
                owned = [int(pid) for pid in children.read().split()]
            if not owned:
                break
            for pid in owned:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            for pid in owned:
                try:
                    os.waitpid(pid, 0)
                except ChildProcessError:
                    pass
        reader.join(timeout=5)
        if reader.is_alive():
            fail(f"VM output did not close; inspect {log_path}")
    elapsed = time.monotonic() - started
    with open(log_path, errors="replace") as handle:
        console = handle.read()
    records, record_errors = [], []
    prefix = f"PROCWARD-VM {nonce} "
    for line in console.splitlines():
        if line.startswith(prefix):
            try:
                record = json.loads(line[len(prefix):])
                if not isinstance(record, dict) or record.get("kind") not in ("boot", "test", "complete"):
                    raise ValueError("unknown record kind")
                records.append(record)
            except (ValueError, TypeError) as error:
                record_errors.append(str(error))
    boots = [r for r in records if r["kind"] == "boot"]
    tests = [r for r in records if r["kind"] == "test"]
    complete = [r for r in records if r["kind"] == "complete"]
    for record in tests:
        print(f"=== {record['verdict']:<14} {record['mode']:<8} {record['binary']}::"
              f"{record['test']} status={record['status']} rescue={record['rescue']} "
              f"leftovers={record['leftovers']} {record['seconds']}s")
        for note in record["notes"]:
            print(f"      {note}")
        if record["verdict"] == "fail":
            print(record["output"])
    problems = list(record_errors)
    if watchdog:
        problems.append(f"HOST WATCHDOG RESCUE after {args.timeout}s (failure, not cleanup)")
    if len(boots) != 1:
        problems.append("missing guest boot record")
    elif boots[0]["boot_id"] == host_boot:
        problems.append("guest boot ID equals host boot ID: not a separate kernel")
    if len(complete) != 1:
        problems.append("missing guest completion record")
    else:
        # The completion record is authoritative: it lists every verdict of this run.
        done = complete[0]
        results = done.get("results", [])
        if done["total"] != len(results):
            problems.append("completion record is internally inconsistent")
        reported = [[t["mode"], t["binary"], t["test"], t["verdict"], t["status"]]
                    for t in tests]
        if reported != results:
            problems.append("test records do not match the completion record")
        if not args.selftest and not results:
            problems.append("no tests matched the requested run")
        failed = [r for r in results if r[3] == "fail"]
        if failed or done["failed"] != len(failed) or done.get("leftover_root_groups"):
            problems.append(f"guest reported failures {[f'{r[0]}:{r[1]}::{r[2]}' for r in failed]}"
                            f", root leftovers {done.get('leftover_root_groups')}")
    if code != 0:
        problems.append(f"VM launcher exit {code}")
    summary = {"nonce": nonce, "host_boot_id": host_boot, "boot": boots, "complete": complete,
               "tests": len(tests), "failed": [f"{t['mode']}:{t['binary']}::{t['test']}"
                                               for t in tests if t["verdict"] == "fail"],
               "not_applicable": [f"{t['mode']}:{t['binary']}::{t['test']}"
                                  for t in tests if t["verdict"] == "not-applicable"],
               "vm_exit": code, "watchdog": watchdog, "seconds": round(elapsed, 1),
               "problems": problems, "console": log_path, "kernel_console": console_path}
    with open(os.path.join(run, "summary.json"), "w") as handle:
        json.dump(summary, handle, indent=1)
    print(json.dumps({k: v for k, v in summary.items() if k != "tests"}, indent=1))
    if problems:
        fail("; ".join(problems))
    print(f"VM-TEST PASSED: {len(tests)} test records, guest {boots[0]['kernel']} "
          f"boot {boots[0]['boot_id']}")


if __name__ == "__main__":
    main()
