// SPDX-License-Identifier: BSD-3-Clause
use std::{
    process::Command,
    thread,
    time::{Duration, Instant},
};

// Removes only Linux procward's one visible weaker-backend startup diagnostic, if present.
fn payload_stderr(bytes: &[u8]) -> &[u8] {
    const PREFIX: &[u8] = b"procward: Linux cgroup v2 workload group unavailable (";
    const SUFFIX: &[u8] = b"); cleanup falls back to subreaper and pidfd termination";
    match bytes.iter().position(|byte| *byte == b'\n') {
        Some(end)
            if cfg!(target_os = "linux")
                && bytes.starts_with(PREFIX)
                && bytes[..end].ends_with(SUFFIX) =>
        {
            &bytes[end + 1..]
        }
        _ => bytes,
    }
}

#[test]
fn backend_runs_real_fixture_and_preserves_primary_status() {
    let fixture = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join(format!("examples/fixture{}", std::env::consts::EXE_SUFFIX));
    let mut child = Command::new(env!("CARGO_BIN_EXE_procward"))
        .args([
            "run",
            "--grace",
            "2s",
            "--fatal-grace",
            "1s",
            "--cleanup-deadline",
            "2500ms",
            "--",
        ])
        .arg(fixture)
        .args(["exit", "23"])
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert_eq!(
                status.code(),
                Some(23),
                "BACKEND INCOMPLETE (expected-unsupported during early development, NOT release coverage): {} / {}: {status}",
                std::env::consts::OS,
                std::env::consts::ARCH
            );
            break;
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("fixture exceeded deadline; HARNESS RESCUE, not product cleanup");
        }
        thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn native_arguments_and_redirected_streams_survive_backend_spawn() {
    use std::{
        ffi::{OsStr, OsString},
        fs,
        io::Write,
        process::Stdio,
    };
    fn bytes(value: &OsStr) -> Vec<u8> {
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStrExt;
            value.as_bytes().to_vec()
        }
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            value.encode_wide().flat_map(u16::to_le_bytes).collect()
        }
    }
    let dir = std::env::temp_dir().join(format!("procward-platform-probe-{}", std::process::id()));
    fs::create_dir(&dir).unwrap();
    #[cfg(unix)]
    let dir = fs::canonicalize(dir).unwrap();
    let fixture = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join(format!("examples/fixture{}", std::env::consts::EXE_SUFFIX));
    let mut args: Vec<OsString> = ["two words", "--literal", "", "a\"b\\c", "$(not a shell) *"]
        .into_iter()
        .map(OsString::from)
        .collect();
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStringExt;
        args.push(OsString::from_vec(vec![b'x', 0xff]));
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStringExt;
        args.push(OsString::from_wide(&[b'x' as u16, 0xd800]));
    }
    let mut child = Command::new(env!("CARGO_BIN_EXE_procward"))
        .args(["run", "--"])
        .arg(fixture)
        .arg("probe")
        .args(&args)
        .current_dir(&dir)
        .env("PROCWARD_TEST_VALUE", "inherited value")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"input\0bytes")
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while child.try_wait().unwrap().is_none() {
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("probe deadline; HARNESS RESCUE, not product cleanup");
        }
        thread::sleep(Duration::from_millis(5));
    }
    let output = child.wait_with_output().unwrap();
    assert_eq!(output.status.code(), Some(23), "{output:?}");
    let mut expected = Vec::new();
    for value in args
        .iter()
        .map(OsString::as_os_str)
        .chain([dir.as_os_str(), OsStr::new("inherited value")])
    {
        let value = bytes(value);
        expected.extend_from_slice(&(value.len() as u32).to_le_bytes());
        expected.extend_from_slice(&value);
    }
    expected.extend_from_slice(b"input\0bytes");
    assert_eq!(output.stdout, expected);
    assert_eq!(payload_stderr(&output.stderr), b"fixture-stderr\n");
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn invalid_cleanup_configuration_is_exit_two_without_payload_side_effects() {
    let marker =
        std::env::temp_dir().join(format!("procward-invalid-timing-{}", std::process::id()));
    let fixture = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join(format!("examples/fixture{}", std::env::consts::EXE_SUFFIX));
    for options in [
        vec!["--grace", "0ms"],
        vec!["--fatal-grace", "0s"],
        vec!["--grace", "2s", "--fatal-grace", "3s"],
        vec!["--cleanup-deadline", "6s"],
        vec!["--grace", "8s"],
        vec!["--grace", "nan"],
        vec!["--grace", "-1s"],
        vec!["--grace", "18446744073709551615s"],
        vec!["--grace", "6s", "--grace", "6s"],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_procward"))
            .arg("run")
            .args(&options)
            .arg("--")
            .arg(&fixture)
            .arg("touch")
            .arg(&marker)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2), "{options:?}: {output:?}");
        assert!(!output.stderr.is_empty());
        assert!(!marker.try_exists().unwrap());
    }
    let output = Command::new(env!("CARGO_BIN_EXE_procward"))
        .args(["run", "--grace"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
}
