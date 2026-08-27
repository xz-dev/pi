#!/usr/bin/env bash
set -euo pipefail

target=${1:?Usage: build-pi-wrapper.sh <release-target> <output> [version]}
output=${2:?Usage: build-pi-wrapper.sh <release-target> <output> [version]}
version=${3:-}
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
if [[ -n "$version" ]]; then
	version_flags=(-DPI_WRAPPER_VERSION="\"$version\"")
else
	version_flags=()
fi
if [[ "$zig_target" == *-windows-* ]]; then
	# -D macros cannot form wide-string literals, so emit a UTF-16 version
	# array through a generated header included only by the WIN32 branch.
	wide_header=$(mktemp)
	trap 'rm -f "$wide_header"' EXIT
	python3 - "$version" "$wide_header" <<'PY'
import sys
version, path = sys.argv[1], sys.argv[2]
units = ", ".join(f"0x{ord(c):04x}" for c in version) + ", 0"
with open(path, "w") as handle:
    handle.write("#include <windows.h>\n")
    handle.write(f"static const wchar_t embedded_version[] = {{{units}}};\n")
    handle.write("#define PI_WRAPPER_VERSION_W embedded_version\n")
PY
	zig cc -target "$zig_target" -std=c11 -Os -s -municode "${version_flags[@]}" -include "$wide_header" native/pi-wrapper.c -o "$output"
else
	zig cc -target "$zig_target" -std=c11 -Os -s "${version_flags[@]}" native/pi-wrapper.c -o "$output"
fi
