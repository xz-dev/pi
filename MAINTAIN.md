# Downstream maintenance

This fork is rebuilt from `earendil-works/pi` rather than developed directly on generated `main`.

## Branch ownership

- `upstream/main` is the rebuild baseline.
- `ci` owns downstream workflows, packaging, release gates, this guide, and the downstream README.
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
- `scripts/prepare-github-release.mjs` emits one canonical hybrid npm tarball retaining the `@earendil-works/pi-coding-agent` name, plus `release-manifest.json`, `install.ts`, thin `install.sh` / `install.ps1` bootstraps, `SHA256SUMS`, and `attestation-subjects.txt`.
- Distribution versions and exact tags are `<api>-xz.<GITHUB_RUN_NUMBER>.<GITHUB_RUN_ATTEMPT>.g<sha8>` and `xz-v<distributionVersion>`. Each workflow attempt has its own immutable tag; repeated execution within that attempt resumes the same tag.
- The pre-push workflow must prepare and install the exact candidate before updating `main`. The publication workflow independently builds/checks/tests, uploads that exact candidate, then verifies npm and Bun global installs on Linux, macOS, and Windows.
- The publication job alone receives `contents:write`, `id-token:write`, and `attestations:write`. It creates GitHub build-provenance attestations for the package, manifest, installers, bootstraps, and checksum file, then verifies those stored attestations before making a Release public. `attestation-subjects.txt` is an immutable Release audit asset but is not itself an attestation subject.
- Publication is staged as a draft. An interrupted draft may be resumed only when its target commit is exact and its uploaded assets are an exact hash-matching subset; only missing assets are uploaded. No asset is overwritten. A mismatch, unknown asset, wrong commit, or incomplete already-public Release fails closed.
- After all assets and hashes are verified, publish as non-draft and non-prerelease. Re-read `refs/heads/main` immediately before that transition: use `make_latest=true` only when it still equals `GITHUB_SHA`; otherwise publish the immutable historical Release with `make_latest=false` so a delayed older run cannot replace Latest.
- An already-published Release with the exact target and exact complete asset hashes is an idempotent no-op. Releases, tags, and assets are immutable and retained; normal automation never deletes or overwrites them.
- The one-time move from legacy `@xz-dev/pi-coding-agent` is an explicit manual `--migrate` hard update with `PI_XZ_LEGACY_PREFIX` set to the verified old npm global prefix. Plain `--migrate` does not discover arbitrary global prefixes. The old updater must never migrate users silently, and installers must preserve `~/.pi` user data.
- Do not publish this fork to npm, GitHub Packages, tags outside `xz-v*`, or GitHub Releases containing standalone binaries in this distribution workflow.
- Do not delete the historical xz-dev/pi GitHub npm Packages until a real Release has passed fresh Node/npm and Bun installs, explicit legacy hard migration, N→N+1 self-update, retained-version rollback, Linux/macOS/Windows acceptance, and remote `origin/main` rebuild verification. Inventory by repository/package ownership first; delete only packages belonging to `xz-dev/pi`.
- Keep `patch/release-self-update` out of the generated stack until its runtime branch is committed and reviewed. Then add its fetch and ordered squash merge to `.github/workflows/upstream-sync.yml`; do not implement runtime self-update behavior only in `ci` or generated `main`.

## Patch retirement

When upstream merges an equivalent patch, verify the upstream behavior, remove the patch from the configured order and README, rebuild and validate `main`, then archive/delete the source branch.
