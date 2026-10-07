#!/usr/bin/env bash
# Build and accept the exact FreeBSD ZIP on a FreeBSD guest of the matching architecture.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(uname -s)" == FreeBSD ]] || { echo "FreeBSD required" >&2; exit 1; }
case "$(uname -m)" in
	amd64) target=freebsd-x64 runner_arch=X64 ;;
	arm64) target=freebsd-arm64 runner_arch=ARM64 ;;
	*) echo "Unsupported FreeBSD architecture: $(uname -m)" >&2; exit 1 ;;
esac
export RUNNER_OS=FreeBSD RUNNER_ARCH=$runner_arch PI_XZ_EXECUTOR=freebsd-vm NODE_ENV=production
bun_version=$(node --input-type=module -e 'import { BUN_VERSION } from "./scripts/lib/bun-targets.mjs"; console.log(BUN_VERSION)')
# Emulated guests (QEMU TCG) get the same scaled budgets as smoke-binary-release.mjs.
interactive_ms=$(node --input-type=module -e 'import { smokeLimits } from "./scripts/lib/bun-targets.mjs"; console.log(smokeLimits(process.argv[1]).interactiveMs)' "$target")
export PI_XZ_E2E_TIMEOUT_MS=$(node --input-type=module -e 'import { EMULATED_SMOKE_SLOWDOWN, bunTarget } from "./scripts/lib/bun-targets.mjs"; console.log(120000 * (bunTarget(process.argv[1]).emulated ? EMULATED_SMOKE_SLOWDOWN : 1))' "$target")
# Bun names the FreeBSD arm64 runtime asset aarch64.
bun_asset=bun-${target/arm64/aarch64}
work=$(mktemp -d /tmp/pi-freebsd-release.XXXXXX)
xvfb_pid=""
cleanup() {
	if [[ -n "$xvfb_pid" ]]; then kill "$xvfb_pid" 2>/dev/null || true; wait "$xvfb_pid" 2>/dev/null || true; fi
	rm -rf "$work"
}
trap cleanup EXIT
curl -fL --retry 3 "https://github.com/oven-sh/bun/releases/download/bun-v$bun_version/$bun_asset.zip" -o "$work/bun.zip"
unzip -q "$work/bun.zip" -d "$work"
export PATH="$work/$bun_asset:$PATH"
npm ci --ignore-scripts --include=dev
npm run hydrate:model-data
npm run build:offline
node scripts/prepare-github-release.mjs --out "$work/candidate" --skip-build --platform "$target"
version=$(node -p 'require(process.argv[1]).distributionVersion' "$work/candidate/release-manifest.json")
# DISPLAY is deliberately absent for the basic TUI, then set for clipboard reads.
env -u DISPLAY -u WAYLAND_DISPLAY PI_OFFLINE=1 PI_CODING_AGENT_DIR="$work/agent" TERM=xterm-256color PI_XZ_TUI_TIMEOUT_MS="$interactive_ms" bun scripts/smoke-bun-tui.mjs "$work/candidate/pi-$target"
Xvfb :99 -screen 0 1024x768x24 -nolisten tcp -ac >"$work/xvfb.log" 2>&1 &
xvfb_pid=$!
for _ in {1..300}; do [[ -S /tmp/.X11-unix/X99 ]] && break; sleep 0.1; done
test -S /tmp/.X11-unix/X99
export DISPLAY=:99
mkdir -p .artifacts/freebsd-release
node scripts/smoke-binary-release.mjs "$work/candidate/pi-$target" "$target" "$version" ".artifacts/freebsd-release/$target.json"
# Signed self-update E2E runs in update-freebsd-release-candidate after attestation.
cp "$work/candidate/pi-$target" .artifacts/freebsd-release/
