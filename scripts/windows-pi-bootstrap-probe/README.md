# Actual Pi Windows bootstrap slice

Runs the real `packages/coding-agent/src/cli-bootstrap.ts`, native parent/FILETIME
consumer and single lifecycle worker with Node22.22.2/Bun1.4.4 on native Windows
x64/arm64. It compiles the existing Windows platform addon from its C sources and
uses Pi's single source-Cargo builder for the still-authenticated v0.3.1 pin.
No early production pin update, copied bootstrap, paid model or fake native
identity is used.

Cases: default outer re-exec runs the application once; valid READY consumes
and clears all claim metadata; native parent creation time remains a full16-digit
FILETIME; healthy operation outlives seven seconds; wrong owner and a one-bit
mutation of a real native creation token fail closed; native-owner death closes
the real primary's inherited output; inherited environment opt-out bypasses the
whole ownership bootstrap. The production native read rejects inheritable pipe
handles. The fixture's10s case guard does not change the production2s startup,
5s main/7s worker loss budgets or any native/VM deadline. Guard/rescue fails.

A diagnostic scratch carrier may contain the exact genuinely replayed product
tree solely to let Actions test local owning history. It is never a production
predecessor, a product-branch push or a repair to main. The persistent ci branch
contains only this workflow/fixture. Freeze all tracked source except the two
owned Windows prebuild outputs, then bind their actual compiled bytes separately.

This is actual Pi early-bootstrap acceptance, not full installed CLI/TUI, task
fd3, tool/SDK/MCP, owner-loss hook opportunity or release acceptance. Windows Job
owner death can preempt JavaScript callbacks. Full task integration and the Bun
high-u32 direct-child boundary still require final Pi differential acceptance.
