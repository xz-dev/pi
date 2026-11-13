#!/usr/bin/env bash
# Moves the generated `nix` distribution branch to one built Release flake.
# The branch is an unrelated root holding only flake.nix, flake.lock and
# nix/package.nix. <built-flake-dir> must equal, byte for byte, the flake this
# script regenerates from the checked-out ci templates and the authenticated
# manifest, so only the tree the native Nix builds accepted is published.
set -euo pipefail

if [[ $# -ne 2 ]]; then
	echo 'Usage: scripts/publish-nix-flake.sh <release-manifest.json> <built-flake-dir>' >&2
	exit 1
fi

source_root=$(realpath "$(dirname "$0")/..")
manifest=$(realpath "$1")
built=$(realpath "$2")
read_manifest() {
	node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]]' "$manifest" "$1"
}
manifest_commit=$(read_manifest commit)
if [[ ! $manifest_commit =~ ^[0-9a-f]{40}$ ]]; then
	echo 'Invalid Nix release manifest commit' >&2
	exit 1
fi
repository=${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}
if [[ $repository == /* ]]; then
	remote=$repository
else
	remote="https://x-access-token:${GITHUB_TOKEN:?GITHUB_TOKEN is required}@github.com/$repository.git"
fi
# Only the current main's Release may move the branch: a delayed run for an
# older commit must not downgrade it.
current_main=$(git ls-remote "$remote" refs/heads/main | cut -f1)
if [[ $current_main != "$manifest_commit" ]]; then
	echo 'Nix flake update skipped for historical Release'
	exit 0
fi
work=$(mktemp -d "${RUNNER_TEMP:-/tmp}/pi-nix-flake.XXXXXX")
trap 'rm -rf -- "$work"' EXIT

flake="$work/flake"
mkdir -p "$flake/nix"
cp "$source_root/flake.nix" "$source_root/flake.lock" "$flake/"
cp "$source_root/nix/package.nix" "$flake/nix/"
node "$source_root/scripts/update-nix-package.mjs" "$manifest" "$flake/nix/package.nix"
if ! diff -r "$flake" "$built" >&2; then
	echo 'Built Nix flake differs from the authenticated Release flake' >&2
	exit 1
fi

branch="$work/branch"
git init -q "$branch"
git -C "$branch" remote add origin "$remote"
if git -C "$branch" ls-remote --exit-code origin refs/heads/nix >/dev/null; then
	git -C "$branch" fetch -q --depth=1 origin refs/heads/nix
	git -C "$branch" checkout -q -B nix FETCH_HEAD
else
	git -C "$branch" checkout -q --orphan nix
fi
find "$branch" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf -- {} +
cp -R "$flake/." "$branch/"
git -C "$branch" add -A
if git -C "$branch" diff --cached --quiet; then
	echo 'Nix flake branch already current'
	exit 0
fi
git -C "$branch" config user.name 'github-actions[bot]'
git -C "$branch" config user.email '41898282+github-actions[bot]@users.noreply.github.com'
git -C "$branch" config commit.gpgsign false
version=$(read_manifest distributionVersion)
git -C "$branch" commit -qm "Update pi to $version"
# Main may have moved while the flake was verified and committed.
current_main=$(git ls-remote "$remote" refs/heads/main | cut -f1)
if [[ $current_main != "$manifest_commit" ]]; then
	echo 'Nix flake update skipped: main moved before push'
	exit 0
fi
git -C "$branch" push -q origin HEAD:refs/heads/nix
echo "Nix flake branch updated to $version"
