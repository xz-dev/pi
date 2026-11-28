// SPDX-License-Identifier: BSD-3-Clause
use rustix::{
    fd::{BorrowedFd, FromRawFd, OwnedFd},
    io::{self as rio},
    process::{self as rp, Pid, Signal, WaitOptions},
    termios,
};
use std::{
    env, fs,
    io::Write,
    os::unix::process::CommandExt,
    path::Path,
    process::Command,
    thread,
    time::{Duration, Instant},
};

pub fn host(fd: &std::ffi::OsStr, binary: &std::ffi::OsStr, dir: &Path) {
    let fd = fd.to_str().unwrap().parse::<i32>().unwrap();
    rustix_openpty::login_tty(unsafe { OwnedFd::from_raw_fd(fd) }).unwrap();
    let tty = unsafe { BorrowedFd::borrow_raw(0) };
    let saved = observe_settings(tty);
    publish(
        dir.join("shell-session"),
        rp::getsid(None).unwrap().to_string(),
    )
    .unwrap();
    publish(dir.join("saved-state"), format!("{saved:?}")).unwrap();
    let mut child = Command::new(binary);
    child
        .args([
            "run",
            "--grace",
            "500ms",
            "--fatal-grace",
            "250ms",
            "--cleanup-deadline",
            "1500ms",
            "--",
        ])
        .arg(env::current_exe().unwrap())
        .arg("terminal-child")
        .arg(dir)
        .process_group(0);
    if dir.join("redirect").exists() {
        child.stderr(fs::File::create(dir.join("stderr")).unwrap());
    }
    unsafe {
        child.pre_exec(|| {
            for signal in [libc::SIGTTIN, libc::SIGTTOU] {
                libc::signal(signal, libc::SIG_DFL);
            }
            Ok(())
        });
    }
    #[expect(
        clippy::zombie_processes,
        reason = "waitpid below consumes both stopped and terminal child statuses"
    )]
    let child = child.spawn().unwrap();
    let pid = Pid::from_raw(child.id() as i32).unwrap();
    publish(dir.join("owner"), child.id().to_string()).unwrap();
    // TTOU denial must not be hidden in production; shell fixture uses its normal shell policy.
    unsafe {
        libc::signal(signal_hook::consts::SIGTTOU, libc::SIG_IGN);
    }
    let startup = Instant::now() + Duration::from_secs(20);
    loop {
        // Linux: a transient cgroup membership probe child may precede the real anchor.
        let children: Vec<_> = owner_children(pid)
            .into_iter()
            .filter(|child| is_anchor(*child))
            .collect();
        if let [anchor] = children.as_slice() {
            publish(dir.join("anchor"), anchor.to_string()).unwrap();
            break;
        }
        assert!(Instant::now() < startup, "native controller did not start");
        thread::sleep(Duration::from_millis(2));
    }
    while rp::getpgid(Some(pid)).unwrap() != pid
        || rp::getsid(Some(pid)).unwrap() != rp::getsid(None).unwrap()
    {
        assert!(
            Instant::now() < startup,
            "shell job group was not ready for foreground handoff"
        );
        thread::sleep(Duration::from_millis(2));
    }
    if !dir.join("never-raw").exists() {
        termios::tcsetpgrp(tty, pid).unwrap();
    }
    let deadline = Instant::now() + Duration::from_secs(25);
    let mut sequence = 0;
    loop {
        if let Some((_, status)) =
            rp::waitpid(Some(pid), WaitOptions::NOHANG | WaitOptions::UNTRACED).unwrap()
        {
            if status.stopped() {
                termios::tcsetpgrp(tty, rp::getpgrp()).unwrap();
                publish(
                    dir.join("paused-state"),
                    format!("{:?}", observe_settings(tty)),
                )
                .unwrap();
                publish(
                    dir.join("stopped"),
                    format!(
                        "{}",
                        format!("{:?}", observe_settings(tty)) == format!("{saved:?}")
                    ),
                )
                .unwrap();
            } else if let Some(code) = status
                .exit_status()
                .or_else(|| status.terminating_signal().map(|s| 128 + s))
            {
                termios::tcsetpgrp(tty, rp::getpgrp()).unwrap();
                publish(dir.join("result"), code.to_string()).unwrap();
                publish(
                    dir.join("restored"),
                    format!(
                        "{}",
                        format!("{:?}", observe_settings(tty)) == format!("{saved:?}")
                    ),
                )
                .unwrap();
                publish(
                    dir.join("returned-state"),
                    format!("{:?}", observe_settings(tty)),
                )
                .unwrap();
                while !dir.join("finish").exists() {
                    assert!(Instant::now() < deadline, "shell hold deadline");
                    thread::sleep(Duration::from_millis(2));
                }
                publish(
                    dir.join("takeover-final"),
                    format!("{:?}", observe_settings(tty)),
                )
                .unwrap();
                return;
            }
        }
        let action = dir.join(format!("action-{sequence}"));
        if let Ok(text) = fs::read_to_string(&action) {
            match text.as_str() {
                "bg" => rp::kill_process_group(pid, Signal::CONT).unwrap(),
                "continue-owner" => rp::kill_process(pid, Signal::CONT).unwrap(),
                "fg" => {
                    termios::tcsetpgrp(tty, pid).unwrap();
                    rp::kill_process_group(pid, Signal::CONT).unwrap();
                }
                "reclaim" => termios::tcsetpgrp(tty, rp::getpgrp()).unwrap(),
                "handoff" => termios::tcsetpgrp(tty, pid).unwrap(),
                "stop-anchor" => {
                    let anchor = fs::read_to_string(dir.join("anchor"))
                        .unwrap()
                        .parse()
                        .unwrap();
                    rp::kill_process(Pid::from_raw(anchor).unwrap(), Signal::STOP).unwrap();
                }
                "takeover" => {
                    termios::tcsetpgrp(tty, rp::getpgrp()).unwrap();
                    let mut state = observe_settings(tty);
                    state.local_modes ^= termios::LocalModes::ECHO;
                    termios::tcsetattr(tty, termios::OptionalActions::Now, &state).unwrap();
                    publish(dir.join("takeover"), format!("{state:?}")).unwrap();
                }
                "race" => {
                    let worker = fs::read_to_string(dir.join("worker"))
                        .unwrap()
                        .parse::<i32>()
                        .unwrap();
                    rp::kill_process(Pid::from_raw(worker).unwrap(), Signal::CONT).unwrap();
                }
                "term" => rp::kill_process(pid, Signal::TERM).unwrap(),
                "kill-anchor" => {
                    let anchor = fs::read_to_string(dir.join("anchor"))
                        .unwrap()
                        .parse()
                        .unwrap();
                    rp::kill_process(Pid::from_raw(anchor).unwrap(), Signal::KILL).unwrap();
                }
                "kill" => rp::kill_process(pid, Signal::KILL).unwrap(),
                _ => panic!("unknown terminal action"),
            }
            publish(dir.join(format!("acted-{sequence}")), b"done").unwrap();
            sequence += 1;
        }
        assert!(Instant::now() < deadline, "terminal host deadline");
        thread::sleep(Duration::from_millis(2));
    }
}

pub fn child(dir: &Path) {
    assert_eq!(
        crate::managed::terminal_handoff().unwrap(),
        rp::getppid().unwrap().as_raw_nonzero().get() as u32
    );
    let stdin = unsafe { BorrowedFd::borrow_raw(0) };
    let group = rp::getpgrp();
    let tty = rustix::fs::open(
        "/dev/tty",
        rustix::fs::OFlags::RDWR | rustix::fs::OFlags::CLOEXEC,
        rustix::fs::Mode::empty(),
    )
    .unwrap();
    let terminal = termios::tcgetpgrp(&tty).unwrap();
    publish(dir.join("primary"), std::process::id().to_string()).unwrap();
    publish(dir.join("keeper"), rp::getppid().unwrap().to_string()).unwrap();
    publish(
        dir.join("terminal"),
        format!(
            "{} {} {}",
            group,
            terminal,
            termios::tcgetsid(&tty).unwrap()
        ),
    )
    .unwrap();
    let mut state = termios::tcgetattr(stdin).unwrap();
    state.make_raw();
    state.local_modes |= termios::LocalModes::ISIG;
    termios::tcsetattr(stdin, termios::OptionalActions::Now, &state).unwrap();
    let interrupts = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let seen = interrupts.clone();
    unsafe {
        signal_hook::low_level::register(signal_hook::consts::SIGINT, move || {
            seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        })
        .unwrap();
    }
    #[expect(
        clippy::zombie_processes,
        reason = "fixture leaves detached descendant for procward cleanup"
    )]
    let _worker = Command::new(env::current_exe().unwrap())
        .arg("terminal-worker")
        .arg(dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let worker_ready = Instant::now() + Duration::from_secs(20);
    while !dir.join("worker").exists() {
        assert!(
            Instant::now() < worker_ready,
            "detached worker startup deadline"
        );
        thread::sleep(Duration::from_millis(2));
    }
    publish(dir.join("ready"), b"ready").unwrap();
    println!("TTY-READY");
    std::io::stdout().flush().unwrap();
    let mut byte = [0];
    loop {
        match rio::read(stdin, &mut byte) {
            Ok(1) => match byte[0] {
                b'q' => {
                    if dir.to_string_lossy().ends_with("tail") {
                        std::io::stdout().write_all(&vec![b'x'; 262144]).unwrap();
                    }
                    println!("FINAL-TAIL");
                    std::io::stdout().flush().unwrap();
                    eprintln!("REDIRECTED-TAIL");
                    std::io::stderr().flush().unwrap();
                    publish(
                        dir.join("tail-written"),
                        b"both streams flushed before primary exit",
                    )
                    .unwrap();
                    std::process::exit(23);
                }
                b'f' => {
                    println!("FLOOD-BEGIN");
                    std::io::stdout().flush().unwrap();
                    for n in 1..16384 {
                        std::io::stdout().write_all(&[b'x'; 4096]).unwrap();
                        publish(dir.join("flood-count"), n.to_string()).unwrap();
                    }
                    publish(dir.join("flood-done"), b"done").unwrap();
                }
                b'p' => {
                    println!(
                        "REPLY {}",
                        interrupts.load(std::sync::atomic::Ordering::SeqCst)
                    );
                    std::io::stdout().flush().unwrap();
                }
                26 => {
                    rp::kill_process(rp::getpid(), Signal::TSTP).unwrap();
                }
                _ => {}
            },
            Err(rustix::io::Errno::INTR) => {}
            other => panic!("terminal input: {other:?}"),
        }
    }
}

pub fn worker(dir: &Path) {
    assert!(
        std::env::var_os("PROCWARD_PROTOCOL").is_none(),
        "terminal tool inherited managed claim"
    );
    rp::setsid().unwrap();
    publish(dir.join("worker"), std::process::id().to_string()).unwrap();
    let mut sequence = 0;
    loop {
        if dir.join(format!("ping-{sequence}")).exists() {
            publish(dir.join(format!("pong-{sequence}")), b"alive").unwrap();
            sequence += 1;
        }
        thread::sleep(Duration::from_millis(2));
    }
}

// Shell-like session leader: procward runs as a background job of a TOSTOP terminal.
#[cfg(target_os = "linux")]
pub fn tostop_host(
    fd: &std::ffi::OsStr,
    binary: &std::ffi::OsStr,
    dir: &Path,
    mode: &std::ffi::OsStr,
) {
    // A fresh test-owned group whose cgroup.max.descendants is 0 forces the weaker backend.
    if let Some(group) = env::var_os("PROCWARD_TEST_FALLBACK_GROUP") {
        fs::write(
            Path::new(&group).join("cgroup.procs"),
            std::process::id().to_string(),
        )
        .unwrap();
    }
    let fd = fd.to_str().unwrap().parse::<i32>().unwrap();
    rustix_openpty::login_tty(unsafe { OwnedFd::from_raw_fd(fd) }).unwrap();
    let tty = unsafe { BorrowedFd::borrow_raw(0) };
    let mut state = termios::tcgetattr(tty).unwrap();
    state.local_modes |= termios::LocalModes::TOSTOP;
    termios::tcsetattr(tty, termios::OptionalActions::Now, &state).unwrap();
    let quiet = || std::process::Stdio::null();
    // The witness leads the background job group and counts every SIGTTOU sent to the job.
    let mut witness = Command::new(env::current_exe().unwrap())
        .arg("ttou-witness")
        .arg(dir)
        .process_group(0)
        .stdin(quiet())
        .stdout(quiet())
        .stderr(quiet())
        .spawn()
        .unwrap();
    let witness_cpu = {
        let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
        unsafe { libc::getrusage(libc::RUSAGE_CHILDREN, &mut usage) };
        usage
    };
    let deadline = Instant::now() + Duration::from_secs(10);
    while !dir.join("witness-ready").exists() {
        assert!(Instant::now() < deadline, "witness startup deadline");
        thread::sleep(Duration::from_millis(2));
    }
    let mut owner = Command::new(binary);
    owner
        .args([
            "run",
            "--grace",
            "300ms",
            "--fatal-grace",
            "150ms",
            "--cleanup-deadline",
            "1500ms",
            "--",
            "/bin/sh",
            "-c",
            "sleep 0.3; exit 7",
        ])
        .process_group(witness.id() as i32);
    if mode != "interactive" {
        owner.stdin(quiet()).stdout(quiet());
    }
    if dir.join("redirect").exists() {
        owner.stderr(fs::File::create(dir.join("stderr")).unwrap());
    }
    unsafe {
        owner.pre_exec(|| {
            for signal in [libc::SIGTTIN, libc::SIGTTOU] {
                libc::signal(signal, libc::SIG_DFL);
            }
            Ok(())
        });
    }
    #[expect(
        clippy::zombie_processes,
        reason = "waitpid below consumes stopped and terminal statuses"
    )]
    let owner = owner.spawn().unwrap();
    let pid = Pid::from_raw(owner.id() as i32).unwrap();
    let started = Instant::now();
    let mut stops = 0;
    let code = loop {
        assert!(Instant::now() < deadline, "background procward deadline");
        match rp::waitpid(Some(pid), WaitOptions::NOHANG | WaitOptions::UNTRACED).unwrap() {
            Some((_, status)) if status.stopped() => {
                // A standard job stop is allowed; resume the job as a shell `bg` would.
                stops += 1;
                rp::kill_process_group(Pid::from_raw(witness.id() as i32).unwrap(), Signal::CONT)
                    .unwrap();
            }
            Some((_, status)) => {
                break status
                    .exit_status()
                    .or_else(|| status.terminating_signal().map(|s| 128 + s))
                    .unwrap();
            }
            None => thread::sleep(Duration::from_millis(2)),
        }
    };
    // CPU of procward and every role it reaped: a retry storm burns the whole run.
    // RUSAGE_CHILDREN also includes the still-parked witness; subtract its usage
    // so only work spawned after it is charged to the storm budget.
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    assert_eq!(
        unsafe { libc::getrusage(libc::RUSAGE_CHILDREN, &mut usage) },
        0
    );
    let spent = |before: libc::timeval, after: libc::timeval| {
        let seconds = after.tv_sec - before.tv_sec;
        let microseconds = after.tv_usec - before.tv_usec;
        seconds * 1000 + microseconds / 1000
    };
    let cpu = (spent(witness_cpu.ru_utime, usage.ru_utime)
        + spent(witness_cpu.ru_stime, usage.ru_stime))
    .max(0)
    .to_string();
    publish(dir.join("cpu-ms"), cpu.as_bytes()).unwrap();
    publish(
        dir.join("elapsed-ms"),
        started.elapsed().as_millis().to_string().as_bytes(),
    )
    .unwrap();
    publish(dir.join("stops"), stops.to_string()).unwrap();
    publish(dir.join("witness-stop"), b"stop").unwrap();
    witness.wait().unwrap();
    publish(dir.join("result"), code.to_string()).unwrap();
}

#[cfg(target_os = "linux")]
pub fn ttou_witness(dir: &Path) {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    let count = Arc::new(AtomicUsize::new(0));
    let seen = count.clone();
    unsafe {
        signal_hook::low_level::register(signal_hook::consts::SIGTTOU, move || {
            seen.fetch_add(1, Ordering::SeqCst);
        })
        .unwrap();
    }
    publish(dir.join("witness-ready"), b"ready").unwrap();
    while !dir.join("witness-stop").exists() {
        thread::sleep(Duration::from_millis(2));
    }
    publish(
        dir.join("ttou-count"),
        count.load(Ordering::SeqCst).to_string(),
    )
    .unwrap();
}

fn publish(path: impl AsRef<Path>, bytes: impl AsRef<[u8]>) -> std::io::Result<()> {
    let path = path.as_ref();
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, bytes)?;
    fs::rename(temporary, path)
}

fn observe_settings(tty: BorrowedFd<'_>) -> termios::Termios {
    // BSD settles its transient PENDIN on a readiness query, without consuming or flushing input.
    rio::ioctl_fionread(tty).unwrap();
    termios::tcgetattr(tty).unwrap()
}

fn is_anchor(pid: u32) -> bool {
    #[cfg(target_os = "linux")]
    return fs::read(format!("/proc/{pid}/cmdline"))
        .is_ok_and(|argv| argv.split(|byte| *byte == 0).nth(1) == Some(b"__anchor"));
    #[cfg(not(target_os = "linux"))]
    {
        let _ = pid;
        true
    }
}

fn owner_children(owner: Pid) -> Vec<u32> {
    #[cfg(target_os = "linux")]
    return fs::read_to_string(format!("/proc/{owner}/task/{owner}/children"))
        .unwrap()
        .split_whitespace()
        .map(|v| v.parse().unwrap())
        .collect();
    #[cfg(target_os = "freebsd")]
    {
        let selector = Some((rp::IdType::Pid, owner));
        if !rp::get_reaper_status(selector)
            .unwrap()
            .flags
            .contains(rp::ReaperStatusFlags::OWNED)
        {
            return Vec::new();
        }
        return rp::get_reaper_pids(Some((rp::IdType::Pid, owner)))
            .unwrap()
            .into_iter()
            .filter(|info| info.flags.contains(rp::PidInfoFlags::CHILD))
            .map(|info| info.pid.as_raw_nonzero().get() as u32)
            .collect();
    }
    #[cfg(target_os = "macos")]
    {
        errno::set_errno(errno::Errno(0));
        libproc::processes::pids_by_type(libproc::processes::ProcFilter::ByParentProcess {
            ppid: owner.as_raw_nonzero().get() as u32,
        })
        .unwrap()
    }
}
