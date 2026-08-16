# Authless GitHub Release attestation verification

## Story

- Actor: a public xz-dev/pi user installing from GitHub Releases.
- Need: verify provenance without signing in to GitHub.
- Value: the Release distribution has no npm/GitHub package login requirement and remains usable after legacy GitHub Packages are retired.

## Scope

- Publish the GitHub-generated Sigstore bundle under the existing compatibility asset name `attestation-subjects.txt`.
- Make the bootstraps verify `install.ts` and make `scripts/install.ts` verify the package through `gh attestation verify --bundle` before executing package code.
- Preserve signer workflow, source branch, source commit, and hosted-runner checks.
- Keep shell/PowerShell bootstraps thin and keep all transaction behavior in `scripts/install.ts`.
- Preserve the exact seven-asset inventory so the currently published updater can cross the immutable format transition without a login-only bridge Release.

## Acceptance examples

1. Given `gh` is installed, no GitHub token is exported, and `gh` has no stored login, when a user runs the public Release installer, then provenance verification uses the Release bundle and installation succeeds with canonical `@earendil-works/pi-coding-agent` identity.
2. Given the bundle is absent or invalid, when installation starts, then installation fails before downloaded `install.ts` or package code executes and no managed version becomes current.
3. Given publication runs on trusted `xz-dev/pi` main, when provenance is generated, then the compatibility-named bundle is verified against all six signed subjects before the draft is published.
4. Given a Release candidate or draft has an asset outside the canonical seven-name inventory, or a canonical asset hash differs, then publication fails without overwriting or weakening immutable assets.

## Pre-change evidence

A fresh install with `GH_CONFIG_DIR` pointing to an empty directory and `GH_TOKEN`, `GITHUB_TOKEN`, `NPM_TOKEN`, and `NODE_AUTH_TOKEN` unset failed at:

```text
gh attestation verify ... --repo xz-dev/pi ...
To get started with GitHub CLI, please run: gh auth login
```

The same tarball verifies successfully without login when the GitHub attestation JSONL is supplied through `gh attestation verify --bundle` with the existing workflow/ref/digest/hosted-runner policy. Sigstore TUF network access remains permitted and documented; full offline installation is not claimed.

## Implementation

- Keep manifest schema 1 and the existing `attestation.subjectsFile: "attestation-subjects.txt"` field for compatibility with the currently published updater.
- Capture the pinned attest action's `bundle-path`, replace the pre-attestation audit list at that filename with the JSONL bundle, and verify all signed subjects before the draft is published.
- Keep the bundle as the existing seventh unsigned Release asset; it is the cryptographic envelope, so signing or checksum-linking it would create a cycle.
- Make bootstraps exact-tag-download the bounded bundle and verify `install.ts` before execution; make `install.ts` verify the already-hashed package using the same bundle.
- Keep the runtime updater's seven-name manifest/inventory contract unchanged; it downloads the new `install.ts`, while pre-execution provenance is enforced by the published bootstrap and the new installer verifies package code.
- Update preparation, verification, publisher, workflow, and focused tests.

## Verification

- Demonstrate the focused installer test fails before production changes because `--bundle` is absent.
- Run focused GitHub Release installer/bootstrap/publisher/workflow tests.
- Run `npm run check` with full output.
- Rebuild generated main through upstream sync and publish a newer immutable Release.
- Repeat a real tokenless/no-stored-login install after publication, plus migration, N-to-N+1 self-update, and rollback checks while preserving user-data sentinels.
