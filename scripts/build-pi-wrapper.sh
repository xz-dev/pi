#!/usr/bin/env bash
set -euo pipefail

target=${1:?Usage: build-pi-wrapper.sh <release-target> <output>}
output=${2:?Usage: build-pi-wrapper.sh <release-target> <output>}
case "$target" in
	darwin-x64-*) zig_target=x86_64-macos ;;
	darwin-arm64) zig_target=aarch64-macos ;;
	linux-x64-gnu-*) zig_target=x86_64-linux-gnu ;;
	linux-arm64-gnu) zig_target=aarch64-linux-gnu ;;
	linux-x64-musl-*) zig_target=x86_64-linux-musl ;;
	linux-arm64-musl) zig_target=aarch64-linux-musl ;;
	windows-x64-*) zig_target=x86_64-windows-gnu ;;
	windows-arm64) zig_target=aarch64-windows-gnu ;;
	*) echo "Unknown Release target: $target" >&2; exit 1 ;;
esac

mkdir -p "$(dirname "$output")"
if [[ "$zig_target" == *-windows-* ]]; then
	zig cc -target "$zig_target" -std=c11 -Os -s -municode native/pi-wrapper.c -o "$output"
else
	zig cc -target "$zig_target" -std=c11 -Os -s native/pi-wrapper.c -o "$output"
fi
