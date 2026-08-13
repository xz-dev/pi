#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
	echo 'Usage: scripts/publish-scoop-bucket.sh <release-manifest.json>' >&2
	exit 1
fi

manifest=$(realpath "$1")
manifest_commit=$(node -p 'require(process.argv[1]).commit' "$manifest")
if [[ ! $manifest_commit =~ ^[0-9a-f]{40}$ ]]; then
	echo 'Invalid Scoop release manifest commit' >&2
	exit 1
fi
repository=${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}
if [[ $repository == /* || $repository == [A-Za-z]:[\\/]* ]]; then
	remote=$repository
else
	remote="https://x-access-token:${GITHUB_TOKEN:?GITHUB_TOKEN is required}@github.com/$repository.git"
fi
current_main=$(git ls-remote "$remote" refs/heads/main | cut -f1)
if [[ $current_main != "$manifest_commit" ]]; then
	echo 'Scoop bucket update skipped for historical Release'
	exit 0
fi
work=$(mktemp -d "${RUNNER_TEMP:-/tmp}/pi-scoop-bucket.XXXXXX")
manifest_output=$(mktemp "${RUNNER_TEMP:-/tmp}/pi-scoop-manifest.XXXXXX")
trap 'rm -rf -- "$work"; rm -f -- "$manifest_output"' EXIT

node "$(dirname "$0")/create-scoop-manifest.mjs" "$manifest" "$work/pi.json"
mv "$work/pi.json" "$manifest_output"

git -C "$work" init -q
git -C "$work" remote add origin "$remote"
if git -C "$work" ls-remote --exit-code --heads origin scoop >/dev/null; then
	git -C "$work" fetch -q --depth=1 origin scoop
	git -C "$work" checkout -q -B scoop FETCH_HEAD
else
	git -C "$work" checkout -q --orphan scoop
fi
find "$work" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf -- {} +
mkdir -p "$work/bucket"
mv "$manifest_output" "$work/bucket/pi.json"
git -C "$work" add -A
if git -C "$work" diff --cached --quiet; then
	echo 'Scoop bucket already current'
	exit 0
fi
git -C "$work" config user.name 'github-actions[bot]'
git -C "$work" config user.email '41898282+github-actions[bot]@users.noreply.github.com'
git -C "$work" config commit.gpgsign false
version=$(node -p 'require(process.argv[1]).distributionVersion' "$manifest")
git -C "$work" commit -qm "Update pi to $version"
git -C "$work" push origin HEAD:scoop
