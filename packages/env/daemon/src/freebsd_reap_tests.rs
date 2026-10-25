//! FreeBSD's exit notification precedes reaper adoption (kern_exit.c:508,977).
//! Run that ordering with real stopped children; this models syscalls, not a FreeBSD run.

use super::*;
use std::os::fd::AsRawFd;
use std::sync::atomic::AtomicI32;
use std::time::{Duration, Instant};

static HOOK_FD: AtomicI32 = AtomicI32::new(-1);
extern "C" fn shutdown_hook(_: i32) {
    unsafe {
        libc::write(HOOK_FD.load(Ordering::Relaxed), b"H".as_ptr().cast(), 1);
        libc::_exit(0);
    }
}

struct HeldChild {
    pid: i32,
    channel: UnixStream,
    lifetime: Option<UnixStream>,
}
impl HeldChild {
    fn start(outer: bool) -> Self {
        let (channel, child) = UnixStream::pair().unwrap();
        let (lifetime, eof) = UnixStream::pair().unwrap();
        let pid = unsafe { libc::fork() };
        assert!(pid >= 0);
        if pid == 0 {
            // Sole post-fork thread: only signal/FD syscalls, then _exit; no libtest locks.
            unsafe {
                libc::close(channel.as_raw_fd());
                libc::close(lifetime.as_raw_fd());
                if libc::setpgid(0, 0) != 0 {
                    libc::_exit(125);
                }
                let mut mask: libc::sigset_t = std::mem::zeroed();
                libc::sigemptyset(&mut mask);
                if libc::sigprocmask(libc::SIG_SETMASK, &mask, std::ptr::null_mut()) != 0 {
                    libc::_exit(125);
                }
                let mut action: libc::sigaction = std::mem::zeroed();
                libc::sigemptyset(&mut action.sa_mask);
                action.sa_sigaction = libc::SIG_DFL;
                for signal in [
                    libc::SIGTSTP,
                    libc::SIGCONT,
                    libc::SIGTTIN,
                    libc::SIGTTOU,
                    libc::SIGTERM,
                ] {
                    if libc::sigaction(signal, &action, std::ptr::null_mut()) != 0 {
                        libc::_exit(125);
                    }
                }
                let fd = child.as_raw_fd();
                if outer {
                    if protect_outer_tty().is_err() {
                        libc::_exit(125);
                    }
                } else {
                    HOOK_FD.store(fd, Ordering::Relaxed);
                    action.sa_sigaction = shutdown_hook as *const () as usize;
                    action.sa_flags = libc::SA_RESTART;
                    if libc::sigaction(libc::SIGTERM, &action, std::ptr::null_mut()) != 0 {
                        libc::_exit(125);
                    }
                }
                libc::write(fd, b"R".as_ptr().cast(), 1);
                let mut byte = 0u8;
                if outer {
                    // The anchor closes its FD before becoming waitable. AIO emits one CONT.
                    if libc::read(eof.as_raw_fd(), (&mut byte as *mut u8).cast(), 1) != 0 {
                        libc::_exit(125);
                    }
                    libc::write(fd, b"E".as_ptr().cast(), 1);
                }
                if libc::read(fd, (&mut byte as *mut u8).cast(), 1) != 1 {
                    libc::_exit(125);
                }
                // A resumed primary with unchanged ppid would restart its TUI here.
                libc::write(fd, if outer { b"D" } else { b"U" }.as_ptr().cast(), 1);
                libc::_exit(0);
            }
        }
        drop(child);
        drop(eof);
        let mut held = Self {
            pid,
            channel,
            lifetime: Some(lifetime),
        };
        held.channel
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        let mut ready = [0];
        held.channel.read_exact(&mut ready).unwrap();
        assert_eq!(&ready, b"R");
        held
    }
    fn signal(&self, signal: i32) {
        assert_eq!(unsafe { libc::kill(self.pid, signal) }, 0);
    }
    fn pause(&self) {
        self.signal(libc::SIGTSTP);
        let deadline = Instant::now() + Duration::from_secs(1);
        loop {
            let mut status = 0;
            let got =
                unsafe { libc::waitpid(self.pid, &mut status, libc::WNOHANG | libc::WUNTRACED) };
            assert!(got >= 0);
            if got == self.pid {
                assert!(libc::WIFSTOPPED(status));
                assert_eq!(libc::WSTOPSIG(status), libc::SIGTSTP);
                return;
            }
            assert!(Instant::now() < deadline, "outer lost default TSTP");
            std::thread::sleep(Duration::from_millis(1));
        }
    }
}
impl Drop for HeldChild {
    fn drop(&mut self) {
        // PID is still an unreaped direct child. Failure cleanup never rescues with CONT.
        unsafe {
            libc::kill(self.pid, libc::SIGKILL);
            while libc::waitpid(self.pid, std::ptr::null_mut(), 0) < 0 {
                if io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
                    break;
                }
            }
        }
    }
}

#[test]
fn primary_death_does_not_resume_tui_before_reaper_adoption() {
    let mut primary = HeldChild::start(false);
    primary.pause();
    // Model FreeBSD PDEATHSIG while the dead guardian is still Pi's reaper/ppid.
    primary.signal(FREEBSD_PRIMARY_DEATH_SIGNAL);
    primary.channel.write_all(b"G").unwrap();
    let mut byte = [0];
    let read = primary.channel.read(&mut byte);
    assert!(
        matches!(read, Err(ref e) if matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut)),
        "primary resumed healthy TUI before adoption: {read:?}, byte={byte:?}"
    );
    // Existing ancestor cleanup runs after waitpid adopted the primary: TERM then CONT.
    primary.signal(libc::SIGCONT);
    primary.channel.read_exact(&mut byte).unwrap();
    assert_eq!(&byte, b"H", "shutdown hook must run before healthy work");
}

fn exit_wake_then_tty_stop(signal: i32) {
    let mut outer = HeldChild::start(true);
    outer.pause();
    drop(outer.lifetime.take());
    outer.signal(libc::SIGCONT);
    let mut byte = [0];
    outer.channel.read_exact(&mut byte).unwrap();
    assert_eq!(&byte, b"E");
    // Background Pi's tty operation can stop the whole group after AIO's one-shot wake.
    outer.signal(signal);
    outer.channel.write_all(b"G").unwrap();
    outer
        .channel
        .read_exact(&mut byte)
        .expect("outer re-stopped after lifetime EOF, before reaping anchor");
    assert_eq!(&byte, b"D");
}

#[test]
fn outer_exit_wake_survives_background_tty_read() {
    exit_wake_then_tty_stop(libc::SIGTTIN);
}
#[test]
fn outer_exit_wake_survives_background_tty_write() {
    exit_wake_then_tty_stop(libc::SIGTTOU);
}
