// SPDX-License-Identifier: BSD-3-Clause
use std::{fs, path::Path, process};

pub fn run(dir: &Path, worker: bool) {
    if worker {
        fs::write(dir.join("retained-worker.pid"), process::id().to_string()).unwrap();
        fs::write(dir.join("retained-ready"), b"ready").unwrap();
        super::wait_for(&dir.join("retained-probe"));
        fs::write(dir.join("retained-probed"), b"alive after primary exit").unwrap();
        super::wait_for(&dir.join("retained-release"));
        fs::write(dir.join("retained-finished"), b"natural exit").unwrap();
        process::exit(17);
    }
    #[cfg(target_os = "linux")]
    fs::write(
        dir.join("retained-anchor.pid"),
        std::env::var("PROCWARD_OWNER_PID").unwrap(),
    )
    .unwrap();
    let _worker = super::spawn("retained-worker", dir);
    super::wait_for(&dir.join("retained-ready"));
    super::wait_for_input();
    process::exit(23);
}
