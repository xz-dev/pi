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
one canonical Windows x64 build, not another transport matrix. Before formal
native release/pinning, it may use the existing source-built development helper
for the two installed-task rows. `smoke-installed-owner.mjs` can report only
`passed-development-only`; the regular final validator rejects that marker.
Four ordinary CLI rows still use their embedded helper and populate/check the
real resource cache. Do not count this development result as final Windows,
SDK/MCP, console/IPC or release acceptance. The default final gate retains its
original watchdogs and requires no helper override.
