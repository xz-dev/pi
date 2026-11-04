set -euo pipefail
# Fail closed unless this is the one diagnostic commit on the diag ref, with no credentials in the environment.
[[ "$GITHUB_EVENT_NAME" == workflow_dispatch ]]
[[ "$GITHUB_REF" == refs/heads/diag/env-tail44-exec ]]
[[ "$GITHUB_RUN_ATTEMPT" == 1 ]]
[[ "$(git rev-parse HEAD^)" == 39b2461c2fea2135460bd90f41444b740f1d5f72 ]]
[[ "$(git rev-parse 'HEAD^^{tree}')" == 16de02f3b05d98657bb88f44ca5dffaee2eabca4 ]]
expected=".github/diag-tail44-guard.sh .github/diag-tail44-probe.ts .github/workflows/npm-audit.yml packages/env/daemon/src/exec.rs packages/env/daemon/src/process.rs packages/env/daemon/src/pty.rs"
[[ "$(git diff-tree --no-commit-id --name-only -r HEAD | sort | xargs)" == "$expected" ]]
[[ -z "$(git status --porcelain=v1 --untracked-files=all)" ]]
# Names only, never values.
if env | cut -d= -f1 | grep -Eq '^(GITHUB_TOKEN|GH_TOKEN|ACTIONS_ID_TOKEN_REQUEST_TOKEN|ACTIONS_ID_TOKEN_REQUEST_URL|[A-Z0-9_]*API_KEY|[A-Z0-9_]*SECRET[A-Z0-9_]*)$'; then
  echo "credential-like environment name present"
  exit 1
fi
workflow=.github/workflows/npm-audit.yml
if grep -nE "secrets[.]|id-token|: *write|persist-credentials: *true" "$workflow"; then
  echo "workflow asks for secrets or write access"
  exit 1
fi
[[ "$(grep -c 'persist-credentials: false' "$workflow")" == 1 ]]
echo "diag-tail44-exec boundary ok: $(git rev-parse HEAD) on $(uname -sm), ${NUMBER_OF_PROCESSORS:-$(nproc)} CPUs"
