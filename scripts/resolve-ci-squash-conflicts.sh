#!/usr/bin/env bash
set -euo pipefail

readonly CI_CONFLICT_PATHS=(
  ".github/workflows/build-binaries.yml"
  "README.md"
  "packages/coding-agent/CHANGELOG.md"
  "packages/coding-agent/test/package-command-paths.test.ts"
  "scripts/build-binaries.sh"
)

resolve_ci_squash_conflicts() {
  local -a conflicts=("$@")
  local -A expected=()
  local conflict

  for conflict in "${CI_CONFLICT_PATHS[@]}"; do
    expected["$conflict"]=1
  done

  if (( ${#conflicts[@]} != ${#CI_CONFLICT_PATHS[@]} )); then
    printf '::error::Unexpected ci squash conflicts:'
    printf ' %q' "${conflicts[@]}"
    printf '\n'
    return 1
  fi

  for conflict in "${conflicts[@]}"; do
    if [[ ! -v expected["$conflict"] ]]; then
      printf '::error::Unexpected ci squash conflicts:'
      printf ' %q' "${conflicts[@]}"
      printf '\n'
      return 1
    fi
    unset 'expected[$conflict]'
  done

  if (( ${#expected[@]} != 0 )); then
    printf '::error::Unexpected ci squash conflicts:'
    printf ' %q' "${conflicts[@]}"
    printf '\n'
    return 1
  fi

  git restore --source=origin/ci --staged --worktree -- README.md scripts/build-binaries.sh
  # The downstream GitHub Release workflow supersedes this upstream tag workflow.
  git rm -- .github/workflows/build-binaries.yml
  # This ci branch intentionally removed superseded registry self-update tests. Preserve
  # current upstream coverage instead of replaying that historical deletion over it.
  git checkout --ours -- packages/coding-agent/test/package-command-paths.test.ts
  git add packages/coding-agent/test/package-command-paths.test.ts
  git checkout --ours -- packages/coding-agent/CHANGELOG.md
  git add packages/coding-agent/CHANGELOG.md

  if ! git diff --quiet --diff-filter=U --; then
    echo '::error::Unresolved conflicts remain after replacing ci conflict files'
    return 1
  fi
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  if (( $# != 0 )); then
    echo 'usage: resolve-ci-squash-conflicts.sh' >&2
    exit 2
  fi
  mapfile -d '' -t conflicts < <(git diff --name-only --diff-filter=U -z)
  resolve_ci_squash_conflicts "${conflicts[@]}"
fi
