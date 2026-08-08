#!/usr/bin/env bash
# Build exactly one native-architecture musl addon from immutable, offline inputs.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
constant() { node "$ROOT/scripts/lib/musl-provenance.mjs" "$1"; }
SOURCE_COMMIT=$(constant source.commit)
SOURCE_SHA256=$(constant source.archiveSha256)
SOURCE_TREE_SHA256=$(constant source.sourceTreeSha256)
VENDOR_TREE_SHA256=$(constant source.vendorTreeSha256)
SOURCE_URL=$(constant source.url)
CARGO_LOCK_SHA256=$(constant source.cargoLockSha256)
RUST_VERSION=$(constant build.rust)
MUSL_DEV_VERSION=$(constant build.muslDev)
VENDOR_DIR="$ROOT/scripts/vendor/clipboard-musl"
OUTPUT_DIR=${1:-$ROOT/packages/coding-agent/binaries/clipboard-musl}
ARCH=${2:-}
[[ "$ARCH" == x64 || "$ARCH" == arm64 ]] || { echo "Usage: $0 [output-dir] <x64|arm64>" >&2; exit 2; }
command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
case "$ARCH" in
	x64|arm64)
		expected_machine=$(constant "build.targets.$ARCH.hostMachine")
		platform=$(constant "build.targets.$ARCH.platform")
		triple=$(constant "build.targets.$ARCH.triple")
		image=$(constant "build.targets.$ARCH.container")
		apk_sha=$(constant "build.targets.$ARCH.muslDevApkSha256")
		;;
esac
host_machine=$(uname -m)
[[ "$host_machine" == "$expected_machine" ]] || { echo "native $ARCH runner required (host is $host_machine); emulation is not accepted" >&2; exit 1; }
work=$(mktemp -d)
host_uid=$(id -u)
host_gid=$(id -g)
cleanup() {
	if [[ -d "$work" ]]; then
		if ! docker run --rm --network none -e HOST_UID="$host_uid" -e HOST_GID="$host_gid" -v "$work:/work" "$image" sh -c 'chown -R "$HOST_UID:$HOST_GID" /work'; then
			echo "failed to restore musl build workspace ownership" >&2
		fi
		rm -rf "$work"
	fi
}
trap cleanup EXIT
source_dir="$work/clipboard-$SOURCE_COMMIT"
mkdir -p "$source_dir"
cp -a "$VENDOR_DIR/source/." "$source_dir/"
tree_sha256() { find "$1" -type f -printf '%P\0' | LC_ALL=C sort -z | while IFS= read -r -d '' file; do printf '%s\0%s\n' "$file" "$(sha256sum "$1/$file" | cut -d' ' -f1)"; done | sha256sum | cut -d' ' -f1; }
test "$(tree_sha256 "$VENDOR_DIR/source")" = "$SOURCE_TREE_SHA256"
test "$(tree_sha256 "$VENDOR_DIR/vendor")" = "$VENDOR_TREE_SHA256"
test "$(node -p "require('$source_dir/package.json').version")" = 0.3.9
echo "$CARGO_LOCK_SHA256  $source_dir/Cargo.lock" | sha256sum --check --status
cmp "$source_dir/Cargo.lock" "$VENDOR_DIR/Cargo.lock"
cp "$VENDOR_DIR/LICENSE" "$source_dir/LICENSE"
cp -a "$VENDOR_DIR/vendor" "$source_dir/vendor"
mkdir -p "$source_dir/.cargo"; cp "$VENDOR_DIR/config.toml" "$source_dir/.cargo/config.toml"
apk_file="$VENDOR_DIR/apk/$ARCH/musl-dev-$MUSL_DEV_VERSION.apk"
echo "$apk_sha  $apk_file" | sha256sum --check --status || { echo "musl-dev apk digest mismatch" >&2; exit 1; }
mkdir -p "$work/build"
docker run --rm --network none --platform "$platform" \
	-e PATH=/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
	-v "$source_dir:/source:ro" -v "$apk_file:/inputs/musl-dev.apk:ro" -v "$work/build:/build" "$image" sh -euxc '
		test "$(uname -m)" = "'"$expected_machine"'"
		test "$(rustc --version)" = "'"$RUST_VERSION"'"
		cp -a /source/. /build/source/; cd /build/source
		tar -xzf /inputs/musl-dev.apk -C / usr/include usr/lib
		test -f /usr/include/stdio.h
		CARGO_NET_OFFLINE=true RUSTFLAGS="-C target-feature=-crt-static" cargo build --offline --release --locked --target "'"$triple"'"
		cp "target/'"$triple"'/release/libcrosscopy_clipboard.so" /build/clipboard.node
	'
package="clipboard-linux-$ARCH-musl"; file="clipboard.linux-$ARCH-musl.node"; package_dir="$OUTPUT_DIR/$package"
rm -rf "$OUTPUT_DIR"; mkdir -p "$package_dir"
cp "$work/build/clipboard.node" "$package_dir/$file"
cp "$VENDOR_DIR/LICENSE" "$package_dir/LICENSE"
cat > "$package_dir/package.json" <<JSON
{"name":"@mariozechner/$package","version":"0.3.9-xz.1","license":"MIT","os":["linux"],"cpu":["$ARCH"],"libc":["musl"],"main":"$file"}
JSON
addon_sha=$(sha256sum "$package_dir/$file" | cut -d' ' -f1)
printf '%s  %s\n' "$addon_sha" "$file" > "$package_dir/SHA256SUMS"
cat > "$OUTPUT_DIR/provenance.json" <<JSON
{
  "schemaVersion": 3,
  "component": "@mariozechner/clipboard",
  "upstreamVersion": "0.3.9",
  "architecture": "$ARCH",
  "source": {"url": "$SOURCE_URL", "commit": "$SOURCE_COMMIT", "sha256": "$SOURCE_SHA256", "sourceTreeSha256": "$SOURCE_TREE_SHA256", "vendorTreeSha256": "$VENDOR_TREE_SHA256", "cargoLockSha256": "$CARGO_LOCK_SHA256", "license": "MIT", "licenseFile": "node_modules/@mariozechner/$package/LICENSE"},
  "build": {"container": "$image", "platform": "$platform", "hostMachine": "$host_machine", "rust": "$RUST_VERSION", "muslDev": "$MUSL_DEV_VERSION", "muslDevApkSha256": "$apk_sha", "networkDisabled": true, "cargoOffline": true, "cargoLocked": true, "profile": "release"},
  "addon": {"file": "node_modules/@mariozechner/$package/$file", "sha256": "$addon_sha"}
}
JSON
