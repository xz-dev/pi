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
WITHOUT_X11=false
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
		--without-x11) WITHOUT_X11=true; shift ;;
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

expected_bun=$(node --input-type=module -e 'import { BUN_VERSION } from "./scripts/lib/bun-targets.mjs"; console.log(BUN_VERSION)')
actual_bun=$(bun --version)
if [[ "$actual_bun" != "$expected_bun" ]]; then
	echo "Bun compiler version mismatch: expected $expected_bun, got $actual_bun" >&2
	exit 1
fi

if [[ "$SKIP_INSTALL" == false ]]; then npm ci --ignore-scripts; fi
if [[ "$SKIP_BUILD" == false ]]; then
	if [[ "$OFFLINE_MODEL_DATA" == true ]]; then npm run build:offline; else npm run build; fi
fi
export NODE_ENV=production
if [[ "$WITHOUT_X11" == false && -z "$CLIPBOARD_MUSL_DIR" ]] && printf '%s\n' "${PLATFORMS_REQUESTED[@]}" | grep -q -- '-musl'; then
	echo "musl targets require an architecture-matched --clipboard-musl-dir" >&2
	exit 1
fi

mkdir -p "$OUTPUT_DIR"
cd packages/coding-agent
for target in "${PLATFORMS_REQUESTED[@]}"; do
	bun_target=$(node ../../scripts/lib/bun-targets.mjs --get "$target" bunTarget)
	executable=$(node ../../scripts/lib/bun-targets.mjs --get "$target" executable)
	target_dir="$OUTPUT_DIR/$target"
	rm -rf "$target_dir"
	mkdir -p "$target_dir"

	# Keep the executable flags in the authoritative target descriptor so local,
	# CI, and release builds cannot silently diverge. macOS runners ship bash 3.2,
	# so read the flags with a portable while loop instead of mapfile.
	bun_build_flags=()
	while IFS= read -r flag; do bun_build_flags+=("$flag"); done < <(node ../../scripts/lib/bun-targets.mjs --build-flags "$target")

	# The public entrypoint is the compiled executable itself (`pi-<target>`);
	# there is no pi-wrapper launcher and no second pi-native binary. Build
	# metadata is written into the embedded package.json BEFORE compilation.
	build_dir=$(mktemp -d "$target_dir/.build.XXXXXX")
	cp package.json "$build_dir/package.json"
	if [[ -n "$DISTRIBUTION_VERSION" ]]; then
		node -e "const fs=require('node:fs');const p=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));const base=p.version;p.version=process.argv[2];p.piConfig={...(p.piConfig??{}),distribution:'xz-dev',releaseTarget:process.argv[3],changelogVersion:p.piConfig?.changelogVersion??base};fs.writeFileSync(process.argv[1],JSON.stringify(p,null,2)+'\n')" "$build_dir/package.json" "$DISTRIBUTION_VERSION" "$target"
	fi
	# Embed package resources consumed via readFileSync/readdir under
	# `/$bunfs/root/<basename>` (see config.ts getEmbeddedAssetPath). Physical
	# resources (native .node addons, README/docs/examples) are materialized to
	# the tmpdir cache lazily at first use.
	asset_args=(
		--asset="$build_dir/package.json"
		--asset=README.md
		--asset=CHANGELOG.md
		--asset=docs
		--asset=examples
		--asset=src/modes/interactive/theme
		--asset=src/modes/interactive/assets
		--asset=src/core/export-html
		--asset=../../node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm
	)
	native_dir=$(node ../../scripts/lib/bun-targets.mjs --get "$target" nativeHelperDir 2>/dev/null || true)
	native_file=$(node ../../scripts/lib/bun-targets.mjs --get "$target" nativeHelperFile 2>/dev/null || true)
	if [[ -n "$native_dir" && ( "$WITHOUT_X11" == false || "$native_file" != *-x11.node ) ]]; then
		if [[ "$target" == freebsd-* ]]; then
			bash ../tui/native/freebsd/build.sh
		fi
		native_source="../tui/$native_dir/$native_file"
		if [[ "$target" == *-musl* ]]; then
			native_source="$CLIPBOARD_MUSL_DIR/$native_dir/$native_file"
			node ../../scripts/verify-musl-provenance.mjs "$CLIPBOARD_MUSL_DIR/provenance.json" "$native_source" "$target"
		fi
		# Embed only this target's helper under `native/` so materialization
		# serves the path the loader expects (e.g.
		# `native/linux/prebuilds/linux-x64/...`) and unfolds nothing else.
		mkdir -p "$build_dir/$native_dir"
		cp "$native_source" "$build_dir/$native_dir/"
		if [[ "$target" == *-musl* ]]; then
			# The provenance names its license as `native/LICENSE` relative to the
			# provenance file, so ship both inside the native tree.
			cp "$CLIPBOARD_MUSL_DIR/provenance.json" "$build_dir/native/clipboard-native-provenance.json"
			mkdir -p "$build_dir/native/native"
			cp "$CLIPBOARD_MUSL_DIR/native/LICENSE" "$build_dir/native/native/LICENSE"
		fi
		asset_args+=(--asset="$build_dir/native")
	fi
	# Do not load project .env files into the standalone process (upstream #10473).
	bun build --compile "${bun_build_flags[@]}" --no-compile-autoload-bunfig --no-compile-autoload-dotenv --target="$bun_target" "${asset_args[@]}" ./src/bun/cli-portable.ts ./src/utils/image-resize-worker.ts ./src/extensions/codemode/worker.ts --outfile "$target_dir/$executable"
	rm -rf "$build_dir"
	# The release artifact is the raw executable, not a ZIP: publish
	# `pi-<target>`/`pi-<target>.exe` directly.
	release_path="$OUTPUT_DIR/pi-$target"
	if [[ "$target" == windows-* ]]; then release_path="$release_path.exe"; fi
	mv "$target_dir/$executable" "$release_path"
	rmdir "$target_dir"
done
