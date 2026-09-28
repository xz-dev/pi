#!/usr/bin/env bash
# Build the Pi bundle usage-claim native module for one Release target.
# Usage: build-pi-usage-claim.sh <release-target> <output>
#
# Linux uses zig with an explicit libc target (gnu/musl) so asking for a musl
# bundle can never silently produce a glibc addon. Darwin builds natively on
# the matching GitHub-hosted runner. Windows follows the self-contained
# pi-filesystem-snapshot pattern and needs no Node headers or CRT.
set -euo pipefail

target=${1:?Usage: build-pi-usage-claim.sh <release-target> <output>}
output=${2:?Usage: build-pi-usage-claim.sh <release-target> <output>}
mkdir -p "$(dirname "$output")"

node_include() {
	local include=${PI_USAGE_CLAIM_NODE_INCLUDE:-}
	if [[ -z "$include" ]]; then
		include=$(node -e 'const p=require("node:path");process.stdout.write(p.resolve(p.dirname(process.execPath),"../include/node"))')
	fi
	if [[ ! -f "$include/node_api.h" ]]; then
		echo "Node-API headers not found at $include (set PI_USAGE_CLAIM_NODE_INCLUDE)" >&2
		exit 1
	fi
	printf '%s' "$include"
}

case "$target" in
	darwin-*)
		include=$(node_include)
		cc -bundle -undefined dynamic_lookup -D_DARWIN_C_SOURCE -O2 -std=c11 -Wall -Wextra -Werror \
			-I"$include" -o "$output" native/pi-usage-claim-posix.c
		;;
	linux-x64-gnu-*) zig_target=x86_64-linux-gnu; source=native/pi-usage-claim-posix.c ;;
	linux-arm64-gnu) zig_target=aarch64-linux-gnu; source=native/pi-usage-claim-posix.c ;;
	linux-x64-musl-*) zig_target=x86_64-linux-musl; source=native/pi-usage-claim-posix.c ;;
	linux-arm64-musl) zig_target=aarch64-linux-musl; source=native/pi-usage-claim-posix.c ;;
	windows-x64-*) zig_target=x86_64-windows-gnu; source=native/pi-usage-claim-win32.c ;;
	windows-arm64) zig_target=aarch64-windows-gnu; source=native/pi-usage-claim-win32.c ;;
	*)
		echo "Pi usage claim module does not support Release target: $target" >&2
		exit 1
		;;
esac

if [[ "$target" == linux-* ]]; then
	include=$(node_include)
	zig cc \
		-target "$zig_target" \
		-shared \
		-fPIC \
		-O2 \
		-std=c11 \
		-Wall \
		-Wextra \
		-Werror \
		-I"$include" \
		-o "$output" \
		"$source"
elif [[ "$target" == windows-* ]]; then
	object=$(mktemp "${TMPDIR:-/tmp}/pi-usage-claim.XXXXXX.o")
	trap 'rm -f "$object"' EXIT
	zig cc \
		-target "$zig_target" \
		-std=c11 \
		-Wall \
		-Wextra \
		-Werror \
		-fno-sanitize=undefined \
		-Os \
		-c \
		"$source" \
		-o "$object"
	zig cc \
		-target "$zig_target" \
		-shared \
		-nostdlib \
		-s \
		"$object" \
		-lkernel32 \
		-o "$output"
fi
