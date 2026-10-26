// CI-only. Uses the locked daemon dependencies; never embedded in Pi.
#[cfg(unix)]
include!("../../../../scripts/fixtures/owner/pty.rs");
#[cfg(not(unix))]
fn main() {
    panic!("Unix PTY fixture only");
}
