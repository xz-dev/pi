//! Linux, macOS and Android.

use super::{OpenMode, ShellConfig, path_exists};
use crate::errors::Failure;
use serde_json::{Map, Value};
use std::ffi::{CString, OsStr};
use std::fs::{File, Metadata, OpenOptions};
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{FileExt, MetadataExt, OpenOptionsExt};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};

/// libuv's name for an OS error.
pub fn os_error_name(error: &io::Error) -> &'static str {
    let Some(errno) = error.raw_os_error() else {
        return "UNKNOWN";
    };
    match errno {
        libc::EPERM => "EPERM",
        libc::ENOENT => "ENOENT",
        libc::EIO => "EIO",
        libc::EBADF => "EBADF",
        libc::EAGAIN => "EAGAIN",
        libc::ENOMEM => "ENOMEM",
        libc::EACCES => "EACCES",
        libc::EBUSY => "EBUSY",
        libc::EEXIST => "EEXIST",
        libc::EXDEV => "EXDEV",
        libc::ENOTDIR => "ENOTDIR",
        libc::EISDIR => "EISDIR",
        libc::EINVAL => "EINVAL",
        libc::ENFILE => "ENFILE",
        libc::EMFILE => "EMFILE",
        libc::ETXTBSY => "ETXTBSY",
        libc::EFBIG => "EFBIG",
        libc::ENOSPC => "ENOSPC",
        libc::EROFS => "EROFS",
        libc::EMLINK => "EMLINK",
        libc::ENAMETOOLONG => "ENAMETOOLONG",
        libc::ENOTEMPTY => "ENOTEMPTY",
        libc::ELOOP => "ELOOP",
        libc::ENOSYS => "ENOSYS",
        libc::ENOTSUP => "ENOTSUP",
        _ => "UNKNOWN",
    }
}

pub const PATH_SEPARATOR: &str = "/";

pub fn read_at(file: &File, buffer: &mut [u8], offset: u64) -> io::Result<usize> {
    file.read_at(buffer, offset)
}

/// Modification time as seconds and nanoseconds since the epoch.
pub fn mtime(metadata: &Metadata) -> (i64, i64) {
    (metadata.mtime(), metadata.mtime_nsec())
}

/// Device and inode, which identify a file across renames.
pub fn identity(metadata: &Metadata) -> (u64, u64) {
    (metadata.dev(), metadata.ino())
}

/// Node's `os.tmpdir()`; Termux's Node falls back to `$PREFIX/tmp`.
pub fn tmpdir() -> String {
    let configured = ["TMPDIR", "TMP", "TEMP"]
        .iter()
        .find_map(|key| std::env::var(key).ok().filter(|value| !value.is_empty()));
    let mut path = configured.unwrap_or_else(|| {
        if cfg!(target_os = "android") {
            format!(
                "{}/tmp",
                std::env::var("PREFIX")
                    .unwrap_or_else(|_| "/data/data/com.termux/files/usr".into())
            )
        } else {
            "/tmp".into()
        }
    });
    if path.len() > 1 && path.ends_with('/') {
        path.pop();
    }
    path
}

pub fn home() -> String {
    std::env::var("HOME").unwrap_or_default()
}

/// `mkdtemp(3)` of `prefix`, as libuv calls it: six random characters from `[A-Za-z0-9]`.
pub fn mkdtemp(prefix: &str) -> io::Result<String> {
    let mut template = prefix.as_bytes().to_vec();
    template.extend_from_slice(b"XXXXXX");
    let template =
        CString::new(template).map_err(|_| io::Error::from_raw_os_error(libc::EINVAL))?;
    let mut buffer = template.into_bytes_with_nul();
    // SAFETY: `buffer` is a NUL-terminated, writable template that mkdtemp fills in place.
    let created = unsafe { libc::mkdtemp(buffer.as_mut_ptr().cast()) };
    if created.is_null() {
        return Err(io::Error::last_os_error());
    }
    buffer.pop();
    Ok(OsStr::from_bytes(&buffer).to_string_lossy().into_owned())
}

/// Open a regular file for positional reads, without blocking on FIFOs and, with `no_follow`, without following a
/// final symbolic link.
pub fn open_reader(path: &str, no_follow: bool) -> Result<File, Failure> {
    let mut flags = libc::O_NONBLOCK;
    if no_follow {
        flags |= libc::O_NOFOLLOW;
    }
    OpenOptions::new()
        .read(true)
        .custom_flags(flags)
        .open(path)
        .map_err(|error| {
            if no_follow && matches!(error.raw_os_error(), Some(libc::ELOOP) | Some(libc::EMLINK)) {
                Failure::new("SYMLINK", "Refusing to follow a symbolic link").path(path)
            } else {
                Failure::io(&error, "open", path)
            }
        })
}

/// Open a file in one of Node's write modes.
pub fn open(path: &str, mode: OpenMode) -> io::Result<File> {
    let mut options = OpenOptions::new();
    match mode {
        OpenMode::Read => options.read(true),
        OpenMode::Write => options.write(true).create(true).truncate(true),
        OpenMode::Append => options.append(true).create(true),
        OpenMode::ReadWrite => options.read(true).write(true),
    };
    options.open(path)
}

pub fn realpath(path: &str) -> io::Result<String> {
    std::fs::canonicalize(path).map(|resolved| resolved.to_string_lossy().into_owned())
}

pub fn rename(from: &str, to: &str) -> io::Result<()> {
    std::fs::rename(from, to)
}

pub fn remove_file(path: &str) -> io::Result<()> {
    std::fs::remove_file(path)
}

/// A pipe a reader thread can poll, so that it stops when the command settles.
pub trait Pipe: io::Read + std::os::fd::AsRawFd {}
impl<T: io::Read + std::os::fd::AsRawFd> Pipe for T {}

/// Read `pipe` until it ends, `on_data` returns false, or `stop` is set; the pipe closes when this returns.
pub fn read_pipe(mut pipe: impl Pipe, stop: &AtomicBool, mut on_data: impl FnMut(&[u8]) -> bool) {
    let fd = pipe.as_raw_fd();
    // SAFETY: fcntl on a descriptor this thread owns.
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
    }
    let mut buffer = vec![0u8; 64 * 1024];
    while !stop.load(Ordering::SeqCst) {
        let mut poll = libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: one valid pollfd.
        let ready = unsafe { libc::poll(&mut poll, 1, 100) };
        if ready == 0
            || (ready < 0 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted)
        {
            continue;
        }
        if ready < 0 {
            return;
        }
        match pipe.read(&mut buffer) {
            Ok(0) => return,
            Ok(read) => {
                if !on_data(&buffer[..read]) {
                    return;
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) => {}
            Err(_) => return,
        }
    }
}

/// Readers poll `stop` every 100 ms.
pub fn interrupt_reader(_reader: &std::thread::JoinHandle<()>) {}

/// The program an argv command runs; `Command` searches `PATH` like `execvp`, as libuv does.
pub fn resolve_program(
    program: &str,
    _cwd: &str,
    _env: &Map<String, Value>,
) -> Result<String, Failure> {
    Ok(program.to_string())
}

fn which_bash() -> Option<String> {
    let output = Command::new("which")
        .arg("bash")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let first = String::from_utf8_lossy(&output.stdout)
        .trim()
        .lines()
        .next()?
        .to_string();
    path_exists(&first).then_some(first)
}

/// Node's shell resolution: a configured shell must exist; otherwise `/bin/bash`, `which bash`, then `sh`.
pub fn shell_config(shell_path: Option<&str>) -> Result<ShellConfig, Failure> {
    let shell = |program: &str| ShellConfig {
        program: program.into(),
        args: vec!["-c".into()],
        command_on_stdin: false,
    };
    if let Some(configured) = shell_path {
        if path_exists(configured) {
            return Ok(shell(configured));
        }
        return Err(Failure::new(
            "shell_unavailable",
            format!("Custom shell path not found: {configured}"),
        ));
    }
    if path_exists("/bin/bash") {
        return Ok(shell("/bin/bash"));
    }
    Ok(shell(&which_bash().unwrap_or_else(|| "sh".into())))
}

/// Arguments, environment and process setup as libuv applies them.
pub fn configure(
    command: &mut Command,
    args: &[String],
    env: &Map<String, Value>,
    inherit_env: bool,
) {
    command.args(args);
    if !inherit_env {
        command.env_clear();
    }
    for (key, value) in env {
        if let Some(value) = value.as_str() {
            command.env(key, value);
        }
    }
    // SAFETY: only async-signal-safe calls between fork and exec.
    unsafe {
        command.pre_exec(|| {
            // A new session, so a kill reaches every descendant; default signal handling and an empty mask, as libuv sets.
            libc::setsid();
            for signal in 1..32 {
                if signal != libc::SIGKILL && signal != libc::SIGSTOP {
                    libc::signal(signal, libc::SIG_DFL);
                }
            }
            let mut mask: libc::sigset_t = std::mem::zeroed();
            libc::sigemptyset(&mut mask);
            libc::sigprocmask(libc::SIG_SETMASK, &mask, std::ptr::null_mut());
            Ok(())
        });
    }
}

pub fn after_spawn(_child: &Child) {}

/// Signal mask the daemon inherited, before `on_exit_signal` blocked its exit signals on every thread.
static INHERITED_SIGNAL_MASK: std::sync::OnceLock<libc::sigset_t> = std::sync::OnceLock::new();

/// Run `on_signal` with the signal on its own thread when `SIGTERM`, `SIGINT` or `SIGHUP` arrives, instead of dying
/// at once. Call before starting any other thread: threads inherit the blocked signals, so only this one receives
/// them. Commands reset their signal mask before they run.
pub fn on_exit_signal(on_signal: impl FnOnce(i32) + Send + 'static) {
    // SAFETY: a zeroed sigset_t initialized by sigemptyset, and plain signal mask calls.
    let set = unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
            libc::sigaddset(&mut set, signal);
        }
        let mut inherited: libc::sigset_t = std::mem::zeroed();
        if libc::pthread_sigmask(libc::SIG_BLOCK, &set, &mut inherited) == 0 {
            let _ = INHERITED_SIGNAL_MASK.set(inherited);
        }
        set
    };
    std::thread::spawn(move || {
        let mut signal = 0;
        // SAFETY: waits for one of the signals blocked above.
        if unsafe { libc::sigwait(&set, &mut signal) } == 0 {
            on_signal(signal);
        }
    });
}

/// Kill the command's process group, or the process if the group is gone.
pub fn kill_tree(pid: u32) {
    let pid = pid as i32;
    // SAFETY: plain signal delivery.
    unsafe {
        if libc::kill(-pid, libc::SIGKILL) != 0 {
            libc::kill(pid, libc::SIGKILL);
        }
    }
}

/// A process killed by a signal has no exit code; report 128 + the signal, as the shell does.
pub fn exit_code(status: ExitStatus) -> i64 {
    i64::from(
        status
            .code()
            .unwrap_or_else(|| 128 + status.signal().unwrap_or(0)),
    )
}

/// The bytes of a file name, which libuv sorts directory listings by.
pub fn raw_name(name: &OsStr) -> Option<Vec<u8>> {
    Some(name.as_bytes().to_vec())
}

/// Windows only: the per-drive working directories of the `=C:` variables.
pub fn drive_cwds() -> Map<String, Value> {
    Map::new()
}

pub fn read_dir(path: &str) -> io::Result<std::fs::ReadDir> {
    std::fs::read_dir(path)
}

/// Device and inode of `path`; the metadata already has them.
pub fn path_identity(_path: &str, metadata: &Metadata, _follow: bool) -> (u64, u64) {
    identity(metadata)
}

/// Linux owned-exec handoff. Startup bytes are immutable after the sole-thread capture.
#[cfg(target_os = "linux")]
pub mod owned {
    use super::*;
    use std::collections::BTreeMap;
    use std::io::{Seek, SeekFrom, Write};
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::net::UnixStream;

    const Q: u64 = 6_291_456;
    const T: u64 = 1_572_864;
    const L: u64 = 29_360_192;
    const SIGNALS: [i32; 5] = [
        libc::SIGHUP,
        libc::SIGINT,
        libc::SIGQUIT,
        libc::SIGTERM,
        libc::SIGCHLD,
    ];
    unsafe extern "C" {
        static mut environ: *mut *const libc::c_char;
    }

    pub struct Snapshot {
        arena: Vec<u8>,
        ends: Vec<u32>,
    }

    impl Snapshot {
        /// SAFETY: caller is the standalone daemon's sole thread, before any serve
        /// threads. No request path mutates parent environ; only owned bytes escape.
        pub unsafe fn capture() -> io::Result<Self> {
            let table = unsafe { environ };
            let (mut count, mut bytes) = (0usize, 0usize);
            if !table.is_null() {
                loop {
                    let record = unsafe { *table.add(count) };
                    if record.is_null() {
                        break;
                    }
                    if count == T as usize {
                        return Err(io::Error::other("startup environment count exceeds bound"));
                    }
                    let mut length = 0usize;
                    loop {
                        if bytes + length == Q as usize {
                            return Err(io::Error::other("startup environment exceeds bound"));
                        }
                        let byte = unsafe { *record.add(length) };
                        length += 1;
                        if byte == 0 {
                            break;
                        }
                    }
                    bytes += length;
                    count += 1;
                }
            }
            let mut arena = Vec::new();
            let mut ends = Vec::new();
            arena.try_reserve_exact(bytes).map_err(io::Error::other)?;
            ends.try_reserve_exact(count).map_err(io::Error::other)?;
            for index in 0..count {
                let record = unsafe { *table.add(index) };
                let mut length = 0;
                while unsafe { *record.add(length) } != 0 {
                    length += 1;
                }
                arena.extend_from_slice(unsafe {
                    std::slice::from_raw_parts(record.cast(), length + 1)
                });
                ends.push(arena.len() as u32);
            }
            Ok(Self { arena, ends })
        }

        fn records(&self) -> impl Iterator<Item = &[u8]> {
            let mut start = 0;
            self.ends.iter().map(move |&end| {
                let record = &self.arena[start..end as usize - 1];
                start = end as usize;
                record
            })
        }

        pub fn qualified(&self) -> bool {
            #[cfg(all(target_env = "gnu", target_pointer_width = "64"))]
            {
                unsafe { std::ffi::CStr::from_ptr(libc::gnu_get_libc_version()) }.to_bytes()
                    == b"2.44"
            }
            #[cfg(not(all(target_env = "gnu", target_pointer_width = "64")))]
            {
                false
            }
        }

        pub fn prepare(
            &self,
            argv: &[String],
            cwd: &str,
            env: &Map<String, Value>,
            inherit: bool,
            discovery: bool,
        ) -> Result<Handoff, Failure> {
            let changed = !discovery && (!inherit || env.values().any(Value::is_string));
            let mut normalized = BTreeMap::new();
            if changed {
                if inherit {
                    for record in self.records() {
                        if let Some(at) = record
                            .iter()
                            .enumerate()
                            .skip(1)
                            .find_map(|(i, &b)| (b == b'=').then_some(i))
                        {
                            normalized.insert(&record[..at], &record[at + 1..]);
                        }
                    }
                }
                // Count final distinct keys before growing the normalization map.
                let additions = env
                    .iter()
                    .filter(|(key, value)| {
                        value.is_string() && !normalized.contains_key(key.as_bytes())
                    })
                    .count();
                if normalized.len() as u64 + additions as u64 + argv.len() as u64 > T {
                    return Err(too_big());
                }
                for (key, value) in env {
                    if let Some(value) = value.as_str() {
                        normalized.insert(key.as_bytes(), value.as_bytes());
                    }
                }
            }
            let records = || {
                normalized
                    .iter()
                    .map(|(&key, &value)| (key, Some(value)))
                    .chain(
                        self.records()
                            .take(if changed { 0 } else { self.ends.len() })
                            .map(|record| (record, None)),
                    )
            };
            let invalid = || Failure::new("spawn_error", "nul byte found in provided data");
            if argv.is_empty() || cwd.len() > 16_777_216 {
                return Err(Failure::new("EINVAL", "invalid exec spec arguments/cwd"));
            }
            if cwd.as_bytes().contains(&0) || argv.iter().any(|arg| arg.as_bytes().contains(&0)) {
                return Err(invalid());
            }
            let mut charge = argv
                .iter()
                .try_fold(0u64, |sum, arg| sum.checked_add(arg.len() as u64 + 1))
                .ok_or_else(too_big)?;
            let mut count = 0u64;
            for (key, value) in records() {
                if key.contains(&0) || value.is_some_and(|value| value.contains(&0)) {
                    return Err(invalid());
                }
                charge = charge
                    .checked_add(
                        key.len() as u64 + 1 + value.map_or(0, |value| value.len() as u64 + 1),
                    )
                    .ok_or_else(too_big)?;
                count += 1;
            }
            let total_count = count.checked_add(argv.len() as u64).ok_or_else(too_big)?;
            if charge > Q || total_count > T {
                return Err(too_big());
            }
            let length = 64u64
                .checked_add(cwd.len() as u64)
                .and_then(|n| n.checked_add(4 * total_count))
                .and_then(|n| n.checked_add(charge - total_count))
                .ok_or_else(too_big)?;
            if length > L {
                return Err(too_big());
            }
            let mut header = [0u8; 64];
            header[..8].copy_from_slice(b"PIEXSPEC");
            header[8..12].copy_from_slice(&1u32.to_le_bytes());
            header[12..16].copy_from_slice(&64u32.to_le_bytes());
            header[16..24].copy_from_slice(&length.to_le_bytes());
            header[24..28].copy_from_slice(&(argv.len() as u32).to_le_bytes());
            header[28..32].copy_from_slice(&(count as u32).to_le_bytes());
            header[32..40].copy_from_slice(&charge.to_le_bytes());
            header[40..44].copy_from_slice(&(cwd.len() as u32).to_le_bytes());
            if discovery {
                header[44] = 1;
                header[47] = 3;
            }
            let mut prepare = || -> io::Result<Handoff> {
                let fd = unsafe {
                    libc::memfd_create(
                        c"pi-env-exec".as_ptr(),
                        libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING,
                    )
                };
                if fd < 0 {
                    return Err(io::Error::last_os_error());
                }
                let mut spec = above_stdio(unsafe { File::from_raw_fd(fd) })?;
                spec.write_all(&header)?;
                spec.write_all(cwd.as_bytes())?;
                for arg in argv {
                    spec.write_all(&(arg.len() as u32).to_le_bytes())?;
                    spec.write_all(arg.as_bytes())?;
                }
                for (key, value) in records() {
                    let length = key.len() + value.map_or(0, |value| value.len() + 1);
                    spec.write_all(&(length as u32).to_le_bytes())?;
                    spec.write_all(key)?;
                    if let Some(value) = value {
                        spec.write_all(b"=")?;
                        spec.write_all(value)?;
                    }
                }
                if spec.stream_position()? != length {
                    return Err(io::Error::other("exec spec length mismatch"));
                }
                // Capture spawning thread's mask and process dispositions after all
                // preparation, before sealing and the immediate helper launch.
                if discovery {
                    let mut mask: libc::sigset_t = unsafe { std::mem::zeroed() };
                    if unsafe {
                        libc::pthread_sigmask(libc::SIG_SETMASK, std::ptr::null(), &mut mask)
                    } != 0
                    {
                        return Err(io::Error::other("cannot read signal mask"));
                    }
                    // Exit signals are blocked daemon-wide for the sigwait thread; owned
                    // commands keep the mask the daemon itself inherited.
                    if let Some(inherited) = super::INHERITED_SIGNAL_MASK.get() {
                        mask = *inherited;
                    }
                    for (bit, signal) in SIGNALS.iter().copied().enumerate() {
                        let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
                        if unsafe { libc::sigaction(signal, std::ptr::null(), &mut action) } != 0 {
                            return Err(io::Error::last_os_error());
                        }
                        if action.sa_sigaction == libc::SIG_IGN {
                            header[45] |= 1 << bit;
                        }
                        let member = unsafe { libc::sigismember(&mask, signal) };
                        if member < 0 {
                            return Err(io::Error::last_os_error());
                        }
                        if member == 1 {
                            header[46] |= 1 << bit;
                        }
                    }
                    spec.seek(SeekFrom::Start(0))?;
                    spec.write_all(&header)?;
                }
                let seals = libc::F_SEAL_WRITE
                    | libc::F_SEAL_GROW
                    | libc::F_SEAL_SHRINK
                    | libc::F_SEAL_SEAL;
                if unsafe { libc::fcntl(spec.as_raw_fd(), libc::F_ADD_SEALS, seals) } != 0 {
                    return Err(io::Error::last_os_error());
                }
                spec.seek(SeekFrom::Start(0))?;
                let (lease, passed) = UnixStream::pair()?;
                let lease = above_stdio(File::from(std::os::fd::OwnedFd::from(lease)))?;
                let lease = UnixStream::from(std::os::fd::OwnedFd::from(lease));
                let passed = above_stdio(File::from(std::os::fd::OwnedFd::from(passed)))?;
                let control_fd = passed.as_raw_fd();
                let spec_fd = spec.as_raw_fd();
                let mut command = Command::new("/proc/self/exe");
                command
                    .args([
                        "supervise",
                        "--control-fd",
                        &control_fd.to_string(),
                        "--exec-spec-fd",
                        &spec_fd.to_string(),
                        "--",
                    ])
                    .env_clear()
                    .stdin(Stdio::null())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped());
                unsafe {
                    command.pre_exec(move || {
                        for fd in [control_fd, spec_fd] {
                            let flags = libc::fcntl(fd, libc::F_GETFD);
                            if flags < 0
                                || libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0
                            {
                                return Err(io::Error::last_os_error());
                            }
                        }
                        Ok(())
                    });
                }
                // GNU's single final overlong component is the only no-attempt
                // case for fixed "which". Nonfinal overlong leaves a cwd attempt.
                let path = self.records().find_map(|r| r.strip_prefix(b"PATH="));
                let zero_attempt =
                    discovery && path.is_some_and(|p| !p.contains(&b':') && p.len() >= 4096);
                Ok(Handoff {
                    command,
                    lease,
                    spec,
                    passed,
                    zero_attempt,
                })
            };
            prepare().map_err(|error| Failure::new("unknown", error.to_string()).extra(serde_json::json!({"ownerError":{"code":"ERR_PROCESS_OWNER_CLEANUP","message":error.to_string()}})))
        }
    }

    fn too_big() -> Failure {
        Failure::new(
            "spawn_error",
            io::Error::from_raw_os_error(libc::E2BIG).to_string(),
        )
        .extra(serde_json::json!({"spawn":{"stage":"target","errno":libc::E2BIG}}))
    }
    fn above_stdio(file: File) -> io::Result<File> {
        if file.as_raw_fd() >= 3 {
            return Ok(file);
        }
        let fd = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 3) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(unsafe { File::from_raw_fd(fd) })
    }
    pub struct Handoff {
        pub command: Command,
        pub lease: UnixStream,
        // Keep descriptors alive through spawn; their copies drop immediately after.
        pub spec: File,
        pub passed: File,
        pub zero_attempt: bool,
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use serde_json::json;
        use std::io::Read;

        fn snapshot(records: &[&[u8]]) -> Snapshot {
            let mut arena = Vec::new();
            let mut ends = Vec::new();
            for record in records {
                arena.extend_from_slice(record);
                arena.push(0);
                ends.push(arena.len() as u32);
            }
            Snapshot { arena, ends }
        }
        fn records(mut handoff: Handoff) -> Vec<Vec<u8>> {
            let fd = handoff.spec.as_raw_fd();
            let seals = unsafe { libc::fcntl(fd, libc::F_GET_SEALS) };
            assert_eq!(seals & 15, 15);
            for fd in [fd, handoff.passed.as_raw_fd(), handoff.lease.as_raw_fd()] {
                assert_ne!(
                    unsafe { libc::fcntl(fd, libc::F_GETFD) } & libc::FD_CLOEXEC,
                    0
                );
            }
            let mut bytes = Vec::new();
            handoff.spec.read_to_end(&mut bytes).unwrap();
            assert_eq!(
                u64::from_le_bytes(bytes[16..24].try_into().unwrap()),
                bytes.len() as u64
            );
            let argc = u32::from_le_bytes(bytes[24..28].try_into().unwrap());
            let count = u32::from_le_bytes(bytes[28..32].try_into().unwrap());
            let cwd = u32::from_le_bytes(bytes[40..44].try_into().unwrap());
            let mut at = 64 + cwd as usize;
            let mut result = Vec::new();
            for index in 0..argc + count {
                let length = u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap()) as usize;
                at += 4;
                if index >= argc {
                    result.push(bytes[at..at + length].to_vec());
                }
                at += length;
            }
            assert_eq!(at, bytes.len());
            result
        }
        #[test]
        fn untouched_raw_records_and_changed_normalization_are_distinct() {
            let snapshot = snapshot(&[
                b"X=first",
                b"X=last",
                b"OPAQUE",
                b"",
                b"=bad",
                b"==value",
                b"N\xff=\xfe",
            ]);
            let argv = ["/bin/true".into()];
            let raw = records(
                snapshot
                    .prepare(&argv, "/", &Map::new(), true, false)
                    .unwrap(),
            );
            assert_eq!(
                raw,
                snapshot.records().map(<[u8]>::to_vec).collect::<Vec<_>>()
            );
            let ignored = json!({"bad\u{0}":false}).as_object().unwrap().clone();
            assert_eq!(
                records(snapshot.prepare(&argv, "/", &ignored, true, false).unwrap()),
                raw
            );
            let changed = json!({"X":"last"}).as_object().unwrap().clone();
            assert_eq!(
                records(snapshot.prepare(&argv, "/", &changed, true, false).unwrap()),
                [
                    b"==value".to_vec(),
                    b"N\xff=\xfe".to_vec(),
                    b"X=last".to_vec()
                ]
            );
            assert!(
                records(
                    snapshot
                        .prepare(&argv, "/", &Map::new(), false, false)
                        .unwrap()
                )
                .is_empty()
            );
            assert_eq!(
                records(
                    snapshot
                        .prepare(&argv, "/", &changed, false, false)
                        .unwrap()
                ),
                [b"X=last".to_vec()]
            );
        }
        #[test]
        fn empty_environment_is_not_one_empty_record() {
            let argv = ["/bin/true".into()];
            assert!(
                records(
                    snapshot(&[])
                        .prepare(&argv, "/", &Map::new(), true, false)
                        .unwrap()
                )
                .is_empty()
            );
            assert_eq!(
                records(
                    snapshot(&[b""])
                        .prepare(&argv, "/", &Map::new(), true, false)
                        .unwrap()
                ),
                [Vec::<u8>::new()]
            );
        }
        #[test]
        fn final_output_only_is_charged_and_nul_is_not_e2big() {
            let mut large = vec![b'x'; Q as usize - 1];
            large[..2].copy_from_slice(b"X=");
            let snapshot = snapshot(&[&large]);
            let argv = ["/bin/true".into()];
            let error = match snapshot.prepare(&argv, "/", &Map::new(), true, false) {
                Err(e) => e,
                Ok(_) => panic!("expected pre-count E2BIG"),
            };
            assert_eq!(error.to_json()["spawn"]["errno"], libc::E2BIG);
            let changed = json!({"X":"small"}).as_object().unwrap().clone();
            assert_eq!(
                records(snapshot.prepare(&argv, "/", &changed, true, false).unwrap()),
                [b"X=small".to_vec()]
            );
            let error = match snapshot.prepare(&["x\0y".into()], "/", &Map::new(), false, false) {
                Err(e) => e,
                Ok(_) => panic!("expected InvalidInput"),
            };
            assert_eq!(error.code, "spawn_error");
            assert!(error.to_json().get("spawn").is_none());
        }
        #[test]
        fn zero_attempt_prediction_is_profile_specific_not_empty_path() {
            let long = vec![b'x'; 4096];
            for (path, expected) in [(b"".as_slice(), false), (long.as_slice(), true)] {
                let mut record = b"PATH=".to_vec();
                record.extend_from_slice(path);
                let snapshot = snapshot(&[&record]);
                let handoff = snapshot
                    .prepare(
                        &["which".into(), "bash".into()],
                        "",
                        &Map::new(),
                        true,
                        true,
                    )
                    .unwrap();
                assert_eq!(handoff.zero_attempt, expected);
            }
            let mut record = b"PATH=".to_vec();
            record.extend_from_slice(&long);
            record.extend_from_slice(b":");
            assert!(
                !snapshot(&[&record])
                    .prepare(
                        &["which".into(), "bash".into()],
                        "",
                        &Map::new(),
                        true,
                        true
                    )
                    .unwrap()
                    .zero_attempt
            );
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn exit_signal_thread_keeps_the_inherited_mask_for_owned_commands() {
        // cargo runs each test on its own thread, so blocking here does not leak into other tests.
        super::on_exit_signal(|_| {});
        // SAFETY: plain signal mask queries on initialized sigset_t values.
        unsafe {
            let mut current: libc::sigset_t = std::mem::zeroed();
            libc::pthread_sigmask(libc::SIG_SETMASK, std::ptr::null(), &mut current);
            let inherited = super::INHERITED_SIGNAL_MASK
                .get()
                .expect("inherited mask recorded");
            for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
                assert_eq!(libc::sigismember(&current, signal), 1);
                assert_eq!(libc::sigismember(inherited, signal), 0);
            }
        }
    }
}
