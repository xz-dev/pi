// CI-only release-artifact job-control probe. openpty/setsid follows pi-env's pty.rs;
// its private PTY API cannot expose termios or a shell-side sibling in the job group.
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
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
#[cfg(target_os = "macos")]
fn query_birth(pid: i32) -> io::Result<String> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of_val(&info) as i32;
    let result = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size,
        )
    };
    require(result == size, "proc_pidinfo birth unavailable")
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    Ok(format!(
        "{}:{}",
        info.pbi_start_tvsec, info.pbi_start_tvusec
    ))
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
    } < 0 {
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
        let parse = |i: usize| f[i].parse::<i32>().map_err(|e| e.to_string());
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
        check(unsafe { libc::kill(number(&self.identity, "pid")?, signal) })?;
        Ok(())
    }
}
fn owned_exited(
    inventory: impl FnOnce() -> Result<BTreeMap<i32, Value>>,
    owned: &[Held],
    roles: &BTreeMap<&str, i32>,
    post_fault: bool,
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
                    let call = if cfg!(target_os = "freebsd") { "sysctl(KERN_PROC_PID)" } else { "query_birth" };
                    return Err(format!("owned teardown birth role={role} pinned={} observed={p} call={call}: {error}", held.identity));
                }
            };
            if current_birth == held.identity["birth"].as_str().ok_or("birth missing")?
                && !p["state"].as_str().ok_or("state missing")?.starts_with('Z')
            {
                return Ok(false);
            }
            if ["observer", "anchor", "extensionChild", "adoptedGrandchild"]
                .iter()
                .any(|role| roles.get(role) == Some(&pid))
            {
                return Ok(false);
            }
        }
    }
    Ok(true)
}

fn terminal() -> Result<Value> {
    let mut term: libc::termios = unsafe { std::mem::zeroed() };
    check(unsafe { libc::tcgetattr(0, &mut term) })?;
    Ok(
        json!({"lflag":term.c_lflag,"iflag":term.c_iflag,"oflag":term.c_oflag,"cflag":term.c_cflag,
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
        drain(master, output).map_err(|error| format!("PTY read while waiting ({message}): {error}"))?;
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
        if ["guardian", "observer", "anchor"].contains(role) {
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
    let outer_pid = outer.id() as i32;
    children.push(outer);
    let mut peer = Command::new(&own_binary);
    peer.arg("--peer").arg(work.join("peer-heartbeat"));
    let peer = spawn_group(&mut peer, outer_pid)?;
    let peer_pid = peer.id() as i32;
    children.push(peer);
    let initial = snapshot()?;
    owned.push(Held::open(&pin(&initial, outer_pid)?)?);
    owned.push(Held::open(&pin(&initial, peer_pid)?)?);
    // The gate removes foreground-startup races without pre-parking Pi or faking Ctrl-Z.
    foreground(outer_pid)?;
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
    let mut roles = BTreeMap::from([
        ("outer", outer_pid),
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
        table
            .get(&task_outer)
            .is_some_and(|v| v["parent"] == pi_pid),
        "task outer not Pi child",
    )?;
    require(
        table
            .get(&extension_pid)
            .is_some_and(|v| v["parent"] == pi_pid),
        "extension child not Pi child",
    )?;
    require(
        table.get(&pi_pid).is_some_and(|v| v["group"] == outer_pid),
        "Pi not in foreground job group",
    )?;
    require(
        table
            .get(&pi_pid)
            .is_some_and(|v| v["parent"] == guardian_pid),
        "Pi parent does not match pinned guardian",
    )?;
    let outer_children = children_of(&table, outer_pid);
    #[cfg(not(target_os = "macos"))]
    {
        let anchor = number(
            table.get(&guardian_pid).ok_or("missing guardian")?,
            "parent",
        )?;
        require(
            outer_children == [anchor]
                && children_of(&table, anchor) == [guardian_pid]
                && table[&anchor]["parent"] == outer_pid,
            "expected outer -> sole anchor -> sole guardian -> Pi",
        )?;
        let identity = pin(&table, anchor)?;
        require(
            identity["group"] == anchor
                && identity["group"] != outer_pid
                && identity["sid"] == pin(&table, outer_pid)?["sid"]
                && matches!(state(&table, &identity)?.chars().next(), Some('R' | 'S')),
            "anchor not runnable/in own group outside foreground group in same SID",
        )?;
        require(
            fs::canonicalize(native_path(anchor)?).map_err(|e| e.to_string())?
                == fs::canonicalize(
                    row["pi"]["owner"]
                        .as_str()
                        .ok_or("native owner path missing")?,
                )
                .map_err(|e| e.to_string())?,
            "anchor not shipped native owner",
        )?;
        roles.insert("anchor", anchor);
        row["anchorNative"] = json!(true);
    }
    #[cfg(target_os = "macos")]
    {
        require(
            table[&guardian_pid]["parent"] == outer_pid && outer_children.len() == 2,
            "expected guardian + exactly one observer under outer",
        )?;
        let observer = *outer_children
            .iter()
            .find(|&&pid| pid != guardian_pid)
            .ok_or("observer missing")?;
        roles.insert("observer", observer);
        require(
            table[&observer]["group"] != outer_pid
                && table[&observer]["group"] != table[&task_outer]["group"],
            "observer in frozen job group",
        )?;
        require(
            fs::canonicalize(native_path(observer)?).map_err(|e| e.to_string())?
                == fs::canonicalize(
                    row["pi"]["owner"]
                        .as_str()
                        .ok_or("native owner path missing")?,
                )
                .map_err(|e| e.to_string())?,
            "observer not shipped native owner",
        )?;
        row["observerNative"] = json!(true);
    }
    let mut expected_ids: BTreeSet<i32> = roles.values().copied().collect();
    expected_ids.insert(spawner_pid);
    require(
        descendants(&table, outer_pid) == expected_ids && !expected_ids.contains(&peer_pid),
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
    sleep(Duration::from_millis(500));
    #[cfg(target_os = "macos")]
    {
        // Observe the descendant through a complete freeze/thaw before it can be adopted by launchd.
        let mut observed_processes = processes.clone();
        observed_processes.insert("spawner", spawner.clone());
        let first = pause_job(
            master,
            output,
            outer_pid,
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
        foreground(outer_pid)?;
        check(unsafe { libc::kill(-outer_pid, libc::SIGCONT) })?;
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
        descendants(&adopted_table, outer_pid) == remaining,
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
    row["sessionChildren"] = json!({"outer":children_of(&adopted_table,outer_pid)});
    #[cfg(not(target_os = "macos"))]
    {
        let anchor = roles["anchor"];
        let mut expected_anchor_children = vec![guardian_pid];
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
    let blocked = name == "paused-both-owners-death-shutdown-blocked";
    if blocked {
        fs::write(work.join("shutdown-arm"), "arm").map_err(|e| e.to_string())?;
    }
    require(
        !work.join("shutdown-hook-entered").exists()
            && !work.join("shutdown-entered").exists()
            && !work.join("shutdown-returned").exists(),
        "shutdown hook ran before fault",
    )?;
    row["pty"]["jobForeground"] = json!(unsafe { libc::tcgetpgrp(0) } == outer_pid);
    let paused = pause_job(
        master,
        output,
        outer_pid,
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
    let roles_to_kill: Vec<&str> = match name.as_str() {
        "suspend-resume" => vec![],
        "paused-outer-death" => vec!["outer"],
        "paused-anchor-death" => vec!["anchor"],
        "paused-guardian-death" => vec!["guardian"],
        "paused-both-owners-death" | "paused-both-owners-death-shutdown-blocked" => {
            vec!["outer", "guardian"]
        }
        "paused-observer-death" => vec!["observer"],
        _ => return Err("unknown PTY scenario".into()),
    };
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
        foreground(outer_pid)?;
        check(unsafe { libc::kill(-outer_pid, libc::SIGCONT) })?;
        wait_for(
            || {
                Ok(!stopped(&snapshot()?, &row["processes"]["pi"])?
                    && ticks(&work.join("heartbeat"))? > pause_start)
            },
            deadline,
            master,
            output,
            "fg did not resume task",
        )?;
        row["resumed"] = json!(true);
        sleep(Duration::from_millis(500));
        master.write_all(&[4]).map_err(|e| e.to_string())?;
    } else {
        for (index, (role, held)) in faults.iter().enumerate() {
            held.signal(libc::SIGKILL).map_err(|error| {
                format!("fault SIGKILL role={role} pinned={}: {error}", held.identity)
            })?;
            row["faultTargets"][index]["delivered"] = json!(true);
        }
    }
    let end = Instant::now() + Duration::from_secs(8);
    wait_for(
        || {
            for child in children.iter_mut().take(1) {
                if let Some(status) = child.try_wait().map_err(|error| {
                    format!("owned teardown try_wait role=outer pinned={}: {error}", processes["outer"])
                })? {
                    row["exit"] = json!({"code":status.code(),"signal":status.signal()});
                }
            }
            owned_exited(snapshot, owned, &roles, !faults.is_empty(), query_birth)
        },
        end,
        master,
        output,
        "owned teardown exceeded 8s (stopped processes count as alive)",
    )
    .inspect_err(|_| {
        row["teardownFailureMs"] = json!(death_start.elapsed().as_millis() as u64);
    })?;
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
    row["shutdownHook"] = json!({"entered":!hook.is_null(),"enteredBeforeFault":false,"pid":hook["pid"]});
    require(
        (hook.is_null() || hook["pid"] == pi_pid)
            && (!matches!(
                name.as_str(),
                "paused-guardian-death"
                    | "paused-both-owners-death"
                    | "paused-both-owners-death-shutdown-blocked"
            ) || !hook.is_null()),
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
    row["guardExpired"] = json!(false);
    row["aliveAfter"] = json!(false);
    row["peerAlive"] = json!(true);
    row["allOwnedExited"] = json!(true);
    row["immediateChecks"] = json!(1);
    row["status"] = json!("passed");
    Ok(())
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
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
                for name in ["shutdown-hook-entered", "shutdown-entered", "shutdown-returned"] {
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
                    &mut size,
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
        assert!(birth(pid).is_err(), "strict pre-fault birth facade must still fail");
        let pending = owned_exited(
            || Ok(table),
            std::slice::from_ref(&held),
            &roles,
            true,
            query_birth,
        );
        if cfg!(target_os = "macos") {
            assert!(pending.is_err(), "Darwin unavailable birth remains a hard failure");
        } else {
            assert!(matches!(pending, Ok(false)), "{pending:?}");
        }
        let fresh = snapshot().unwrap();
        assert!(!fresh.contains_key(&pid));
        assert!(owned_exited(
            || Ok(fresh),
            &[held],
            &roles,
            true,
            |_| panic!("absence must come from complete inventory, not another birth error"),
        ).unwrap());
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
                    |_| {
                        queries += 1;
                        Err(io::Error::from_raw_os_error(errno))
                    },
                );
                assert_eq!(queries, 1, "retry needs a new complete inventory");
                if post_fault {
                    assert!(matches!(result, Ok(false)), "{result:?}");
                } else {
                    assert!(result.is_err(), "normal exit must not gain retry permission");
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
                |_| Err(error.take().unwrap()),
            ).unwrap_err();
            assert!(failure.contains(&message), "{failure}");
            assert!(failure.contains("owned teardown birth role=guardian"), "{failure}");
            assert!(failure.contains(&format!("pinned={}", held.identity)), "{failure}");
        }
    }
    #[test]
    fn teardown_preserves_stopped_zombie_and_reused_identity_policy() {
        let table = snapshot().unwrap();
        let pid = std::process::id() as i32;
        let held = Held::open(&pin(&table, pid).unwrap()).unwrap();
        let cases = [("S", false), ("T", false), ("Ts+", false), ("Z", false), ("Z+", false), ("S", true), ("T", true)];
        for (role, expected) in [
            ("outer", [false, false, false, true, true, true, true]),
            ("guardian", [false, false, false, true, true, true, true]),
            ("pi", [false, false, false, true, true, true, true]),
            ("taskOuter", [false, false, false, true, true, true, true]),
            ("taskGuardian", [false, false, false, true, true, true, true]),
            ("payload", [false, false, false, true, true, true, true]),
            ("leaf", [false, false, false, true, true, true, true]),
            ("observer", [false; 7]),
            ("anchor", [false; 7]),
            ("extensionChild", [false; 7]),
            ("adoptedGrandchild", [false; 7]),
        ] {
            let roles = BTreeMap::from([(role, pid)]);
            for ((state, reused), done) in cases.into_iter().zip(expected) {
                let mut observed = table.clone();
                observed.get_mut(&pid).unwrap()["state"] = json!(state);
                let birth = if reused { "other-birth" } else { held.identity["birth"].as_str().unwrap() };
                let pending_table = observed.clone();
                assert_eq!(owned_exited(
                    || Ok(observed),
                    std::slice::from_ref(&held),
                    &roles,
                    true,
                    |_| Ok(birth.to_string()),
                ).unwrap(), done, "role={role} state={state} reused={reused}");
                assert!(!owned_exited(
                    || Ok(pending_table),
                    std::slice::from_ref(&held),
                    &roles,
                    true,
                    |_| Err(io::Error::from_raw_os_error(libc::ESRCH)),
                ).unwrap(), "disappearance never grants {role} completion");
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
                |_| panic!("failed inventory cannot reach birth query or prove absence"),
            ).unwrap_err();
            assert!(failure.starts_with("owned teardown ps inventory:"), "{failure}");
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
                assert!(Instant::now() < deadline + Duration::from_secs(2), "pending polls escaped original deadline");
                polls += 1;
                owned_exited(
                    || Ok(table.clone()),
                    std::slice::from_ref(&held),
                    &roles,
                    true,
                    |_| Err(io::Error::from_raw_os_error(libc::ESRCH)),
                )
            },
            deadline,
            &mut master,
            &mut Vec::new(),
            message,
        ).unwrap_err();
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
        assert!(error.starts_with("wait condition (owned teardown"), "{error}");
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
