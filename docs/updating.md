# Updates and mirrors

Use this guide for the xz-dev distribution. For a first installation, see
[Installation](../README.md#installation). Package-manager installations remain
owned by their channel; a source checkout remains user-managed.

## Choose what to update

| Task | Command |
| --- | --- |
| Update the standalone Pi executable | `pi update --self` |
| Update all installed extensions/packages | `pi update --extensions` |
| Update one installed package | `pi update <source>` |
| Refresh Pi-managed model catalogs | `pi update --models` |
| Update Pi and installed packages | `pi update --all` |
| Remove old executable backups | `pi update --clean` |

`pi update`, `pi update self` and `pi update pi` also select Pi itself.
`--force` permits a reinstall when the selected operation includes Pi; it does
not bypass signature, checksum or channel-ownership checks.

Use the configured source when updating a single package, for example
`pi update git:github.com/xz-dev/openai-api-pi-extension`. Versioned npm sources,
Git tags and Git commits stay pinned. Standalone package operations use the
running executable's embedded Bun; Git sources still require Git, but public
`pi` on `PATH` is not required. See [package sources and manager selection](../packages/coding-agent/docs/packages.md#choose-a-source).

`--models` is extension-free. To refresh models registered by extensions, use
`pi --list-models --refresh` instead. That is a separate startup/refresh path,
not an explicit-update retry operation.

When an extension requires new host APIs, update Pi first and restart before
reloading that extension. The [OpenAI plugin's compression requirements](https://github.com/xz-dev/openai-api-pi-extension/blob/main/docs/request-compression.md#host-requirement)
are one example.

## Extension dependencies

**Available only in builds containing `patch/plugin-dependency-updates`; older binaries lack dependency refresh.** No new flags; notifications do not apply updates automatically.

Package update notifications include runtime dependency updates even when the
extension's own npm version or Git commit has not changed. One package appears
once, labelled for its own update, its dependencies, or both.

Use the same commands:

```sh
pi update --extensions   # All configured packages and eligible dependencies
pi update <source>       # One package and its eligible dependencies
pi update --all          # Pi, packages and eligible dependencies
```

| Manager | Dependency-refresh coverage |
| --- | --- |
| npm / Bun | Direct and indirect registry dependencies and eligible Git default HEAD/named branches in managed npm and Git-sourced extension roots. Bun hoisted and isolated layouts are covered. |
| pnpm | Direct and indirect registry dependencies. Git refresh is limited to a direct, unaliased dependency declared by a Git-sourced extension, using a validated isolated local-store layout. |

pnpm's default `blockExoticSubdeps` policy forbids indirect Git dependencies,
including Git beneath a managed npm extension. Pi does not disable that policy
or claim support for configurations that manually allow it. pnpm Git paths with
aliases, peer-context suffixes, optional-importer entries, custom/global virtual
stores or unproven native lock formats are skipped. Workspace contexts, including
an explicit native workspace-directory environment, are conservatively skipped.

Registry updates stay within declared version ranges. Exact registry dependency
versions stay fixed; out-of-range releases are not advertised. A Git runtime dependency
on default HEAD or an unambiguous named branch can advance its commit even when
its package version is unchanged. Full Git SHAs and tags stay fixed; Git semver
selectors, ambiguous branch/tag names, mixed repository/ref/transport constraints
and unknown Git lock instances are skipped rather than advertised as updates.
Git URL checks preserve the authored transport and authentication; SSH failures
do not trigger an HTTP fallback.

Fixing an extension's source does not by itself fix dependencies that its
manifest allows to float. Dependency-only refresh leaves the extension's own npm
version or Git SHA and source declarations unchanged. Tracked Git author locks
(`package-lock.json`, `npm-shrinkwrap.json`, `bun.lock`, `bun.lockb`,
`pnpm-lock.yaml`, `yarn.lock`) and published npm shrinkwraps remain respected.
Pi-generated installation locks may refresh; they record an installation, not
an additional author pin. Bundled and author-locked subtrees are not refreshed.

Only runtime dependencies, including eligible indirect dependencies, are
maintained. Local development directories, development dependencies and
host-provided peers are excluded. A targeted refresh preserves other extensions'
own versions and unique dependency trees; shared dependencies must still satisfy
every incoming constraint. Unsafe name-wide transitions, downgrades and
incompatible OS/CPU/Node targets are withheld.
Overrides/resolutions, Git workspace roots and unknown graph contexts are skipped
for dependency-only planning rather than guessing solver policy. Package source
updates retain their existing behavior, and applying updates uses the native
package manager's existing security policy.

Dependency availability checks do not modify installed plugins, dependency
graphs or author locks, and do not run lifecycle scripts. Git metadata checks may
use an owned temporary repository, removed after success or failure; normal
native cache writes can still occur. Pi does not reset or clean a Git checkout
merely to refresh dependencies. Restart Pi after updating loaded extension code
or dependencies.

## Automatic retries

An eligible failed update operation gets **three additional attempts**, after
**3, 6 and 12 seconds**: one initial attempt plus at most three retries. No
setting is needed.

- Self-update retries transient release-discovery and download failures before
  staging or activation. Signature/integrity failures and local activation
  errors do not become retryable.
- Git/npm package updates retry the failed package operation, not the complete
  command or packages that have already succeeded.
- Model-catalog updates retry the failed provider. Successful providers are not
  fetched again, and other providers still get their own refresh attempt.

This is an operation budget, not a promise of four HTTP requests total. A
self-update attempt may try the ordered mirror chain; release discovery and
artifact download are separate operations.

Retries preserve exact pins, version checks, integrity verification, rollback
and the final failure report. They cannot repair a wrong credential, unsupported
configuration or permanently unavailable service. They do not change model
inference retry settings.

Implementation: [shared backoff helper](../packages/coding-agent/src/utils/update-retry.ts).

## Use a mirror for this update

Without flags or a saved preference, downloads use GitHub directly.

```sh
# GH-Proxy → GHFast → direct GitHub
pi update --mirror

# A custom source
pi update --mirror-url https://ghfast.top/https://github.com
```

Repeat `--mirror-url` to choose an ordered chain. Only the listed sources are
tried; append GitHub explicitly for direct fallback:

```sh
pi update --mirror-url https://ghfast.top/https://github.com \
          --mirror-url https://github.com
```

Each value replaces the literal `https://github.com` in release URLs, including
protocol and any path prefix. Include `https://github.com` in a mirror base when
that service expects it; do not add a trailing slash. Custom values are not
prevalidated.

Both built-in and custom chains apply to release discovery and artifact
downloads. An explicit update reports a failed source with a gray message, then
tries the next; only an exhausted chain reports final failure. Every candidate
must still pass verification.

## Save or override a preference

`--permanent` **only saves the setting and exits**; it does not perform an update
or test that a source is reachable.

```sh
pi update --mirror --permanent
# Or save a custom ordered chain:
pi update --mirror-url https://ghfast.top/https://github.com \
          --mirror-url https://github.com --permanent

# Use the saved chain later:
pi update --self
```

The ordered `updateMirrors` array is stored in the global agent settings,
`~/.pi/agent/settings.json` or the directory selected by
`PI_CODING_AGENT_DIR`. Project settings cannot redirect self-update downloads.
Saved sources also apply to silent automatic version checks.

```sh
pi update --no-mirror              # Direct GitHub once; retain saved sources
pi update --no-mirror --permanent  # Clear saved sources; do not update
```

CLI choices override saved preferences for that invocation. Mirror flags do not
apply to extension, npm or model-catalog downloads and cannot accompany
`--clean` or extension/model-only updates. `--permanent` also cannot accompany
`--force` or `--all`.

## Verification, backups and managed installs

Self-update authenticates `release-manifest.json` against Sigstore trust roots
bundled in the installed client. It requires the `xz-dev/pi` main-branch release
workflow, GitHub Actions OIDC issuer, GitHub-hosted signer and manifest's full
source commit. The ZIP and extracted executable must match that authenticated
manifest before activation. This is mandatory for mirrors, direct GitHub and
`--force`; there is no verification-disable switch.

Missing, forged or wrong-identity proof rejects the source. A mirror cannot
supply a replacement trust root. Root rotations require a separately trusted
client update. Signatures prove origin and integrity, not freshness: a mirror
can still withhold or replay an authentic older release.

A successful update retains the old executable as `pi-<old-version>`
(`pi-<old-version>.exe` on Windows), then activates the verified candidate.
`--clean` only removes regular backups matching the strict distribution-version
pattern beside the executable; it leaves the running executable, symlinks,
directories and unrelated files untouched. Backups that cannot be removed are
kept and reported.

A `*.managed.lock` marker belongs to the installation channel. For example,
Scoop installations use `scoop update pi`, not `pi update --self`. Do not remove
the marker to bypass channel ownership. Source checkouts print xz-dev source
update instructions rather than querying an upstream release or running a
package-manager update.

Raw-executable releases through `xz-v1.0.0-xz.253` and the older multi-file ZIP
layout cannot self-update to the current single-file ZIP. Reinstall once from
a trusted current archive, as described in [Installation](../README.md#installation).

## Install through a mirror

For a first install, obtain a current [GitHub CLI](https://cli.github.com/) from
an independent trusted channel. Do not download a verifier or replacement trust
root from the same mirror as Pi.

Choose a target from the [platform table](../README.md), then obtain the exact
version and full 40-character source commit from the trusted
[xz-dev/pi Release page](https://github.com/xz-dev/pi/releases). Verify **before
extraction or execution**:

```sh
target=linux-x64-gnu-modern
version='<VERSION>'
commit='<FULL_COMMIT_SHA>'
mirror=https://gh-proxy.com/https://github.com
base="${mirror}/xz-dev/pi/releases/download/xz-v${version}"
curl --fail --location --output "pi-${target}.zip" "${base}/pi-${target}.zip" &&
curl --fail --location --output attestation-subjects.jsonl "${base}/attestation-subjects.jsonl" &&
gh attestation verify "pi-${target}.zip" --bundle attestation-subjects.jsonl \
  --repo xz-dev/pi \
  --cert-identity 'https://github.com/xz-dev/pi/.github/workflows/publish-github-release.yml@refs/heads/main' \
  --cert-oidc-issuer https://token.actions.githubusercontent.com \
  --source-ref refs/heads/main --source-digest "$commit" --deny-self-hosted-runners &&
unzip "pi-${target}.zip" &&
./pi --version
```

If unavailable, retry the whole chain with GHFast
(`https://ghfast.top/https://github.com`) or direct GitHub, keeping the exact
version and commit. Missing or invalid proof means stop, not execute anyway.
On Windows, download both files, run the same verification and check
`$LASTEXITCODE -eq 0` before `Expand-Archive` or execution.

These mirrors are third-party services, not infrastructure operated by this
fork. Checksums alone do not authenticate an untrusted mirror. jsDelivr's
repository-file CDN is not a substitute for GitHub Release attachments.

For the full command grammar, see [CLI update reference](../packages/coding-agent/docs/cli.md#update-pi-or-packages).
