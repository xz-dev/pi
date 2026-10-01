#!/usr/bin/env bash
# Build and accept the exact FreeBSD ZIP on a matching FreeBSD amd64 guest.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(uname -s):$(uname -m)" == FreeBSD:amd64 ]] || { echo "FreeBSD amd64 required" >&2; exit 1; }
export RUNNER_OS=FreeBSD RUNNER_ARCH=X64 PI_XZ_EXECUTOR=freebsd-vm NODE_ENV=production
bun_version=$(node --input-type=module -e 'import { BUN_VERSION } from "./scripts/lib/bun-targets.mjs"; console.log(BUN_VERSION)')
work=$(mktemp -d /tmp/pi-freebsd-release.XXXXXX)
xvfb_pid=""
cleanup() {
	if [[ -n "$xvfb_pid" ]]; then kill "$xvfb_pid" 2>/dev/null || true; wait "$xvfb_pid" 2>/dev/null || true; fi
	rm -rf "$work"
}
trap cleanup EXIT
curl -fL --retry 3 "https://github.com/oven-sh/bun/releases/download/bun-v$bun_version/bun-freebsd-x64.zip" -o "$work/bun.zip"
unzip -q "$work/bun.zip" -d "$work"
export PATH="$work/bun-freebsd-x64:$PATH"
npm ci --ignore-scripts --include=dev
npm run hydrate:model-data
npm run build:offline
node scripts/prepare-github-release.mjs --out "$work/candidate" --skip-build --platform freebsd-x64
version=$(node -p 'require(process.argv[1]).distributionVersion' "$work/candidate/release-manifest.json")
# DISPLAY is deliberately absent for the basic TUI, then set for clipboard reads.
env -u DISPLAY -u WAYLAND_DISPLAY PI_OFFLINE=1 PI_CODING_AGENT_DIR="$work/agent" TERM=xterm-256color bun scripts/smoke-bun-tui.mjs "$work/candidate/work/freebsd-x64/pi"
Xvfb :99 -screen 0 1024x768x24 -nolisten tcp -ac >"$work/xvfb.log" 2>&1 &
xvfb_pid=$!
for _ in {1..50}; do [[ -S /tmp/.X11-unix/X99 ]] && break; sleep 0.1; done
test -S /tmp/.X11-unix/X99
export DISPLAY=:99
mkdir -p .artifacts/freebsd-release
node scripts/smoke-binary-release.mjs "$work/candidate/pi-freebsd-x64.zip" freebsd-x64 "$version" .artifacts/freebsd-release/freebsd-x64.json
node scripts/e2e-binary-self-update.mjs "$work/candidate" freebsd-x64 "$version"
cp "$work/candidate/pi-freebsd-x64.zip" .artifacts/freebsd-release/
