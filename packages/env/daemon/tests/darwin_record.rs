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
fn only_exact_permission_failure_uses_bsd_record() {
    assert_eq!(full_query(136, 136, 0).unwrap(), Query::Complete);
    assert_eq!(full_query(0, 136, libc::EPERM).unwrap(), Query::Bsd);
    assert_eq!(full_query(0, 136, libc::ESRCH).unwrap(), Query::Absent);
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
