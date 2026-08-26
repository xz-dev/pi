#!/usr/bin/env bash
# Build one or more canonical Bun Release targets. The authoritative matrix is
# scripts/lib/bun-targets.mjs; GitHub Actions invokes one target per matrix job.
set -euo pipefail

cd "$(dirname "$0")/.."
SKIP_INSTALL=false
SKIP_DEPS=false
SKIP_BUILD=false
HYDRATE_TARGET_DEPS=false
OFFLINE_MODEL_DATA=false
PLATFORMS_REQUESTED=()
OUTPUT_DIR=""
DISTRIBUTION_VERSION=""
CLIPBOARD_MUSL_DIR=""

while [[ $# -gt 0 ]]; do
	case $1 in
		--skip-install) SKIP_INSTALL=true; shift ;;
		--skip-deps) SKIP_DEPS=true; shift ;;
		--skip-build) SKIP_BUILD=true; shift ;;
		--hydrate-target-deps) HYDRATE_TARGET_DEPS=true; shift ;;
		--offline-model-data) OFFLINE_MODEL_DATA=true; shift ;;
		--platform) PLATFORMS_REQUESTED+=("$2"); shift 2 ;;
		--out) OUTPUT_DIR="$2"; shift 2 ;;
		--distribution-version) DISTRIBUTION_VERSION="$2"; shift 2 ;;
		--clipboard-musl-dir) CLIPBOARD_MUSL_DIR="$2"; shift 2 ;;
		*) echo "Unknown option: $1" >&2; exit 1 ;;
	esac
done

ALL_TARGETS=()
while IFS= read -r target; do
	[[ -n "$target" ]] && ALL_TARGETS+=("$target")
done < <(node scripts/lib/bun-targets.mjs --ids)
if [[ ${#PLATFORMS_REQUESTED[@]} -eq 0 ]]; then PLATFORMS_REQUESTED=("${ALL_TARGETS[@]}"); fi
for target in "${PLATFORMS_REQUESTED[@]}"; do
	node scripts/lib/bun-targets.mjs --get "$target" bunTarget >/dev/null || { echo "Invalid target: $target" >&2; exit 1; }
done

OUTPUT_DIR=${OUTPUT_DIR:-packages/coding-agent/binaries}
if command -v cygpath >/dev/null 2>&1 && [[ "$OUTPUT_DIR" =~ ^[A-Za-z]:[\\/] ]]; then
	OUTPUT_DIR=$(cygpath -u "$OUTPUT_DIR")
fi
[[ "$OUTPUT_DIR" = /* ]] || OUTPUT_DIR="$(pwd)/$OUTPUT_DIR"

if [[ "$SKIP_INSTALL" == false ]]; then npm ci --ignore-scripts; fi
if [[ "$SKIP_DEPS" == false ]]; then
	clipboard_version=$(node -p "require('./packages/coding-agent/package.json').optionalDependencies['@mariozechner/clipboard']")
	npm install --include=optional --no-save --package-lock=false --force --ignore-scripts \
		"@mariozechner/clipboard@$clipboard_version" \
		"@mariozechner/clipboard-darwin-arm64@$clipboard_version" \
		"@mariozechner/clipboard-darwin-x64@$clipboard_version" \
		"@mariozechner/clipboard-linux-x64-gnu@$clipboard_version" \
		"@mariozechner/clipboard-linux-arm64-gnu@$clipboard_version" \
		"@mariozechner/clipboard-linux-x64-musl@$clipboard_version" \
		"@mariozechner/clipboard-linux-arm64-musl@$clipboard_version" \
		"@mariozechner/clipboard-win32-x64-msvc@$clipboard_version" \
		"@mariozechner/clipboard-win32-arm64-msvc@$clipboard_version"
fi
if [[ "$SKIP_BUILD" == false ]]; then
	if [[ "$OFFLINE_MODEL_DATA" == true ]]; then npm run build:offline; else npm run build; fi
fi
if [[ "$HYDRATE_TARGET_DEPS" == true ]]; then
	test "${#PLATFORMS_REQUESTED[@]}" -eq 1 || { echo "--hydrate-target-deps requires exactly one target" >&2; exit 1; }
	clipboard_package=$(node scripts/lib/bun-targets.mjs --get "${PLATFORMS_REQUESTED[0]}" clipboardNativePackage)
	lock_entry="node_modules/@mariozechner/$clipboard_package"
	resolved=$(node -p "require('./package-lock.json').packages['$lock_entry'].resolved")
	integrity=$(node -p "require('./package-lock.json').packages['$lock_entry'].integrity")
	mkdir -p node_modules/@mariozechner
	tarball="$(pwd)/$(npm pack --ignore-scripts --silent "$resolved")"
	node -e "const fs=require('node:fs');const crypto=require('node:crypto');const [file,expected]=process.argv.slice(1);const [algorithm,digest]=expected.split('-',2);const actual=crypto.createHash(algorithm).update(fs.readFileSync(file)).digest('base64');if(actual!==digest)throw new Error('clipboard tarball integrity mismatch')" "$tarball" "$integrity"
	tmp_deps=$(mktemp -d)
	trap 'rm -rf "$tmp_deps" "$tarball"' EXIT
	tar -xzf "$tarball" -C "$tmp_deps"
	rm -rf "node_modules/@mariozechner/$clipboard_package"
	mv "$tmp_deps/package" "node_modules/@mariozechner/$clipboard_package"
fi
export NODE_ENV=production
if [[ -z "$CLIPBOARD_MUSL_DIR" ]] && printf '%s\n' "${PLATFORMS_REQUESTED[@]}" | grep -q -- '-musl'; then
	echo "musl targets require an architecture-matched --clipboard-musl-dir" >&2
	exit 1
fi

mkdir -p "$OUTPUT_DIR"
cd packages/coding-agent
for target in "${PLATFORMS_REQUESTED[@]}"; do
	bun_target=$(node ../../scripts/lib/bun-targets.mjs --get "$target" bunTarget)
	executable=$(node ../../scripts/lib/bun-targets.mjs --get "$target" executable)
	wrapper=$(node ../../scripts/lib/bun-targets.mjs --get "$target" wrapper)
	archive=$(node ../../scripts/lib/bun-targets.mjs --get "$target" archive)
	clipboard_package=$(node ../../scripts/lib/bun-targets.mjs --get "$target" clipboardNativePackage)
	clipboard_file=$(node ../../scripts/lib/bun-targets.mjs --get "$target" clipboardNativeFile)
	target_dir="$OUTPUT_DIR/$target"
	rm -rf "$target_dir"
	mkdir -p "$target_dir"

	# Keep the executable flags in the authoritative target descriptor so local,
	# CI, and release builds cannot silently diverge. macOS runners ship bash 3.2,
	# so read the flags with a portable while loop instead of mapfile.
	bun_build_flags=()
	while IFS= read -r flag; do bun_build_flags+=("$flag"); done < <(node ../../scripts/lib/bun-targets.mjs --build-flags "$target")
	bun build --compile "${bun_build_flags[@]}" --target="$bun_target" ./dist/bun/cli.js ./src/utils/image-resize-worker.ts --outfile "$target_dir/$executable"
	(cd ../.. && scripts/build-pi-wrapper.sh "$target" "$target_dir/$wrapper")
	cp package.json README.md CHANGELOG.md "$target_dir/"
	if [[ -n "$DISTRIBUTION_VERSION" ]]; then
		node -e "const fs=require('node:fs');const p=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));const base=p.version;p.version=process.argv[2];p.piConfig={...(p.piConfig??{}),distribution:'xz-dev',releaseTarget:process.argv[3],changelogVersion:p.piConfig?.changelogVersion??base};fs.writeFileSync(process.argv[1],JSON.stringify(p,null,2)+'\n')" "$target_dir/package.json" "$DISTRIBUTION_VERSION" "$target"
	fi
	cp ../../node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm "$target_dir/"
	mkdir -p "$target_dir/theme" "$target_dir/assets"
	cp dist/modes/interactive/theme/*.json "$target_dir/theme/"
	cp dist/modes/interactive/assets/* "$target_dir/assets/"
	cp -r dist/core/export-html docs examples "$target_dir/"
	mkdir -p "$target_dir/node_modules/@mariozechner"
	cp -r ../../node_modules/@mariozechner/clipboard "$target_dir/node_modules/@mariozechner/"
	if [[ "$target" == *-musl* ]]; then
		test -n "$CLIPBOARD_MUSL_DIR"
		cp -r "$CLIPBOARD_MUSL_DIR/$clipboard_package" "$target_dir/node_modules/@mariozechner/"
		cp "$CLIPBOARD_MUSL_DIR/$clipboard_package/$clipboard_file" "$target_dir/node_modules/@mariozechner/clipboard/"
		cp "$CLIPBOARD_MUSL_DIR/provenance.json" "$target_dir/clipboard-native-provenance.json"
		cp "$CLIPBOARD_MUSL_DIR/$clipboard_package/LICENSE" "$target_dir/node_modules/@mariozechner/$clipboard_package/LICENSE"
	else
		native_package="../../node_modules/@mariozechner/$clipboard_package"
		test -f "$native_package/$clipboard_file" || { echo "npm ci did not install host native package @mariozechner/$clipboard_package for $target" >&2; exit 1; }
		cp -r "$native_package" "$target_dir/node_modules/@mariozechner/"
		cp "$native_package/$clipboard_file" "$target_dir/node_modules/@mariozechner/clipboard/"
	fi

	native_dir=$(node ../../scripts/lib/bun-targets.mjs --get "$target" nativeHelperDir 2>/dev/null || true)
	if [[ -n "$native_dir" ]]; then
		native_file=$(node ../../scripts/lib/bun-targets.mjs --get "$target" nativeHelperFile)
		mkdir -p "$target_dir/$native_dir"
		cp "../tui/$native_dir/$native_file" "$target_dir/$native_dir/"
	fi
	node ../../scripts/generate-third-party-notices.mjs "$target_dir" "$target_dir/THIRD_PARTY_NOTICES.md"

	[[ "$archive" == zip ]]
	archive_path="$OUTPUT_DIR/pi-$target.zip"
	rm -f "$archive_path"
	if command -v cygpath >/dev/null 2>&1; then
		archive_path=$(cygpath -w "$archive_path")
		(cd "$target_dir" && 7z a -bd -tzip -mm=Deflate "$archive_path" .)
		node ../../scripts/normalize-windows-zip.mjs "$archive_path"
	else
		(cd "$target_dir" && zip -qr "$archive_path" .)
	fi
done
