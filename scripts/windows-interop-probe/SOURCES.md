# Stage-1 source provenance

Read-only inputs:
- Product checkout `/var/tmp/pi-owner-product-repair-20261110`: HEAD `ac246db2a2045145a173fb5f7dbdcab8c9780202`; supplied product base `43908a543edd8d5ffa54df567e551e22d7a895fe`.
- Both contain vendor/procward tree `164561d170371a9c0cd2268cb46bd1d9974f8771` (v0.3.1).
- CI checkout `/var/tmp/pi-wt-ci`: `115e2e835d9fe598faefc0842a983ee50ddd4d91`.

`fixture.rs` adapts the Windows `File::from_raw_handle` ownership pattern and noninheritance check from procward `tests/fixtures/managed.rs:45–66`, and the UTF-16 `CreateFileW(GENERIC_READ | GENERIC_WRITE, ..., OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, ...)` client construction from `tests/task.rs:30–89`. Its std-only explicit declarations replace windows-sys imports, avoiding dependencies. Original copyright/license is in LICENSE. The CRT descriptor lookup/duplicate/source-close experiment and tiny ready/ping/pong framing are new, not an existing procward feature. The actual procward task protocol, identity checks, launch implementation, and cleanup code are NOT copied or exercised.

Public API references (not remotely fetched during this run):
- Node `child_process.spawn`, extra `stdio` pipe, and Windows named-pipe `net.Server`: https://nodejs.org/docs/latest-v22.x/api/child_process.html and https://nodejs.org/docs/latest-v22.x/api/net.html#ipc-support
- Microsoft UCRT `_get_osfhandle`, `_close`, thread-local invalid-parameter handler; kernel32 `DuplicateHandle`, `CreateFileW`, `GetFileType`, `GetHandleInformation`, `GetNamedPipeInfo`, `GetNamedPipeHandleStateW`.
- No raw Node `_handle`, Bun FFI, adapter, or invented numeric-HANDLE inheritance API.

Action SHAs are copied from the immutable CI's `publish-github-release.yml` and `probe-windows-rename.yml`: checkout `3d3c42e5aac5ba805825da76410c181273ba90b1`; setup-node `820762786026740c76f36085b0efc47a31fe5020`; oven-sh/setup-bun `0c5077e51419868618aeaa5fe8019c62421857d6`; upload-artifact `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a`. These are official actions in their respective projects. The proposed workflow does not use a third-party Rust setup action: it requires the image's installed x86_64-pc-windows-msvc target and linker, records their compiler version, and stops if setup is missing. Compiler bytes are not pinned.

Native CI run 42758244417 attempt 3's historical x64/arm64 success is resource evidence only. It establishes neither current runner capacity nor support for these probes. During the original preparation run no actions were dispatched, no Git network used, no Windows executable linked/run and no repository edited.

Application checkpoint: the reviewed fixture and driver bytes are unchanged. Downstream CI's real upstream-refresh commit is `f00fbf49ef37bf155123f88e84849b2925f61d2d`; all 472 original CI commits remain ancestors. The full43 product composition at `6c9bcd9a9992ba3125bd4e4301cad053686b1722` passed local replay/full check and 99 controlled scripts; its runtime tree is byte-identical to the 815-test composition except a root packaging test fixture. Only workflow scheduling, bounded artifact collection and this diagnostic documentation were adapted for initial execution on the bounded scratch ref. The default-branch dispatch restriction was checked against GitHub's official documentation. Actual Windows execution status belongs to the run receipts, not these source notes.

The first genuine Windows run `43043301903` passed all four byte-I/O cells, but artifact download omitted `.gitattributes` through the default hidden-file filter. Its incomplete artifact sets are retained. Collection now explicitly copies hidden source files and enables hidden-file upload only for this dedicated probe output directory; the Rust fixture, driver, runtime pins, guards and assertions are unchanged. A new exact-commit run is required to close that evidence gap.
