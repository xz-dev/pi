#!/usr/bin/env bash
# SPDX-License-Identifier: BSD-3-Clause
set -euo pipefail
# A container or qemu-user alone shares the kernel and is not the test boundary.
python3 "$(dirname "$0")/../../ci/linux-test-guard.py" --check-only
exec docker run --rm -v "$PWD:$PWD" -w "$PWD" \
  "${PROCWARD_CI_IMAGE:?missing pinned target image}" "$@"
