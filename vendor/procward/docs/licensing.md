# Licensing

Procward implementation and fixtures are newly authored under **BSD-3-Clause**.
[LICENSE](../LICENSE) contains the canonical licence and copyright notice.
Rust sources and Cargo manifest use matching SPDX identifiers.

No pi-env implementation, tests, fixtures or ABI shims were copied or translated.
Its behaviour informed planning scenarios only. No inherited pi-env MIT notice
or relicensing permission applies to this new implementation.

## Dependency terms

[`third-party-licenses.md`](third-party-licenses.md) preserves selected upstream
licences, copyright and attribution files from the checked Cargo.lock archives.
Include this bundle alongside LICENSE in source and binary distributions.
Dependencies are not BSD-licensed procward code.

For optional MIT/Apache terms, this distribution selects MIT unless a per-file
exception requires otherwise. `unicode-ident` also requires its Unicode-3.0
notice; `bindgen` is BSD-3-Clause, `libloading` ISC and `clang-sys` Apache-2.0.
The bundle includes their actual texts, including build-time dependencies and
Windows/WASI crates recorded by Cargo, not a claim that each is linked on every
target.

Process-wrap's COPYRIGHT identifies Windows Job/thread routines under
**Apache-2.0 only**. The Windows backend enables those routines through a
narrowly patched vendored process-wrap dependency. Its Apache licence and
copyright/attribution are retained in the bundle and original vendor files.
The native Job completion helper and callers are modified with prominent source
change notices; [PROCWARD-PATCH.md](../third_party/process-wrap/PROCWARD-PATCH.md)
records the change and [UPSTREAM.md](../third_party/process-wrap/UPSTREAM.md)
contains an unfiled upstream report/patch. Other procward coordination remains
new BSD code. Recheck per-file exceptions, NOTICE and change-notice obligations
for future dependency modifications and before release packaging.

Rustix 1.1.6 is separately vendored for its FreeBSD no-failed-PID sentinel fix,
with original licence/COPYRIGHT files and a source modification notice.
[Patch notes](../third_party/rustix/PROCWARD-PATCH.md) and an
[unfiled upstream report](../third_party/rustix/UPSTREAM.md) identify that narrow
change. No procctl ABI shim or assertion suppression is used.

## Locked inventory

| Crate | Locked version | Published SPDX expression |
| --- | --- | --- |
| aho-corasick | 1.1.5 | Unlicense OR MIT |
| bindgen | 0.72.1 | BSD-3-Clause |
| bitflags | 2.13.2 | MIT OR Apache-2.0 |
| bytes | 1.12.1 | MIT |
| cexpr | 0.6.0 | Apache-2.0/MIT |
| cfg-if | 1.0.5 | MIT OR Apache-2.0 |
| cfg_aliases | 0.2.2 | MIT |
| clang-sys | 1.9.1 | Apache-2.0 |
| either | 1.19.0 | MIT OR Apache-2.0 |
| equivalent | 1.0.3 | Apache-2.0 OR MIT |
| errno | 0.3.14 | MIT OR Apache-2.0 |
| futures | 0.3.34 | MIT OR Apache-2.0 |
| futures-channel | 0.3.34 | MIT OR Apache-2.0 |
| futures-core | 0.3.34 | MIT OR Apache-2.0 |
| futures-executor | 0.3.34 | MIT OR Apache-2.0 |
| futures-io | 0.3.34 | MIT OR Apache-2.0 |
| futures-macro | 0.3.34 | MIT OR Apache-2.0 |
| futures-sink | 0.3.34 | MIT OR Apache-2.0 |
| futures-task | 0.3.34 | MIT OR Apache-2.0 |
| futures-util | 0.3.34 | MIT OR Apache-2.0 |
| glob | 0.3.4 | MIT OR Apache-2.0 |
| hashbrown | 0.17.1 | MIT OR Apache-2.0 |
| indexmap | 2.14.2 | Apache-2.0 OR MIT |
| itertools | 0.13.0 | MIT OR Apache-2.0 |
| libc | 0.2.191 | MIT OR Apache-2.0 |
| libloading | 0.8.9 | ISC |
| libproc | 0.14.11 | MIT |
| linux-raw-sys | 0.12.1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| memchr | 2.8.3 | Unlicense OR MIT |
| minimal-lexical | 0.2.1 | MIT/Apache-2.0 |
| mio | 1.2.4 | MIT |
| nix | 0.31.3 | MIT |
| nom | 7.1.3 | MIT |
| pin-project-lite | 0.2.17 | Apache-2.0 OR MIT |
| proc-macro2 | 1.0.107 | MIT OR Apache-2.0 |
| process-wrap | 10.0.1 | Apache-2.0 OR MIT |
| quote | 1.0.47 | MIT OR Apache-2.0 |
| regex | 1.13.1 | MIT OR Apache-2.0 |
| regex-automata | 0.4.18 | MIT OR Apache-2.0 |
| regex-syntax | 0.8.11 | MIT OR Apache-2.0 |
| rustc-hash | 2.1.3 | Apache-2.0 OR MIT |
| rustix | 1.1.6 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| rustix-openpty | 0.2.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| shlex | 1.3.0 | MIT OR Apache-2.0 |
| signal-hook | 0.4.5 | MIT OR Apache-2.0 |
| signal-hook-registry | 1.4.8 | MIT OR Apache-2.0 |
| slab | 0.4.12 | MIT |
| syn | 2.0.119 | MIT OR Apache-2.0 |
| syn | 3.0.9 | MIT OR Apache-2.0 |
| tokio | 1.54.1 | MIT |
| tokio-macros | 2.7.2 | MIT |
| unicode-ident | 1.0.27 | (MIT OR Apache-2.0) AND Unicode-3.0 |
| wasi | 0.11.1+wasi-snapshot-preview1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| windows | 0.62.2 | MIT OR Apache-2.0 |
| windows-collections | 0.3.2 | MIT OR Apache-2.0 |
| windows-core | 0.62.2 | MIT OR Apache-2.0 |
| windows-future | 0.3.2 | MIT OR Apache-2.0 |
| windows-implement | 0.60.2 | MIT OR Apache-2.0 |
| windows-interface | 0.59.3 | MIT OR Apache-2.0 |
| windows-link | 0.2.1 | MIT OR Apache-2.0 |
| windows-numerics | 0.3.1 | MIT OR Apache-2.0 |
| windows-result | 0.4.1 | MIT OR Apache-2.0 |
| windows-strings | 0.5.1 | MIT OR Apache-2.0 |
| windows-sys | 0.61.2 | MIT OR Apache-2.0 |
| windows-threading | 0.2.1 | MIT OR Apache-2.0 |

Process-wrap and rustix are vendored with original licences and documented
narrow fixes; other source archives remain in Cargo's registry cache. Refresh inventory
and bundle together after dependency changes; this development snapshot does
not replace the release-package licence check.
