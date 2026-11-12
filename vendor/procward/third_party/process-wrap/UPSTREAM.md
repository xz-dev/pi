# Prepared upstream report — NOT FILED

Target: https://github.com/watchexec/process-wrap

## Suggested title

Windows Job wait returns after non-empty completion packets

## Summary

In process-wrap 10.0.1, `windows::wait_on_job` returns Break after any successful
GetQueuedCompletionStatus call, without checking message code or completion key.
NEW_PROCESS/EXIT_PROCESS packets therefore look like whole-Job completion.
This affects the shared native helper used by std and Tokio Job wrappers.

## Reproducer / observed result

Fresh Rust fixture: primary starts a gated descendant tree, waits for a file
release, then exits 23 while descendants stay alive. The test proves primary
exit through inner child try_wait, retains live native descendant process handles,
and polls the Job wrapper wait future. Expected: Pending until descendants exit.
Actual on pristine 10.0.1: Ready while retained process handles are still live.
The test does not depend on fixed sleeps or a timing race.

Procward regression:
`tests/windows.rs::job_wait_does_not_complete_while_gated_descendants_are_alive`.
Run `cargo build --locked --examples`, then
`cargo test --locked --test windows job_wait_does_not_complete -- --nocapture`.

Red evidence (both Windows x64 and arm64):
https://github.com/xz-dev/procward/actions/runs/40532870970
Source commit: cd19b63 (deleted temporary branch; commit retained by Actions).
Failure: `Job wait completed while gated descendant process handles are still live`.
The registry 10.0.1 source is identical to the pristine vendored crate archive,
SHA-256 `1f21b97672d2dc848e7b25701ab4535618b92f4861c13cc3f7f7bed52ad3c8da`.

## Proposed fix and scope

Check ACTIVE_PROCESS_ZERO and expected Job completion key; continue on other
packets under the original finite timeout budget; propagate real API errors.
Use the maintained windows constant binding. No replacement Job implementation.
The normalized vendored Cargo.toml mirrors the feature added to upstream's
source manifest in the patch below.

This patch does not claim to fix separate try_wait event-consumption or
cancelled-wait cache semantics. Procward uses inner primary try_wait and one
uncancelled completion wait on success. Keep those related follow-ups visible
when reviewing an upstream change.

## Source patch

Prepared only. No issue or pull request has been submitted. Source licence and
copyright notices are retained; modification comments identify changed files.

```diff
diff --git a/Cargo.toml b/Cargo.toml
index 2b45b84..54f6f00 100644
--- a/Cargo.toml
+++ b/Cargo.toml
@@ -1,3 +1,4 @@
+# Modified for procward: enable the native Job-empty message constant binding.
 [package]
 name = "process-wrap"
 version = "10.0.1"
@@ -56,7 +57,7 @@ tokio1 = ["dep:nix", "dep:futures", "dep:tokio"]
 creation-flags = ["dep:windows", "windows/Win32_System_Threading"]
 
 ## Wrapper: Job Object
-job-object = ["dep:windows", "windows/Win32_Security", "windows/Win32_System_Diagnostics_ToolHelp", "windows/Win32_System_IO", "windows/Win32_System_JobObjects", "windows/Win32_System_Threading"]
+job-object = ["dep:windows", "windows/Win32_Security", "windows/Win32_System_Diagnostics_ToolHelp", "windows/Win32_System_IO", "windows/Win32_System_JobObjects", "windows/Win32_System_SystemServices", "windows/Win32_System_Threading"]
 
 ## Wrapper: Kill on Drop
 kill-on-drop = []
diff --git a/src/std/job_object.rs b/src/std/job_object.rs
index ad10743..357e2f2 100644
--- a/src/std/job_object.rs
+++ b/src/std/job_object.rs
@@ -1,3 +1,4 @@
+// Modified for procward: pass the expected Job key to completion-port waits.
 use std::{
 	io::{Error, ErrorKind, Result},
 	os::windows::{
@@ -180,15 +181,20 @@ impl ChildWrapper for JobObjectChild {
 
 		// nevertheless, now wait and make sure we reap all children.
 		let JobPort {
-			completion_port, ..
+			job,
+			completion_port,
 		} = self.job_port;
-		let _ = wait_on_job(completion_port, None)?;
+		let _ = wait_on_job(job, completion_port, None)?;
 		Ok(status)
 	}
 
 	#[cfg_attr(feature = "tracing", instrument(level = "debug", skip(self)))]
 	fn try_wait(&mut self) -> Result<Option<ExitStatus>> {
-		let _ = wait_on_job(self.job_port.completion_port, Some(Duration::ZERO))?;
+		let _ = wait_on_job(
+			self.job_port.job,
+			self.job_port.completion_port,
+			Some(Duration::ZERO),
+		)?;
 		self.inner.try_wait()
 	}
 }
diff --git a/src/tokio/job_object.rs b/src/tokio/job_object.rs
index 4433ef9..5825427 100644
--- a/src/tokio/job_object.rs
+++ b/src/tokio/job_object.rs
@@ -1,3 +1,4 @@
+// Modified for procward: pass the expected Job key to completion-port waits.
 use std::{
 	future::Future,
 	io::{Error, ErrorKind, Result},
@@ -189,7 +190,13 @@ impl ChildWrapper for JobObjectChild {
 
 			// nevertheless, now try reaping all children a few times...
 			for _ in 1..MAX_RETRY_ATTEMPT {
-				if wait_on_job(self.job_port.completion_port, Some(Duration::ZERO))?.is_break() {
+				if wait_on_job(
+					self.job_port.job,
+					self.job_port.completion_port,
+					Some(Duration::ZERO),
+				)?
+				.is_break()
+				{
 					return Ok(status);
 				}
 			}
@@ -197,16 +204,21 @@ impl ChildWrapper for JobObjectChild {
 			// ...finally, if there are some that are still alive,
 			// block in the background to reap them fully.
 			let JobPort {
-				completion_port, ..
+				job,
+				completion_port,
 			} = self.job_port;
-			let _ = spawn_blocking(move || wait_on_job(completion_port, None)).await??;
+			let _ = spawn_blocking(move || wait_on_job(job, completion_port, None)).await??;
 			Ok(status)
 		})
 	}
 
 	#[cfg_attr(feature = "tracing", instrument(level = "debug", skip(self)))]
 	fn try_wait(&mut self) -> Result<Option<ExitStatus>> {
-		let _ = wait_on_job(self.job_port.completion_port, Some(Duration::ZERO))?;
+		let _ = wait_on_job(
+			self.job_port.job,
+			self.job_port.completion_port,
+			Some(Duration::ZERO),
+		)?;
 		self.inner.try_wait()
 	}
 }
diff --git a/src/windows.rs b/src/windows.rs
index 890bdb5..cda56bc 100644
--- a/src/windows.rs
+++ b/src/windows.rs
@@ -1,16 +1,19 @@
+// Modified for procward: validate Job-empty completion, preserve deadlines and errors.
 //! Windows API support functions.
 
 use std::{
 	io::{Error, Result},
 	ops::ControlFlow,
-	time::Duration,
+	time::{Duration, Instant},
 };
 
 #[cfg(feature = "tracing")]
 use tracing::{debug, instrument};
 use windows::{
 	Win32::{
-		Foundation::{CloseHandle, ERROR_NO_MORE_FILES, HANDLE, INVALID_HANDLE_VALUE},
+		Foundation::{
+			CloseHandle, ERROR_NO_MORE_FILES, HANDLE, INVALID_HANDLE_VALUE, WAIT_TIMEOUT,
+		},
 		System::{
 			Diagnostics::ToolHelp::{
 				CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First,
@@ -23,6 +26,7 @@ use windows::{
 				JobObjectAssociateCompletionPortInformation, JobObjectExtendedLimitInformation,
 				SetInformationJobObject, TerminateJobObject,
 			},
+			SystemServices::JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO,
 			Threading::{
 				CREATE_SUSPENDED, GetProcessId, INFINITE, OpenThread, PROCESS_CREATION_FLAGS,
 				ResumeThread, THREAD_SUSPEND_RESUME,
@@ -241,31 +245,46 @@ pub(crate) fn terminate_job(job: JobHandle, exit_code: u32) -> Result<()> {
 }
 
 /// Wait for a job to complete.
+// Procward modification: require this Job's empty notification; preserve timeout and error results.
 #[cfg_attr(feature = "tracing", instrument(level = "debug"))]
 pub(crate) fn wait_on_job(
+	job: JobHandle,
 	completion_port: PortHandle,
 	timeout: Option<Duration>,
 ) -> Result<ControlFlow<()>> {
-	let mut code: u32 = 0;
-	let mut key: usize = 0;
-	let mut overlapped = OVERLAPPED::default();
-	let mut lp_overlapped = &mut overlapped as *mut OVERLAPPED;
-
-	let result = unsafe {
-		GetQueuedCompletionStatus(
-			completion_port.0,
-			&mut code,
-			&mut key,
-			&mut lp_overlapped as *mut _,
-			timeout.map_or(INFINITE, |d| d.as_millis().try_into().unwrap_or(INFINITE)),
-		)
-	};
-
-	// ignore timing out errors unless the timeout was specified to INFINITE
-	// https://docs.microsoft.com/en-us/windows/win32/api/ioapiset/nf-ioapiset-getqueuedcompletionstatus
-	if timeout.is_some() && result.is_err() && lp_overlapped.is_null() {
-		return Ok(ControlFlow::Continue(()));
+	let started = Instant::now();
+	loop {
+		let mut code: u32 = 0;
+		let mut key: usize = 0;
+		let mut overlapped: *mut OVERLAPPED = std::ptr::null_mut();
+		let milliseconds = timeout.map_or(INFINITE, |limit| {
+			limit
+				.saturating_sub(started.elapsed())
+				.as_millis()
+				.min(u128::from(INFINITE - 1)) as u32
+		});
+		let result = unsafe {
+			GetQueuedCompletionStatus(
+				completion_port.0,
+				&mut code,
+				&mut key,
+				&mut overlapped,
+				milliseconds,
+			)
+		};
+		match result {
+			Ok(()) if key == job.0.0 as usize && code == JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO => {
+				return Ok(ControlFlow::Break(()));
+			}
+			Ok(()) => {}
+			Err(error)
+				if timeout.is_some()
+					&& overlapped.is_null()
+					&& error.code() == HRESULT::from_win32(WAIT_TIMEOUT.0) => {}
+			Err(error) => return Err(Error::other(error)),
+		}
+		if timeout.is_some_and(|limit| started.elapsed() >= limit) {
+			return Ok(ControlFlow::Continue(()));
+		}
 	}
-
-	Ok(ControlFlow::Break(()))
 }
```
