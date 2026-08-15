#!/usr/bin/env bash
set -euo pipefail

readonly STARTUP_BENCHMARK_CONFLICT_PATHS=(
  "packages/coding-agent/src/modes/interactive/interactive-mode.ts"
  "packages/coding-agent/test/tools-manager.test.ts"
)

resolve_startup_benchmark_squash_conflicts() {
  local -a conflicts=()
  if (( $# > 0 )); then conflicts=("$@"); fi

  if (( ${#conflicts[@]} != ${#STARTUP_BENCHMARK_CONFLICT_PATHS[@]} )); then
    printf '::error::Unexpected startup-benchmark squash conflicts:'
    if (( ${#conflicts[@]} > 0 )); then printf ' %q' "${conflicts[@]}"; fi
    printf '\n'
    return 1
  fi

  local index
  for index in "${!STARTUP_BENCHMARK_CONFLICT_PATHS[@]}"; do
    if [[ ${conflicts[index]} != "${STARTUP_BENCHMARK_CONFLICT_PATHS[index]}" ]]; then
      printf '::error::Unexpected startup-benchmark squash conflicts:'
      printf ' %q' "${conflicts[@]}"
      printf '\n'
      return 1
    fi
  done

  local interactive_mode=${STARTUP_BENCHMARK_CONFLICT_PATHS[0]}
  git checkout --ours -- "$interactive_mode"
  python - "$interactive_mode" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()

import_anchor = 'import { killTrackedDetachedChildren } from "../../utils/shell.ts";\n'
import_line = 'import { markStartupBenchmarkStage } from "../../utils/startup-benchmark.ts";\n'
if import_line not in text:
    if text.count(import_anchor) != 1:
        raise SystemExit("startup benchmark import anchor is missing or ambiguous")
    text = text.replace(import_anchor, import_anchor + import_line, 1)

stage_insertions = {
    "init-entered": (
        "\t\tif (this.isInitialized) return;\n",
        "\t\tif (this.isInitialized) return;\n\t\tmarkStartupBenchmarkStage(\"init-entered\");\n",
    ),
    "tui-started": (
        "\t\t// Start the UI before initializing extensions so session_start handlers can use interactive dialogs\n"
        "\t\tthis.ui.start();\n\t\tthis.isInitialized = true;\n",
        "\t\t// Start the UI before initializing extensions so session_start handlers can use interactive dialogs\n"
        "\t\tthis.ui.start();\n\t\tthis.isInitialized = true;\n"
        "\t\tmarkStartupBenchmarkStage(\"tui-started\");\n",
    ),
    "theme-applied": (
        "\t\tawait this.themeController.applyFromSettings();\n\n\t\t// Add header with keybindings from config (unless silenced)\n",
        "\t\tawait this.themeController.applyFromSettings();\n"
        "\t\tmarkStartupBenchmarkStage(\"theme-applied\");\n\n"
        "\t\t// Add header with keybindings from config (unless silenced)\n",
    ),
    "tools-ready": (
        "\t\tthis.fdPath = fdPath;\n\n\t\t// Enable the remaining input handlers only after managed-tool setup completes.\n",
        "\t\tthis.fdPath = fdPath;\n\t\tmarkStartupBenchmarkStage(\"tools-ready\");\n\n"
        "\t\t// Enable the remaining input handlers only after managed-tool setup completes.\n",
    ),
    "session-rebound": (
        "\t\t// Initialize extensions first so resources are shown before messages\n"
        "\t\tawait this.rebindCurrentSession();\n\n\t\t// Render initial messages AFTER showing loaded resources\n",
        "\t\t// Initialize extensions first so resources are shown before messages\n"
        "\t\tawait this.rebindCurrentSession();\n"
        "\t\tmarkStartupBenchmarkStage(\"session-rebound\");\n\n"
        "\t\t// Render initial messages AFTER showing loaded resources\n",
    ),
    "providers-counted": (
        "\t\t// Initialize available provider count for footer display\n"
        "\t\tawait this.updateAvailableProviderCount();\n\t}\n",
        "\t\t// Initialize available provider count for footer display\n"
        "\t\tawait this.updateAvailableProviderCount();\n"
        "\t\tmarkStartupBenchmarkStage(\"providers-counted\");\n\t}\n",
    ),
}
for stage, (anchor, replacement) in stage_insertions.items():
    line = f'\t\tmarkStartupBenchmarkStage("{stage}");\n'
    if line in text:
        continue
    if text.count(anchor) != 1:
        raise SystemExit(f"startup benchmark stage anchor is missing or ambiguous: {stage}")
    text = text.replace(anchor, replacement, 1)

path.write_text(text)
PY
  git add "$interactive_mode"

  local timeout_test=packages/coding-agent/test/tools-manager-timeout.test.ts
  git checkout --theirs -- packages/coding-agent/test/tools-manager.test.ts
  mv packages/coding-agent/test/tools-manager.test.ts "$timeout_test"
  git checkout --ours -- packages/coding-agent/test/tools-manager.test.ts
  git add packages/coding-agent/test/tools-manager.test.ts "$timeout_test"

  if ! git diff --quiet --diff-filter=U --; then
    echo '::error::Unresolved conflicts remain after applying startup-benchmark conflict staging'
    return 1
  fi
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  if (( $# != 0 )); then
    echo 'usage: resolve-startup-benchmark-squash-conflicts.sh' >&2
    exit 2
  fi
  mapfile -d '' -t conflicts < <(git diff --name-only --diff-filter=U -z)
  resolve_startup_benchmark_squash_conflicts "${conflicts[@]}"
fi
