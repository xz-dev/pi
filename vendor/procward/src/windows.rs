// SPDX-License-Identifier: BSD-3-Clause
use process_wrap::tokio::{CommandWrap, JobObject, KillOnDrop};
use std::{
    ffi::{OsStr, OsString},
    io,
    time::Duration,
};

use std::sync::atomic::{AtomicBool, Ordering};
use windows_sys::Win32::System::Console::{CTRL_BREAK_EVENT, CTRL_C_EVENT, SetConsoleCtrlHandler};
static CLOSING: AtomicBool = AtomicBool::new(false);
unsafe extern "system" fn console_control(event: u32) -> i32 {
    if event != CTRL_C_EVENT && event != CTRL_BREAK_EVENT {
        CLOSING.store(true, Ordering::SeqCst);
    }
    // The console delivers C/Break to the payload itself; forwarding would duplicate it.
    1
}

pub fn run(
    command: &OsStr,
    args: &[OsString],
    config: crate::config::Config,
    mut task: Option<&mut crate::task::Task>,
) -> io::Result<u32> {
    if unsafe { SetConsoleCtrlHandler(Some(console_control), 1) } == 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(windows_sys::Win32::Foundation::ERROR_INVALID_HANDLE as i32)
        {
            return Err(error);
        }
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let result = runtime.block_on(async {
        let mut handoff = crate::contract::Handoff::new()?;
        let mut command = tokio::process::Command::new(command);
        command.args(args);
        crate::contract::clear(command.as_std_mut());
        command.envs(handoff.environment()?);
        let mut child = CommandWrap::from(command)
            .wrap(KillOnDrop)
            .wrap(JobObject)
            .spawn()?;
        let ready = handoff.ready(
            child
                .id()
                .ok_or_else(|| io::Error::other("primary PID missing"))?,
        );
        let mut notified = false;
        // JobObject::wait waits for the entire Job; observe only its immediate inner primary first.
        let status = loop {
            if CLOSING.load(Ordering::SeqCst) || task.as_mut().is_some_and(|task| task.poll()) {
                if !notified {
                    let _ = handoff.owner_lost();
                    notified = true;
                }
                child.start_kill()?;
            }
            if let Some(status) = child.inner_mut().try_wait()? {
                if let Some(task) = &mut task {
                    task.primary(status.code().expect("native process status") as u32)?;
                }
                break status;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        };
        child.start_kill()?;
        tokio::time::timeout(config.deadline, child.wait())
            .await
            .map_err(|_| io::Error::other("Job completion deadline expired"))??;
        ready?;
        Ok(status
            .code()
            .expect("Windows process has a native exit code") as u32)
    });
    // A timed-out completion-port blocking task must not make runtime destruction unbounded.
    runtime.shutdown_timeout(Duration::from_millis(50));
    result
}
