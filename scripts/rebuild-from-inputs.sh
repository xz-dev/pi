#!/usr/bin/env bash
# rebuild-from-inputs.sh — authoritative replay of the upstream-sync patch order.
#
# One source of truth for the integration order and semantics. The CI workflow
# (.github/workflows/upstream-sync.yml "Rebuild main from upstream and squash
# branches") captures every input as a fixed full SHA right after its fetch
# step, clones its own source checkout into a fresh scratch target it owns,
# then runs this script there with those captured SHAs; operators run the same
# script with --source <repo> --target <fresh-path> for local diagnosis.
# Fetch/publication authority stays in the workflow — this script never
# fetches, pushes, dispatches, or mutates refs outside the scratch target it
# creates, and it never touches the source repository's refs, index, files, or
# worktrees.
#
# Usage:
#   scripts/rebuild-from-inputs.sh --source <repo> --target <new-path>
#                                  [--upstream <sha>] [--ci <sha>]
#                                  [--patch <name>=<sha>]...
#                                  [--base <name>=<sha>]...
#                                  [--diagnostic] [--stop-before <name>]
#   scripts/rebuild-from-inputs.sh --print-inputs          # default SHAs + order
#   scripts/rebuild-from-inputs.sh --print-marker          # marker commit message
#   scripts/rebuild-from-inputs.sh --check                 # workflow self-test
#
# Target contract (fail closed):
#   --target must be a path that does not exist yet. The script clones
#   --source into it itself and owns that checkout exclusively. Passing an
#   existing directory, a source-equal path, or the caller's own checkout is
#   rejected before any git mutation. The source is opened read-only: its
#   HEAD, refs, index, files, and linked worktrees are never modified.
#
# Modes:
#   --stop-before: run the sequence, stop (exit 0) immediately before applying
#     the named input (bare name: "ci", "esc-abort", ...). Steps already run
#     stay committed in the target, and the run records a distinct
#     "record upstream sync inputs (partial through <name>)" marker that never
#     matches the complete-vector skip key.
#   --print-inputs: print the recorded default input vector (ref name + fixed
#     full SHA + one-line subject) and exit. No git repo required.
#   --check: verify the workflow's fetch list and the recorded input block
#     name the same refs (used by CI to fail when the two drift).
#
# Invariants (fail closed on violation):
#   - unknown input names, unresolvable SHAs, missing required inputs,
#     existing/source/linked targets, unexpected conflict shapes, unresolved
#     conflicts, empty integrations, and whitespace damage all abort the
#     replay;
#   - inputs are frozen SHAs; no ref is read after capture, so mid-run remote
#     movement cannot change the replay;
#   - only a run that actually applies every fetched input emits the canonical
#     "record upstream sync inputs" marker; partial/prefix runs record their
#     own prefixed marker instead.
set -euo pipefail
ENTRYPOINT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/$(basename "${BASH_SOURCE[0]}")"

say() { printf '== %s\n' "$*" >&2; }
die() { printf '::error::%s\n' "$*" >&2; exit 1; }

# --- recorded default input vector -------------------------------------------
# Full fixed SHAs of the recorded input snapshot. Each entry: <name> <sha>
# where name is a bare patch name ("ci", "patch/<name>") and sha is a full
# commit object id that must exist in the local object database. The workflow
# passes its freshly captured SHAs explicitly; these recorded defaults are
# what local diagnosis uses and what --print-inputs exposes.
# ponytail: SHAs recorded as literal defaults; the workflow re-captures per run
# after fetch, so these go stale only between syncs.
read -r -d '' DEFAULT_INPUTS <<'EOF' || true
upstream/main 1a584a7a56eb5e7b4ff8ccbd46430f1533282eed
ci 5ce32cc3c61e33e233d359b0627ca0aa51709545
patch/contributor-approval e005a344660c3ad8b3aa86192c3a10f18a53a10d
patch/model-startup-refresh-barrier 9df4360c66f053219d93072fda108743b22913d5
patch/model-refresh-session-rebind 5db5e814a7f010800b40d1a7142682e59c0be6d7
patch/model-catalog-extension-refresh 465671288cfc16f8adb58e891f44964facd0e6c4
patch/bun-bytecode-entrypoint 72f9732aa2dacc279a225c00661566c000be92a4
patch/startup-benchmark-exit 97a37c792e125823f1111babef76d803aabd4b1c
patch/native-wrapper-release 405ccb72af50b1359a37d91231b7d6c07796b29e
patch/update-clean 2c14802c404849da1d308c9175edcd7413275633
patch/bundle-usage-claims f0eb0624cd605584558c18edd729bdd6de581989
patch/use-embedded-bun-package-manager 1a23a65f0d1cc83c77078e5d5c23810fd6c724a2
patch/git-package-storage 79f85e86f39ba1e3557318e39cccf9ae1d0ee046
patch/model-refresh-timeout 43fd5c94086a3deae7cb4113d6aa8bf08841575e
patch/agent-run-failure-seam ef1c9a295629bc786a43eba527f1184e1625d954
patch/managed-tool-executions eafd556e2b63a542eb381702892d951645f1627c
patch/esc-abort de575ef58ae9a97e3cda6104fbfb5bcd5b61fb58
patch/manual-retry eef3791ab8e9c758d4da1f3392f95e0198922404
patch/changelog-prerelease 3ea1afed328d8cf79cced1854a0a47455f97f0b9
patch/skill-overrides cd0314ef426c466550984eaba2f70ddec224907c
patch/retry-non-retryable-patterns 67b899b60d5227eeb7a60bc1b52bb1ff816b3252
patch/slow-hook-tui-only f088e90d175cfe2304124cc4d38b13abce985dc4
patch/session-tree-splice a522b4ca863f23e26643fe156215c444760b5612
patch/ws-cached-empty-delta 29c95ca8c46fa6866061dedc4f6054297d4549ac
patch/self-update-managed-by 24781b9788d416b8acae965dc37be44548d0857d
patch/google-toomany-toolcalls 8be79bbe2c647e9540f1eae290187cadc3b19b77
patch/model-selector-refresh-selection a2db8aa087910c08bd4fea83b75ec97fb7c2f3a5
patch/ai-drop-empty-messages 355b16c9522b30906562c7d7ca2813ed728e874d
patch/compaction-test-exclusion d9a0c2a0402ff83a6882b6ccceb9f6a6e11e5d59
EOF

# Explicit accumulated compat bases. These steps consume a recorded
# base..accumulated-tip pair instead of inferring tip^: later fixups on a
# patch tip must not silently shrink the replayed delta. Each entry:
#   <patch-name> <base-sha> <accumulated-ref-name> <default-tip-sha>
# The base is immutable recorded provenance. The accumulated tip is captured
# per run via --patch <accumulated-ref-name>=<sha>. A --base <name>=<sha>
# override records a different explicit base; no base is inferred from tip^.
# Recorded defaults are used only as a complete default vector. When the accumulated ref is the patch's own ref (its
# branch is already a linear accumulated stack), the entry names the patch
# itself. Later rebases/base changes require a new recorded vector here, not
# inference.
read -r -d '' COMPAT_RANGES <<'EOF' || true
model-refresh-session-rebind 4f2a4ff8d111697b22f4cb35519d1075fed432d5 model-refresh-session-rebind-on-accumulated d8776ddaccd494d73fd42d8984225f8feb553eb5
model-refresh-timeout a1d2c1054dc08007b16d40c8156250b2b7985c4e model-refresh-timeout 43fd5c94086a3deae7cb4113d6aa8bf08841575e
agent-run-failure-seam 13393639c27b44e1e909f71eb1a1c08f82d8118a agent-run-failure-seam-on-accumulated f565bc3eea39def63c6b5c2540b1eff226ef5e76
managed-tool-executions f565bc3eea39def63c6b5c2540b1eff226ef5e76 managed-tool-executions-on-accumulated e79c3248831c5ca1683281a21ad34b465a336074
esc-abort e79c3248831c5ca1683281a21ad34b465a336074 esc-abort-on-accumulated 2dd9c7188c899e28b6915f22d15a4bceeb936980
manual-retry 2dd9c7188c899e28b6915f22d15a4bceeb936980 manual-retry-on-accumulated de85ff1c46692b2891635a79f8f07f73fc143cf3
slow-hook-tui-only 1551e040801d3c041aa7bdb10b88855fc47f1609 slow-hook-on-accumulated d274cb156fe47522a3ddf385f3ddd7094e719894
EOF

print_inputs() {
	printf '%s\n' "$DEFAULT_INPUTS"
	printf '# compat ranges (explicit base..tip)\n'
	printf '%s\n' "$COMPAT_RANGES"
}

print_marker() {
	local subject="record upstream sync inputs"
	if [[ -n "$STOP_BEFORE" ]]; then
		subject="record upstream sync inputs (partial through $STOP_BEFORE)"
	elif ((DIAGNOSTIC)); then
		subject="record upstream sync inputs (diagnostic subset)"
	elif [[ "${APPLIED_ORDER[*]}" != "ci ${PATCH_ORDER[*]}" ]]; then
		die "complete marker requires the entire recorded application order"
	fi
	echo "$subject"
	echo
	echo "upstream/main $UPSTREAM_SHA"
	echo "origin/ci $CI_SHA"
	echo "applied-order ${APPLIED_ORDER[*]}"
	local p
	for p in "${APPLIED_ORDER[@]}"; do
		[[ "$p" == ci ]] && continue
		echo "origin/patch/$p ${INPUT_SHA[$p]}"
	done
	for p in "${APPLIED_ORDER[@]}"; do
		[[ -n "${APPLIED_RANGE[$p]:-}" ]] || continue
		echo "range/patch/$p ${APPLIED_RANGE[$p]}"
	done
}

check_mode() {
	# Workflow self-test: every ref this script consumes must be fetched by
	# the workflow and vice versa. The workflow's fetch list is the source of
	# truth; this checks the recorded default names against it.
	local workflow=".github/workflows/upstream-sync.yml"
	[[ -f "$workflow" ]] || { say "check: no $workflow (out of repo); skipping"; exit 0; }
	local missing=0 name ref
	while read -r name _; do
		case "$name" in
		upstream/main) ref=main; source=upstream ;;
		ci) ref=ci ;;
		patch/*) ref="patch/${name#patch/}" ;;
		esac
		[[ "$name" == upstream/main ]] && { grep -qE 'git fetch upstream main' "$workflow" || { say "check: workflow does not fetch upstream main"; missing=1; }; continue; }
		grep -qE "refs/heads/${ref}(:|\\\\)" "$workflow" || { say "check: workflow does not fetch $name"; missing=1; }
	done <<<"$DEFAULT_INPUTS"
	# Compat entries are well-formed and their accumulated tips are fetched
	# as patch/<accum-ref>; verify the workflow fetches each recorded ref.
	while read -r name base accum_ref tip; do
		[[ "$base" =~ ^[0-9a-f]{40}$ && "$tip" =~ ^[0-9a-f]{40}$ && -n "$accum_ref" ]] || \
			{ say "check: malformed compat range for $name"; missing=1; continue; }
		grep -qE "refs/heads/patch/${accum_ref}(:|\\\\)" "$workflow" || { say "check: workflow does not fetch compat ref patch/$accum_ref"; missing=1; }
	done <<<"$COMPAT_RANGES"
	# Reverse direction: every patch ref the workflow fetches must appear here
	# (as a recorded patch input or as a recorded compat accum ref).
	local fetched
	fetched="$(grep -o 'refs/heads/patch/[^:]*' "$workflow" | sed 's/refs\/heads\///')"
	for ref in $fetched; do
		local short="${ref#patch/}"
		grep -q "^$ref " <<<"$DEFAULT_INPUTS" && continue
		grep -q " $short " <<<"$COMPAT_RANGES" || { say "check: script has no recorded input for $ref"; missing=1; }
	done
	((missing == 0)) || die "check failed: workflow and script inputs drift"
	say "check ok: workflow fetch list and script inputs match"
	exit 0
}

# Expected application order. run_replay is the shared implementation;
# a complete marker is allowed only when its actual step trace matches this.
PATCH_ORDER=(
	contributor-approval
	model-startup-refresh-barrier
	model-refresh-session-rebind
	model-catalog-extension-refresh
	model-refresh-timeout
	bun-bytecode-entrypoint
	startup-benchmark-exit
	native-wrapper-release
	update-clean
	bundle-usage-claims
	use-embedded-bun-package-manager
	git-package-storage
	agent-run-failure-seam
	managed-tool-executions
	esc-abort
	manual-retry
	changelog-prerelease
	skill-overrides
	retry-non-retryable-patterns
	slow-hook-tui-only
	session-tree-splice
	ws-cached-empty-delta
	self-update-managed-by
	google-toomany-toolcalls
	model-selector-refresh-selection
	ai-drop-empty-messages
	compaction-test-exclusion
)

# --- argument parsing ---------------------------------------------------------

MODE="replay"
DIAGNOSTIC=0
STOP_BEFORE=""
SOURCE_REPO=""
TARGET_PATH=""
EXPLICIT_PATCHES=()
EXPLICIT_BASES=()
declare -A INPUT_SHA
declare -A COMPAT_BASE
declare -A COMPAT_TIP
declare -A COMPAT_REF
declare -A APPLIED_RANGE
APPLIED_ORDER=()
ACTIVE_ORDER=()
UPSTREAM_SHA=""
CI_SHA=""
cn=""
range=""
while (($# > 0)); do
	case "$1" in
	--print-inputs) MODE="print" ; shift ;;
	--print-marker) MODE="print-marker" ; shift ;;
	--check) MODE="check" ; shift ;;
	--diagnostic) DIAGNOSTIC=1 ; shift ;;
	--base)
		(($# >= 2)) && [[ "$2" == *=* ]] || die "--base requires name=sha"
		COMPAT_BASE["${2%%=*}"]="${2#*=}"
		EXPLICIT_BASES+=("${2%%=*}")
		shift 2
		;;
	--stop-before)
		(($# >= 2)) || die "--stop-before requires a value"
		STOP_BEFORE="$2"
		shift 2
		;;
	--source)
		(($# >= 2)) || die "--source requires a value"
		SOURCE_REPO="$2"
		shift 2
		;;
	--target)
		(($# >= 2)) || die "--target requires a value"
		TARGET_PATH="$2"
		shift 2
		;;
	--upstream)
		(($# >= 2)) || die "--upstream requires a value"
		UPSTREAM_SHA="$2"
		shift 2
		;;
	--ci)
		(($# >= 2)) || die "--ci requires a value"
		CI_SHA="$2"
		shift 2
		;;
	--patch)
		(($# >= 2)) || die "--patch requires name=sha"
		[[ "$2" == *=* ]] || die "--patch requires name=sha"
		INPUT_SHA["${2%%=*}"]="${2#*=}"
		EXPLICIT_PATCHES+=("${2%%=*}")
		shift 2
		;;
	--help|-h)
		sed -n '2,40p' "$0" >&2
		exit 0
		;;
	*)
		die "unknown argument: $1"
		;;
	esac
done

if [[ "$MODE" == "print" ]]; then
	print_inputs
	exit 0
fi

# Load recorded defaults for any input not provided explicitly. Refs are
# resolved exactly once, before any mutation; every step below consumes only
# these frozen SHAs.
if [[ -z "$UPSTREAM_SHA" ]]; then
	UPSTREAM_SHA="$(awk '$1=="upstream/main"{print $2}' <<<"$DEFAULT_INPUTS")"
	[[ -n "$UPSTREAM_SHA" ]] || die "no recorded default for upstream/main"
fi
if [[ -z "$CI_SHA" ]]; then
	CI_SHA="$(awk '$1=="ci"{print $2}' <<<"$DEFAULT_INPUTS")"
	[[ -n "$CI_SHA" ]] || die "no recorded default for ci"
fi
local_name=""
while read -r name sha; do
	case "$name" in
	upstream/main | ci) continue ;;
	patch/*)
		local_name="${name#patch/}"
		[[ -n "${INPUT_SHA[$local_name]:-}" ]] || INPUT_SHA[$local_name]="$sha"
		;;
	esac
done <<<"$DEFAULT_INPUTS"
while read -r name base accum_ref tip; do
	[[ -n "${COMPAT_BASE[$name]:-}" ]] || COMPAT_BASE[$name]="$base"
	COMPAT_REF[$name]="$accum_ref"
	# The accumulated tip resolves from the explicitly passed
	# patch/<accum-ref> input when present, else the recorded default.
	COMPAT_TIP[$name]="${INPUT_SHA[$accum_ref]:-$tip}"
done <<<"$COMPAT_RANGES"
# A recorded compat pair only activates when its patch input is present; keep
# the map aligned so provenance never names a pair that cannot apply.
for name in "${!COMPAT_BASE[@]}"; do
	[[ -n "${INPUT_SHA[$name]:-}" ]] || unset "COMPAT_BASE[$name]" "COMPAT_TIP[$name]" "COMPAT_REF[$name]"
done
select_active() {
	ACTIVE_ORDER=()
	if ((DIAGNOSTIC == 0)); then
		ACTIVE_ORDER=("${PATCH_ORDER[@]}")
		return
	fi
	local p e
	for p in "${PATCH_ORDER[@]}"; do
		for e in "${EXPLICIT_PATCHES[@]}"; do
			if [[ "$e" == "$p" ]]; then
				ACTIVE_ORDER+=("$p")
				break
			fi
		done
	done
}

validate_inputs() {
	local p q known
	for p in "${EXPLICIT_PATCHES[@]}"; do
		known=0
		for q in "${PATCH_ORDER[@]}"; do [[ "$p" == "$q" ]] && known=1; done
		for q in "${!COMPAT_REF[@]}"; do [[ "$p" == "${COMPAT_REF[$q]}" ]] && known=1; done
		((known)) || die "unknown patch input name: $p"
		[[ "${INPUT_SHA[$p]}" =~ ^[0-9a-f]{40}$ ]] || die "patch/$p input is not a full fixed SHA"
	done
	select_active
	if ((DIAGNOSTIC)); then
		((${#ACTIVE_ORDER[@]} > 0)) || die "diagnostic replay requires an explicit patch step"
	elif ((${#EXPLICIT_PATCHES[@]} > 0)); then
		# Overrides in a full run must describe a complete vector. A caller
		# wanting a subset must opt into a non-publishable diagnostic run.
		for p in "${PATCH_ORDER[@]}" "${COMPAT_REF[@]}"; do
			[[ " ${EXPLICIT_PATCHES[*]} " == *" $p "* ]] || die "missing explicit input patch/$p in full vector"
		done
	fi
	for p in "${EXPLICIT_BASES[@]}"; do
		[[ -n "${COMPAT_REF[$p]:-}" ]] || die "unknown compat base name: $p"
		[[ " ${ACTIVE_ORDER[*]} " == *" $p "* ]] || die "compat base $p requires its owning patch step"
		[[ "${COMPAT_BASE[$p]}" =~ ^[0-9a-f]{40}$ ]] || die "compat base $p is not a full fixed SHA"
	done
	for p in "${!COMPAT_REF[@]}"; do
		q="${COMPAT_REF[$p]}"
		if [[ " ${EXPLICIT_PATCHES[*]} " == *" $q "* ]]; then
			[[ " ${ACTIVE_ORDER[*]} " == *" $p "* ]] || die "compat input $q requires owning patch $p"
		fi
	done
	if [[ -n "$STOP_BEFORE" && "$STOP_BEFORE" != ci ]]; then
		[[ " ${ACTIVE_ORDER[*]} " == *" $STOP_BEFORE "* ]] || die "unknown --stop-before step or step not selected: $STOP_BEFORE"
	fi
}

planned_range() {
	local name="$1" base_name
	if [[ -n "${COMPAT_BASE[$name]:-}" ]]; then
		printf '%s..%s' "${COMPAT_BASE[$name]}" "${COMPAT_TIP[$name]}"
		return
	fi
	case "$name" in
	esc-abort|manual-retry) base_name=agent-run-failure-seam ;;
	update-clean) base_name=native-wrapper-release ;;
	bundle-usage-claims) base_name=update-clean ;;
	git-package-storage) base_name=use-embedded-bun-package-manager ;;
	session-tree-splice) base_name=slow-hook-tui-only ;;
	*) return 0 ;;
	esac
	printf '%s..%s' "${INPUT_SHA[$base_name]}" "${INPUT_SHA[$name]}"
}

if [[ "$MODE" == "print-marker" ]]; then
	validate_inputs
	APPLIED_ORDER=()
	APPLIED_RANGE=()
	if [[ "$STOP_BEFORE" != ci ]]; then
		APPLIED_ORDER=(ci)
		for p in "${ACTIVE_ORDER[@]}"; do
			[[ -n "$STOP_BEFORE" && "$STOP_BEFORE" == "$p" ]] && break
			APPLIED_ORDER+=("$p")
			range="$(planned_range "$p")"
			[[ -z "$range" ]] || APPLIED_RANGE[$p]="$range"
		done
	fi
	print_marker
	exit 0
fi

label_of() {
	# Canonical git label for a recorded input name: "origin/ci" or
	# "origin/patch/<name>". Merging against this label (not the raw SHA) keeps
	# conflict markers identical to the CI workflow's, so the resolvers'
	# fail-closed shape checks match exactly.
	if [[ "$1" == ci ]]; then
		printf 'ci'
	else
		printf 'patch/%s' "$1"
	fi
}

active() {
	# True when the named input is part of this run's active order.
	local p
	for p in "${ACTIVE_ORDER[@]}"; do
		[[ "$p" == "$1" ]] && return 0
	done
	return 1
}

sha_of() {
	local sha="$1" what="$2"
	[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "$what input is not a full fixed SHA: $sha"
	git cat-file -t "$sha" >/dev/null 2>&1 || die "$what input object does not exist locally: $sha"
	[[ "$(git cat-file -t "$sha")" == commit ]] || die "$what input is not a commit: $sha"
}

stop_before() {
	if [[ -n "$STOP_BEFORE" && "$STOP_BEFORE" == "$1" ]]; then
		say "stop before $1"
		commit_input_marker
		exit 0
	fi
}

commit_input_marker() {
	# Record the exact input vector as a final (empty) commit so a successful
	# snapshot is reproducible from its own history. Partial runs emit a
	# prefixed marker that cannot collide with the complete-vector key.
	local marker
	marker="$(mktemp "${TMPDIR:-/tmp}/upstream-sync-inputs-message.XXXXXX")"
	print_marker >"$marker"
	if [[ "$(git show -s --format=%B HEAD)" == "$(cat "$marker")" ]]; then
		say "input marker already recorded at HEAD"
	else
		git commit --allow-empty -F "$marker"
	fi
	rm -f "$marker"
}

# Guard helpers -------------------------------------------------------------

# Resolver/helper files this script consumes, extracted with git archive from
# the recorded CI_SHA (never a worktree overlay, whose bytes could differ from
# the frozen input).
HELPERS=(
	rebuild-from-inputs.sh
	union-contributor-approvals.py
	resolve-model-catalog-squash-conflicts.py
	resolve-model-refresh-timeout-conflicts.py
	resolve-embedded-bun-squash-conflicts.py
	resolve-managed-tool-executions-conflicts.py
	resolve-esc-abort-conflicts.py
	resolve-slow-hook-conflicts.py
	resolve-session-tree-splice-conflicts.py
)

ensure_no_conflicts() {
	local msg="$1"
	if ! git diff --quiet --diff-filter=U --; then
		die "Unresolved conflicts remain after $msg"
	fi
}

ensure_not_empty() {
	local msg="$1"
	if git diff --cached --quiet; then
		die "Empty patch integration for $msg"
	fi
}

ensure_conflicts_are() {
	# ensure_conflicts_are <msg> <expected-file>...
	# Fail closed unless the conflicted file set is exactly the expected files.
	local msg="$1"
	shift
	mapfile -d '' -t actual < <(git diff --name-only --diff-filter=U -z)
	if (( ${#actual[@]} != $# )); then
		printf '::error::Unexpected %s conflicts:' "$msg" >&2
		printf ' %q' "${actual[@]}" >&2
		printf '\n' >&2
		die "$msg expected conflict set: $*"
	fi
	local expected
	for expected in "$@"; do
		[[ " ${actual[*]} " == *" $expected "* ]] || die "Unexpected $msg conflict set: ${actual[*]}"
	done
}

verify_staged() {
	# Whitespace damage guard on the staged integration.
	git diff --cached --check
}

commit_step() {
	# $1 is the full merge message, e.g. "merge patch/esc-abort branch".
	git commit -m "$1"
	APPLIED_ORDER+=("$CURRENT_STEP")
}

# Step helpers ---------------------------------------------------------------

merge_squash() {
	# merge_squash <name> <msg> [flags]
	local name="$1" msg="$2"
	local flags="${3:-}"
	stop_before "$name"
	if ! git merge --squash "origin/$(label_of "$name")"; then
		if [[ "$flags" == *"readme-ok"* ]]; then
			# ci's overlay deletes publish-model-catalog.yml (the fork ships its own
			# publish-github-release.yml); when upstream touches that file it
			# resurfaces as a modify/delete conflict — keep ci's deletion.
			local ci_conflicts
			mapfile -t ci_conflicts < <(git diff --name-only --diff-filter=U)
			for f in "${ci_conflicts[@]}"; do
				case "$f" in
				README.md|.github/workflows/publish-model-catalog.yml) ;;
				*) die "Unexpected $msg squash conflict: $f" ;;
				esac
			done
			if git diff --name-only --diff-filter=U | grep -qx 'README.md'; then
				git checkout --theirs -- README.md
				git add README.md
			fi
			if git diff --name-only --diff-filter=U | grep -qx '.github/workflows/publish-model-catalog.yml'; then
				git rm -f .github/workflows/publish-model-catalog.yml
			fi
		else
			die "Unexpected $msg squash conflict"
		fi
	fi
	ensure_no_conflicts "$msg"
	ensure_not_empty "$msg"
	if [[ "$flags" != *"skip-check"* ]]; then
		verify_staged
	fi
	commit_step "$msg"
}

merge_squash_resolver() {
	# merge_squash_resolver <name> <msg> <resolver> [<expected-conflict-file>...]
	# The resolver runs only when the merge conflicts, and only after the
	# conflict set matches the expected files exactly (when any are declared).
	# Resolvers themselves fail closed on unexpected content shapes.
	local name="$1" msg="$2" resolver="$3"
	shift 3
	stop_before "$name"
	if ! git merge --squash "origin/$(label_of "$name")"; then
		if (($# > 0)); then
			ensure_conflicts_are "$msg" "$@"
		fi
		if [[ "$resolver" == *.py ]]; then
			python3 "$HELPER_DIR/$resolver"
		else
			bash "$HELPER_DIR/$resolver"
		fi
	fi
	ensure_no_conflicts "$msg"
	ensure_not_empty "$msg"
	verify_staged
	commit_step "$msg"
}

apply_range() {
	# apply_range <name> <msg> <base-sha> <tip-sha> [<resolver> [<expected-file>...]]
	# 3-way apply of the explicit base..tip diff. Empty integration, conflicts,
	# and whitespace damage fail closed. Optional resolver runs only on the
	# exact expected conflict shape.
	local name="$1" msg="$2" base="$3" tip="$4"
	shift 4
	stop_before "$name"
	git diff --binary "$base" "$tip" -- >"$TMPDIR_WORK/$name.patch"
	if ! git apply --3way --index "$TMPDIR_WORK/$name.patch"; then
		if (($# > 0)); then
			local resolver="$1"
			shift
			if (($# > 0)); then
				ensure_conflicts_are "$msg" "$@"
			fi
			if [[ "$resolver" == *.py ]]; then
				python3 "$HELPER_DIR/$resolver"
			else
				bash "$HELPER_DIR/$resolver"
			fi
		else
			die "Failed to apply $msg compat diff"
		fi
	fi
	ensure_no_conflicts "$msg"
	ensure_not_empty "$msg"
	verify_staged
	CURRENT_STEP="$name"
	commit_step "$msg"
	APPLIED_RANGE[$name]="$base..$tip"
}

apply_compat_range() {
	# apply_compat_range <name> <msg> [<resolver> [<expected-file>...]]
	# Applies the recorded explicit base..accumulated-tip compat pair for
	# <name>. The base is recorded provenance; the tip is the captured
	# -on-accumulated ref SHA. Never tip^.
	local name="$1" msg="$2"
	shift 2
	local base="${COMPAT_BASE[$name]:-}" tip="${COMPAT_TIP[$name]:-}"
	[[ -n "$base" && -n "$tip" ]] || die "$msg requires a recorded base..tip compat pair"
	sha_of "$base" "$msg compat base"
	sha_of "$tip" "$msg compat tip"
	git merge-base --is-ancestor "$base" "$tip" || die "$msg compat tip must descend from its recorded base"
	case "$name" in
	slow-hook-tui-only)
		git merge-base --is-ancestor "${INPUT_SHA[$name]}" "$tip" ||
			die "$msg compat does not contain selected source patch/$name"
		;;
	agent-run-failure-seam|managed-tool-executions|esc-abort|manual-retry)
		local dependency
		for dependency in agent-run-failure-seam managed-tool-executions esc-abort manual-retry; do
			if active "$dependency"; then
				git merge-base --is-ancestor "${INPUT_SHA[$dependency]}" "$tip" ||
					die "$msg compat does not contain selected source patch/$dependency"
			fi
			[[ "$dependency" == "$name" ]] && break
		done
		;;
	esac
	# The compat tip is the accumulated pre-image commit carrying the patch's
	# semantics on top of the accumulated tree; the patch's own tip is recorded
	# in the marker for provenance but is not itself applied.
	apply_range "$name" "$msg" "$base" "$tip" "$@"
}

cherry_pick_range() {
	# cherry_pick_range <name> <msg> <base-patch-name> — applies
	# base..name as a linear descendant range.
	local name="$1" msg="$2" base_name="$3"
	local base="${INPUT_SHA[$base_name]}" tip="${INPUT_SHA[$name]}"
	stop_before "$name"
	git merge-base --is-ancestor "$base" "$tip" || die "$msg must descend from patch/$base_name"
	[[ -z "$(git rev-list --min-parents=2 "$base..$tip")" ]] || die "$msg range must be linear"
	if ! git cherry-pick --no-commit "origin/patch/$base_name..origin/patch/$name"; then
		die "Failed to apply $msg descendant range"
	fi
	ensure_no_conflicts "$msg"
	ensure_not_empty "$msg"
	verify_staged
	commit_step "$msg"
	APPLIED_RANGE[$name]="$base..$tip"
}

require_ancestor() {
	# require_ancestor <ancestor-patch-name> <descendant-patch-name>
	# Fails closed when either input is missing (the descendant guard must not
	# silently pass because an ancestor was not provided).
	local ancestor="${INPUT_SHA[$1]:-}" descendant="${INPUT_SHA[$2]:-}"
	[[ -n "$ancestor" ]] || die "patch/$2 guard requires patch/$1 input"
	git merge-base --is-ancestor "$ancestor" "$descendant" ||
		die "patch/$2 must descend from patch/$1"
}

prepare_target() {
	# Fresh standalone scratch target owned by this script. The source repo is
	# opened read-only (object donor only); the target must be a path that
	# does not exist yet so no caller checkout, linked worktree, or shared-ref
	# store is ever mutated.
	local git_override
	for git_override in GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE GIT_OBJECT_DIRECTORY; do
		[[ -z "${!git_override:-}" ]] || die "repository override variable $git_override must be unset for isolated replay"
	done
	[[ -n "$SOURCE_REPO" ]] || die "--source <repo> is required; this script never replays into the caller's checkout"
	[[ -n "$TARGET_PATH" ]] || die "--target <new-path> is required; the script creates and owns it"
	[[ -d "$SOURCE_REPO/.git" || -f "$SOURCE_REPO/.git" || -d "$SOURCE_REPO/objects" ]] || \
		die "--source is not a git repository: $SOURCE_REPO"
	local source_real target_parent target_real
	source_real="$(cd "$SOURCE_REPO" && pwd -P)"
	# Reject an existing target outright: anything already there is either a
	# caller checkout or leftover state the script does not own.
	[[ ! -e "$TARGET_PATH" && ! -L "$TARGET_PATH" ]] || die "--target already exists: $TARGET_PATH (must be a fresh path the script creates)"
	target_parent="$(dirname "$TARGET_PATH")"
	[[ -d "$target_parent" ]] || die "--target parent does not exist: $target_parent"
	target_real="$(cd "$target_parent" && pwd -P)/$(basename "$TARGET_PATH")"
	local protected entry
	protected="$(git -C "$source_real" rev-parse --path-format=absolute --git-common-dir)"
	protected="$(cd "$protected" && pwd -P)"
	case "$target_real" in
	"$source_real"|"$source_real"/*|"$protected"|"$protected"/*)
		die "--target must be outside the source repository and its git storage" ;;
	esac
	while IFS= read -r -d '' entry; do
		[[ "$entry" == 'worktree '* ]] || continue
		protected="${entry#worktree }"
		case "$target_real" in "$protected"|"$protected"/*)
			die "--target must be outside every source worktree" ;;
		esac
	done < <(git -C "$source_real" worktree list --porcelain -z)
	SOURCE_REPO="$source_real"
	TARGET_PATH="$target_real"
	# Clone via the source's object store: --no-local transfers objects, and a
	# follow-up fetch of the source's remote-tracking refs imports patch tips
	# that live only under refs/remotes/origin/* (exactly what the workflow
	# fetches). Both reads leave the source fully untouched.
	git clone --no-local --no-hardlinks "$SOURCE_REPO" "$TARGET_PATH" >/dev/null || \
		die "failed to clone $SOURCE_REPO into fresh target $TARGET_PATH"
	cd "$TARGET_PATH"
	git fetch --quiet "$SOURCE_REPO" \
		'+refs/remotes/origin/*:refs/remotes/source/*' \
		'+refs/remotes/upstream/*:refs/remotes/upstream/*' \
		'+refs/heads/*:refs/remotes/src/*' 2>/dev/null || true
	git config user.name "${GIT_AUTHOR_NAME:-github-actions[bot]}"
	git config user.email "${GIT_AUTHOR_EMAIL:-41898282+github-actions[bot]@users.noreply.github.com}"
	git config commit.gpgsign false
	# Detach the scratch target from the source's remote-tracking refs: the
	# replay writes its own refs/remotes/origin/* from frozen SHAs and must
	# never resolve anything back through the source's remote state.
	git remote remove origin 2>/dev/null || true
	for ref in $(git for-each-ref --format='%(refname)' refs/remotes/origin/); do
		git update-ref -d "$ref"
	done
	# The clone's initial branch points at the source's HEAD content; the
	# replay resets to upstream and builds on an explicit rebuilt branch.
}

run_replay() {
	validate_inputs
	local p
	prepare_target

	# The selected ci input must actually carry every helper this replay
	# executes; extract them from the immutable CI_SHA object, never a
	# worktree overlay (which could carry uncommitted edits or stale
	# generated-main bytes). A dirty source worktree is irrelevant: the
	# recorded commit bytes are what run.
	TMPDIR_WORK="$(mktemp -d "${TMPDIR:-/tmp}/rebuild-from-inputs.XXXXXX")"
	# ponytail: per-run temp dir never cleaned on failure; keeps conflict
	# evidence for diagnosis. /tmp cleaners reap it.
	HELPER_DIR="$TMPDIR_WORK/helpers"
	mkdir -p "$HELPER_DIR"
	if ! git archive "$CI_SHA" scripts/ >"$TMPDIR_WORK/ci-scripts.tar" 2>/dev/null; then
		die "ci input $CI_SHA carries no scripts/ helpers"
	fi
	tar -xf "$TMPDIR_WORK/ci-scripts.tar" -C "$TMPDIR_WORK"
	for helper in "${HELPERS[@]}"; do
		[[ -f "$TMPDIR_WORK/scripts/$helper" ]] || die "ci input $CI_SHA lacks helper scripts/$helper"
		cp "$TMPDIR_WORK/scripts/$helper" "$HELPER_DIR/$helper"
	done
	cmp -s "$ENTRYPOINT" "$HELPER_DIR/rebuild-from-inputs.sh" || die "running replay driver differs from frozen ci input"

	# Only --diagnostic allows an explicitly selected, non-publishable subset.
	# Full runs require the entire vector, whether defaulted or supplied.
	select_active
	for p in "${EXPLICIT_PATCHES[@]}"; do
		sha_of "${INPUT_SHA[$p]}" "patch/$p"
	done
	sha_of "$UPSTREAM_SHA" upstream/main
	sha_of "$CI_SHA" ci
	# Every active input must resolve locally. In the default full-vector run
	# this is what makes a missing recorded input fail closed instead of
	# silently shrinking the replay; in an explicit-subset run it rechecks
	# the named inputs.
	for p in "${ACTIVE_ORDER[@]}"; do
		sha_of "${INPUT_SHA[$p]:-}" "patch/$p"
	done

	say "replay inputs (frozen):"
	say "  upstream/main $UPSTREAM_SHA"
	say "  origin/ci $CI_SHA"
	for p in "${ACTIVE_ORDER[@]}"; do say "  origin/patch/$p ${INPUT_SHA[$p]}"; done

	# Materialize the frozen inputs as origin/* remote-tracking refs inside
	# the owned scratch target so conflict labels match the CI workflow's
	# exactly (e.g. ">>>>>>> origin/patch/esc-abort"). These are local refs
	# created from the frozen SHAs; the script never fetches, and it never
	# touches the source repository's refs.
	git update-ref refs/remotes/origin/ci "$CI_SHA"
	for p in "${ACTIVE_ORDER[@]}"; do
		git update-ref "refs/remotes/origin/patch/$p" "${INPUT_SHA[$p]}"
	done

	# Upstream-maintained changelogs move every release cycle, so patch
	# branches must never carry packages/*/CHANGELOG.md hunks. Fail before
	# merging anything.
	local offender base ref
	local offenders=()
	for p in "${ACTIVE_ORDER[@]}"; do
		ref="${INPUT_SHA[$p]}"
		base="$(git merge-base "$UPSTREAM_SHA" "$ref")"
		if [[ -n "$(git diff --name-only "$base..$ref" -- 'packages/*/CHANGELOG.md')" ]]; then
			offenders+=("patch/$p")
		fi
	done
	if (( ${#offenders[@]} )); then
		printf '::error::%s modifies an upstream-maintained packages/*/CHANGELOG.md; keep downstream notes in README/MAINTAIN on ci\n' "${offenders[*]}" >&2
		exit 1
	fi

	# --- begin replay: reset the owned scratch target to upstream ---
	git reset --hard "$UPSTREAM_SHA"
	git checkout -q -B rebuilt-main "$UPSTREAM_SHA"

	# 1 ci — README.md is the only tolerated squash conflict (fork README is a
	# full rewrite maintained on ci).
	CURRENT_STEP=ci
	merge_squash ci "merge ci branch" readme-ok,skip-check

	# 2 contributor-approval — deterministic additive union, not a squash.
	if [[ -v INPUT_SHA[contributor-approval] ]] && active contributor-approval; then
		CURRENT_STEP=contributor-approval
		stop_before contributor-approval
		git show "$UPSTREAM_SHA":.github/APPROVED_CONTRIBUTORS >"$TMPDIR_WORK/up-contrib"
		git show "${INPUT_SHA[contributor-approval]}":.github/APPROVED_CONTRIBUTORS >"$TMPDIR_WORK/patch-contrib"
		python3 "$HELPER_DIR/union-contributor-approvals.py" \
			--current "$TMPDIR_WORK/up-contrib" \
			--patch "$TMPDIR_WORK/patch-contrib" \
			--output .github/APPROVED_CONTRIBUTORS
		if git diff --quiet -- .github/APPROVED_CONTRIBUTORS; then
			say "contributor approval union already complete"
			APPLIED_ORDER+=(contributor-approval)
		else
			test "$(git diff --name-only)" = .github/APPROVED_CONTRIBUTORS
			git add .github/APPROVED_CONTRIBUTORS
			verify_staged
			commit_step "merge patch/contributor-approval branch"
		fi
	fi

	# 3 model-startup-refresh-barrier
	if active model-startup-refresh-barrier; then
		CURRENT_STEP=model-startup-refresh-barrier
		merge_squash model-startup-refresh-barrier "merge patch/model-startup-refresh-barrier branch"
	fi

	# 4 model-refresh-session-rebind — explicit recorded compat base..tip.
	if active model-refresh-session-rebind; then
		apply_compat_range model-refresh-session-rebind "merge patch/model-refresh-session-rebind branch"
		agent_session=packages/coding-agent/src/core/agent-session.ts
		grep -Fq 'private _cacheWarmer?:' "$agent_session"
		grep -Fq 'private _unsubscribeModelsChanged: () => void;' "$agent_session"
		grep -Fq 'this._modelRuntime.onModelsChanged(() => this._refreshModelsFromRuntime())' "$agent_session"
		if grep -Fq '_refreshCurrentModelFromRegistry' "$agent_session"; then
			die "Stale _refreshCurrentModelFromRegistry reference remains"
		fi
	fi

	# 5 model-catalog-extension-refresh — upstream v0.87.1 doc refresh makes
	# README + packages.md + usage.md conflict; resolver takes upstream's side
	# (patch code still applies cleanly and owns the feature).
	if active model-catalog-extension-refresh; then
		CURRENT_STEP=model-catalog-extension-refresh
		merge_squash_resolver model-catalog-extension-refresh "merge patch/model-catalog-extension-refresh branch" \
			resolve-model-catalog-squash-conflicts.py \
			packages/coding-agent/README.md \
			packages/coding-agent/docs/packages.md \
			packages/coding-agent/docs/usage.md
	fi

	# 6 model-refresh-timeout — explicit recorded compat base..tip, kept
	# immediately after the model-catalog refresh it builds on. Upstream's doc
	# refresh moved its settings.md anchor; resolver re-appends the row to the
	# new Network-and-retries table.
	if active model-refresh-timeout; then
		apply_compat_range model-refresh-timeout "merge patch/model-refresh-timeout branch" \
			resolve-model-refresh-timeout-conflicts.py \
			packages/coding-agent/docs/settings.md
	fi

	# 7 bun-bytecode-entrypoint
	if active bun-bytecode-entrypoint; then
		CURRENT_STEP=bun-bytecode-entrypoint
		merge_squash bun-bytecode-entrypoint "merge patch/bun-bytecode-entrypoint branch"
	fi

	# 8 startup-benchmark-exit
	if active startup-benchmark-exit; then
		CURRENT_STEP=startup-benchmark-exit
		merge_squash startup-benchmark-exit "merge patch/startup-benchmark-exit branch"
	fi

	# 9 native-wrapper-release
	if active native-wrapper-release; then
		CURRENT_STEP=native-wrapper-release
		merge_squash native-wrapper-release "merge patch/native-wrapper-release branch"
	fi

	# 10-11 linear descendant ranges
	if active update-clean; then
		CURRENT_STEP=update-clean
		cherry_pick_range update-clean "merge patch/update-clean branch" native-wrapper-release
	fi
	if active bundle-usage-claims; then
		CURRENT_STEP=bundle-usage-claims
		cherry_pick_range bundle-usage-claims "merge patch/bundle-usage-claims branch" update-clean
	fi

	# 12 use-embedded-bun-package-manager — config.ts metadata + upstream's
	# doc refresh moved the patch's packages.md/settings.md sections.
	if active use-embedded-bun-package-manager; then
		CURRENT_STEP=use-embedded-bun-package-manager
		merge_squash_resolver use-embedded-bun-package-manager "merge patch/use-embedded-bun-package-manager branch" \
			resolve-embedded-bun-squash-conflicts.py \
			packages/coding-agent/docs/packages.md \
			packages/coding-agent/docs/settings.md \
			packages/coding-agent/src/config.ts \
			packages/coding-agent/src/core/package-manager.ts \
			packages/coding-agent/test/package-manager.test.ts
	fi

	# 13 git-package-storage — descendant range. Its docs/packages.md hunk
	# conflicts against the embedded-Bun section we just appended; resolve
	# that file by taking the accumulated side, keeping the new source
	# unchanged (upstream's rewritten doc does not cover these behaviors).
	if active git-package-storage; then
		CURRENT_STEP=git-package-storage
		stop_before git-package-storage
		local base="${INPUT_SHA[use-embedded-bun-package-manager]}" tip="${INPUT_SHA[git-package-storage]}"
		git merge-base --is-ancestor "$base" "$tip" || die "merge patch/git-package-storage branch must descend from patch/use-embedded-bun-package-manager"
		[[ -z "$(git rev-list --min-parents=2 "$base..$tip")" ]] || die "merge patch/git-package-storage branch range must be linear"
		if ! git cherry-pick --no-commit "origin/patch/use-embedded-bun-package-manager..origin/patch/git-package-storage"; then
			ensure_conflicts_are "merge patch/git-package-storage branch" \
				packages/coding-agent/docs/packages.md \
				packages/coding-agent/src/core/package-manager.ts \
				packages/coding-agent/test/package-manager.test.ts
			# Upstream's packages.md was rewritten wholesale; the patch range's
			# doc version predates that rewrite, so taking --theirs would revert
			# upstream's doc refresh. Restore upstream's file, then re-append
			# only the storage-specific git source notes.
			git checkout --ours -- packages/coding-agent/docs/packages.md
			python3 - <<'PY'
from pathlib import Path

path = Path("packages/coding-agent/docs/packages.md")
text = path.read_text()
anchor = "Versioned npm specifications are pinned. Git tags and commits are also pinned; package updates reconcile the checkout but do not move a configured ref.\n"
addition = """
New git installs use depth-one, single-branch clones without unrelated tags. Branches and tags are selected during cloning; full commit IDs are fetched directly without cloning another branch. Abbreviated commit IDs require a full clone for local resolution; use a full commit ID to avoid downloading history.

Git updates fetch only the selected ref at depth one and discard stale commit-graph caches. Existing refs, reflogs, and stored objects are not automatically deleted; making an old clone shallow does not by itself reclaim all of its history.

When reconciliation changes the checkout, Pi resets and cleans the clone, then installs dependencies if `package.json` exists. Default npm uses `install --omit=dev --legacy-peer-deps`; embedded Bun uses `install --omit=dev --omit=peer`. This avoids installing Pi-provided host APIs again through peer dependencies. Explicit `npmCommand` commands use plain `install`. A current checkout with missing runtime dependencies is repaired without cleaning it; existing extra dependencies are not automatically pruned.
"""
if text.count(anchor) != 1:
    raise SystemExit("unexpected packages.md git-source anchor")
text = text.replace(anchor, anchor + addition, 1)
path.write_text(text)
PY
			git add packages/coding-agent/docs/packages.md
			# package-manager.ts: upstream's getGitDependencyInstallArgs switch is
			# already in place from the embedded-bun merge; the cherry-picked
			# patch re-adds its old ternary tail. Keep ours (switch + gate).
			python3 - <<'PY'
from pathlib import Path

path = Path("packages/coding-agent/src/core/package-manager.ts")
text = path.read_text()
block = (
    "<<<<<<< HEAD\n"
    "\t\tswitch (resolvedName) {\n"
    "\t\t\tcase \"bun\":\n"
    "\t\t\t\treturn [\"install\", \"--omit=dev\", \"--omit=peer\"];\n"
    "\t\t\tcase \"pnpm\":\n"
    "\t\t\t\treturn [\n"
    "\t\t\t\t\t\"install\",\n"
    "\t\t\t\t\t\"--prod\",\n"
    "\t\t\t\t\t\"--config.auto-install-peers=false\",\n"
    "\t\t\t\t\t\"--config.strict-peer-dependencies=false\",\n"
    "\t\t\t\t\t\"--config.strict-dep-builds=false\",\n"
    "\t\t\t\t];\n"
    "\t\t\tcase \"npm\":\n"
    "\t\t\t\treturn [\"install\", \"--omit=dev\", \"--legacy-peer-deps\"];\n"
    "\t\t\tdefault:\n"
    "\t\t\t\treturn [\"install\"];\n"
    "\t\t}\n"
    "=======\n"
    "\t\t// Pi supplies host APIs. Omitting dev alone can reinstall them through peerDependencies.\n"
    "\t\treturn this.getPackageManagerName() === \"bun\"\n"
    "\t\t\t? [\"install\", \"--omit=dev\", \"--omit=peer\"]\n"
    "\t\t\t: [\"install\", \"--omit=dev\", \"--legacy-peer-deps\"];\n"
    ">>>>>>> 72abe9a79 (Reapply \"fix(coding-agent): reduce Git package installation storage (#7)\")\n"
)
if text.count(block) != 1:
    raise SystemExit("unexpected package-manager.ts install-args conflict shape")
ours = block.split("=======\n")[0].replace("<<<<<<< HEAD\n", "")
text = text.replace(block, ours, 1)
path.write_text(text)
PY
			git add packages/coding-agent/src/core/package-manager.ts
			# package-manager.test.ts: the patch re-adds getNpmCommand next to the
			# copy the embedded-bun resolver already merged in. Keep HEAD.
			python3 - <<'PY'
from pathlib import Path

path = Path("packages/coding-agent/test/package-manager.test.ts")
text = path.read_text()
block = (
    "<<<<<<< HEAD\n"
    "\tgetNpmCommand(): { command: string; args: string[]; embeddedBun?: boolean };\n"
    "=======\n"
    ">>>>>>> 72abe9a79 (Reapply \"fix(coding-agent): reduce Git package installation storage (#7)\")\n"
)
if text.count(block) != 1:
    raise SystemExit("unexpected package-manager.test.ts conflict shape")
text = text.replace(block, "\tgetNpmCommand(): { command: string; args: string[]; embeddedBun?: boolean };\n", 1)
path.write_text(text)
PY
			git add packages/coding-agent/test/package-manager.test.ts
		fi
		ensure_no_conflicts "merge patch/git-package-storage branch"
		ensure_not_empty "merge patch/git-package-storage branch"
		verify_staged
		commit_step "merge patch/git-package-storage branch"
		APPLIED_RANGE[git-package-storage]="$base..$tip"
	fi

	# 14-15 reviewed accumulated ranges; no runtime rewriting in CI.
	if active agent-run-failure-seam; then
		apply_compat_range agent-run-failure-seam "merge patch/agent-run-failure-seam branch"
	fi

	# MTE's source remains independent: the compat base describes application
	# order, not invented ancestry between its source branch and the seam.
	if active managed-tool-executions; then
		apply_compat_range managed-tool-executions "merge patch/managed-tool-executions branch" \
			resolve-managed-tool-executions-conflicts.py \
			packages/coding-agent/README.md \
			packages/coding-agent/docs/settings.md \
			packages/coding-agent/docs/usage.md
	fi

	# 16-17 esc-abort and manual-retry must descend from the recorded seam and
	# stay disjoint except agent-session.ts.
	if active esc-abort || active manual-retry; then
		# Cross-patch guards run pairwise only for the children present in
		# this run; the disjointness check below uses whichever are active.
		if active esc-abort; then
			require_ancestor agent-run-failure-seam esc-abort
		fi
		if active manual-retry; then
			require_ancestor agent-run-failure-seam manual-retry
		fi
		local seam="${INPUT_SHA[agent-run-failure-seam]}"
		if active esc-abort; then
			git diff --quiet "$seam..${INPUT_SHA[esc-abort]}" -- packages/agent/src/types.ts ||
				die "patch/esc-abort must not redefine the shared run_failure event type"
		fi
		if active manual-retry; then
			git diff --quiet "$seam..${INPUT_SHA[manual-retry]}" -- packages/agent ||
				die "patch/manual-retry must not modify packages/agent after the shared seam"
		fi
		if active esc-abort && active manual-retry; then
			mapfile -t overlap < <(comm -12 \
				<(git diff --name-only "$seam..${INPUT_SHA[esc-abort]}" | sort) \
				<(git diff --name-only "$seam..${INPUT_SHA[manual-retry]}" | sort))
			local expected_overlap=(packages/coding-agent/src/core/agent-session.ts)
			if (( ${#overlap[@]} != ${#expected_overlap[@]} )) ||
				[[ "${overlap[*]}" != "${expected_overlap[*]}" ]]; then
				printf '::error::Unexpected Esc/manual-retry overlap: %q\n' "${overlap[*]}" >&2
				exit 1
			fi
		fi
		if active esc-abort; then
			apply_compat_range esc-abort "merge patch/esc-abort branch" \
				resolve-esc-abort-conflicts.py \
				packages/coding-agent/docs/extensions.md
		fi
		if active manual-retry; then
			apply_compat_range manual-retry "merge patch/manual-retry branch"
		fi
	fi

	# 18 changelog-prerelease — inline conflict resolution, exact shape.
	if active changelog-prerelease; then
		CURRENT_STEP=changelog-prerelease
		stop_before changelog-prerelease
		if ! git merge --squash "origin/patch/changelog-prerelease"; then
			ensure_conflicts_are patch/changelog-prerelease \
				packages/coding-agent/src/config.ts
			python3 - <<'PY'
from pathlib import Path
import subprocess

path = Path("packages/coding-agent/src/config.ts")
base, ours, theirs = (
    subprocess.check_output(["git", "show", f":{stage}:{path}"], text=True)
    for stage in (1, 2, 3)
)

def add_changelog_settings(text: str) -> str:
    for anchor, addition in (
        ("\t\tconfigDir?: string;\n", "\t\tchangelogVersion?: string;\n"),
        ('export const VERSION: string = pkg.version || "0.0.0";\n',
         'export const CHANGELOG_VERSION: string = pkg.piConfig?.changelogVersion || VERSION;\n'),
    ):
        if text.count(anchor) != 1 or addition in text:
            raise SystemExit("Unexpected changelog config anchor or duplicate declaration")
        text = text.replace(anchor, anchor + addition, 1)
    return text

# Only the two source-patch additions are mechanical. Reject any other
# incoming edit before replacing conflict markers or staging the file.
if add_changelog_settings(base) != theirs:
    raise SystemExit("Unexpected changelog patch config delta")
resolved = add_changelog_settings(ours)
path.write_text(resolved)
PY
			git add packages/coding-agent/src/config.ts
		fi
		ensure_no_conflicts patch/changelog-prerelease
		ensure_not_empty patch/changelog-prerelease
		verify_staged
		commit_step "merge patch/changelog-prerelease branch"
	fi

	# 19-20
	if active skill-overrides; then
		CURRENT_STEP=skill-overrides
		stop_before skill-overrides
		if ! git merge --squash "origin/patch/skill-overrides"; then
			ensure_conflicts_are "merge patch/skill-overrides branch" \
				packages/coding-agent/docs/packages.md \
				packages/coding-agent/src/core/package-manager.ts \
				packages/coding-agent/test/resource-loader.test.ts
			# Upstream rewrote packages.md; re-append the skillOverrides note
			# under its new resource-selection section.
			git checkout --ours -- packages/coding-agent/docs/packages.md
			python3 - <<'PY'
from pathlib import Path

path = Path("packages/coding-agent/docs/packages.md")
text = path.read_text()
anchor = "Filters narrow the package manifest. They do not expose resources that the package itself did not declare.\n"
addition = "\nA package may also set `skillOverrides` keyed by each skill's resolved `name`. Setting `disableModelInvocation` to `true` hides that skill from the model prompt while keeping `/skill:name` available; `false` overrides the skill's frontmatter. Unknown skill names are ignored, and overrides apply only to skills from that package. For an `autoload: false` project delta, same-name overrides replace global entries while unspecified skill overrides are inherited.\n"
if text.count(anchor) != 1:
    raise SystemExit("unexpected packages.md filter anchor")
text = text.replace(anchor, anchor + addition, 1)
path.write_text(text)
PY
			git add packages/coding-agent/docs/packages.md
			# package-manager.ts: PathMetadata gains packageRoot (ours, from
			# upstream 8d897edaa) and skillOverrides (theirs). Keep both fields.
			python3 - <<'PY'
from pathlib import Path

path = Path("packages/coding-agent/src/core/package-manager.ts")
text = path.read_text()
block = (
    "<<<<<<< HEAD\n"
    "\tpackageRoot?: string;\n"
    "=======\n"
    "\tskillOverrides?: SkillOverrides;\n"
    ">>>>>>> origin/patch/skill-overrides\n"
)
if text.count(block) != 1:
    raise SystemExit("unexpected package-manager.ts metadata conflict shape")
text = text.replace(block, "\tpackageRoot?: string;\n\tskillOverrides?: SkillOverrides;\n", 1)
path.write_text(text)
PY
			git add packages/coding-agent/src/core/package-manager.ts
			# resource-loader.test.ts: ours carries upstream's #9863 regression
			# tests, theirs carries the skillOverrides tests. Both run; merge
			# them into the same describe block.
			python3 - <<'PY'
from pathlib import Path

path = Path("packages/coding-agent/test/resource-loader.test.ts")
text = path.read_text()
start = text.index("<<<<<<< HEAD\n")
mid = text.index("=======\n", start)
end = text.index(">>>>>>> origin/patch/skill-overrides\n", mid)
ours = text[start + len("<<<<<<< HEAD\n") : mid]
theirs = text[mid + len("=======\n") : end]
# ours ends mid-it() — the marker cut its closing `});`. Restore it.
if not ours.rstrip().endswith("});"):
    ours = ours.rstrip() + "\n\t\t});\n\n"
text = text[:start] + ours + theirs + text[end + len(">>>>>>> origin/patch/skill-overrides\n"):]
path.write_text(text)
PY
			git add packages/coding-agent/test/resource-loader.test.ts
		fi
		ensure_no_conflicts "merge patch/skill-overrides branch"
		ensure_not_empty "merge patch/skill-overrides branch"
		verify_staged
		commit_step "merge patch/skill-overrides branch"
	fi
	if active retry-non-retryable-patterns; then
		CURRENT_STEP=retry-non-retryable-patterns
		stop_before retry-non-retryable-patterns
		if ! git merge --squash "origin/patch/retry-non-retryable-patterns"; then
			ensure_conflicts_are "merge patch/retry-non-retryable-patterns branch" packages/coding-agent/docs/settings.md
			# Re-append the nonRetryableErrorPatterns row into upstream's new
			# Network-and-retries table.
			git checkout --ours -- packages/coding-agent/docs/settings.md
			python3 - <<'PY'
from pathlib import Path

path = Path("packages/coding-agent/docs/settings.md")
text = path.read_text()
anchor = "| `retry.maxAgentDelayMs` | number | `60000` | Maximum agent-level retry delay in milliseconds. |\n"
addition = "| `retry.nonRetryableErrorPatterns` | `string[]` | None | Extra case-insensitive `errorMessage` substrings that skip automatic retry (in addition to the built-in quota and billing patterns). Useful when a gateway returns a terminal quota/limit error that still looks retryable, for example a plain HTTP 429. |\n"
if text.count(anchor) != 1:
    raise SystemExit("unexpected settings.md retry anchor")
text = text.replace(anchor, anchor + addition, 1)
path.write_text(text)
PY
			git add packages/coding-agent/docs/settings.md
		fi
		ensure_no_conflicts "merge patch/retry-non-retryable-patterns branch"
		ensure_not_empty "merge patch/retry-non-retryable-patterns branch"
		verify_staged
		commit_step "merge patch/retry-non-retryable-patterns branch"
	fi

	# 21 slow-hook-tui-only — explicit recorded compat base..tip. Upstream's
	# doc refresh moved its docs anchors; resolver re-appends onto new docs.
	if active slow-hook-tui-only; then
		apply_compat_range slow-hook-tui-only "merge patch/slow-hook-tui-only branch" \
			resolve-slow-hook-conflicts.py \
			packages/coding-agent/docs/extensions.md \
			packages/coding-agent/docs/settings.md
		grep -Fq 'if (ext.uninterruptibleHandlers?.has(handler) === true) continue;' \
			packages/coding-agent/src/core/extensions/runner.ts
		grep -Fq 'this.runHandler("message_end", ext, handlerIndex' \
			packages/coding-agent/src/core/extensions/runner.ts
	fi

	# 22 session-tree-splice — descendant range with exact conflict shape.
	if active session-tree-splice; then
		CURRENT_STEP=session-tree-splice
		require_ancestor slow-hook-tui-only session-tree-splice
		stop_before session-tree-splice
		git diff --binary "${INPUT_SHA[slow-hook-tui-only]}" "${INPUT_SHA[session-tree-splice]}" \
			-- >"$TMPDIR_WORK/session-tree-splice.patch"
		if ! git apply --3way --index "$TMPDIR_WORK/session-tree-splice.patch"; then
			ensure_conflicts_are patch/session-tree-splice \
				packages/coding-agent/docs/extensions.md \
				packages/coding-agent/docs/session-format.md \
				packages/coding-agent/src/core/session-manager.ts \
				packages/coding-agent/test/suite/harness.ts
			python3 "$HELPER_DIR/resolve-session-tree-splice-conflicts.py" ||
				{ echo '::group::sts conflict dump' >&2; git diff --diff-filter=U | head -120 >&2; echo '::endgroup::' >&2; die "session-tree-splice resolver failed"; }
		fi
		ensure_no_conflicts patch/session-tree-splice
		ensure_not_empty patch/session-tree-splice
		verify_staged
		grep -Fq 'rmSync,' packages/coding-agent/src/core/session-manager.ts
		grep -Fq 'unlinkSync,' packages/coding-agent/src/core/session-manager.ts
		grep -Fq 'sessionManagerFactory?: (tempDir: string) => SessionManager;' packages/coding-agent/test/suite/harness.ts
		grep -Fq 'persist?: boolean;' packages/coding-agent/test/suite/harness.ts
		commit_step "merge patch/session-tree-splice branch"
		APPLIED_RANGE[session-tree-splice]="${INPUT_SHA[slow-hook-tui-only]}..${INPUT_SHA[session-tree-splice]}"
	fi

	# 23-27
	if active ws-cached-empty-delta; then
		CURRENT_STEP=ws-cached-empty-delta
		merge_squash ws-cached-empty-delta "merge patch/ws-cached-empty-delta branch"
	fi
	if active self-update-managed-by; then
		CURRENT_STEP=self-update-managed-by
		merge_squash self-update-managed-by "merge patch/self-update-managed-by branch"
	fi
	if active google-toomany-toolcalls; then
		CURRENT_STEP=google-toomany-toolcalls
		merge_squash google-toomany-toolcalls "merge patch/google-toomany-toolcalls branch"
	fi
	if active model-selector-refresh-selection; then
		CURRENT_STEP=model-selector-refresh-selection
		merge_squash model-selector-refresh-selection "merge patch/model-selector-refresh-selection branch"
	fi
	if active ai-drop-empty-messages; then
		CURRENT_STEP=ai-drop-empty-messages
		merge_squash ai-drop-empty-messages "merge patch/ai-drop-empty-messages branch"
	fi

	# 28 compaction-test-exclusion
	if active compaction-test-exclusion; then
		CURRENT_STEP=compaction-test-exclusion
		merge_squash compaction-test-exclusion "merge patch/compaction-test-exclusion branch"
		grep -Fq '"test/suite/agent-session-compaction.test.ts"' packages/coding-agent/vitest.config.ts
	fi

	commit_input_marker
	say "rebuild complete: $(git rev-parse --short HEAD)"
}

if [[ "$MODE" == "check" ]]; then
	check_mode
fi
run_replay
