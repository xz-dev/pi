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
4. Run all pre-push build, check, focused integration, packed-release, GitHub Packages candidate, audit, and signature gates.
5. Update `main` only with `--force-with-lease`; a lease failure requires investigation and a fresh rebuild.

## GitHub Packages release rules

- Only a generated `refs/heads/main` commit may publish packages.
- `scripts/prepare-github-packages.mjs` derives the coding-agent production workspace dependency closure, orders it dependency-first, rewrites internal dependencies to the exact same `@xz-dev` release version, and emits `release-manifest.json`.
- The pre-push workflow must install the exact transformed tarballs locally before updating `main`.
- The publish workflow publishes support packages first, verifies the local coding-agent tarball against those exact registry packages, then publishes coding-agent and verifies a clean exact-version registry install.
- Release versions are stable across reruns of one generated commit. Existing package coordinates must never be overwritten; a partially published run is resumed only after verifying existing coordinates match the prepared release manifest. A mismatch stops publication.
- Do not move the `latest` dist-tag manually as part of a normal release. A successful coding-agent publication and registry-install verification is the release completion boundary.

## Patch retirement

When upstream merges an equivalent patch, verify the upstream behavior, remove the patch from the configured order and README, rebuild and validate `main`, then archive/delete the source branch.
