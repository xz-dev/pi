#!/usr/bin/env bash
# check-allow-model-catalog-drift.sh — run `npm run check`, tolerating only the
# documented "Known Pre-existing Failures" class from AGENTS.md: model-ID /
# model-catalog TS2345/TS7053 errors in packages/(ai|agent|coding-agent)/
# (test|examples), caused by models.dev renaming or retiring models faster
# than the test fixtures track. Those errors never relate to the change being
# validated and self-heal on the next upstream catalog regen.
#
# Anything else still fails: a failing non-tsc stage (biome, pinned-deps,
# shrinkwrap, …) produces no "error TS" lines and fails; any TS error outside
# the filtered class fails.
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

grep -vE '^packages/(ai|agent|coding-agent)/(test|examples)/.*error TS(2345|7053).*([Mm]odel|ModelId|ModelCatalog)|^packages/(ai|agent|coding-agent)/(test|examples)/.*error TS(2345|7053).*parameter of type '"'"'' "$ts_errors" >"$real_errors" || true
if [[ -s "$real_errors" ]]; then
	cat "$log"
	printf '::error::npm run check has errors outside the known model-catalog drift class\n' >&2
	exit 1
fi

printf '::warning::Ignoring known model-catalog drift errors (AGENTS.md known pre-existing failures):\n' >&2
cat "$ts_errors"
