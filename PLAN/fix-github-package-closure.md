# Fix GitHub Packages dependency closure

## Goal

Restore clean installation of the downstream `@xz-dev/pi-coding-agent` package after upstream added runtime dependencies on `@earendil-works/pi-client` and `@earendil-works/pi-protocol`.

## Investigation

- Reproduced on downstream `main` packages `0.83.0-xz.120.1.g5877333d` and `0.83.0-xz.122.1.g5be1b7ad`: coding-agent metadata retained `@earendil-works/pi-client` and `@earendil-works/pi-protocol`, and neither package existed in npmjs or GitHub Packages.
- Upstream package introductions are already merged: earendil-works/pi PRs #7344, #7348, #7371, and coding-agent integration PR #7409. No upstream or fork issue/PR covers the downstream GitHub Packages omission.
- Ownership is downstream release automation, so the durable source branch is `ci`, not generated `main` or a product patch branch.
- Fresh upstream compatibility was checked against `upstream/main` `583f153d502aa8e958eefdb9af0fbd3344e68f95`.

## Acceptance seams

1. `scripts/prepare-github-packages.mjs` produces dependency-first tarballs for all downstream packages required by coding-agent.
2. Prepared manifests rewrite every published internal dependency to the exact matching `@xz-dev` fork version and fail if an internal dependency remains unresolved.
3. The publish workflow installs the exact prepared coding-agent tarball against GitHub Packages after publishing support packages but before publishing coding-agent itself.
4. After publication, a clean registry-backed install runs `pi --version` successfully.

## Slices

- [x] RED: transformed-artifact test exposes omitted client/protocol packages and unresolved aliases.
- [x] GREEN: discover and rewrite the coding-agent workspace dependency closure in dependency order.
- [x] Gate: add local transformed-artifact, support-registry, and post-publication exact-install gates.
- [x] Verify: focused tests, fresh-upstream build/check, transformed-artifact install, and independent test review.
- [ ] Release: integrate through `ci`, rebuild generated `main`, publish, and verify a clean registry install.
