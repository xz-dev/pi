// SPDX-License-Identifier: BSD-3-Clause
// HAZARDOUS adversarial workload. Faithful port of `pwbomb-original.c` in this directory: the
// independent review reproducer, kept byte-for-byte and never built (SHA256
// a4804e7d5f506c425e527295d2b7c356724daa18caf9c365849a7455098ab89f). It runs a live root that
// ignores TERM, a capped live chain (deep), an UNCAPPED rolling chain (endless fresh PIDs) and a
// capped wide forker. Do not cap the rolling chain: that adversarial behaviour is the test.
//
// Execution safety is external: only the disposable VM runner may launch this, inside a group
// with finite hard caps. The mode also refuses to fork unless its own cgroup proves that.
use std::{env, ffi::OsStr, fs, io::Write, path::Path, process, sync::atomic::AtomicI32};

const MAX_PIDS: u64 = 768;
const MAX_MEMORY: u64 = 512 << 20;

// The expected containment group must be this process's own group (or an ancestor of it) and
// carry finite pids.max and memory.max within the approved bounds.
fn contained() -> Result<(), String> {
    let host_boot = env::var("PROCWARD_VM_HOST_BOOT_ID")
        .map_err(|_| "disposable full-system VM proof is missing".to_owned())?;
    let boot = fs::read_to_string("/proc/sys/kernel/random/boot_id").map_err(|e| e.to_string())?;
    if host_boot.trim() == boot.trim() {
        return Err("the workload must not run on the host kernel".to_owned());
    }
    let expected = env::var("PROCWARD_HAZARD_GROUP")
        .map_err(|_| "PROCWARD_HAZARD_GROUP names no containment group".to_owned())?;
    if !expected.starts_with('/') || expected == "/" || expected.split('/').any(|p| p == "..") {
        return Err(format!("unacceptable containment group {expected:?}"));
    }
    let membership = fs::read_to_string("/proc/self/cgroup").map_err(|e| e.to_string())?;
    let own = membership
        .lines()
        .find_map(|line| line.strip_prefix("0::"))
        .ok_or("no cgroup v2 membership")?;
    if own != expected && !own.starts_with(&format!("{expected}/")) {
        return Err(format!("own group {own} is not inside {expected}"));
    }
    let base = Path::new("/sys/fs/cgroup").join(expected.trim_start_matches('/'));
    if rustix::fs::statfs(&base).map_err(|e| e.to_string())?.f_type as i64 != 0x6367_7270 {
        return Err(format!("{} is not cgroup v2", base.display()));
    }
    for (file, bound) in [("pids.max", MAX_PIDS), ("memory.max", MAX_MEMORY)] {
        let text = fs::read_to_string(base.join(file)).map_err(|e| format!("{file}: {e}"))?;
        match text.trim().parse::<u64>() {
            Ok(value) if value > 0 && value <= bound => {}
            _ => {
                return Err(format!(
                    "{file} is {:?}, not a hard cap <= {bound}",
                    text.trim()
                ));
            }
        }
    }
    Ok(())
}

fn name() {
    unsafe {
        libc::prctl(libc::PR_SET_NAME, c"pwbomb".as_ptr(), 0, 0, 0);
    }
}

fn forever() -> ! {
    loop {
        unsafe {
            libc::pause();
        }
    }
}

// Live chain: each member forks one child and stays alive (deepening tree).
fn chain(count: &AtomicI32, cap: i32) -> ! {
    use std::sync::atomic::Ordering::SeqCst;
    loop {
        if count.fetch_add(1, SeqCst) >= cap {
            forever();
        }
        let p = unsafe { libc::fork() };
        if p != 0 {
            forever();
        }
        // child continues the chain
    }
}

// Rolling chain: fork a child, parent exits; endless fresh PIDs.
fn rolling() -> ! {
    loop {
        let p = unsafe { libc::fork() };
        if p < 0 {
            unsafe { libc::usleep(1000) };
            continue;
        }
        if p > 0 {
            unsafe { libc::_exit(0) };
        }
    }
}

// Wide: keep forking sleeping children while under the cap.
fn wide(count: &AtomicI32, cap: i32) -> ! {
    use std::sync::atomic::Ordering::SeqCst;
    loop {
        if count.load(SeqCst) >= cap {
            unsafe { libc::usleep(1000) };
            continue;
        }
        count.fetch_add(1, SeqCst);
        if unsafe { libc::fork() } == 0 {
            // each child also forks one grandchild while under cap
            if count.fetch_add(1, SeqCst) < cap && unsafe { libc::fork() } == 0 {
                forever();
            }
            forever();
        }
    }
}

pub fn pwbomb(cap: Option<&OsStr>) -> ! {
    if let Err(reason) = contained() {
        eprintln!("HAZARD-REFUSED: {reason}");
        process::exit(125);
    }
    let cap = cap.map_or(300, |cap| cap.to_str().unwrap().parse().unwrap());
    let shared = unsafe {
        libc::mmap(
            std::ptr::null_mut(),
            size_of::<AtomicI32>(),
            libc::PROT_READ | libc::PROT_WRITE,
            libc::MAP_SHARED | libc::MAP_ANONYMOUS,
            -1,
            0,
        )
    };
    assert_ne!(shared, libc::MAP_FAILED);
    let count = unsafe { &*(shared as *const AtomicI32) };
    unsafe {
        libc::signal(libc::SIGTERM, libc::SIG_IGN);
    }
    name();
    if unsafe { libc::fork() } == 0 {
        name();
        unsafe { libc::write(1, b"deep-started\n".as_ptr().cast(), 13) };
        chain(count, cap);
    }
    if unsafe { libc::fork() } == 0 {
        name();
        unsafe { libc::write(1, b"rolling-started\n".as_ptr().cast(), 16) };
        rolling();
    }
    if unsafe { libc::fork() } == 0 {
        name();
        unsafe { libc::write(1, b"wide-started\n".as_ptr().cast(), 13) };
        wide(count, cap);
    }
    println!("ready");
    std::io::stdout().flush().unwrap();
    forever();
}
