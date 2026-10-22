// A custom harness keeps the exec fixture on its main OS thread. Linux's
// PR_GET_PDEATHSIG in a libtest worker thread would read that new thread's zero setting.
#[cfg(any(target_os = "linux", target_os = "freebsd"))]
mod checks {

    use std::fs;
    use std::process::{Command, Stdio};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn primary_kernel_wake_fixture() {
        let Some(path) = std::env::var_os("PI_KERNEL_WAKE_FIXTURE") else {
            return;
        };
        let mut signal = 0i32;
        #[cfg(target_os = "linux")]
        let result = unsafe { libc::prctl(libc::PR_GET_PDEATHSIG, &mut signal as *mut i32) };
        #[cfg(target_os = "freebsd")]
        let result = unsafe {
            libc::procctl(
                libc::P_PID,
                libc::getpid() as libc::id_t,
                libc::PROC_PDEATHSIG_STATUS,
                (&mut signal as *mut i32).cast(),
            )
        };
        assert_eq!(result, 0);
        assert_eq!(signal, libc::SIGCONT, "exec must retain the kernel wake");
        #[cfg(target_os = "linux")]
        {
            let parent = unsafe { libc::getppid() };
            let tids: Vec<_> = fs::read_dir(format!("/proc/{parent}/task"))
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .collect();
            assert_eq!(
                tids,
                [parent.to_string()],
                "Pi's creating thread must live for guardian lifetime"
            );
        }
        fs::write(path, signal.to_string()).unwrap();
    }

    fn owned_primary_retains_parent_death_cont_across_exec() {
        let path = std::env::temp_dir().join(format!(
            "pi-kernel-wake-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let status = Command::new(env!("CARGO_BIN_EXE_pi-env"))
            .args(["supervise", "--"])
            .arg(std::env::current_exe().unwrap())
            .env("PI_PROCESS_OWNER_PENDING", "1")
            .env("PI_KERNEL_WAKE_FIXTURE", &path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .status()
            .unwrap();
        assert!(status.success());
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            libc::SIGCONT.to_string()
        );
        fs::remove_file(path).unwrap();
    }

    fn parent_death_fault_switch_is_build_scoped() {
        for session in [true, false] {
            let path = std::env::temp_dir().join(format!(
                "pi-kernel-failure-{}-{}-{session}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            let mut command = Command::new(env!("CARGO_BIN_EXE_pi-env"));
            command
                .args([
                    "supervise",
                    "--",
                    "/bin/sh",
                    "-c",
                    "printf executed > \"$1\"",
                    "sh",
                ])
                .arg(&path)
                .env_remove("PI_PROCESS_OWNER_PENDING")
                .env("PI_PROCESS_OWNER_TEST_PDEATHSIG_FAIL", "1");
            if session {
                command.env("PI_PROCESS_OWNER_PENDING", "1");
            }
            let output = command.output().unwrap();
            if session && cfg!(feature = "test-parent-death-failure") {
                assert_eq!(output.status.code(), Some(125));
                assert!(!path.exists(), "arm failure must not grant exec");
                assert!(String::from_utf8_lossy(&output.stderr).contains("--no-process-ownership"));
            } else {
                assert!(
                    output.status.success(),
                    "default build or non-session must ignore test-only arm injection"
                );
                assert!(output.stderr.is_empty());
                assert!(path.exists());
                fs::remove_file(path).unwrap();
            }
        }
    }

    pub fn run() {
        if std::env::var_os("PI_KERNEL_WAKE_FIXTURE").is_some() {
            primary_kernel_wake_fixture();
            return;
        }
        owned_primary_retains_parent_death_cont_across_exec();
        parent_death_fault_switch_is_build_scoped();
        println!("2 kernel parent-death checks passed");
    }
}
fn main() {
    #[cfg(any(target_os = "linux", target_os = "freebsd"))]
    checks::run();
}
