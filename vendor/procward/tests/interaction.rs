// SPDX-License-Identifier: BSD-3-Clause
use std::{
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
    sync::mpsc::{self, RecvTimeoutError},
    thread,
    time::{Duration, Instant},
};

#[test]
fn response_driven_actions_retry_not_ready_but_silence_and_endless_hints_fail_at_original_deadline()
{
    let fixture = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join(format!("examples/fixture{}", std::env::consts::EXE_SUFFIX));
    for mode in ["cooperative", "silence", "hints"] {
        let mut child = OwnedChild(
            Command::new(env!("CARGO_BIN_EXE_procward"))
                .args([
                    "run",
                    "--grace",
                    "100ms",
                    "--fatal-grace",
                    "50ms",
                    "--cleanup-deadline",
                    "1s",
                    "--",
                ])
                .arg(&fixture)
                .args(["responses", mode])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let stdout = child.0.stdout.take().unwrap();
        let (send, receive) = mpsc::sync_channel(1);
        let reader = thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if send.send(line.unwrap()).is_err() {
                    break;
                }
            }
        });
        let readiness = receive.recv_timeout(Duration::from_secs(20)).unwrap();
        let owner: u32 = readiness
            .strip_prefix("RESPONSE-READY ")
            .unwrap()
            .parse()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(1);
        let mut hints = 0;
        let outcome = loop {
            if Instant::now() >= deadline {
                break Err(RecvTimeoutError::Timeout);
            }
            child
                .0
                .stdin
                .as_mut()
                .unwrap()
                .write_all(b"quit\n")
                .unwrap();
            child.0.stdin.as_mut().unwrap().flush().unwrap();
            match receive.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(reply) if reply == "NOT-READY" => hints += 1,
                Ok(reply) => break Ok(reply),
                Err(error) => break Err(error),
            }
        };
        if mode == "cooperative" {
            assert_eq!(outcome, Ok("BYE 4".into()));
            assert_eq!(
                hints, 3,
                "each explicit not-ready response drives exactly one retry"
            );
            let finish = Instant::now() + Duration::from_secs(2);
            while child.0.try_wait().unwrap().is_none() {
                assert!(Instant::now() < finish, "normal status deadline");
                thread::sleep(Duration::from_millis(2));
            }
            assert_eq!(child.0.wait().unwrap().code(), Some(23));
        } else {
            assert_eq!(
                outcome,
                Err(RecvTimeoutError::Timeout),
                "{mode} must fail, not count hints as success"
            );
            assert!(Instant::now() >= deadline);
            if mode == "hints" {
                assert!(hints > 1);
            }
            eprintln!(
                "EXPECTED INTERACTION FAILURE: {mode}; terminate owner, then require native transport closure"
            );
            child.0.kill().unwrap();
            assert!(!child.0.wait().unwrap().success());
        }
        let cleanup = Instant::now() + Duration::from_secs(2);
        loop {
            match receive.recv_timeout(cleanup.saturating_duration_since(Instant::now())) {
                Err(RecvTimeoutError::Disconnected) => break,
                Ok(_) => {}
                Err(error) => panic!("native cleanup failed to close output after {mode}: {error}"),
            }
        }
        reader.join().unwrap();
        #[cfg(unix)]
        {
            use rustix::{
                io::Errno,
                process::{self, Pid, WaitOptions},
            };
            let pid = Pid::from_raw(owner as i32).unwrap();
            loop {
                match process::waitpid(Some(pid), WaitOptions::NOHANG) {
                    Ok(Some((_, status))) => {
                        assert!(
                            status.exit_status().is_some() || status.terminating_signal().is_some()
                        );
                        break;
                    }
                    Err(Errno::CHILD) => break,
                    Ok(None) | Err(Errno::INTR) => {
                        assert!(
                            Instant::now() < cleanup,
                            "adopted native role reaping deadline"
                        );
                        thread::sleep(Duration::from_millis(2));
                    }
                    Err(error) => panic!("native-role reaping failed: {error}"),
                }
            }
        }
        #[cfg(windows)]
        assert_eq!(owner, child.0.id());
    }
}

struct OwnedChild(std::process::Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            eprintln!("HARNESS RESCUE: response fixture owner; not interaction success");
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}
