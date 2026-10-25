//! FreeBSD overrides an rfork exit signal when the parent is also its reaper.
//! A kernel socket-AIO EOF completion instead wakes only this owning process.

use std::cell::UnsafeCell;
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant};

struct Request {
    io: Box<UnsafeCell<libc::aiocb>>,
    _buffer: Box<UnsafeCell<[u8; 1]>>,
}
pub(super) struct ExitWake {
    stream: UnixStream,
    request: Option<Request>,
    queued: bool,
}
impl ExitWake {
    pub(super) fn pair() -> io::Result<(Self, UnixStream)> {
        let (stream, guardian) = UnixStream::pair()?;
        let buffer = Box::new(UnsafeCell::new([0]));
        let io = Box::new(UnsafeCell::new(unsafe {
            std::mem::zeroed::<libc::aiocb>()
        }));
        // Both allocations remain stable until aio_return confirms the kernel released them.
        unsafe {
            (*io.get()).aio_fildes = stream.as_raw_fd();
            (*io.get()).aio_buf = buffer.get().cast();
            (*io.get()).aio_nbytes = 1;
            (*io.get()).aio_sigevent.sigev_notify = libc::SIGEV_SIGNAL;
            (*io.get()).aio_sigevent.sigev_signo = libc::SIGCONT;
        }
        Ok((
            Self {
                stream,
                request: Some(Request {
                    io,
                    _buffer: buffer,
                }),
                queued: false,
            },
            guardian,
        ))
    }
    pub(super) fn arm(&mut self) -> io::Result<()> {
        if unsafe { libc::aio_read(self.request.as_ref().unwrap().io.get()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        self.queued = true;
        Ok(())
    }
    pub(super) fn check(&mut self) -> io::Result<()> {
        if !self.queued {
            return Ok(());
        }
        let ptr = self.request.as_ref().unwrap().io.get();
        let error = unsafe { libc::aio_error(ptr) };
        if error == libc::EINPROGRESS {
            return Ok(());
        }
        if error < 0 {
            return Err(io::Error::last_os_error());
        }
        let result = unsafe { libc::aio_return(ptr) };
        self.queued = false;
        if error != 0 && error != libc::ECANCELED {
            return Err(io::Error::from_raw_os_error(error));
        }
        if error == 0 && result != 0 {
            return Err(io::Error::other("unexpected guardian lifetime data"));
        }
        Ok(())
    }
    pub(super) fn finish(&mut self) -> io::Result<()> {
        if !self.queued {
            return Ok(());
        }
        let ptr = self.request.as_ref().unwrap().io.get();
        if unsafe { libc::aio_error(ptr) } == libc::EINPROGRESS {
            if unsafe { libc::aio_cancel(self.stream.as_raw_fd(), ptr) } < 0 {
                return Err(io::Error::last_os_error());
            }
        }
        let deadline = Instant::now() + Duration::from_millis(250);
        while unsafe { libc::aio_error(ptr) } == libc::EINPROGRESS {
            if Instant::now() >= deadline {
                // An uncancellable request still owns these addresses until process exit.
                // Never free/reuse them and turn a teardown error into kernel memory corruption.
                std::mem::forget(self.request.take());
                self.queued = false;
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "guardian wake AIO cancellation unconfirmed",
                ));
            }
            let list = [ptr as *const libc::aiocb];
            let timeout = libc::timespec {
                tv_sec: 0,
                tv_nsec: 10_000_000,
            };
            let result = unsafe { libc::aio_suspend(list.as_ptr(), 1, &timeout) };
            if result < 0
                && !matches!(
                    io::Error::last_os_error().raw_os_error(),
                    Some(libc::EINTR | libc::EAGAIN)
                )
            {
                // Keep polling to retain memory until completion, including on API errors.
                continue;
            }
        }
        self.check()
    }
}
impl Drop for ExitWake {
    fn drop(&mut self) {
        if let Err(error) = self.finish() {
            // run() propagates explicit finish errors; this also covers early setup returns.
            eprintln!("pi-env: guardian wake cleanup failed: {error}");
            if self.queued {
                std::mem::forget(self.request.take());
                self.queued = false;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    #[test]
    fn socket_aio_cancel_and_eof_use_default_policy() {
        // SIGCONT has its normal continue effect even if blocked; keep it blocked here
        // so this unit entry never interferes with any other test's signal handler.
        let mut set: libc::sigset_t = unsafe { std::mem::zeroed() };
        let mut previous = unsafe { std::mem::zeroed() };
        unsafe {
            libc::sigemptyset(&mut set);
            libc::sigaddset(&mut set, libc::SIGCONT);
            libc::sigprocmask(libc::SIG_BLOCK, &set, &mut previous);
        }
        let (mut wake, guardian) = ExitWake::pair().unwrap();
        wake.arm()
            .expect("default-policy AF_UNIX AIO must be available without sysctl changes");
        wake.check().unwrap();
        wake.finish().unwrap();
        drop(guardian);
        let (mut wake, guardian) = ExitWake::pair().unwrap();
        wake.arm().unwrap();
        drop(guardian);
        let deadline = Instant::now() + Duration::from_secs(1);
        while unsafe { libc::aio_error(wake.request.as_ref().unwrap().io.get()) }
            == libc::EINPROGRESS
        {
            assert!(Instant::now() < deadline);
            std::thread::yield_now();
        }
        wake.check().unwrap();
        let (mut wake, mut guardian) = ExitWake::pair().unwrap();
        wake.arm().unwrap();
        guardian.write_all(b"x").unwrap();
        let deadline = Instant::now() + Duration::from_secs(1);
        while unsafe { libc::aio_error(wake.request.as_ref().unwrap().io.get()) }
            == libc::EINPROGRESS
        {
            assert!(Instant::now() < deadline);
            std::thread::yield_now();
        }
        assert!(
            wake.check().is_err(),
            "lifetime stream may complete only at EOF"
        );
        unsafe {
            libc::sigprocmask(libc::SIG_SETMASK, &previous, std::ptr::null_mut());
        }
    }
}
