// SPDX-License-Identifier: BSD-3-Clause
use std::{env, ffi::OsString, process::ExitCode};
#[cfg(target_os = "linux")]
mod cgroup;
mod config;
mod contract;
#[cfg(target_os = "linux")]
#[path = "linux_inventory.rs"]
mod inventory;
#[cfg(target_os = "freebsd")]
#[path = "freebsd_inventory.rs"]
mod inventory;
#[cfg(target_os = "macos")]
#[path = "darwin.rs"]
mod inventory;
#[cfg(any(target_os = "linux", target_os = "freebsd", target_os = "macos"))]
mod owner;
#[cfg(any(target_os = "linux", target_os = "freebsd", target_os = "macos"))]
mod policy;
#[cfg(any(target_os = "linux", target_os = "freebsd", target_os = "macos"))]
mod reaper;
mod task;
#[cfg(unix)]
mod terminal;
#[cfg(windows)]
mod windows;

const USAGE: &str = concat!(
    "procward ",
    env!("CARGO_PKG_VERSION"),
    "\n\nUsage: procward run [options] -- <command> [args...]\n       procward --help\n       procward --version\n\nOptions: --grace <dur> --fatal-grace <dur> --cleanup-deadline <dur>\nDurations: integer ms or s suffix (for example 750ms, 6s).\n\nUnix terminal jobs use a private PTY; redirected streams retain their destinations.\nTask control: --control-fd <fd> (Unix), --control-handle <handle> (Windows).\n--quiet suppresses only the routine Linux cgroup-fallback startup notice; errors remain visible.\n--retain-descendants keeps task descendants alive after the primary exits (requires task control)."
);
fn main() -> ExitCode {
    match cli(env::args_os().skip(1).collect()) {
        Ok(code) => {
            #[cfg(windows)]
            std::process::exit(code as i32);
            #[cfg(not(windows))]
            ExitCode::from(code as u8)
        }
        Err((code, message)) => {
            diagnostic(message);
            std::process::exit(i32::from(code));
        }
    }
}
fn cli(args: Vec<OsString>) -> Result<u32, (u8, String)> {
    match args.as_slice() {
        [flag] if flag == "--help" || flag == "-h" => {
            println!("{USAGE}");
            Ok(0)
        }
        [flag] if flag == "--version" || flag == "-V" => {
            println!("procward {}", env!("CARGO_PKG_VERSION"));
            Ok(0)
        }
        #[cfg(any(target_os = "linux", target_os = "freebsd", target_os = "macos"))]
        [role, rest @ ..] if role == "__anchor" => owner::anchor(rest)
            .map(u32::from)
            .map_err(|error| (125, error.to_string())),
        #[cfg(target_os = "linux")]
        [role, rest @ ..] if role == "__cgroup_exec" => cgroup::exec(rest)
            .map(u32::from)
            .map_err(|error| (125, error.to_string())),
        #[cfg(unix)]
        [role, rest @ ..] if role == "__terminal_exec" => terminal::exec_ready(rest)
            .map(u32::from)
            .map_err(|error| (125, error.to_string())),
        #[cfg(unix)]
        [role, rest @ ..] if role == "__terminal" => terminal::exec(rest)
            .map(u32::from)
            .map_err(|error| (125, error.to_string())),
        [run, options @ ..] if run == "run" => {
            let config::RunOptions {
                cleanup: config,
                control,
                retain_descendants,
                quiet,
                command_index: index,
            } = config::options(options)?;
            let [command, rest @ ..] = &options[index..] else {
                return Err((125, "missing command after --".into()));
            };
            if command.is_empty() {
                return Err((125, "command must not be empty".into()));
            }
            contract::discard_inherited();
            let mut task = control
                .map(task::Task::open)
                .transpose()
                .map_err(|error| (125, error.to_string()))?;
            #[cfg(any(target_os = "linux", target_os = "freebsd", target_os = "macos"))]
            let result = owner::run(
                command,
                rest,
                config,
                retain_descendants,
                quiet,
                task.as_mut(),
            )
            .map(u32::from);
            #[cfg(windows)]
            let result = {
                let _ = quiet;
                windows::run(command, rest, config, retain_descendants, task.as_mut())
            };
            #[cfg(any(
                target_os = "linux",
                target_os = "freebsd",
                target_os = "macos",
                windows
            ))]
            {
                if let Some(task) = &mut task {
                    task.complete(result.as_ref().ok().copied(), config.deadline)
                        .map_err(|error| (125, error.to_string()))?;
                }
                result.map_err(|error| (125, error.to_string()))
            }
            #[cfg(not(any(
                target_os = "linux",
                target_os = "freebsd",
                target_os = "macos",
                windows
            )))]
            {
                let _ = (rest, config);
                Err((125, "unsupported platform".into()))
            }
        }
        _ => Err((
            125,
            "expected run [options] -- <command> [args...]; see --help".into(),
        )),
    }
}

pub(crate) fn diagnostic(message: String) {
    use std::{sync::mpsc, time::Duration};
    let (send, receive) = mpsc::sync_channel(1);
    // A full inherited stderr must not retain a cleaned controller or block failover.
    if std::thread::Builder::new()
        .name("procward-diagnostic".into())
        .spawn(move || {
            let line = format!("procward: {message}\n");
            // One bounded attempt; the kernel, not procward, decides terminal authority.
            // A TOSTOP background job keeps a single standard SIGTTOU stop and the line
            // is dropped. No SIGTTOU masking, and no write_all/EINTR/EIO retry storm.
            #[cfg(unix)]
            unsafe {
                libc::write(2, line.as_ptr().cast(), line.len());
            }
            #[cfg(not(unix))]
            {
                use std::io::Write;
                let _ = std::io::stderr().write_all(line.as_bytes());
            }
            let _ = send.send(());
        })
        .is_ok()
    {
        let _ = receive.recv_timeout(Duration::from_millis(50));
    }
}
