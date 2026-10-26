#![cfg(all(unix, target_pointer_width = "64"))]

#[path = "../src/darwin_record.rs"]
mod record;

use record::{Identity, Query, Record, bsd_query, full_query};
use std::io::ErrorKind;

fn process(uid: u32) -> Record {
    Record {
        pbi_pid: 123,
        pbi_ppid: 100,
        pbi_pgid: 123,
        pbi_status: 2,
        pbi_uid: uid,
        pbi_ruid: 502,
        pbi_start_tvsec: 1792817793,
        pbi_start_tvusec: 892918,
    }
}

#[test]
fn normalized_sdk_record_has_fixed_c_abi() {
    assert_eq!(std::mem::size_of::<Record>(), 40);
    assert_eq!(std::mem::align_of::<Record>(), 8);
    assert_eq!(process(0).checked(123).unwrap().pbi_ruid, 502);
}

#[test]
fn same_birth_survives_credential_change_but_signal_identity_still_checks_uid() {
    let original = process(502).identity();
    let changed = process(0).identity();
    assert!(original.same_birth(changed));
    assert_ne!(original, changed);
    assert_eq!(changed, process(0).checked(123).unwrap().identity());
    assert_eq!(Identity::decode(changed.encode()).unwrap(), changed);
    assert_eq!(changed.pid(), 123);
}

#[test]
fn pid_reuse_does_not_refresh_owned_identity() {
    let original = process(502).identity();
    let mut reused = process(0);
    reused.pbi_start_tvusec += 1;
    assert!(!original.same_birth(reused.identity()));
    reused = process(502);
    reused.pbi_pid += 1;
    assert!(!original.same_birth(reused.identity()));
}

#[test]
fn malformed_records_are_not_birth_proof() {
    for mutate in [
        |r: &mut Record| r.pbi_pid = 124,
        |r: &mut Record| r.pbi_ppid = u32::MAX,
        |r: &mut Record| r.pbi_pgid = u32::MAX,
        |r: &mut Record| r.pbi_status = u32::MAX,
        |r: &mut Record| r.pbi_start_tvsec = 0,
        |r: &mut Record| r.pbi_start_tvusec = 1_000_000,
    ] {
        let mut r = process(502);
        mutate(&mut r);
        assert_eq!(r.checked(123).unwrap_err().kind(), ErrorKind::InvalidData);
    }
}

#[test]
fn permission_or_esrch_requires_bsd_record() {
    assert_eq!(full_query(136, 136, 0).unwrap(), Query::Complete);
    assert_eq!(full_query(0, 136, libc::EPERM).unwrap(), Query::Bsd);
    assert_eq!(full_query(0, 136, libc::ESRCH).unwrap(), Query::Bsd);
    for got in [1, 64, 135, 137] {
        for errno in [0, libc::EPERM, libc::ESRCH] {
            assert_eq!(
                full_query(got, 136, errno).unwrap_err().kind(),
                ErrorKind::InvalidData
            );
        }
    }
    assert_eq!(
        full_query(0, 136, 0).unwrap_err().kind(),
        ErrorKind::InvalidData
    );
    assert_eq!(
        full_query(0, 136, libc::EIO).unwrap_err().raw_os_error(),
        Some(libc::EIO)
    );
}

#[test]
fn libproc_esrch_keeps_zombie_identity_until_kernel_absence() {
    // Native macOS probe: live/zombie share this birth; libproc returns 0/ESRCH for both zombie/reaped.
    let mut zombie = process(502);
    zombie.pbi_status = 5;
    let live = process(502).identity();
    assert_eq!(full_query(0, 136, libc::ESRCH).unwrap(), Query::Bsd);
    assert_eq!(bsd_query(0).unwrap(), Query::Complete);
    assert_eq!(zombie.checked(123).unwrap().identity(), live);
    assert_eq!(bsd_query(-1).unwrap(), Query::Absent);
}

#[cfg(target_os = "macos")]
#[test]
fn native_sdk_query_distinguishes_zombie_from_reaped() {
    use std::io::Write;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    unsafe extern "C" {
        fn pi_env_darwin_record(pid: i32, output: *mut Record) -> i32;
    }
    let mut child = Command::new("/bin/sh").args(["-c", "read gate; exit 0"])
        .stdin(Stdio::piped()).spawn().unwrap();
    let pid = child.id() as i32;
    let mut live = Record::default();
    assert_eq!(unsafe { pi_env_darwin_record(pid, &mut live) }, 0);
    let identity = live.checked(pid).unwrap().identity();
    child.stdin.take().unwrap().write_all(b"go\n").unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let mut zombie = Record::default();
        assert_eq!(unsafe { pi_env_darwin_record(pid, &mut zombie) }, 0);
        assert_eq!(zombie.checked(pid).unwrap().identity(), identity);
        if zombie.pbi_status == libc::SZOMB {
            let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
            unsafe { *libc::__error() = 0 };
            let got = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&mut info as *mut libc::proc_bsdinfo).cast(), std::mem::size_of_val(&info) as i32) };
            let errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
            assert_eq!(full_query(got, std::mem::size_of_val(&info) as i32, errno).unwrap(), Query::Bsd);
            break;
        }
        assert!(Instant::now() < deadline, "child did not become zombie");
        std::thread::sleep(Duration::from_millis(1));
    }
    assert!(child.wait().unwrap().success());
    let mut reaped = Record::default();
    assert_eq!(bsd_query(unsafe { pi_env_darwin_record(pid, &mut reaped) }).unwrap(), Query::Absent);
}

#[test]
fn fresh_bsd_absence_is_distinct_from_permission_and_invalid_data() {
    assert_eq!(bsd_query(0).unwrap(), Query::Complete);
    assert_eq!(bsd_query(-1).unwrap(), Query::Absent);
    assert_eq!(bsd_query(-2).unwrap_err().kind(), ErrorKind::InvalidData);
    assert_eq!(
        bsd_query(libc::EPERM).unwrap_err().raw_os_error(),
        Some(libc::EPERM)
    );
    assert_eq!(
        bsd_query(libc::EIO).unwrap_err().raw_os_error(),
        Some(libc::EIO)
    );
}
