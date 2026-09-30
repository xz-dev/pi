#!/usr/bin/env bash
set -euo pipefail

target=${1:?Usage: build-win32-filesystem-snapshot.sh <release-target> <output> [api-version] [malformed-results]}
output=${2:?Usage: build-win32-filesystem-snapshot.sh <release-target> <output> [api-version] [malformed-results]}
api_version=${3:-1}
malformed_results=${4:-0}
case "$api_version" in
	''|*[!0-9]*) echo "Win32 filesystem snapshot API version must be an unsigned integer: $api_version" >&2; exit 1 ;;
esac
case "$malformed_results" in
	0|1) ;;
	*) echo "Win32 filesystem snapshot malformed-results flag must be 0 or 1: $malformed_results" >&2; exit 1 ;;
esac
case "$target" in
	windows-x64-*) zig_target=x86_64-windows-gnu ;;
	windows-arm64) zig_target=aarch64-windows-gnu ;;
	*) echo "Win32 filesystem snapshot helper does not support Release target: $target" >&2; exit 1 ;;
esac

mkdir -p "$(dirname "$output")"
object=$(mktemp "${TMPDIR:-/tmp}/pi-filesystem-snapshot.XXXXXX.o")
trap 'rm -f "$object"' EXIT
zig cc \
	-target "$zig_target" \
	-std=c11 \
	-Wall \
	-Wextra \
	-Werror \
	-DSNAPSHOT_API_VERSION="$api_version" \
	-DSNAPSHOT_MALFORMED_RESULTS="$malformed_results" \
	-Os \
	-c \
	native/pi-filesystem-snapshot.c \
	-o "$object"
zig cc \
	-target "$zig_target" \
	-shared \
	-nostdlib \
	-s \
	"$object" \
	-lkernel32 \
	-o "$output"
