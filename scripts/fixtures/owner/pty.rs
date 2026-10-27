// CI-only release-artifact job-control probe. openpty/setsid follows pi-env's pty.rs;
// its private PTY API cannot expose termios or a shell-side sibling in the job group.
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt};
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
#[cfg(any(target_os = "macos", test))]
#[allow(dead_code)]
#[path = "../../../packages/env/daemon/src/darwin_record.rs"]
mod darwin_record;

#[cfg(any(target_os = "macos", test))]
fn darwin_birth_with_fallback(
    pid: i32,
    birth: io::Result<String>,
    bsd: impl FnOnce(&mut darwin_record::Record) -> i32,
) -> io::Result<String> {
    if !birth.as_ref().is_err_and(|error| error.raw_os_error() == Some(libc::ESRCH)) {
        return birth;
    }
    let mut record = darwin_record::Record::default();
    let result = bsd(&mut record);
    eprintln!("[owner-pty] darwin-birth-fallback pid={pid} sysctl={result} record_pid={} state={} birth={}:{}", record.pbi_pid, record.pbi_status, record.pbi_start_tvsec, record.pbi_start_tvusec);
    match darwin_record::bsd_query(result)? {
        darwin_record::Query::Complete => {
            let record = record.checked(pid)?;
            darwin_birth_record(pid, record.pbi_pid, record.pbi_start_tvsec, record.pbi_start_tvusec)
        }
        darwin_record::Query::Absent => Err(io::Error::from_raw_os_error(libc::ESRCH)),
        darwin_record::Query::Bsd => unreachable!(),
    }
}

#[cfg(target_os = "macos")]
fn query_birth(pid: i32) -> io::Result<String> {
    unsafe extern "C" {
        fn pi_env_darwin_record(pid: i32, output: *mut darwin_record::Record) -> i32;
    }
    let birth = darwin_birth_call(
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
    )
    .and_then(|info| darwin_birth_record(
        pid,
        info.pbi_pid,
        info.pbi_start_tvsec,
        info.pbi_start_tvusec,
    ));
    darwin_birth_with_fallback(pid, birth, |record| unsafe { pi_env_darwin_record(pid, record) })
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
#[cfg(any(target_os = "freebsd", test))]
fn freebsd_birth_call<T>(
    mut info: T,
    call: impl FnOnce(&mut T) -> io::Result<usize>,
) -> io::Result<T> {
    if call(&mut info)? != std::mem::size_of_val(&info) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "sysctl birth unavailable",
        ));
    }
    Ok(info)
}
#[cfg(target_os = "freebsd")]
fn freebsd_process_record(pid: i32) -> io::Result<(i32, String)> {
    let mut mib = [libc::CTL_KERN, libc::KERN_PROC, libc::KERN_PROC_PID, pid];
    let info: libc::kinfo_proc = unsafe { std::mem::zeroed() };
    let info = freebsd_birth_call(info, |info| {
        let mut size = std::mem::size_of_val(info);
        if unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                4,
                (info as *mut libc::kinfo_proc).cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        } < 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(size)
    })?;
    Ok((
        info.ki_pid,
        format!("{}:{}", info.ki_start.tv_sec, info.ki_start.tv_usec),
    ))
}
#[cfg(target_os = "freebsd")]
fn query_birth(pid: i32) -> io::Result<String> {
    freebsd_process_record(pid).map(|(_, birth)| birth)
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
            // procps can print a dead process's (pid_t)-1 PGID as unsigned.
            let value = if i == 2 && f[i].parse::<u32>() == Ok(u32::MAX) {
                Ok(-1)
            } else {
                f[i].parse::<i32>()
            };
            value.map_err(|e| format!("ps inventory column={i} line={line:?}: {e}"))
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

fn canonical_owner(pi: &mut Value) -> Result<()> {
    let owner = pi["owner"].as_str().ok_or("owner path missing")?;
    pi["owner"] = json!(fs::canonicalize(owner).map_err(|e| e.to_string())?);
    Ok(())
}

fn native_owner_matches(image: &Path, expected: &Path) -> Result<bool> {
    Ok(image == fs::canonicalize(expected).map_err(|e| e.to_string())?)
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
#[cfg(any(not(target_os = "linux"), test))]
fn lsof_command(pid: i32) -> Command {
    let mut command = Command::new("/usr/sbin/lsof");
    // lsof 4.91 has numeric ranges, not the newer "fd" selector for all numbered FDs.
    command.args([
        "-nP", "-a", "-p", &pid.to_string(), "-d",
        &format!("0-{}", libc::c_int::MAX), "-F0pftnr",
    ]);
    command
}
#[cfg(not(target_os = "linux"))]
fn descriptor_inventory(pid: i32) -> Result<Vec<Value>> {
    let mut command = if cfg!(target_os = "macos") {
        lsof_command(pid)
    } else {
        let mut command = Command::new("procstat");
        command.args(["-f", &pid.to_string()]);
        command
    };
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
        #[cfg(target_os = "macos")]
        authorize_birth_fault(
            &self.identity,
            signal,
            |pid| query_birth(pid).map(|birth| (pid, birth)),
            |pid, signal| check(unsafe { libc::kill(pid, signal) }).map(|_| ()),
        )?;
        #[cfg(target_os = "freebsd")]
        {
            require(same(&self.identity)?, "held target identity lost")?;
            check(unsafe { libc::kill(number(&self.identity, "pid")?, signal) })?;
        }
        Ok(())
    }
}
#[cfg(any(target_os = "freebsd", target_os = "macos", test))]
fn authorize_birth_fault(
    identity: &Value,
    signal: i32,
    query: impl FnOnce(i32) -> io::Result<(i32, String)>,
    send: impl FnOnce(i32, i32) -> Result<()>,
) -> Result<()> {
    let pid = number(identity, "pid")?;
    let pinned_birth = identity["birth"]
        .as_str()
        .filter(|birth| !birth.is_empty())
        .ok_or("missing birth")?;
    let (record_pid, birth) = query(pid).map_err(|error| error.to_string())?;
    require(
        record_pid == pid && birth == pinned_birth,
        "fault target identity changed",
    )?;
    send(pid, signal)
}

type CleanupObserver<'a> = dyn FnMut(&str, &'static str, &'static str) + 'a;

fn owned_exited(
    inventory: impl FnOnce() -> Result<BTreeMap<i32, Value>>,
    owned: &[Held],
    roles: &BTreeMap<&str, i32>,
    post_fault: bool,
    outer_exit_observed: bool,
    mut sample_birth: impl FnMut(i32) -> io::Result<String>,
    mut observed: Option<&mut CleanupObserver<'_>>,
) -> Result<bool> {
    let mut record = |role: &str, reason: &'static str, error: &'static str| {
        if let Some(observe) = observed.as_mut() {
            observe(role, reason, error);
        }
    };
    let table = inventory().map_err(|error| format!("owned teardown ps inventory: {error}"))?;
    for held in owned
        .iter()
        .filter(|h| roles.values().any(|pid| h.identity["pid"] == *pid))
    {
        let pid = number(&held.identity, "pid")?;
        let role = roles.iter().find(|(_, p)| **p == pid).unwrap().0;
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
                    record(role, "disappearing-birth", cleanup_errno(&error));
                    return Ok(false);
                }
                Err(error) => {
                    record(role, "query-error", cleanup_errno(&error));
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
                record(role, "same-birth-non-z", "-");
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
                record(role, "critical-presence", "-");
                return Ok(false);
            }
        }
    }
    // A terminal process sample is not the outer child's wait status.
    let complete = post_fault || outer_exit_observed;
    record(
        if complete { "all" } else { "carrier" },
        if complete {
            "eligible-absence"
        } else {
            "child-pending"
        },
        "-",
    );
    Ok(complete)
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
fn wait_session(child: &mut Child, master: &mut File, result: &Path) -> Result<std::process::ExitStatus> {
    let mut tail = Vec::new();
    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            return Ok(status);
        }
        // Publication hands off reading: session evidence is final and no session reads remain.
        if result.try_exists().map_err(|e| e.to_string())? {
            drain(master, &mut tail)?;
            // Wake on the next output burst instead of throttling a blocked writer by 25ms.
            let mut ready = libc::pollfd {
                fd: master.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            if unsafe { libc::poll(&mut ready, 1, 25) } < 0 {
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::Interrupted {
                    return Err(error.to_string());
                }
            }
        } else {
            sleep(Duration::from_millis(25));
        }
    }
}
fn wait_for(
    condition: impl FnMut() -> Result<bool>,
    deadline: Instant,
    master: &mut File,
    output: &mut Vec<u8>,
    message: &str,
) -> Result<()> {
    wait_for_clock(condition, deadline, master, output, message, Instant::now)
}
fn wait_for_clock(
    mut condition: impl FnMut() -> Result<bool>,
    deadline: Instant,
    master: &mut File,
    output: &mut Vec<u8>,
    message: &str,
    mut now: impl FnMut() -> Instant,
) -> Result<()> {
    loop {
        drain(master, output)
            .map_err(|error| format!("PTY read while waiting ({message}): {error}"))?;
        require(now() < deadline, message)?;
        let complete =
            condition().map_err(|error| format!("wait condition ({message}): {error}"))?;
        require(now() < deadline, message)?;
        if complete {
            return Ok(());
        }
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

struct AdoptionReadiness<'a> {
    table: BTreeMap<i32, Value>,
    processes: BTreeMap<&'a str, Value>,
    adopted: Value,
}

fn adoption_candidate<'a>(
    table: BTreeMap<i32, Value>,
    previous: &BTreeMap<&'a str, Value>,
    roles: &BTreeMap<&'a str, i32>,
    spawner_pid: i32,
    os: &str,
    mut sample: impl FnMut(&BTreeMap<i32, Value>, i32) -> Result<Value>,
) -> Result<Option<AdoptionReadiness<'a>>> {
    let role_pid = |role| roles.get(role).copied().ok_or("readiness role missing");
    let carrier = role_pid("carrier")?;
    let outer = role_pid("outer")?;
    let guardian = role_pid("guardian")?;
    let grandchild = role_pid("adoptedGrandchild")?;
    let remaining = roles
        .values()
        .copied()
        .filter(|pid| os != "macos" || *pid != grandchild)
        .collect();
    require(
        !table.contains_key(&spawner_pid) && descendants(&table, carrier) == remaining,
        "owned inventory changed before final pause",
    )?;
    let adopted = sample(&table, grandchild)?;
    require(
        adopted["birth"]
            == previous
                .get("adoptedGrandchild")
                .ok_or("readiness identity missing")?["birth"],
        "adopted grandchild birth changed",
    )?;
    let mut processes = BTreeMap::new();
    for (&role, &pid) in roles {
        let expected = previous.get(role).ok_or("readiness identity missing")?;
        let current = sample(&table, pid)?;
        require(
            current["pid"] == pid
                && ["pid", "birth", "uid", "group", "sid"]
                    .iter()
                    .all(|key| current[key] == expected[key])
                && (role == "adoptedGrandchild" || current["parent"] == expected["parent"])
                && table.get(&pid).is_some_and(|raw| {
                    ["pid", "parent", "group", "uid", "state"]
                        .iter()
                        .all(|key| raw[key] == current[key])
                }),
            "owned identity changed before final pause",
        )?;
        processes.insert(role, current);
    }
    let adopted = processes["adoptedGrandchild"].clone();
    require(
        if os == "macos" {
            adopted["parent"] == 1
        } else {
            [role_pid("anchor")?, guardian]
                .iter()
                .any(|pid| adopted["parent"] == *pid)
        },
        "grandchild not adopted by pinned session reaper",
    )?;
    require(
        children_of(&table, carrier) == [outer],
        "carrier topology changed before final pause",
    )?;
    if os != "macos" {
        let anchor = role_pid("anchor")?;
        let mut expected = vec![guardian, role_pid("backup")?];
        if adopted["parent"] == anchor {
            expected.push(grandchild);
        }
        expected.sort_unstable();
        require(
            children_of(&table, outer) == [anchor] && children_of(&table, anchor) == expected,
            "session reaper topology changed before final pause",
        )?;
        let anchor_state = state(&table, &processes["anchor"])?;
        if !matches!(anchor_state.chars().next(), Some('R' | 'S')) {
            require(
                os == "freebsd" && matches!(anchor_state, "D" | "Ds"),
                "private anchor/session/group invalid",
            )?;
            return Ok(None);
        }
    }
    Ok(Some(AdoptionReadiness {
        table,
        processes,
        adopted,
    }))
}

fn acquire_adoption_readiness<'a>(
    mut candidate: impl FnMut() -> Result<Option<AdoptionReadiness<'a>>>,
    deadline: Instant,
    master: &mut File,
    output: &mut Vec<u8>,
    now: impl FnMut() -> Instant,
) -> Result<AdoptionReadiness<'a>> {
    let mut accepted = None;
    wait_for_clock(
        || {
            accepted = candidate()?;
            Ok(accepted.is_some())
        },
        deadline,
        master,
        output,
        "final adoption readiness exceeded setup deadline",
        now,
    )?;
    accepted.ok_or("final adoption readiness missing".into())
}

fn session(
    args: &[String],
    master: &mut File,
    row: &mut Value,
    owned: &mut Vec<Held>,
    children: &mut Vec<Child>,
    output: &mut Vec<u8>,
    cleanup: &mut CleanupWitness,
    progress: &mut SessionWitness,
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
    progress.record(2, "b");
    let initial = snapshot()?;
    owned.push(Held::open(&pin(&initial, carrier_pid)?)?);
    owned.push(Held::open(&pin(&initial, peer_pid)?)?);
    // The gate removes foreground-startup races without pre-parking Pi or faking Ctrl-Z.
    foreground(carrier_pid)?;
    fs::write(work.join("launch"), "go").map_err(|e| e.to_string())?;
    progress.record(3, "b");
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
    progress.record(4, "b");
    row["pi"] = load(&work.join("ready"))?;
    canonical_owner(&mut row["pi"])?;
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
            native_owner_matches(
                &native_path(anchor)?,
                Path::new(row["pi"]["owner"].as_str().ok_or("owner path missing")?),
            )?,
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
            native_owner_matches(
                &native_path(observer)?,
                Path::new(row["pi"]["owner"].as_str().ok_or("owner path missing")?),
            )?,
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
        progress.record(5, "b");
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
    progress.record(6, "b");
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
    // The existing pinned exit and complete absence prove that the helper writer is gone.
    *cleanup = CleanupWitness::handoff(&work, name);
    let ready = acquire_adoption_readiness(
        || {
            adoption_candidate(
                snapshot()?,
                &processes,
                &roles,
                spawner_pid,
                std::env::consts::OS,
                pin,
            )
        },
        deadline,
        master,
        output,
        Instant::now,
    )?;
    let adopted_table = ready.table;
    let adopted = ready.adopted;
    processes = ready.processes;
    row["adoption"]["spawnerExit"] = spawner_exit;
    row["adoption"]["spawnerReaped"] = json!(true);
    row["adoption"]["spawnerState"] = json!("gone");
    row["adoption"]["postExitParent"] = adopted["parent"].clone();
    row["processes"] = json!(processes);
    row["sessionChildren"] = json!({"carrier":children_of(&adopted_table,carrier_pid),"outer":children_of(&adopted_table,outer_pid)});
    #[cfg(target_os = "macos")]
    {
        row["sessionChildren"]["guardian"] = json!(children_of(&adopted_table, guardian_pid));
    }
    #[cfg(not(target_os = "macos"))]
    {
        row["sessionChildren"]["anchor"] = json!(children_of(&adopted_table, roles["anchor"]));
    }
    progress.record(7, "b");
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
    cleanup.origin = Some(death_start);
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
            cleanup
                .observe(CleanupOperation::Fault, Instant::now, || {
                    #[cfg(target_os = "freebsd")]
                    {
                        authorize_birth_fault(
                            &held.identity,
                            libc::SIGKILL,
                            freebsd_process_record,
                            |pid, signal| check(unsafe { libc::kill(pid, signal) }).map(|_| ()),
                        )
                    }
                    #[cfg(not(target_os = "freebsd"))]
                    held.signal_pinned(libc::SIGKILL)
                })
                .map_err(|error| {
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
    let end = death_start + Duration::from_secs(8);
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
            cleanup.predicate(
                snapshot,
                owned,
                &roles,
                !faults.is_empty(),
                row.get("exit").is_some(),
                query_birth,
                Instant::now,
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

const HELPER_WITNESS_FILE: &str = "helper-witness";
const HELPER_OPERATIONS: [&str; 4] = ["grandchild-spawn", "snapshot", "pin", "publish"];
const HELPER_WITNESS_CAP: u64 = 16384;

fn helper_witness_case(name: &str) -> bool {
    name == "suspend-resume"
        || fault_roles(name).is_ok()
            && (!name.ends_with("-shutdown-blocked")
                || matches!(
                    name,
                    "paused-both-owners-death-shutdown-blocked"
                        | "paused-carrier-guardian-death-shutdown-blocked"
                        | "paused-carrier-outer-death-shutdown-blocked"
                ))
}

fn helper_witness_file(work: &Path, create: bool) -> io::Result<File> {
    let unsafe_file = || io::Error::other("unsafe helper witness");
    let directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(work)?;
    let dir = directory.metadata()?;
    let path_dir = fs::symlink_metadata(work)?;
    if directory.as_raw_fd() <= 2
        || !dir.is_dir()
        || dir.uid() != unsafe { libc::getuid() }
        || dir.mode() & 0o022 != 0
        || dir.dev() != path_dir.dev()
        || dir.ino() != path_dir.ino()
        || !path_dir.is_dir()
    {
        return Err(unsafe_file());
    }
    let flags = libc::O_RDWR
        | libc::O_APPEND
        | libc::O_NOFOLLOW
        | libc::O_CLOEXEC
        | libc::O_NONBLOCK
        | if create {
            libc::O_CREAT | libc::O_EXCL
        } else {
            0
        };
    let raw = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            c"helper-witness".as_ptr(),
            flags,
            0o600,
        )
    };
    if raw < 0 {
        return Err(io::Error::last_os_error());
    }
    let file = unsafe { File::from_raw_fd(raw) };
    let meta = file.metadata()?;
    let path = fs::symlink_metadata(work.join(HELPER_WITNESS_FILE))?;
    let after_dir = fs::symlink_metadata(work)?;
    if raw <= 2
        || !meta.is_file()
        || meta.uid() != unsafe { libc::getuid() }
        || meta.mode() & 0o7777 != 0o600
        || meta.nlink() != 1
        || meta.len() > HELPER_WITNESS_CAP
        || !path.is_file()
        || meta.dev() != path.dev()
        || meta.ino() != path.ino()
        || !after_dir.is_dir()
        || dir.dev() != after_dir.dev()
        || dir.ino() != after_dir.ino()
    {
        return Err(unsafe_file());
    }
    Ok(file)
}

fn initialize_helper_witness(
    work: &Path,
    name: &str,
    uid: libc::uid_t,
    euid: libc::uid_t,
) -> io::Result<()> {
    if !pty_entry_allowed(Some("--run"), uid, euid) || !helper_witness_case(name) {
        return Err(io::Error::other("helper witness setup rejected"));
    }
    let mut file = helper_witness_file(work, true)?;
    let header = format!("owner-helper-v1 {name}\n");
    if header.len() > 96 {
        return Err(io::Error::other("helper witness header too large"));
    }
    file.write_all(header.as_bytes())
}

fn session_stage(previous: usize, next: usize) -> bool {
    match next {
        1..=5 => previous + 1 == next,
        6 => previous == 4 || previous == 5,
        7 => previous == 6,
        8 => (1..=7).contains(&previous),
        9..=11 => previous + 1 == next,
        _ => false,
    }
}

fn session_helper_bytes(bytes: &[u8]) -> io::Result<Vec<u8>> {
    let text = std::str::from_utf8(bytes).map_err(io::Error::other)?;
    if !text.ends_with('\n') {
        return Err(io::Error::other("partial session witness"));
    }
    let mut result = Vec::new();
    let (mut sequence, mut stage, mut previous, mut last_ok) = (0usize, 0usize, 0u64, false);
    for line in text.split_inclusive('\n') {
        if !line.starts_with("session-v1 ") {
            result.extend_from_slice(line.as_bytes());
            continue;
        }
        let fields: Vec<_> = line.trim_end_matches('\n').split(' ').collect();
        if fields.len() != 5 {
            return Err(io::Error::other("invalid session witness"));
        }
        let seq = fields[1].parse::<usize>().map_err(io::Error::other)?;
        let next = fields[2].parse::<usize>().map_err(io::Error::other)?;
        let at = fields[3].parse::<u64>().map_err(io::Error::other)?;
        let flag = fields[4];
        if seq != sequence + 1
            || seq > 11
            || fields[1] != seq.to_string()
            || fields[2] != next.to_string()
            || fields[3] != at.to_string()
            || at < previous
            || !session_stage(stage, next)
            || next > 11
            || (seq == 1 && next != 1)
            || (next < 8 && flag != "b")
            || ((next == 8 || next == 9) && !["o", "e"].contains(&flag))
            || (next == 9 && stage != 8)
            || (next == 10 && (stage != 9 || !last_ok || flag != "b"))
            || (next == 11 && (stage != 10 || flag != "o"))
        {
            return Err(io::Error::other("invalid session order"));
        }
        (sequence, stage, previous, last_ok) = (seq, next, at, flag == "o");
    }
    Ok(result)
}

// One session writer, at most eleven <=64-byte atomic appends. No FD crosses a call.
// IDs: entry, initial inventory, readiness, identity, Darwin observation, adoption,
// controller FD/TTY, session return, publication return, final cleanup, completion.
struct SessionWitness {
    work: PathBuf,
    identity: Option<(u64, u64)>,
    origin: Instant,
    sequence: usize,
    stage: usize,
    elapsed: u128,
    last_ok: bool,
}
impl SessionWitness {
    fn open(work: &Path, name: &str) -> Self {
        Self {
            work: work.to_owned(),
            identity: HelperWitness::open(work, name).identity,
            origin: Instant::now(),
            sequence: 0,
            stage: 0,
            elapsed: 0,
            last_ok: false,
        }
    }
    fn record(&mut self, stage: usize, flag: &str) {
        self.record_at(stage, flag, self.origin.elapsed().as_nanos());
    }
    fn returned<T>(&mut self, stage: usize, result: Result<T>) -> Result<T> {
        self.record(stage, if result.is_ok() { "o" } else { "e" });
        result
    }
    fn record_at(&mut self, stage: usize, flag: &str, at: u128) {
        let Some(identity) = self.identity else {
            return;
        };
        if at > u64::MAX as u128
            || at < self.elapsed
            || self.sequence >= 11
            || !session_stage(self.stage, stage)
            || stage > 11
            || (self.sequence == 0 && stage != 1)
            || (stage < 8 && flag != "b")
            || ([8, 9].contains(&stage) && !["o", "e"].contains(&flag))
            || (stage == 9 && self.stage != 8)
            || (stage == 10 && (self.stage != 9 || !self.last_ok || flag != "b"))
            || (stage == 11 && (self.stage != 10 || flag != "o"))
        {
            self.identity = None;
            return;
        }
        let record = format!("session-v1 {} {stage} {at} {flag}\n", self.sequence + 1);
        if record.len() > 64 {
            self.identity = None;
            return;
        }
        let written = (|| -> io::Result<()> {
            let mut file = helper_witness_file(&self.work, false)?;
            let before = file.metadata()?;
            if (before.dev(), before.ino()) != identity
                || before.len() + record.len() as u64 > HELPER_WITNESS_CAP
            {
                return Err(io::Error::other("session witness changed"));
            }
            // O_APPEND plus a single write prevents interleaving with helper records.
            if file.write(record.as_bytes())? != record.len() {
                return Err(io::Error::other("partial session append"));
            }
            let after = file.metadata()?;
            if after.len() < before.len() + record.len() as u64 || after.len() > HELPER_WITNESS_CAP
            {
                return Err(io::Error::other("session append changed"));
            }
            Ok(())
        })();
        if written.is_err() {
            self.identity = None;
            return;
        }
        self.sequence += 1;
        self.stage = stage;
        self.elapsed = at;
        self.last_ok = flag == "o";
    }
}

// One helper, four operations, at most eight <=192-byte records plus <=96-byte header (<16KiB).
// No FD survives these calls; partial/failed I/O disables all subsequent diagnostic writes.
struct HelperWitness {
    work: PathBuf,
    identity: Option<(u64, u64)>,
    len: u64,
    seq: usize,
    start: Instant,
}
impl HelperWitness {
    fn open(work: &Path, name: &str) -> Self {
        let mut result = Self {
            work: work.to_owned(),
            identity: None,
            len: 0,
            seq: 0,
            start: Instant::now(),
        };
        if !helper_witness_case(name) {
            return result;
        }
        let header = format!("owner-helper-v1 {name}\n");
        let opened = (|| -> io::Result<_> {
            let mut file = helper_witness_file(work, false)?;
            let meta = file.metadata()?;
            if meta.len() < header.len() as u64 || meta.len() > header.len() as u64 + 1024 {
                return Err(io::Error::other("invalid witness header"));
            }
            let mut bytes = vec![0; header.len()];
            file.read_exact(&mut bytes)?;
            if bytes != header.as_bytes() {
                return Err(io::Error::other("invalid witness header"));
            }
            Ok((meta.dev(), meta.ino()))
        })();
        if let Ok(identity) = opened {
            result.identity = Some(identity);
            result.len = header.len() as u64;
        }
        result
    }
    fn begin(&mut self, operation: usize) {
        self.record(operation, "begin", "none", "-");
    }
    fn end(&mut self, operation: usize, success: bool, errno: Option<i32>) {
        let error = match errno {
            Some(libc::ENOENT) => "ENOENT",
            Some(libc::EACCES) => "EACCES",
            Some(libc::EPERM) => "EPERM",
            Some(libc::EAGAIN) => "EAGAIN",
            Some(libc::ENOMEM) => "ENOMEM",
            Some(libc::ENOEXEC) => "ENOEXEC",
            Some(libc::EMFILE) => "EMFILE",
            Some(libc::ENFILE) => "ENFILE",
            Some(libc::EINVAL) => "EINVAL",
            Some(libc::EIO) => "EIO",
            Some(_) => "other",
            None => "-",
        };
        self.record(
            operation,
            if success { "completed" } else { "error" },
            if success {
                "none"
            } else if errno.is_some() {
                "native-error"
            } else {
                "operation-error"
            },
            if success { "-" } else { error },
        );
        if !success {
            self.identity = None;
        }
    }
    fn record(&mut self, operation: usize, stage: &str, category: &str, errno: &str) {
        let Some(identity) = self.identity else {
            return;
        };
        if self.seq >= 8
            || operation >= 4
            || self.seq != operation * 2 + usize::from(stage != "begin")
        {
            self.identity = None;
            return;
        }
        let elapsed = self.start.elapsed().as_nanos();
        let record = format!(
            "adoption-spawner {} {stage} {} {elapsed} {category} {errno}\n",
            HELPER_OPERATIONS[operation],
            self.seq + 1
        );
        if elapsed > u64::MAX as u128
            || record.len() > 192
            || self.len + record.len() as u64 > HELPER_WITNESS_CAP
        {
            self.identity = None;
            return;
        }
        let written = (|| -> io::Result<()> {
            let mut file = helper_witness_file(&self.work, false)?;
            let before = file.metadata()?;
            if (before.dev(), before.ino()) != identity
                || before.len() < self.len
                || before.len() > self.len + 1024
            {
                return Err(io::Error::other("helper witness changed"));
            }
            if file.write(record.as_bytes())? != record.len() {
                return Err(io::Error::other("partial helper append"));
            }
            let length = file.metadata()?.len();
            if length < self.len + record.len() as u64
                || length > self.len + record.len() as u64 + 1024
            {
                return Err(io::Error::other("helper witness changed"));
            }
            Ok(())
        })();
        if written.is_err() {
            self.identity = None;
            return;
        }
        self.len += record.len() as u64;
        self.seq += 1;
    }
}

fn cleanup_errno(error: &io::Error) -> &'static str {
    match error.raw_os_error() {
        Some(libc::ESRCH) => "ESRCH",
        Some(libc::ENOENT) => "ENOENT",
        Some(libc::EACCES) => "EACCES",
        Some(libc::EPERM) => "EPERM",
        Some(libc::EAGAIN) => "EAGAIN",
        Some(libc::ENOMEM) => "ENOMEM",
        Some(libc::ENOEXEC) => "ENOEXEC",
        Some(libc::EMFILE) => "EMFILE",
        Some(libc::ENFILE) => "ENFILE",
        Some(libc::EINVAL) => "EINVAL",
        Some(libc::EIO) => "EIO",
        Some(_) => "other",
        None => "-",
    }
}
fn cleanup_role(role: &str) -> Option<&'static str> {
    [
        "all",
        "carrier",
        "outer",
        "backup",
        "guardian",
        "pi",
        "observer",
        "anchor",
        "taskOuter",
        "taskGuardian",
        "payload",
        "leaf",
        "extensionChild",
        "adoptedGrandchild",
    ]
    .into_iter()
    .find(|value| *value == role)
}
#[derive(Clone, Copy)]
struct CleanupDecision {
    at: u64,
    role: &'static str,
    reason: &'static str,
    error: &'static str,
}

const CLEANUP_TIMEOUT: &str = "owned teardown exceeded 8s (stopped processes count as alive)";
const CLEANUP_BUDGET_NS: u64 = 8_000_000_000;

#[derive(Clone, Copy)]
enum CleanupOperation {
    Fault,
    Inventory,
}
#[derive(Clone, Copy)]
struct CleanupInterval {
    ordinal: u64,
    begin: u64,
    end: u64,
    success: bool,
    decision: Option<CleanupDecision>,
}

// Existing CI session succeeds the reaped spawner. Only the same file is used.
// Two fault slots and two inventory slots bound memory and publication below 3KiB.
#[derive(Default)]
struct CleanupWitness {
    work: PathBuf,
    identity: Option<(u64, u64)>,
    prefix: Vec<u8>,
    origin: Option<Instant>,
    faults: Vec<CleanupInterval>,
    inventories: Vec<CleanupInterval>,
    inventory_count: u64,
}
impl CleanupWitness {
    fn handoff(work: &Path, name: &str) -> Self {
        let mut result = Self {
            work: work.to_owned(),
            ..Self::default()
        };
        if !helper_witness_case(name) {
            return result;
        }
        let opened = (|| -> io::Result<_> {
            let mut file = helper_witness_file(work, false)?;
            let before = file.metadata()?;
            if before.len() > HELPER_WITNESS_CAP {
                return Err(io::Error::other("invalid helper prefix"));
            }
            let mut prefix = vec![0; before.len() as usize];
            file.read_exact(&mut prefix)?;
            let after = file.metadata()?;
            let verified = helper_witness_file(work, false)?.metadata()?;
            if !Self::same_metadata(&before, &after) || !Self::same_metadata(&after, &verified) {
                return Err(io::Error::other("helper prefix changed"));
            }
            let helper = session_helper_bytes(&prefix)?;
            if helper.len() > 1632 {
                return Err(io::Error::other("invalid helper prefix"));
            }
            let text = std::str::from_utf8(&helper).map_err(io::Error::other)?;
            let mut lines = text.split_terminator('\n');
            if !text.ends_with('\n')
                || lines.next() != Some(format!("owner-helper-v1 {name}").as_str())
            {
                return Err(io::Error::other("invalid helper prefix"));
            }
            let mut previous = 0;
            for index in 0..8 {
                let line = lines
                    .next()
                    .ok_or_else(|| io::Error::other("partial helper prefix"))?;
                let fields: Vec<_> = line.split(' ').collect();
                if fields.len() != 7
                    || fields[0] != "adoption-spawner"
                    || fields[1] != HELPER_OPERATIONS[index / 2]
                    || fields[2] != (if index % 2 == 0 { "begin" } else { "completed" })
                    || fields[3] != (index + 1).to_string()
                    || fields[5] != "none"
                    || fields[6] != "-"
                {
                    return Err(io::Error::other("invalid helper prefix"));
                }
                let elapsed = fields[4].parse::<u64>().map_err(io::Error::other)?;
                if fields[4] != elapsed.to_string() || elapsed < previous || line.len() + 1 > 192 {
                    return Err(io::Error::other("invalid helper time"));
                }
                previous = elapsed;
            }
            if lines.next().is_some() {
                return Err(io::Error::other("unexpected helper suffix"));
            }
            Ok(((before.dev(), before.ino()), prefix))
        })();
        if let Ok((identity, prefix)) = opened {
            result.identity = Some(identity);
            result.prefix = prefix;
        }
        result
    }
    fn same_metadata(a: &fs::Metadata, b: &fs::Metadata) -> bool {
        a.dev() == b.dev()
            && a.ino() == b.ino()
            && a.mode() == b.mode()
            && a.uid() == b.uid()
            && a.nlink() == b.nlink()
            && a.len() == b.len()
            && a.mtime() == b.mtime()
            && a.mtime_nsec() == b.mtime_nsec()
            && a.ctime() == b.ctime()
            && a.ctime_nsec() == b.ctime_nsec()
    }
    fn elapsed(&self, at: Instant) -> Option<u64> {
        u64::try_from(at.checked_duration_since(self.origin?)?.as_nanos()).ok()
    }
    fn observe<T>(
        &mut self,
        operation: CleanupOperation,
        mut now: impl FnMut() -> Instant,
        run: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        if self.identity.is_none() || self.origin.is_none() {
            return run();
        }
        let begin = self.elapsed(now());
        let result = run();
        let end = self.elapsed(now());
        let Some((begin, end)) = begin.zip(end).filter(|(a, b)| a <= b) else {
            self.identity = None;
            return result;
        };
        let slots = match operation {
            CleanupOperation::Fault => &mut self.faults,
            CleanupOperation::Inventory => &mut self.inventories,
        };
        let ordinal = match operation {
            CleanupOperation::Fault if slots.len() < 2 => slots.len() as u64 + 1,
            CleanupOperation::Inventory => {
                let Some(next) = self.inventory_count.checked_add(1) else {
                    self.identity = None;
                    return result;
                };
                self.inventory_count = next;
                if slots.len() == 2 {
                    slots.remove(0);
                }
                next
            }
            _ => {
                self.identity = None;
                return result;
            }
        };
        slots.push(CleanupInterval {
            ordinal,
            begin,
            end,
            success: result.is_ok(),
            decision: None,
        });
        result
    }
    #[allow(clippy::too_many_arguments)]
    fn predicate(
        &mut self,
        inventory: impl FnOnce() -> Result<BTreeMap<i32, Value>>,
        owned: &[Held],
        roles: &BTreeMap<&str, i32>,
        post_fault: bool,
        outer_exit_observed: bool,
        sample_birth: impl FnMut(i32) -> io::Result<String>,
        now: impl FnMut() -> Instant,
    ) -> Result<bool> {
        let enabled = self.identity.is_some() && self.origin.is_some();
        let origin = self.origin;
        let now = std::cell::RefCell::new(now);
        let mut decision = None;
        let mut record = |role: &str, reason: &'static str, error: &'static str| {
            decision = cleanup_role(role).zip(origin).and_then(|(role, origin)| {
                let at = now.borrow_mut()().checked_duration_since(origin)?;
                Some(CleanupDecision {
                    at: u64::try_from(at.as_nanos()).ok()?,
                    role,
                    reason,
                    error,
                })
            });
        };
        let result = owned_exited(
            || {
                self.observe(
                    CleanupOperation::Inventory,
                    || now.borrow_mut()(),
                    inventory,
                )
            },
            owned,
            roles,
            post_fault,
            outer_exit_observed,
            sample_birth,
            if enabled { Some(&mut record) } else { None },
        );
        if enabled {
            match (self.inventories.last_mut(), decision) {
                (Some(slot), Some(value))
                    if slot.success && slot.decision.is_none() && value.at >= slot.end =>
                {
                    slot.decision = Some(value);
                }
                _ => self.identity = None,
            }
        }
        result
    }
    fn flush_timeout(&mut self, error: &str, at: Instant) -> bool {
        let Some(identity) = self.identity.take() else {
            return false;
        };
        let Some(terminal) = self.elapsed(at).filter(|t| *t >= CLEANUP_BUDGET_NS) else {
            return false;
        };
        if error != CLEANUP_TIMEOUT {
            return false;
        }
        let mut suffix = String::from("cleanup-session-v2 begin 0\n");
        let mut previous = 0;
        for (kind, slots) in [("fault", &self.faults), ("inventory", &self.inventories)] {
            for slot in slots {
                if slot.begin < previous || slot.end < slot.begin || slot.end > terminal {
                    return false;
                }
                suffix.push_str(&format!(
                    "cleanup-session-v2 {kind} {} {} {} {}\n",
                    slot.ordinal,
                    slot.begin,
                    slot.end,
                    if slot.success { "ok" } else { "error" }
                ));
                previous = slot.end;
                if kind == "inventory" {
                    let Some(decision) = slot.decision else {
                        return false;
                    };
                    if decision.at < slot.end || decision.at > terminal {
                        return false;
                    }
                    suffix.push_str(&format!(
                        "cleanup-session-v2 decision {} {} {} {} {}\n",
                        slot.ordinal, decision.at, decision.role, decision.reason, decision.error
                    ));
                    previous = decision.at;
                }
            }
        }
        suffix.push_str(&format!("cleanup-session-v2 timeout {terminal}\n"));
        if suffix.len() > 2048 || self.prefix.len() + suffix.len() > HELPER_WITNESS_CAP as usize {
            return false;
        }
        let written = (|| -> io::Result<()> {
            let mut file = helper_witness_file(&self.work, false)?;
            let before = file.metadata()?;
            if (before.dev(), before.ino()) != identity
                || before.len() < self.prefix.len() as u64
                || before.len() + suffix.len() as u64 > HELPER_WITNESS_CAP
            {
                return Err(io::Error::other("cleanup witness changed"));
            }
            let mut prefix = vec![0; before.len() as usize];
            file.read_exact(&mut prefix)?;
            let after = file.metadata()?;
            let verified = helper_witness_file(&self.work, false)?.metadata()?;
            if !prefix.starts_with(&self.prefix)
                || session_helper_bytes(&prefix)? != session_helper_bytes(&self.prefix)?
                || !Self::same_metadata(&before, &after)
                || !Self::same_metadata(&after, &verified)
            {
                return Err(io::Error::other("cleanup prefix changed"));
            }
            file.write_all(suffix.as_bytes())?;
            let after = file.metadata()?;
            let verified = helper_witness_file(&self.work, false)?.metadata()?;
            if after.len() != before.len() + suffix.len() as u64
                || !Self::same_metadata(&after, &verified)
            {
                return Err(io::Error::other("cleanup append changed"));
            }
            Ok(())
        })();
        written.is_ok()
    }
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
            let mut witness = HelperWitness::open(
                work,
                &std::env::var("PI_OWNER_PTY_SCENARIO").unwrap_or_default(),
            );
            witness.begin(0);
            let grandchild = command.spawn();
            witness.end(
                0,
                grandchild.is_ok(),
                grandchild.as_ref().err().and_then(io::Error::raw_os_error),
            );
            #[expect(
                clippy::zombie_processes,
                reason = "Deliberate orphan fixture: spawner exits before child; session reaper or launchd must reap it"
            )]
            let _grandchild = grandchild.expect("setsid grandchild");
            witness.begin(1);
            let table = snapshot();
            witness.end(1, table.is_ok(), None);
            let table = table.expect("spawner inventory");
            witness.begin(2);
            let identity = pin(&table, std::process::id() as i32);
            witness.end(2, identity.is_ok(), None);
            let identity = identity.expect("spawner identity");
            witness.begin(3);
            let publication = publish(&work.join("spawner"), &identity);
            witness.end(3, publication.is_ok(), None);
            publication.expect("spawner record");
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
            let mut cleanup = CleanupWitness::default();
            let mut progress = SessionWitness::open(Path::new(&args[4]), &args[5]);
            progress.record(1, "b");
            let outcome = session(
                &args[2..],
                &mut master,
                &mut row,
                &mut held,
                &mut children,
                &mut output,
                &mut cleanup,
                &mut progress,
            );
            let outcome = progress.returned(8, outcome);
            if let Err(error) = outcome {
                // Diagnostic publication precedes the original failure inventory and cleanup.
                cleanup.flush_timeout(&error, Instant::now());
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
            // Session has returned; retain its final native-query diagnostics before publication.
            let _ = drain(&mut master, &mut output);
            row["outputTail"] = json!(String::from_utf8_lossy(&output));
            // Evidence is final BEFORE any cleanup. No cleanup CONT, even on failure.
            let publication = publish(&Path::new(&args[4]).join("result"), &row);
            let publication = progress.returned(9, publication);
            publication.expect("result");
            progress.record(10, "b");
            for process in held.iter().rev() {
                if same(&process.identity).unwrap_or(false) {
                    let _ = process.signal(libc::SIGKILL);
                }
            }
            for child in &mut children {
                let _ = child.kill();
                let _ = child.wait();
            }
            progress.record(11, "o");
        }
        Some("--run") => {
            assert_eq!(args.len(), 6, "--run artifact fixtures work row startup-ms");
            if initialize_helper_witness(
                Path::new(&args[3]),
                &args[4],
                unsafe { libc::getuid() },
                unsafe { libc::geteuid() },
            )
            .is_err()
            {
                eprintln!("[owner-pty] helper-witness-init-failed");
                std::process::exit(1);
            }
            let mut master = -1;
            let mut slave = -1;
            let mut size = libc::winsize {
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
                    &raw mut size,
                )
            })
            .expect("openpty");
            let mut master_file = unsafe { File::from_raw_fd(master) };
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
            let mut child = command.spawn().expect("PTY session");
            let status = wait_session(
                &mut child,
                &mut master_file,
                &Path::new(&args[3]).join("result"),
            )
            .expect("PTY session wait/drain");
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
    fn published_owner_is_canonical_without_changing_process_identity() {
        use std::os::unix::fs::symlink;
        let work = std::env::temp_dir().join(format!("published-owner-{}", std::process::id()));
        fs::create_dir(&work).unwrap();
        let owner = work.join("pi-env");
        fs::write(&owner, b"owner").unwrap();
        symlink(&work, work.join("alias")).unwrap();
        let mut pi = json!({"owner":work.join("alias/pi-env"),"pid":123,"parent":122,"uid":502});
        canonical_owner(&mut pi).unwrap();
        assert_eq!(pi, json!({"owner":fs::canonicalize(&owner).unwrap(),"pid":123,"parent":122,"uid":502}));
        for owner in [json!(work.join("missing")), Value::Null] {
            assert!(canonical_owner(&mut json!({"owner":owner})).is_err());
        }
        fs::remove_file(work.join("alias")).unwrap();
        fs::remove_dir_all(work).unwrap();
    }

    #[test]
    fn native_owner_comparison_canonicalizes_expected_aliases_but_rejects_other_images() {
        use std::os::unix::fs::symlink;

        let work = std::env::temp_dir().join(format!("native-owner-path-{}", std::process::id()));
        fs::create_dir(&work).unwrap();
        let real = work.join("real");
        fs::create_dir(&real).unwrap();
        let owner = real.join("pi-env");
        fs::write(&owner, b"owner").unwrap();
        let image = fs::canonicalize(&owner).unwrap();
        symlink(&real, work.join("alias")).unwrap();
        symlink(&owner, work.join("owner-link")).unwrap();
        assert!(native_owner_matches(&image, &owner).unwrap());
        assert!(native_owner_matches(&image, &work.join("alias/pi-env")).unwrap());
        assert!(native_owner_matches(&image, &work.join("owner-link")).unwrap());
        let other = real.join("other-executable");
        fs::write(&other, b"owner").unwrap();
        assert!(!native_owner_matches(&image, &other).unwrap());
        assert!(!native_owner_matches(&fs::canonicalize(&other).unwrap(), &owner).unwrap());
        assert!(native_owner_matches(&image, &work.join("missing")).is_err());
        fs::remove_dir_all(work).unwrap();
    }

    #[test]
    fn session_wait_drains_only_after_publication_and_preserves_failure() {
        let work = std::env::temp_dir().join(format!("pty-exit-drain-{}", std::process::id()));
        fs::create_dir(&work).unwrap();
        let result = work.join("result");
        let mut master = -1;
        let mut slave = -1;
        check(unsafe {
            libc::openpty(
                &mut master,
                &mut slave,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        })
        .unwrap();
        let mut master = unsafe { File::from_raw_fd(master) };
        let slave = unsafe { File::from_raw_fd(slave) };
        let mut termios = unsafe { std::mem::zeroed() };
        check(unsafe { libc::tcgetattr(slave.as_raw_fd(), &mut termios) }).unwrap();
        unsafe { libc::cfmakeraw(&mut termios) };
        check(unsafe { libc::tcsetattr(slave.as_raw_fd(), libc::TCSANOW, &termios) }).unwrap();
        check(unsafe { libc::fcntl(master.as_raw_fd(), libc::F_SETFL, libc::O_NONBLOCK) }).unwrap();
        let mut command = Command::new("sh");
        unsafe {
            command.pre_exec(|| {
                check(libc::setpgid(0, 0)).map(|_| ()).map_err(io::Error::other)
            });
        }
        let mut child = command
            .args([
                "-c",
                "printf session-owned; sleep 0.1; actual=$(dd bs=1 count=13 2>/dev/null); [ \"$actual\" = session-owned ] || exit 2; : > \"$1\"; dd if=/dev/zero bs=1024 count=256 2>/dev/null; exit 7",
                "sh",
            ])
            .arg(&result)
            .stdin(Stdio::from(master.try_clone().unwrap()))
            .stdout(Stdio::from(slave.try_clone().unwrap()))
            .spawn()
            .unwrap();
        let pid = child.id() as i32;
        let (done, timeout) = std::sync::mpsc::channel();
        let guard = std::thread::spawn(move || {
            if timeout.recv_timeout(Duration::from_secs(5)).is_err() {
                // The shell can be waiting for dd; stop the whole test-owned group on failure.
                unsafe { libc::kill(-pid, libc::SIGKILL) };
            }
        });
        let status = wait_session(&mut child, &mut master, &result).unwrap();
        let _ = done.send(());
        guard.join().unwrap();
        fs::remove_dir_all(work).unwrap();
        assert_eq!(status.code(), Some(7), "session output stolen or exit drain stalled");
    }

    #[test]
    fn freebsd_fault_authorization() {
        use std::cell::RefCell;
        use std::collections::VecDeque;

        #[derive(Clone, Copy)]
        struct Record {
            pid: i32,
            birth: &'static str,
        }
        #[derive(Clone, Copy)]
        enum Reply {
            Error(i32),
            Record(i32, &'static str, usize),
        }
        type Event = (&'static str, i32, i32);
        fn authorize(
            identity: &Value,
            replies: &mut VecDeque<Reply>,
            events: &RefCell<Vec<Event>>,
            kill_error: Option<i32>,
        ) -> Result<()> {
            authorize_birth_fault(
                identity,
                libc::SIGKILL,
                |pid| {
                    events.borrow_mut().push(("query", pid, 0));
                    // Even failed/partial calls expose populated-looking initialized fields.
                    freebsd_birth_call(
                        Record {
                            pid,
                            birth: "12:34",
                        },
                        |record| match replies.pop_front().expect("one fresh query per target") {
                            Reply::Error(errno) => Err(io::Error::from_raw_os_error(errno)),
                            Reply::Record(pid, birth, bytes) => {
                                *record = Record { pid, birth };
                                Ok(bytes)
                            }
                        },
                    )
                    .map(|record| (record.pid, record.birth.to_owned()))
                },
                |pid, signal| {
                    events.borrow_mut().push(("kill", pid, signal));
                    match kill_error {
                        Some(errno) => Err(io::Error::from_raw_os_error(errno).to_string()),
                        None => Ok(()),
                    }
                },
            )
        }
        let marker = std::env::var_os("PI_FREEBSD_FAULT_PS_MARKER");
        if let Some(path) = &marker {
            assert!(!Path::new(path).exists(), "tripwire must start absent");
        }
        let carrier = json!({"pid":24001,"birth":"12:34"});
        let guardian = json!({"pid":24002,"birth":"12:34"});
        let size = std::mem::size_of::<Record>();
        let matching = Reply::Record(24001, "12:34", size);
        let mut cases = vec![
            ("matching", carrier.clone(), matching, None, 1, 1, None),
            (
                "zero bytes",
                carrier.clone(),
                Reply::Record(24001, "12:34", 0),
                None,
                1,
                0,
                Some("sysctl birth unavailable".to_owned()),
            ),
            (
                "short bytes",
                carrier.clone(),
                Reply::Record(24001, "12:34", size - 1),
                None,
                1,
                0,
                Some("sysctl birth unavailable".to_owned()),
            ),
            (
                "oversize bytes",
                carrier.clone(),
                Reply::Record(24001, "12:34", size + 1),
                None,
                1,
                0,
                Some("sysctl birth unavailable".to_owned()),
            ),
            (
                "wrong record PID",
                carrier.clone(),
                Reply::Record(24002, "12:34", size),
                None,
                1,
                0,
                Some("fault target identity changed".to_owned()),
            ),
            (
                "changed record birth",
                carrier.clone(),
                Reply::Record(24001, "12:35", size),
                None,
                1,
                0,
                Some("fault target identity changed".to_owned()),
            ),
            (
                "empty record birth",
                carrier.clone(),
                Reply::Record(24001, "", size),
                None,
                1,
                0,
                Some("fault target identity changed".to_owned()),
            ),
            (
                "kill error",
                carrier.clone(),
                matching,
                Some(libc::EPERM),
                1,
                1,
                Some(io::Error::from_raw_os_error(libc::EPERM).to_string()),
            ),
        ];
        for errno in [
            libc::ESRCH,
            libc::EPERM,
            libc::EACCES,
            libc::ENOMEM,
            libc::EIO,
        ] {
            cases.push((
                "native query error",
                carrier.clone(),
                Reply::Error(errno),
                None,
                1,
                0,
                Some(io::Error::from_raw_os_error(errno).to_string()),
            ));
        }
        for invalid in [
            json!({"birth":"12:34"}),
            json!({"pid":0,"birth":"12:34"}),
            json!({"pid":1,"birth":"12:34"}),
            json!({"pid":-7,"birth":"12:34"}),
            json!({"pid":2147483648_i64,"birth":"12:34"}),
            json!({"pid":"24001","birth":"12:34"}),
            json!({"pid":24001}),
            json!({"pid":24001,"birth":""}),
            json!({"pid":24001,"birth":null}),
            json!({"pid":24001,"birth":123}),
        ] {
            cases.push((
                "invalid pinned identity",
                invalid,
                matching,
                None,
                0,
                0,
                None,
            ));
        }
        let case_count = cases.len();
        for (label, identity, reply, kill_error, queries, kills, expected_error) in cases {
            let mut replies = VecDeque::from([reply]);
            let events = RefCell::new(Vec::new());
            let result = authorize(&identity, &mut replies, &events, kill_error);
            assert_eq!(result.is_ok(), label == "matching", "{label}: {result:?}");
            if let Some(expected) = expected_error {
                assert_eq!(result, Err(expected), "{label}");
            }
            let events = events.into_inner();
            assert_eq!(
                events.iter().filter(|event| event.0 == "query").count(),
                queries,
                "{label}"
            );
            assert_eq!(
                events.iter().filter(|event| event.0 == "kill").count(),
                kills,
                "{label}"
            );
            assert_eq!(replies.len(), 1 - queries, "{label}: no retry");
            if kills == 1 {
                assert_eq!(
                    events,
                    [("query", 24001, 0), ("kill", 24001, libc::SIGKILL)],
                    "{label}"
                );
            }
        }
        let pair_cases = [
            (
                "two success",
                vec![carrier.clone(), guardian.clone()],
                vec![matching, Reply::Record(24002, "12:34", size)],
                None,
                true,
                vec![
                    ("query", 24001, 0),
                    ("kill", 24001, libc::SIGKILL),
                    ("query", 24002, 0),
                    ("kill", 24002, libc::SIGKILL),
                ],
            ),
            (
                "repeat queries fresh",
                vec![carrier.clone(), carrier.clone()],
                vec![matching, Reply::Record(24001, "12:35", size)],
                None,
                false,
                vec![
                    ("query", 24001, 0),
                    ("kill", 24001, libc::SIGKILL),
                    ("query", 24001, 0),
                ],
            ),
            (
                "first rejected",
                vec![carrier.clone(), guardian.clone()],
                vec![
                    Reply::Error(libc::EACCES),
                    Reply::Record(24002, "12:34", size),
                ],
                None,
                false,
                vec![("query", 24001, 0)],
            ),
            (
                "second rejected",
                vec![carrier.clone(), guardian.clone()],
                vec![matching, Reply::Error(libc::ESRCH)],
                None,
                false,
                vec![
                    ("query", 24001, 0),
                    ("kill", 24001, libc::SIGKILL),
                    ("query", 24002, 0),
                ],
            ),
            (
                "kill failure aborts",
                vec![carrier, guardian],
                vec![matching, Reply::Record(24002, "12:34", size)],
                Some(libc::EPERM),
                false,
                vec![("query", 24001, 0), ("kill", 24001, libc::SIGKILL)],
            ),
        ];
        for (label, identities, replies, kill_error, success, expected) in pair_cases {
            let mut replies = VecDeque::from(replies);
            let events = RefCell::new(Vec::new());
            let result = identities
                .iter()
                .try_for_each(|identity| authorize(identity, &mut replies, &events, kill_error));
            assert_eq!(result.is_ok(), success, "{label}: {result:?}");
            let events = events.into_inner();
            assert_eq!(events, expected, "{label}");
            assert_eq!(
                replies.len(),
                2 - events.iter().filter(|event| event.0 == "query").count(),
                "{label}: no hidden query/retry"
            );
        }
        if let Some(path) = &marker {
            assert!(
                !Path::new(path).exists(),
                "positive authorization spawned ps"
            );
        }
        println!(
            "freebsd positive-fault host seam: {case_count} scalar cases + 5 pair cases; exact gate/error/query/send checks passed; ps marker absent"
        );
    }

    #[test]
    fn session_progress_transport() {
        let base = std::env::var_os("PI_OWNER_SESSION_TEST_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::temp_dir().join("session-progress-transport"));
        fs::create_dir_all(&base).unwrap();
        for label in ["entered", "returned", "published", "completed"] {
            let work = base.join(label);
            fs::create_dir(&work).unwrap();
            initialize_helper_witness(&work, "suspend-resume", 1000, 1000).unwrap();
            let mut progress = SessionWitness::open(&work, "suspend-resume");
            progress.record_at(1, "b", 0);
            let mut helper = HelperWitness::open(&work, "suspend-resume");
            for operation in 0..4 {
                helper.begin(operation);
                helper.end(operation, true, None);
            }
            progress.record_at(2, "b", 1);
            progress.record_at(3, "b", 2);
            if label != "entered" {
                progress.record_at(8, "e", 3);
            }
            if ["published", "completed"].contains(&label) {
                progress.record_at(9, "o", 4);
                progress.record_at(10, "b", 5);
            }
            if label == "completed" {
                progress.record_at(11, "o", 6);
            }
            assert!(progress.identity.is_some());
            assert_eq!(
                session_helper_bytes(&fs::read(work.join(HELPER_WITNESS_FILE)).unwrap())
                    .unwrap()
                    .split(|b| *b == b'\n')
                    .count(),
                10
            );
        }
        let name = "paused-carrier-guardian-death-shutdown-blocked";
        let work = base.join("bounds");
        fs::create_dir(&work).unwrap();
        initialize_helper_witness(&work, name, 1000, 1000).unwrap();
        let mut progress = SessionWitness::open(&work, name);
        progress.record_at(1, "b", u64::MAX as u128);
        let mut helper = HelperWitness::open(&work, name);
        for operation in 0..4 {
            helper.begin(operation);
            helper.end(operation, true, None);
        }
        for stage in 2..=11 {
            progress.record_at(
                stage,
                if [8, 9, 11].contains(&stage) {
                    "o"
                } else {
                    "b"
                },
                u64::MAX as u128,
            );
        }
        assert!(progress.identity.is_some());
        assert!(session_helper_bytes(&fs::read(work.join(HELPER_WITNESS_FILE)).unwrap()).is_ok());
        if std::env::var_os("PI_OWNER_SESSION_TEST_DIR").is_none() {
            fs::remove_dir_all(base).unwrap();
        }
    }

    #[test]
    fn session_progress_concurrent_and_cleanup_handoff() {
        let work = std::env::temp_dir().join("session-progress-concurrent");
        fs::create_dir(&work).unwrap();
        let name = "suspend-resume";
        initialize_helper_witness(&work, name, 1000, 1000).unwrap();
        let mut progress = SessionWitness::open(&work, name);
        progress.record(1, "b");
        let mut helper = HelperWitness::open(&work, name);
        let barrier = std::sync::Barrier::new(2);
        std::thread::scope(|scope| {
            scope.spawn(|| {
                for operation in 0..4 {
                    helper.begin(operation);
                    barrier.wait();
                    helper.end(operation, true, None);
                    barrier.wait();
                }
            });
            for stage in 2..=5 {
                barrier.wait();
                progress.record(stage, "b");
                barrier.wait();
            }
        });
        assert!(helper.identity.is_some());
        assert!(progress.identity.is_some());
        let mut cleanup = CleanupWitness::handoff(&work, name);
        assert!(cleanup.identity.is_some());
        progress.record(6, "b");
        progress.record(7, "b");
        let start = Instant::now();
        cleanup.origin = Some(start);
        fault(&mut cleanup, start, 1, 8395);
        progress.record(8, "e");
        assert!(cleanup.flush_timeout(CLEANUP_TIMEOUT, ms(start, 8396)));
        progress.record(9, "o");
        progress.record(10, "b");
        progress.record(11, "o");
        let bytes = fs::read(work.join(HELPER_WITNESS_FILE)).unwrap();
        assert!(
            session_helper_bytes(&bytes)
                .unwrap()
                .ends_with(b"cleanup-session-v2 timeout 8396000000\n")
        );
        let original = bytes.clone();
        progress.record(11, "o");
        assert!(progress.identity.is_none());
        assert_eq!(fs::read(work.join(HELPER_WITNESS_FILE)).unwrap(), original);
        assert_eq!(
            progress.returned::<()>(8, Err("original unmodified error".into())),
            Err("original unmodified error".into())
        );
        assert_eq!(fs::read(work.join(HELPER_WITNESS_FILE)).unwrap(), original);
        let file = helper_witness_file(&work, false).unwrap();
        assert_ne!(
            unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFD) } & libc::FD_CLOEXEC,
            0
        );
        drop(file);
        fs::remove_dir_all(work).unwrap();
    }

    #[test]
    fn cleanup_v2_first_returns_keep_exact_disabled_trace_and_result() {
        let base = std::env::var_os("PI_OWNER_CLEANUP_V2_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::temp_dir().join("cleanup-v2-pure"));
        fs::create_dir(&base).unwrap();
        let owned: Vec<_> = [10, 11]
            .into_iter()
            .map(|pid| Held {
                identity: json!({"pid":pid,"birth":"held","state":"S"}),
                #[cfg(target_os = "linux")]
                fd: File::open("/dev/null").unwrap(),
            })
            .collect();
        let roles = BTreeMap::from([("guardian", 10), ("payload", 11)]);
        for (label, state, errno, post, reason) in [
            ("same-birth", "T", None, true, "same-birth-non-z"),
            ("critical", "Z", None, true, "critical-presence"),
            (
                "disappearing",
                "S",
                Some(libc::ESRCH),
                true,
                "disappearing-birth",
            ),
            ("query-error", "S", Some(libc::EACCES), true, "query-error"),
            ("eligible", "gone", None, true, "eligible-absence"),
            ("child", "gone", None, false, "child-pending"),
        ] {
            let (work, mut cleanup, start) = cleanup_case(&base, label);
            let mut outcomes = Vec::new();
            for enabled in [true, false] {
                let mut disabled = CleanupWitness::default();
                let witness = if enabled { &mut cleanup } else { &mut disabled };
                for (begin, end) in [(1, 2), (2, 3)] {
                    let mut times = [begin, end].into_iter();
                    witness
                        .observe(
                            CleanupOperation::Fault,
                            || ms(start, times.next().unwrap()),
                            || Ok(()),
                        )
                        .unwrap();
                }
                let prefix = fs::read(work.join(HELPER_WITNESS_FILE)).unwrap();
                let trace = std::cell::RefCell::new(Vec::new());
                let mut clocks = [7991, 8001, 8002].into_iter();
                let mut wait_clocks = [7990, 8003].into_iter();
                let result = wait_for_clock(
                    || {
                        witness.predicate(
                            || {
                                trace.borrow_mut().push("inventory");
                                Ok(if state == "gone" {
                                    BTreeMap::new()
                                } else {
                                    BTreeMap::from([(10, json!({"state":state}))])
                                })
                            },
                            &owned,
                            &roles,
                            post,
                            false,
                            |pid| {
                                trace.borrow_mut().push("birth");
                                assert_eq!(pid, 10, "never sample later role after first return");
                                if let Some(errno) = errno {
                                    Err(io::Error::from_raw_os_error(errno))
                                } else {
                                    Ok("held".into())
                                }
                            },
                            || ms(start, clocks.next().unwrap()),
                        )
                    },
                    ms(start, 8000),
                    &mut File::open("/dev/null").unwrap(),
                    &mut Vec::new(),
                    CLEANUP_TIMEOUT,
                    || ms(start, wait_clocks.next().unwrap()),
                );
                assert_eq!(
                    fs::read(work.join(HELPER_WITNESS_FILE)).unwrap(),
                    prefix,
                    "no poll-loop IO"
                );
                if enabled {
                    let decision = witness.inventories.last().unwrap().decision.unwrap();
                    assert_eq!(decision.reason, reason);
                    assert_eq!(decision.at, 8_002_000_000);
                    assert_eq!(
                        decision.role,
                        if state == "gone" {
                            if post { "all" } else { "carrier" }
                        } else {
                            "guardian"
                        }
                    );
                }
                outcomes.push((result, trace.into_inner()));
            }
            assert_eq!(
                outcomes[0], outcomes[1],
                "enabled/disabled {label} result and native call trace"
            );
            if label == "query-error" {
                assert!(
                    outcomes[0]
                        .0
                        .as_ref()
                        .unwrap_err()
                        .contains("owned teardown birth role=guardian")
                );
                assert!(
                    !cleanup.flush_timeout(outcomes[0].0.as_ref().unwrap_err(), ms(start, 8003))
                );
            } else {
                assert_eq!(outcomes[0].0, Err(CLEANUP_TIMEOUT.into()));
                assert!(cleanup.flush_timeout(CLEANUP_TIMEOUT, ms(start, 8003)));
                let text = fs::read_to_string(work.join(HELPER_WITNESS_FILE)).unwrap();
                assert!(text.contains(&format!(" {reason} ")));
                assert!(text.len() < 16384);
                assert!(!text.contains("held\""));
            }
        }
        if std::env::var_os("PI_OWNER_CLEANUP_V2_DIR").is_none() {
            fs::remove_dir_all(base).unwrap();
        }
    }
    #[test]
    fn cleanup_v2_retains_last_two_matching_decisions_and_rejects_missing_fact() {
        let base = std::env::temp_dir().join("cleanup-v2-slots");
        fs::create_dir(&base).unwrap();
        let (work, mut cleanup, start) = cleanup_case(&base, "slots");
        for times in [[100, 101, 102], [200, 201, 202], [7999, 8001, 8002]] {
            let mut clocks = times.into_iter();
            assert!(
                !cleanup
                    .predicate(
                        || Ok(BTreeMap::new()),
                        &[],
                        &BTreeMap::new(),
                        false,
                        false,
                        |_| panic!("no birth query"),
                        || ms(start, clocks.next().unwrap())
                    )
                    .unwrap()
            );
        }
        assert!(cleanup.flush_timeout(CLEANUP_TIMEOUT, ms(start, 8003)));
        let text = fs::read_to_string(work.join(HELPER_WITNESS_FILE)).unwrap();
        assert!(!text.contains("inventory 1 "));
        assert!(text.contains("inventory 2 "));
        assert!(text.contains("decision 2 "));
        assert!(text.contains("inventory 3 "));
        assert!(text.contains("decision 3 "));
        let (_, mut missing, start) = cleanup_case(&base, "missing");
        let mut times = [7999, 8001].into_iter();
        missing
            .observe(
                CleanupOperation::Inventory,
                || ms(start, times.next().unwrap()),
                || Ok(()),
            )
            .unwrap();
        assert!(!missing.flush_timeout(CLEANUP_TIMEOUT, ms(start, 8003)));
        fs::remove_dir_all(base).unwrap();
    }

    fn readiness_fixture(
        anchor_state: &str,
    ) -> (
        BTreeMap<&'static str, Value>,
        BTreeMap<&'static str, i32>,
        BTreeMap<i32, Value>,
    ) {
        let rows = [
            ("carrier", 10, 1, 10, 10),
            ("outer", 11, 10, 10, 10),
            ("anchor", 12, 11, 12, 12),
            ("backup", 13, 12, 10, 10),
            ("guardian", 14, 12, 14, 12),
            ("pi", 15, 14, 14, 12),
            ("taskOuter", 16, 15, 16, 12),
            ("taskGuardian", 17, 16, 16, 12),
            ("payload", 18, 17, 16, 12),
            ("leaf", 19, 18, 16, 12),
            ("extensionChild", 20, 15, 14, 12),
            ("adoptedGrandchild", 21, 22, 21, 21),
        ];
        let previous: BTreeMap<_,_> = rows.iter().map(|&(role,pid,parent,group,sid)| (role,json!({"pid":pid,"parent":parent,"group":group,"sid":sid,"uid":1001,"birth":format!("b{pid}"),"state":"R","sample":1}))).collect();
        let roles = rows
            .iter()
            .map(|&(role, pid, _, _, _)| (role, pid))
            .collect();
        let mut table: BTreeMap<_, _> = previous
            .values()
            .map(|p| (number(p, "pid").unwrap(), p.clone()))
            .collect();
        table.get_mut(&21).unwrap()["parent"] = json!(14);
        table.get_mut(&12).unwrap()["state"] = json!(anchor_state);
        (previous, roles, table)
    }
    fn readiness_pin(table: &BTreeMap<i32, Value>, pid: i32) -> Result<Value> {
        table
            .get(&pid)
            .cloned()
            .ok_or("injected missing pin".into())
    }
    #[test]
    fn readiness_pending_d_commits_only_coherent_timely_rs_bundle() {
        for state in ["R", "Ss"] {
            let (previous, roles, first) = readiness_fixture("Ds");
            let mut second = first.clone();
            for p in second.values_mut() {
                p["sample"] = json!(2);
            }
            second.get_mut(&12).unwrap()["state"] = json!(state);
            second.get_mut(&21).unwrap()["parent"] = json!(12);
            let mut tables = [first, second.clone()].into_iter();
            let start = Instant::now();
            let mut times = [0, 1, 2, 3].map(|value| ms(start, value)).into_iter();
            let ready = acquire_adoption_readiness(
                || {
                    adoption_candidate(
                        tables.next().expect("no extra table"),
                        &previous,
                        &roles,
                        22,
                        "freebsd",
                        readiness_pin,
                    )
                },
                ms(start, 10),
                &mut File::open("/dev/null").unwrap(),
                &mut Vec::new(),
                || times.next().unwrap(),
            )
            .unwrap();
            assert_eq!(ready.table, second);
            assert_eq!(ready.processes["anchor"]["state"], state);
            assert!(ready.processes.values().all(|p| p["sample"] == 2));
            assert_eq!(ready.adopted["parent"], 12);
            assert_eq!(children_of(&ready.table, 12), [13, 14, 21]);
            assert!(tables.next().is_none());
            assert!(times.next().is_none());
            let mut independent_controller = ready.processes["anchor"].clone();
            independent_controller["state"] = json!("D");
            assert_eq!(ready.processes["anchor"]["state"], state);
            assert_eq!(independent_controller["state"], "D");
        }
    }
    #[test]
    fn readiness_persistent_d_and_late_true_publish_nothing() {
        for state in ["Ds", "R"] {
            let (previous, roles, table) = readiness_fixture(state);
            let start = Instant::now();
            let mut times = if state == "R" {
                vec![0, 10]
            } else {
                vec![0, 1, 2, 10]
            }
            .into_iter();
            let mut calls = 0;
            let result = acquire_adoption_readiness(
                || {
                    calls += 1;
                    adoption_candidate(
                        table.clone(),
                        &previous,
                        &roles,
                        22,
                        "freebsd",
                        readiness_pin,
                    )
                },
                ms(start, 10),
                &mut File::open("/dev/null").unwrap(),
                &mut Vec::new(),
                || ms(start, times.next().unwrap()),
            );
            assert!(
                result.is_err(),
                "{state} must not publish late or pending readiness"
            );
            assert_eq!(calls, if state == "R" { 1 } else { 2 });
        }
    }
    #[test]
    fn readiness_forbidden_states_and_other_os_d_fail_immediately() {
        for state in ["T", "t", "Z", "X", "?", "", "D?", "I", "U"] {
            let (previous, roles, table) = readiness_fixture(state);
            assert!(
                adoption_candidate(table, &previous, &roles, 22, "freebsd", readiness_pin).is_err(),
                "{state}"
            );
        }
        let (previous, roles, table) = readiness_fixture("D");
        assert!(adoption_candidate(table, &previous, &roles, 22, "linux", readiness_pin).is_err());
    }
    #[test]
    fn readiness_d_never_masks_identity_topology_missing_or_query_errors() {
        for (role, key, value) in [
            ("anchor", "birth", json!("reused")),
            ("anchor", "pid", json!(99)),
            ("anchor", "uid", json!(1002)),
            ("anchor", "sid", json!(99)),
            ("anchor", "group", json!(99)),
            ("guardian", "parent", json!(11)),
            ("adoptedGrandchild", "parent", json!(1)),
            ("adoptedGrandchild", "parent", json!(99)),
        ] {
            let (previous, roles, mut table) = readiness_fixture("D");
            table.get_mut(&roles[role]).unwrap()[key] = value;
            assert!(
                adoption_candidate(table, &previous, &roles, 22, "freebsd", readiness_pin).is_err(),
                "{role} {key}"
            );
        }
        let (previous, roles, mut table) = readiness_fixture("D");
        table.insert(22, json!({"pid":22,"parent":1}));
        assert!(
            adoption_candidate(table, &previous, &roles, 22, "freebsd", readiness_pin).is_err()
        );
        let (previous, roles, mut table) = readiness_fixture("D");
        table.remove(&12);
        assert!(
            adoption_candidate(table, &previous, &roles, 22, "freebsd", readiness_pin).is_err()
        );
        let (previous, roles, table) = readiness_fixture("D");
        let mut calls = 0;
        assert!(
            adoption_candidate(table, &previous, &roles, 22, "freebsd", |_, _| {
                calls += 1;
                Err("injected pin failure".into())
            })
            .is_err()
        );
        assert_eq!(calls, 1);
    }
    #[test]
    fn readiness_pending_cannot_repair_replaced_identity_or_cherry_pick_state() {
        let (previous, roles, first) = readiness_fixture("D");
        let mut second = first.clone();
        second.get_mut(&12).unwrap()["state"] = json!("R");
        second.get_mut(&12).unwrap()["birth"] = json!("replacement");
        let mut tables = [first, second].into_iter();
        let start = Instant::now();
        let result = acquire_adoption_readiness(
            || {
                adoption_candidate(
                    tables.next().expect("no retry after error"),
                    &previous,
                    &roles,
                    22,
                    "freebsd",
                    readiness_pin,
                )
            },
            ms(start, 100),
            &mut File::open("/dev/null").unwrap(),
            &mut Vec::new(),
            || start,
        );
        assert!(result.is_err());
        assert!(tables.next().is_none());
        let (_, _, table) = readiness_fixture("D");
        assert!(
            adoption_candidate(table, &previous, &roles, 22, "freebsd", |t, pid| {
                let mut value = readiness_pin(t, pid)?;
                value["state"] = json!("R");
                Ok(value)
            })
            .is_err()
        );
    }

    #[test]
    fn wait_expired_deadline_never_calls_true_predicate() {
        let mut master = File::open("/dev/null").unwrap();
        let mut calls = 0;
        let result = wait_for(
            || {
                calls += 1;
                Ok(true)
            },
            Instant::now() - Duration::from_secs(1),
            &mut master,
            &mut Vec::new(),
            "expired original deadline",
        );
        assert_eq!(result, Err("expired original deadline".into()));
        assert_eq!(calls, 0);
    }

    #[test]
    fn wait_clock_complete_must_finish_before_original_deadline() {
        let start = Instant::now();
        let deadline = start + Duration::from_secs(8);
        for completion_ms in [7999, 8000, 8396] {
            let mut master = File::open("/dev/null").unwrap();
            let mut times = [
                start + Duration::from_millis(7998),
                start + Duration::from_millis(completion_ms),
            ]
            .into_iter();
            let mut calls = 0;
            let result = wait_for_clock(
                || {
                    calls += 1;
                    Ok(true)
                },
                deadline,
                &mut master,
                &mut Vec::new(),
                "late complete predicate",
                || times.next().expect("only pre/post clock samples"),
            );
            assert_eq!(result.is_ok(), completion_ms < 8000);
            if completion_ms >= 8000 {
                assert_eq!(result, Err("late complete predicate".into()));
            }
            assert_eq!(calls, 1);
            assert!(times.next().is_none());
        }
    }

    #[test]
    fn wait_clock_expired_ui_prefix_does_not_start_another_budget() {
        let death_start = Instant::now();
        let deadline = death_start + Duration::from_secs(8);
        let mut master = File::open("/dev/null").unwrap();
        let result = wait_for_clock(
            || panic!("normal UI prefix already consumed the original budget"),
            deadline,
            &mut master,
            &mut Vec::new(),
            "owned teardown exceeded 8s (stopped processes count as alive)",
            || death_start + Duration::from_millis(8001),
        );
        assert_eq!(
            result,
            Err("owned teardown exceeded 8s (stopped processes count as alive)".into())
        );
    }

    #[test]
    fn wait_clock_pending_requires_fresh_complete_poll_within_original_budget() {
        let table = snapshot().unwrap();
        let pid = std::process::id() as i32;
        let held = Held::open(&pin(&table, pid).unwrap()).unwrap();
        let roles = BTreeMap::from([("guardian", pid)]);
        let mut absent = table.clone();
        absent.remove(&pid);
        let start = Instant::now();
        let deadline = start + Duration::from_secs(8);
        for completion_ms in [7999, 8000] {
            let mut times = [7996, 7997, 7998, completion_ms]
                .map(|ms| start + Duration::from_millis(ms))
                .into_iter();
            let mut master = File::open("/dev/null").unwrap();
            let mut polls = 0;
            let mut queries = 0;
            let result = wait_for_clock(
                || {
                    polls += 1;
                    owned_exited(
                        || {
                            Ok(if polls == 1 {
                                table.clone()
                            } else {
                                absent.clone()
                            })
                        },
                        std::slice::from_ref(&held),
                        &roles,
                        true,
                        true,
                        |_| {
                            queries += 1;
                            Err(io::Error::from_raw_os_error(libc::ESRCH))
                        },
                        None,
                    )
                },
                deadline,
                &mut master,
                &mut Vec::new(),
                "original Pending deadline",
                || times.next().expect("same deadline across fresh polls"),
            );
            assert_eq!(result.is_ok(), completion_ms < 8000);
            if completion_ms >= 8000 {
                assert_eq!(result, Err("original Pending deadline".into()));
            }
            assert_eq!(polls, 2);
            assert_eq!(queries, 1, "fresh complete absence needs no birth query");
            assert!(times.next().is_none());
        }
    }

    #[test]
    fn wait_clock_overrun_error_keeps_original_stage_and_native_failure() {
        let start = Instant::now();
        let deadline = start + Duration::from_secs(8);
        let now = std::cell::Cell::new(start);
        let native_error = io::Error::from_raw_os_error(libc::EACCES).to_string();
        let mut master = File::open("/dev/null").unwrap();
        let result = wait_for_clock(
            || {
                now.set(deadline + Duration::from_millis(1));
                Err(native_error.clone())
            },
            deadline,
            &mut master,
            &mut Vec::new(),
            "owned teardown",
            || now.get(),
        );
        assert_eq!(
            result,
            Err(format!("wait condition (owned teardown): {native_error}"))
        );
    }

    #[test]
    fn witness_security_and_finite_producer() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let base = std::env::temp_dir().join("witness-security");
        fs::create_dir(&base).unwrap();
        fs::set_permissions(&base, fs::Permissions::from_mode(0o700)).unwrap();
        let work = base.join("root");
        for (uid, euid) in [(0, 1000), (1000, 0), (0, 0)] {
            assert!(initialize_helper_witness(&work, "suspend-resume", uid, euid).is_err());
            assert!(!work.exists());
        }
        assert!(initialize_helper_witness(&work, "suspend-resume", 1000, 1000).is_err());
        let stale = base.join("stale");
        fs::create_dir(&stale).unwrap();
        initialize_helper_witness(&stale, "suspend-resume", 1000, 1000).unwrap();
        let mut witness = HelperWitness::open(&stale, "suspend-resume");
        witness.begin(0);
        witness.end(0, false, Some(libc::ENOENT));
        let stale_path = stale.join(HELPER_WITNESS_FILE);
        let stale_bytes = fs::read(&stale_path).unwrap();
        assert!(initialize_helper_witness(&stale, "suspend-resume", 1000, 1000).is_err());
        assert_eq!(fs::read(stale_path).unwrap(), stale_bytes);
        let work = base.join("valid");
        fs::create_dir(&work).unwrap();
        initialize_helper_witness(&work, "suspend-resume", 1000, 1000).unwrap();
        let path = work.join(HELPER_WITNESS_FILE);
        let original = fs::read(&path).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().mode() & 0o7777, 0o600);
        assert!(initialize_helper_witness(&work, "suspend-resume", 1000, 1000).is_err());
        assert_eq!(fs::read(&path).unwrap(), original);
        let fd = helper_witness_file(&work, false).unwrap();
        let raw = fd.as_raw_fd();
        assert_ne!(
            unsafe { libc::fcntl(raw, libc::F_GETFD) } & libc::FD_CLOEXEC,
            0
        );
        drop(fd);
        assert_eq!(unsafe { libc::fcntl(raw, libc::F_GETFD) }, -1);
        for mode in [0o644, 0o660, 0o4600] {
            fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
            assert!(helper_witness_file(&work, false).is_err());
        }
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        fs::hard_link(&path, work.join("link")).unwrap();
        assert!(helper_witness_file(&work, false).is_err());
        fs::remove_file(work.join("link")).unwrap();
        let mut witness = HelperWitness::open(&work, "suspend-resume");
        for operation in 0..4 {
            witness.begin(operation);
            witness.end(operation, true, None);
        }
        let complete = fs::read(&path).unwrap();
        for _ in 0..100 {
            witness.begin(0);
            witness.end(0, false, Some(libc::ENOENT));
        }
        assert_eq!(fs::read(&path).unwrap(), complete);
        assert!(complete.len() < 16384);
        let other = base.join("symlink");
        fs::create_dir(&other).unwrap();
        symlink(&path, other.join(HELPER_WITNESS_FILE)).unwrap();
        assert!(initialize_helper_witness(&other, "suspend-resume", 1000, 1000).is_err());
        assert!(helper_witness_file(&other, false).is_err());
        assert_eq!(fs::read(&path).unwrap(), complete);
        fs::remove_file(other.join(HELPER_WITNESS_FILE)).unwrap();
        fs::create_dir(other.join(HELPER_WITNESS_FILE)).unwrap();
        assert!(helper_witness_file(&other, false).is_err());
        fs::remove_dir(other.join(HELPER_WITNESS_FILE)).unwrap();
        let fifo = std::ffi::CString::new(
            other
                .join(HELPER_WITNESS_FILE)
                .as_os_str()
                .as_encoded_bytes(),
        )
        .unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        assert!(helper_witness_file(&other, false).is_err());
        assert!(initialize_helper_witness(&other, "suspend-resume", 1000, 1000).is_err());
        fs::write(&path, vec![b'x'; 16385]).unwrap();
        assert!(helper_witness_file(&work, false).is_err());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn witness_emit_production_errors() {
        let base = std::env::var_os("PI_OWNER_WITNESS_TEST_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::temp_dir().join("witness-producer"));
        fs::create_dir(&base).unwrap();
        for failed in 0..4 {
            let work = base.join(HELPER_OPERATIONS[failed]);
            fs::create_dir(&work).unwrap();
            initialize_helper_witness(&work, "suspend-resume", 1000, 1000).unwrap();
            let mut witness = HelperWitness::open(&work, "suspend-resume");
            for operation in 0..=failed {
                witness.begin(operation);
                witness.end(
                    operation,
                    operation != failed,
                    (operation == 0).then_some(libc::ENOENT),
                );
            }
            let bytes = fs::read(work.join(HELPER_WITNESS_FILE)).unwrap();
            assert!(bytes.len() < 16384);
            assert!(String::from_utf8(bytes).unwrap().contains(" error "));
        }
        if std::env::var_os("PI_OWNER_WITNESS_TEST_DIR").is_none() {
            fs::remove_dir_all(base).unwrap();
        }
    }

    fn cleanup_case(base: &Path, label: &str) -> (PathBuf, CleanupWitness, Instant) {
        let name = "paused-carrier-guardian-death-shutdown-blocked";
        let work = base.join(label);
        fs::create_dir(&work).unwrap();
        initialize_helper_witness(&work, name, 1000, 1000).unwrap();
        let mut helper = HelperWitness::open(&work, name);
        for operation in 0..4 {
            helper.begin(operation);
            helper.end(operation, true, None);
        }
        let mut cleanup = CleanupWitness::handoff(&work, name);
        assert!(
            cleanup.identity.is_some(),
            "successful pinned handoff accepts helper8"
        );
        let start = Instant::now();
        cleanup.origin = Some(start);
        (work, cleanup, start)
    }
    fn ms(start: Instant, value: u64) -> Instant {
        start + Duration::from_millis(value)
    }
    fn fault(cleanup: &mut CleanupWitness, start: Instant, begin: u64, end: u64) {
        let mut times = [ms(start, begin), ms(start, end)].into_iter();
        cleanup
            .observe(CleanupOperation::Fault, || times.next().unwrap(), || Ok(()))
            .unwrap();
        assert!(times.next().is_none());
    }

    // One real fault/wait/inventory history; returns the operation trace for disabled equivalence.
    #[allow(clippy::too_many_arguments)]
    fn cleanup_history(
        cleanup: &mut CleanupWitness,
        start: Instant,
        faults: [(u64, u64); 2],
        wait: &[u64],
        inventory: &[u64],
        held: &Held,
        roles: &BTreeMap<&str, i32>,
        absent: &BTreeMap<i32, Value>,
    ) -> (Result<()>, Vec<&'static str>) {
        let enabled = cleanup.identity.is_some();
        let trace = std::cell::RefCell::new(Vec::new());
        for (index, (begin, end)) in faults.into_iter().enumerate() {
            let mut times = [ms(start, begin), ms(start, end)].into_iter();
            let label = ["fault1", "fault2"][index];
            cleanup
                .observe(
                    CleanupOperation::Fault,
                    || times.next().unwrap(),
                    || {
                        trace.borrow_mut().push(label);
                        Ok(())
                    },
                )
                .unwrap();
        }
        let mut wait_times = wait.iter().map(|value| ms(start, *value));
        let mut inventory_times = inventory.iter().map(|value| ms(start, *value));
        let mut master = File::open("/dev/null").unwrap();
        let result = wait_for_clock(
            || {
                trace.borrow_mut().push("predicate");
                cleanup.predicate(
                    || {
                        trace.borrow_mut().push("inventory");
                        Ok(absent.clone())
                    },
                    std::slice::from_ref(held),
                    roles,
                    true,
                    false,
                    |_| panic!("complete absence needs no birth query"),
                    || inventory_times.next().unwrap(),
                )
            },
            start + Duration::from_secs(8),
            &mut master,
            &mut Vec::new(),
            CLEANUP_TIMEOUT,
            || wait_times.next().unwrap(),
        );
        assert!(wait_times.next().is_none(), "exact original wait samples");
        if enabled {
            assert!(inventory_times.next().is_none(), "every inventory timed");
        }
        (result, trace.into_inner())
    }

    #[test]
    fn cleanup_witness_same_timeout_selects_distinct_ci_costs() {
        let base = std::env::var_os("PI_OWNER_CLEANUP_TEST_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::temp_dir().join("cleanup-producer"));
        fs::create_dir(&base).unwrap();
        let table = snapshot().unwrap();
        let pid = std::process::id() as i32;
        let held = Held::open(&pin(&table, pid).unwrap()).unwrap();
        let roles = BTreeMap::from([("guardian", pid)]);
        let mut absent = table.clone();
        absent.remove(&pid);
        // Both histories deliver the case's two pinned faults; only the operation spanning 8s differs.
        let histories: [(&str, [(u64, u64); 2], &[u64], &[u64], &[&str]); 2] = [
            (
                "held-fault-delivery",
                [(1, 2), (2, 8395)],
                &[8396],
                &[],
                &["fault1", "fault2"],
            ),
            (
                "complete-inventory",
                [(0, 1), (1, 2)],
                &[7990, 8396],
                &[7991, 8396, 8396],
                &["fault1", "fault2", "predicate", "inventory"],
            ),
        ];
        let mut paths = Vec::new();
        for (label, faults, wait, inventory, expected) in histories {
            let (work, mut cleanup, start) = cleanup_case(&base, label);
            let enabled = cleanup_history(
                &mut cleanup,
                start,
                faults,
                wait,
                inventory,
                &held,
                &roles,
                &absent,
            );
            assert!(cleanup.flush_timeout(CLEANUP_TIMEOUT, ms(start, 8396)));
            assert!(
                !cleanup.flush_timeout(CLEANUP_TIMEOUT, ms(start, 8396)),
                "single flush"
            );
            let disabled = cleanup_history(
                &mut CleanupWitness::default(),
                start,
                faults,
                wait,
                inventory,
                &held,
                &roles,
                &absent,
            );
            assert_eq!(
                enabled, disabled,
                "witness changes no result, order or count"
            );
            assert_eq!(enabled.0, Err(CLEANUP_TIMEOUT.into()));
            assert_eq!(enabled.1, expected);
            paths.push(work);
        }
        let (delivery, observation) = (&paths[0], &paths[1]);

        let delivery = fs::read_to_string(delivery.join(HELPER_WITNESS_FILE)).unwrap();
        let observation = fs::read_to_string(observation.join(HELPER_WITNESS_FILE)).unwrap();
        assert!(delivery.ends_with("cleanup-session-v2 fault 2 2000000 8395000000 ok\ncleanup-session-v2 timeout 8396000000\n"));
        assert!(observation.ends_with("cleanup-session-v2 fault 1 0 1000000 ok\ncleanup-session-v2 fault 2 1000000 2000000 ok\ncleanup-session-v2 inventory 1 7991000000 8396000000 ok\ncleanup-session-v2 decision 1 8396000000 all eligible-absence -\ncleanup-session-v2 timeout 8396000000\n"));
        assert!(delivery.len() < 3000 && observation.len() < 3000);
        if std::env::var_os("PI_OWNER_CLEANUP_TEST_DIR").is_none() {
            fs::remove_dir_all(base).unwrap();
        }
    }

    #[test]
    fn cleanup_witness_requires_safe_complete_handoff_and_timeout() {
        let base = std::env::temp_dir().join("cleanup-negatives");
        fs::create_dir(&base).unwrap();
        let name = "paused-carrier-guardian-death-shutdown-blocked";
        let partial = base.join("partial");
        fs::create_dir(&partial).unwrap();
        initialize_helper_witness(&partial, name, 1000, 1000).unwrap();
        let mut helper = HelperWitness::open(&partial, name);
        helper.begin(0);
        helper.end(0, true, None);
        let before = fs::read(partial.join(HELPER_WITNESS_FILE)).unwrap();
        let mut cleanup = CleanupWitness::handoff(&partial, name);
        cleanup.origin = Some(Instant::now());
        assert!(cleanup.identity.is_none());
        assert!(!cleanup.flush_timeout(CLEANUP_TIMEOUT, Instant::now() + Duration::from_secs(9)));
        assert_eq!(fs::read(partial.join(HELPER_WITNESS_FILE)).unwrap(), before);

        let (work, mut cleanup, start) = cleanup_case(&base, "wrong-error");
        let path = work.join(HELPER_WITNESS_FILE);
        let prefix = fs::read(&path).unwrap();
        fault(&mut cleanup, start, 1, 2);
        assert!(!cleanup.flush_timeout("wait condition (owned teardown): EACCES", ms(start, 8396)));
        assert!(
            !cleanup.flush_timeout(CLEANUP_TIMEOUT, ms(start, 8396)),
            "failed attempt disables writer"
        );
        assert_eq!(fs::read(&path).unwrap(), prefix);

        let (work, mut cleanup, start) = cleanup_case(&base, "early");
        let early = fs::read(work.join(HELPER_WITNESS_FILE)).unwrap();
        assert!(!cleanup.flush_timeout(CLEANUP_TIMEOUT, ms(start, 7999)));
        assert_eq!(fs::read(work.join(HELPER_WITNESS_FILE)).unwrap(), early);

        let (work, mut cleanup, start) = cleanup_case(&base, "changed");
        let path = work.join(HELPER_WITNESS_FILE);
        OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"x")
            .unwrap();
        let changed = fs::read(&path).unwrap();
        assert!(!cleanup.flush_timeout(CLEANUP_TIMEOUT, ms(start, 8396)));
        assert_eq!(fs::read(&path).unwrap(), changed);

        let (work, mut cleanup, start) = cleanup_case(&base, "no-origin");
        let disabled = fs::read(work.join(HELPER_WITNESS_FILE)).unwrap();
        cleanup.origin = None;
        assert_eq!(
            cleanup.observe(
                CleanupOperation::Fault,
                || panic!("disabled clock"),
                || Ok(7)
            ),
            Ok(7)
        );
        assert!(!cleanup.flush_timeout(CLEANUP_TIMEOUT, ms(start, 8396)));
        assert_eq!(fs::read(work.join(HELPER_WITNESS_FILE)).unwrap(), disabled);

        let (_, mut cleanup, start) = cleanup_case(&base, "third-fault");
        for index in 0..3 {
            let mut times = [ms(start, index), ms(start, index + 1)].into_iter();
            assert_eq!(
                cleanup.observe(CleanupOperation::Fault, || times.next().unwrap(), || Ok(())),
                Ok(())
            );
        }
        assert!(
            cleanup.identity.is_none(),
            "more than original two faults disables witness"
        );
        fs::remove_dir_all(base).unwrap();
    }

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
        // Query a stable subject, not our own transient inventory-command pipes.
        let mut child = Command::new("sleep").arg("30")
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
            .spawn().unwrap();
        let pid = child.id() as i32;
        let before = pin(&snapshot().unwrap(), pid).unwrap();
        let mut outcomes = Vec::new();
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
            outcomes.push((calls, result));
        }
        child.kill().unwrap();
        child.wait().unwrap();
        for (index, (calls, result)) in outcomes.into_iter().enumerate() {
            assert_eq!(calls, 2);
            let error = result.unwrap_err();
            assert!(error.contains(if index == 0 {
                "postcapture credential permission denied"
            } else {
                "controller changed during image/FD inventory"
            }), "{error}");
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
        let mut child = Command::new("sleep").arg("30")
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
            .spawn().unwrap();
        let pid = child.id() as i32;
        let before = pin(&snapshot().unwrap(), pid).unwrap();
        let image = fs::canonicalize(native_path(pid).unwrap()).unwrap();
        let uids = current_uids(pid).unwrap();
        let result = capture_controller(&before, Some(&image), "0", false, current_uids, || {});
        child.kill().unwrap();
        child.wait().unwrap();
        let result = result.unwrap();
        assert_eq!(result["image"], json!(image));
        assert_eq!(result["uids"], json!(uids));
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
    fn darwin_lsof_491_numeric_range_retains_live_controller_fds() {
        let command = lsof_command(41415);
        assert_eq!(command.get_program(), "/usr/sbin/lsof");
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            ["-nP", "-a", "-p", "41415", "-d", "0-2147483647", "-F0pftnr"],
        );
        // Captured macOS 15.8.1 lsof 4.91 stdout, same-UID suspend-resume outer.
        // The old -d fd returned status 0 with empty stdout/stderr on this same PID.
        let raw = "p41415\0\nf0\0tCHR\0r0x10000000\0n/dev/ttys000\0\nf1\0tCHR\0r0x10000000\0n/dev/ttys000\0\nf2\0tCHR\0r0x10000000\0n/dev/ttys000\0\nf3\0tCHR\0r0x2000000\0n/dev/tty\0\nf4\0tCHR\0r0xf000001\0n/dev/ptmx\0\nf5\0tCHR\0r0x10000001\0n/dev/ttys001\0\nf6\0tunix\0n->0x97048fce06eb9472\0\nf7\0tPIPE\0n->0x38ee58c6fdbb7cb5\0\nf10\0tPIPE\0n->0x76c1f4c770cde526\0\nf11\0tunix\0n->0x6cb1720b366509c3\0\nf13\0tunix\0n->0x3a293e358fc9771a\0\n";
        let records = parse_lsof(raw, 41415).unwrap();
        assert_eq!(
            records.iter().map(|record| record["fd"].as_u64().unwrap()).collect::<Vec<_>>(),
            [0, 1, 2, 3, 4, 5, 6, 7, 10, 11, 13],
        );
        assert_eq!(records[0]["rdev"], "268435456");
        assert_eq!(records[6]["kind"], "socket");
        assert_eq!(records[7]["kind"], "pipe");
        assert!(validate_private_descriptors(&records, "268435456").is_err());
        assert!(parse_lsof("", 41415).is_err());
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
    #[cfg(target_os = "macos")]
    #[test]
    fn darwin_native_birth_keeps_unreaped_child_then_reports_reaped_absence() {
        let mut child = Command::new("/bin/sh").args(["-c", "read gate; exit 0"])
            .stdin(Stdio::piped()).spawn().unwrap();
        let pid = child.id() as i32;
        let live = query_birth(pid).unwrap();
        child.stdin.take().unwrap().write_all(b"go\n").unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let table = snapshot().unwrap();
            if table.get(&pid).is_some_and(|row| row["state"].as_str().unwrap().starts_with('Z')) {
                break;
            }
            assert!(Instant::now() < deadline, "child did not become zombie");
            sleep(Duration::from_millis(1));
        }
        assert_eq!(query_birth(pid).unwrap(), live);
        assert_eq!(unsafe { libc::kill(pid, 0) }, 0);
        assert!(child.wait().unwrap().success());
        assert_eq!(query_birth(pid).unwrap_err().raw_os_error(), Some(libc::ESRCH));
    }

    #[test]
    fn darwin_fault_delivery_requires_present_exact_birth_after_esrch() {
        use std::cell::Cell;
        let pid = 59300;
        let pinned = json!({"pid":pid,"birth":"1793010359:616748"});
        for (result, micros, sends) in [(0, 616748, 1), (0, 616749, 0), (-1, 616748, 0), (libc::EPERM, 616748, 0), (-2, 616748, 0)] {
            let sent = Cell::new(0);
            let outcome = authorize_birth_fault(
                &pinned,
                libc::SIGKILL,
                |pid| darwin_birth_with_fallback(pid, Err(io::Error::from_raw_os_error(libc::ESRCH)), |record| {
                    record.pbi_pid = pid as u32;
                    record.pbi_status = 5;
                    record.pbi_start_tvsec = 1793010359;
                    record.pbi_start_tvusec = micros;
                    result
                }).map(|birth| (pid, birth)),
                |actual, signal| {
                    assert_eq!((actual, signal), (pid, libc::SIGKILL));
                    sent.set(sent.get() + 1);
                    Ok(())
                },
            );
            assert_eq!(sent.get(), sends);
            assert_eq!(outcome.is_ok(), sends == 1);
        }
        let sent = Cell::new(false);
        assert!(authorize_birth_fault(&pinned, libc::SIGKILL, |_| Err(io::Error::from_raw_os_error(libc::EPERM)), |_, _| { sent.set(true); Ok(()) }).is_err());
        assert!(!sent.get());
    }

    #[test]
    fn darwin_esrch_preserves_zombie_birth_until_fresh_bsd_absence() {
        let pid = 59300;
        let esrch = || Err(io::Error::from_raw_os_error(libc::ESRCH));
        let zombie = |record: &mut darwin_record::Record| {
            record.pbi_pid = pid as u32;
            record.pbi_status = 5; // SZOMB from native live/zombie/reaped guest probe.
            record.pbi_start_tvsec = 1793010359;
            record.pbi_start_tvusec = 616748;
            0
        };
        assert_eq!(darwin_birth_with_fallback(pid, esrch(), zombie).unwrap(), "1793010359:616748");
        assert_eq!(darwin_birth_with_fallback(pid, esrch(), |_| -1).unwrap_err().raw_os_error(), Some(libc::ESRCH));
        for result in [-2, libc::EPERM, libc::EIO] {
            assert!(darwin_birth_with_fallback(pid, esrch(), |_| result).is_err());
        }
        assert!(darwin_birth_with_fallback(pid + 1, esrch(), zombie).is_err());
        assert!(darwin_birth_with_fallback(pid, esrch(), |_| 0).is_err());
        assert_eq!(darwin_birth_with_fallback(pid, Ok("live".into()), |_| panic!("no fallback on live record")).unwrap(), "live");
        for error in [libc::EPERM, libc::EACCES, libc::EIO] {
            assert_eq!(darwin_birth_with_fallback(pid, Err(io::Error::from_raw_os_error(error)), |_| panic!("only ESRCH falls back")).unwrap_err().raw_os_error(), Some(error));
        }
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
                    None,
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
                |_| panic!("fresh complete absence only"),
                None,
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
    fn inventory_accepts_unsigned_minus_one_pgid_for_dead_procps_record() {
        let table = parse_inventory("   2303       0 4294967295 1001 X+\n").unwrap();
        assert_eq!(
            table[&2303],
            json!({"pid":2303,"parent":0,"group":-1,"uid":1001,"state":"X+"})
        );
        assert!(!runnable(&table, &json!({"pid":2303})).unwrap());
        assert_eq!(table, parse_inventory("2303 0 -1 1001 X+\n").unwrap());
    }
    #[test]
    fn inventory_unsigned_sentinel_is_only_valid_for_pgid() {
        for index in [0, 1, 3] {
            let mut fields = ["2303", "0", "-1", "1001", "X+"];
            fields[index] = "4294967295";
            assert!(parse_inventory(&fields.join(" ")).is_err());
        }
        for invalid in ["4294967294", "4294967296", "-2147483649"] {
            assert!(parse_inventory(&format!("2303 0 {invalid} 1001 X+\n")).is_err());
        }
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
                None,
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
                    |_| panic!("complete absence needs no birth query"),
                    None,
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
                        |_| panic!("complete absence needs no birth query"),
                        None,
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
                |_| panic!("inventory errors must not become pending"),
                None,
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
                    None,
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
            None,
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
                None,
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
                    None,
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
                None,
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
                        None,
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
                        None,
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
                None,
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
                    None,
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
