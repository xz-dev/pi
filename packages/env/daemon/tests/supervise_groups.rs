#![cfg(any(target_os = "linux", target_os = "freebsd"))]

use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};

#[test]
fn non_session_supervisor_isolates_group_but_preserves_session() {
    for private_group in [false, true] {
        let mut command = Command::new(env!("CARGO_BIN_EXE_pi-env"));
        command
            .args([
                "supervise",
                "--",
                "/bin/sh",
                "-c",
                "ps -p $$ -o pid= -o ppid= -o pgid= -o sid=",
            ])
            .env_remove("PI_PROCESS_OWNER_PENDING")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        if private_group {
            command.process_group(0);
        }
        let child = command.spawn().unwrap();
        let outer = child.id() as i32;
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success());
        let row: Vec<i32> = String::from_utf8(output.stdout)
            .unwrap()
            .split_whitespace()
            .map(|word| word.parse().unwrap())
            .collect();
        assert_eq!(row.len(), 4);
        assert_eq!(
            row[2], outer,
            "payload must inherit task outer's private PG"
        );
        assert_ne!(row[2], unsafe { libc::getpgrp() });
        assert_eq!(row[3], unsafe { libc::getsid(0) }, "task must retain SID");
    }
}

#[test]
fn non_session_group_error_fails_before_payload_exec() {
    let mut command = Command::new(env!("CARGO_BIN_EXE_pi-env"));
    command
        .args(["supervise", "--", "/bin/echo", "payload-ran"])
        .env_remove("PI_PROCESS_OWNER_PENDING");
    // A session leader cannot change its PG; never turn real EPERM into success.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let output = command.output().unwrap();
    assert_eq!(output.status.code(), Some(125));
    assert!(output.stdout.is_empty());
    assert!(
        String::from_utf8(output.stderr)
            .unwrap()
            .contains("pi-env supervise:")
    );
}
