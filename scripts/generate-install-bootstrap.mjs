#!/usr/bin/env node

/**
 * Generate native install.sh / install.ps1 installers for a GitHub Release.
 *
 * These scripts ARE the installers: they perform download, SHA-256, `gh
 * attestation verify`, safe extraction, staging smoke, and bundle pointer
 * activation directly. They require no Node.js, Bun, or npm at runtime - only
 * standard platform tools plus `gh` (retained because the user intentionally
 * keeps GitHub artifact attestation).
 *
 * `pi update --self` later invokes these same installers; there is no separate
 * transaction installer (install.ts is not shipped or executed for normal
 * installation).
 *
 * POSIX install.sh handles only tar.gz bundles for the darwin/linux family.
 * Windows install.ps1 handles only zip bundles for the windows family. Each
 * installer therefore needs only its own platform-family bundle pins.
 */

import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUN_TARGETS, binaryArchiveName, bunTarget } from "./lib/bun-targets.mjs";
import { REPOSITORY } from "./lib/github-release.mjs";

export const INSTALL_SH_FILENAME = "install.sh";
export const INSTALL_PS1_FILENAME = "install.ps1";
export const RELEASE_MANIFEST_FILENAME = "release-manifest.json";
export const ATTESTATION_BUNDLE_FILENAME = "attestation-subjects.txt";

/** POSIX-family canonical target IDs (tar.gz bundles). */
export const POSIX_PLATFORMS = Object.freeze(BUN_TARGETS.filter((target) => target.os !== "windows").map((target) => target.id));
/** Windows-family canonical target IDs (zip bundles). */
export const WINDOWS_PLATFORMS = Object.freeze(BUN_TARGETS.filter((target) => target.os === "windows").map((target) => target.id));

/**
 * Canonical per-tag download base URL for a published GitHub Release.
 * Trailing slash is required so URL joins resolve as sibling assets.
 */
export function releaseDownloadBaseUrl(tag, repository = REPOSITORY) {
	if (typeof tag !== "string" || !tag.trim()) {
		throw new Error("releaseDownloadBaseUrl requires a non-empty tag");
	}
	return `https://github.com/${repository}/releases/download/${tag}/`;
}

function assertBootstrapPins(options) {
	const { tag, baseUrl, manifestSha256, commit, distributionVersion, bundles, attestation } = options ?? {};
	if (typeof tag !== "string" || !/^xz-v\d+\.\d+\.\d+-xz\.\d+\.\d+\.g[0-9a-f]{8}$/.test(tag)) {
		throw new Error("installer requires an exact xz Release tag");
	}
	let releaseUrl;
	try {
		releaseUrl = new URL(baseUrl);
	} catch {
		throw new Error("installer requires an absolute baseUrl");
	}
	const isLocalTestUrl =
		releaseUrl.protocol === "http:" &&
		["127.0.0.1", "localhost", "[::1]"].includes(releaseUrl.hostname);
	const isProductionUrl =
		releaseUrl.protocol === "https:" &&
		releaseUrl.origin === "https://github.com" &&
		releaseUrl.pathname === `/${REPOSITORY}/releases/download/${tag}/`;
	if (
		(!isProductionUrl && !isLocalTestUrl) ||
		releaseUrl.username || releaseUrl.password || releaseUrl.search || releaseUrl.hash ||
		!releaseUrl.pathname.endsWith("/")
	) {
		throw new Error("installer baseUrl must be the exact xz-dev/pi Release tag URL");
	}
	if (typeof manifestSha256 !== "string" || !/^[0-9a-f]{64}$/.test(manifestSha256)) {
		throw new Error("installer requires 64-hex manifestSha256");
	}
	if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) {
		throw new Error("installer requires a 40-hex commit");
	}
	if (typeof distributionVersion !== "string" || !distributionVersion) {
		throw new Error("installer requires distributionVersion");
	}
	if (!bundles || typeof bundles !== "object" || Array.isArray(bundles)) {
		throw new Error("installer requires a per-platform bundles object");
	}
	for (const platform of Object.keys(bundles)) {
		const bundle = bundles[platform];
		const expectedName = binaryArchiveName(platform);
		bunTarget(platform);
		if (
			!bundle ||
			bundle.file !== expectedName ||
			!Number.isSafeInteger(bundle.bytes) ||
			bundle.bytes <= 0 ||
			!/^[0-9a-f]{64}$/.test(bundle.sha256 ?? "")
		) {
			throw new Error(`installer has invalid bundle metadata for ${platform}`);
		}
	}
	if (!attestation || typeof attestation !== "object") {
		throw new Error("installer requires attestation policy");
	}
	if (
		attestation.repository !== REPOSITORY ||
		attestation.signerWorkflow !== `${REPOSITORY}/.github/workflows/publish-github-release.yml` ||
		attestation.signerRef !== "refs/heads/main" ||
		attestation.denySelfHostedRunners !== true ||
		attestation.subjectsFile !== ATTESTATION_BUNDLE_FILENAME
	) {
		throw new Error("installer attestation policy is invalid or missing");
	}
	return { tag, baseUrl, manifestSha256, commit, distributionVersion, bundles, attestation };
}

function shellSingleQuote(value) {
	return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function shellDoubleQuote(value) {
	return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$").replaceAll("`", "\\`")}"`;
}

function hexLower(value) {
	return String(value).toLowerCase();
}

/**
 * POSIX sh installer. Requires curl, openssl, gh, and tar. Handles tar.gz
 * bundles for the darwin/linux family. Performs download, SHA-256, `gh
 * attestation verify`, safe extraction (rejecting symlink/hardlink/device/FIFO
 * and traversal/absolute entries), staging smoke, and atomic pointer
 * activation. Never requires Node/Bun/npm.
 */
export function generateInstallSh(options) {
	const pins = assertBootstrapPins(options);
	const posixBundles = Object.fromEntries(
		Object.entries(pins.bundles).filter(([platform]) => POSIX_PLATFORMS.includes(platform)),
	);
	if (Object.keys(posixBundles).length !== POSIX_PLATFORMS.length) {
		throw new Error(`install.sh requires the ${POSIX_PLATFORMS.length} canonical POSIX target bundles`);
	}
	const tagQ = shellSingleQuote(pins.tag);
	const baseUrlQ = shellSingleQuote(pins.baseUrl);
	const manifestShaQ = shellSingleQuote(hexLower(pins.manifestSha256));
	const commitQ = shellSingleQuote(hexLower(pins.commit));
	const distVersionQ = shellSingleQuote(pins.distributionVersion);
	const manifestNameQ = shellSingleQuote(RELEASE_MANIFEST_FILENAME);
	const bundleNameQ = shellSingleQuote(ATTESTATION_BUNDLE_FILENAME);
	const sumsNameQ = shellSingleQuote("SHA256SUMS");
	const repoQ = shellSingleQuote(REPOSITORY);
	const signerWorkflowQ = shellSingleQuote(`${REPOSITORY}/.github/workflows/publish-github-release.yml`);

	const bundleCases = POSIX_PLATFORMS.map((platform) => {
		const bundle = posixBundles[platform];
		return `${platform})
\t\tbundle_file=${shellSingleQuote(bundle.file)}
\t\tbundle_bytes=${bundle.bytes}
\t\tbundle_sha=${shellSingleQuote(hexLower(bundle.sha256))}
\t\t;;`;
	}).join("\n");

	return `#!/bin/sh
# Pi GitHub Release native installer (POSIX).
# Pinned to exact tag/base URL + verified manifest + per-platform bundle pins.
# Generated by scripts/generate-install-bootstrap.mjs - do not hand-edit.
# Requires: curl, openssl, gh (GitHub attestation), tar. No Node/Bun/npm.
set -eu

# Internal control flags are accepted for self-update parity. The installation
# transaction is idempotent, so both flags intentionally share the same path.
for arg in "$@"; do
	case "$arg" in
		--update|--force) ;;
		*) echo "pi installer: unknown argument: $arg" >&2; exit 2 ;;
	esac
done

TAG=${tagQ}
BASE_URL=${baseUrlQ}
MANIFEST_SHA256=${manifestShaQ}
RELEASE_COMMIT=${commitQ}
DISTRIBUTION_VERSION=${distVersionQ}
MANIFEST_NAME=${manifestNameQ}
BUNDLE_NAME=${bundleNameQ}
SUMS_NAME=${sumsNameQ}
REPOSITORY=${repoQ}
SIGNER_WORKFLOW=${signerWorkflowQ}
SIGNER_REF='refs/heads/main'

require_cmd() {
\tif ! command -v "$1" >/dev/null 2>&1; then
\t\techo "pi installer: $1 is required but not found on PATH" >&2
\t\texit 1
\tfi
}

require_cmd curl
require_cmd openssl
require_cmd gh
require_cmd tar

hex_sha256() {
\t# Portable SHA-256; the trailing field of \`openssl dgst -sha256 <file>\`.
\topenssl dgst -sha256 "$1" | awk '{print $NF}'
}

file_bytes() {
\tsize=$(stat -c %s "$1" 2>/dev/null || stat -f %z "$1" 2>/dev/null || true)
\tif [ -n "\${size:-}" ]; then
\t\tprintf '%s\\n' "$size"
\t\treturn 0
\tfi
\twc -c < "$1" | tr -d '[:space:]'
}

has_avx2() {
\tcase "\${PI_XZ_TARGET_CPU:-}" in
\t\tmodern) return 0 ;;
\t\tbaseline) return 1 ;;
\t\t"") ;;
\t\t*) echo "pi installer: PI_XZ_TARGET_CPU must be modern or baseline" >&2; exit 1 ;;
\tesac
\tcase "$(uname -s)" in
\t\tDarwin) sysctl -n machdep.cpu.leaf7_features 2>/dev/null | grep -Eiq '(^|[[:space:]])AVX2([[:space:]]|$)' ;;
\t\tLinux) grep -Eiq '(^|[[:space:]])avx2([[:space:]]|$)' /proc/cpuinfo 2>/dev/null ;;
\t\t*) return 1 ;;
\tesac
}

linux_libc() {
\tcase "\${PI_XZ_TARGET_LIBC:-}" in
\t\tgnu|musl) printf '%s\\n' "$PI_XZ_TARGET_LIBC"; return ;;
\t\t"") ;;
\t\t*) echo "pi installer: PI_XZ_TARGET_LIBC must be gnu or musl" >&2; exit 1 ;;
\tesac
\tif command -v getconf >/dev/null 2>&1 && getconf GNU_LIBC_VERSION >/dev/null 2>&1; then echo gnu; return; fi
\tif ldd --version 2>&1 | grep -qi musl || ls /lib/ld-musl-*.so.1 >/dev/null 2>&1; then echo musl; return; fi
\techo "pi installer: cannot reliably detect Linux libc (set PI_XZ_TARGET_LIBC=gnu or musl)" >&2
\texit 1
}

host_platform() {
\tos=$(uname -s)
\tmachine=$(uname -m)
\tcase "$os:$machine" in
\t\tDarwin:arm64|Darwin:aarch64) echo darwin-arm64 ;;
\t\tDarwin:x86_64|Darwin:amd64) if has_avx2; then echo darwin-x64-modern; else echo darwin-x64-baseline; fi ;;
\t\tLinux:arm64|Linux:aarch64) echo "linux-arm64-$(linux_libc)" ;;
\t\tLinux:x86_64|Linux:amd64)
\t\t\tlibc=$(linux_libc)
\t\t\tif has_avx2; then echo "linux-x64-$libc-modern"; else echo "linux-x64-$libc-baseline"; fi ;;
\t\t*) echo "pi installer: unsupported host $os/$machine" >&2; exit 1 ;;
\tesac
}

# Reject any entry whose mode does not start with '-' (regular file) or 'd'
# (directory): symlink, hardlink, device, and FIFO entries fail.
# Also reject traversal (..) and absolute-path entries.
check_tar_safety() {
\tif ! tar -tvzf "$1" | awk 'NR && $1 !~ /^-/ && $1 !~ /^d/ { print "pi installer: unsafe tar entry type " $1 > "/dev/stderr"; bad=1 } END { exit bad }'; then
\t\texit 1
\tfi
\tif ! tar -tzf "$1" | awk '$0 ~ /^\\// || $0 ~ /(^|\\/)\\.\\.(\\/|$)/ || $0 ~ /\\\\/ { print "pi installer: unsafe tar path " $0 > "/dev/stderr"; bad=1 } END { exit bad }'; then
\t\texit 1
\tfi
}

# Verify the pinned release manifest and extract tag/commit. The manifest
# digest is pinned, so a tampered manifest fails the sha256 check before use.
verify_manifest() {
\tactual=$(hex_sha256 "$1")
\tif [ "$actual" != "$MANIFEST_SHA256" ]; then
\t\techo "pi installer: release-manifest.json sha256 mismatch" >&2
\t\techo "  expected: $MANIFEST_SHA256" >&2
\t\techo "  actual:   $actual" >&2
\t\texit 1
\tfi
\tm_tag=$(sed -n 's/.*"tag"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$1" | head -n 1)
\tm_commit=$(sed -n 's/.*"commit"[[:space:]]*:[[:space:]]*"\\([0-9a-f]*\\)".*/\\1/p' "$1" | head -n 1)
\tif [ "$m_tag" != "$TAG" ]; then
\t\techo "pi installer: manifest tag $m_tag does not match pinned tag $TAG" >&2
\t\texit 1
\tfi
\tif [ "$m_commit" != "$RELEASE_COMMIT" ]; then
\t\techo "pi installer: manifest commit $m_commit does not match pinned commit $RELEASE_COMMIT" >&2
\t\texit 1
\tfi
}

# Smoke the staged bundle with isolated user data.
run_smoke() {
\tbundle_dir=$1
\texe="$bundle_dir/pi"
\tif [ ! -f "$exe" ]; then
\t\techo "pi installer: staged bundle is missing executable $exe" >&2
\t\texit 1
\tfi
\tsmoke_agent="$bundle_dir/.pi-verify"
\tversion=$(PI_CODING_AGENT_DIR="$smoke_agent" "$exe" --version 2>/dev/null || true)
\tif [ "$version" != "$DISTRIBUTION_VERSION" ]; then
\t\techo "pi installer: staged pi --version returned '$version', expected '$DISTRIBUTION_VERSION'" >&2
\t\texit 1
\tfi
\tPI_CODING_AGENT_DIR="$smoke_agent" "$exe" --help >/dev/null 2>&1 || {
\t\techo "pi installer: staged pi --help failed" >&2
\t\texit 1
\t}
\trm -rf "$smoke_agent"
}

# Determine install locations.
if [ -n "\${XDG_DATA_HOME:-}" ]; then
\tinstall_root="$XDG_DATA_HOME/pi-bin"
else
\tinstall_root="$HOME/.local/share/pi-bin"
fi
if [ -n "\${XDG_BIN_HOME:-}" ]; then
\tbin_dir="$XDG_BIN_HOME"
else
\tbin_dir="$HOME/.local/bin"
fi
install_root=\${PI_XZ_INSTALL_ROOT:-\$install_root}
bin_dir=\${PI_XZ_BIN_DIR:-\$bin_dir}
bundles_dir="$install_root/bundles"
current_path="$install_root/current"
previous_path="$install_root/previous"

platform=$(host_platform)
bundle_file=""
bundle_bytes=""
bundle_sha=""
case "$platform" in
${bundleCases}
\t*)
\t\techo "pi installer: no bundle pin for host platform $platform" >&2
\t\texit 1
\t\t;;
esac

WORKDIR=\${TMPDIR:-/tmp}
WORKDIR=$(mktemp -d "$WORKDIR/pi-xz-install.XXXXXX")
cleanup() {
\trm -rf "$WORKDIR"
}
trap cleanup EXIT INT TERM

MANIFEST_PATH="$WORKDIR/$MANIFEST_NAME"
BUNDLE_PATH="$WORKDIR/$BUNDLE_NAME"
SUMS_PATH="$WORKDIR/$SUMS_NAME"
ARCHIVE_PATH="$WORKDIR/$bundle_file"

echo "pi installer: downloading Release $TAG for $platform"
curl -fsSL "$BASE_URL$MANIFEST_NAME" -o "$MANIFEST_PATH"
curl -fsSL "$BASE_URL$BUNDLE_NAME" -o "$BUNDLE_PATH"
curl -fsSL "$BASE_URL$SUMS_NAME" -o "$SUMS_PATH"
curl -fsSL "$BASE_URL$bundle_file" -o "$ARCHIVE_PATH"

verify_manifest "$MANIFEST_PATH"

if ! awk -v hash="$bundle_sha" -v file="$bundle_file" '$1 == hash && $2 == file { found=1 } END { exit found ? 0 : 1 }' "$SUMS_PATH"; then
	echo "pi installer: SHA256SUMS does not authenticate $bundle_file" >&2
	exit 1
fi
actual_archive_sha=$(hex_sha256 "$ARCHIVE_PATH")
if [ "$actual_archive_sha" != "$bundle_sha" ]; then
\techo "pi installer: bundle sha256 mismatch" >&2
\techo "  expected: $bundle_sha" >&2
\techo "  actual:   $actual_archive_sha" >&2
\texit 1
fi
actual_bytes=$(file_bytes "$ARCHIVE_PATH")
if [ "$actual_bytes" != "$bundle_bytes" ]; then
\techo "pi installer: bundle size mismatch (expected $bundle_bytes, actual $actual_bytes)" >&2
\texit 1
fi

# GitHub artifact attestation verification before extraction or execution.
if ! gh attestation verify "$ARCHIVE_PATH" \\
\t--bundle "$BUNDLE_PATH" \\
\t--repo "$REPOSITORY" \\
\t--signer-workflow "$SIGNER_WORKFLOW" \\
\t--source-ref "$SIGNER_REF" \\
\t--source-digest "$RELEASE_COMMIT" \\
\t--deny-self-hosted-runners >/dev/null; then
\techo "pi installer: bundle provenance verification failed" >&2
\texit 1
fi

# Safe extraction: reject unsafe entry types and traversal/absolute paths
# before extracting anything.
check_tar_safety "$ARCHIVE_PATH"
mkdir -p "$install_root/bundles"
version_dir="$bundles_dir/$DISTRIBUTION_VERSION"
staging_dir="$bundles_dir/.$DISTRIBUTION_VERSION.staging.$$"

prior=""
if [ -f "$current_path" ]; then
\tprior=$(cat "$current_path" 2>/dev/null || true)
fi

if [ "$prior" != "$DISTRIBUTION_VERSION" ]; then
\trm -rf "$staging_dir"
\tmkdir -p "$staging_dir"
\t# tar.gz bundles wrap files under a top-level pi/ directory; unwrap it so the
\t# executable sits at the bundle content root.
\ttar -xzf "$ARCHIVE_PATH" -C "$staging_dir"
\twrapper="$staging_dir/pi"
\tif [ -d "$wrapper" ]; then
\t\tmv "$wrapper" "$staging_dir/.pi-content"
\t\tfind "$staging_dir/.pi-content" -mindepth 1 -maxdepth 1 -exec mv -t "$staging_dir" {} +
\t\trm -rf "$staging_dir/.pi-content"
\tfi
\trun_smoke "$staging_dir"
\trm -rf "$version_dir"
\tmv "$staging_dir" "$version_dir"
\trmdir "$staging_dir" 2>/dev/null || true
fi

# Activation: atomically replace the current pointer without first removing the
# old pointer. The prior version is preserved in \`previous\` (non-authoritative
# cleanup metadata) after activation.
printf '%s\\n' "$DISTRIBUTION_VERSION" > "$install_root/current.new"
mv -f "$install_root/current.new" "$current_path"
if [ -n "$prior" ] && [ "$prior" != "$DISTRIBUTION_VERSION" ]; then
\tprintf '%s\\n' "$prior" > "$previous_path"
fi

# Clean stale staging and non-current/non-previous bundles, but always preserve
# the bundle referenced by \`previous\` so cleanup never leaves it dangling.
cleanup_bundles() {
\tkeep=""
\tfor v in "$DISTRIBUTION_VERSION" "$prior"; do
\t\t[ -n "$v" ] && keep="$keep $v"
\tdone
\tif [ -d "$bundles_dir" ]; then
\t\tfor entry in "$bundles_dir"/* "$bundles_dir"/.[!.]*; do
\t\t\t[ -e "$entry" ] || continue
\t\t\tname=$(basename "$entry")
\t\t\tcase "$name" in
\t\t\t\t.*) rm -rf "$entry" ;; # staging dirs and dotfiles
\t\t\t\t*)
\t\t\t\t\tmatched=0
\t\t\t\t\tfor v in $keep; do
\t\t\t\t\t\tif [ "$name" = "$v" ]; then
\t\t\t\t\t\t\tmatched=1
\t\t\t\t\t\t\tbreak
\t\t\t\t\t\tfi
\t\t\t\t\tdone
\t\t\t\t\tif [ "$matched" -eq 0 ]; then
\t\t\t\t\t\trm -rf "$entry"
\t\t\t\t\tfi
\t\t\t\t\t;;
\t\t\tesac
\t\tdone
\tfi
}
cleanup_bundles

# Install the managed launcher that reads the pointer.
mkdir -p "$bin_dir"
launcher="$bin_dir/pi"
if [ -f "$launcher" ] && ! grep -q "pi-bin managed launcher" "$launcher"; then
\techo "pi installer: refusing to overwrite unknown pi shim: $launcher" >&2
\texit 1
fi
# Quote the runtime-selected install root as POSIX shell data before writing it
# into the stable launcher. This handles spaces and single quotes without
# evaluating the path as code.
launcher_root=$(printf '%s' "$install_root" | sed "s/'/'\\\\''/g")
{
	printf '%s\n' '#!/bin/sh' '# pi-bin managed launcher'
	printf "ROOT='%s'\\n" "$launcher_root"
	cat <<'PI_LAUNCHER_EOF'
if [ ! -f "$ROOT/current" ]; then
	echo "pi-bin: no active install (missing $ROOT/current)" >&2
	exit 1
fi
VERSION=$(cat "$ROOT/current")
exec "$ROOT/bundles/$VERSION/pi" "$@"
PI_LAUNCHER_EOF
} > "$launcher"
chmod 755 "$launcher"

echo "pi installer: installed $DISTRIBUTION_VERSION ($platform)"
echo "pi installer: launch with: $launcher"
`;
}

/**
 * Windows PowerShell installer. Requires gh and the .NET ZipFile APIs (no
 * unzip dependency). Handles zip bundles for the windows family. Performs
 * download, SHA-256, \`gh attestation verify\`, safe extraction (rejecting
 * symlink/hardlink/device and traversal/absolute paths), staging smoke, and
 * atomic pointer activation via a stable launcher that reads the pointer.
 * Never overwrites the running pi.exe.
 */
export function generateInstallPs1(options) {
	const pins = assertBootstrapPins(options);
	const windowsBundles = Object.fromEntries(
		Object.entries(pins.bundles).filter(([platform]) => WINDOWS_PLATFORMS.includes(platform)),
	);
	if (Object.keys(windowsBundles).length !== WINDOWS_PLATFORMS.length) {
		throw new Error(`install.ps1 requires the ${WINDOWS_PLATFORMS.length} canonical Windows target bundles`);
	}
	const q = (value) => `'${String(value).replaceAll("'", "''")}'`;

	const bundleEntries = WINDOWS_PLATFORMS.map((platform) => {
		const bundle = windowsBundles[platform];
		return `[pscustomobject]@{ Platform = '${platform}'; File = '${bundle.file}'; Bytes = ${bundle.bytes}; Sha256 = '${hexLower(bundle.sha256)}' }`;
	}).join(", ");

	return `# Pi GitHub Release native installer (PowerShell).
# Pinned to exact tag/base URL + verified manifest + per-platform bundle pins.
# Generated by scripts/generate-install-bootstrap.mjs - do not hand-edit.
# Requires: gh (GitHub attestation). No Node/Bun/npm.
param(
	[Parameter(ValueFromRemainingArguments = $true)]
	[string[]] $InstallerArgs
)
$ErrorActionPreference = 'Stop'
foreach ($arg in $InstallerArgs) {
	if ($arg -ne '--update' -and $arg -ne '--force') {
		throw "pi installer: unknown argument: $arg"
	}
}

$Tag = ${q(pins.tag)}
$BaseUrl = ${q(pins.baseUrl)}
$ManifestSha256 = ${q(hexLower(pins.manifestSha256))}
$ReleaseCommit = ${q(hexLower(pins.commit))}
$DistributionVersion = ${q(pins.distributionVersion)}
$ManifestName = ${q(RELEASE_MANIFEST_FILENAME)}
$BundleName = ${q(ATTESTATION_BUNDLE_FILENAME)}
$Repository = ${q(REPOSITORY)}
$SignerWorkflow = ${q(`${REPOSITORY}/.github/workflows/publish-github-release.yml`)}
$SignerRef = 'refs/heads/main'

$Bundles = @(${bundleEntries})

function Get-Sha256Hex([string] $Path) {
	return (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLowerInvariant()
}

function Test-Avx2 {
	if ($env:PI_XZ_TARGET_CPU -eq 'modern') { return $true }
	if ($env:PI_XZ_TARGET_CPU -eq 'baseline') { return $false }
	if ($env:PI_XZ_TARGET_CPU) { throw 'pi installer: PI_XZ_TARGET_CPU must be modern or baseline' }
	# IsProcessorFeaturePresent(40) is PF_AVX2_INSTRUCTIONS_AVAILABLE.
	try {
		Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class PiCpu { [DllImport("kernel32.dll")] public static extern bool IsProcessorFeaturePresent(uint feature); }'
		return [PiCpu]::IsProcessorFeaturePresent(40)
	} catch {
		# Reliable detection is unavailable: choose the compatible baseline.
		return $false
	}
}

function Get-HostPlatform {
	$archText = $env:PROCESSOR_ARCHITECTURE
	if ($env:PI_XZ_TARGET_ARCH) { $archText = $env:PI_XZ_TARGET_ARCH }
	if ($archText -match 'ARM64') { return 'windows-arm64' }
	if ($archText -notmatch 'AMD64|x64') { throw "pi installer: unsupported Windows architecture $archText" }
	if (Test-Avx2) { return 'windows-x64-modern' }
	return 'windows-x64-baseline'
}

function Select-Bundle {
	$platform = Get-HostPlatform
	$bundle = $Bundles | Where-Object { $_.Platform -eq $platform }
	if ($null -eq $bundle) { throw "pi installer: no bundle for host platform $platform" }
	return $bundle
}

function Test-SafeEntry([string] $Name, [string] $Type, [string] $ArchiveName) {
	$normalized = $Name.Replace('\\', '/').TrimStart('/')
	if ([string]::IsNullOrWhiteSpace($normalized)) { throw "pi installer: empty entry in $ArchiveName" }
	if ($normalized -eq '.' -or $normalized -eq '..') { throw "pi installer: unsafe entry '$Name' in $ArchiveName" }
	if ($normalized -match '^(?:[A-Za-z]:)?/') { throw "pi installer: unsafe absolute entry '$Name' in $ArchiveName" }
	if (($normalized -split '/' | Where-Object { $_ -eq '..' }).Count -gt 0) { throw "pi installer: traversal entry '$Name' in $ArchiveName" }
	if ($normalized -match '\0') { throw "pi installer: NUL in entry '$Name' in $ArchiveName" }
	if ($Type -ne 'File' -and $Type -ne 'Directory') {
		throw "pi installer: non-regular/non-directory entry '$Name' (type $Type) in $ArchiveName"
	}
	return $normalized
}

function Assert-ZipSafety([string] $ZipPath) {
	Add-Type -AssemblyName System.IO.Compression.FileSystem
	$allowedTop = @('pi','pi.exe','package.json','README.md','CHANGELOG.md','photon_rs_bg.wasm','theme','assets','export-html','docs','examples','node_modules','native')
	$zip = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
	try {
		foreach ($entry in $zip.Entries) {
			if ($entry.FullName.EndsWith('/')) {
				# Directory entry.
				$normalized = Test-SafeEntry $entry.FullName 'Directory' $ZipPath
				$top = ($normalized -split '/')[0]
				if ($allowedTop -notcontains $top) { throw "pi installer: unexpected top-level entry '$top' in $ZipPath" }
			} else {
				# Regular file entry.
				$normalized = Test-SafeEntry $entry.FullName 'File' $ZipPath
				$top = ($normalized -split '/')[0]
				if ($allowedTop -notcontains $top) { throw "pi installer: unexpected top-level entry '$top' in $ZipPath" }
			}
		}
	} finally {
		$zip.Dispose()
	}
}

function Invoke-VerifyManifest([string] $ManifestPath) {
	$actual = Get-Sha256Hex $ManifestPath
	if ($actual -ne $ManifestSha256) {
		throw "pi installer: release-manifest.json sha256 mismatch (expected $ManifestSha256, actual $actual)"
	}
	$json = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
	if ($json.tag -ne $Tag) { throw "pi installer: manifest tag $($json.tag) does not match pinned tag $Tag" }
	if ($json.commit -ne $ReleaseCommit) { throw "pi installer: manifest commit $($json.commit) does not match pinned commit $ReleaseCommit" }
}

function Invoke-Smoke([string] $BundleDir) {
	$exe = Join-Path $BundleDir 'pi.exe'
	if (-not (Test-Path -LiteralPath $exe)) { throw "pi installer: staged bundle is missing executable $exe" }
	$smokeAgent = Join-Path $BundleDir '.pi-verify'
	$oldDir = $env:PI_CODING_AGENT_DIR
	$env:PI_CODING_AGENT_DIR = $smokeAgent
	try {
		$version = & $exe --version
		if ($version.Trim() -ne $DistributionVersion) {
			throw "pi installer: staged pi --version returned '$version', expected '$DistributionVersion'"
		}
		& $exe --help | Out-Null
	} finally {
		if ($null -eq $oldDir) { Remove-Item Env:PI_CODING_AGENT_DIR -ErrorAction SilentlyContinue }
		else { $env:PI_CODING_AGENT_DIR = $oldDir }
	}
	if (Test-Path -LiteralPath $smokeAgent) { Remove-Item -LiteralPath $smokeAgent -Recurse -Force }
}

$ghCmd = Get-Command gh -ErrorAction SilentlyContinue
if ($null -eq $ghCmd) { throw "pi installer: GitHub CLI (gh) is required for artifact attestation verification" }

$installRoot = Join-Path $env:LOCALAPPDATA 'pi-bin'
if ($env:PI_XZ_INSTALL_ROOT) { $installRoot = $env:PI_XZ_INSTALL_ROOT }
$binDir = Join-Path $installRoot 'bin'
if ($env:PI_XZ_BIN_DIR) { $binDir = $env:PI_XZ_BIN_DIR }
$bundlesDir = Join-Path $installRoot 'bundles'
$currentPath = Join-Path $installRoot 'current'
$previousPath = Join-Path $installRoot 'previous'

$bundle = Select-Bundle
$bundleFile = $bundle.File
$bundleBytes = $bundle.Bytes
$bundleSha = $bundle.Sha256

$workDir = Join-Path ([System.IO.Path]::GetTempPath()) ('pi-xz-install-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $workDir | Out-Null
try {
	$manifestPath = Join-Path $workDir $ManifestName
	$bundlePath = Join-Path $workDir $BundleName
	$archivePath = Join-Path $workDir $bundleFile

	Invoke-WebRequest -Uri ($BaseUrl + $ManifestName) -OutFile $manifestPath -UseBasicParsing
	Invoke-WebRequest -Uri ($BaseUrl + $BundleName) -OutFile $bundlePath -UseBasicParsing
	Invoke-WebRequest -Uri ($BaseUrl + $bundleFile) -OutFile $archivePath -UseBasicParsing

	Invoke-VerifyManifest $manifestPath

	$actualSha = Get-Sha256Hex $archivePath
	if ($actualSha -ne $bundleSha) {
		throw "pi installer: bundle sha256 mismatch (expected $bundleSha, actual $actualSha)"
	}
	$actualBytes = (Get-Item -LiteralPath $archivePath).Length
	if ($actualBytes -ne $bundleBytes) {
		throw "pi installer: bundle size mismatch (expected $bundleBytes, actual $actualBytes)"
	}

	& $ghCmd.Source attestation verify $archivePath ${"`"}
		--bundle $bundlePath ${"`"}
		--repo $Repository ${"`"}
		--signer-workflow $SignerWorkflow ${"`"}
		--source-ref $SignerRef ${"`"}
		--source-digest $ReleaseCommit ${"`"}
		--deny-self-hosted-runners | Out-Null
	if ($LASTEXITCODE -ne 0) {
		throw "pi installer: bundle provenance verification failed"
	}

	Assert-ZipSafety $archivePath

	New-Item -ItemType Directory -Force -Path $bundlesDir | Out-Null
	$versionDir = Join-Path $bundlesDir $DistributionVersion
	$stagingDir = Join-Path $bundlesDir ('.' + $DistributionVersion + '.staging.' + $PID)

	$currentVersion = $null
	if (Test-Path -LiteralPath $currentPath) {
		$currentVersion = (Get-Content -LiteralPath $currentPath -Raw).Trim()
	}

	if ($currentVersion -ne $DistributionVersion) {
		if (Test-Path -LiteralPath $stagingDir) { Remove-Item -LiteralPath $stagingDir -Recurse -Force }
		New-Item -ItemType Directory -Path $stagingDir | Out-Null
		Expand-Archive -LiteralPath $archivePath -DestinationPath $stagingDir -Force
		Invoke-Smoke $stagingDir
		if (Test-Path -LiteralPath $versionDir) { Remove-Item -LiteralPath $versionDir -Recurse -Force }
		Move-Item -LiteralPath $stagingDir -Destination $versionDir
	}

	# Activation: replace the small pointer file via a temp file + Move-Item
	# (atomic on NTFS). Never overwrite the running pi.exe.
	$pointerTemp = Join-Path $installRoot 'current.new'
	Set-Content -LiteralPath $pointerTemp -Value ($DistributionVersion + \`n) -NoNewline
	Move-Item -LiteralPath $pointerTemp -Destination $currentPath -Force

	if ($currentVersion -and ($currentVersion -ne $DistributionVersion)) {
		Set-Content -LiteralPath $previousPath -Value ($currentVersion + \`n) -NoNewline
	}

	# Clean stale staging and non-current/non-previous bundles, preserving the
	# bundle referenced by \`previous\` so cleanup never leaves it dangling.
	$keep = @($DistributionVersion)
	if ($currentVersion) { $keep += $currentVersion }
	foreach ($entry in Get-ChildItem -LiteralPath $bundlesDir -Force -ErrorAction SilentlyContinue) {
		$name = $entry.Name
		if ($name.StartsWith('.')) {
			Remove-Item -LiteralPath $entry.FullName -Recurse -Force -ErrorAction SilentlyContinue
			continue
		}
		if ($keep -notcontains $name) {
			Remove-Item -LiteralPath $entry.FullName -Recurse -Force -ErrorAction SilentlyContinue
		}
	}

	# Install the managed launcher that reads the pointer.
	New-Item -ItemType Directory -Force -Path $binDir | Out-Null
	$launcherCmd = Join-Path $binDir 'pi.cmd'
	if (Test-Path -LiteralPath $launcherCmd) {
		$existing = Get-Content -LiteralPath $launcherCmd -Raw
		if ($existing -notmatch 'pi-bin managed launcher') {
			throw "pi installer: refusing to overwrite unknown pi shim: $launcherCmd"
		}
	}
	$cmdContent = "@echo off\`r\`nrem pi-bin managed launcher\`r\`nset \`"ROOT=$installRoot\`"\`r\`nif not exist \`"%ROOT%\\\\current\`" (\`r\`n\`techo pi-bin: no active install ^(missing \`"%ROOT%\\\\current\`"^) 1>&2\`r\`n\`texit /b 1\`r\`n)\`r\`nset /p VERSION=< \`"%ROOT%\\\\current\`"\`r\`n\`"%ROOT%\\\\bundles\\\\%VERSION%\\\\pi.exe\`" %*\`r\`n"
	Set-Content -LiteralPath $launcherCmd -Value $cmdContent -NoNewline

	Write-Host "pi installer: installed $DistributionVersion ($($bundle.Platform))"
	Write-Host "pi installer: launch with: $launcherCmd"
}
finally {
	Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
}
`;
}

/**
 * Write install.sh + install.ps1 into outDir and return their asset metadata.
 */
export function writeInstallBootstrap(outDir, options) {
	const pins = assertBootstrapPins(options);
	const shContent = generateInstallSh(pins);
	const ps1Content = generateInstallPs1(pins);
	const shPath = join(outDir, INSTALL_SH_FILENAME);
	const ps1Path = join(outDir, INSTALL_PS1_FILENAME);
	writeFileSync(shPath, shContent, { encoding: "utf8", mode: 0o755 });
	writeFileSync(ps1Path, ps1Content, { encoding: "utf8" });
	return {
		tag: pins.tag,
		baseUrl: pins.baseUrl,
		manifestSha256: pins.manifestSha256,
		commit: pins.commit,
		distributionVersion: pins.distributionVersion,
		sh: {
			file: INSTALL_SH_FILENAME,
			path: shPath,
			content: shContent,
		},
		ps1: {
			file: INSTALL_PS1_FILENAME,
			path: ps1Path,
			content: ps1Content,
		},
	};
}

function parseCliArgs(argv) {
	const args = argv.slice(2);
	const options = {};
	for (let i = 0; i < args.length; i += 1) {
		const key = args[i];
		const value = args[i + 1];
		if (!value || value.startsWith("--")) {
			throw new Error(`Missing value for ${key}`);
		}
		switch (key) {
			case "--out":
				options.outDir = value;
				break;
			case "--tag":
				options.tag = value;
				break;
			case "--base-url":
				options.baseUrl = value;
				break;
			case "--manifest-sha256":
				options.manifestSha256 = value;
				break;
			case "--commit":
				options.commit = value;
				break;
			case "--distribution-version":
				options.distributionVersion = value;
				break;
			default:
				throw new Error(`Unknown argument: ${key}`);
		}
		i += 1;
	}
	if (!options.outDir) {
		throw new Error(
			"Usage: node scripts/generate-install-bootstrap.mjs --out <dir> --tag <tag> --base-url <url/> --manifest-sha256 <hex> --commit <40hex> --distribution-version <ver>",
		);
	}
	return options;
}

function main() {
	const { outDir, ...pins } = parseCliArgs(process.argv);
	const written = writeInstallBootstrap(outDir, pins);
	console.log(written.sh.path);
	console.log(written.ps1.path);
}

const isMain =
	Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
	main();
}
