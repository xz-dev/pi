#!/usr/bin/env bash
# Reuse the POSIX XCB clipboard implementation, compiled for FreeBSD's ABI.
set -euo pipefail
[[ "$(uname -s)" == FreeBSD ]] || { echo "FreeBSD native helpers must be built on FreeBSD" >&2; exit 1; }
case "$(uname -m)" in
	amd64|x86_64) arch=x64 ;;
	arm64|aarch64) arch=arm64 ;;
	*) echo "Unsupported FreeBSD architecture: $(uname -m)" >&2; exit 1 ;;
esac
script_dir="$(cd "$(dirname "$0")" && pwd)"
output="$script_dir/prebuilds/freebsd-$arch/freebsd-platform-x11.node"
mkdir -p "$(dirname "$output")"
"${CC:-cc}" -std=c11 -D_POSIX_C_SOURCE=200809L -Wall -Wextra -Werror -Os \
	-fPIC -pthread -fvisibility=hidden -shared -Wl,-z,nodelete \
	-I/usr/local/include -L/usr/local/lib -Wl,-rpath,/usr/local/lib \
	"$script_dir/../linux/src/linux-platform-x11.c" -lxcb -o "$output"
printf 'Built %s\n' "$output"
