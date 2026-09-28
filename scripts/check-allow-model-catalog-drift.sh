#!/usr/bin/env bash
# Run `npm run check`, tolerating only the documented model-catalog drift class
# from AGENTS.md. Live catalog changes can make model IDs disappear and can
# widen generated Model/ModelId types in downstream test fixtures.
set -uo pipefail

log="$(mktemp -t pi-check.XXXXXX)"
ts_errors="$(mktemp -t pi-check-ts.XXXXXX)"
real_errors="$(mktemp -t pi-check-real.XXXXXX)"
trap 'rm -f "$log" "$ts_errors" "$real_errors"' EXIT

if npm run check >"$log" 2>&1; then
	exit 0
fi

grep -E '^\S+\([0-9]+,[0-9]+\): error TS' "$log" >"$ts_errors" || true
if [[ ! -s "$ts_errors" ]]; then
	cat "$log"
	printf '::error::npm run check failed outside tsc (stage failure)\n' >&2
	exit 1
fi

is_model_catalog_drift() {
	local line="$1"
	case "$line" in
		packages/ai/test/*|packages/ai/examples/*|packages/agent/test/*|packages/agent/examples/*|packages/coding-agent/test/*|packages/coding-agent/examples/*) ;;
		*) return 1 ;;
	esac

	case "$line" in
		*"error TS2345:"*|*"error TS7053:"*|*"error TS2339:"*|*"error TS18046:"*) ;;
		*) return 1 ;;
	esac

	case "$line" in
		# A catalog-resolved model's compat type is the union of the compat types of
		# the APIs the live catalog currently offers, so any compat property can
		# disappear from it when models move between APIs.
		*ModelId*|*"Model<"*|*ModelCatalog*|*"error TS2339: Property '"*"' does not exist on type '"*Compat*|*"'model' is of type 'unknown'"*)
			return 0
		;;
		*"Argument of type '"*accounts/*|*"Argument of type '"*anthropic/*|*"Argument of type '"*claude-*|*"Argument of type '"*deepseek-*|*"Argument of type '"*gemini-*|*"Argument of type '"*glm-*|*"Argument of type '"*gpt-*|*"Argument of type '"*kimi-*|*"Argument of type '"*mimo-*|*"Argument of type '"*qwen-*|*"Argument of type '"*xai-*|*"Argument of type '"*zai-*|*"Argument of type '"*openai-*|*"Argument of type '"*google-*|*"Argument of type '"*minimax-*|*"Argument of type '"*moonshotai-*|*"Argument of type '"*opencode-*|*"Argument of type '"*fireworks-*|*"Argument of type '"*baseten-*)
			return 0
		;;
	esac
	return 1
}

: >"$real_errors"
while IFS= read -r line; do
	if ! is_model_catalog_drift "$line"; then
		printf '%s\n' "$line" >>"$real_errors"
	fi
done <"$ts_errors"

if [[ -s "$real_errors" ]]; then
	cat "$log"
	printf '::error::npm run check has errors outside the known model-catalog drift class\n' >&2
	exit 1
fi

printf '::warning::Ignoring known model-catalog drift errors (AGENTS.md known pre-existing failures):\n' >&2
cat "$ts_errors"
