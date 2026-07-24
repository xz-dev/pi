# Implement OpenAI Responses native compaction checkpoints (#6492)

## Goal

Add an explicitly selected, provider-scoped native compaction strategy for supported OpenAI Responses models in the xz-dev/pi downstream fork. It must persist an opaque canonical checkpoint, replay it only for compatible requests, and reconstruct intact portable branch history for incompatible models.

## Sources

- Upstream issue research: `/tmp/pi-issue-6492-report.md`
- Session export evidence: `/tmp/pi-issue-6492-session-report.md`
- OpenAI protocol research: `/tmp/pi-issue-6492-openai-docs-report.md`
- Current architecture research: `/tmp/pi-issue-6492-architecture-report.md`
- Branch workflow audit: `/tmp/pi-issue-6492-branch-report.md`
- Codex compaction/continuation research: `/tmp/pi-6492-codex-compaction-continuation.md`
- OpenCode compaction/continuation research: `/tmp/pi-6492-opencode-compaction-continuation.md`
- Cross-client design/test matrix: `/tmp/pi-6492-cross-client-design-matrix.md`

## Global constraints

- Native compaction is opt-in; existing textual compaction remains unchanged by default.
- A successful native compaction does not generate/send a parallel textual summary.
- Persist complete opaque provider result with a versioned compatibility identity; never log or display its contents as portable text.
- Compatible requests replay the newest valid ancestral checkpoint plus post-frontier history exactly once; checkpoints carry frontier, predecessor/window generation, and provider-owned compatibility identity.
- Incompatible requests send no opaque checkpoint and reconstruct context from the intact append-only branch.
- Manual, threshold, and overflow triggers share the same strategy decision; existing overflow retry semantics stay intact.
- Abort/failure is atomic: no partial checkpoint and no silent native/text hybrid. Attempt/run generation rejects late responses and stale compatibility changes.
- Core owns branch ancestry, durable append/install ordering, continuation permits, queue ordering, and accounting; provider adapter owns opaque checkpoint payload, compaction operation, rendering, and compatibility key.
- Preserve `store: false`; do not enable automatic `context_management` in this slice.
- V1 implements only the stable standalone `/responses/compact` adapter. Codex V2 `compaction_trigger` and automatic `context_management` are explicitly deferred; the provider-checkpoint interface remains deep enough to add another adapter later without changing session semantics.
- Persist and replay the complete returned canonical `/responses/compact` output as-is; do not reconstruct, prune, summarize, or extract only the opaque item.
- Reuse production OpenAI Responses conversion/auth paths; no paid/provider API in tests.
- No inline/dynamic TypeScript imports, no `any`, no non-erasable TypeScript syntax.
- Work on isolated `work/issue-6492` from latest `upstream/main`; after review, transplant the finished commit(s) onto refreshed persistent `patch/tmp-patchs`, then sync/verify remote main.

## Task 1 — Define behavior and RED tests

- Resolve current OpenAI compaction protocol and explicit opt-in surface from the protocol, Codex, OpenCode, and cross-client research reports.
- Separate provider checkpointing from continuation authorization: preserve any pending user work/overflow retry exactly once, but never synthesize a new user turn merely because compaction completed.
- Adopt Codex/OpenCode patterns only where current source and tests prove them; do not infer that OpenCode uses native Responses checkpoints if it actually uses local summaries.
- Select the narrowest stable external behavior seams in `packages/ai`, `packages/agent`, and/or `packages/coding-agent`.
- Add deterministic fake-fetch/faux-provider tests for:
  - explicit selection of stable `/responses/compact`, including unsupported/non-opted-in custom proxy behavior;
  - native request serialization and opaque result parsing;
  - persistence and resume;
  - same-identity replay;
  - incompatible model fallback to intact history;
  - no textual summarization on native success;
  - abort/failure atomicity;
  - repeated checkpoints and trigger semantics where the production seam supports them;
  - compaction during a real unfinished retry/pending-turn path continues exactly once;
  - manual/threshold compaction with no authorized pending work does not invent or auto-submit a continuation turn;
  - queued user messages and tool call/result pairs preserve ordering across compaction and resume;
  - malformed/empty stable compact responses, HTTP errors, aborts, and stale completions commit no checkpoint;
  - compaction operation usage is distinct from estimated active replacement-window usage;
  - fork-before/fork-after frontier behavior, session checkout, stale completion after reload, and concurrent compact ownership;
  - same display model with different endpoint/auth realm is incompatible.
- Run the focused test command and capture the expected failure caused by missing behavior, not setup errors.

## Task 2 — Implement provider-native transport

- Add the narrow `packages/ai` capability and types needed to compact/replay OpenAI Responses input.
- Implement only the named stable `openai-responses-compact-v1` capability; do not silently probe, fall back across transports, or add Codex V2.
- Reuse shared request conversion and provider compatibility logic.
- Implement documented request/response validation, bounded retry/abort handling, and safe opaque preservation. The stable endpoint's complete non-empty ordered output is canonical and must be preserved.
- Make the Task 1 transport tests pass.

## Task 3 — Implement durable dual projection

- Add a distinct versioned provider checkpoint representation to active session persistence with opaque payload, provider compatibility key, frontier entry, predecessor/window generation, metadata, and usage.
- Project compatible context as newest valid ancestral checkpoint + later messages; fork/checkpoint ancestry and repeated compaction selection must be deterministic.
- Project incompatible context from intact original branch history without leaking opaque items.
- Preserve existing legacy/text compaction behavior and migrations.
- Make persistence/replay/switching/branch tests pass.

## Task 4 — Integrate compaction lifecycle and opt-in

- Wire manual, threshold, and overflow compaction to one strategy chooser and one-owner attempt/generation lifecycle.
- Resolve auth through existing model runtime paths.
- Ensure no textual summary call on native success and atomic behavior on abort/error, late completion, reload/session replacement, and compatibility changes during flight.
- Capture an explicit continuation permit before compaction: pre-prompt threshold consumes only the pending real prompt; mid-turn overflow retries the same run once; manual/post-turn compaction stops; permits are generation-bound and single-use.
- Expose explicit selection through the smallest existing configuration surface; document provider scoping/non-portability.
- Make lifecycle tests pass.

## Deferred beyond v1

- Codex V2 `compaction_trigger`, streamed checkpoint collection, and client retained-tail policy.
- Automatic Responses `context_management`, beta APIs, and `previous_response_id` chaining.
- Azure and unverified generic proxy support; runtime wire-protocol probing/fallback.
- New Agent Harness persistence parity under `packages/agent/src/harness/**`.
- Durable inbox/task redesign, distributed compaction ownership, rich checkpoint UI, and speculative cross-realm migration.

## Task 5 — Validate and review

- Run all modified focused tests.
- Run `npm run check` and fix all findings.
- Independently review spec compliance, security/privacy of opaque state, compatibility gating, test quality, and unnecessary complexity.
- Address important findings and re-review.
- Review final diff for generated/model-data noise and remove all task-local setup artifacts.

## Task 6 — Persist downstream and rebuild main

- Fetch current `origin/patch/tmp-patchs` and `upstream/main`.
- In a separate persistent-branch worktree, preserve existing history, merge latest upstream, and apply the reviewed #6492 commit(s).
- Push only with a normal fast-forward update.
- Trigger `upstream-sync.yml` from `ci`, wait for success, fetch remote `origin/main`, and verify both the persistent branch and rebuilt main contain the exact change.
