#!/usr/bin/env bash
# SPDX-License-Identifier: BSD-3-Clause
set -euo pipefail
# A container or qemu-user alone shares the kernel and is not the test boundary.
python3 "$(dirname "$0")/../../ci/linux-test-guard.py" --check-only
# Keep compile-time CARGO_BIN_EXE paths valid inside the target container.
exec docker run --rm --platform linux/riscv64 -v "$PWD:$PWD" -w "$PWD" \
  -e PROCWARD_TEST_QEMU_USER=1 -e RUST_TEST_THREADS=1 \
  "${PROCWARD_CI_IMAGE:?missing pinned target image}" "$@"
