// CI-only release-artifact job-control probe. openpty/setsid follows pi-env's pty.rs;
// its private PTY API cannot expose termios or a shell-side sibling in the job group.
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};

type Result<T> = std::result::Result<T, String>;
fn check(value: i32) -> Result<i32> {
    if value < 0 {
        Err(std::io::Error::last_os_error().to_string())
    } else {
        Ok(value)
    }
}
fn require(value: bool, message: &str) -> Result<()> {
    if value { Ok(()) } else { Err(message.into()) }
}
fn load(path: &Path) -> Result<Value> {
    serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
fn publish(path: &Path, value: &Value) -> Result<()> {
    let temp = path.with_extension("tmp");
    fs::write(&temp, value.to_string()).map_err(|e| e.to_string())?;
    fs::rename(temp, path).map_err(|e| e.to_string())
}
fn number(value: &Value, key: &str) -> Result<i32> {
    value[key]
        .as_i64()
        .and_then(|n| i32::try_from(n).ok())
        .filter(|n| *n > 1)
        .ok_or_else(|| format!("missing PID: {key}"))
}
fn ticks(path: &Path) -> Result<u64> {
    Ok(fs::metadata(path).map_err(|e| e.to_string())?.len())
}
fn beat(path: &Path) -> ! {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .expect("heartbeat");
    loop {
        file.write_all(b".").expect("heartbeat write");
        sleep(Duration::from_millis(25));
    }
}

fn birth(pid: i32) -> Result<String> {
    query_birth(pid).map_err(|error| {
        if cfg!(target_os = "freebsd") && error.raw_os_error().is_some() {
            format!("sysctl(KERN_PROC_PID, pid={pid}): {error}")
        } else {
            error.to_string()
        }
    })
}
#[cfg(target_os = "linux")]
fn query_birth(pid: i32) -> io::Result<String> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat"))?;
    let fields: Vec<_> = stat
        .rsplit_once(") ")
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid proc stat"))?
        .1
        .split_whitespace()
        .collect();
    Ok(fields
        .get(19)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing proc starttime"))?
        .to_string())
}
// Clear errno before the call, then capture it immediately: zero without errno is not ESRCH.
#[cfg(any(target_os = "macos", test))]
fn darwin_birth_call<T>(
    mut call: impl FnMut(&mut T) -> i32,
    errno: *mut libc::c_int,
) -> io::Result<T> {
    let mut info: T = unsafe { std::mem::zeroed() };
    unsafe { *errno = 0 };
    let result = call(&mut info);
    let error = unsafe { *errno };
    if result <= 0 && error != 0 {
        return Err(io::Error::from_raw_os_error(error));
    }
    if result != std::mem::size_of::<T>() as i32 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "proc_pidinfo birth unavailable",
        ));
    }
    Ok(info)
}
#[cfg(target_os = "macos")]
fn query_birth(pid: i32) -> io::Result<String> {
    let info: libc::proc_bsdinfo = darwin_birth_call(
        |info: &mut libc::proc_bsdinfo| unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                0,
                (info as *mut libc::proc_bsdinfo).cast(),
                std::mem::size_of_val(info) as i32,
            )
        },
        unsafe { libc::__error() },
    )?;
    darwin_birth_record(
        pid,
        info.pbi_pid,
        info.pbi_start_tvsec,
        info.pbi_start_tvusec,
    )
}
#[cfg(any(target_os = "macos", test))]
fn darwin_birth_record(pid: i32, record_pid: u32, seconds: u64, micros: u64) -> io::Result<String> {
    if record_pid != pid as u32 || seconds == 0 || micros >= 1_000_000 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "malformed proc_pidinfo birth",
        ));
    }
    Ok(format!("{seconds}:{micros}"))
}
#[cfg(target_os = "freebsd")]
fn query_birth(pid: i32) -> io::Result<String> {
    let mut mib = [libc::CTL_KERN, libc::KERN_PROC, libc::KERN_PROC_PID, pid];
    let mut info: libc::kinfo_proc = unsafe { std::mem::zeroed() };
    let mut size = std::mem::size_of_val(&info);
    if unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            4,
            (&mut info as *mut libc::kinfo_proc).cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    } < 0
    {
        return Err(io::Error::last_os_error());
    }
    require(
        size == std::mem::size_of_val(&info),
        "sysctl birth unavailable",
    )
    .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    Ok(format!(
        "{}:{}",
        info.ki_start.tv_sec, info.ki_start.tv_usec
    ))
}

fn ps_command() -> Command {
    let mut command = Command::new("ps");
    // FreeBSD consumes the rest of each -o argument after '=' as one header.
    command.args([
        "-ax", "-o", "pid=", "-o", "ppid=", "-o", "pgid=", "-o", "uid=", "-o", "stat=",
    ]);
    command
}

// ps absence is established by a successful complete inventory, never by a failed PID query.
fn snapshot() -> Result<BTreeMap<i32, Value>> {
    let out = ps_command().output().map_err(|e| e.to_string())?;
    require(out.status.success(), "ps inventory failed")?;
    let text = String::from_utf8(out.stdout).map_err(|e| e.to_string())?;
    parse_inventory(&text)
}
fn parse_inventory(text: &str) -> Result<BTreeMap<i32, Value>> {
    let mut result = BTreeMap::new();
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        let f: Vec<_> = line.split_whitespace().collect();
        require(f.len() == 5, "malformed ps inventory")?;
        let parse = |i: usize| {
            f[i].parse::<i32>()
                .map_err(|e| format!("ps inventory column={i} line={line:?}: {e}"))
        };
        let pid = parse(0)?;
        result.insert(
            pid,
            json!({"pid":pid,"parent":parse(1)?,"group":parse(2)?,"uid":parse(3)?,"state":f[4]}),
        );
    }
    require(!result.is_empty(), "empty ps inventory")?;
    Ok(result)
}
fn pin(table: &BTreeMap<i32, Value>, pid: i32) -> Result<Value> {
    let mut value = table
        .get(&pid)
        .cloned()
        .ok_or_else(|| format!("PID absent: {pid}"))?;
    value["birth"] = json!(birth(pid)?);
    value["sid"] = json!(check(unsafe { libc::getsid(pid) })?);
    let after = snapshot()?;
    require(
        after.get(&pid).is_some_and(|p| {
            ["pid", "parent", "group", "uid"]
                .iter()
                .all(|key| p[key] == value[key])
        }) && birth(pid)? == value["birth"].as_str().ok_or("missing birth")?
            && unsafe { libc::getsid(pid) } == number(&value, "sid")?,
        "process changed during pin",
    )?;
    Ok(value)
}
fn state<'a>(table: &'a BTreeMap<i32, Value>, value: &Value) -> Result<&'a str> {
    table
        .get(&number(value, "pid")?)
        .and_then(|v| v["state"].as_str())
        .ok_or_else(|| "held process missing before fault".into())
}
fn stopped(table: &BTreeMap<i32, Value>, value: &Value) -> Result<bool> {
    Ok(state(table, value)?.starts_with('T'))
}
fn runnable(table: &BTreeMap<i32, Value>, value: &Value) -> Result<bool> {
    let s = state(table, value)?;
    Ok(!s.starts_with('T') && !s.starts_with('Z') && !s.starts_with('X'))
}
fn same(value: &Value) -> Result<bool> {
    let pid = number(value, "pid")?;
    if !snapshot()?.contains_key(&pid) {
        return Ok(false);
    }
    Ok(birth(pid)? == value["birth"].as_str().ok_or("missing birth")?)
}
fn descendants(table: &BTreeMap<i32, Value>, root: i32) -> BTreeSet<i32> {
    let mut ids = BTreeSet::from([root]);
    loop {
        let before = ids.len();
        for (&pid, value) in table {
            if value["parent"]
                .as_i64()
                .is_some_and(|parent| ids.contains(&(parent as i32)))
            {
                ids.insert(pid);
            }
        }
        if before == ids.len() {
            return ids;
        }
    }
}

#[cfg(target_os = "linux")]
fn native_path(pid: i32) -> Result<PathBuf> {
    fs::read_link(format!("/proc/{pid}/exe")).map_err(|e| e.to_string())
}
#[cfg(target_os = "macos")]
fn native_path(pid: i32) -> Result<PathBuf> {
    let mut path = [0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    require(
        unsafe { libc::proc_pidpath(pid, path.as_mut_ptr().cast(), path.len() as u32) } > 0,
        "native path unavailable",
    )?;
    Ok(PathBuf::from(
        std::ffi::CStr::from_bytes_until_nul(&path)
            .map_err(|e| e.to_string())?
            .to_str()
            .map_err(|e| e.to_string())?,
    ))
}
#[cfg(target_os = "freebsd")]
fn native_path(pid: i32) -> Result<PathBuf> {
    let mut mib = [
        libc::CTL_KERN,
        libc::KERN_PROC,
        libc::KERN_PROC_PATHNAME,
        pid,
    ];
    let mut path = [0u8; 4096];
    let mut size = path.len();
    check(unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            4,
            path.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    })?;
    require(size > 0 && size <= path.len(), "native path unavailable")?;
    Ok(PathBuf::from(
        std::ffi::CStr::from_bytes_until_nul(&path[..size])
            .map_err(|e| e.to_string())?
            .to_str()
            .map_err(|e| e.to_string())?,
    ))
}

#[cfg(target_os = "linux")]
fn current_uids(pid: i32) -> Result<Vec<u32>> {
    let status = fs::read_to_string(format!("/proc/{pid}/status")).map_err(|e| e.to_string())?;
    let values = status
        .lines()
        .find_map(|line| line.strip_prefix("Uid:"))
        .ok_or("native UID record missing")?;
    let uids = values
        .split_whitespace()
        .map(|v| v.parse::<u32>().map_err(|e| e.to_string()))
        .collect::<Result<Vec<_>>>()?;
    require(uids.len() == 4, "native UID record truncated")?;
    Ok(uids)
}
#[cfg(target_os = "macos")]
fn current_uids(pid: i32) -> Result<Vec<u32>> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of_val(&info) as i32;
    require(
        unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                0,
                (&mut info as *mut libc::proc_bsdinfo).cast(),
                size,
            )
        } == size,
        "native UID record unavailable",
    )?;
    Ok(vec![info.pbi_ruid, info.pbi_uid, info.pbi_svuid])
}
#[cfg(target_os = "freebsd")]
fn current_uids(pid: i32) -> Result<Vec<u32>> {
    let mut mib = [libc::CTL_KERN, libc::KERN_PROC, libc::KERN_PROC_PID, pid];
    let mut info: libc::kinfo_proc = unsafe { std::mem::zeroed() };
    let mut size = std::mem::size_of_val(&info);
    check(unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            4,
            (&mut info as *mut libc::kinfo_proc).cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    })?;
    require(
        size == std::mem::size_of_val(&info),
        "native UID record unavailable",
    )?;
    Ok(vec![info.ki_ruid, info.ki_uid, info.ki_svuid])
}

fn fd_record(fd: u32, kind: &str, target: &str, rdev: Option<u64>) -> Value {
    json!({"fd":fd,"kind":kind,"target":target,"rdev":rdev.map(|n| n.to_string())})
}
fn validate_descriptors(records: &[Value]) -> Result<()> {
    let mut seen = BTreeSet::new();
    for record in records {
        let fd = record["fd"].as_u64().ok_or("invalid FD number")?;
        require(
            fd <= i32::MAX as u64 && seen.insert(fd),
            "duplicate/invalid FD",
        )?;
        let kind = record["kind"].as_str().ok_or("FD kind missing")?;
        let target = record["target"].as_str().ok_or("FD target missing")?;
        require(
            !target.is_empty()
                && !target.contains(['\n', '\r'])
                && (target != "-" || matches!(kind, "pipe" | "socket" | "event")),
            "FD target unavailable",
        )?;
        require(
            matches!(
                kind,
                "char"
                    | "pty-master"
                    | "file"
                    | "directory"
                    | "block"
                    | "pipe"
                    | "socket"
                    | "event"
            ),
            "unknown FD kind",
        )?;
        require(
            if matches!(kind, "char" | "pty-master") {
                (kind != "pty-master"
                    || target
                        .strip_prefix("/dev/pts/")
                        .is_some_and(|n| !n.is_empty() && n.bytes().all(|c| c.is_ascii_digit())))
                    && target.starts_with("/dev/")
                    && record["rdev"]
                        .as_str()
                        .is_some_and(|n| n.parse::<u64>().is_ok())
            } else {
                record["rdev"].is_null()
            },
            "FD device identity missing",
        )?;
    }
    require(
        [0, 1, 2].iter().all(|fd| seen.contains(fd)),
        "FD standard-descriptor coverage incomplete",
    )
}
#[cfg(target_os = "linux")]
fn descriptor_inventory(pid: i32) -> Result<Vec<Value>> {
    let mut result = Vec::new();
    for entry in fs::read_dir(format!("/proc/{pid}/fd")).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let fd = entry
            .file_name()
            .to_str()
            .ok_or("invalid proc FD")?
            .parse::<u32>()
            .map_err(|e| e.to_string())?;
        let path = fs::read_link(entry.path()).map_err(|e| e.to_string())?;
        let target = path.to_str().ok_or("non-UTF8 FD target")?;
        let meta = fs::metadata(entry.path()).map_err(|e| e.to_string())?;
        let ft = meta.file_type();
        let kind = if ft.is_char_device() {
            "char"
        } else if ft.is_file() {
            "file"
        } else if ft.is_dir() {
            "directory"
        } else if ft.is_block_device() {
            "block"
        } else if ft.is_fifo() {
            "pipe"
        } else if ft.is_socket() {
            "socket"
        } else if target.starts_with("anon_inode:[") && target.ends_with(']') {
            "event"
        } else {
            return Err("unknown proc FD type".into());
        };
        result.push(fd_record(
            fd,
            kind,
            target,
            (kind == "char").then(|| meta.rdev()),
        ));
    }
    result.sort_by_key(|v| v["fd"].as_u64());
    validate_descriptors(&result)?;
    Ok(result)
}
// lsof(8) -F0: NUL-terminated fields; newline separates process/file sets.
#[cfg(any(not(target_os = "linux"), test))]
fn parse_lsof(text: &str, pid: i32) -> Result<Vec<Value>> {
    require(text.ends_with("\0\n"), "truncated lsof field set")?;
    let mut sets = text.split("\0\n");
    require(
        sets.next() == Some(format!("p{pid}").as_str()),
        "lsof PID attribution missing",
    )?;
    let mut records = Vec::new();
    for set in sets {
        if set.is_empty() {
            continue;
        }
        let mut fields = BTreeMap::new();
        for field in set.split('\0') {
            let key = field.chars().next().ok_or("empty lsof field")?;
            require(
                matches!(key, 'f' | 't' | 'n' | 'r') && fields.insert(key, &field[1..]).is_none(),
                "unknown/duplicate lsof field",
            )?;
        }
        let fd = fields
            .get(&'f')
            .ok_or("lsof FD missing")?
            .parse::<u32>()
            .map_err(|e| e.to_string())?;
        let kind = match *fields.get(&'t').ok_or("lsof type missing")? {
            "CHR" => "char",
            "REG" => "file",
            "DIR" => "directory",
            "BLK" => "block",
            "FIFO" | "PIPE" => "pipe",
            "IPv4" | "IPv6" | "unix" => "socket",
            "KQUEUE" => "event",
            _ => return Err("unknown lsof FD type".into()),
        };
        let rdev = fields
            .get(&'r')
            .map(|r| {
                u64::from_str_radix(r.strip_prefix("0x").ok_or("invalid lsof rdev")?, 16)
                    .map_err(|e| e.to_string())
            })
            .transpose()?;
        let target = match fields.get(&'n') {
            Some(target) if *target != "unavailable" => *target,
            None if matches!(kind, "pipe" | "socket" | "event") => "-",
            _ => return Err("lsof name unavailable".into()),
        };
        records.push(fd_record(fd, kind, target, rdev));
    }
    validate_descriptors(&records)?;
    Ok(records)
}
// FreeBSD procstat_files.c: PID COMM FD T V FLAGS REF OFFSET PRO NAME.
#[cfg(any(not(target_os = "linux"), test))]
fn parse_procstat(text: &str, pid: i32) -> Result<Vec<Value>> {
    let mut lines = text.lines();
    require(
        lines.next().is_some_and(|l| {
            l.split_whitespace().eq([
                "PID", "COMM", "FD", "T", "V", "FLAGS", "REF", "OFFSET", "PRO", "NAME",
            ])
        }),
        "procstat header missing",
    )?;
    let mut records = Vec::new();
    for line in lines {
        let f: Vec<_> = line.split_whitespace().collect();
        require(
            f.len() >= 10 && f[0] == pid.to_string(),
            "malformed/wrong-PID procstat record",
        )?;
        if ["ctty", "cwd", "jail", "root", "text", "trace"].contains(&f[2]) {
            continue;
        }
        let fd = f[2].parse::<u32>().map_err(|e| e.to_string())?;
        require(
            f[5].len() == 8
                && f[5]
                    .chars()
                    .zip("rwasfndl".chars())
                    .all(|(a, b)| a == '-' || a == b)
                && [f[6], f[7]]
                    .iter()
                    .all(|s| *s == "-" || s.parse::<u64>().is_ok()),
            "invalid procstat descriptor fields",
        )?;
        let kind = match (f[3], f[4]) {
            ("v", "c") => "char",
            ("t", "-") => "pty-master",
            ("v", "r") => "file",
            ("v", "d") => "directory",
            ("v", "b") => "block",
            ("p" | "f", "-") | ("v", "f") => "pipe",
            ("s", "-") => "socket",
            ("k" | "e" | "E", "-") => "event",
            _ => return Err("unknown procstat FD type".into()),
        };
        let mut target = f[9..].join(" ");
        if kind == "pty-master" {
            // FreeBSD 14.3 tty_pts.c: fill_kinfo exports tty_devname, allocated as pts/%u.
            let unit = target
                .strip_prefix("pts/")
                .ok_or("ambiguous procstat PTS target")?;
            require(
                !unit.is_empty() && unit.bytes().all(|c| c.is_ascii_digit()),
                "invalid procstat PTS target",
            )?;
            target = format!("/dev/{target}");
        }
        let rdev = if matches!(kind, "char" | "pty-master") {
            // procstat has no rdev column. Only concrete devfs nodes may bind a character FD.
            require(
                target.starts_with("/dev/"),
                "ambiguous procstat character alias",
            )?;
            target = fs::canonicalize(&target)
                .map_err(|e| e.to_string())?
                .to_str()
                .ok_or("non-UTF8 character target")?
                .to_owned();
            let meta = fs::metadata(&target).map_err(|e| e.to_string())?;
            require(
                meta.file_type().is_char_device(),
                "procstat character target changed",
            )?;
            Some(meta.rdev())
        } else {
            None
        };
        records.push(fd_record(fd, kind, &target, rdev));
    }
    validate_descriptors(&records)?;
    Ok(records)
}
#[cfg(not(target_os = "linux"))]
fn descriptor_inventory(pid: i32) -> Result<Vec<Value>> {
    let mut command = if cfg!(target_os = "macos") {
        Command::new("/usr/sbin/lsof")
    } else {
        Command::new("procstat")
    };
    if cfg!(target_os = "macos") {
        command.args(["-nP", "-a", "-p", &pid.to_string(), "-d", "fd", "-F0pftnr"]);
    } else {
        command.args(["-f", &pid.to_string()]);
    }
    let output = command.output().map_err(|e| e.to_string())?;
    decode_descriptor_output(output, pid, cfg!(target_os = "macos"))
}
#[cfg(any(not(target_os = "linux"), test))]
fn decode_descriptor_output(
    output: std::process::Output,
    pid: i32,
    macos: bool,
) -> Result<Vec<Value>> {
    require(
        output.status.success() && output.stderr.is_empty(),
        "native FD inventory failed/diagnostic",
    )?;
    let text = String::from_utf8(output.stdout).map_err(|e| e.to_string())?;
    if macos {
        parse_lsof(&text, pid)
    } else {
        parse_procstat(&text, pid)
    }
}

fn validate_private_descriptors(fds: &[Value], physical_device: &str) -> Result<()> {
    require(
        !fds.iter().any(|fd| {
            matches!(fd["kind"].as_str(), Some("char" | "pty-master"))
                && (fd["rdev"] == physical_device
                    || [
                        "/dev/tty",
                        "/dev/console",
                        "/dev/stdin",
                        "/dev/stdout",
                        "/dev/stderr",
                    ]
                    .iter()
                    .any(|name| fd["target"] == *name)
                    || fd["target"]
                        .as_str()
                        .is_some_and(|name| name.starts_with("/dev/fd/")))
        }),
        "private controller retains physical tty/ambiguous alias",
    )
}

// Bracket both equal FD samples with native image, credentials and strong process identity.
fn capture_controller(
    expected: &Value,
    owner: Option<&Path>,
    physical_device: &str,
    private: bool,
    mut sample_uids: impl FnMut(i32) -> Result<Vec<u32>>,
    #[cfg(test)] after_capture: impl FnOnce(),
) -> Result<Value> {
    let pid = number(expected, "pid")?;
    let before = pin(&snapshot()?, pid)?;
    require(
        before["birth"] == expected["birth"] && before["uid"] == unsafe { libc::getuid() },
        "controller changed before image/FD inventory",
    )?;
    let image = fs::canonicalize(native_path(pid)?).map_err(|e| e.to_string())?;
    let native = owner.is_some();
    require(
        !native
            || image
                == fs::canonicalize(owner.ok_or("owner missing")?).map_err(|e| e.to_string())?,
        "controller native image mismatch",
    )?;
    let uids = sample_uids(pid)?;
    require(
        uids.iter().all(|&uid| uid == unsafe { libc::getuid() }),
        "controller current UID mismatch",
    )?;
    let fds = descriptor_inventory(pid)?;
    require(
        fds == descriptor_inventory(pid)?,
        "controller FD inventory changed/incomplete",
    )?;
    if private {
        validate_private_descriptors(&fds, physical_device)?;
    }
    #[cfg(test)]
    after_capture();
    let after_image = fs::canonicalize(native_path(pid)?).map_err(|e| e.to_string())?;
    let after_uids = sample_uids(pid)?;
    let mut current = pin(&snapshot()?, pid)?;
    require(
        after_image == image
            && after_uids == uids
            && current["birth"] == before["birth"]
            && current["uid"] == unsafe { libc::getuid() },
        "controller changed during image/FD inventory",
    )?;
    current["uids"] = json!(uids);
    current["image"] = json!(image);
    current["native"] = json!(native);
    current["fds"] = json!({"schema":1,"source":if cfg!(target_os="linux") {"procfs"} else if cfg!(target_os="macos") {"lsof-F0"} else {"procstat-f"},"pid":pid,"birth":current["birth"],"image":image,"complete":true,"records":fds});
    Ok(current)
}

fn fault_roles(name: &str) -> Result<Vec<&'static str>> {
    Ok(
        match name.strip_suffix("-shutdown-blocked").unwrap_or(name) {
            "suspend-resume" => vec![],
            "paused-outer-death" => vec!["outer"],
            "paused-anchor-death" => vec!["anchor"],
            "paused-guardian-death" => vec!["guardian"],
            "paused-both-owners-death" => vec!["outer", "guardian"],
            "paused-observer-death" => vec!["observer"],
            "paused-carrier-death" => vec!["carrier"],
            "paused-backup-death" => vec!["backup"],
            "paused-carrier-guardian-death" => vec!["carrier", "guardian"],
            "paused-carrier-outer-death" => vec!["carrier", "outer"],
            "paused-carrier-backup-death" => vec!["carrier", "backup"],
            "paused-outer-backup-death" => vec!["outer", "backup"],
            _ => return Err("unknown PTY scenario".into()),
        },
    )
}

struct Held {
    identity: Value,
    #[cfg(target_os = "linux")]
    fd: File,
}
impl Held {
    fn open(identity: &Value) -> Result<Self> {
        require(same(identity)?, "fault target birth changed")?;
        #[cfg(target_os = "linux")]
        {
            let fd = check(unsafe {
                libc::syscall(libc::SYS_pidfd_open, number(identity, "pid")?, 0) as i32
            })?;
            let fd = unsafe { File::from_raw_fd(fd) };
            require(same(identity)?, "fault target changed while opening pidfd")?;
            Ok(Self {
                identity: identity.clone(),
                fd,
            })
        }
        #[cfg(not(target_os = "linux"))]
        Ok(Self {
            identity: identity.clone(),
        })
    }
    fn signal(&self, signal: i32) -> Result<()> {
        require(same(&self.identity)?, "held target identity lost")?;
        self.signal_pinned(signal)
    }
    // Faults are all checked first; no slow inventory between the two held pidfd syscalls.
    fn signal_pinned(&self, signal: i32) -> Result<()> {
        #[cfg(target_os = "linux")]
        check(unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                self.fd.as_raw_fd(),
                signal,
                std::ptr::null::<libc::siginfo_t>(),
                0,
            ) as i32
        })?;
        #[cfg(not(target_os = "linux"))]
        {
            require(same(&self.identity)?, "held target identity lost")?;
            check(unsafe { libc::kill(number(&self.identity, "pid")?, signal) })?;
        }
        Ok(())
    }
}
fn owned_exited(
    inventory: impl FnOnce() -> Result<BTreeMap<i32, Value>>,
    owned: &[Held],
    roles: &BTreeMap<&str, i32>,
    post_fault: bool,
    outer_exit_observed: bool,
    mut sample_birth: impl FnMut(i32) -> io::Result<String>,
) -> Result<bool> {
    let table = inventory().map_err(|error| format!("owned teardown ps inventory: {error}"))?;
    for held in owned
        .iter()
        .filter(|h| roles.values().any(|pid| h.identity["pid"] == *pid))
    {
        let pid = number(&held.identity, "pid")?;
        if let Some(p) = table.get(&pid) {
            let current_birth = match sample_birth(pid) {
                Ok(value) => value,
                Err(error)
                    if post_fault
                        && (error.raw_os_error() == Some(libc::ESRCH)
                            || cfg!(target_os = "linux")
                                && error.raw_os_error() == Some(libc::ENOENT)) =>
                {
                    // A disappearing sample is inconclusive; only a fresh complete poll can finish.
                    return Ok(false);
                }
                Err(error) => {
                    let role = roles.iter().find(|(_, p)| **p == pid).unwrap().0;
                    let call = if cfg!(target_os = "freebsd") {
                        "sysctl(KERN_PROC_PID)"
                    } else {
                        "query_birth"
                    };
                    return Err(format!(
                        "owned teardown birth role={role} pinned={} observed={p} call={call}: {error}",
                        held.identity
                    ));
                }
            };
            if current_birth == held.identity["birth"].as_str().ok_or("birth missing")?
                && !p["state"].as_str().ok_or("state missing")?.starts_with('Z')
            {
                return Ok(false);
            }
            if [
                "carrier",
                "outer",
                "backup",
                "guardian",
                "pi",
                "observer",
                "anchor",
                "extensionChild",
                "adoptedGrandchild",
            ]
            .iter()
            .any(|role| roles.get(role) == Some(&pid))
            {
                return Ok(false);
            }
        }
    }
    // A terminal process sample is not the outer child's wait status.
    Ok(post_fault || outer_exit_observed)
}

fn terminal() -> Result<Value> {
    let mut term: libc::termios = unsafe { std::mem::zeroed() };
    check(unsafe { libc::tcgetattr(0, &mut term) })?;
    let mut size: libc::winsize = unsafe { std::mem::zeroed() };
    check(unsafe { libc::ioctl(0, libc::TIOCGWINSZ, &mut size) })?;
    Ok(
        json!({"rows":size.ws_row,"columns":size.ws_col,"lflag":term.c_lflag,"iflag":term.c_iflag,"oflag":term.c_oflag,"cflag":term.c_cflag,
        "isig":term.c_lflag & libc::ISIG != 0,"icanon":term.c_lflag & libc::ICANON != 0,"echo":term.c_lflag & libc::ECHO != 0}),
    )
}
fn foreground(group: i32) -> Result<()> {
    // Like a shell: only this harness thread blocks TTOU during tcsetpgrp. No product policy change.
    unsafe {
        let mut mask: libc::sigset_t = std::mem::zeroed();
        let mut old: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut mask);
        libc::sigaddset(&mut mask, libc::SIGTTOU);
        check(libc::sigprocmask(libc::SIG_BLOCK, &mask, &mut old))?;
        let result = check(libc::tcsetpgrp(0, group));
        check(libc::sigprocmask(
            libc::SIG_SETMASK,
            &old,
            std::ptr::null_mut(),
        ))?;
        result?;
    }
    Ok(())
}
fn drain(master: &mut File, output: &mut Vec<u8>) -> Result<()> {
    let mut buf = [0u8; 8192];
    loop {
        match master.read(&mut buf) {
            Ok(0) => return Ok(()),
            Ok(n) => {
                output.extend_from_slice(&buf[..n]);
                if output.len() > 8192 {
                    output.drain(..output.len() - 8192);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
}
fn wait_for(
    mut condition: impl FnMut() -> Result<bool>,
    deadline: Instant,
    master: &mut File,
    output: &mut Vec<u8>,
    message: &str,
) -> Result<()> {
    loop {
        drain(master, output)
            .map_err(|error| format!("PTY read while waiting ({message}): {error}"))?;
        if condition().map_err(|error| format!("wait condition ({message}): {error}"))? {
            return Ok(());
        }
        require(Instant::now() < deadline, message)?;
        sleep(Duration::from_millis(25));
    }
}
fn spawn_group(command: &mut Command, group: i32) -> Result<Child> {
    unsafe {
        command.pre_exec(move || {
            if libc::setpgid(0, group) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    command.spawn().map_err(|e| e.to_string())
}

fn paused_inventory(
    table: &BTreeMap<i32, Value>,
    processes: &BTreeMap<&str, Value>,
    peer: &Value,
) -> Result<bool> {
    for (role, p) in processes {
        let pid = number(p, "pid")?;
        require(
            birth(pid)? == p["birth"].as_str().ok_or("missing paused birth")?
                && unsafe { libc::getsid(pid) } == number(p, "sid")?,
            "paused identity changed",
        )?;
        if ["outer", "backup", "guardian", "observer", "anchor"].contains(role) {
            if !runnable(table, p)?
                || *role == "anchor" && !matches!(state(table, p)?.chars().next(), Some('R' | 'S'))
            {
                return Ok(false);
            }
        } else if !stopped(table, p)? {
            return Ok(false);
        }
    }
    require(same(peer)?, "paused peer identity changed")?;
    stopped(table, peer)
}
fn pause_job(
    master: &mut File,
    output: &mut Vec<u8>,
    group: i32,
    processes: &BTreeMap<&str, Value>,
    peer: &Value,
    deadline: Instant,
) -> Result<BTreeMap<i32, Value>> {
    require(
        unsafe { libc::tcgetpgrp(0) } == group,
        "Pi job is not PTY foreground",
    )?;
    master.write_all(&[26]).map_err(|e| e.to_string())?;
    wait_for(
        || paused_inventory(&snapshot()?, processes, peer),
        deadline,
        master,
        output,
        "Pi/outer/tool/extension tree did not stop with runnable session reapers",
    )?;
    let table = snapshot()?;
    require(paused_inventory(&table, processes, peer)?, "pause unstable")?;
    Ok(table)
}
fn children_of(table: &BTreeMap<i32, Value>, parent: i32) -> Vec<i32> {
    table
        .iter()
        .filter(|(_, p)| p["parent"] == parent)
        .map(|(&pid, _)| pid)
        .collect()
}

fn session(
    args: &[String],
    master: &mut File,
    row: &mut Value,
    owned: &mut Vec<Held>,
    children: &mut Vec<Child>,
    output: &mut Vec<u8>,
) -> Result<()> {
    let executable = &args[0];
    let fixtures = &args[1];
    let work = PathBuf::from(&args[2]);
    let name = &args[3];
    let startup_ms: u64 = args[4].parse().map_err(|_| "invalid startup timeout")?;
    let deadline = Instant::now() + Duration::from_millis(startup_ms);
    let me = std::process::id() as i32;
    row["pty"] = json!({"harness":"native-openpty","interactive":true,"input":"ctrl-z","original":terminal()?,"noRescueCont":true});
    require(
        unsafe { libc::getuid() } != 0 && unsafe { libc::geteuid() } != 0,
        "PTY probe requires nonroot",
    )?;
    row["identity"] = json!({"uid":unsafe {libc::getuid()},"euid":unsafe {libc::geteuid()}});
    for flag in ["isig", "icanon", "echo"] {
        require(
            row["pty"]["original"][flag] == true,
            "original terminal not cooked",
        )?;
    }
    let own_binary = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut launch = Command::new(&own_binary);
    launch
        .arg("--launch")
        .arg(work.join("launch"))
        .arg(executable)
        .args([
            "--no-session",
            "--no-skills",
            "--no-prompt-templates",
            "--no-themes",
            "--no-context-files",
            "-e",
        ])
        .arg(Path::new(fixtures).join("extension.mjs"))
        .env("PI_OWNER_CASE", "pty")
        .env("PI_OWNER_PTY_SCENARIO", name)
        .env("PI_OWNER_PTY_HARNESS", &own_binary)
        .env("PI_OWNER_PTY_WORK", &work)
        .env("PI_OWNER_READY", work.join("ready"))
        .env("PI_OFFLINE", "1")
        .env("TERM", "xterm-256color")
        .env("HOME", &work)
        .env("PI_CODING_AGENT_DIR", &work)
        .current_dir(&work);
    for key in [
        "PI_PROCESS_OWNER_PID",
        "PI_PROCESS_OWNER_PENDING",
        "PI_PROCESS_OWNER_BINARY",
        "PI_NO_PROCESS_OWNERSHIP",
        "PI_STARTUP_BENCHMARK",
    ] {
        launch.env_remove(key);
    }
    let outer = spawn_group(&mut launch, 0)?;
    let carrier_pid = outer.id() as i32;
    children.push(outer);
    let mut peer = Command::new(&own_binary);
    peer.arg("--peer").arg(work.join("peer-heartbeat"));
    let peer = spawn_group(&mut peer, carrier_pid)?;
    let peer_pid = peer.id() as i32;
    children.push(peer);
    let initial = snapshot()?;
    owned.push(Held::open(&pin(&initial, carrier_pid)?)?);
    owned.push(Held::open(&pin(&initial, peer_pid)?)?);
    // The gate removes foreground-startup races without pre-parking Pi or faking Ctrl-Z.
    foreground(carrier_pid)?;
    fs::write(work.join("launch"), "go").map_err(|e| e.to_string())?;
    wait_for(
        || {
            Ok(work.join("ready").exists()
                && work.join("payload").exists()
                && work.join("heartbeat").exists()
                && work.join("peer-heartbeat").exists()
                && work.join("extension-child").exists()
                && work.join("extension-heartbeat").exists()
                && work.join("spawner").exists()
                && work.join("grandchild").exists()
                && work.join("grandchild-heartbeat").exists())
        },
        deadline,
        master,
        output,
        "interactive task not ready",
    )?;
    row["pi"] = load(&work.join("ready"))?;
    let pi_pid = number(&row["pi"], "pid")?;
    let guardian_pid = number(&row["pi"], "parent")?;
    let payload = load(&work.join("payload"))?;
    let payload_pid = number(&payload, "pid")?;
    let leaf_pid = number(&payload, "leaf")?;
    let table = snapshot()?;
    let task_guardian = number(table.get(&payload_pid).ok_or("missing payload")?, "parent")?;
    let task_outer = number(
        table.get(&task_guardian).ok_or("missing task guardian")?,
        "parent",
    )?;
    let extension_pid = number(&load(&work.join("extension-child"))?, "pid")?;
    let grandchild_record = load(&work.join("grandchild"))?;
    let grandchild_pid = number(&grandchild_record, "pid")?;
    let spawner_record = load(&work.join("spawner"))?;
    let spawner_pid = number(&spawner_record, "pid")?;
    let guardian_parent = number(
        table.get(&guardian_pid).ok_or("missing guardian")?,
        "parent",
    )?;
    let outer_pid = if cfg!(target_os = "macos") {
        guardian_parent
    } else {
        number(
            table.get(&guardian_parent).ok_or("missing anchor")?,
            "parent",
        )?
    };
    let backup_parent = if cfg!(target_os = "macos") {
        guardian_pid
    } else {
        guardian_parent
    };
    let backup = *children_of(&table, backup_parent)
        .iter()
        .find(|&&pid| pid != guardian_pid && pid != pi_pid)
        .ok_or("backup missing")?;
    let mut roles = BTreeMap::from([
        ("carrier", carrier_pid),
        ("outer", outer_pid),
        ("backup", backup),
        ("guardian", guardian_pid),
        ("pi", pi_pid),
        ("taskOuter", task_outer),
        ("taskGuardian", task_guardian),
        ("payload", payload_pid),
        ("leaf", leaf_pid),
        ("extensionChild", extension_pid),
        ("adoptedGrandchild", grandchild_pid),
    ]);
    require(
        table[&outer_pid]["parent"] == carrier_pid
            && children_of(&table, carrier_pid) == [outer_pid],
        "carrier must hold sole physical guardian",
    )?;
    require(
        table[&task_outer]["parent"] == pi_pid,
        "task outer not Pi child",
    )?;
    require(
        table[&extension_pid]["parent"] == pi_pid,
        "extension child not Pi child",
    )?;
    let carrier = pin(&table, carrier_pid)?;
    let guardian = pin(&table, guardian_pid)?;
    let primary = pin(&table, pi_pid)?;
    require(
        primary["sid"] == guardian["sid"]
            && primary["sid"] != carrier["sid"]
            && primary["group"]
                == if cfg!(target_os = "macos") {
                    pi_pid
                } else {
                    guardian_pid
                },
        "Pi private SID/foreground PG invalid",
    )?;
    require(
        primary["parent"] == guardian_pid,
        "Pi parent does not match pinned guardian",
    )?;
    for pid in [outer_pid, backup] {
        let physical = pin(&table, pid)?;
        require(
            physical["sid"] == carrier["sid"] && physical["group"] == carrier_pid,
            "physical controller left caller SID/job PG",
        )?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let anchor = guardian_parent;
        let mut expected = vec![guardian_pid, backup];
        expected.sort_unstable();
        require(
            children_of(&table, outer_pid) == [anchor] && children_of(&table, anchor) == expected,
            "expected physical guardian -> anchor -> guardian + backup",
        )?;
        let identity = pin(&table, anchor)?;
        require(
            identity["group"] == anchor
                && identity["sid"] == anchor
                && guardian["sid"] == anchor
                && guardian["group"] == guardian_pid
                && matches!(state(&table, &identity)?.chars().next(), Some('R' | 'S')),
            "private anchor/session/group invalid",
        )?;
        require(
            native_path(anchor)?
                == Path::new(row["pi"]["owner"].as_str().ok_or("owner path missing")?),
            "anchor not shipped native owner",
        )?;
        roles.insert("anchor", anchor);
        row["anchorNative"] = json!(true);
    }
    #[cfg(target_os = "macos")]
    {
        let outer_children = children_of(&table, outer_pid);
        require(
            outer_children.len() == 2 && outer_children.contains(&guardian_pid),
            "expected private guardian + observer",
        )?;
        let observer = *outer_children
            .iter()
            .find(|&&pid| pid != guardian_pid)
            .ok_or("observer missing")?;
        let observed = pin(&table, observer)?;
        require(
            observed["sid"] == observer
                && observed["group"] == observer
                && guardian["sid"] == guardian_pid
                && guardian["group"] == guardian_pid
                && primary["group"] != guardian["group"],
            "Darwin private guardian/observer sessions invalid",
        )?;
        require(
            native_path(observer)?
                == Path::new(row["pi"]["owner"].as_str().ok_or("owner path missing")?),
            "observer not shipped native owner",
        )?;
        roles.insert("observer", observer);
        row["observerNative"] = json!(true);
    }
    let mut expected_ids: BTreeSet<i32> = roles.values().copied().collect();
    expected_ids.insert(spawner_pid);
    require(
        descendants(&table, carrier_pid) == expected_ids && !expected_ids.contains(&peer_pid),
        "owned inventory/peer ancestry invalid",
    )?;
    for &pid in &expected_ids {
        let identity = pin(&table, pid)?;
        require(
            identity["uid"] == unsafe { libc::getuid() },
            "owned process UID mismatch",
        )?;
        if !owned.iter().any(|held| held.identity["pid"] == pid) {
            owned.push(Held::open(&identity)?);
        }
    }
    let mut processes: BTreeMap<&str, Value> = roles
        .iter()
        .map(|(&role, &pid)| Ok((role, pin(&table, pid)?)))
        .collect::<Result<_>>()?;
    let spawner = pin(&table, spawner_pid)?;
    let grandchild_before = processes["adoptedGrandchild"].clone();
    require(
        spawner["birth"] == spawner_record["birth"]
            && spawner["parent"] == pi_pid
            && grandchild_before["birth"] == grandchild_record["birth"]
            && grandchild_before["parent"] == spawner_pid
            && grandchild_before["group"] == grandchild_pid
            && grandchild_before["sid"] == grandchild_pid,
        "pinned spawner/setsid grandchild ancestry invalid",
    )?;
    row["adoption"] =
        json!({"spawner":spawner,"grandchildBefore":grandchild_before,"observationCycle":null});
    row["peer"] = pin(&table, peer_pid)?;
    let peer_identity = row["peer"].clone();
    let heartbeat_paths = [
        ("task", "heartbeat"),
        ("extensionChild", "extension-heartbeat"),
        ("adoptedGrandchild", "grandchild-heartbeat"),
    ];
    let before: BTreeMap<_, _> = heartbeat_paths
        .iter()
        .map(|(role, path)| Ok((*role, ticks(&work.join(path))?)))
        .collect::<Result<_>>()?;
    sleep(Duration::from_millis(250));
    row["descendantHeartbeats"] = json!({});
    for (role, path) in heartbeat_paths {
        let advancing = ticks(&work.join(path))?;
        require(
            advancing > before[role],
            "owned heartbeat not advancing before pause",
        )?;
        let proof = json!({"before":before[role],"advancing":advancing,"stableMs":250});
        if role == "task" {
            row["heartbeats"] = proof;
        } else {
            row["descendantHeartbeats"][role] = proof;
        }
    }
    wait_for(
        || Ok(terminal()?["icanon"] == false && terminal()?["echo"] == false),
        deadline,
        master,
        output,
        "interactive raw terminal missing",
    )?;
    row["pty"]["rawObserved"] = json!(true);
    row["pty"]["raw"] = terminal()?;
    sleep(Duration::from_millis(500));
    #[cfg(target_os = "macos")]
    {
        // Observe the descendant through a complete freeze/thaw before it can be adopted by launchd.
        let mut observed_processes = processes.clone();
        observed_processes.insert("spawner", spawner.clone());
        let first = pause_job(
            master,
            output,
            carrier_pid,
            &observed_processes,
            &peer_identity,
            deadline,
        )?;
        let pause_start = ticks(&work.join("grandchild-heartbeat"))?;
        sleep(Duration::from_millis(250));
        require(
            paused_inventory(&snapshot()?, &observed_processes, &peer_identity)?,
            "Darwin observation cycle unstable",
        )?;
        let pause_end = ticks(&work.join("grandchild-heartbeat"))?;
        require(
            pause_start == pause_end,
            "Darwin observed grandchild still advancing while stopped",
        )?;
        let grandchild_paused = pin(&first, grandchild_pid)?;
        let spawner_paused = pin(&first, spawner_pid)?;
        foreground(me)?;
        foreground(carrier_pid)?;
        check(unsafe { libc::kill(-carrier_pid, libc::SIGCONT) })?;
        wait_for(
            || {
                let t = snapshot()?;
                Ok(runnable(&t, &grandchild_before)?
                    && runnable(&t, &spawner)?
                    && ticks(&work.join("grandchild-heartbeat"))? > pause_end)
            },
            deadline,
            master,
            output,
            "Darwin observed grandchild did not resume before adoption",
        )?;
        let resumed = snapshot()?;
        row["adoption"]["observationCycle"] = json!({"input":"ctrl-z,fg","grandchildPaused":grandchild_paused,"spawnerPaused":spawner_paused,"grandchildResumed":pin(&resumed,grandchild_pid)?,"spawnerResumed":pin(&resumed,spawner_pid)?,"heartbeatPauseStart":pause_start,"heartbeatPauseEnd":pause_end,"heartbeatResumed":ticks(&work.join("grandchild-heartbeat"))?,"stableMs":250});
        wait_for(
            || Ok(terminal()?["icanon"] == false && terminal()?["echo"] == false),
            deadline,
            master,
            output,
            "Darwin raw terminal did not resume",
        )?;
        sleep(Duration::from_millis(500));
    }
    fs::write(work.join("spawner-release"), "exit").map_err(|e| e.to_string())?;
    wait_for(
        || Ok(work.join("spawner-exit").exists() && !snapshot()?.contains_key(&spawner_pid)),
        deadline,
        master,
        output,
        "extension spawner was not reaped before fault pause",
    )?;
    let spawner_exit = load(&work.join("spawner-exit"))?;
    require(
        spawner_exit["pid"] == spawner_pid
            && spawner_exit["birth"] == spawner["birth"]
            && spawner_exit["code"] == 0
            && spawner_exit["signal"].is_null(),
        "spawner did not exit cleanly with pinned birth",
    )?;
    let adopted_table = snapshot()?;
    let remaining: BTreeSet<i32> = roles
        .values()
        .copied()
        .filter(|pid| !cfg!(target_os = "macos") || *pid != grandchild_pid)
        .collect();
    require(
        descendants(&adopted_table, carrier_pid) == remaining,
        "owned inventory changed before final pause",
    )?;
    let adopted = pin(&adopted_table, grandchild_pid)?;
    require(
        adopted["birth"] == grandchild_before["birth"],
        "adopted grandchild birth changed",
    )?;
    #[cfg(not(target_os = "macos"))]
    require(
        [roles["anchor"], guardian_pid]
            .iter()
            .any(|pid| adopted["parent"] == *pid),
        "grandchild not adopted by pinned session reaper",
    )?;
    #[cfg(target_os = "macos")]
    require(
        adopted["parent"] == 1,
        "observed Darwin grandchild not adopted by launchd",
    )?;
    row["adoption"]["spawnerExit"] = spawner_exit;
    row["adoption"]["spawnerReaped"] = json!(true);
    row["adoption"]["spawnerState"] = json!("gone");
    row["adoption"]["postExitParent"] = adopted["parent"].clone();
    // Refresh live ancestry before final pause, preserving each already held birth identity.
    for (&role, &pid) in &roles {
        let current = pin(&adopted_table, pid)?;
        require(
            current["birth"] == processes[role]["birth"],
            "owned birth changed before final pause",
        )?;
        processes.insert(role, current);
    }
    row["processes"] = json!(processes);
    row["controllers"] = json!({});
    let physical_tty = unsafe { libc::ttyname(0) };
    require(!physical_tty.is_null(), "physical tty name unavailable")?;
    let physical_tty = unsafe { std::ffi::CStr::from_ptr(physical_tty) }
        .to_str()
        .map_err(|e| e.to_string())?
        .to_owned();
    row["pty"]["physicalTty"] = json!(physical_tty);
    let physical_device = fs::metadata(&physical_tty)
        .map_err(|e| e.to_string())?
        .rdev()
        .to_string();
    row["pty"]["physicalDevice"] = json!(physical_device);
    for role in [
        "carrier",
        "outer",
        "backup",
        "guardian",
        if cfg!(target_os = "macos") {
            "observer"
        } else {
            "anchor"
        },
        "pi",
    ] {
        let mut current = capture_controller(
            &processes[role],
            if role == "pi" {
                None
            } else {
                Some(Path::new(
                    row["pi"]["owner"].as_str().ok_or("owner missing")?,
                ))
            },
            &physical_device,
            ["pi", "guardian", "anchor", "observer"].contains(&role),
            current_uids,
            #[cfg(test)]
            || {},
        )?;
        current["physicalTty"] = json!(physical_tty);
        row["controllers"][role] = current;
    }
    row["sessionChildren"] = json!({"carrier":children_of(&adopted_table,carrier_pid),"outer":children_of(&adopted_table,outer_pid)});
    #[cfg(target_os = "macos")]
    {
        row["sessionChildren"]["guardian"] = json!(children_of(&adopted_table, guardian_pid));
    }
    #[cfg(not(target_os = "macos"))]
    {
        let anchor = roles["anchor"];
        let mut expected_anchor_children = vec![guardian_pid, backup];
        if adopted["parent"] == anchor {
            expected_anchor_children.push(grandchild_pid);
        }
        expected_anchor_children.sort_unstable();
        require(
            children_of(&adopted_table, outer_pid) == [anchor]
                && children_of(&adopted_table, anchor) == expected_anchor_children,
            "session reaper topology changed before final pause",
        )?;
        row["sessionChildren"]["anchor"] = json!(expected_anchor_children);
    }
    let blocked = name.ends_with("-shutdown-blocked");
    if blocked {
        fs::write(work.join("shutdown-arm"), "arm").map_err(|e| e.to_string())?;
    }
    require(
        !work.join("shutdown-hook-entered").exists()
            && !work.join("shutdown-entered").exists()
            && !work.join("shutdown-returned").exists(),
        "shutdown hook ran before fault",
    )?;
    row["pty"]["jobForeground"] = json!(unsafe { libc::tcgetpgrp(0) } == carrier_pid);
    let paused = pause_job(
        master,
        output,
        carrier_pid,
        &processes,
        &peer_identity,
        deadline,
    )?;
    row["paused"] = json!(
        processes
            .iter()
            .map(|(role, identity)| {
                let mut p = paused[&(identity["pid"].as_i64().unwrap() as i32)].clone();
                p["role"] = json!(role);
                p["birth"] = identity["birth"].clone();
                p["sid"] = identity["sid"].clone();
                p
            })
            .collect::<Vec<_>>()
    );
    row["pty"]["paused"] = terminal()?;
    row["peerPaused"] = paused[&peer_pid].clone();
    row["peerPaused"]["birth"] = peer_identity["birth"].clone();
    row["peerPaused"]["sid"] = peer_identity["sid"].clone();
    let pause_counts: BTreeMap<_, _> = heartbeat_paths
        .iter()
        .map(|(role, path)| Ok((*role, ticks(&work.join(path))?)))
        .collect::<Result<_>>()?;
    let pause_start = pause_counts["task"];
    let peer_start = ticks(&work.join("peer-heartbeat"))?;
    sleep(Duration::from_millis(250));
    require(
        paused_inventory(&snapshot()?, &processes, &peer_identity)?,
        "pause not stable for 250ms",
    )?;
    for (role, path) in heartbeat_paths {
        let end = ticks(&work.join(path))?;
        require(
            end == pause_counts[role],
            "paused owned heartbeat continued",
        )?;
        let proof = if role == "task" {
            &mut row["heartbeats"]
        } else {
            &mut row["descendantHeartbeats"][role]
        };
        proof["pauseStart"] = json!(pause_counts[role]);
        proof["pauseEnd"] = json!(end);
    }
    row["heartbeats"]["peerPause"] = json!(peer_start);
    row["piStopped"] = json!(true);
    row["stopped"] = json!(true);
    row["aliveBefore"] = json!(true);
    row["peerRunning"] = json!(true);
    // Shell regains foreground only. Never tcsetattr: final cooked flags must come from product teardown.
    foreground(me)?;
    let roles_to_kill = fault_roles(name)?;
    let faults = roles_to_kill
        .iter()
        .map(|role| {
            let p = &row["processes"][role];
            require(p.is_object(), "fault role absent")?;
            Held::open(p).map(|held| (*role, held))
        })
        .collect::<Result<Vec<_>>>()?;
    // Recheck both ancestry and birth immediately before injecting faults, before any adoption.
    let pre_fault = snapshot()?;
    for (_, held) in &faults {
        let pid = number(&held.identity, "pid")?;
        require(
            pre_fault
                .get(&pid)
                .is_some_and(|p| p["parent"] == held.identity["parent"]),
            "fault ancestry changed",
        )?;
    }
    require(
        !work.join("shutdown-hook-entered").exists()
            && !work.join("shutdown-entered").exists()
            && !work.join("shutdown-returned").exists(),
        "shutdown hook entered before injected fault",
    )?;
    row["faultTargets"] = json!(faults.iter().map(|(role, held)| json!({"role":role,"pid":held.identity["pid"],"birth":held.identity["birth"],"parent":held.identity["parent"],"method":if cfg!(target_os="linux") {"pidfd"} else {"checked-birth"},"delivered":false})).collect::<Vec<_>>());
    let death_start = Instant::now();
    if name == "suspend-resume" {
        row["resizeCycles"] = json!([]);
        for (index, (rows, columns)) in [(43u16, 127u16), (37, 113)].into_iter().enumerate() {
            if index != 0 {
                pause_job(
                    master,
                    output,
                    carrier_pid,
                    &processes,
                    &peer_identity,
                    deadline,
                )?;
                foreground(me)?;
            }
            // Normal shell bg: resume this job, but keep shell/physical holder foreground.
            check(unsafe { libc::kill(-carrier_pid, libc::SIGCONT) })?;
            wait_for(
                || {
                    Ok(runnable(&snapshot()?, &processes["pi"])?
                        && ticks(&work.join("heartbeat"))? > pause_start)
                },
                deadline,
                master,
                output,
                "bg did not resume private primary/task",
            )?;
            fs::write(work.join("ui-probe-arm"), "arm").map_err(|e| e.to_string())?;
            wait_for(
                || Ok(work.join("ui-listeners-initial").exists()),
                deadline,
                master,
                output,
                "UI listener sample missing",
            )?;
            let version = (index + 1).to_string();
            let size = libc::winsize {
                ws_row: rows,
                ws_col: columns,
                ws_xpixel: 0,
                ws_ypixel: 0,
            };
            check(unsafe { libc::ioctl(0, libc::TIOCSWINSZ, &size) })?;
            require(
                unsafe { libc::tcgetpgrp(0) } == me && terminal()?["icanon"] == true,
                "bg lost shell foreground/cooked mode",
            )?;
            drain(master, output)?;
            let mut background_output = Vec::new();
            fs::write(work.join("ui-version"), &version).map_err(|e| e.to_string())?;
            wait_for(
                || {
                    Ok(work.join("ui-acked").exists()
                        && load(&work.join("ui-acked"))?["version"] == version)
                },
                deadline,
                master,
                &mut background_output,
                "background UI state did not advance",
            )?;
            sleep(Duration::from_millis(150));
            drain(master, &mut background_output)?;
            require(
                background_output.is_empty(),
                "background physical UI emitted output",
            )?;
            require(
                runnable(&snapshot()?, &processes["pi"])? && terminal()?["icanon"] == true,
                "background private primary stopped/physical mode changed",
            )?;
            output.clear();
            foreground(carrier_pid)?;
            check(unsafe { libc::kill(-carrier_pid, libc::SIGCONT) })?;
            wait_for(
                || {
                    Ok(!stopped(&snapshot()?, &processes["pi"])?
                        && ticks(&work.join("heartbeat"))? > pause_start)
                },
                deadline,
                master,
                output,
                "fg did not resume task",
            )?;
            let layout_deadline = Instant::now() + Duration::from_secs(5);
            loop {
                drain(master, output)?;
                let frame = load(&work.join("ui-frame"))?;
                if frame["version"] == version
                    && frame["rows"] == rows
                    && frame["columns"] == columns
                    && frame["width"] == columns
                    && frame_evidence(output, &version, rows, columns).is_some()
                {
                    break;
                }
                require(
                    Instant::now() < layout_deadline,
                    "fg private dimensions/current full layout stale",
                )?;
                sleep(Duration::from_millis(25));
            }
            let frame = load(&work.join("ui-frame"))?;
            let evidence = frame_evidence(output, &version, rows, columns)
                .ok_or("current full frame absent")?;
            require(
                terminal()?["icanon"] == false
                    && terminal()?["rows"] == rows
                    && terminal()?["columns"] == columns,
                "fg raw/current physical dimensions missing",
            )?;
            let key = if index == 0 { b'x' } else { b'y' };
            master.write_all(&[key, 127]).map_err(|e| e.to_string())?;
            wait_for(
                || {
                    Ok(work.join("ui-input").exists()
                        && load(&work.join("ui-input"))?["count"] == index + 1)
                },
                deadline,
                master,
                output,
                "input was duplicated or lost",
            )?;
            sleep(Duration::from_millis(75));
            let listeners = load(&work.join("ui-listeners"))?;
            require(
                listeners == load(&work.join("ui-listeners-initial"))?,
                "input/CONT/resize listeners grew after fg",
            )?;
            require(
                load(&work.join("ui-input"))?["count"] == index + 1,
                "input duplicated after settling",
            )?;
            row["resizeCycles"].as_array_mut().ok_or("resize cycles missing")?.push(json!({"input":"ctrl-z,bg,fg","physical":{"rows":rows,"columns":columns},"private":frame,"frame":evidence,"bgPrimaryRunnable":true,"physicalUiPaused":true,"bgCooked":true,"fgRaw":true,"inputCount":index+1,"listeners":listeners,"initialListeners":load(&work.join("ui-listeners-initial"))?}));
        }
        row["resumed"] = json!(true);
        sleep(Duration::from_millis(500));
        master.write_all(&[4]).map_err(|e| e.to_string())?;
    } else {
        for (index, (role, held)) in faults.iter().enumerate() {
            held.signal_pinned(libc::SIGKILL).map_err(|error| {
                format!(
                    "fault SIGKILL role={role} pinned={}: {error}",
                    held.identity
                )
            })?;
            row["faultTargets"][index]["delivered"] = json!(true);
            row["faultTargets"][index]["signal"] = json!("SIGKILL");
            row["faultTargets"][index]["result"] = json!(0);
        }
    }
    let end = Instant::now() + Duration::from_secs(8);
    wait_for(
        || {
            for child in children.iter_mut().take(1) {
                if let Some(status) = child.try_wait().map_err(|error| {
                    format!(
                        "owned teardown try_wait role=outer pinned={}: {error}",
                        processes["carrier"]
                    )
                })? {
                    row["exit"] = json!({"code":status.code(),"signal":status.signal()});
                }
            }
            owned_exited(
                snapshot,
                owned,
                &roles,
                !faults.is_empty(),
                row.get("exit").is_some(),
                query_birth,
            )
        },
        end,
        master,
        output,
        "owned teardown exceeded 8s (stopped processes count as alive)",
    )
    .inspect_err(|_| {
        row["teardownFailureMs"] = json!(death_start.elapsed().as_millis() as u64);
    })?;
    if roles_to_kill.contains(&"carrier") {
        require(
            row["exit"]["code"].is_null() && row["exit"]["signal"] == libc::SIGKILL,
            "carrier actual SIGKILL terminal status missing",
        )?;
    }
    if name == "suspend-resume" {
        require(
            row["exit"]["code"] == 0 && row["exit"]["signal"].is_null(),
            "normal fg/Ctrl-D exit was not clean",
        )?;
    }
    row["postDeathMs"] = json!(death_start.elapsed().as_millis() as u64);
    let table = snapshot()?;
    row["after"] = json!(owned.iter().filter(|h| roles.values().any(|pid| h.identity["pid"] == *pid)).map(|h| {
        let pid = h.identity["pid"].as_i64().unwrap() as i32;
        json!({"pid":pid,"birth":h.identity["birth"],"state":table.get(&pid).map(|p| p["state"].clone()).unwrap_or(json!("gone"))})
    }).collect::<Vec<_>>());
    let mut exit_counts = BTreeMap::new();
    for (role, path) in heartbeat_paths {
        exit_counts.insert(role, ticks(&work.join(path))?);
    }
    sleep(Duration::from_millis(250));
    for (role, path) in heartbeat_paths {
        let after = ticks(&work.join(path))?;
        require(
            exit_counts[role] == after,
            "owned heartbeat continued after teardown",
        )?;
        let proof = if role == "task" {
            &mut row["heartbeats"]
        } else {
            &mut row["descendantHeartbeats"][role]
        };
        proof["exit"] = json!(exit_counts[role]);
        proof["after"] = json!(after);
    }
    row["heartbeats"]["peerAfter"] = json!(ticks(&work.join("peer-heartbeat"))?);
    let hook = if work.join("shutdown-hook-entered").exists() {
        load(&work.join("shutdown-hook-entered"))?
    } else {
        Value::Null
    };
    row["shutdownHook"] =
        json!({"entered":!hook.is_null(),"enteredBeforeFault":false,"pid":hook["pid"]});
    require(
        (hook.is_null() || hook["pid"] == pi_pid)
            && (roles_to_kill.is_empty()
                || matches!(
                    name.as_str(),
                    "paused-outer-death" | "paused-anchor-death" | "paused-observer-death"
                )
                || !hook.is_null()),
        "shutdown-hook entry proof missing",
    )?;
    let entered = if work.join("shutdown-entered").exists() {
        load(&work.join("shutdown-entered"))?
    } else {
        Value::Null
    };
    row["shutdownBlock"] = json!({"armed":work.join("shutdown-arm").exists(),"entered":!entered.is_null(),"returned":work.join("shutdown-returned").exists(),"enteredBeforeFault":false,"pid":entered["pid"],"waitMs":entered["waitMs"]});
    require(
        row["shutdownBlock"]["armed"] == blocked
            && row["shutdownBlock"]["entered"] == blocked
            && row["shutdownBlock"]["returned"] == false
            && (!blocked
                || entered["pid"] == pi_pid
                    && entered["waitMs"].as_u64().is_some_and(|ms| ms >= 12000)),
        "shutdown-hook worker deadline not exercised",
    )?;
    require(same(&row["peer"])?, "unowned peer lost")?;
    if name != "suspend-resume" {
        require(
            stopped(&snapshot()?, &row["peer"])?
                && ticks(&work.join("peer-heartbeat"))? == peer_start,
            "unowned same-group peer received CONT",
        )?;
    }
    foreground(me)?;
    row["pty"]["after"] = terminal()?;
    row["pty"]["shellForeground"] = json!(unsafe { libc::tcgetpgrp(0) } == me);
    row["pty"]["shellAlive"] = json!(true);
    for flag in ["isig", "icanon", "echo"] {
        require(
            row["pty"]["after"][flag] == row["pty"]["original"][flag],
            "product did not restore cooked terminal",
        )?;
    }
    row["peerStoppedAfter"] = json!(stopped(&snapshot()?, &row["peer"])?);
    #[cfg(target_os = "macos")]
    {
        row["observerReaped"] = json!(!snapshot()?.contains_key(&roles["observer"]));
    }
    #[cfg(not(target_os = "macos"))]
    {
        row["anchorReaped"] = json!(!snapshot()?.contains_key(&roles["anchor"]));
    }
    row["backupReaped"] = json!(!snapshot()?.contains_key(&backup));
    row["guardExpired"] = json!(false);
    row["aliveAfter"] = json!(false);
    row["peerAlive"] = json!(true);
    row["allOwnedExited"] = json!(true);
    row["immediateChecks"] = json!(1);
    row["status"] = json!("passed");
    Ok(())
}

fn frame_evidence(output: &[u8], version: &str, rows: u16, columns: u16) -> Option<String> {
    let text = String::from_utf8_lossy(output);
    let top = format!("CI_PTY_TOP_{version}");
    let start = text.rfind(&top)?;
    let frame = &text[start..];
    let layout = frame.find(&format!("CI_PTY_LAYOUT_{columns}x{rows}"))?;
    let bar = frame[layout..].find('~')? + layout;
    let length = frame[bar..].chars().take_while(|&c| c == '~').count();
    if length != usize::from(columns) {
        return None;
    }
    let bottom = format!("CI_PTY_BOTTOM_{version}");
    let end = frame[bar + length..].find(&bottom)? + bar + length + bottom.len();
    Some(frame[..end].to_owned())
}

fn pty_entry_allowed(mode: Option<&str>, uid: libc::uid_t, euid: libc::uid_t) -> bool {
    !matches!(mode, Some("--run" | "--session")) || uid != 0 && euid != 0
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if !pty_entry_allowed(
        args.first().map(String::as_str),
        unsafe { libc::getuid() },
        unsafe { libc::geteuid() },
    ) {
        eprintln!("PTY probe requires nonroot");
        std::process::exit(1);
    }
    match args.first().map(String::as_str) {
        Some("--peer") | Some("--leaf") => beat(Path::new(&args[1])),
        Some("--extension-child") | Some("--adopted-grandchild") => {
            let work = Path::new(&args[1]);
            let direct = args[0] == "--extension-child";
            let name = if direct {
                "extension-child"
            } else {
                "grandchild"
            };
            let identity = pin(
                &snapshot().expect("child inventory"),
                std::process::id() as i32,
            )
            .expect("child identity");
            publish(&work.join(name), &identity).expect("child record");
            beat(&work.join(if direct {
                "extension-heartbeat"
            } else {
                "grandchild-heartbeat"
            }));
        }
        Some("--adoption-spawner") => {
            let work = Path::new(&args[1]);
            let mut command = Command::new(std::env::current_exe().unwrap());
            command.arg("--adopted-grandchild").arg(work);
            unsafe {
                command.pre_exec(|| {
                    if libc::setsid() < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
            #[expect(
                clippy::zombie_processes,
                reason = "Deliberate orphan fixture: spawner exits before child; session reaper or launchd must reap it"
            )]
            let _grandchild = command.spawn().expect("setsid grandchild");
            publish(
                &work.join("spawner"),
                &pin(
                    &snapshot().expect("spawner inventory"),
                    std::process::id() as i32,
                )
                .expect("spawner identity"),
            )
            .expect("spawner record");
            let deadline = Instant::now() + Duration::from_secs(240);
            while !work.join("spawner-release").exists() {
                assert!(Instant::now() < deadline, "spawner gate expired");
                sleep(Duration::from_millis(5));
            }
            // Deliberate orphan: Pi reaps this direct child; session ownership must retain its setsid child.
        }
        Some("--payload") => {
            let work = Path::new(&args[1]);
            let mut leaf = Command::new(std::env::current_exe().unwrap())
                .arg("--leaf")
                .arg(work.join("heartbeat"))
                .spawn()
                .expect("leaf");
            publish(
                &work.join("payload"),
                &json!({"pid":std::process::id(),"leaf":leaf.id()}),
            )
            .expect("payload record");
            let status = leaf.wait().expect("leaf wait");
            std::process::exit(status.code().unwrap_or(1));
        }
        Some("--launch") => {
            let deadline = Instant::now() + Duration::from_secs(10);
            while !Path::new(&args[1]).exists() {
                assert!(Instant::now() < deadline, "launch gate expired");
                sleep(Duration::from_millis(5));
            }
            let error = Command::new(&args[2]).args(&args[3..]).exec();
            panic!("exec artifact: {error}");
        }
        Some("--session") => {
            let fd: i32 = args[1].parse().expect("master fd");
            let mut master = unsafe { File::from_raw_fd(fd) };
            check(unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) })
                .expect("master cloexec");
            let mut row = json!({"name":args[5],"status":"failed"});
            let mut held = Vec::new();
            let mut children = Vec::new();
            let mut output = Vec::new();
            if let Err(error) = session(
                &args[2..],
                &mut master,
                &mut row,
                &mut held,
                &mut children,
                &mut output,
            ) {
                row["error"] = json!(error);
                row["terminalAtFailure"] = match terminal() {
                    Ok(value) => value,
                    Err(error) => json!({"error":error}),
                };
                row["inventoryAtFailure"] = match snapshot() {
                    Ok(table) => json!(
                        held.iter()
                            .map(|p| {
                                let pid = p.identity["pid"].as_i64().unwrap() as i32;
                                json!({"identity":p.identity,"observed":table.get(&pid)})
                            })
                            .collect::<Vec<_>>()
                    ),
                    Err(error) => json!({"error":error}),
                };
                let work = Path::new(&args[4]);
                row["shutdownFilesAtFailure"] = json!({"armed":work.join("shutdown-arm").exists()});
                for name in [
                    "shutdown-hook-entered",
                    "shutdown-entered",
                    "shutdown-returned",
                ] {
                    let path = work.join(name);
                    let record = if path.exists() {
                        load(&path).unwrap_or_else(|error| json!({"error":error}))
                    } else {
                        Value::Null
                    };
                    row["shutdownFilesAtFailure"][name] = json!({"record":record,"temporaryExists":path.with_extension("tmp").exists()});
                }
            }
            row["outputTail"] = json!(String::from_utf8_lossy(&output));
            // Evidence is final BEFORE any cleanup. No cleanup CONT, even on failure.
            publish(&Path::new(&args[4]).join("result"), &row).expect("result");
            for process in held.iter().rev() {
                if same(&process.identity).unwrap_or(false) {
                    let _ = process.signal(libc::SIGKILL);
                }
            }
            for child in &mut children {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        Some("--run") => {
            assert_eq!(args.len(), 6, "--run artifact fixtures work row startup-ms");
            let mut master = -1;
            let mut slave = -1;
            let size = libc::winsize {
                ws_row: 40,
                ws_col: 120,
                ws_xpixel: 0,
                ws_ypixel: 0,
            };
            check(unsafe {
                libc::openpty(
                    &mut master,
                    &mut slave,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    &size,
                )
            })
            .expect("openpty");
            let master_file = unsafe { File::from_raw_fd(master) };
            let slave_file = unsafe { File::from_raw_fd(slave) };
            check(unsafe { libc::fcntl(slave, libc::F_SETFD, libc::FD_CLOEXEC) })
                .expect("slave cloexec");
            check(unsafe { libc::fcntl(master, libc::F_SETFL, libc::O_NONBLOCK) })
                .expect("nonblocking master");
            let mut command = Command::new(std::env::current_exe().unwrap());
            command
                .arg("--session")
                .arg(master.to_string())
                .args(&args[1..])
                .stdin(Stdio::from(slave_file.try_clone().unwrap()))
                .stdout(Stdio::from(slave_file.try_clone().unwrap()))
                .stderr(Stdio::from(slave_file.try_clone().unwrap()));
            unsafe {
                command.pre_exec(|| {
                    if libc::setsid() < 0 || libc::ioctl(0, libc::TIOCSCTTY as _, 0) < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    for signal in [
                        libc::SIGTSTP,
                        libc::SIGTTIN,
                        libc::SIGTTOU,
                        libc::SIGCONT,
                        libc::SIGHUP,
                    ] {
                        libc::signal(signal, libc::SIG_DFL);
                    }
                    let mut mask: libc::sigset_t = std::mem::zeroed();
                    libc::sigemptyset(&mut mask);
                    libc::sigprocmask(libc::SIG_SETMASK, &mask, std::ptr::null_mut());
                    Ok(())
                });
            }
            let status = command.status().expect("PTY session");
            drop(master_file);
            drop(slave_file);
            let result =
                load(&Path::new(&args[3]).join("result")).expect("session evidence missing");
            println!("{result}");
            if !status.success() || result["status"] != "passed" {
                std::process::exit(1);
            }
        }
        _ => panic!("CI owner PTY fixture: unknown invocation"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(target_os = "linux")]
    fn capture_rejects_same_birth_exec_after_last_fd_sample() {
        let mut child = Command::new("bash")
            .args(["-c", "read gate; exec sleep 30"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id() as i32;
        sleep(Duration::from_millis(50));
        let before = pin(&snapshot().unwrap(), pid).unwrap();
        let image = fs::canonicalize(native_path(pid).unwrap()).unwrap();
        let result = capture_controller(&before, None, "0", true, current_uids, || {
            child.stdin.as_mut().unwrap().write_all(b"go\n").unwrap();
            let end = Instant::now() + Duration::from_secs(3);
            while fs::canonicalize(native_path(pid).unwrap()).unwrap() == image {
                assert!(Instant::now() < end);
                sleep(Duration::from_millis(5));
            }
            assert_eq!(birth(pid).unwrap(), before["birth"]);
        });
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(result.unwrap_err().contains("controller changed"));
    }
    #[test]
    fn capture_rechecks_full_uid_vector_and_propagates_credential_errors() {
        let pid = std::process::id() as i32;
        let before = pin(&snapshot().unwrap(), pid).unwrap();
        for changed in [false, true] {
            let mut calls = 0;
            let result = capture_controller(
                &before,
                None,
                "0",
                false,
                |pid| {
                    calls += 1;
                    let mut uids = current_uids(pid)?;
                    if calls == 2 {
                        if !changed {
                            return Err("postcapture credential permission denied".into());
                        }
                        uids[0] += 1;
                    }
                    Ok(uids)
                },
                || {},
            );
            assert_eq!(calls, 2);
            assert!(result.is_err());
        }
    }
    #[test]
    #[cfg(target_os = "linux")]
    fn capture_postcapture_native_image_error_is_fatal() {
        let mut child = Command::new("sleep").arg("30").spawn().unwrap();
        let before = pin(&snapshot().unwrap(), child.id() as i32).unwrap();
        let result = capture_controller(&before, None, "0", false, current_uids, || {
            child.kill().unwrap();
            child.wait().unwrap();
        });
        assert!(
            result.is_err(),
            "lost image must not become absence or pending"
        );
    }
    #[test]
    fn capture_accepts_unchanged_native_controller() {
        let pid = std::process::id() as i32;
        let before = pin(&snapshot().unwrap(), pid).unwrap();
        let image = fs::canonicalize(native_path(pid).unwrap()).unwrap();
        let result =
            capture_controller(&before, Some(&image), "0", false, current_uids, || {}).unwrap();
        assert_eq!(result["image"], json!(image));
        assert_eq!(result["uids"], json!(current_uids(pid).unwrap()));
    }
    #[test]
    #[cfg(any(target_os = "linux", target_os = "freebsd"))]
    fn stock_procstat_pts_master_binds_live_terminal_device() {
        let mut master = -1;
        let mut slave = -1;
        check(unsafe {
            libc::openpty(
                &mut master,
                &mut slave,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
            )
        })
        .unwrap();
        let _master = unsafe { File::from_raw_fd(master) };
        let slave = unsafe { File::from_raw_fd(slave) };
        let name = unsafe { std::ffi::CStr::from_ptr(libc::ttyname(slave.as_raw_fd())) }
            .to_str()
            .unwrap();
        let stock_name = name.strip_prefix("/dev/").unwrap();
        let stdio = "PID COMM FD T V FLAGS REF OFFSET PRO NAME\n123 pi-env 0 v c rw------ 1 0 - /dev/null\n123 pi-env 1 v c rw------ 1 0 - /dev/null\n123 pi-env 2 v c rw------ 1 0 - /dev/null\n";
        let text = format!("{stdio}123 pi-env 9 t - rw------ 1 0 - {stock_name}\n");
        let records = parse_procstat(&text, 123).unwrap();
        let pts = records.last().unwrap();
        assert_eq!(pts["kind"], "pty-master");
        assert_eq!(pts["target"], name);
        assert_eq!(pts["rdev"], slave.metadata().unwrap().rdev().to_string());
        validate_private_descriptors(&records, "0").unwrap();
        assert!(
            validate_private_descriptors(&records, &slave.metadata().unwrap().rdev().to_string())
                .is_err()
        );
        for target in [
            "-",
            "/dev/null",
            "pts/../null",
            "pts/999999999",
            "/dev/tty",
            "pts/not-a-number",
        ] {
            assert!(
                parse_procstat(&text.replace(stock_name, target), 123).is_err(),
                "{target}"
            );
        }
    }
    #[test]
    fn native_fd_command_status_zero_diagnostics_and_partial_output_fail_closed() {
        for macos in [false, true] {
            for (code, stdout, stderr) in [
                (
                    0,
                    "PID COMM FD T V FLAGS REF OFFSET PRO NAME\n",
                    "Permission denied",
                ),
                (0, "PID COMM FD T V FLAGS REF OFFSET PRO NAME\n", ""),
                (0, "p999\0\nf0\0n/dev/null\0\n", ""),
                (0, "unavailable", ""),
                (1, "", ""),
            ] {
                let output = std::process::Output {
                    status: std::process::ExitStatus::from_raw(code << 8),
                    stdout: stdout.as_bytes().to_vec(),
                    stderr: stderr.as_bytes().to_vec(),
                };
                assert!(decode_descriptor_output(output, 123, macos).is_err());
            }
        }
    }
    #[test]
    fn stock_fd_formats_require_pid_numeric_stdio_types_and_complete_fields() {
        // lsof(8), OUTPUT FOR OTHER PROGRAMS: p/f/t/n/r with -F0 NUL sets.
        let lsof =
            "p123\0\nf0\0tCHR\0r0x103\0n/dev/null\0\nf1\0tPIPE\0npipe\0\nf2\0tunix\0nsocket\0\n";
        assert_eq!(parse_lsof(lsof, 123).unwrap().len(), 3);
        // lsof field selection does not synthesize n for unnamed pipes/sockets/kqueues.
        let unnamed = "p123\0\nf0\0tPIPE\0\nf1\0tunix\0\nf2\0tKQUEUE\0\n";
        let records = parse_lsof(unnamed, 123).unwrap();
        assert!(records.iter().all(|record| record["target"] == "-"));
        for bad in [
            unnamed.replace("tPIPE", "tCHR"),
            unnamed.replace("tPIPE", "tREG"),
            unnamed.replace("tPIPE", "tunknown"),
            unnamed.replace("tPIPE\0", "tPIPE\0nunavailable\0"),
        ] {
            assert!(parse_lsof(&bad, 123).is_err());
        }
        assert!(parse_lsof(lsof, 999).is_err());
        for bad in [
            "p123\0\n",
            "p123\0\nfcwd\0tDIR\0n/\0\n",
            "unavailable",
            "p999\0\nf0\0n/dev/null\0\n",
        ] {
            assert!(parse_lsof(bad, 123).is_err());
        }
        for bad in [
            lsof.replace("tCHR", "tunknown"),
            lsof.replace("r0x103\0", ""),
            lsof.replace("f2\0", "f1\0"),
            lsof.replace("n/dev/null", "n-"),
            lsof.replace("f2\0tunix\0nsocket\0\n", ""),
        ] {
            assert!(parse_lsof(&bad, 123).is_err(), "{bad:?}");
        }
        // FreeBSD usr.bin/procstat/procstat_files.c stock header and type/flag columns.
        let header = "  PID COMM FD T V FLAGS REF OFFSET PRO NAME\n";
        let procstat = format!(
            "{header}123 pi-env cwd v d r------- 1 0 - /\n123 pi-env 0 v c rw------ 1 0 - /dev/null\n123 pi-env 1 p - -w------ 1 0 - -\n123 pi-env 2 s - rw------ 1 0 UDS -\n"
        );
        assert_eq!(parse_procstat(&procstat, 123).unwrap().len(), 3);
        assert!(parse_procstat(&procstat, 999).is_err());
        for bad in [
            header.to_string(),
            format!("{header}123 pi-env cwd v d r------- 1 0 - /\n"),
            procstat.replace(" v c ", " v ? "),
            procstat.replace("/dev/null", "/unavailable"),
            procstat.replace("rw------", "invalid!"),
            procstat.replace("123 pi-env 2", "999 pi-env 2"),
        ] {
            assert!(parse_procstat(&bad, 123).is_err(), "{bad:?}");
        }
    }
    #[test]
    #[cfg(target_os = "linux")]
    fn linux_live_fd_inventory_has_device_identity_and_numeric_coverage() {
        let mut child = Command::new("sleep").arg("30").spawn().unwrap();
        let result = descriptor_inventory(child.id() as i32);
        child.kill().unwrap();
        child.wait().unwrap();
        validate_descriptors(&result.unwrap()).unwrap();
        assert!(descriptor_inventory(child.id() as i32).is_err());
    }
    #[test]
    fn darwin_native_call_adapter_composes_with_strict_teardown_policy() {
        let table = snapshot().unwrap();
        let pid = std::process::id() as i32;
        let held = Held::open(&pin(&table, pid).unwrap()).unwrap();
        let roles = BTreeMap::from([("guardian", pid)]);
        // Same adapter as proc_pidinfo; a controlled call changes actual thread errno.
        #[cfg(target_os = "linux")]
        let errno = unsafe { libc::__errno_location() };
        #[cfg(not(target_os = "linux"))]
        let errno = unsafe { libc::__error() };
        for (result, native_errno, typed) in [
            (0, libc::ESRCH, true),
            (0, 0, false),
            (0, libc::EPERM, false),
            (0, libc::EACCES, false),
            (4, libc::ESRCH, false),
        ] {
            for post_fault in [false, true] {
                unsafe { *errno = libc::ESRCH }; // stale errno must be cleared by production adapter.
                let observed = owned_exited(
                    || Ok(table.clone()),
                    std::slice::from_ref(&held),
                    &roles,
                    post_fault,
                    true,
                    |_| {
                        darwin_birth_call::<u64>(
                            |_| {
                                unsafe { *errno = native_errno };
                                result
                            },
                            errno,
                        )
                        .map(|v| v.to_string())
                    },
                );
                if typed && post_fault {
                    assert!(matches!(observed, Ok(false)));
                } else {
                    assert!(
                        observed.is_err(),
                        "result={result} errno={native_errno} post={post_fault}"
                    );
                }
            }
        }
        unsafe { *errno = libc::ESRCH };
        let stale = darwin_birth_call::<u64>(|_| 0, errno).unwrap_err();
        assert_eq!(stale.raw_os_error(), None);
        let valid = darwin_birth_call::<u64>(
            |v| {
                *v = 42;
                8
            },
            errno,
        )
        .unwrap();
        assert_eq!(valid, 42);
        for (record_pid, seconds, micros, valid) in [
            (pid as u32, 42, 1, true),
            (0, 42, 1, false),
            (pid as u32, 0, 1, false),
            (pid as u32, 42, 1_000_000, false),
        ] {
            let decoded = darwin_birth_call::<(u32, u64, u64)>(
                |v| {
                    *v = (record_pid, seconds, micros);
                    std::mem::size_of_val(v) as i32
                },
                errno,
            )
            .and_then(|(p, sec, us)| darwin_birth_record(pid, p, sec, us));
            assert_eq!(decoded.is_ok(), valid);
        }

        let mut gone = table.clone();
        gone.remove(&pid);
        assert!(
            owned_exited(
                || Ok(gone),
                &[held],
                &roles,
                true,
                true,
                |_| panic!("fresh complete absence only")
            )
            .unwrap()
        );
    }
    #[test]
    fn current_frame_requires_state_dimensions_and_exact_rendered_width() {
        let frame = format!(
            "CI_PTY_TOP_1\x1b[2KCI_PTY_LAYOUT_127x43\r\n{}\r\nCI_PTY_BOTTOM_1",
            "~".repeat(127)
        );
        assert!(frame_evidence(frame.as_bytes(), "1", 43, 127).is_some());
        assert!(frame_evidence(frame.as_bytes(), "2", 43, 127).is_none());
        assert!(frame_evidence(frame.as_bytes(), "1", 43, 120).is_none());
        assert!(
            frame_evidence(
                frame.replace(&"~".repeat(127), &"~".repeat(120)).as_bytes(),
                "1",
                43,
                127
            )
            .is_none()
        );
        assert!(
            frame_evidence(
                b"CI_PTY_TOP_1CI_PTY_LAYOUT_127x43CI_PTY_BOTTOM_1",
                "1",
                43,
                127
            )
            .is_none()
        );
    }
    #[test]
    fn role_fault_mapping_retains_originals_and_all_physical_pairs() {
        for (name, expected) in [
            ("paused-outer-death", vec!["outer"]),
            ("paused-guardian-death", vec!["guardian"]),
            ("paused-both-owners-death", vec!["outer", "guardian"]),
            ("paused-carrier-guardian-death", vec!["carrier", "guardian"]),
            ("paused-carrier-outer-death", vec!["carrier", "outer"]),
            ("paused-backup-death", vec!["backup"]),
            ("paused-carrier-backup-death", vec!["carrier", "backup"]),
            ("paused-outer-backup-death", vec!["outer", "backup"]),
        ] {
            assert_eq!(fault_roles(name).unwrap(), expected);
        }
        for name in [
            "paused-both-owners-death",
            "paused-carrier-guardian-death",
            "paused-carrier-outer-death",
        ] {
            assert_eq!(
                fault_roles(&format!("{name}-shutdown-blocked")).unwrap(),
                fault_roles(name).unwrap()
            );
        }
        assert!(fault_roles("paused-unknown-death").is_err());
    }
    #[test]
    fn pty_entry_rejects_either_root_identity_before_dispatch() {
        for mode in ["--run", "--session"] {
            for (uid, euid, allowed) in [
                (0, 0, false),
                (0, 1000, false),
                (1000, 0, false),
                (1000, 1000, true),
            ] {
                assert_eq!(
                    pty_entry_allowed(Some(mode), uid, euid),
                    allowed,
                    "{mode} {uid}/{euid}"
                );
            }
        }
    }
    #[test]
    fn other_fixture_modes_keep_existing_identity_policy() {
        for mode in [
            None,
            Some("--peer"),
            Some("--leaf"),
            Some("--extension-child"),
            Some("--adopted-grandchild"),
            Some("--adoption-spawner"),
            Some("--payload"),
            Some("--launch"),
            Some("unknown"),
        ] {
            assert!(pty_entry_allowed(mode, 0, 0), "{mode:?}");
        }
    }
    #[test]
    fn ps_columns_have_separate_empty_headers() {
        let command = ps_command();
        let mut columns = Vec::new();
        for argument in command.get_args() {
            if let Some((keyword, header)) = argument.to_str().unwrap().split_once('=') {
                assert_eq!(header, "", "nonempty ps header for {keyword}");
                columns.push(keyword);
            }
        }
        assert_eq!(columns, ["pid", "ppid", "pgid", "uid", "stat"]);
    }
    #[test]
    fn inventory_preserves_numeric_identities_and_state_modifiers() {
        let table = parse_inventory("\n 123 1 123 1001 Ts+\n 124 123 123 1001 S<+\n").unwrap();
        assert_eq!(table.len(), 2);
        assert_eq!(
            table[&123],
            json!({"pid":123,"parent":1,"group":123,"uid":1001,"state":"Ts+"})
        );
        assert_eq!(table[&124]["state"], "S<+");
    }
    #[test]
    fn inventory_rejects_malformed_rows_and_every_nonnumeric_identity() {
        for malformed in [
            ",ppid=,pgid=,uid=,stat=",
            "123",
            "123 1 123 1001",
            "123 1 123 1001 T extra",
        ] {
            assert!(parse_inventory(&format!("124 1 124 1001 S\n{malformed}\n")).is_err());
        }
        for index in 0..4 {
            for invalid in ["12x", "2147483648"] {
                let mut fields = ["123", "1", "123", "1001", "T"];
                fields[index] = invalid;
                assert!(parse_inventory(&fields.join(" ")).is_err());
            }
        }
        assert!(parse_inventory("\n").is_err());
    }
    #[test]
    fn ancestry_is_transitive_and_excludes_same_group_peer() {
        let table = BTreeMap::from([
            (10, json!({"parent":1,"group":10})),
            (11, json!({"parent":10,"group":11})),
            (12, json!({"parent":11,"group":11})),
            (13, json!({"parent":1,"group":10})),
        ]);
        assert_eq!(descendants(&table, 10), BTreeSet::from([10, 11, 12]));
    }
    #[test]
    fn stopped_and_missing_are_not_runnable_or_dead_proof() {
        let table = BTreeMap::from([(10, json!({"state":"T"}))]);
        assert!(!runnable(&table, &json!({"pid":10})).unwrap());
        assert!(stopped(&table, &json!({"pid":11})).is_err());
    }
    #[test]
    fn exact_direct_children_distinguish_anchor_from_guardian_descendants() {
        let table = BTreeMap::from([
            (10, json!({"parent":1})),
            (11, json!({"parent":10})),
            (12, json!({"parent":11})),
            (13, json!({"parent":12})),
        ]);
        assert_eq!(children_of(&table, 10), vec![11]);
        assert_eq!(children_of(&table, 11), vec![12]);
        assert_ne!(children_of(&table, 10), vec![12]);
    }
    #[test]
    #[cfg(any(target_os = "linux", target_os = "freebsd"))]
    fn normal_teardown_waits_for_child_status_after_zombie_inventory() {
        for code in [0, 17] {
            let mut child = Command::new("sh")
                .args(["-c", &format!("read gate; exit {code}")])
                .stdin(Stdio::piped())
                .spawn()
                .unwrap();
            let pid = child.id() as i32;
            let table = snapshot().unwrap();
            let held = Held::open(&pin(&table, pid).unwrap()).unwrap();
            let observed_exit = child.try_wait().unwrap();
            assert!(observed_exit.is_none());
            child.stdin.take().unwrap().write_all(b"exit\n").unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            let zombie = loop {
                let table = snapshot().unwrap();
                if table
                    .get(&pid)
                    .and_then(|p| p["state"].as_str())
                    .is_some_and(|s| s.starts_with('Z'))
                {
                    break table;
                }
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    panic!("held child did not become a zombie");
                }
                sleep(Duration::from_millis(5));
            };
            let roles = BTreeMap::from([("outer", pid)]);
            let pending = owned_exited(
                || Ok(zombie),
                std::slice::from_ref(&held),
                &roles,
                false,
                observed_exit.is_some(),
                query_birth,
            );
            let status = child.wait().unwrap();
            assert!(
                !pending.unwrap(),
                "a zombie sample cannot replace the missing Child status"
            );
            assert_eq!(status.code(), Some(code));
            let fresh = snapshot().unwrap();
            assert!(!fresh.contains_key(&pid));
            assert!(
                owned_exited(
                    || Ok(fresh),
                    &[held],
                    &roles,
                    false,
                    true,
                    |_| panic!("complete absence needs no birth query")
                )
                .unwrap()
            );
            let exit = json!({"code":status.code(),"signal":status.signal()});
            assert_eq!(
                exit["code"] == 0 && exit["signal"].is_null(),
                code == 0,
                "nonzero actual exit must still fail the unchanged clean-exit assertion"
            );
        }
    }
    #[test]
    fn normal_completion_requires_status_without_changing_fault_or_inventory_policy() {
        let mut table = snapshot().unwrap();
        let pid = std::process::id() as i32;
        let held = Held::open(&pin(&table, pid).unwrap()).unwrap();
        table.remove(&pid);
        let roles = BTreeMap::from([("outer", pid)]);
        for post_fault in [false, true] {
            for status_observed in [false, true] {
                assert_eq!(
                    owned_exited(
                        || Ok(table.clone()),
                        std::slice::from_ref(&held),
                        &roles,
                        post_fault,
                        status_observed,
                        |_| panic!("complete absence needs no birth query")
                    )
                    .unwrap(),
                    post_fault || status_observed
                );
            }
        }
        assert!(
            owned_exited(
                || Err("inventory failure".into()),
                &[held],
                &roles,
                false,
                false,
                |_| panic!("inventory errors must not become pending")
            )
            .unwrap_err()
            .contains("inventory failure")
        );
    }
    #[test]
    fn normal_completion_missing_status_keeps_original_eight_second_deadline() {
        let mut table = snapshot().unwrap();
        let pid = std::process::id() as i32;
        let held = Held::open(&pin(&table, pid).unwrap()).unwrap();
        table.remove(&pid);
        let roles = BTreeMap::from([("outer", pid)]);
        let mut master = File::open("/dev/null").unwrap();
        let start = Instant::now();
        let deadline = start + Duration::from_secs(8);
        let mut polls = 0;
        let failure = wait_for(
            || {
                assert!(Instant::now() < deadline + Duration::from_secs(2));
                polls += 1;
                owned_exited(
                    || Ok(table.clone()),
                    std::slice::from_ref(&held),
                    &roles,
                    false,
                    false,
                    |_| panic!("complete absence needs no birth query"),
                )
            },
            deadline,
            &mut master,
            &mut Vec::new(),
            "normal status was not observed",
        )
        .unwrap_err();
        assert_eq!(failure, "normal status was not observed");
        assert!(polls > 1);
        assert!(
            start.elapsed() >= Duration::from_secs(8) && start.elapsed() < Duration::from_secs(10)
        );
    }
    #[test]
    fn teardown_disappearing_birth_is_pending_until_fresh_complete_absence() {
        let mut child = Command::new("sleep").arg("30").spawn().unwrap();
        let pid = child.id() as i32;
        let sampled = snapshot().and_then(|table| {
            let held = Held::open(&pin(&table, pid)?)?;
            Ok((table, held))
        });
        child.kill().unwrap();
        child.wait().unwrap();
        let (table, held) = sampled.unwrap();
        let roles = BTreeMap::from([("guardian", pid)]);
        assert!(
            birth(pid).is_err(),
            "strict pre-fault birth facade must still fail"
        );
        let pending = owned_exited(
            || Ok(table),
            std::slice::from_ref(&held),
            &roles,
            true,
            true,
            query_birth,
        );
        assert!(matches!(pending, Ok(false)), "{pending:?}");
        let fresh = snapshot().unwrap();
        assert!(!fresh.contains_key(&pid));
        assert!(
            owned_exited(
                || Ok(fresh),
                &[held],
                &roles,
                true,
                true,
                |_| panic!("absence must come from complete inventory, not another birth error"),
            )
            .unwrap()
        );
    }
    #[test]
    fn teardown_only_native_disappearance_after_fault_is_pending() {
        let table = snapshot().unwrap();
        let held = Held::open(&pin(&table, std::process::id() as i32).unwrap()).unwrap();
        let roles = BTreeMap::from([("guardian", number(&held.identity, "pid").unwrap())]);
        let mut gone = vec![libc::ESRCH];
        if cfg!(target_os = "linux") {
            gone.push(libc::ENOENT);
        }
        for errno in gone {
            for post_fault in [false, true] {
                let mut queries = 0;
                let result = owned_exited(
                    || Ok(table.clone()),
                    std::slice::from_ref(&held),
                    &roles,
                    post_fault,
                    true,
                    |_| {
                        queries += 1;
                        Err(io::Error::from_raw_os_error(errno))
                    },
                );
                assert_eq!(queries, 1, "retry needs a new complete inventory");
                if post_fault {
                    assert!(matches!(result, Ok(false)), "{result:?}");
                } else {
                    assert!(
                        result.is_err(),
                        "normal exit must not gain retry permission"
                    );
                }
            }
        }
        let mut fatal = vec![libc::EACCES, libc::EPERM, libc::EINVAL, libc::EIO];
        if !cfg!(target_os = "linux") {
            fatal.push(libc::ENOENT);
        }
        for error in fatal.into_iter().map(io::Error::from_raw_os_error).chain([
            io::Error::new(io::ErrorKind::InvalidData, "invalid native birth record"),
            io::Error::new(io::ErrorKind::NotFound, "No such process (os error 3)"),
        ]) {
            let message = error.to_string();
            let mut error = Some(error);
            let failure = owned_exited(
                || Ok(table.clone()),
                std::slice::from_ref(&held),
                &roles,
                true,
                true,
                |_| Err(error.take().unwrap()),
            )
            .unwrap_err();
            assert!(failure.contains(&message), "{failure}");
            assert!(
                failure.contains("owned teardown birth role=guardian"),
                "{failure}"
            );
            assert!(
                failure.contains(&format!("pinned={}", held.identity)),
                "{failure}"
            );
        }
    }
    #[test]
    fn teardown_preserves_stopped_zombie_and_reused_identity_policy() {
        let table = snapshot().unwrap();
        let pid = std::process::id() as i32;
        let held = Held::open(&pin(&table, pid).unwrap()).unwrap();
        let cases = [
            ("S", false),
            ("T", false),
            ("Ts+", false),
            ("Z", false),
            ("Z+", false),
            ("S", true),
            ("T", true),
        ];
        for (role, expected) in [
            ("outer", [false; 7]),
            ("guardian", [false; 7]),
            ("pi", [false; 7]),
            ("taskOuter", [false, false, false, true, true, true, true]),
            (
                "taskGuardian",
                [false, false, false, true, true, true, true],
            ),
            ("payload", [false, false, false, true, true, true, true]),
            ("leaf", [false, false, false, true, true, true, true]),
            ("carrier", [false; 7]),
            ("backup", [false; 7]),
            ("observer", [false; 7]),
            ("anchor", [false; 7]),
            ("extensionChild", [false; 7]),
            ("adoptedGrandchild", [false; 7]),
        ] {
            let roles = BTreeMap::from([(role, pid)]);
            for ((state, reused), done) in cases.into_iter().zip(expected) {
                let mut observed = table.clone();
                observed.get_mut(&pid).unwrap()["state"] = json!(state);
                let birth = if reused {
                    "other-birth"
                } else {
                    held.identity["birth"].as_str().unwrap()
                };
                let pending_table = observed.clone();
                assert_eq!(
                    owned_exited(
                        || Ok(observed),
                        std::slice::from_ref(&held),
                        &roles,
                        true,
                        true,
                        |_| Ok(birth.to_string()),
                    )
                    .unwrap(),
                    done,
                    "role={role} state={state} reused={reused}"
                );
                assert!(
                    !owned_exited(
                        || Ok(pending_table),
                        std::slice::from_ref(&held),
                        &roles,
                        true,
                        true,
                        |_| Err(io::Error::from_raw_os_error(libc::ESRCH)),
                    )
                    .unwrap(),
                    "disappearance never grants {role} completion"
                );
            }
        }
    }
    #[test]
    fn teardown_failed_or_malformed_inventory_never_credits_absence() {
        let table = snapshot().unwrap();
        let held = Held::open(&pin(&table, std::process::id() as i32).unwrap()).unwrap();
        let roles = BTreeMap::from([("guardian", number(&held.identity, "pid").unwrap())]);
        for inventory in [
            Err("ps inventory failed".to_string()),
            parse_inventory("1 2 malformed inventory"),
            parse_inventory(""),
        ] {
            let failure = owned_exited(
                || inventory,
                std::slice::from_ref(&held),
                &roles,
                true,
                true,
                |_| panic!("failed inventory cannot reach birth query or prove absence"),
            )
            .unwrap_err();
            assert!(
                failure.starts_with("owned teardown ps inventory:"),
                "{failure}"
            );
        }
    }
    #[test]
    fn teardown_repeated_inconclusive_polls_keep_original_eight_second_deadline() {
        let table = snapshot().unwrap();
        let held = Held::open(&pin(&table, std::process::id() as i32).unwrap()).unwrap();
        let roles = BTreeMap::from([("guardian", number(&held.identity, "pid").unwrap())]);
        let mut master = File::open("/dev/null").unwrap();
        let start = Instant::now();
        let deadline = start + Duration::from_secs(8);
        let mut polls = 0;
        let message = "owned teardown exceeded 8s (stopped processes count as alive)";
        let failure = wait_for(
            || {
                assert!(
                    Instant::now() < deadline + Duration::from_secs(2),
                    "pending polls escaped original deadline"
                );
                polls += 1;
                owned_exited(
                    || Ok(table.clone()),
                    std::slice::from_ref(&held),
                    &roles,
                    true,
                    true,
                    |_| Err(io::Error::from_raw_os_error(libc::ESRCH)),
                )
            },
            deadline,
            &mut master,
            &mut Vec::new(),
            message,
        )
        .unwrap_err();
        assert_eq!(failure, message);
        assert!(polls > 1);
        assert!(start.elapsed() >= Duration::from_secs(8));
        assert!(start.elapsed() < Duration::from_secs(10));
    }
    #[test]
    fn wait_condition_error_retains_stage_and_native_failure() {
        let mut master = File::open("/dev/null").unwrap();
        let native_error = std::io::Error::from_raw_os_error(libc::ESRCH).to_string();
        let error = wait_for(
            || Err(native_error.clone()),
            Instant::now() + Duration::from_secs(1),
            &mut master,
            &mut Vec::new(),
            "owned teardown exceeded 8s (stopped processes count as alive)",
        )
        .unwrap_err();
        assert!(error.contains(&native_error), "{error}");
        assert!(
            error.starts_with("wait condition (owned teardown"),
            "{error}"
        );
    }
    #[test]
    fn held_target_rejects_wrong_birth_before_signaling() {
        let table = snapshot().unwrap();
        let mut identity = pin(&table, std::process::id() as i32).unwrap();
        assert_eq!(identity["sid"], unsafe { libc::getsid(0) });
        identity["birth"] = json!("not-this-process");
        assert!(Held::open(&identity).is_err());
    }
}
