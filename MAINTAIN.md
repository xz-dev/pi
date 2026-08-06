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
- `scripts/build-binaries.sh` produces six version-correct Bun-compiled platform bundles with downstream metadata (`piConfig.distribution=xz-dev`, downstream distribution version) and every existing runtime asset. `scripts/prepare-github-release.mjs` runs it, verifies each archive's machine-checkable required-path inventory and archive safety, and emits `release-manifest.json`, standalone generated `install.sh` / `install.ps1` installers, `SHA256SUMS`, and `attestation-subjects.txt`. There is no hybrid npm tarball; each Release ships exactly the six platform bundles.
- The manifest freezes the exact tag, full commit, downstream and upstream API versions, per-platform bundle archive metadata (file, bytes, sha256), the bundle layout version, and the required-path inventory per platform. The verifier checks every required path and rejects unknown unsafe archive entries.
- Distribution versions and exact tags are `<api>-xz.<GITHUB_RUN_NUMBER>.<GITHUB_RUN_ATTEMPT>.g<sha8>` and `xz-v<distributionVersion>`. Each workflow attempt has its own immutable tag; repeated execution within that attempt resumes the same tag.
- The pre-push workflow must prepare and install the exact candidate before updating `main`. The publication workflow independently builds/checks/tests, uploads that exact candidate, then verifies all six platform bundle inventories and runs a host-native bundle smoke on Linux, macOS, and Windows.
- The publication job alone receives `contents:write`, `id-token:write`, and `attestations:write`. It creates GitHub build-provenance attestations for the six bundles, manifest, installer, bootstraps, and checksum file, then verifies those stored attestations before making a Release public. `attestation-subjects.txt` is an immutable Release audit asset but is not itself an attestation subject.
- Publication is staged as a draft. An interrupted draft may be resumed only when its target commit is exact and its uploaded assets are an exact hash-matching subset; only missing assets are uploaded. No asset is overwritten. A mismatch, unknown asset, wrong commit, or incomplete already-public Release fails closed.
- After all assets and hashes are verified, publish as non-draft and non-prerelease. Re-read `refs/heads/main` immediately before that transition: use `make_latest=true` only when it still equals `GITHUB_SHA`; otherwise publish the immutable historical Release with `make_latest=false` so a delayed older run cannot replace Latest.
- An already-published Release with the exact target and exact complete asset hashes is an idempotent no-op. Releases, tags, and assets are immutable and retained; normal automation never deletes or overwrites them.
- Installation is self-contained: the executable and its adjacent native modules, WASM, themes, assets, HTML export templates, docs, and examples travel together as one version-matched archive. There is no backward compatibility with the old hybrid `pi-xz` install and no legacy detection or migration bridge.
- POSIX activation stages and validates the new bundle, creates `current.new` pointing at the new bundle, atomically renames it over `current` without removing the old `current` first, then updates `previous` afterward as non-authoritative cleanup metadata. Windows activation installs a distinct bundle directory, uses an owned stable launcher and atomically replaces a small `current` pointer file, never overwrites the running `pi.exe`, and defers deletion of locked old bundles. Stale staging and non-current/non-previous bundles are cleaned on later installer runs.
- `pi update --self` from an xz-dev binary discovers only `xz-dev/pi` Releases and invokes the same installer implementation used for fresh installation; failure before activation leaves the old bundle active. An xz-dev source checkout is user-managed: `pi update --self` prints source-update instructions and never runs an upstream package-manager update.
- Do not publish this fork to npm, GitHub Packages, tags outside `xz-v*`, or a second Release plane. `.github/workflows/build-binaries.yml` is persistently removed from generated `main`; the `ci` overlay and generated-main verification continue removing it if upstream ever reintroduces it.
- Keep `patch/release-self-update` out of the generated stack until its runtime branch is committed and reviewed. Then add its fetch and ordered squash merge to `.github/workflows/upstream-sync.yml`; do not implement runtime self-update behavior only in `ci` or generated `main`.

## Patch retirement

When upstream merges an equivalent patch, verify the upstream behavior, remove the patch from the configured order and README, rebuild and validate `main`, then archive/delete the source branch.
