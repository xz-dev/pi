// SPDX-License-Identifier: BSD-3-Clause
//! Enumerate pipe objects for caller hygiene and the payload's isolation assertion.
use std::io;

#[cfg(unix)]
pub fn open(_include_stdio: bool) -> io::Result<Vec<usize>> {
    use rustix::{
        fd::BorrowedFd,
        fs::{FileType, fstat},
        io::Errno,
    };
    #[cfg(target_os = "freebsd")]
    let descriptors = {
        // FreeBSD's default devfs /dev/fd lists only 0, 1 and 2; scan the actual limit.
        let limit = rustix::process::getrlimit(rustix::process::Resource::Nofile)
            .current
            .and_then(|value| i32::try_from(value).ok())
            .ok_or_else(|| io::Error::other("cannot enumerate unbounded descriptor table"))?;
        (3..limit).collect::<Vec<_>>()
    };
    #[cfg(not(target_os = "freebsd"))]
    let descriptors = {
        let directory = if cfg!(target_os = "linux") {
            "/proc/self/fd"
        } else {
            "/dev/fd"
        };
        std::fs::read_dir(directory)?
            .map(|entry| {
                entry?
                    .file_name()
                    .to_string_lossy()
                    .parse::<i32>()
                    .map_err(io::Error::other)
            })
            .collect::<io::Result<Vec<_>>>()?
    };
    let mut pipes = Vec::new();
    for fd in descriptors.into_iter().filter(|fd| *fd > 2) {
        match fstat(unsafe { BorrowedFd::borrow_raw(fd) }) {
            Ok(stat) if FileType::from_raw_mode(stat.st_mode) == FileType::Fifo => {
                pipes.push(fd as usize)
            }
            Ok(_) | Err(Errno::BADF) => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(pipes)
}

#[cfg(windows)]
pub fn open(include_stdio: bool) -> io::Result<Vec<usize>> {
    use windows_sys::Win32::{
        Foundation::{CompareObjectHandles, ERROR_NO_MORE_ITEMS, ERROR_SUCCESS},
        Storage::FileSystem::{FILE_TYPE_PIPE, GetFileType},
        System::{
            Console::{GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE},
            Diagnostics::ProcessSnapshotting::*,
            Threading::GetCurrentProcess,
        },
    };
    unsafe {
        let mut snapshot = std::ptr::null_mut();
        let result = PssCaptureSnapshot(GetCurrentProcess(), PSS_CAPTURE_HANDLES, 0, &mut snapshot);
        if result != ERROR_SUCCESS {
            return Err(io::Error::from_raw_os_error(result as i32));
        }
        let mut marker = std::ptr::null_mut();
        let result = PssWalkMarkerCreate(std::ptr::null(), &mut marker);
        if result != ERROR_SUCCESS {
            PssFreeSnapshot(GetCurrentProcess(), snapshot);
            return Err(io::Error::from_raw_os_error(result as i32));
        }
        let stdio = [
            GetStdHandle(STD_INPUT_HANDLE),
            GetStdHandle(STD_OUTPUT_HANDLE),
            GetStdHandle(STD_ERROR_HANDLE),
        ];
        let mut pipes = Vec::new();
        let result = loop {
            let mut entry = PSS_HANDLE_ENTRY::default();
            let result = PssWalkSnapshot(
                snapshot,
                PSS_WALK_HANDLES,
                marker,
                (&mut entry as *mut PSS_HANDLE_ENTRY).cast(),
                std::mem::size_of_val(&entry) as u32,
            );
            if result == ERROR_NO_MORE_ITEMS {
                break Ok(());
            }
            if result != ERROR_SUCCESS {
                break Err(io::Error::from_raw_os_error(result as i32));
            }
            // Rust duplicates inherited stdio at each spawn; compare objects, not HANDLE numbers.
            let is_stdio = stdio
                .iter()
                .any(|standard| CompareObjectHandles(entry.Handle, *standard) != 0);
            if (include_stdio || !is_stdio) && GetFileType(entry.Handle) == FILE_TYPE_PIPE {
                pipes.push(entry.Handle as usize);
            }
        };
        assert_eq!(PssWalkMarkerFree(marker), ERROR_SUCCESS);
        assert_eq!(
            PssFreeSnapshot(GetCurrentProcess(), snapshot),
            ERROR_SUCCESS
        );
        result?;
        Ok(pipes)
    }
}
