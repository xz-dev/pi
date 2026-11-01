//! libuv Windows STARTUPINFO reserved2 table. Kept portable for bounds tests.
use std::io;

pub fn control_handle(bytes: &[u8], fd: usize, width: usize) -> io::Result<usize> {
    let invalid = || {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid inherited control table",
        )
    };
    if bytes.len() < 4 || !matches!(width, 4 | 8) {
        return Err(invalid());
    }
    let count = u32::from_ne_bytes(bytes[..4].try_into().unwrap()) as usize;
    if !(3..=256).contains(&count)
        || fd < 3
        || fd >= count
        || bytes.len() < 4 + count * (1 + width)
        || bytes[4 + fd] & 9 != 9
    {
        return Err(invalid());
    }
    let at = 4 + count + fd * width;
    let value = if width == 4 {
        u32::from_ne_bytes(bytes[at..at + 4].try_into().unwrap()) as u64
    } else {
        u64::from_ne_bytes(bytes[at..at + 8].try_into().unwrap())
    };
    if value == 0
        || value
            == if width == 4 {
                u32::MAX as u64
            } else {
                u64::MAX
            }
    {
        return Err(invalid());
    }
    usize::try_from(value).map_err(|_| invalid())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crt_table_checks_bounds_flags_and_handle_width_not_fd_values() {
        for width in [4, 8] {
            let mut bytes = vec![0; 4 + 5 * (1 + width)];
            bytes[..4].copy_from_slice(&5u32.to_ne_bytes());
            bytes[7] = 9;
            let at = 4 + 5 + 3 * width;
            let handle = 0x12345678u64.to_ne_bytes();
            bytes[at..at + width].copy_from_slice(&handle[..width]);
            assert_eq!(control_handle(&bytes, 3, width).unwrap(), 0x12345678);
            for end in 0..bytes.len() {
                assert!(control_handle(&bytes[..end], 3, width).is_err());
            }
            for fd in [0, 1, 2, 4, 5, usize::MAX] {
                assert!(control_handle(&bytes, fd, width).is_err());
            }
            for count in [0, 2, 257, u32::MAX] {
                let mut bad = bytes.clone();
                bad[..4].copy_from_slice(&count.to_ne_bytes());
                assert!(control_handle(&bad, 3, width).is_err());
            }
            bytes[7] = 1;
            assert!(control_handle(&bytes, 3, width).is_err());
            bytes[7] = 9;
            for fill in [0, 255] {
                bytes[at..at + width].fill(fill);
                assert!(control_handle(&bytes, 3, width).is_err());
            }
        }
    }
}
