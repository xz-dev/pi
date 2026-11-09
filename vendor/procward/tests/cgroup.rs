// SPDX-License-Identifier: BSD-3-Clause
// Real delegated cgroup v2 integration. Opt-in: PROCWARD_TEST_CGROUP_PARENT names an existing,
// already writable cgroup v2 directory. The test creates one fresh group there and moves only
// a freshly spawned shell into it before that shell execs procward. Absent opt-in = not run.
#![cfg(target_os = "linux")]

use rustix::{
    fd::OwnedFd,
    fs::{self, AtFlags, Mode, OFlags},
};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const FALLBACK: &str = "cgroup v2 workload group unavailable";

fn fixture() -> PathBuf {
    std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("examples/fixture")
}

fn poll(phase: &str, mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !condition() {
        assert!(Instant::now() < deadline, "deadline expired: {phase}");
        thread::sleep(Duration::from_millis(5));
    }
}

fn running(pid: u32) -> bool {
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => stat.rsplit_once(')').unwrap().1.split_whitespace().next() != Some("Z"),
        Err(_) => false,
    }
}

fn membership(pid: u32) -> String {
    std::fs::read_to_string(format!("/proc/{pid}/cgroup"))
        .unwrap()
        .trim()
        .to_owned()
}

// One fresh test group, removed through its retained handle on every path.
struct TestGroup {
    parent: OwnedFd,
    dir: OwnedFd,
    name: String,
    path: PathBuf,
    // Unified-hierarchy membership line for processes directly in this group.
    line: String,
}

impl TestGroup {
    fn create(tag: &str) -> Option<Self> {
        let Some(parent_path) = std::env::var_os("PROCWARD_TEST_CGROUP_PARENT") else {
            println!(
                "CGROUP-NOT-RUN: set PROCWARD_TEST_CGROUP_PARENT to a writable cgroup v2 directory"
            );
            return None;
        };
        let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
        let parent = fs::open(Path::new(&parent_path), flags, Mode::empty())
            .unwrap_or_else(|error| panic!("opt-in cgroup parent unusable: {error}"));
        assert_eq!(
            fs::fstatfs(&parent).unwrap().f_type as i64,
            0x6367_7270,
            "opt-in parent is not cgroup v2"
        );
        let name = format!("procward-test-{}-{tag}", std::process::id());
        fs::mkdirat(&parent, name.as_str(), Mode::from_raw_mode(0o755))
            .unwrap_or_else(|error| panic!("opt-in cgroup parent not writable: {error}"));
        let dir = fs::openat(&parent, name.as_str(), flags, Mode::empty()).unwrap();
        let path = Path::new(&parent_path).join(&name);
        let mount = std::fs::read_to_string("/proc/self/mountinfo").unwrap();
        let (root, point) = mount
            .lines()
            .filter_map(|line| {
                let (fields, fs_type) = line.split_once(" - ")?;
                (fs_type.split_whitespace().next()? == "cgroup2").then(|| {
                    let mut fields = fields.split_whitespace().skip(3);
                    (
                        fields.next().unwrap().to_owned(),
                        fields.next().unwrap().to_owned(),
                    )
                })
            })
            .find(|(_, point)| path.starts_with(point))
            .expect("opt-in parent below a cgroup2 mount");
        let relative = path.strip_prefix(&point).unwrap();
        let line = format!("0::{}", Path::new(&root).join(relative).display());
        Some(Self {
            parent,
            dir,
            name,
            path,
            line,
        })
    }

    // Shell joins this group, then execs procward; only that child is moved.
    fn spawn(&self, args: &[&str], tree: &Path, nested: bool) -> Child {
        let mut command = Command::new("/bin/sh");
        command
            .arg("-c")
            .arg(r#"echo $$ > "$1/cgroup.procs" && shift && exec "$@""#)
            .arg("sh")
            .arg(&self.path)
            .arg(env!("CARGO_BIN_EXE_procward"))
            .arg("run")
            .args(args)
            .arg("--");
        if nested {
            command
                .arg(env!("CARGO_BIN_EXE_procward"))
                .arg("run")
                .args(args)
                .arg("--");
        }
        command
            .arg(fixture())
            .arg("cgroup-tree")
            .arg(tree)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap()
    }

    fn children(&self) -> Vec<String> {
        fs::Dir::read_from(&self.dir)
            .unwrap()
            .map(Result::unwrap)
            .filter(|entry| entry.file_type() == fs::FileType::Directory)
            .map(|entry| entry.file_name().to_str().unwrap().to_owned())
            .filter(|name| name != "." && name != "..")
            .collect()
    }
}

fn remove_tree(dir: &OwnedFd) {
    let names: Vec<_> = fs::Dir::read_from(dir)
        .unwrap()
        .map(Result::unwrap)
        .filter(|entry| entry.file_type() == fs::FileType::Directory)
        .map(|entry| entry.file_name().to_owned())
        .filter(|name| !matches!(name.to_bytes(), b"." | b".."))
        .collect();
    for name in names {
        let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
        let child = fs::openat(dir, name.as_c_str(), flags, Mode::empty()).unwrap();
        remove_tree(&child);
        let _ = fs::unlinkat(dir, name.as_c_str(), AtFlags::REMOVEDIR);
    }
}

impl Drop for TestGroup {
    fn drop(&mut self) {
        let events = || std::fs::read_to_string(self.path.join("cgroup.events")).unwrap();
        let rescued = events().contains("populated 1");
        if rescued {
            // Only this fresh test group is a kill target.
            let kill = fs::openat(&self.dir, "cgroup.kill", OFlags::WRONLY, Mode::empty()).unwrap();
            rustix::io::write(&kill, b"1").unwrap();
            poll("harness group kill", || events().contains("populated 0"));
            eprintln!("HARNESS RESCUE: test cgroup still populated; NOT product cleanup");
        }
        remove_tree(&self.dir);
        fs::unlinkat(&self.parent, self.name.as_str(), AtFlags::REMOVEDIR).unwrap();
        assert!(!rescued || thread::panicking(), "test cgroup needed rescue");
    }
}

struct Scratch(PathBuf);
impl Scratch {
    fn new(tag: &str) -> Self {
        let path =
            std::env::temp_dir().join(format!("procward-cgroup-{}-{tag}", std::process::id()));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn pid(&self, mode: &str) -> u32 {
        let path = self.0.join(format!("{mode}.pid"));
        // A fixture's rename may not be visible yet; an empty read is not a PID.
        poll("non-empty fixture pid", || {
            std::fs::read_to_string(&path)
                .map(|text| !text.trim().is_empty())
                .unwrap_or(false)
        });
        std::fs::read_to_string(path)
            .unwrap()
            .trim()
            .parse()
            .unwrap()
    }
    fn membership(&self, mode: &str) -> String {
        let path = self.0.join(format!("{mode}.cgroup"));
        poll("fixture membership", || path.exists());
        std::fs::read_to_string(path).unwrap().trim().to_owned()
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

fn parent(pid: u32) -> u32 {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap();
    stat.rsplit_once(')')
        .unwrap()
        .1
        .split_whitespace()
        .nth(1)
        .unwrap()
        .parse()
        .unwrap()
}

fn finish(child: &mut Child) -> (Option<i32>, String) {
    poll("procward completion", || {
        child.try_wait().unwrap().is_some()
    });
    let mut stderr = String::new();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut stderr)
        .unwrap();
    (child.wait().unwrap().code(), stderr)
}

const OPTIONS: [&str; 6] = [
    "--grace",
    "300ms",
    "--fatal-grace",
    "150ms",
    "--cleanup-deadline",
    "2s",
];

// Owner, anchor and unrelated work stay outside; the payload is a member before its first fork.
fn start(group: &TestGroup, tree: &Scratch) -> (Child, u32, u32, u32) {
    let child = group.spawn(&OPTIONS, &tree.0, false);
    let primary = tree.pid("cgroup-tree");
    let worker = tree.pid("cgroup-worker");
    let workload = tree.membership("cgroup-tree");
    assert!(
        workload.starts_with(&format!("{}/procward-", group.line)),
        "{workload}"
    );
    assert_eq!(tree.membership("cgroup-worker"), workload);
    let anchor = parent(primary);
    println!(
        "CGROUP-REAL: test group {}; owner {}; anchor {}; payload before fork {workload}",
        group.line,
        membership(child.id()),
        membership(anchor)
    );
    assert_eq!(
        membership(child.id()),
        group.line,
        "owner joined its workload group"
    );
    assert_eq!(
        membership(anchor),
        group.line,
        "anchor joined its workload group"
    );
    assert_eq!(
        group.children().len(),
        1,
        "exactly one owned workload group"
    );
    (child, primary, worker, anchor)
}

#[test]
fn payload_joins_owned_group_before_fork_and_group_kill_completes() {
    let Some(group) = TestGroup::create("normal") else {
        return;
    };
    let tree = Scratch::new("normal");
    let mut unrelated = Command::new("sleep").arg("30").spawn().unwrap();
    let (mut child, primary, worker, _) = start(&group, &tree);
    child.stdin.as_mut().unwrap().write_all(b"x").unwrap();
    let (code, stderr) = finish(&mut child);
    assert_eq!(code, Some(23), "{stderr}");
    assert!(
        !stderr.contains(FALLBACK),
        "no fallback diagnostic on cgroup success: {stderr}"
    );
    assert!(stderr.is_empty(), "{stderr}");
    assert!(
        !running(primary) && !running(worker),
        "owned member survived"
    );
    assert!(
        group.children().is_empty(),
        "owned workload group was not removed"
    );
    assert!(
        unrelated.try_wait().unwrap().is_none(),
        "unrelated process was hit"
    );
    unrelated.kill().unwrap();
    unrelated.wait().unwrap();
}

#[test]
fn owner_kills_and_removes_group_after_anchor_loss_within_deadline() {
    let Some(group) = TestGroup::create("failover") else {
        return;
    };
    let tree = Scratch::new("failover");
    let (mut child, primary, worker, anchor) = start(&group, &tree);
    let fault = Instant::now();
    rustix::process::kill_process(
        rustix::process::Pid::from_raw(anchor as i32).unwrap(),
        rustix::process::Signal::KILL,
    )
    .unwrap();
    let (code, stderr) = finish(&mut child);
    assert_eq!(code, Some(125), "{stderr}");
    assert!(fault.elapsed() < Duration::from_secs(2) + Duration::from_millis(500));
    assert!(
        !running(primary) && !running(worker),
        "owned member survived anchor loss"
    );
    assert!(
        group.children().is_empty(),
        "owned workload group was not removed"
    );
}

#[test]
fn nested_invocation_owns_a_group_inside_the_outer_group_and_both_are_removed() {
    let Some(group) = TestGroup::create("nested") else {
        return;
    };
    let tree = Scratch::new("nested");
    let mut child = group.spawn(&OPTIONS, &tree.0, true);
    let worker = tree.pid("cgroup-worker");
    let inner = tree.membership("cgroup-tree");
    let outer = format!("{}/procward-", group.line);
    // Outer group contains the inner owner/anchor; the inner payload is one level deeper.
    let (outer_group, inner_name) = inner.rsplit_once('/').unwrap();
    assert!(outer_group.starts_with(&outer), "{inner}");
    assert!(inner_name.starts_with("procward-"), "{inner}");
    assert_eq!(tree.membership("cgroup-worker"), inner);
    println!("CGROUP-REAL: nested payload before fork {inner}");
    child.stdin.as_mut().unwrap().write_all(b"x").unwrap();
    let (code, stderr) = finish(&mut child);
    assert_eq!(code, Some(23), "{stderr}");
    assert!(stderr.is_empty(), "{stderr}");
    assert!(!running(worker), "nested member survived");
    assert!(
        group.children().is_empty(),
        "owned workload groups were not removed"
    );
}

// N1: after owner SIGKILL the surviving anchor kills the group, confirms it empty, and
// removes it through the owner's parent handle; no empty procward-* group is left behind.
#[test]
fn surviving_anchor_removes_empty_group_after_owner_loss() {
    let Some(group) = TestGroup::create("owner-loss") else {
        return;
    };
    let tree = Scratch::new("owner-loss");
    let (mut child, primary, worker, anchor) = start(&group, &tree);
    let fault = Instant::now();
    child.kill().unwrap();
    child.wait().unwrap();
    poll("surviving anchor completion", || !running(anchor));
    assert!(fault.elapsed() < Duration::from_secs(2) + Duration::from_millis(500));
    assert!(
        !running(primary) && !running(worker),
        "owned member survived owner loss"
    );
    assert!(
        group.children().is_empty(),
        "surviving anchor left the empty workload group: {:?}",
        group.children()
    );
}
