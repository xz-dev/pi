禁止向上游（earendil-works/pi）发送任何信息，包括但不限于 issues、PR、评论、review。

## 同类实现参考

新增或修复下游 patch 前，优先检查仓库内官方 Pi Durable 的相关实现，再按问题相关性参考 Codex、Claude Code、OpenCode、Hermes Agent，核实它们是否已解决同类问题，以及实现机制能否用于 Pi。优先查官方源码、文档和测试；闭源或无法核实的部分明确标记为未知。

Pi Durable 的现有代码或公共接口满足需求时，优先直接复用，避免自行重写和承担额外维护。在补丁说明或计划中记录参考来源、采用或不采用的理由及适用边界。借鉴成熟实现不等于过度设计：选择满足 Pi 当前需求的最小机制，不照搬无关框架、依赖或功能；取得足够证据后进入验证，不把完整审计所有参考项目作为前置条件。

作为下游发行版，changelog 审阅步骤 `/cl` 对我们永远不需要执行 — 我们维护 downstream CHANGELOG/文档在自己的分支上，上游 changelog 已在上游发版时审阅过。

## 禁止本地发版/版本 bump — 版本号永远跟随上游

下游**绝不**运行 `npm run release:patch|minor|major`、`npm version`，也不在 main 上 commit 版本 bump 或 `Release vX.Y.Z` 提交。原因：

- 基础版本号（`0.87.x`）唯一来源是 `packages/*/package.json` 的 `version` 字段，由**上游 release** bump，经 upstream-sync squash 流入我们的 main。
- 下游发布是 **CI 自动的**：每次 main push，`publish-github-release.yml` 用 `package.json.version + "-xz." + GITHUB_RUN_NUMBER + ".1.g" + SHA` 生成 tag 并发布（第三段固定为 1，与重跑次数无关，所以 `gh run rerun --failed` 只重建部分平台也能对齐版本）。run number 单调递增，无需人工发版。
- main 由 sync workflow 重建（upstream + patch 分支 squash），main-only 的 `Release vX.Y.Z` commit 会在下次重建时被丢弃 → package.json 版本回退 → 后续 publish 产出更低 semver 的更新构建 → GitHub 将其标为 Latest → `pi update self` 因 `latest < current` 拒绝安装 → 用户永久卡在旧版。
- 若误发了一个高 semver 的下游 release（如 `0.87.2-xz.210` 在上游仍是 `0.87.1` 时），必须删除该 GitHub Release + 其 `xz-v*` tag + 对应本地/远端 `v*` tag，否则版本链断裂后所有用户无法 update。

下游需要"发版"时的正确动作：直接触发 sync（`gh workflow run "Upstream Sync" --ref ci`）。修复随 sync 后的 publish workflow 自动上线，不需要任何版本号操作。

# 下游不等上游 — Downstream Never Waits for Upstream

原则：下游完全不等上游。上游带进来的问题（失败测试、过期 fixture、catalog drift、构建或发版阻断）由我们直接修复，不以"等上游修"或"下次 sync 自愈"作为处理方式。

- Upstream breakage that blocks our CI, sync, or publish is our blocker. Fix it in the downstream branch that owns the area (`ci` for workflow/scripts/gates, a `patch/*` branch for product code and its tests), then trigger sync so the fix ships.
- Do not leave publish red waiting for upstream, and do not hide a real failure by widening skip lists or allow-lists when a direct fix is possible. A skip is acceptable only when the test needs unavailable external resources, and must name the reason.
- When upstream later lands an equivalent fix, retire ours (drop the patch or overlay, or rebase it away) instead of carrying duplicates.

Model-catalog drift is the most common case. Provider model data is hydrated from a live catalog, so test fixtures can reference model IDs that no longer exist (e.g. `"..." is not assignable to parameter of type ...` in `packages/*/test`, or runtime assertions on a dropped model). Update the fixtures to current catalog IDs on the owning downstream branch. A local commit may still use `git commit --no-verify` when its hook failure is confined to this drift class and the drift is unrelated to the change, but the drift itself must be fixed downstream, not ignored.

# Development Rules

## Downstream Distribution Workflow

This repository is the `xz-dev/pi` downstream distribution fork of `earendil-works/pi`. Do not treat `main` as a normal long-lived development branch.

`main` is automatically rebuilt from upstream and downstream branches by `.github/workflows/upstream-sync.yml`. Direct downstream-only changes committed only to `main` are temporary and can disappear on the next sync. Every downstream change that must persist must live on an appropriate downstream branch, then be brought back to `main` through the sync workflow's squash-merge process.

Branch placement rules:

- Put fork CI, publishing, packaging, release automation, GitHub Actions, and sync workflow changes on `ci`.
- Put downstream code fixes or behavior patches on a dedicated patch branch such as `patch/esc-abort-and-manual-retry`.
- If a new downstream branch is introduced, update `.github/workflows/upstream-sync.yml` in the persistent workflow branch (`ci`) so the sync job fetches that branch, squash-merges it in the correct order, and uses an explicit commit message such as `merge <branch> branch`.
- After changing any persistent downstream branch that participates in sync, rebuild `main` from the upstream sync base and recreate the squash merge commits. Do not leave the only copy of the change as a standalone `main` commit.
- When a patch branch conflicts with moved upstream, repair it by rebasing onto the latest `upstream/main` (preserving the branch's own commit sequence; rebase rewrites SHAs but keeps the development history readable). Do not add resolver scripts, accumulated compat branches, or exact-conflict-shape pins to the sync machinery — that double-layer was removed because every upstream drift cost a manual repair in two places at once.
- Before saying a downstream change is complete, verify both the persistent branch and the rebuilt `main` contain the intended result.

Operational checklist for downstream sync work:

- Create downstream code patch branches from the latest `upstream/main`, not from the rebuilt downstream `main`.
- Keep workflow/packaging changes on `ci`; keep runtime behavior changes on a named patch branch. When a fix spans both, split it across branches instead of mixing branch responsibilities.
- Sync model: `main` = upstream + ci + each `patch/*` squash-merged in `PATCH_ORDER`. No resolvers, no `*-on-accumulated` branches, no `COMPAT_RANGES`. When sync fails on a merge conflict, the repair is exactly one action: rebase the named patch branch onto the latest `upstream/main` (or onto its predecessor patch tip for dependent chains like `manual-retry` → `slow-hook-tui-only`), force-push it, rerun sync. Dependent patches must keep their predecessor patch tip in their ancestry so their squash-merge applies after the predecessor's content.
- When adding a new patch branch, update BOTH `scripts/rebuild-from-inputs.sh` (PATCH_ORDER entry, merge_squash block; no commit-ID pins) AND `.github/workflows/upstream-sync.yml` (fetch refspec + rebuild_args list) on `ci`, push `ci` and the patch branch to `origin`, then trigger the sync workflow from the updated `ci` ref if an immediate remote `main` rebuild is needed. Before pushing, replay locally: `scripts/rebuild-from-inputs.sh --source <repo> --target <fresh-path>` must complete green — never use CI as the debugger.
- Never hand-expand a short SHA into a full one. Always resolve with `git rev-parse`/`git ls-remote`; fabricated SHA tails cost real debugging rounds.
- After the sync workflow succeeds, fetch `origin/main` and force-sync the local `main` to it before reporting final status. Do not trust a locally rebuilt `main` as the final remote state.
- For fork package versions, remember that SemVer prerelease versions such as `0.80.6-xz.29.1.g<sha>` are valid. Do not remove release assets such as `CHANGELOG.md` to hide downstream packaging symptoms. Preserve the real fork package version and add explicit package metadata or parser handling when a stable upstream changelog baseline is needed.

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text (e.g., "Thanks @user" not "Thanks so much @user!")
- Technical prose only, be direct
- Use concise, clear, simple language. Define unavoidable jargon before using it.
- Explain non-trivial designs and problems as: problem, concrete example or short trace, then solution. State why the solution is necessary and distinguish it from optional complexity.
- Prefer concrete behavior and small illustrations over abstract summaries, dense terminology, or unexplained lists of changes.
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Check node_modules for external API types; don't guess.
- **Imports:** use top-level imports, including `import type`. Dynamic value imports are allowed in `packages/ai/src/api/*.lazy.ts` only to preserve lazy loading of the corresponding API implementation. Inline type imports remain prohibited.
- In `packages/coding-agent`, resolve package assets through helpers in `src/config.ts`. Do not use `__dirname` directly; the helpers account for source checkouts, npm installations, and standalone binaries.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Use only erasable TypeScript syntax (Node strip-only mode) in code checked by the root config (`packages/*/src`, `packages/*/test`, `packages/coding-agent/examples`): no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other constructs needing JS emit. Use explicit fields with constructor assignments.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.
- Never hardcode key checks (e.g. `matchesKey(keyData, "ctrl+x")`). Add defaults to `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS` so they stay configurable.
- Never modify `packages/ai/src/models.generated.ts` directly; update the catalog definitions in `packages/ai/catalog/` instead (see its README), then regenerate. Including the resulting `models.generated.ts` diff is always OK, even if regeneration includes unrelated upstream model metadata changes. The generated model data in `packages/ai/src/providers/data/` is gitignored: never stage it, and don't look for it in git history.

## Chord v2 Code Style

Binding for `packages/chord/src/next/` and its tests, when writing and when reviewing. The model is pi-durable's source.

- Files: one concept per file, named after it; no one-helper files, no grab-bag files. First line: a comment saying what the file is for. Order: imports, exported types, then the public entry point first and its helpers below it in the order they are used; constants right above their first user. A blank line between top-level declarations. Split files by concept, never by size: one concept may take a long file (up to about 1,000 lines is fine); a second concept in a file is the reason to split.
- Functions: every export has a one-line doc comment saying what it does or guarantees. Inline comments explain a non-obvious why (cost, race, decided rule), never what the next line does. Short functions with one job (about 40 lines needs a reason; one `switch` over a tagged union is fine). No boolean flag parameters that switch behaviour: two functions or a tagged value. Never write the same lines twice. Context last: required args, then `context`/`ctx` (always required, as in Durable; optional only on error-reporting paths), then optional args.
- Types and checks: tagged unions for every state and result. Casts only where TypeScript cannot express a decided invariant, each with a short why. Every remaining runtime check names the trust boundary it serves (wire input, schema-checked params and arguments, declaration policy the types cannot express). Same-host values are plain data, immutable by convention: never copied, frozen or walked to enforce it; freeze only Chord-owned metadata when a decision says so. No defensive code against broken adapters, callers or our own modules.
- Cost and memory: no hot-path work a decision did not ask for (walks, copies, compilations, per-call allocations). The function doing counted work counts it through its context; call sites never count for others. Caches are `WeakMap`s keyed by their owner, each with a GC test; no module-level strong caches.
- Names and API: the design's vocabulary (`params`, `binding`, `principal key`), no invented synonyms; decided `ChordError` codes and reasons. Export only what a later layer or app needs. No dev or test modes, no unrequested options.
- Tests: one test file per source file, one `describe` per mechanism, the layer spec's test list case by case; cost guards through the in-memory telemetry adapter; GC tests for every cache and binding. Every slice also adds one or more runnable examples in `packages/chord/test/next/examples/NN-topic.ts`, one topic each, numbered across slices, written as references for Chord's users (Durable's `test/examples/` format: header with what it shows and how to run it, commented steps, printed results).
- Slices: Chord v2 is built in vertical slices (`packages/chord/docs/next/slices.md`). Implementers and reviewers read the slice spec, the feature map in `slices.md` and the whole of `packages/chord/docs/next/design.md` in full, and check the work against all three; slice specs cite design sections for orientation, not as a reading limit.
- Deferred work: anything left to a later slice goes into the section "Carry-over" of `packages/chord/docs/next/slices.md` under that slice, in the same change; a slice's spec and build include every entry of its section.
- Before reporting: re-read every changed file top to bottom as a stranger would; each file must be understandable without jumping around. Then `npm run check` and the layer's tests.

## Commands

- After code changes (not docs): `npm run check` (full output, no tail). Fix all errors, warnings, and infos before committing. Does not run tests.
- Run `npm run build` whenever something needs built output (`dist/`): tests or benchmarks that import built packages, Durable's workerd suite. Never use it to type check or lint: that is `npm run check`, the preferred check.
- Never run `npm test` unless requested by the user.
- Never run the full vitest suite directly: it includes e2e tests that activate when endpoint/auth env vars are present. For all non-e2e tests, run `./test.sh` from the repo root. Otherwise run specific tests from the package root:
  - Vitest: `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/specific.test.ts`
  - `packages/tui` (`node:test`): `node --test test/specific.test.ts`
- If you create or modify a test file, run it and iterate on test or implementation until it passes.
- For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` + the faux provider. No real provider APIs, keys, or paid tokens.
- When regressions tests for fixing a github issue, add a comment with the github issue number next to the test.
- For ad-hoc scripts, `write` them to a temp file (e.g. `/tmp`), run, edit if needed, remove when done. Don't embed multi-line scripts in `bash` commands.
- Never commit unless the user asks.

## Dependency and Install Security

- Treat npm dep and lockfile changes as reviewed code. Direct registry deps, including internal workspace deps, stay pinned to exact versions.
- When updating `undici`, you MUST read its changelog/release notes for the target version and evaluate whether any changes may affect functionality before applying the update.
- Hydrate/update locally with `npm install --ignore-scripts`; clean/CI-style with `npm ci --ignore-scripts`. Don't run lifecycle scripts unless the user asks.
- If dep metadata changes, refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`.
- If `packages/coding-agent/install-lock/` needs regen, run `node scripts/generate-coding-agent-install-lock.mjs` (verify with `--check` or `npm run check`). New deps with lifecycle scripts require review and an explicit allowlist entry in that script; never add one silently.
- Pre-commit blocks lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1`. Don't bypass unless the user wants the lockfile change committed.

## Git

Multiple pi sessions may be running in this cwd at the same time, each modifying different files. Git operations that touch unstaged, staged, or untracked files outside your own changes will stomp on other sessions' work. Follow these rules:

Committing:

- Only commit files YOU changed in THIS session.
- Stage explicit paths (`git add <path1> <path2>`); never `git add -A` / `git add .`.
- Before committing, run `git status` and verify you are only staging your files.
- `packages/ai/src/models.generated.ts` may always be included alongside your files.
- Message format: `{feat,fix,docs}[(ai,tui,agent,coding-agent)]: <commit message> (optionally multiple lines)`. Message is informative and concise.

Never run (destroys other agents' work or bypasses checks):

- `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.

If rebase conflicts occur:

- Resolve conflicts only in files you modified.
- If a conflict is in a file you did not modify, abort and ask the user.

Force pushes are allowed in this downstream repository; the upstream blanket prohibition does not apply. For authorized downstream maintenance, prefer `git push --force-with-lease=<ref>:<expected-old-sha>` and retain the old tip before rewriting history. Stop on a lease mismatch rather than overwriting concurrent work.

## Issues and PRs

See `CONTRIBUTING.md` for the contributor quality bar. This fork does not auto-close issues or PRs.

When reviewing PRs:

- Do not run `gh pr checkout`, `git switch`, or otherwise move the worktree to the PR branch unless the user explicitly asks.
- Use `gh pr view`, `gh pr diff`, `gh api`, and local `git show`/`git diff` against fetched refs to inspect PR metadata, commits, and patches without changing branches.
- If you need PR file contents, fetch/read them into temporary files or use `git show <ref>:<path>` without switching branches.

When creating issues:

- Add `pkg:*` labels for affected packages (`pkg:agent`, `pkg:ai`, `pkg:coding-agent`, `pkg:tui`); use all that apply.

When posting issue/PR comments:

- Write the comment to a temp file and post with `gh issue/pr comment --body-file` (never multi-line markdown via `--body`).
- Keep comments concise, technical, in the user's tone.
- End every AI-posted comment with the AI-generated disclaimer line specified by the originating prompt (e.g. `This comment is AI-generated by `/wr``).

When closing issues via commit:

- Include `fixes #<number>` or `closes #<number>` in the message so merging auto-closes the issue. For multiple issues, repeat the keyword per issue (`closes #1, closes #2`); a shared keyword (`closes #1, #2`) only closes the first.

## Testing pi Interactive Mode with tmux

For testing pi's interactive mode, load and follow [.pi/skills/interactive-testing.md](.pi/skills/interactive-testing.md).

## Changelog

Location: `packages/*/CHANGELOG.md` (one per package).

Sections under `## [Unreleased]`: `### Breaking Changes` (API changes requiring migration), `### Added`, `### Changed`, `### Fixed`, `### Removed`.

Rules:

- All new entries go under `## [Unreleased]`. Read the full section first and append to existing subsections; never duplicate them.
- Released version sections (e.g. `## [0.12.2]`) are immutable; never modify them.
- Do not create changelog entries when the work targets a branch other than `main`

Attribution:

- Internal (from issues): `Fixed foo bar ([#123](https://github.com/earendil-works/pi/issues/123))`
- External contributions: `Added feature X ([#456](https://github.com/earendil-works/pi/pull/456) by [@username](https://github.com/username))`

## Releasing

For release preparation, publishing, verification, or recovery, load and follow [.pi/skills/release.md](.pi/skills/release.md).

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.
