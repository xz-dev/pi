// SPDX-License-Identifier: BSD-3-Clause
// Descendants across an access boundary: payload status must propagate; cleanup kills what
// the OS allows and reports what it denies (docs/platforms.md).
#[cfg(unix)]
mod unix {
    use rustix::{
        io::Errno,
        process::{self, Pid, Signal},
    };
    use std::{
        fs,
        os::unix::{
            fs::{PermissionsExt, chown},
            process::CommandExt,
        },
        path::{Path, PathBuf},
        process::{Child, Command, Stdio},
        thread,
        time::{Duration, Instant},
    };

    const SCRIPT: &str = r#""$1" boundary "$2" keep &
    "$1" boundary "$2" root &
    if [ "$(uname)" = Linux ]; then "$3" boundary "$2" nondumpable & fi
    "$3" await "$2/go"
    exit 23"#;
    // The intermediate shell exits at once, so the subshell is orphaned to procward's reaper
    // before it execs the setuid helper (which keeps our real UID, like ps).
    #[cfg(not(target_os = "macos"))]
    const ORPHAN: &str = r#"/bin/sh -c '( "$3" await "$2/exec"; exec "$1" boundary "$2" orphan ) &' sh "$1" "$2" "$3"
: > "$2/orphaned"
"$3" await "$2/go"
exit 23"#;
    // The fully root guardian outlives cleanup; only its dropped child is signalable.
    #[cfg(target_os = "linux")]
    const GUARDED: &str = r#""$1" boundary "$2" guardian &
    "$3" await "$2/go"
    exit 23"#;
    const DENIED: &str = "denied signals to privileged descendant";
    // Startup diagnostic when Linux selects the subreaper/pidfd backend instead of cgroup v2.
    const FALLBACK: &str = "procward: Linux cgroup v2 workload group unavailable (";
    // A real cgroup.kill is a kernel kill that credential checks cannot deny.
    fn cgroup_backend(stderr: &str) -> bool {
        cfg!(target_os = "linux") && !stderr.contains(FALLBACK)
    }
    // Conventional unprivileged account; only used when the test itself runs as root.
    const NOBODY: u32 = 65534;

    fn poll(limit: Duration, phase: &str, mut predicate: impl FnMut() -> bool) {
        let deadline = Instant::now() + limit;
        while !predicate() {
            assert!(Instant::now() < deadline, "deadline expired: {phase}");
            thread::sleep(Duration::from_millis(5));
        }
    }
    fn alive(pid: i32) -> bool {
        let pid = Pid::from_raw(pid).unwrap();
        // Orphans reach this test process when it is a container's PID 1; reap them here.
        let _ = process::waitpid(Some(pid), process::WaitOptions::NOHANG);
        match process::test_kill_process(pid) {
            Ok(()) | Err(Errno::PERM) => true,
            Err(Errno::SRCH) => false,
            Err(error) => panic!("existence probe for {pid} failed: {error}"),
        }
    }
    // A killed child of a live non-reaping parent stays a zombie: terminated, not running.
    fn running(pid: i32) -> bool {
        if !alive(pid) {
            return false;
        }
        #[cfg(target_os = "linux")]
        if let Ok(stat) = fs::read_to_string(format!("/proc/{pid}/stat")) {
            let state = stat
                .rsplit_once(')')
                .and_then(|(_, rest)| rest.split_whitespace().next());
            return state != Some("Z");
        }
        true
    }
    fn fixture() -> PathBuf {
        std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("examples/fixture")
    }
    fn install(from: &Path, to: &Path, mode: u32) {
        fs::copy(from, to).unwrap();
        chown(to, Some(0), Some(0)).unwrap();
        fs::set_permissions(to, fs::Permissions::from_mode(mode)).unwrap();
    }

    struct Boundary {
        dir: PathBuf,
        child: Child,
        // Real UID procward runs with; helpers that keep it remain signalable.
        user: u32,
        pids: Vec<(&'static str, i32)>,
        unsupported: bool,
    }
    impl Boundary {
        fn start(tag: &str, options: &[&str], script: &str) -> Option<Self> {
            let dir = std::env::temp_dir()
                .join(format!("procward-boundary-{}-{tag}", std::process::id()));
            fs::create_dir(&dir).unwrap();
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o777)).unwrap();
            let helper = dir.join("setuid-fixture");
            let (procward, plain, user) = if process::geteuid().is_root() {
                // Drop procward to an unprivileged user so the boundary is real; copies stay reachable.
                install(fixture().as_path(), &helper, 0o4755);
                let (procward, plain) = (dir.join("procward"), dir.join("fixture"));
                install(Path::new(env!("CARGO_BIN_EXE_procward")), &procward, 0o755);
                install(fixture().as_path(), &plain, 0o755);
                (procward, plain, NOBODY)
            } else {
                let installed = Command::new("sudo")
                    .args(["-n", "install", "-o", "root", "-m", "4755"])
                    .arg(fixture())
                    .arg(&helper)
                    .stdin(Stdio::null())
                    .status()
                    .is_ok_and(|status| status.success());
                if !installed {
                    fs::remove_dir_all(&dir).unwrap();
                    assert!(
                        std::env::var_os("CI").is_none(),
                        "CI needs root or passwordless sudo for the access-boundary test"
                    );
                    eprintln!(
                        "BOUNDARY-NOT-RUN: needs root or passwordless sudo for a setuid-root helper"
                    );
                    return None;
                }
                (
                    PathBuf::from(env!("CARGO_BIN_EXE_procward")),
                    fixture(),
                    process::getuid().as_raw(),
                )
            };
            let mut command = Command::new(procward);
            command
                .arg("run")
                .args(options)
                .args(["--", "/bin/sh", "-c", script, "sh"])
                .arg(&helper)
                .arg(&dir)
                .arg(plain)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(fs::File::create(dir.join("stderr.log")).unwrap());
            if process::geteuid().is_root() {
                command.uid(NOBODY).gid(NOBODY);
            }
            Some(Self {
                child: command.spawn().unwrap(),
                dir,
                user,
                pids: Vec::new(),
                unsupported: false,
            })
        }
        fn stderr(&self) -> String {
            fs::read_to_string(self.dir.join("stderr.log")).unwrap()
        }
        // Waits for each helper and checks its UIDs; false means qemu-user ignored setuid.
        fn ready(&mut self, kinds: &[&'static str]) -> bool {
            for &kind in kinds {
                let path = self.dir.join(format!("{kind}.pid"));
                poll(Duration::from_secs(20), "helper readiness", || {
                    path.try_exists().unwrap()
                });
                let ids: Vec<u32> = fs::read_to_string(&path)
                    .unwrap()
                    .split_whitespace()
                    .map(|value| value.parse().unwrap())
                    .collect();
                self.pids.push((kind, ids[0] as i32));
                let wanted = match kind {
                    "root" | "guardian" => (0, 0),
                    "nondumpable" | "ward" => (self.user, self.user),
                    _ => (self.user, 0),
                };
                if (ids[1], ids[2]) != wanted {
                    if kind != "nondumpable"
                        && std::env::var_os("PROCWARD_TEST_QEMU_USER").is_some()
                    {
                        self.unsupported = true;
                        println!(
                            "EMULATOR-UNSUPPORTED: descendant_across_access_boundary: qemu-user binfmt did not honour setuid (helper uid {}/{})",
                            ids[1], ids[2]
                        );
                        return false;
                    }
                    panic!(
                        "{kind} helper has real/effective UID {}/{}, expected {wanted:?}",
                        ids[1], ids[2]
                    );
                }
            }
            assert!(
                self.child.try_wait().unwrap().is_none(),
                "procward exited while descendants crossed the boundary: {}",
                self.stderr()
            );
            true
        }
    }
    impl Drop for Boundary {
        fn drop(&mut self) {
            if thread::panicking() {
                eprintln!(
                    "access-boundary failure facts: pids={:?}; procward stderr={:?}",
                    self.pids,
                    fs::read_to_string(self.dir.join("stderr.log"))
                );
            }
            let _ = fs::write(self.dir.join("release"), b"go");
            let _ = fs::write(self.dir.join("go"), b"go");
            let _ = self.child.kill();
            let _ = self.child.wait();
            let mut rescued = Vec::new();
            for (kind, pid) in &self.pids {
                // A released root helper exits by itself; anything else left is a survivor.
                if !matches!(*kind, "root" | "guardian") && running(*pid) {
                    process::kill_process(Pid::from_raw(*pid).unwrap(), Signal::KILL).unwrap();
                    rescued.push(*kind);
                }
            }
            poll(Duration::from_secs(3), "harness cleanup", || {
                self.pids.iter().all(|(_, pid)| !alive(*pid))
            });
            if !rescued.is_empty() {
                eprintln!(
                    "HARNESS RESCUE: {rescued:?} survived; NOT product cleanup; stderr={:?}",
                    fs::read_to_string(self.dir.join("stderr.log"))
                );
            }
            fs::remove_dir_all(&self.dir).unwrap();
            assert!(
                rescued.is_empty() || self.unsupported || thread::panicking(),
                "access-boundary descendants needed rescue"
            );
        }
    }

    fn kinds() -> &'static [&'static str] {
        if cfg!(target_os = "linux") {
            &["keep", "root", "nondumpable"]
        } else {
            &["keep", "root"]
        }
    }

    #[test]
    fn denied_survivor_past_cleanup_deadline_fails_closed() {
        let options = [
            "--grace",
            "300ms",
            "--fatal-grace",
            "150ms",
            "--cleanup-deadline",
            "1500ms",
        ];
        let Some(mut run) = Boundary::start("deadline", &options, SCRIPT) else {
            return;
        };
        if !run.ready(kinds()) {
            return;
        }
        fs::write(run.dir.join("go"), b"go").unwrap();
        poll(Duration::from_secs(8), "deadline failure", || {
            run.child.try_wait().unwrap().is_some()
        });
        let stderr = run.stderr();
        eprintln!("access-boundary deadline stderr: {stderr:?}");
        let root = run.pids[1].1;
        if cgroup_backend(&stderr) {
            // TERM was still denied, but the workload group's kill covers the root helper.
            assert_eq!(run.child.wait().unwrap().code(), Some(23), "{stderr}");
            assert!(!alive(root), "cgroup.kill left the root helper alive");
        } else {
            assert_eq!(run.child.wait().unwrap().code(), Some(125), "{stderr}");
            assert!(stderr.contains(DENIED), "{stderr}");
            assert!(stderr.contains("cleanup deadline expired"), "{stderr}");
            assert!(alive(root), "denied survivor was not alive at the deadline");
        }
        for (kind, pid) in &run.pids {
            assert!(
                *kind == "root" || !alive(*pid),
                "{kind} survived the deadline"
            );
        }
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn orphan_that_execs_setuid_after_adoption_is_still_cleaned() {
        let Some(mut run) = Boundary::start("orphan", &[], ORPHAN) else {
            return;
        };
        // The foreground intermediate has exited, so the subshell is already an orphan; only
        // now does it exec the setuid helper and change credentials under procward.
        let orphaned = run.dir.join("orphaned");
        poll(Duration::from_secs(20), "orphan adoption", || {
            orphaned.try_exists().unwrap()
        });
        fs::write(run.dir.join("exec"), b"go").unwrap();
        if !run.ready(&["orphan"]) {
            return;
        }
        fs::write(run.dir.join("go"), b"go").unwrap();
        poll(Duration::from_secs(8), "owner completion", || {
            run.child.try_wait().unwrap().is_some()
        });
        assert_eq!(
            run.child.wait().unwrap().code(),
            Some(23),
            "{}",
            run.stderr()
        );
        let orphan = run.pids[0].1;
        assert!(!alive(orphan), "orphan survived after its setuid exec");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn denied_live_ancestor_does_not_shield_signalable_descendant() {
        let options = [
            "--grace",
            "300ms",
            "--fatal-grace",
            "150ms",
            "--cleanup-deadline",
            "1500ms",
        ];
        let mut unrelated = Command::new("sleep").arg("30").spawn().unwrap();
        let Some(mut run) = Boundary::start("guarded", &options, GUARDED) else {
            let _ = unrelated.kill();
            let _ = unrelated.wait();
            return;
        };
        if !run.ready(&["guardian", "ward"]) {
            return;
        }
        let (guardian, ward) = (run.pids[0].1, run.pids[1].1);
        let parent = fs::read_to_string(format!("/proc/{ward}/stat")).unwrap();
        let parent = parent.rsplit_once(')').unwrap().1.split_whitespace().nth(1);
        assert_eq!(parent, Some(guardian.to_string().as_str()));
        let start = Instant::now();
        fs::write(run.dir.join("go"), b"go").unwrap();
        poll(Duration::from_secs(8), "procward completion", || {
            run.child.try_wait().unwrap().is_some()
        });
        let elapsed = start.elapsed();
        let stderr = run.stderr();
        eprintln!("guarded descendant stderr: {stderr:?} after {elapsed:?}");
        let code = run.child.wait().unwrap().code();
        assert!(
            !running(ward),
            "signalable descendant of a live denied ancestor survived"
        );
        if cgroup_backend(&stderr) {
            assert_eq!(code, Some(23), "{stderr}");
            assert!(!alive(guardian), "cgroup.kill left the root guardian alive");
        } else {
            // The guardian never exited, so the descendant was killed without adoption.
            assert!(
                alive(guardian),
                "denied guardian was not alive at the deadline"
            );
            assert_eq!(code, Some(125), "{stderr}");
            assert!(stderr.contains(DENIED), "{stderr}");
            assert!(stderr.contains("cleanup deadline expired"), "{stderr}");
        }
        assert!(elapsed < Duration::from_millis(1500 + 1000), "{elapsed:?}");
        assert!(
            unrelated.try_wait().unwrap().is_none(),
            "unrelated process was hit"
        );
        unrelated.kill().unwrap();
        unrelated.wait().unwrap();
    }

    #[test]
    fn descendant_across_access_boundary_keeps_status_and_reports_denial() {
        let Some(mut run) = Boundary::start("status", &[], SCRIPT) else {
            return;
        };
        if !run.ready(kinds()) {
            return;
        }
        fs::write(run.dir.join("go"), b"go").unwrap();
        poll(Duration::from_secs(6), "denial report", || {
            run.stderr().contains(DENIED) || run.child.try_wait().unwrap().is_some()
        });
        assert!(
            run.child.try_wait().unwrap().is_none(),
            "procward stopped cleanup instead of reporting the denied descendant: {}",
            run.stderr()
        );
        let allowed: Vec<i32> = run
            .pids
            .iter()
            .filter(|(kind, _)| *kind != "root")
            .map(|(_, pid)| *pid)
            .collect();
        poll(
            Duration::from_secs(6),
            "signalable descendants removed",
            || allowed.iter().all(|pid| !alive(*pid)),
        );
        assert!(run.child.try_wait().unwrap().is_none(), "{}", run.stderr());
        fs::write(run.dir.join("release"), b"go").unwrap();
        poll(Duration::from_secs(8), "owner completion", || {
            run.child.try_wait().unwrap().is_some()
        });
        assert_eq!(
            run.child.wait().unwrap().code(),
            Some(23),
            "{}",
            run.stderr()
        );
        eprintln!("access-boundary procward stderr: {:?}", run.stderr());
        let root = run.pids[1].1;
        poll(Duration::from_secs(3), "released root helper exit", || {
            !alive(root)
        });
    }
}

#[cfg(windows)]
mod windows {
    use std::{
        fs,
        path::PathBuf,
        process::{Child, Command, Stdio},
        thread,
        time::{Duration, Instant},
    };
    use windows_sys::Win32::{
        Foundation::{CloseHandle, ERROR_ACCESS_DENIED, HANDLE, WAIT_OBJECT_0},
        System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
            TerminateProcess, WaitForSingleObject,
        },
    };

    fn poll(limit: Duration, phase: &str, mut predicate: impl FnMut() -> bool) {
        let deadline = Instant::now() + limit;
        while !predicate() {
            assert!(Instant::now() < deadline, "deadline expired: {phase}");
            thread::sleep(Duration::from_millis(5));
        }
    }
    // Remove SeDebugPrivilege (enabled on hosted runners) so the inherited controller token
    // obeys process DACLs like an ordinary user's token. Returns whether it was held.
    fn drop_debug_privilege() -> bool {
        use windows_sys::Win32::{
            Foundation::{ERROR_NOT_ALL_ASSIGNED, GetLastError},
            Security::{
                AdjustTokenPrivileges, LUID_AND_ATTRIBUTES, LookupPrivilegeValueW, SE_DEBUG_NAME,
                SE_PRIVILEGE_REMOVED, TOKEN_ADJUST_PRIVILEGES, TOKEN_PRIVILEGES,
            },
            System::Threading::{GetCurrentProcess, OpenProcessToken},
        };
        unsafe {
            let mut token = std::ptr::null_mut();
            assert_ne!(
                OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES, &mut token),
                0
            );
            let mut privileges = TOKEN_PRIVILEGES {
                PrivilegeCount: 1,
                Privileges: [LUID_AND_ATTRIBUTES {
                    Luid: std::mem::zeroed(),
                    Attributes: SE_PRIVILEGE_REMOVED,
                }],
            };
            assert_ne!(
                LookupPrivilegeValueW(
                    std::ptr::null(),
                    SE_DEBUG_NAME,
                    &mut privileges.Privileges[0].Luid
                ),
                0
            );
            let adjusted = AdjustTokenPrivileges(
                token,
                0,
                &privileges,
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            );
            let held = adjusted != 0 && GetLastError() != ERROR_NOT_ALL_ASSIGNED;
            assert_ne!(adjusted, 0, "{}", std::io::Error::last_os_error());
            CloseHandle(token);
            held
        }
    }
    struct Run {
        child: Child,
        dir: PathBuf,
        // Opened before the descendant's DACL change; existing handle rights survive it.
        helper: HANDLE,
    }
    impl Drop for Run {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
            if !self.helper.is_null() {
                let survived = unsafe { WaitForSingleObject(self.helper, 3000) } != WAIT_OBJECT_0;
                if survived {
                    eprintln!(
                        "HARNESS RESCUE: DACL-protected descendant survived; NOT product cleanup"
                    );
                    unsafe { TerminateProcess(self.helper, 1) };
                }
                unsafe { CloseHandle(self.helper) };
                assert!(!survived || thread::panicking(), "descendant needed rescue");
            }
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn descendant_denying_controller_access_keeps_status_and_job_cleanup() {
        // This binary's only Windows test, so the token change cannot affect other tests.
        eprintln!(
            "SeDebugPrivilege removed before launch: {}",
            drop_debug_privilege()
        );
        let dir = std::env::temp_dir().join(format!("procward-boundary-{}", std::process::id()));
        fs::create_dir(&dir).unwrap();
        let fixture = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("examples/fixture.exe");
        let child = Command::new(env!("CARGO_BIN_EXE_procward"))
            .args(["run", "--"])
            .arg(fixture)
            .arg("boundary-tree")
            .arg(&dir)
            .stdin(Stdio::null())
            .stderr(fs::File::create(dir.join("stderr.log")).unwrap())
            .spawn()
            .unwrap();
        let mut run = Run {
            child,
            dir,
            helper: std::ptr::null_mut(),
        };
        let pid_path = run.dir.join("deny.pid");
        poll(Duration::from_secs(20), "helper readiness", || {
            pid_path.exists()
        });
        let pid: u32 = fs::read_to_string(&pid_path).unwrap().parse().unwrap();
        run.helper = unsafe { OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_TERMINATE, 0, pid) };
        assert!(!run.helper.is_null(), "{}", std::io::Error::last_os_error());
        fs::write(run.dir.join("apply"), b"go").unwrap();
        poll(Duration::from_secs(20), "DACL applied", || {
            run.dir.join("denied").exists()
        });
        let denied = unsafe {
            OpenProcess(
                PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
                0,
                pid,
            )
        };
        let error = std::io::Error::last_os_error();
        if !denied.is_null() {
            unsafe { CloseHandle(denied) };
            panic!("controller user still opens the protected descendant; boundary not real");
        }
        assert_eq!(error.raw_os_error(), Some(ERROR_ACCESS_DENIED as i32));
        assert!(run.child.try_wait().unwrap().is_none());
        fs::write(run.dir.join("go"), b"go").unwrap();
        poll(Duration::from_secs(8), "owner completion", || {
            run.child.try_wait().unwrap().is_some()
        });
        assert_eq!(
            run.child.wait().unwrap().code(),
            Some(23),
            "{:?}",
            fs::read_to_string(run.dir.join("stderr.log"))
        );
        assert_eq!(
            unsafe { WaitForSingleObject(run.helper, 3000) },
            WAIT_OBJECT_0,
            "Job left the access-denying descendant alive"
        );
    }
}
