// SPDX-License-Identifier: BSD-3-Clause
// Linux cgroup v2 workload group, created only inside this owner's own current group.
use rustix::{
    fd::{AsRawFd, BorrowedFd, FromRawFd, OwnedFd},
    fs::{self, AtFlags, Mode, OFlags},
    io::{self as rio, FdFlags},
};
use std::{io, os::unix::process::CommandExt, path::PathBuf, process::Command};

pub const ENV: &str = "PROCWARD_PRIVATE_CGROUP";
const CGROUP2_SUPER_MAGIC: i64 = 0x6367_7270;

pub struct Scope {
    dir: OwnedFd,
    path: PathBuf,
    // The creating owner removes the group through its retained parent handle.
    removal: Option<(OwnedFd, String)>,
    // The anchor holds the same parent/name authority, armed only after owner loss.
    orphan: Option<(OwnedFd, String)>,
}

impl Scope {
    // Err carries the visible reason the weaker backend is selected.
    pub fn create() -> Result<Self, String> {
        let parent_path = current().map_err(|error| format!("no cgroup v2 location: {error}"))?;
        let parent = open_group(None, parent_path.as_os_str())
            .map_err(|error| format!("{}: {error}", parent_path.display()))?;
        let nanos = crate::policy::now().as_nanos();
        let name = format!("procward-{}-{nanos}", std::process::id());
        fs::mkdirat(&parent, name.as_str(), Mode::from_raw_mode(0o755))
            .map_err(|error| format!("cannot create in {}: {error}", parent_path.display()))?;
        let opened = open_group(Some(&parent), name.as_ref());
        let path = parent_path.join(&name);
        let dir = match opened {
            Ok(dir) => dir,
            Err(error) => {
                let _ = fs::unlinkat(&parent, name.as_str(), AtFlags::REMOVEDIR);
                return Err(format!("{}: {error}", path.display()));
            }
        };
        // From here, dropping the scope removes the new group.
        let scope = Self {
            dir,
            path,
            removal: Some((parent, name)),
            orphan: None,
        };
        // The new group is empty, so this proves cgroup.kill without killing anything.
        scope
            .kill()
            .map_err(|error| format!("cgroup.kill unusable: {error}"))?;
        scope.probe_membership()?;
        Ok(scope)
    }

    // The anchor receives the owner's group handle plus the parent handle and name; it may
    // kill the group, and removes it only if the owner is lost (see `arm_orphan_removal`).
    pub fn inherited() -> io::Result<Option<Self>> {
        let Some((dir, removal)) = take_env()? else {
            return Ok(None);
        };
        rio::fcntl_setfd(&dir, FdFlags::CLOEXEC)?;
        let orphan = match removal {
            Some((parent, name)) => {
                rio::fcntl_setfd(&parent, FdFlags::CLOEXEC)?;
                // Only the owner's own procward-* child named by the parent handle is removable.
                let named = fs::statat(&parent, name.as_str(), AtFlags::SYMLINK_NOFOLLOW)?;
                let held = fs::fstat(&dir)?;
                if !name.starts_with("procward-")
                    || name.contains('/')
                    || fs::fstatfs(&parent)?.f_type as i64 != CGROUP2_SUPER_MAGIC
                    || (named.st_dev, named.st_ino) != (held.st_dev, held.st_ino)
                {
                    return Err(io::Error::other(
                        "inherited workload group removal authority does not match",
                    ));
                }
                Some((parent, name))
            }
            None => None,
        };
        Ok(Some(Self {
            dir,
            path: PathBuf::from("inherited workload group"),
            removal: None,
            orphan,
        }))
    }

    // After owner loss and confirmed-empty cleanup, the surviving anchor removes the group.
    pub fn arm_orphan_removal(&mut self) {
        if self.removal.is_none() {
            self.removal = self.orphan.take();
        }
    }

    pub fn kill(&self) -> io::Result<()> {
        let file = fs::openat(
            &self.dir,
            "cgroup.kill",
            OFlags::WRONLY | OFlags::CLOEXEC,
            Mode::empty(),
        )?;
        write_all(&file, b"1")
    }

    pub fn populated(&self) -> io::Result<bool> {
        let file = fs::openat(
            &self.dir,
            "cgroup.events",
            OFlags::RDONLY | OFlags::CLOEXEC,
            Mode::empty(),
        )?;
        let mut text = Vec::new();
        let mut bytes = [0; 256];
        loop {
            match rio::read(&file, &mut bytes)? {
                0 => break,
                count => text.extend_from_slice(&bytes[..count]),
            }
        }
        let text = String::from_utf8_lossy(&text);
        match text
            .lines()
            .find_map(|line| line.strip_prefix("populated "))
        {
            Some("0") => Ok(false),
            Some("1") => Ok(true),
            _ => Err(io::Error::other("invalid cgroup.events")),
        }
    }

    // Lets a trusted procward stage join this group before any untrusted exec.
    pub fn pass(&self, command: &mut Command) {
        let raw = self.dir.as_raw_fd();
        command.env(ENV, raw.to_string());
        inherit(command, raw);
    }

    // The owner's anchor also receives removal authority for the owner-loss path.
    pub fn pass_to_anchor(&self, command: &mut Command) {
        let Some((parent, name)) = &self.removal else {
            return self.pass(command);
        };
        let (raw, parent_raw) = (self.dir.as_raw_fd(), parent.as_raw_fd());
        command.env(ENV, format!("{raw}:{parent_raw}:{name}"));
        inherit(command, raw);
        inherit(command, parent_raw);
    }

    fn probe_membership(&self) -> Result<(), String> {
        let mut probe = Command::new(std::env::current_exe().map_err(|error| error.to_string())?);
        probe
            .arg("__cgroup_exec")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped());
        self.pass(&mut probe);
        let output = probe.output().map_err(|error| error.to_string())?;
        if output.status.success() {
            return Ok(());
        }
        let message = String::from_utf8_lossy(&output.stderr);
        let message = message.trim().trim_start_matches("procward: ");
        Err(format!("cannot move work into group: {message}"))
    }
}

impl Drop for Scope {
    fn drop(&mut self) {
        let Some((parent, name)) = &self.removal else {
            return;
        };
        // Owner and surviving anchor may both remove: an already-removed group is success.
        let removed = remove_children(&self.dir).and_then(|()| {
            match fs::unlinkat(parent, name.as_str(), AtFlags::REMOVEDIR) {
                Ok(()) | Err(rio::Errno::NOENT) => Ok(()),
                Err(error) => Err(error.into()),
            }
        });
        if let Err(error) = removed {
            crate::diagnostic(format!(
                "Linux workload group {} was left in place: {error}",
                self.path.display()
            ));
        }
    }
}

// Trusted stage: join the workload group, then exec the payload without a shell fallback.
pub fn exec(args: &[std::ffi::OsString]) -> io::Result<u8> {
    if !join()? {
        return Err(io::Error::other("missing workload group handle"));
    }
    let [command, rest @ ..] = args else {
        // Owner membership probe: joined and exits at once.
        return Ok(0);
    };
    // Match the direct std spawn this stage replaces: empty mask, default SIGPIPE.
    unsafe {
        let mut empty = std::mem::zeroed();
        libc::sigemptyset(&mut empty);
        if libc::sigprocmask(libc::SIG_SETMASK, &empty, std::ptr::null_mut()) != 0 {
            return Err(io::Error::last_os_error());
        }
        libc::signal(libc::SIGPIPE, libc::SIG_DFL);
    }
    let result = crate::terminal::exec_payload(command, rest);
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }
    result
}

// Joins the passed group if present, closing its handle before the caller may exec.
pub fn join() -> io::Result<bool> {
    let Some((dir, removal)) = take_env()? else {
        return Ok(false);
    };
    if removal.is_some() {
        return Err(io::Error::other(
            "workload stage received removal authority",
        ));
    }
    let procs = fs::openat(
        &dir,
        "cgroup.procs",
        OFlags::WRONLY | OFlags::CLOEXEC,
        Mode::empty(),
    )?;
    write_all(&procs, std::process::id().to_string().as_bytes())?;
    Ok(true)
}

// Only async-signal-safe fcntl runs between fork and trusted native exec.
fn inherit(command: &mut Command, raw: i32) {
    unsafe {
        command.pre_exec(move || {
            rio::fcntl_setfd(BorrowedFd::borrow_raw(raw), FdFlags::empty())?;
            Ok(())
        });
    }
}

// `<group fd>` for a workload stage, `<group fd>:<parent fd>:<name>` for the anchor.
type Passed = (OwnedFd, Option<(OwnedFd, String)>);
fn take_env() -> io::Result<Option<Passed>> {
    let Some(value) = std::env::var_os(ENV) else {
        return Ok(None);
    };
    let invalid = || io::Error::other("invalid workload group handle");
    let text = value.to_str().ok_or_else(invalid)?;
    let mut parts = text.splitn(3, ':');
    let dir = take_dir_fd(parts.next().ok_or_else(invalid)?)?;
    let removal = match (parts.next(), parts.next()) {
        (None, None) => None,
        (Some(parent), Some(name)) => Some((take_dir_fd(parent)?, name.to_owned())),
        _ => return Err(invalid()),
    };
    Ok(Some((dir, removal)))
}

fn take_dir_fd(text: &str) -> io::Result<OwnedFd> {
    let raw = text
        .parse::<i32>()
        .ok()
        .filter(|raw| *raw > 2)
        .ok_or_else(|| io::Error::other("invalid workload group handle"))?;
    let borrowed = unsafe { BorrowedFd::borrow_raw(raw) };
    let stat = fs::fstat(borrowed)?;
    if fs::FileType::from_raw_mode(stat.st_mode) != fs::FileType::Directory
        || fs::fstatfs(borrowed)?.f_type as i64 != CGROUP2_SUPER_MAGIC
    {
        return Err(io::Error::other(
            "workload group handle is not a cgroup v2 directory",
        ));
    }
    Ok(unsafe { OwnedFd::from_raw_fd(raw) })
}

fn open_group(parent: Option<&OwnedFd>, path: &std::ffi::OsStr) -> io::Result<OwnedFd> {
    let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    let dir = match parent {
        Some(parent) => fs::openat(parent, path, flags, Mode::empty())?,
        None => fs::open(path, flags, Mode::empty())?,
    };
    if fs::fstatfs(&dir)?.f_type as i64 != CGROUP2_SUPER_MAGIC {
        return Err(io::Error::other("not a cgroup v2 directory"));
    }
    Ok(dir)
}

// Nested groups made by work inside the scope are removed deepest first, never followed out.
fn remove_children(dir: &OwnedFd) -> io::Result<()> {
    let mut names = Vec::new();
    for entry in fs::Dir::read_from(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_owned();
        if entry.file_type() == fs::FileType::Directory && !matches!(name.to_bytes(), b"." | b"..")
        {
            names.push(name);
        }
    }
    for name in names {
        let child = open_group(
            Some(dir),
            std::ffi::OsStr::new(name.to_str().map_err(io::Error::other)?),
        )?;
        remove_children(&child)?;
        fs::unlinkat(dir, name.as_c_str(), AtFlags::REMOVEDIR)?;
    }
    Ok(())
}

fn write_all(file: &OwnedFd, bytes: &[u8]) -> io::Result<()> {
    if rio::write(file, bytes)? != bytes.len() {
        return Err(io::Error::other("partial cgroup interface write"));
    }
    Ok(())
}

// The owner's own group path below the cgroup v2 mount that contains it.
fn current() -> io::Result<PathBuf> {
    let membership = std::fs::read_to_string("/proc/self/cgroup")?;
    let own = membership
        .lines()
        .find_map(|line| line.strip_prefix("0::"))
        .filter(|path| path.starts_with('/') && !path.ends_with(" (deleted)"))
        .ok_or_else(|| io::Error::other("no unified hierarchy membership"))?;
    let mounts = std::fs::read_to_string("/proc/self/mountinfo")?;
    locate(own, &mounts).ok_or_else(|| io::Error::other("no visible cgroup2 mount"))
}

fn locate(own: &str, mountinfo: &str) -> Option<PathBuf> {
    mountinfo.lines().find_map(|line| {
        let (fields, filesystem) = line.split_once(" - ")?;
        if filesystem.split_whitespace().next()? != "cgroup2" {
            return None;
        }
        let mut fields = fields.split_whitespace().skip(3);
        let root = unescape(fields.next()?);
        let mount = unescape(fields.next()?);
        let relative = if root == "/" {
            own.strip_prefix('/')?
        } else {
            let rest = own.strip_prefix(root.as_str())?;
            if !rest.is_empty() && !rest.starts_with('/') {
                return None;
            }
            rest.trim_start_matches('/')
        };
        if relative.split('/').any(|part| part == "..") {
            return None;
        }
        Some(PathBuf::from(mount).join(relative))
    })
}

// mountinfo octal-escapes space, tab, newline and backslash.
fn unescape(field: &str) -> String {
    let bytes = field.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'\\' && index + 3 < bytes.len() {
            let digits = std::str::from_utf8(&bytes[index + 1..index + 4]).unwrap_or("");
            if let Ok(value) = u8::from_str_radix(digits, 8) {
                out.push(value);
                index += 4;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn own_group_is_found_below_the_cgroup2_mount_root() {
        let info = "30 1 0:26 / /sys/fs/cgroup rw - cgroup2 cgroup2 rw\n";
        assert_eq!(
            locate("/user.slice/a b", info),
            Some(PathBuf::from("/sys/fs/cgroup/user.slice/a b"))
        );
        let nested = "31 1 0:26 /ns /mnt/c\\040g rw - cgroup2 none rw\n";
        assert_eq!(
            locate("/ns/job", nested),
            Some(PathBuf::from("/mnt/c g/job"))
        );
        assert_eq!(locate("/nsx/job", nested), None);
        assert_eq!(locate("/x", "32 1 0:3 / /proc rw - proc proc rw\n"), None);
        assert_eq!(locate("/a/../b", info), None);
    }
}
