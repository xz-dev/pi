#!/usr/bin/env bash
set -euo pipefail

readonly RELEASE_SELF_UPDATE_CONFLICT_PATHS=(
  "package.json"
  "packages/coding-agent/CHANGELOG.md"
)

resolve_release_self_update_squash_conflicts() {
  local -a conflicts=()
  if (( $# > 0 )); then conflicts=("$@"); fi
  local -A expected=()
  local conflict

  for conflict in "${RELEASE_SELF_UPDATE_CONFLICT_PATHS[@]}"; do
    expected["$conflict"]=1
  done

  if (( ${#conflicts[@]} < 1 || ${#conflicts[@]} > ${#RELEASE_SELF_UPDATE_CONFLICT_PATHS[@]} )); then
    printf '::error::Unexpected release-self-update squash conflicts:'
    if (( ${#conflicts[@]} > 0 )); then printf ' %q' "${conflicts[@]}"; fi
    printf '\n'
    return 1
  fi

  for conflict in "${conflicts[@]}"; do
    if [[ ! -v expected["$conflict"] ]]; then
      printf '::error::Unexpected release-self-update squash conflicts:'
      printf ' %q' "${conflicts[@]}"
      printf '\n'
      return 1
    fi
    unset 'expected[$conflict]'
  done

  if [[ -v expected["packages/coding-agent/CHANGELOG.md"] ]]; then
    printf '::error::Unexpected release-self-update squash conflicts:'
    printf ' %q' "${conflicts[@]}"
    printf '\n'
    return 1
  fi

  git checkout --ours -- packages/coding-agent/CHANGELOG.md
  git add packages/coding-agent/CHANGELOG.md
  if [[ ! -v expected["package.json"] ]]; then
    git checkout --ours -- package.json
    git add package.json
  fi

  if ! git diff --quiet --diff-filter=U --; then
    echo '::error::Unresolved conflicts remain after applying release-self-update conflict staging'
    return 1
  fi
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  if (( $# != 0 )); then
    echo 'usage: resolve-release-self-update-squash-conflicts.sh' >&2
    exit 2
  fi
  mapfile -d '' -t conflicts < <(git diff --name-only --diff-filter=U -z)
  resolve_release_self_update_squash_conflicts "${conflicts[@]}"
fi
