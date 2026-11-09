#!/usr/bin/env bash
# Compile the vendored procward process owner (vendor/procward) into
# packages/coding-agent/native/procward/<triple>/. Called by build-binaries.sh
# and CI packaging. Set PROCWARD=0 to skip: the build then produces a pi
# without process ownership support (the runtime treats it like
# --no-process-ownership builds).
#
# Usage: scripts/build-procward.sh [--triple <rust-triple>] [--skip-if-missing]
#   --triple          Explicit Rust target triple (default: host).
#   --skip-if-missing Do not fail when cargo is unavailable; print a warning
#                     and exit 0 (used by developer builds, never CI).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VENDOR_DIR="$REPO_ROOT/vendor/procward"
OUT_ROOT="$REPO_ROOT/packages/coding-agent/native/procward"

TRIPLE=""
SKIP_IF_MISSING=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --triple) TRIPLE="$2"; shift 2 ;;
        --skip-if-missing) SKIP_IF_MISSING=1; shift ;;
        *) echo "build-procward.sh: unknown argument: $1" >&2; exit 2 ;;
    esac
done

if [[ "${PROCWARD:-1}" == "0" ]]; then
    echo "==> PROCWARD=0: skipping procward build (ownership disabled in this build)"
    exit 0
fi

if [[ ! -f "$VENDOR_DIR/Cargo.toml" ]]; then
    echo "build-procward.sh: vendored procward source missing at $VENDOR_DIR" >&2
    exit 1
fi

if ! command -v cargo >/dev/null 2>&1; then
    if [[ "$SKIP_IF_MISSING" == "1" ]]; then
        echo "==> cargo not found; skipping procward build (--skip-if-missing)" >&2
        exit 0
    fi
    echo "build-procward.sh: cargo is required to build procward." \
        "Install Rust, or build with PROCWARD=0 for a pi without process ownership." >&2
    exit 1
fi

cd "$VENDOR_DIR"
if [[ -n "$TRIPLE" ]]; then
    echo "==> Building procward for $TRIPLE..."
    cargo build --release --target "$TRIPLE"
    BIN="target/$TRIPLE/release/procward"
    OUT_DIR="$OUT_ROOT/$TRIPLE"
else
    echo "==> Building procward for host..."
    cargo build --release
    BIN="target/release/procward"
    OUT_DIR="$OUT_ROOT/host"
fi

mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR/procward" "$OUT_DIR/procward.exe"
if [[ -f "$BIN.exe" ]]; then
    cp "$BIN.exe" "$OUT_DIR/procward.exe"
else
    cp "$BIN" "$OUT_DIR/procward"
fi

echo "==> procward installed at $OUT_DIR"
