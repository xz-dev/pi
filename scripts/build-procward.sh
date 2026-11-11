#!/usr/bin/env bash
# Compatibility entrypoint; the Node builder is the sole Cargo authority.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/../packages/coding-agent/scripts/build-procward.mjs" "$@"
