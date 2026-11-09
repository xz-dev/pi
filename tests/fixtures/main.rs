// SPDX-License-Identifier: BSD-3-Clause
use std::{
    env,
    ffi::OsStr,
    fs,
    io::{self, Read, Write},
    path::Path,
    process::{self, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

#[cfg(target_os = "linux")]
mod hazard;
mod managed;
mod pipes;
#[cfg(unix)]
mod terminal;
#[cfg(windows)]
mod windows;

fn main() {
    let args: Vec<_> = env::args_os().collect();
    match args[1].to_str().unwrap() {
        "responses" => managed::responses(&args[2]),
        #[cfg(unix)]
        "managed-owner" | "managed-blocked" => {
            if let Err(error) =
                managed::owner_loss(Path::new(&args[2]), args[1] == "managed-blocked")
            {
                eprintln!("REJECTED: {error}");
                process::exit(125);
            }
            process::exit(23);
        }
        "task-probe" => {
            if let Err(error) = managed::task_probe(Path::new(&args[2])) {
                eprintln!("REJECTED: {error}");
                process::exit(125);
            }
            process::exit(23);
        }
        "nested-probe" | "nested-tree" => {
            if let Err(error) = managed::nested(Path::new(&args[2]), args[1] == "nested-probe") {
                eprintln!("REJECTED: {error}");
                process::exit(125);
            }
            process::exit(23);
        }
        "managed-probe" => {
            if let Err(error) = managed::probe(Path::new(&args[2])) {
                eprintln!("REJECTED: {error}");
                process::exit(125);
            }
            process::exit(23);
        }
        "managed-ordinary" => managed::ordinary(&args[2], &args[3]),
        #[cfg(unix)]
        "terminal-host" => terminal::host(&args[2], &args[3], Path::new(&args[4])),
        #[cfg(unix)]
        "terminal-child" => terminal::child(Path::new(&args[2])),
        #[cfg(unix)]
        "terminal-worker" => terminal::worker(Path::new(&args[2])),
        // Refuses unless contained; launched only by the disposable VM runner.
        #[cfg(target_os = "linux")]
        "pwbomb" => hazard::pwbomb(args.get(2).map(|cap| cap.as_os_str())),
        #[cfg(target_os = "linux")]
        "tostop-host" => terminal::tostop_host(&args[2], &args[3], Path::new(&args[4]), &args[5]),
        #[cfg(target_os = "linux")]
        "ttou-witness" => terminal::ttou_witness(Path::new(&args[2])),
        #[cfg(windows)]
        "conpty-bootstrap" => windows::conpty_bootstrap(&args[2]),
        #[cfg(windows)]
        "boundary-tree" => windows::boundary_tree(Path::new(&args[2])),
        #[cfg(windows)]
        "boundary-deny" => windows::deny_self(Path::new(&args[2])),
        #[cfg(windows)]
        "console" => windows::interactive(),
        #[cfg(windows)]
        "console-host" => windows::console_host(&args[2], Path::new(&args[3])),
        #[cfg(windows)]
        "job-member" => {
            use windows_sys::Win32::System::{
                JobObjects::{
                    IsProcessInJob, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
                    QueryInformationJobObject,
                },
                Threading::GetCurrentProcess,
            };
            let mut member = 0;
            assert_ne!(
                unsafe { IsProcessInJob(GetCurrentProcess(), std::ptr::null_mut(), &mut member) },
                0
            );
            assert_ne!(member, 0, "payload ran outside Job");
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            assert_ne!(
                unsafe {
                    QueryInformationJobObject(
                        std::ptr::null_mut(),
                        JobObjectExtendedLimitInformation,
                        (&mut limits as *mut JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                        std::mem::size_of_val(&limits) as u32,
                        std::ptr::null_mut(),
                    )
                },
                0
            );
            assert_ne!(
                limits.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                0,
                "payload began before kill-on-close Job policy"
            );
            process::exit(23);
        }
        #[cfg(windows)]
        "limited-launch" => {
            use windows_sys::Win32::{
                Foundation::CloseHandle,
                System::{JobObjects::*, Threading::GetCurrentProcess},
            };
            let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            assert!(!job.is_null());
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
            limits.BasicLimitInformation.ActiveProcessLimit = 1;
            assert_ne!(
                unsafe {
                    SetInformationJobObject(
                        job,
                        JobObjectExtendedLimitInformation,
                        (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                        std::mem::size_of_val(&limits) as u32,
                    )
                },
                0
            );
            assert_ne!(
                unsafe { AssignProcessToJobObject(job, GetCurrentProcess()) },
                0
            );
            let attempt = Command::new(&args[2])
                .args(["run", "--"])
                .arg(env::current_exe().unwrap())
                .arg("touch")
                .arg(&args[3])
                .status();
            if let Ok(status) = attempt {
                assert!(
                    !status.success(),
                    "restricted payload unexpectedly succeeded"
                );
            }
            assert!(!Path::new(&args[3]).try_exists().unwrap());
            assert_ne!(unsafe { CloseHandle(job) }, 0);
            process::exit(23);
        }
        "probe" => {
            let mut out = io::stdout().lock();
            for arg in &args[2..] {
                record(&mut out, arg);
            }
            record(&mut out, env::current_dir().unwrap().as_os_str());
            record(&mut out, &env::var_os("PROCWARD_TEST_VALUE").unwrap());
            let mut input = Vec::new();
            io::stdin().read_to_end(&mut input).unwrap();
            out.write_all(&input).unwrap();
            out.flush().unwrap();
            eprintln!("fixture-stderr");
            process::exit(23);
        }
        "exit" => process::exit(args[2].to_str().unwrap().parse::<u32>().unwrap() as i32),
        "touch" => fs::write(&args[2], b"payload ran").unwrap(),
        "await" => wait_for(Path::new(&args[2])),
        // Installed setuid root: "keep" retains the caller's real UID (like ps), "root"
        // becomes fully root (like sudo); "nondumpable" runs unprivileged.
        #[cfg(unix)]
        "boundary" => {
            let dir = Path::new(&args[2]);
            let kind = args[3].to_str().unwrap();
            #[cfg(target_os = "linux")]
            let caller = unsafe { libc::getuid() };
            if matches!(kind, "root" | "guardian") && rustix::process::geteuid().is_root() {
                // POSIX: a privileged setuid() sets real, effective and saved UIDs.
                assert_eq!(unsafe { libc::setuid(0) }, 0);
            }
            // A fully root guardian stays alive and denied while its child, dropped back
            // to the caller's UID, is signalable but never adopted by procward.
            #[cfg(target_os = "linux")]
            let _ward = (kind == "guardian").then(|| {
                use std::os::unix::process::CommandExt;
                Command::new(env::current_exe().unwrap())
                    .args([OsStr::new("boundary"), dir.as_os_str(), OsStr::new("ward")])
                    .arg(caller.to_string())
                    .uid(caller)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .unwrap()
            });
            #[cfg(target_os = "linux")]
            if kind == "ward" {
                let user = args[4].to_str().unwrap().parse().unwrap();
                // Re-exec of the setuid helper regained root; drop real, effective and saved.
                assert_eq!(unsafe { libc::setuid(user) }, 0);
                signal_hook::flag::register(
                    signal_hook::consts::SIGTERM,
                    std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                )
                .unwrap();
            }
            #[cfg(target_os = "linux")]
            if kind == "nondumpable" {
                assert_eq!(unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) }, 0);
            }
            let record = dir.join(format!("{kind}.tmp"));
            let ids = unsafe { (libc::getuid(), libc::geteuid()) };
            fs::write(&record, format!("{} {} {}", process::id(), ids.0, ids.1)).unwrap();
            fs::rename(record, dir.join(format!("{kind}.pid"))).unwrap();
            loop {
                if matches!(kind, "root" | "guardian") && dir.join("release").exists() {
                    process::exit(0);
                }
                thread::sleep(Duration::from_millis(5));
            }
        }
        mode => {
            let dir = Path::new(&args[2]);
            fs::write(dir.join(format!("{mode}.pid")), process::id().to_string()).unwrap();
            match mode {
                #[cfg(target_os = "macos")]
                "observed-tree" => {
                    let _worker = spawn("observed-worker", dir);
                    wait_for(&dir.join("observed-ready"));
                    wait_for(&dir.join("detach"));
                    process::exit(23);
                }
                #[cfg(target_os = "macos")]
                "observed-worker" => {
                    fs::write(dir.join("observed-ready"), b"ready").unwrap();
                    wait_for(&dir.join("detach"));
                    rustix::process::setsid().unwrap();
                    fs::write(dir.join("observed-detached"), b"detached").unwrap();
                    loop {
                        thread::park();
                    }
                }
                #[cfg(target_os = "macos")]
                "fast-escape" => {
                    let _worker = spawn("escape-worker", dir);
                    wait_for(&dir.join("escaped"));
                    wait_for(&dir.join("exit-escape"));
                }
                #[cfg(target_os = "macos")]
                "escape-worker" => {
                    rustix::process::setsid().unwrap();
                    fs::write(dir.join("escaped"), b"escaped").unwrap();
                    loop {
                        thread::park();
                    }
                }
                #[cfg(any(target_os = "linux", target_os = "freebsd"))]
                "cleanup-order" => {
                    let _worker = spawn("order-worker", dir);
                    wait_for(&dir.join("order-ready"));
                    wait_for_input();
                    process::exit(23);
                }
                #[cfg(any(target_os = "linux", target_os = "freebsd"))]
                "order-worker" => {
                    use std::sync::{
                        Arc,
                        atomic::{AtomicBool, AtomicUsize, Ordering},
                    };
                    let term = Arc::new(AtomicBool::new(false));
                    signal_hook::flag::register(signal_hook::consts::SIGTERM, term.clone())
                        .unwrap();
                    let cont = Arc::new(AtomicUsize::new(0));
                    let seen = cont.clone();
                    unsafe {
                        signal_hook::low_level::register(signal_hook::consts::SIGCONT, move || {
                            seen.fetch_add(1, Ordering::SeqCst);
                        })
                        .unwrap();
                    }
                    fs::write(dir.join("order-ready"), b"ready").unwrap();
                    rustix::process::kill_process(
                        rustix::process::getpid(),
                        rustix::process::Signal::STOP,
                    )
                    .unwrap();
                    loop {
                        let record = dir.join("order-observed.tmp");
                        fs::write(
                            &record,
                            format!(
                                "{} {}",
                                term.load(Ordering::SeqCst),
                                cont.load(Ordering::SeqCst)
                            ),
                        )
                        .unwrap();
                        fs::rename(record, dir.join("order-observed")).unwrap();
                        thread::park_timeout(Duration::from_millis(5));
                    }
                }
                #[cfg(any(target_os = "linux", target_os = "freebsd"))]
                "stubborn" => {
                    signal_hook::flag::register(
                        signal_hook::consts::SIGTERM,
                        std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                    )
                    .unwrap();
                    fs::write(dir.join("ready"), b"ready").unwrap();
                    loop {
                        thread::park();
                    }
                }
                #[cfg(any(target_os = "linux", target_os = "freebsd"))]
                "detached-tree" => {
                    let _branch = spawn("detached-branch", dir);
                    wait_for(&dir.join("stopped-worker.pid"));
                    wait_for_input();
                    process::exit(23);
                }
                #[cfg(any(target_os = "linux", target_os = "freebsd"))]
                "detached-branch" => {
                    #[cfg(target_os = "freebsd")]
                    rustix::process::set_reaper_status(true).unwrap();
                    rustix::process::setsid().unwrap();
                    spawn("stopped-worker", dir).wait().unwrap();
                }
                #[cfg(any(target_os = "linux", target_os = "freebsd"))]
                "stopped-worker" => {
                    rustix::process::kill_process(
                        rustix::process::getpid(),
                        rustix::process::Signal::STOP,
                    )
                    .unwrap();
                    loop {
                        thread::park();
                    }
                }
                #[cfg(unix)]
                "deadline-failover" => {
                    use std::sync::{
                        Arc,
                        atomic::{AtomicBool, Ordering},
                    };
                    let term = Arc::new(AtomicBool::new(false));
                    signal_hook::flag::register(signal_hook::consts::SIGTERM, term.clone())
                        .unwrap();
                    fs::write(dir.join("ready"), b"ready").unwrap();
                    let mut cleanup = None;
                    let mut late = false;
                    loop {
                        if term.load(Ordering::SeqCst) && cleanup.is_none() {
                            cleanup = Some(Instant::now());
                            fs::write(dir.join("cleanup-start"), b"TERM observed").unwrap();
                        }
                        if !late
                            && cleanup
                                .is_some_and(|start| start.elapsed() >= Duration::from_millis(1800))
                        {
                            fs::write(dir.join("late-cleanup"), b"late work reached").unwrap();
                            late = true;
                        }
                        thread::park_timeout(Duration::from_millis(5));
                    }
                }
                #[cfg(windows)]
                "job-wait" => {
                    let _branch = spawn("branch", dir);
                    wait_for(&dir.join("worker.pid"));
                    wait_for(&dir.join("release"));
                    process::exit(23);
                }
                #[cfg(unix)]
                "task-tree" => {
                    let _worker = spawn("task-worker", dir);
                    fs::write(
                        dir.join("task-anchor"),
                        env::var("PROCWARD_OWNER_PID").unwrap(),
                    )
                    .unwrap();
                    wait_for(&dir.join("task-worker-ready"));
                    wait_for_input();
                    process::exit(23);
                }
                #[cfg(unix)]
                "task-worker" => {
                    signal_hook::flag::register(
                        signal_hook::consts::SIGTERM,
                        std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                    )
                    .unwrap();
                    fs::write(dir.join("task-worker-ready"), b"ready").unwrap();
                    loop {
                        thread::park();
                    }
                }
                "blocked-stderr" => {
                    io::stderr()
                        .write_all(&vec![b'e'; 2 * 1024 * 1024])
                        .unwrap();
                    wait_for_input();
                }
                #[cfg(target_os = "linux")]
                "cgroup-tree" => {
                    // Membership is recorded before and after the first fork.
                    record_cgroup(dir, mode);
                    let _worker = spawn("cgroup-worker", dir);
                    wait_for(&dir.join("cgroup-worker.cgroup"));
                    wait_for_input();
                    process::exit(23);
                }
                #[cfg(target_os = "linux")]
                "cgroup-worker" => {
                    rustix::process::setsid().unwrap();
                    signal_hook::flag::register(
                        signal_hook::consts::SIGTERM,
                        std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                    )
                    .unwrap();
                    record_cgroup(dir, mode);
                    loop {
                        thread::park();
                    }
                }
                // A live TERM-ignoring root holding a small TERM-ignoring subtree: while the
                // root lives, only a recursive KILL reaches these nondirect descendants.
                #[cfg(target_os = "linux")]
                "fd-tree" => {
                    signal_hook::flag::register(
                        signal_hook::consts::SIGTERM,
                        std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                    )
                    .unwrap();
                    let count: usize = args[3].to_str().unwrap().parse().unwrap();
                    let leaves: Vec<_> = (0..count).map(|_| spawn("fd-leaf", dir)).collect();
                    let pids: Vec<_> = leaves.iter().map(|leaf| leaf.id().to_string()).collect();
                    fs::write(dir.join("fd-leaves.tmp"), pids.join(" ")).unwrap();
                    fs::rename(dir.join("fd-leaves.tmp"), dir.join("fd-leaves")).unwrap();
                    loop {
                        thread::park();
                    }
                }
                #[cfg(target_os = "linux")]
                "fd-leaf" => {
                    signal_hook::flag::register(
                        signal_hook::consts::SIGTERM,
                        std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                    )
                    .unwrap();
                    loop {
                        thread::park();
                    }
                }
                "tree" => {
                    let _branch = spawn("branch", dir);
                    wait_for(&dir.join("worker.pid"));
                    wait_for_input();
                    process::exit(23);
                }
                "nested-branch" => {
                    #[cfg(any(target_os = "linux", target_os = "freebsd"))]
                    rustix::process::setsid().unwrap();
                    #[cfg(target_os = "freebsd")]
                    rustix::process::set_reaper_status(true).unwrap();
                    spawn("nested-worker", dir).wait().unwrap();
                }
                "nested-worker" => {
                    #[cfg(unix)]
                    signal_hook::flag::register(
                        signal_hook::consts::SIGTERM,
                        std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                    )
                    .unwrap();
                    fs::write(dir.join("nested-worker-ready"), b"ready").unwrap();
                    #[cfg(any(target_os = "linux", target_os = "freebsd"))]
                    rustix::process::kill_process(
                        rustix::process::getpid(),
                        rustix::process::Signal::STOP,
                    )
                    .unwrap();
                    loop {
                        thread::park();
                    }
                }
                "branch" => {
                    spawn("worker", dir).wait().unwrap();
                }
                "worker" => loop {
                    thread::park();
                },
                "orphan" => {
                    assert_eq!(spawn("orphan-parent", dir).wait().unwrap().code(), Some(17));
                    fs::write(dir.join("ready"), b"ready").unwrap();
                    wait_for_input();
                    process::exit(23);
                }
                "orphan-parent" => {
                    let _orphan = spawn("orphan-child", dir);
                    wait_for(&dir.join("orphan-child.pid"));
                    process::exit(17);
                }
                "orphan-child" => {
                    wait_for(&dir.join("release"));
                    process::exit(19);
                }
                "waiting" => wait_for_input(),
                _ => panic!("unknown fixture mode: {mode}"),
            }
        }
    }
}

fn record(out: &mut impl Write, value: &OsStr) {
    #[cfg(unix)]
    let bytes = {
        use std::os::unix::ffi::OsStrExt;
        value.as_bytes().to_vec()
    };
    #[cfg(windows)]
    let bytes: Vec<_> = {
        use std::os::windows::ffi::OsStrExt;
        value.encode_wide().flat_map(u16::to_le_bytes).collect()
    };
    out.write_all(&(bytes.len() as u32).to_le_bytes()).unwrap();
    out.write_all(&bytes).unwrap();
}

#[cfg(target_os = "linux")]
fn record_cgroup(dir: &Path, mode: &str) {
    let membership = fs::read_to_string("/proc/self/cgroup").unwrap();
    let record = dir.join(format!("{mode}.cgroup.tmp"));
    fs::write(&record, membership).unwrap();
    fs::rename(record, dir.join(format!("{mode}.cgroup"))).unwrap();
}

fn spawn(mode: &str, dir: &Path) -> process::Child {
    Command::new(env::current_exe().unwrap())
        .arg(mode)
        .arg(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
}

fn wait_for(path: &Path) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !path.try_exists().unwrap() {
        assert!(Instant::now() < deadline, "fixture timed out: {path:?}");
        thread::sleep(Duration::from_millis(5));
    }
}

fn wait_for_input() {
    let mut byte = [0];
    io::stdin().read_exact(&mut byte).unwrap();
}
