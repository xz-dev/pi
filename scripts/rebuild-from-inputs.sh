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
# Model: main = upstream + ci + each patch/* squash-merged in PATCH_ORDER.
# There are no resolver scripts, no accumulated compat branches, and no
# recorded base..tip ranges. When a merge conflicts, the replay fails and
# names the patch; the repair is exactly one action: rebase that patch branch
# onto the latest upstream/main (or onto its predecessor patch tip for
# dependent chains), force-push it, and rerun. Patch content lives in patch
# branches, never in this script.
#
# Usage:
#   scripts/rebuild-from-inputs.sh --source <repo> --target <new-path>
#                                  [--upstream <sha>] [--ci <sha>]
#                                  [--patch <name>=<sha>]...
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
# SHAs recorded as literal defaults; the workflow re-captures per run after
# fetch, so these go stale only between syncs. Never hand-expand a short SHA:
# resolve with git rev-parse / git ls-remote.
read -r -d '' DEFAULT_INPUTS <<'EOF' || true
upstream/main 2b0a123de98318c2ff8069661721ce0c3794c34e
ci 7c44f701e0ba3e86e19b9427cb8e27a73894b259
patch/contributor-approval 57928a38185ca3e73d26d5fde1cbd7184f676fef
patch/model-startup-refresh-barrier 5e074cee683c0412ff08a6828cf43f4555115a1d
patch/model-refresh-session-rebind d9341253b4d04c2e631102f3dddedd66af43bbe1
patch/model-catalog-extension-refresh a47e894e6fed7bfa7d72aef973f045096109923f
patch/model-refresh-timeout 0a305565340654e159d66bacf781990c3fbc20e9
patch/bun-bytecode-entrypoint 5a70e570b18555712901fa64374af7e67c10da1d
patch/startup-benchmark-exit 944a3079d9b7a93df4bd3e92974337aa7feee2a4
patch/native-wrapper-release 65281278ed2bdd966bec63e5406b3fb4948a99d7
patch/update-clean c66b86b5677da578a25be1914125aa6720a8ccbf
patch/bundle-usage-claims c2786bd512d2f78fb99e80940c88489f628e7acf
patch/use-embedded-bun-package-manager e083b951142014d0c0e986b58c4cfcc275ace771
patch/git-package-storage ce3d8adb016a3d8405bddae52d14656c7bf505ff
patch/agent-run-failure-seam dc9d6756da8cfe685613d5c02e4432ccc9c513cd
patch/managed-tool-executions dc2801ee4f63fb017322864eb92d9de7e2d0c62c
patch/esc-abort 68d78004fe76cea140fbb7bb99dbe558b196e4fd
patch/managed-tool-abort-drain 11a07140e907406d0fa1c330589a10d19ed0b6b0
patch/manual-retry 27cf4b80a0da75cbb1010a05d20453374d91758f
patch/startup-submit-readiness 39d2c8d3e9f1dff7b0ad7f13b1779549d8963601
patch/changelog-prerelease d4fed01fb03513eb25f0c6a2395e14074ded7fc4
patch/skill-overrides 83e390f1abcc5d82c0ce42ce0ce74d56902cda96
patch/retry-non-retryable-patterns 0c431dd6a2d0741be5a269dfb2fd87a211aa5e6c
patch/slow-hook-tui-only 341e04df00840bfc833b286b9e0ad53525588014
patch/session-tree-splice 4f4a61d9ba82e80b1d00bf6167c7d102d10156fc
patch/ws-cached-empty-delta 6eb1779b7ef737284aa862ca8cc31ea512cd1125
patch/self-update-managed-by 992af1524a99c1b5c8f6d4b434c85341141619cc
patch/google-toomany-toolcalls 47573caacf550ec57f7c308940b3a217d6fd00b9
patch/model-selector-refresh-selection 8f582eb8df619f3d32899d0d78433cb841e26573
patch/ai-drop-empty-messages 37f145b54ec4cd4b1f1d2b0066fedd3b1c7713de
patch/openrouter-live-fixture a1bbcf9779128e25354add89406459276021104b
patch/compaction-test-exclusion cfa24a33672f03d5e88888123ead7d4cdc636bda
patch/quarantine-auth-storage-flake b9ab213dc9676f1f527b6ea709284c3350907378
patch/vitest-audit-fix 559232f68ef83ac305bd775a31b5dc0d42aa5ee9
EOF

print_inputs() {
	printf '%s\n' "$DEFAULT_INPUTS"
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
	managed-tool-abort-drain
	manual-retry
	startup-submit-readiness
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
	openrouter-live-fixture
	compaction-test-exclusion
	quarantine-auth-storage-flake
	vitest-audit-fix
)

# Dependent chains: the descendant patch must keep the predecessor patch tip
# in its ancestry so its delta applies on top of the predecessor's content.
# Descendants are integrated as range diffs (predecessor_tip..descendant_tip),
# not squash merges: the rebuilt tree never contains the predecessor's branch
# commits, so a squash merge of a descendant would re-conflict on every region
# the two patches share. Rebase cascades down the chain when the predecessor
# is rebased.
CHAIN_EDGES=(
	model-startup-refresh-barrier:model-catalog-extension-refresh
	model-catalog-extension-refresh:model-refresh-timeout
	native-wrapper-release:update-clean
	native-wrapper-release:use-embedded-bun-package-manager
	update-clean:bundle-usage-claims
	use-embedded-bun-package-manager:git-package-storage
	git-package-storage:changelog-prerelease
	agent-run-failure-seam:managed-tool-executions
	managed-tool-executions:esc-abort
	esc-abort:managed-tool-abort-drain
	esc-abort:manual-retry
	manual-retry:retry-non-retryable-patterns
	retry-non-retryable-patterns:slow-hook-tui-only
	slow-hook-tui-only:session-tree-splice
)

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
		upstream/main)
			grep -qE 'git fetch upstream main' "$workflow" || { say "check: workflow does not fetch upstream main"; missing=1; }
			continue
			;;
		ci) ref=ci ;;
		patch/*) ref="$name" ;;
		esac
		grep -qE "refs/heads/${ref}(:|\\\\)" "$workflow" || { say "check: workflow does not fetch $name"; missing=1; }
	done <<<"$DEFAULT_INPUTS"
	# Reverse direction: every patch ref the workflow fetches must appear here.
	local fetched
	fetched="$(grep -o 'refs/heads/patch/[^:]*' "$workflow" | sed 's/refs\/heads\///')"
	for ref in $fetched; do
		grep -q "^$ref " <<<"$DEFAULT_INPUTS" || { say "check: script has no recorded input for $ref"; missing=1; }
	done
	((missing == 0)) || die "check failed: workflow and script inputs drift"
	say "check ok: workflow fetch list and script inputs match"
	exit 0
}

# --- argument parsing ---------------------------------------------------------

MODE="replay"
DIAGNOSTIC=0
STOP_BEFORE=""
SOURCE_REPO=""
TARGET_PATH=""
EXPLICIT_PATCHES=()
declare -A INPUT_SHA
APPLIED_ORDER=()
ACTIVE_ORDER=()
UPSTREAM_SHA=""
CI_SHA=""
while (($# > 0)); do
	case "$1" in
	--print-inputs) MODE="print" ; shift ;;
	--print-marker) MODE="print-marker" ; shift ;;
	--check) MODE="check" ; shift ;;
	--diagnostic) DIAGNOSTIC=1 ; shift ;;
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
		((known)) || die "unknown patch input name: $p"
		[[ "${INPUT_SHA[$p]}" =~ ^[0-9a-f]{40}$ ]] || die "patch/$p input is not a full fixed SHA"
	done
	select_active
	if ((DIAGNOSTIC)); then
		((${#ACTIVE_ORDER[@]} > 0)) || die "diagnostic replay requires an explicit patch step"
	elif ((${#EXPLICIT_PATCHES[@]} > 0)); then
		# Overrides in a full run must describe a complete vector. A caller
		# wanting a subset must opt into a non-publishable diagnostic run.
		for p in "${PATCH_ORDER[@]}"; do
			[[ " ${EXPLICIT_PATCHES[*]} " == *" $p "* ]] || die "missing explicit input patch/$p in full vector"
		done
	fi
	if [[ -n "$STOP_BEFORE" && "$STOP_BEFORE" != ci ]]; then
		[[ " ${ACTIVE_ORDER[*]} " == *" $STOP_BEFORE "* ]] || die "unknown --stop-before step or step not selected: $STOP_BEFORE"
	fi
}

if [[ "$MODE" == "print-marker" ]]; then
	validate_inputs
	APPLIED_ORDER=()
	if [[ "$STOP_BEFORE" != ci ]]; then
		APPLIED_ORDER=(ci)
		for p in "${ACTIVE_ORDER[@]}"; do
			[[ -n "$STOP_BEFORE" && "$STOP_BEFORE" == "$p" ]] && break
			APPLIED_ORDER+=("$p")
		done
	fi
	print_marker
	exit 0
fi

label_of() {
	# Canonical git label for a recorded input name: "origin/ci" or
	# "origin/patch/<name>". Merging against this label (not the raw SHA) keeps
	# conflict markers identical to the CI workflow's.
	if [[ "$1" == ci ]]; then
		printf 'ci'
	else
		printf 'patch/%s' "$1"
	fi
}

active() {
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

# Idempotency: if the recorded marker for exactly this input vector already
# sits on main (or the source's published origin/main), the rebuild would
# produce the identical tree — skip it. CI relies on this to no-op when the
# fetched vector has not moved since the last published sync.
skip_if_recorded() {
	local expected actual ref
	local saved=("${APPLIED_ORDER[@]}")
	APPLIED_ORDER=(ci "${ACTIVE_ORDER[@]}")
	expected="$(print_marker)"
	APPLIED_ORDER=("${saved[@]}")
	for ref in main origin/main src/main; do
		actual="$(git log --format=%B -1 "$ref" 2>/dev/null || true)"
		if [[ -n "$actual" && "$actual" == "$expected" ]]; then
			say "recorded input vector already present on $ref; skipping rebuild"
			exit 0
		fi
	done
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

verify_staged() {
	# Whitespace damage guard on the staged integration.
	git diff --cached --check
}

commit_step() {
	# $1 is the full merge message, e.g. "merge patch/esc-abort branch".
	git commit -m "$1"
	APPLIED_ORDER+=("$CURRENT_STEP")
}

require_ancestor() {
	# require_ancestor <ancestor-patch-name> <descendant-patch-name>
	# Fails closed when either input is missing (the descendant guard must not
	# silently pass because an ancestor was not provided).
	local ancestor="${INPUT_SHA[$1]:-}" descendant="${INPUT_SHA[$2]:-}"
	[[ -n "$ancestor" ]] || die "patch/$2 guard requires patch/$1 input"
	git merge-base --is-ancestor "$ancestor" "$descendant" ||
		die "patch/$2 must descend from patch/$1 — rebase the descendant onto the new predecessor tip"
}

# Step helpers ---------------------------------------------------------------

merge_squash() {
	# merge_squash <name> <msg> [flags]
	# On conflict the replay fails closed and names the patch. The repair is to
	# rebase that patch branch onto the latest upstream (or its chain
	# predecessor) and rerun — never to teach this script conflict shapes.
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
				*) die "Unexpected $msg squash conflict: $f — rebase patch/$name onto upstream and rerun" ;;
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
			local conflicts
			mapfile -t conflicts < <(git diff --name-only --diff-filter=U)
			printf '::error::%s conflicts: %s — rebase patch/%s onto upstream (or its chain predecessor) and rerun\n' \
				"$msg" "${conflicts[*]}" "$name" >&2
			exit 1
		fi
	fi
	ensure_no_conflicts "$msg"
	ensure_not_empty "$msg"
	if [[ "$flags" != *"skip-check"* ]]; then
		verify_staged
	fi
	commit_step "$msg"
}

apply_range() {
	# apply_range <name> <msg> <predecessor-patch-name>
	# 3-way apply of the predecessor_tip..tip delta for chain descendants.
	# No resolvers: any conflict fails closed with a rebase instruction.
	local name="$1" msg="$2" pred="$3"
	stop_before "$name"
	require_ancestor "$pred" "$name"
	git merge-base --is-ancestor "${INPUT_SHA[$pred]}" "${INPUT_SHA[$name]}" ||
		die "$msg must descend from patch/$pred — rebase patch/$name onto the new patch/$pred tip"
	[[ -z "$(git rev-list --min-parents=2 "${INPUT_SHA[$pred]}..${INPUT_SHA[$name]}")" ]] ||
		die "$msg range must be linear (no merge commits between patch/$pred and patch/$name)"
	git diff --binary "${INPUT_SHA[$pred]}" "${INPUT_SHA[$name]}" -- >"$TMPDIR_WORK/$name.patch"
	if ! git apply --3way --index "$TMPDIR_WORK/$name.patch"; then
		local conflicts
		mapfile -t conflicts < <(git diff --name-only --diff-filter=U)
		printf '::error::%s conflicts: %s — rebase patch/%s onto patch/%s and rerun\n' \
			"$msg" "${conflicts[*]}" "$name" "$pred" >&2
		exit 1
	fi
	ensure_no_conflicts "$msg"
	ensure_not_empty "$msg"
	verify_staged
	commit_step "$msg"
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
	# Skip before any mutation when the exact vector is already recorded.
	skip_if_recorded
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

	# The selected ci input must actually carry the helper this replay
	# executes; extract it from the immutable CI_SHA object, never a worktree
	# overlay (which could carry uncommitted edits).
	TMPDIR_WORK="$(mktemp -d "${TMPDIR:-/tmp}/rebuild-from-inputs.XXXXXX")"
	HELPER_DIR="$TMPDIR_WORK/helpers"
	mkdir -p "$HELPER_DIR"
	if ! git archive "$CI_SHA" scripts/ >"$TMPDIR_WORK/ci-scripts.tar" 2>/dev/null; then
		die "ci input $CI_SHA carries no scripts/ helpers"
	fi
	tar -xf "$TMPDIR_WORK/ci-scripts.tar" -C "$TMPDIR_WORK"
	for helper in rebuild-from-inputs.sh union-contributor-approvals.py; do
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
	# silently shrinking the replay.
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

	# Dependent chains must keep the predecessor patch tip in their ancestry.
	local edge pred desc
	for edge in "${CHAIN_EDGES[@]}"; do
		pred="${edge%%:*}"
		desc="${edge##*:}"
		if active "$pred" && active "$desc"; then
			require_ancestor "$pred" "$desc"
		fi
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

	# 3+ patches — plain squash merges in PATCH_ORDER; chain descendants apply
	# their predecessor-relative range instead. Any conflict fails closed with
	# the patch name; the fix is a rebase of that patch branch.
	for p in "${ACTIVE_ORDER[@]}"; do
		[[ "$p" == contributor-approval ]] && continue
		CURRENT_STEP="$p"
		local_pred=""
		for edge in "${CHAIN_EDGES[@]}"; do
			if [[ "${edge##*:}" == "$p" ]] && active "${edge%%:*}"; then
				local_pred="${edge%%:*}"
				break
			fi
		done
		if [[ -n "$local_pred" ]]; then
			apply_range "$p" "merge patch/$p branch" "$local_pred"
		else
			merge_squash "$p" "merge patch/$p branch"
		fi
	done

	commit_input_marker
	say "rebuild complete: $(git rev-parse --short HEAD)"
}

if [[ "$MODE" == "check" ]]; then
	check_mode
fi
run_replay
