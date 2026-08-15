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

- Only `xz-dev/pi` `refs/heads/main` push or explicit dispatch contexts may publish, and the checked-out clean `HEAD`, manifest commit, and `GITHUB_SHA` must be identical.
- `scripts/lib/bun-targets.mjs` is the authoritative 12-target Bun descriptor matrix. `scripts/build-binaries.sh` produces version-correct ZIP bundles containing a native `pi` wrapper, `pi-native`, matching GNU/musl native dependencies, and every runtime asset. `scripts/prepare-github-release.mjs` verifies each archive's required-path inventory and archive safety, then emits `release-manifest.json`, `SHA256SUMS`, and `attestation-subjects.jsonl`. There are no generated installer scripts or hybrid npm tarballs.
- The manifest freezes the exact tag, full commit, downstream and upstream API versions, per-platform bundle archive metadata (file, bytes, sha256), the bundle layout version, and the required-path inventory per platform. The verifier checks every required path and rejects unknown unsafe archive entries.
- Distribution versions and exact tags are `<api>-xz.<GITHUB_RUN_NUMBER>.<GITHUB_RUN_ATTEMPT>.g<sha8>` and `xz-v<distributionVersion>`. Each workflow attempt has its own immutable tag; repeated execution within that attempt resumes the same tag.
- The publication workflow builds one target per parallel job, aggregates exactly 12 archives, runs native smoke on each GitHub-hosted OS/architecture, runs musl targets in pinned native userspaces, and executes direct-to-managed plus managed-to-managed self-update E2E before publication.
- The publication job alone receives `contents:write`, `id-token:write`, and `attestations:write`. It creates GitHub build-provenance attestations for the 12 bundles, manifest, acceptance record, and checksum file, then verifies those stored attestations before making a Release public. `attestation-subjects.jsonl` is an immutable Release audit asset but is not itself an attestation subject.
- Publication is staged as a draft. An interrupted draft may be resumed only when its target commit is exact and its uploaded assets are an exact hash-matching subset; only missing assets are uploaded. No asset is overwritten. A mismatch, unknown asset, wrong commit, or incomplete already-public Release fails closed.
- After all assets and hashes are verified, publish as non-draft and non-prerelease. Re-read `refs/heads/main` immediately before that transition: use `make_latest=true` only when it still equals `GITHUB_SHA`; otherwise publish the immutable historical Release with `make_latest=false` so a delayed older run cannot replace Latest.
- An already-published Release with the exact target and exact complete asset hashes is an idempotent no-op. Releases, tags, and assets are immutable and retained; normal automation never deletes or overwrites them.
- Installation is self-contained: `pi`, `pi-native`, native modules, WASM, themes, assets, HTML export templates, docs, and examples travel together as one version-matched ZIP. Schema-v4 installer-based releases require one manual ZIP migration to schema v5.
- POSIX activation stages and validates the new bundle, atomically replaces the root wrapper, then atomically replaces `current`. Windows uses a stable waiting wrapper, installs a distinct bundle directory, and atomically replaces only `current`; it never overwrites the running `pi.exe`.
- `pi update --self` from an xz-dev binary discovers only the latest immutable `xz-dev/pi` Release, downloads the exact target recorded in `piConfig.releaseTarget`, verifies the GitHub asset digest plus archive/package identity, and activates it without parsing the audit manifest at runtime. An xz-dev source checkout remains user-managed.
- Do not publish this fork to npm, GitHub Packages, tags outside `xz-v*`, or a second Release plane. `.github/workflows/build-binaries.yml` is persistently removed from generated `main`; the `ci` overlay and generated-main verification continue removing it if upstream ever reintroduces it.
- Keep runtime self-update behavior on `patch/native-wrapper-release`; keep descriptor, packaging, Scoop generator/publisher, E2E workflow, README, and this guide on `ci`. Generated Scoop artifacts alone live on `scoop`. Source automation is squash-integrated through `ci`; `scoop` is never merged into generated `main`.
- Integrate `patch/shutdown-lifecycle-log` after `patch/provider-transparent-compaction`; its guarded resolver must preserve the combined compaction and manual-retry `AgentSession` imports while adding lifecycle diagnostics.
- Integrate the commits after `patch/shutdown-lifecycle-log` on `patch/slow-hook-execution-kind` immediately after that base patch; they extend those lifecycle diagnostics with synchronous and asynchronous execution labels.

## Patch retirement

When upstream merges equivalent behavior or an enabled downstream replacement supersedes a patch, verify the replacement, remove the retired patch from the configured order and README, rebuild and validate `main`, then move the source branch to `archive/<patch-name>` and delete its original `patch/<patch-name>` ref.
