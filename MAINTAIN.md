# Downstream maintenance

This fork is rebuilt from `earendil-works/pi` rather than developed directly on generated `main`.

## Branch ownership

- `upstream/main` is the rebuild baseline.
- `ci` owns downstream workflows, packaging, release gates, this guide, and the downstream README.
- `patch/contributor-approval` remains the bot-owned approval branch, including preserved commit `fa047a9bc8f3254bfde47bad2e93207f7a8bf62d`. After `ci`, generated `main` applies a deterministic additive union of the current upstream `.github/APPROVED_CONTRIBUTORS` file plus names present only on that branch. Whole-file replacement is forbidden.
- `scoop` is an unrelated-root distribution branch containing only generated `bucket/pi.json`.
- Product changes remain on the ordered `patch/*` branches declared in `.github/workflows/upstream-sync.yml`.
- Generated `main` contains one countable squash integration commit for `ci` and each enabled patch. Do not fix release or product problems only on generated `main`.

## Rebuild rules

1. Fetch a specific fresh upstream `main`, `ci`, and every configured patch ref.
2. Rebuild in the fixed order in `.github/workflows/upstream-sync.yml`.
3. Stop on unexpected conflicts or empty patch integrations.
4. Run all pre-push build, check, focused integration, packed-release, GitHub Release candidate, audit, and signature gates.
5. Update `main` only with `--force-with-lease`; a lease failure requires investigation and a fresh rebuild.

## GitHub Release distribution rules

- Only an `xz-dev/pi` `refs/heads/main` push or explicit dispatch from `main` may publish. An explicit workflow dispatch from any non-`main` repository branch is a non-publishing release probe that must complete source validation, all 12 native builds, archive acceptance, and self-update E2E while `publish-release` remains skipped. In every context the checked-out clean `HEAD` and `GITHUB_SHA` must be identical.
- `scripts/lib/bun-targets.mjs` is the authoritative 12-target Bun 1.4 descriptor matrix. Public baseline/modern x64 asset names remain for update compatibility, but both aliases compile the same Nehalem-compatible runtime-dispatched Bun target. Every Release build runs on a GitHub-hosted runner whose OS and architecture match its target, so all twelve artifacts use `--minify --bytecode --format=esm`; ad-hoc cross-builds omit bytecode because cross-compiled bytecode remains unsafe (oven-sh/bun#18416). `scripts/build-binaries.sh` produces version-correct ZIP bundles containing a native `pi` wrapper, `pi-native`, matching GNU/musl native dependencies, and every runtime asset. Native Windows 7z archives have their central-directory creator OS and POSIX regular-file/directory modes normalized before verification so the unchanged runtime self-updater can reject symlinks and other unsafe types consistently. `scripts/prepare-github-release.mjs` verifies each archive's required-path inventory and archive safety, then emits `release-manifest.json`, `SHA256SUMS`, and `attestation-subjects.jsonl`. There are no generated installer scripts or hybrid npm tarballs.
- The manifest freezes the exact tag, full commit, downstream and upstream API versions, per-platform bundle archive metadata (file, bytes, sha256), the bundle layout version, and the required-path inventory per platform. The verifier checks every required path and rejects unknown unsafe archive entries.
- Distribution versions and exact tags are `<api>-xz.<GITHUB_RUN_NUMBER>.<GITHUB_RUN_ATTEMPT>.g<sha8>` and `xz-v<distributionVersion>`. Each workflow attempt has its own immutable tag; repeated execution within that attempt resumes the same tag.
- The publication workflow builds one target per parallel job on a matching native OS and architecture, aggregates exactly 12 archives, proves each final native executable loads its entrypoint from embedded bytecode, runs native smoke on each GitHub-hosted OS/architecture, runs musl targets in pinned native userspaces, and executes direct-to-managed plus managed-to-managed self-update E2E before publication. Linux archive smoke must provision an explicit temporary Xvfb display and still load and call the packaged clipboard addon; never weaken the gate by skipping clipboard verification in headless CI. Musl smoke mounts only that temporary X11 socket into the pinned container.
- The publication job alone receives `contents:write`, `id-token:write`, and `attestations:write`. It creates GitHub build-provenance attestations for the 12 bundles, manifest, acceptance record, and checksum file, then verifies those stored attestations before making a Release public. `attestation-subjects.jsonl` is an immutable Release audit asset but is not itself an attestation subject.
- Publication is staged as a draft. An interrupted draft may be resumed only when its target commit is exact and its uploaded assets are an exact hash-matching subset; only missing assets are uploaded. No asset is overwritten. A mismatch, unknown asset, wrong commit, or incomplete already-public Release fails closed.
- After all assets and hashes are verified, publish as non-draft and non-prerelease. Re-read `refs/heads/main` immediately before that transition: use `make_latest=true` only when it still equals `GITHUB_SHA`; otherwise publish the immutable historical Release with `make_latest=false` so a delayed older run cannot replace Latest.
- An already-published Release with the exact target and exact complete asset hashes is an idempotent no-op. Releases, tags, and assets are immutable and retained; normal automation never deletes or overwrites them.
- Installation is self-contained: `pi`, `pi-native`, native modules, WASM, themes, assets, HTML export templates, docs, and examples travel together as one version-matched ZIP. Schema-v4 installer-based releases require one manual ZIP migration to schema v5.
- POSIX activation stages and validates the new bundle, atomically replaces the root wrapper, then atomically replaces `current`. Windows uses a stable waiting wrapper, installs a distinct bundle directory, and atomically replaces only `current`; it never overwrites the running `pi.exe`.
- `pi update --self` from an xz-dev binary discovers only the latest immutable `xz-dev/pi` Release, downloads the exact target recorded in `piConfig.releaseTarget`, verifies the GitHub asset digest plus archive/package identity, and activates it without parsing the audit manifest at runtime. An xz-dev source checkout remains user-managed.
- Do not publish this fork to npm, GitHub Packages, tags outside `xz-v*`, or a second Release plane. `.github/workflows/build-binaries.yml` is persistently removed from generated `main`; the `ci` overlay and generated-main verification continue removing it if upstream ever reintroduces it.
- Keep runtime self-update behavior on `patch/native-wrapper-release`; keep descriptor, packaging, Scoop generator/publisher, E2E workflow, README, and this guide on `ci`. Generated Scoop artifacts alone live on `scoop`. Source automation is squash-integrated through `ci`; `scoop` is never merged into generated `main`.
- Integrate `patch/slow-hook-tui-only` after `patch/retry-non-retryable-patterns`. It owns transient TUI-only slow-hook and shutdown diagnostics and must never create timing session entries, model context, print/RPC events, or lifecycle log files.
- Integrate `patch/session-tree-splice` as the final compaction-related patch after `patch/slow-hook-tui-only`. Provider-transparent Responses remote compaction and its dependent pre-provider patch are temporarily retired from generated `main`; their source branches remain retained for re-evaluation. Do not reintroduce provider-specific compaction into the sync chain without a fresh compatibility review.
- Patch branches must never carry `packages/*/CHANGELOG.md` hunks. Upstream rewrites the `[Unreleased]` section every release cycle, so any changelog hunk on a patch branch becomes a guaranteed recurring squash conflict. Downstream-facing notes live in this guide, the README patch list, and release automation on `ci`. The sync workflow enforces this with a pre-merge guard that fails on any integrated patch or tmp branch touching an upstream changelog; fix the branch before re-running sync instead of resolving the conflict in generated `main`.

## Patch retirement

Temporary retirement removes a patch from sync fetch/merge/test integration and enabled README features while retaining its source branch for re-evaluation. Do not archive or delete the source ref.

Permanent retirement requires verified replacement evidence, removal from configured order and README, a validated rebuilt `main`, archival to `archive/<patch-name>`, then deletion of the original `patch/<patch-name>` ref.
