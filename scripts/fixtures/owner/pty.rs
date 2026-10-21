// CI-only release-artifact job-control probe. openpty/setsid follows pi-env's pty.rs;
// its private PTY API cannot expose termios or a shell-side sibling in the job group.
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
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

#[cfg(target_os = "linux")]
fn birth(pid: i32) -> Result<String> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).map_err(|e| e.to_string())?;
    let fields: Vec<_> = stat
        .rsplit_once(") ")
        .ok_or("invalid proc stat")?
        .1
        .split_whitespace()
        .collect();
    Ok(fields.get(19).ok_or("missing proc starttime")?.to_string())
}
#[cfg(target_os = "macos")]
fn birth(pid: i32) -> Result<String> {
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
    require(result == size, "proc_pidinfo birth unavailable")?;
    Ok(format!(
        "{}:{}",
        info.pbi_start_tvsec, info.pbi_start_tvusec
    ))
}
#[cfg(target_os = "freebsd")]
fn birth(pid: i32) -> Result<String> {
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
        "sysctl birth unavailable",
    )?;
    Ok(format!(
        "{}:{}",
        info.ki_start.tv_sec, info.ki_start.tv_usec
    ))
}

// ps absence is established by a successful complete inventory, never by a failed PID query.
fn snapshot() -> Result<BTreeMap<i32, Value>> {
    let out = Command::new("ps")
        .args(["-axo", "pid=,ppid=,pgid=,uid=,stat="])
        .output()
        .map_err(|e| e.to_string())?;
    require(out.status.success(), "ps inventory failed")?;
    let text = String::from_utf8(out.stdout).map_err(|e| e.to_string())?;
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
    let after = snapshot()?;
    require(
        after.get(&pid).is_some_and(|p| {
            ["pid", "parent", "group", "uid"]
                .iter()
                .all(|key| p[key] == value[key])
        }) && birth(pid)? == value["birth"].as_str().ok_or("missing birth")?,
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
        drain(master, output)?;
        if condition()? {
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
                && work.join("peer-heartbeat").exists())
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
    let task_guardian = table
        .get(&payload_pid)
        .and_then(|p| p["parent"].as_i64())
        .ok_or("missing task guardian")? as i32;
    let task_outer = table
        .get(&task_guardian)
        .and_then(|p| p["parent"].as_i64())
        .ok_or("missing task outer")? as i32;
    let roles = BTreeMap::from([
        ("outer", outer_pid),
        ("guardian", guardian_pid),
        ("pi", pi_pid),
        ("taskOuter", task_outer),
        ("taskGuardian", task_guardian),
        ("payload", payload_pid),
        ("leaf", leaf_pid),
    ]);
    #[cfg(target_os = "macos")]
    let mut roles = roles;
    require(
        table
            .get(&guardian_pid)
            .is_some_and(|v| v["parent"] == outer_pid),
        "Pi parent not outer's guardian",
    )?;
    require(
        table
            .get(&task_outer)
            .is_some_and(|v| v["parent"] == pi_pid),
        "task outer not Pi child",
    )?;
    require(
        table.get(&pi_pid).is_some_and(|v| v["group"] == outer_pid),
        "Pi not in foreground job group",
    )?;
    #[cfg(target_os = "macos")]
    {
        let observers: Vec<_> = table
            .iter()
            .filter(|(pid, p)| **pid != guardian_pid && p["parent"] == outer_pid)
            .map(|(&pid, _)| pid)
            .collect();
        require(
            observers.len() == 1,
            "expected guardian + exactly one observer under outer",
        )?;
        roles.insert("observer", observers[0]);
        require(
            table[&observers[0]]["group"] != outer_pid
                && table[&observers[0]]["group"] != table[&task_outer]["group"],
            "observer in frozen job group",
        )?;
        let mut path = [0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        let length = unsafe {
            libc::proc_pidpath(observers[0], path.as_mut_ptr().cast(), path.len() as u32)
        };
        require(length > 0, "observer native path unavailable")?;
        let path = std::ffi::CStr::from_bytes_until_nul(&path)
            .map_err(|e| e.to_string())?
            .to_str()
            .map_err(|e| e.to_string())?;
        require(
            fs::canonicalize(path).map_err(|e| e.to_string())?
                == fs::canonicalize(
                    row["pi"]["owner"]
                        .as_str()
                        .ok_or("native owner path absent")?,
                )
                .map_err(|e| e.to_string())?,
            "observer not shipped native owner",
        )?;
        row["observerNative"] = json!(true);
    }
    row["processes"] = json!({});
    let ids = descendants(&table, outer_pid);
    require(
        ids.contains(&leaf_pid)
            && !ids.contains(&peer_pid)
            && ids == roles.values().copied().collect(),
        "owned inventory/peer ancestry invalid",
    )?;
    for &pid in &ids {
        let identity = pin(&table, pid)?;
        require(
            identity["uid"] == unsafe { libc::getuid() },
            "owned process UID mismatch",
        )?;
        if !owned.iter().any(|held| held.identity["pid"] == pid) {
            owned.push(Held::open(&identity)?);
        }
    }
    for (role, pid) in &roles {
        row["processes"][role] = pin(&table, *pid)?;
    }
    row["peer"] = pin(&table, peer_pid)?;
    require(same(&row["peer"])?, "peer changed during readiness")?;
    let before = ticks(&work.join("heartbeat"))?;
    sleep(Duration::from_millis(250));
    let advancing = ticks(&work.join("heartbeat"))?;
    require(
        advancing > before,
        "task heartbeat not advancing before pause",
    )?;
    wait_for(
        || Ok(terminal()?["icanon"] == false && terminal()?["echo"] == false),
        deadline,
        master,
        output,
        "interactive raw terminal missing",
    )?;
    row["pty"]["rawObserved"] = json!(true);
    sleep(Duration::from_millis(500));
    drain(master, output)?;
    row["pty"]["jobForeground"] = json!(unsafe { libc::tcgetpgrp(0) } == outer_pid);
    require(
        row["pty"]["jobForeground"] == true,
        "Pi job is not PTY foreground",
    )?;
    master.write_all(&[26]).map_err(|e| e.to_string())?;
    let processes = row["processes"].clone();
    let peer_identity = row["peer"].clone();
    let is_paused = |table: &BTreeMap<i32, Value>| -> Result<bool> {
        for role in roles.keys() {
            let p = &processes[role];
            require(
                birth(number(p, "pid")?)? == p["birth"].as_str().ok_or("missing paused birth")?,
                "paused identity changed",
            )?;
            if *role == "guardian" || *role == "observer" {
                if !runnable(table, p)? {
                    return Ok(false);
                }
            } else if !stopped(table, p)? {
                return Ok(false);
            }
        }
        require(same(&peer_identity)?, "paused peer identity changed")?;
        stopped(table, &peer_identity)
    };
    wait_for(
        || is_paused(&snapshot()?),
        deadline,
        master,
        output,
        "Pi/outer/task tree did not stop with live guardian",
    )?;
    let paused = snapshot()?;
    require(is_paused(&paused)?, "pause unstable")?;
    row["paused"] = json!(
        roles
            .iter()
            .map(|(role, pid)| {
                let mut p = paused[pid].clone();
                p["role"] = json!(role);
                p["birth"] = row["processes"][role]["birth"].clone();
                p
            })
            .collect::<Vec<_>>()
    );
    row["peerPaused"] = paused[&peer_pid].clone();
    row["peerPaused"]["birth"] = row["peer"]["birth"].clone();
    let pause_start = ticks(&work.join("heartbeat"))?;
    let peer_start = ticks(&work.join("peer-heartbeat"))?;
    sleep(Duration::from_millis(250));
    require(is_paused(&snapshot()?)?, "pause not stable for 250ms")?;
    let pause_end = ticks(&work.join("heartbeat"))?;
    require(
        pause_start == pause_end && ticks(&work.join("peer-heartbeat"))? == peer_start,
        "paused heartbeat continued",
    )?;
    row["heartbeats"] = json!({"before":before,"advancing":advancing,"pauseStart":pause_start,"pauseEnd":pause_end,"stableMs":250,"peerPause":peer_start});
    row["piStopped"] = json!(true);
    row["stopped"] = json!(true);
    row["aliveBefore"] = json!(true);
    row["peerRunning"] = json!(true);
    // Shell regains foreground only. Never tcsetattr: final cooked flags must come from product teardown.
    foreground(me)?;
    let roles_to_kill: Vec<&str> = match name.as_str() {
        "suspend-resume" => vec![],
        "paused-guardian-death" => vec!["guardian"],
        "paused-both-owners-death" => vec!["outer", "guardian"],
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
    row["faultTargets"] = json!(faults.iter().map(|(role, held)| json!({"role":role,"pid":held.identity["pid"],"birth":held.identity["birth"],"parent":held.identity["parent"],"method":if cfg!(target_os="linux") {"pidfd"} else {"checked-birth"}})).collect::<Vec<_>>());
    let death_start = Instant::now();
    if name == "suspend-resume" {
        foreground(outer_pid)?;
        check(unsafe { libc::kill(-outer_pid, libc::SIGCONT) })?;
        wait_for(
            || {
                Ok(!stopped(&snapshot()?, &row["processes"]["pi"])?
                    && ticks(&work.join("heartbeat"))? > pause_end)
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
        for (_, held) in &faults {
            held.signal(libc::SIGKILL)?;
        }
    }
    let end = Instant::now() + Duration::from_secs(8);
    wait_for(
        || {
            for child in children.iter_mut().take(1) {
                if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                    row["exit"] = json!({"code":status.code(),"signal":status.signal()});
                }
            }
            let table = snapshot()?;
            for held in owned.iter().filter(|h| h.identity["pid"] != peer_pid) {
                let pid = number(&held.identity, "pid")?;
                if let Some(p) = table.get(&pid) {
                    if birth(pid)? == held.identity["birth"].as_str().ok_or("birth missing")?
                        && !p["state"].as_str().ok_or("state missing")?.starts_with('Z')
                    {
                        return Ok(false);
                    }
                    if roles.get("observer") == Some(&pid) {
                        return Ok(false);
                    }
                }
            }
            Ok(true)
        },
        end,
        master,
        output,
        "owned teardown exceeded 8s (stopped processes count as alive)",
    )?;
    if name == "suspend-resume" {
        require(
            row["exit"]["code"] == 0 && row["exit"]["signal"].is_null(),
            "normal fg/Ctrl-D exit was not clean",
        )?;
    }
    row["postDeathMs"] = json!(death_start.elapsed().as_millis() as u64);
    let table = snapshot()?;
    row["after"] = json!(owned.iter().filter(|h| h.identity["pid"] != peer_pid).map(|h| {
        let pid = h.identity["pid"].as_i64().unwrap() as i32;
        json!({"pid":pid,"birth":h.identity["birth"],"state":table.get(&pid).map(|p| p["state"].clone()).unwrap_or(json!("gone"))})
    }).collect::<Vec<_>>());
    let last = ticks(&work.join("heartbeat"))?;
    sleep(Duration::from_millis(250));
    row["heartbeats"]["after"] = json!(ticks(&work.join("heartbeat"))?);
    row["heartbeats"]["exit"] = json!(last);
    row["heartbeats"]["peerAfter"] = json!(ticks(&work.join("peer-heartbeat"))?);
    require(
        last == ticks(&work.join("heartbeat"))?,
        "heartbeat continued after teardown",
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
                    std::ptr::null(),
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
    fn held_target_rejects_wrong_birth_before_signaling() {
        let table = snapshot().unwrap();
        let mut identity = pin(&table, std::process::id() as i32).unwrap();
        identity["birth"] = json!("not-this-process");
        assert!(Held::open(&identity).is_err());
    }
}
