# Installed procward ownership acceptance

The old 38-entry runtime list tested the removed guardian framework: K signal, lease
loss, guardian/bootstrap/launcher deaths, attach phases and permit expiry no longer
exist in the two-level procward design and are intentionally not counted. The 38th
entry count must never be used as evidence again. The current runtime gate keeps
the observable guarantees that still bind:

| Guarantee | Native responsibility | Pi and installed responsibility |
| --- | --- | --- |
| Identity and private transport | direct parent/live creation identity; typed fd/HANDLE; noninheritance | actual bootstrap rejects wrong owner/token and consumes one-use claims; shipped addon/helper bytes match |
| Fail before payload | reject bad endpoint/options; assign Job before payload; no false completion | pre-S admission/cancellation; missing/invalid startup is unconfirmed, never success |
| Ordinary command behavior | exact command stdio/argv/status | actual direct-versus-owned exec/bash, including Bun's tested public status boundary without narrowing native X |
| Retained work and selected cancel | retained Job scope; ordered S/X/matching C/EOF | public bash return, process_list provenance/id0, confirmed process_kill, causal1600ms work and surviving second task |
| Session exit and unrelated work | recursive/nested Job kill-on-close | normal and forced actual CLI exit: prior detached descendants gone; unrelated same-user peer lives; no expiry/rescue credit |
| Console and IPC | Windows console/ConPTY plus ordinary inherited channels | actual shipped CLI Ctrl-C and Node/Bun fork/message/handle behavior still require installed coverage |
| Artifact and privilege | authenticated exact native source | canonical build, embedded/materialized hash identity, nonadmin token and matched staged Node/Bun; final default embedded helper, not a development override |

`installed-probe.mjs` reuses the existing faux provider for one real tool call.
Its body invokes actual public `ctx.executeTool` APIs. `installed-contract.mjs`
contains no transport or process manager. `descendant.mjs` is only a gated
workload. Unit mocks validate fixture assertions, not native cleanup.

The existing scratch workflow has an explicitly selected installed-only phase:
one canonical Windows x64 build, not another transport matrix. It runs the
regular `smoke-owner-lifecycle.mjs` validator against the helper embedded from
the authenticated vendored source; no helper override is set, and any row that
reports one is rejected. A pass covers this one target's installed lifecycle,
public tools and runtime gate, not SDK/MCP, other platforms or release
publication. The final gate keeps its original watchdogs.

`windows-runtime.mjs` (staged as `test/windows-owner-runtime.mjs`) is the
current Windows runtime gate. Its owned-versus-direct comparisons keep the
tested Bun public-status boundary (low byte) without narrowing native X.
