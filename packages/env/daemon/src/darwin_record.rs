//! Typed Darwin metadata and birth policy, independent of either kernel record layout.

use std::io;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Record {
    pub(crate) pbi_pid: u32,
    pub(crate) pbi_ppid: u32,
    pub(crate) pbi_pgid: u32,
    pub(crate) pbi_status: u32,
    pub(crate) pbi_uid: u32,
    pub(crate) pbi_ruid: u32,
    pub(crate) pbi_start_tvsec: u64,
    pub(crate) pbi_start_tvusec: u64,
}

impl Record {
    pub(crate) fn checked(self, pid: libc::pid_t) -> io::Result<Self> {
        if pid <= 0
            || self.pbi_pid != pid as u32
            || self.pbi_ppid > i32::MAX as u32
            || self.pbi_pgid > i32::MAX as u32
            || self.pbi_status > i8::MAX as u32
            || self.pbi_start_tvsec == 0
            || self.pbi_start_tvusec >= 1_000_000
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid Darwin process record",
            ));
        }
        Ok(self)
    }

    pub(crate) fn identity(self) -> Identity {
        Identity {
            pid: self.pbi_pid as libc::pid_t,
            seconds: self.pbi_start_tvsec,
            micros: self.pbi_start_tvusec,
            uid: self.pbi_uid,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct Identity {
    pub(crate) pid: libc::pid_t,
    seconds: u64,
    micros: u64,
    uid: libc::uid_t,
}

impl Identity {
    pub(crate) fn same_birth(self, other: Self) -> bool {
        self.pid == other.pid && self.seconds == other.seconds && self.micros == other.micros
    }

    pub(crate) fn pid(self) -> libc::pid_t {
        self.pid
    }

    pub(crate) fn encode(self) -> [u8; 24] {
        let mut bytes = [0; 24];
        bytes[..4].copy_from_slice(&self.pid.to_ne_bytes());
        bytes[4..12].copy_from_slice(&self.seconds.to_ne_bytes());
        bytes[12..20].copy_from_slice(&self.micros.to_ne_bytes());
        bytes[20..].copy_from_slice(&self.uid.to_ne_bytes());
        bytes
    }

    pub(crate) fn decode(bytes: [u8; 24]) -> io::Result<Self> {
        let value = Self {
            pid: i32::from_ne_bytes(bytes[..4].try_into().unwrap()),
            seconds: u64::from_ne_bytes(bytes[4..12].try_into().unwrap()),
            micros: u64::from_ne_bytes(bytes[12..20].try_into().unwrap()),
            uid: u32::from_ne_bytes(bytes[20..].try_into().unwrap()),
        };
        if value.pid <= 0 || value.micros >= 1_000_000 {
            return Err(io::Error::other("invalid session birth identity"));
        }
        Ok(value)
    }
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum Query {
    Complete,
    Absent,
    Bsd,
}

pub(crate) fn full_query(got: i32, expected: i32, errno: i32) -> io::Result<Query> {
    if got == expected {
        return Ok(Query::Complete);
    }
    // libproc also returns ESRCH for unreaped zombies; only the SDK query proves absence.
    if got == 0 && matches!(errno, libc::EPERM | libc::ESRCH) {
        return Ok(Query::Bsd);
    }
    if got > 0 || errno == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "incomplete libproc identity record",
        ));
    }
    Err(io::Error::from_raw_os_error(errno))
}

pub(crate) fn bsd_query(result: i32) -> io::Result<Query> {
    match result {
        0 => Ok(Query::Complete),
        // The SDK shim reports a fresh successful PID-specific empty kernel result.
        -1 => Ok(Query::Absent),
        value if value > 0 => Err(io::Error::from_raw_os_error(value)),
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "incomplete BSD process record",
        )),
    }
}
