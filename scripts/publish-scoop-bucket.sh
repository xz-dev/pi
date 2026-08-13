#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
	echo 'Usage: scripts/publish-scoop-bucket.sh <release-manifest.json>' >&2
	exit 1
fi

manifest=$(realpath "$1")
work=$(mktemp -d "${RUNNER_TEMP:-/tmp}/pi-scoop-bucket.XXXXXX")
trap 'rm -rf -- "$work"' EXIT

node "$(dirname "$0")/create-scoop-manifest.mjs" "$manifest" "$work/pi.json"

git -C "$work" init -q
repository=${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}
if [[ $repository == /* || $repository == [A-Za-z]:[\\/]* ]]; then
	remote=$repository
else
	remote="https://x-access-token:${GITHUB_TOKEN:?GITHUB_TOKEN is required}@github.com/$repository.git"
fi
git -C "$work" remote add origin "$remote"
if git -C "$work" ls-remote --exit-code --heads origin scoop >/dev/null; then
	git -C "$work" fetch -q --depth=1 origin scoop
	git -C "$work" checkout -q -B scoop FETCH_HEAD
else
	git -C "$work" checkout -q --orphan scoop
fi
mkdir -p "$work/bucket"
mv "$work/pi.json" "$work/bucket/pi.json"
printf '# xz-dev Pi Scoop bucket\n' > "$work/README.md"
git -C "$work" add README.md bucket/pi.json
if git -C "$work" diff --cached --quiet; then
	echo 'Scoop bucket already current'
	exit 0
fi
git -C "$work" config user.name 'github-actions[bot]'
git -C "$work" config user.email '41898282+github-actions[bot]@users.noreply.github.com'
version=$(node -p 'require(process.argv[1]).distributionVersion' "$manifest")
git -C "$work" commit -qm "Update pi to $version"
git -C "$work" push origin HEAD:scoop
