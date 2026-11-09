#!/usr/bin/env python3
# SPDX-License-Identifier: BSD-3-Clause
# Guest side of ci/vm-test.py. Runs ONLY inside the disposable virtme/QEMU guest as root.
# It mutates only guest state: tmpfs scratch and fresh guest cgroups. Every record it
# prints is "PROCWARD-VM <nonce> <json>"; the host trusts nothing else.
import ctypes, json, os, signal, subprocess, sys, time

# Every record also lands in this durable guest-side log; the host re-reads it
# because a closing SSH channel can drop the stream's final lines.
RECORD_LOG = '/tmp/procward-vm-records.log'

MANIFEST = "/run/procward-vm/manifest.json"
CGROUP = "/sys/fs/cgroup"
JOIN = (
    'echo $$ > "$0/cgroup.procs" && [ "$(cat /proc/self/cgroup)" = "0::/$1" ] '
    '&& echo "MEMBERSHIP-OK $(cat /proc/self/cgroup)" && shift && exec "$@"'
)


def emit(nonce, **record):
    line = f"PROCWARD-VM {nonce} {json.dumps(record, sort_keys=True)}"
    print(line, flush=True)
    with open(RECORD_LOG, 'a') as log:
        print(line, file=log, flush=True)


def populated(group):
    with open(os.path.join(group, "cgroup.events")) as events:
        return "populated 1" in events.read()


def subgroups(path):
    found = []
    for name in sorted(os.listdir(path)):
        full = os.path.join(path, name)
        if os.path.isdir(full):
            found.extend(subgroups(full))
            found.append(full)
    return found


def reap_orphans():
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        if pid == 0:
            return


def oom_kills():
    with open("/proc/vmstat") as stats:
        for line in stats:
            key, value = line.split()
            if key == "oom_kill":
                return int(value)
    raise RuntimeError("guest OOM accounting is unavailable")


def classify(mode, status, output, membership, rescue, leftovers, oom_delta=0):
    passed = status == 0 and "test result: ok. 1 passed" in output
    if (not passed or not membership or rescue or leftovers or oom_delta != 0
            or "HARNESS RESCUE" in output):
        return "fail"
    if "CGROUP-NOT-RUN" in output:
        return "fail" if mode == "cgroup" else "not-applicable"
    if "BOUNDARY-NOT-RUN" in output:
        return "not-applicable"
    return "pass"


def run_test(nonce, mode, binary, name, index, budget, cwd, hazard=False):
    oom_before = oom_kills()
    relative = f"pwvm-{mode}-{index}"
    group = os.path.join(CGROUP, relative)
    os.mkdir(group)
    env = dict(os.environ, TMPDIR="/tmp")
    env.pop("PROCWARD_TEST_CGROUP_PARENT", None)
    if mode == "fallback":
        # The test and everything it starts stay in this group; procward cannot create one.
        with open(os.path.join(group, "cgroup.max.descendants"), "w") as limit:
            limit.write("0")
    else:
        env["PROCWARD_TEST_CGROUP_PARENT"] = group
    log = open(f"/tmp/pwvm-{index}.log", "w+b")
    start = time.monotonic()
    child = subprocess.Popen(
        ["/bin/sh", "-c", JOIN, group, relative, binary, "--exact", name,
         "--nocapture", "--test-threads=1"] + (["--ignored"] if hazard else []),
        cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT)
    status = None
    while status is None:
        # This guest runner is the tests' subreaper: reap every orphan, not only the test.
        try:
            pid, raw = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            break
        if pid == child.pid:
            status = os.waitstatus_to_exitcode(raw)
            break
        if pid == 0:
            if time.monotonic() - start > budget:
                status = "TIMEOUT"
                with open(os.path.join(group, "cgroup.kill"), "w") as kill:
                    kill.write("1")
                child.wait()
                break
            time.sleep(0.005)
    elapsed = time.monotonic() - start
    rescue = False
    if populated(group):
        rescue = True
        with open(os.path.join(group, "cgroup.kill"), "w") as kill:
            kill.write("1")
        deadline = time.monotonic() + 10
        while populated(group) and time.monotonic() < deadline:
            reap_orphans()
            time.sleep(0.01)
    reap_orphans()
    leftovers = [os.path.relpath(path, group) for path in subgroups(group)]
    for path in subgroups(group):
        try:
            os.rmdir(path)
        except OSError:
            pass
    os.rmdir(group)
    log.seek(0)
    output = log.read().decode(errors="replace")
    log.close()
    membership = f"MEMBERSHIP-OK 0::/{relative}" in output
    oom_delta = oom_kills() - oom_before
    verdict = classify(mode, status, output, membership, rescue, leftovers, oom_delta)
    notes = [line for line in output.splitlines()
             if any(tag in line for tag in ("HARNESS", "NOT-RUN", "CGROUP-REAL", "TOSTOP ",
                                            "NOFILE-REGRESSION", "panicked", "HAZARD"))]
    if oom_delta:
        notes.append(f"GUEST-OOM: counter changed by {oom_delta}; not product cleanup")
    emit(nonce, kind="test", mode=mode, binary=os.path.basename(binary), test=name,
         status=status, verdict=verdict, membership=membership, rescue=rescue,
         leftovers=leftovers, oom_kills=oom_delta, seconds=round(elapsed, 2), notes=notes[:20],
         output=output[-4000:] if verdict == "fail" else "")
    return [mode, os.path.basename(binary), name, verdict, status]


def main():
    with open(MANIFEST) as handle:
        manifest = json.load(handle)
    nonce = manifest["nonce"]
    with open("/proc/sys/kernel/random/boot_id") as handle:
        boot = handle.read().strip()
    if boot == manifest["host_boot_id"]:
        sys.exit("VM-GUEST REFUSED: host kernel, not the disposable guest")
    if os.getuid() != 0:
        sys.exit("VM-GUEST REFUSED: guest root is required for isolated fixture setup")
    os.environ["PROCWARD_VM_HOST_BOOT_ID"] = manifest["host_boot_id"]
    emit(nonce, kind="boot", boot_id=boot, kernel=os.uname().release, uid=os.getuid(),
         pid=os.getpid())
    selftest = manifest.get("selftest")
    if selftest == "exit7":
        sys.exit(7)
    if selftest == "hang":
        time.sleep(3600)
    if selftest == "ok":
        emit(nonce, kind="complete", total=0, failed=0, results=[])
        return
    # Guest-only: keep kernel console messages from interleaving with records.
    with open("/proc/sys/kernel/printk", "w") as printk:
        printk.write("1")
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        sys.exit("guest subreaper unavailable")
    subprocess.run(["mount", "-t", "tmpfs", "-o", "mode=1777", "tmpfs", "/tmp"], check=True)
    if os.statvfs(CGROUP) and not os.path.exists(os.path.join(CGROUP, "cgroup.procs")):
        subprocess.run(["mount", "-t", "cgroup2", "none", CGROUP], check=True)
    if manifest.get("hazard"):
        with open(os.path.join(CGROUP, "cgroup.controllers")) as controllers:
            available = set(controllers.read().split())
        if not {"pids", "memory"} <= available:
            sys.exit("HAZARD-REFUSED: guest pids/memory controllers unavailable")
        enabled = [name for name in ("pids", "memory", "cpu") if name in available]
        with open(os.path.join(CGROUP, "cgroup.subtree_control"), "w") as control:
            control.write(" ".join("+" + name for name in enabled))
    verdicts = []
    index = 0
    for mode in manifest["modes"]:
        for binary in manifest["executables"]:
            listing = subprocess.run([binary, "--list", "--format", "terse"],
                                     cwd=manifest["cwd"], stdout=subprocess.PIPE,
                                     check=True).stdout.decode()
            names = [line[:-len(": test")] for line in listing.splitlines()
                     if line.endswith(": test")]
            for name in names:
                if manifest["filters"] and not any(f in name for f in manifest["filters"]):
                    continue
                if any(f in name for f in manifest["skip"]):
                    continue
                index += 1
                verdicts.append(run_test(nonce, mode, binary, name, index,
                                         manifest["test_budget"], manifest["cwd"],
                                         manifest.get("hazard", False)))
    remaining = [name for name in os.listdir(CGROUP) if name.startswith(("pwvm-", "procward-"))]
    failed = sum(result[3] == "fail" for result in verdicts)
    emit(nonce, kind="complete", total=len(verdicts), failed=failed,
         not_applicable=sum(result[3] == "not-applicable" for result in verdicts),
         leftover_root_groups=remaining, results=verdicts)
    # Let the console drain before power-off.
    time.sleep(1)
    sys.exit(1 if failed or remaining else 0)


if __name__ == "__main__":
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    main()
