// SPDX-License-Identifier: BSD-3-Clause
use super::{Handle, fixture};
use std::{
    fs::File,
    io::{Read, Write},
    os::windows::io::FromRawHandle,
    ptr::{null, null_mut},
    sync::mpsc::{self, Receiver},
    thread,
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::*,
    System::{Console::*, Pipes::CreatePipe, Threading::*},
};

struct Console {
    pc: HPCON,
    input: File,
    output: Receiver<Vec<u8>>,
    transcript: String,
    process: Option<Handle>,
}

impl Console {
    fn start() -> Self {
        let mut input_read = null_mut();
        let mut input_write = null_mut();
        let mut output_read = null_mut();
        let mut output_write = null_mut();
        assert_ne!(
            unsafe { CreatePipe(&mut input_read, &mut input_write, null(), 0) },
            0
        );
        assert_ne!(
            unsafe { CreatePipe(&mut output_read, &mut output_write, null(), 0) },
            0
        );
        let mut pc = 0;
        let result = unsafe {
            CreatePseudoConsole(COORD { X: 80, Y: 24 }, input_read, output_write, 0, &mut pc)
        };
        let input = unsafe { File::from_raw_handle(input_write) };
        let mut output = unsafe { File::from_raw_handle(output_read) };
        assert_eq!(result, 0, "CreatePseudoConsole HRESULT {result:#x}");
        let (send, recv) = mpsc::channel();
        thread::spawn(move || {
            let mut bytes = [0; 4096];
            loop {
                match output.read(&mut bytes) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if send.send(bytes[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        });
        let mut console = Self {
            pc,
            input,
            output: recv,
            transcript: String::new(),
            process: None,
        };
        let mut size = 0;
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut size);
        }
        let mut attrs = vec![0usize; size.div_ceil(std::mem::size_of::<usize>())];
        let list = attrs.as_mut_ptr().cast();
        assert_ne!(
            unsafe { InitializeProcThreadAttributeList(list, 1, 0, &mut size) },
            0
        );
        assert_ne!(
            unsafe {
                UpdateProcThreadAttribute(
                    list,
                    0,
                    PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
                    pc as *const _,
                    std::mem::size_of::<HPCON>(),
                    null_mut(),
                    null(),
                )
            },
            0
        );
        let mut startup: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
        startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        startup.lpAttributeList = list;
        let command = format!(
            "\"{}\" conpty-bootstrap \"{}\"",
            fixture().display(),
            env!("CARGO_BIN_EXE_procward")
        );
        let mut wide: Vec<u16> = command.encode_utf16().chain([0]).collect();
        let mut info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
        let created = unsafe {
            CreateProcessW(
                null(),
                wide.as_mut_ptr(),
                null(),
                null(),
                0,
                EXTENDED_STARTUPINFO_PRESENT,
                null(),
                null(),
                &startup.StartupInfo,
                &mut info,
            )
        };
        let error = std::io::Error::last_os_error();
        unsafe {
            DeleteProcThreadAttributeList(list);
            CloseHandle(input_read);
            CloseHandle(output_write);
        }
        assert_ne!(created, 0, "CreateProcessW: {error}");
        unsafe {
            CloseHandle(info.hThread);
        }
        console.process = Some(Handle(info.hProcess));
        console
    }
    fn send(&mut self, bytes: &[u8]) -> usize {
        let cursor = self.transcript.len();
        self.input.write_all(bytes).unwrap();
        cursor
    }
    fn response(&mut self, cursor: usize, needles: &[&str], deadline: Instant) -> String {
        loop {
            let tail = &self.transcript[cursor..];
            if needles.iter().any(|needle| tail.contains(needle)) {
                return tail.to_string();
            }
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .unwrap_or_default();
            match self.output.recv_timeout(remaining) {
                Ok(bytes) => self.transcript.push_str(&String::from_utf8_lossy(&bytes)),
                Err(error) => panic!(
                    "ConPTY silence/EOF: {error}; transcript {:?}",
                    self.transcript
                ),
            }
        }
    }
}
impl Drop for Console {
    fn drop(&mut self) {
        if let Some(process) = &self.process {
            if !process.exited() {
                eprintln!(
                    "HARNESS RESCUE: terminating ConPTY owner; transcript {:?}",
                    self.transcript
                );
                unsafe {
                    TerminateProcess(process.0, 99);
                    WaitForSingleObject(process.0, 8000);
                }
                assert!(thread::panicking(), "ConPTY owner required rescue");
            }
        }
        unsafe {
            ClosePseudoConsole(self.pc);
        }
    }
}

#[test]
fn conpty_interrupt_and_response_driven_quit() {
    let mut console = Console::start();
    console.response(0, &["READY"], Instant::now() + Duration::from_secs(20));
    let cursor = console.send(b"quit\r");
    console.response(
        cursor,
        &["NOT_READY"],
        Instant::now() + Duration::from_secs(5),
    );
    console.send(b"\x03");
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let cursor = console.send(b"status\r");
        let reply = console.response(cursor, &["SEEN 1 0", "NOT_READY"], deadline);
        if reply.contains("SEEN") {
            assert!(reply.contains("SEEN 1 0"), "{reply:?}");
            break;
        }
        assert!(Instant::now() < deadline, "endless not-ready hints");
    }
    let cursor = console.send(b"quit\r");
    console.response(cursor, &["BYE"], Instant::now() + Duration::from_secs(5));
    let process = console.process.as_ref().unwrap();
    assert_eq!(
        unsafe { WaitForSingleObject(process.0, 8000) },
        WAIT_OBJECT_0
    );
    let mut code = 0;
    assert_ne!(unsafe { GetExitCodeProcess(process.0, &mut code) }, 0);
    assert_eq!(code, 23);
}
