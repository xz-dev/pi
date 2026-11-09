// SPDX-License-Identifier: BSD-3-Clause
use std::{
    fs::File,
    io::{self, Read, Write},
    time::{Duration, Instant},
};

pub struct Task {
    transport: File,
    input: Vec<u8>,
    output: Vec<u8>,
    cancel: bool,
    invalid: bool,
    result: Option<u32>,
}
impl Task {
    pub fn open(raw: u64) -> io::Result<Self> {
        #[cfg(unix)]
        let transport = {
            use std::os::fd::FromRawFd;
            let raw = i32::try_from(raw)
                .ok()
                .filter(|n| *n > 2)
                .ok_or_else(|| io::Error::other("invalid control fd"))?;
            rustix::io::fcntl_getfd(unsafe { std::os::fd::BorrowedFd::borrow_raw(raw) })?;
            let file = unsafe { File::from_raw_fd(raw) };
            rustix::io::fcntl_setfd(&file, rustix::io::FdFlags::CLOEXEC)?;
            if rustix::net::sockopt::socket_type(&file)? != rustix::net::SocketType::STREAM
                || rustix::net::getsockname(&file)?.address_family()
                    != rustix::net::AddressFamily::UNIX
            {
                return Err(io::Error::other("control fd must be a Unix stream socket"));
            }
            rustix::fs::fcntl_setfl(&file, rustix::fs::OFlags::NONBLOCK)?;
            file
        };
        #[cfg(windows)]
        let transport = {
            use std::os::windows::io::{AsRawHandle, FromRawHandle};
            use windows_sys::Win32::{
                Foundation::{HANDLE_FLAG_INHERIT, SetHandleInformation},
                Storage::FileSystem::WriteFile,
                System::Pipes::{PIPE_NOWAIT, PeekNamedPipe, SetNamedPipeHandleState},
            };
            let raw = usize::try_from(raw)
                .ok()
                .filter(|n| *n != 0)
                .ok_or_else(|| io::Error::other("invalid control handle"))?;
            let mut flags = 0;
            if unsafe { windows_sys::Win32::Foundation::GetHandleInformation(raw as _, &mut flags) }
                == 0
            {
                return Err(io::Error::last_os_error());
            }
            let file = unsafe { File::from_raw_handle(raw as _) };
            let mode = PIPE_NOWAIT;
            let mut available = 0;
            let mut written = 0;
            if unsafe { SetHandleInformation(file.as_raw_handle(), HANDLE_FLAG_INHERIT, 0) } == 0
                || unsafe {
                    SetNamedPipeHandleState(
                        file.as_raw_handle(),
                        &mode,
                        std::ptr::null(),
                        std::ptr::null(),
                    )
                } == 0
                || unsafe {
                    PeekNamedPipe(
                        file.as_raw_handle(),
                        std::ptr::null_mut(),
                        0,
                        std::ptr::null_mut(),
                        &mut available,
                        std::ptr::null_mut(),
                    )
                } == 0
                || unsafe {
                    WriteFile(
                        file.as_raw_handle(),
                        std::ptr::null(),
                        0,
                        &mut written,
                        std::ptr::null_mut(),
                    )
                } == 0
            {
                return Err(io::Error::last_os_error());
            }
            file
        };
        let mut task = Self {
            transport,
            input: Vec::new(),
            output: Vec::new(),
            cancel: false,
            invalid: false,
            result: None,
        };
        task.record(&format!("S {} {}", std::process::id(), scope()))?;
        Ok(task)
    }
    fn record(&mut self, payload: &str) -> io::Result<()> {
        self.output
            .extend_from_slice(format!("PROCWARD/1 {payload}\n").as_bytes());
        if self.output.len() > 1024 {
            return Err(io::Error::other("task output bound exceeded"));
        }
        self.flush()
    }
    fn flush(&mut self) -> io::Result<()> {
        if !self.output.is_empty() {
            match self.transport.write(&self.output) {
                Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
                Ok(count) => {
                    self.output.drain(..count);
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                    ) => {}
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }
    pub fn primary(&mut self, result: u32) -> io::Result<()> {
        if self.result.is_none() {
            self.result = Some(result);
            self.record(&format!("X {result}"))?;
        } else if self.result != Some(result) {
            return Err(io::Error::other("conflicting primary result"));
        }
        Ok(())
    }
    pub fn poll(&mut self) -> bool {
        if self.cancel {
            return true;
        }
        let mut bytes = [0; 257];
        match self.read_available(&mut bytes) {
            Ok(0) => {
                self.invalid |= !self.input.is_empty();
                self.cancel = true;
            }
            Ok(count) => {
                self.input.extend_from_slice(&bytes[..count]);
                if self.input.len() > 256 {
                    self.invalid = true;
                    self.cancel = true;
                } else if let Some(end) = self.input.iter().position(|b| *b == b'\n') {
                    self.invalid = &self.input[..=end] != b"PROCWARD/1 CANCEL\n"
                        || end + 1 != self.input.len();
                    self.cancel = true;
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) => {}
            Err(_) => {
                self.invalid = true;
                self.cancel = true;
            }
        }
        if self.flush().is_err() {
            self.cancel = true;
        }
        self.cancel
    }
    #[cfg(unix)]
    fn read_available(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.transport.read(bytes)
    }
    #[cfg(windows)]
    fn read_available(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{Foundation::ERROR_BROKEN_PIPE, System::Pipes::PeekNamedPipe};
        let mut available = 0;
        if unsafe {
            PeekNamedPipe(
                self.transport.as_raw_handle(),
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                &mut available,
                std::ptr::null_mut(),
            )
        } == 0
        {
            let error = io::Error::last_os_error();
            return if error.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) {
                Ok(0)
            } else {
                Err(error)
            };
        }
        if available == 0 {
            return Err(io::ErrorKind::WouldBlock.into());
        }
        let count = bytes.len().min(available as usize);
        self.transport.read(&mut bytes[..count])
    }
    pub fn complete(&mut self, result: Option<u32>, deadline: Duration) -> io::Result<()> {
        let confirmed = result.is_some() && result == self.result;
        if confirmed && !self.invalid {
            self.record(&format!("C {}", scope()))?;
        } else {
            self.record("E 125")?;
        }
        let limit = Instant::now() + deadline;
        while !self.output.is_empty() {
            self.flush()?;
            if Instant::now() >= limit {
                return Err(io::Error::other("task transport drain deadline"));
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        if self.invalid || (result.is_some() && !confirmed) {
            return Err(io::Error::other(
                "task primary result or valid control missing",
            ));
        }
        Ok(())
    }
}
fn scope() -> &'static str {
    if cfg!(target_os = "macos") {
        "best-effort"
    } else {
        "kernel"
    }
}
