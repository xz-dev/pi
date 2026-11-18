// SPDX-License-Identifier: BSD-3-Clause
#[cfg(unix)]
use std::io::Read;
use std::{
    ffi::OsStr,
    io::{self, Write},
};

pub const ENV: [&str; 6] = [
    "PROCWARD_PROTOCOL",
    "PROCWARD_OWNER_PID",
    "PROCWARD_LIFECYCLE_FD",
    "PROCWARD_LIFECYCLE_HANDLE",
    "PROCWARD_CONTRACT_ID",
    "PROCWARD_PRIMARY_PID",
];

pub struct Handoff {
    read: Option<std::fs::File>,
    write: Option<std::fs::File>,
    id: String,
}
impl Handoff {
    pub fn new() -> io::Result<Self> {
        let (read, write) = pipe()?;
        let mut bytes = [0u8; 16];
        #[cfg(unix)]
        std::fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::Security::Cryptography::{
                BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom,
            };
            if BCryptGenRandom(
                std::ptr::null_mut(),
                bytes.as_mut_ptr(),
                bytes.len() as u32,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            ) < 0
            {
                return Err(io::Error::other("contract identity generation failed"));
            }
        }
        Ok(Self {
            read: Some(read),
            write: Some(write),
            id: bytes.iter().map(|b| format!("{b:02x}")).collect(),
        })
    }
    pub fn environment(&self) -> io::Result<Vec<(&'static str, String)>> {
        let mut env = vec![
            ("PROCWARD_PROTOCOL", "1".into()),
            ("PROCWARD_OWNER_PID", std::process::id().to_string()),
            ("PROCWARD_CONTRACT_ID", self.id.clone()),
        ];
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            let read = self.read.as_ref().unwrap();
            rustix::io::fcntl_setfd(read, rustix::io::FdFlags::empty())?;
            env.push(("PROCWARD_LIFECYCLE_FD", read.as_raw_fd().to_string()));
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            env.push((
                "PROCWARD_LIFECYCLE_HANDLE",
                (self.read.as_ref().unwrap().as_raw_handle() as usize).to_string(),
            ));
        }
        Ok(env)
    }
    pub fn ready(&mut self, primary: u32) -> io::Result<()> {
        self.read.take();
        let record = format!(
            "PROCWARD/1 READY {} {primary} {} {}\n",
            std::process::id(),
            owner_identity()?,
            self.id
        );
        self.send(record.as_bytes())
    }
    pub fn owner_lost(&mut self) -> io::Result<()> {
        let record = format!("PROCWARD/1 OWNER-LOSS {}\n", self.id);
        let result = self.send(record.as_bytes());
        self.write.take();
        result
    }
    fn send(&mut self, bytes: &[u8]) -> io::Result<()> {
        assert!(bytes.len() <= 256);
        if let Some(write) = &mut self.write {
            // Two bounded records fit the fresh 4 KiB pipe; no application reply can block cleanup.
            if let Err(error) = write.write_all(bytes) {
                if error.kind() != io::ErrorKind::BrokenPipe {
                    return Err(error);
                }
                self.write.take();
            }
        }
        Ok(())
    }
}

#[cfg(unix)]
fn pipe() -> io::Result<(std::fs::File, std::fs::File)> {
    let (read, write) = crate::owner::pipe()?;
    Ok((read.into(), write.into()))
}
#[cfg(windows)]
fn pipe() -> io::Result<(std::fs::File, std::fs::File)> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::{
        Foundation::{HANDLE_FLAG_INHERIT, SetHandleInformation},
        Security::SECURITY_ATTRIBUTES,
        System::Pipes::CreatePipe,
    };
    let security = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: std::ptr::null_mut(),
        bInheritHandle: 1,
    };
    let (mut read, mut write) = (std::ptr::null_mut(), std::ptr::null_mut());
    if unsafe { CreatePipe(&mut read, &mut write, &security, 4096) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let read = unsafe { OwnedHandle::from_raw_handle(read) };
    let write = unsafe { OwnedHandle::from_raw_handle(write) };
    if unsafe { SetHandleInformation(write.as_raw_handle(), HANDLE_FLAG_INHERIT, 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((read.into(), write.into()))
}

#[cfg(unix)]
pub fn owner_identity() -> io::Result<String> {
    Ok("parent".into())
}
#[cfg(windows)]
pub fn owner_identity() -> io::Result<String> {
    use windows_sys::Win32::{
        Foundation::FILETIME,
        System::Threading::{GetCurrentProcess, GetProcessTimes},
    };
    let mut times: [FILETIME; 4] = unsafe { std::mem::zeroed() };
    if unsafe {
        GetProcessTimes(
            GetCurrentProcess(),
            &mut times[0],
            &mut times[1],
            &mut times[2],
            &mut times[3],
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(format!(
        "{:016x}",
        (u64::from(times[0].dwHighDateTime) << 32) | u64::from(times[0].dwLowDateTime)
    ))
}

// A nested procward replaces the application handoff; it never accepts it as an ownership opt-out.
pub fn discard_inherited() {
    #[cfg(unix)]
    if let Some(raw) = std::env::var("PROCWARD_LIFECYCLE_FD")
        .ok()
        .and_then(|value| value.parse::<i32>().ok())
        .filter(|raw| *raw > 2)
    {
        use std::os::fd::{BorrowedFd, FromRawFd, OwnedFd};
        let fd = unsafe { BorrowedFd::borrow_raw(raw) };
        if crate::owner::validate_endpoint(fd, rustix::fs::OFlags::RDONLY).is_ok() {
            drop(unsafe { OwnedFd::from_raw_fd(raw) });
        }
    }
    #[cfg(windows)]
    if let Some(raw) = std::env::var("PROCWARD_LIFECYCLE_HANDLE")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|raw| *raw != 0)
    {
        use std::os::windows::io::{FromRawHandle, OwnedHandle};
        use windows_sys::Win32::{
            Foundation::INVALID_HANDLE_VALUE,
            Storage::FileSystem::{FILE_TYPE_PIPE, GetFileType},
            System::Console::{
                GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
            },
        };
        let handle = raw as windows_sys::Win32::Foundation::HANDLE;
        unsafe {
            if handle != INVALID_HANDLE_VALUE
                && ![
                    GetStdHandle(STD_INPUT_HANDLE),
                    GetStdHandle(STD_OUTPUT_HANDLE),
                    GetStdHandle(STD_ERROR_HANDLE),
                ]
                .contains(&handle)
                && GetFileType(handle) == FILE_TYPE_PIPE
            {
                drop(OwnedHandle::from_raw_handle(handle));
            }
        }
    }
}

pub fn clear(command: &mut std::process::Command) {
    for name in ENV {
        command.env_remove(OsStr::new(name));
    }
}
