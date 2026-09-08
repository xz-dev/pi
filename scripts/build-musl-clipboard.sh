#!/usr/bin/env bash
# Stage upstream's libc-neutral Linux helper and exact source/license evidence.
# No separate Rust clipboard addon is built or loaded after upstream #9163.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUTPUT_DIR=${1:-$ROOT/packages/coding-agent/binaries/clipboard-musl}
ARCH=${2:-}
node "$ROOT/scripts/lib/musl-provenance.mjs" "$OUTPUT_DIR" "$ARCH"
