禁止向上游（earendil-works/pi）发送任何信息，包括但不限于 issues、PR、评论、review。

作为下游发行版，changelog 审阅步骤 `/cl` 对我们永远不需要执行 — 我们维护 downstream CHANGELOG/文档在自己的分支上，上游 changelog 已在上游发版时审阅过。

## 禁止本地发版/版本 bump — 版本号永远跟随上游

下游**绝不**运行 `npm run release:patch|minor|major`、`npm version`，也不在 main 上 commit 版本 bump 或 `Release vX.Y.Z` 提交。原因：

- 基础版本号（`0.87.x`）唯一来源是 `packages/*/package.json` 的 `version` 字段，由**上游 release** bump，经 upstream-sync squash 流入我们的 main。
- 下游发布是 **CI 自动的**：每次 main push，`publish-github-release.yml` 用 `package.json.version + "-xz." + GITHUB_RUN_NUMBER + "." + ATTEMPT + ".g" + SHA` 生成 tag 并发布。run number 单调递增，无需人工发版。
- main 由 sync workflow 重建（upstream + patch 分支 squash），main-only 的 `Release vX.Y.Z` commit 会在下次重建时被丢弃 → package.json 版本回退 → 后续 publish 产出更低 semver 的更新构建 → GitHub 将其标为 Latest → `pi update self` 因 `latest < current` 拒绝安装 → 用户永久卡在旧版。
- 若误发了一个高 semver 的下游 release（如 `0.87.2-xz.210` 在上游仍是 `0.87.1` 时），必须删除该 GitHub Release + 其 `xz-v*` tag + 对应本地/远端 `v*` tag，否则版本链断裂后所有用户无法 update。

下游需要"发版"时的正确动作：直接触发 sync（`gh workflow run "Upstream Sync" --ref ci`），或等下一次 upstream sync。修复随 sync 后的 publish workflow 自动上线，不需要任何版本号操作。

# Known Pre-existing Failures — Always Ignore

The pre-commit hook (`npm run check` → `tsgo --noEmit`) fails with model-catalog type errors in `packages/ai/test/*` (e.g. `"..." is not assignable to parameter of type ...`). Cause: test fixtures reference model IDs from models.dev's live catalog, which renames/retires models faster than the branch baseline tracks. These errors:

- Never relate to the change being committed (they live in upstream-maintained test files).
- Self-heal on the next upstream sync.
- Have been hit hundreds of times.

Rule: when `tsgo` failures are confined to model-ID/catalog type mismatches in `packages/ai/test/` (and equivalents such as stale model IDs in `packages/coding-agent/test/`), commit with `git commit --no-verify` without asking. Do not fix those test files, do not regenerate model data to satisfy the hook, and do not treat this as a blocker. Any other hook failure still requires fixing before commit.

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
- Sync model: `main` = upstream + ci + each `patch/*` squash-merged in `PATCH_ORDER`. No resolvers, no `*-on-accumulated` branches, no `COMPAT_RANGES`. When sync fails on a merge conflict, the repair is exactly one action: rebase the named patch branch onto the latest `upstream/main` (or onto its predecessor patch tip for dependent chains like `slow-hook-tui-only` → `session-tree-splice`), force-push it, rerun sync. Dependent patches must keep their predecessor patch tip in their ancestry so their squash-merge applies after the predecessor's content.
- When adding a new patch branch, update BOTH `scripts/rebuild-from-inputs.sh` (DEFAULT_INPUTS pin, PATCH_ORDER entry, merge_squash block) AND `.github/workflows/upstream-sync.yml` (fetch refspec + rebuild_args list) on `ci`, push `ci` and the patch branch to `origin`, then trigger the sync workflow from the updated `ci` ref if an immediate remote `main` rebuild is needed. Before pushing, replay locally: `scripts/rebuild-from-inputs.sh --source <repo> --target <fresh-path>` must complete green — never use CI as the debugger.
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
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Use only erasable TypeScript syntax (Node strip-only mode) in code checked by the root config (`packages/*/src`, `packages/*/test`, `packages/coding-agent/examples`): no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other constructs needing JS emit. Use explicit fields with constructor assignments.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.
- Never hardcode key checks (e.g. `matchesKey(keyData, "ctrl+x")`). Add defaults to `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS` so they stay configurable.
- Never modify `packages/ai/src/models.generated.ts` directly; update `packages/ai/scripts/generate-models.ts` instead, then regenerate. Including the resulting `models.generated.ts` diff is always OK, even if regeneration includes unrelated upstream model metadata changes.

## Commands

- After code changes (not docs): `npm run check` (full output, no tail). Fix all errors, warnings, and infos before committing. Does not run tests.
- Never run `npm run build` or `npm test` unless requested by the user.
- Never run the full vitest suite directly: it includes e2e tests that activate when endpoint/auth env vars are present. For all non-e2e tests, run `./test.sh` from the repo root. Otherwise run specific tests from the package root:
  - Vitest: `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/specific.test.ts`
  - `packages/tui` (`node:test`): `node --test test/specific.test.ts`
- If you create or modify a test file, run it and iterate on test or implementation until it passes.
- For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` + the faux provider. No real provider APIs, keys, or paid tokens.
- When regressions tests for fixing a github issue, add a comment with the github issue number next to the test.
- For ad-hoc scripts, `write` them to a temp file (e.g. `/tmp`), run, edit if needed, remove when done. Don't embed multi-line scripts in `bash` commands.
- Never commit unless the user asks.

## Dependency and Install Security

- Treat npm dep and lockfile changes as reviewed code. Direct external deps stay pinned to exact versions.
- When updating `undici`, you MUST read its changelog/release notes for the target version and evaluate whether any changes may affect functionality before applying the update.
- Hydrate/update locally with `npm install --ignore-scripts`; clean/CI-style with `npm ci --ignore-scripts`. Don't run lifecycle scripts unless the user asks.
- If dep metadata changes, refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`.
- If `packages/coding-agent/npm-shrinkwrap.json` needs regen, run `node scripts/generate-coding-agent-shrinkwrap.mjs` (verify with `--check` or `npm run check`). New deps with lifecycle scripts require review and an explicit allowlist entry in that script; never add one silently.
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
- Never force push.

## Issues and PRs

See `CONTRIBUTING.md` for the contributor gate (auto-close workflows, `lgtm`/`lgtmi`, quality bar).

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

Run the TUI in a controlled terminal (from the repo root):

```bash
tmux new-session -d -s pi-test -x 80 -y 24
tmux send-keys -t pi-test "./pi-test.sh" Enter
sleep 3 && tmux capture-pane -t pi-test -p     # capture after startup
tmux send-keys -t pi-test "your prompt here" Enter
tmux send-keys -t pi-test Escape               # special keys (also C-o for ctrl+o, etc.)
tmux kill-session -t pi-test
```

## Changelog

Location: `packages/*/CHANGELOG.md` (one per package).

Sections under `## [Unreleased]`: `### Breaking Changes` (API changes requiring migration), `### Added`, `### Changed`, `### Fixed`, `### Removed`.

Rules:

- All new entries go under `## [Unreleased]`. Read the full section first and append to existing subsections; never duplicate them.
- Released version sections (e.g. `## [0.12.2]`) are immutable; never modify them.
- Do not create changelog entries when working on a branch other than `main` or pull request

Attribution:

- Internal (from issues): `Fixed foo bar ([#123](https://github.com/earendil-works/pi/issues/123))`
- External contributions: `Added feature X ([#456](https://github.com/earendil-works/pi/pull/456) by [@username](https://github.com/username))`

## Releasing

**Lockstep versioning**: all packages share one version; every release updates all together. `patch` = fixes + additions, `minor` = breaking changes. No major releases.

1. **Update CHANGELOGs**: ask the user whether they ran the `/cl` prompt on the latest commit on `main`. If not, they must run `/cl` first to audit and update each package's `[Unreleased]` section before releasing.

2. **Local smoke test**: build an unpublished release and smoke test from outside the repo (so it can't resolve workspace files):
   ```bash
   npm run release:local -- --out /tmp/pi-local-release --force
   cd /tmp

   # Node package install smoke tests
   /tmp/pi-local-release/node/pi --help
   /tmp/pi-local-release/node/pi --version
   /tmp/pi-local-release/node/pi --list-models
   /tmp/pi-local-release/node/pi -p "Say exactly: ok"
   /tmp/pi-local-release/node/pi

   # Bun binary smoke tests
   /tmp/pi-local-release/bun/pi --help
   /tmp/pi-local-release/bun/pi --version
   /tmp/pi-local-release/bun/pi --list-models
   /tmp/pi-local-release/bun/pi -p "Say exactly: ok"
   /tmp/pi-local-release/bun/pi
   ```
   Verify both Node and Bun startup, model/account listing, interactive startup, and at least one real prompt with the intended default provider. The bare commands `/tmp/pi-local-release/node/pi` and `/tmp/pi-local-release/bun/pi` start interactive mode; run each in tmux, submit a prompt, and wait for the model reply before considering the interactive smoke test passed. Failures are release blockers unless the user explicitly accepts the risk.

3. **Run the release script**:
   ```bash
   PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:patch    # fixes + additions
   PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:minor    # breaking changes
   ```
   Use `npm_config_min_release_age=0` only for the release command. The repo's normal npm age gate can otherwise block the release lockfile refresh when the current workspace package version was published recently. Review any lockfile or shrinkwrap diffs the release creates before push.

   The release script bumps all package versions, updates changelogs, regenerates release artifacts, runs `npm run check`, commits `Release vX.Y.Z`, tags `vX.Y.Z`, adds fresh `## [Unreleased]` changelog sections, commits `Add [Unreleased] section for next cycle`, then pushes `main` and the tag. Do not rerun the release script after a tag was pushed.

4. **CI verifies and announces the npm release**: pushing the `vX.Y.Z` tag triggers `.github/workflows/build-binaries.yml`. The `publish-npm` job uses npm trusted publishing through GitHub Actions OIDC with environment `npm-publish`; no local `npm publish`, `npm whoami`, OTP, or WebAuthn flow is required. After publishing, `announce-pi-dev-release` verifies every public workspace package resolves at the exact release version and that its npm tarball is available, then writes the verified release marker to R2. `pi.dev/api/latest-version` reads that marker; it must never announce a release from npm before this job succeeds.

5. **If CI publish or announcement fails**: inspect the failed job. The publish helper is idempotent and skips package versions already present on npm; the announcement job rechecks availability before updating the R2 marker. Rerun the failed job or workflow after fixing CI or transient npm issues. Do not rerun `npm run release:patch` or `npm run release:minor` for the same version.

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.
