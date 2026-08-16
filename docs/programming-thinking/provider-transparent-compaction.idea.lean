-- Lean's standard library supplies finite structures, arithmetic, equality, proofs, and executable output.
import Std

set_option autoImplicit false

namespace ProviderTransparentCompaction

-- Process vocabulary distinguishes public compaction kinds, trigger boundaries, results, decisions, and source ranges.
inductive CompactionKind where
  | remote
  | classic
  | extension
  deriving DecidableEq, Repr

inductive Trigger where
  | explicitCompaction
  | providerRequest
  deriving DecidableEq, Repr

-- Same-run continuation vocabulary models the checkpoint after tool results and before provider dispatch.
inductive ContinuationDecision where
  | dispatchCurrent
  | compactThenDispatch
  | stopWithoutDispatch
  deriving DecidableEq, Repr

structure ContinuationInput where
  hasNextProviderRequest : Bool
  liveContextTokens : Nat
  contextWindow : Nat
  reserveTokens : Nat
  compactionEnabled : Bool
  compactionPrepared : Bool
  compactionCommitted : Bool
  rebuiltContextMatchesCommittedBoundary : Bool
  deriving DecidableEq, Repr

structure ContinuationResult where
  decision : ContinuationDecision
  providerRequestAllowed : Bool
  usedRebuiltContext : Bool
  toolExecutionRepeated : Bool
  committedBoundaryCount : Nat
  deriving DecidableEq, Repr

inductive Boundary where
  | none
  | compacted (kind : CompactionKind) (coveredPrefix : Nat)
  deriving DecidableEq, Repr

inductive RemoteResult where
  | succeeded
  | failed
  | cancelled
  deriving DecidableEq, Repr

structure CompactUsageDetails where
  outputReasoningTokens : Option Nat
  deriving DecidableEq, Repr

inductive ClassicFoldResult where
  | succeeded (providerPasses : Nat)
  | failed
  | cancelled
  deriving DecidableEq, Repr

inductive Decision where
  | sendNormally
  | replayRemote
  | commitRemote
  | commitClassic
  | commitExtension
  | cancelled
  | failed
  | stale
  deriving DecidableEq, Repr

inductive CompactionSource where
  | rawPrefix (endExclusive : Nat)
  | priorBoundaryAndDelta (startInclusive : Nat) (endExclusive : Nat)
  | extensionProjection (endExclusive : Nat)
  deriving DecidableEq, Repr

-- Producer freshness distinguishes ignored tail growth from source changes and records auth-to-snapshot coherence.
inductive TailChange where
  | none
  | irrelevantAppend (count : Nat)
  | relevantAppend
  deriving DecidableEq, Repr

-- Commit steps expose required durability order without performing persistence in executable documentation.
inductive CommitStep where
  | persistBoundary
  | publishBoundary
  deriving DecidableEq, Repr

structure AuthResolution where
  resolvedBeforeProducerSnapshot : Bool
  modelChangesDuringResolution : Nat
  authModelMatchesSnapshotModel : Bool
  deriving DecidableEq, Repr

structure FreshnessEvidence where
  sameSession : Bool
  sameGeneration : Bool
  sameLeaf : Bool
  rawBranchContentUnchanged : Bool
  canonicalFilteredSourceUnchanged : Bool
  effectiveModelUnchanged : Bool
  effectiveThinkingUnchanged : Bool
  sourceLeafOnCurrentLineage : Bool
  anchorOnSourceLineage : Bool
  currentGeneration : Nat
  currentLeaf : Nat
  tailChange : TailChange
  auth : AuthResolution
  deriving DecidableEq, Repr

-- Durable process data keeps raw history authoritative while tracking one public boundary and private remote availability.
structure SessionState where
  boundary : Boundary
  privateRemotePresent : Bool
  rawHistoryIntact : Bool
  rawItemCount : Nat
  committedBoundaryCount : Nat
  generation : Nat
  leaf : Nat
  lastBoundaryParent : Option Nat
  deriving DecidableEq, Repr

structure ProviderTarget where
  responsesCapable : Bool
  remoteEnabled : Bool
  remoteCheckpointCompatible : Bool
  deriving DecidableEq, Repr

structure CommitGate where
  freshness : FreshnessEvidence
  persistenceSucceeded : Bool
  deriving DecidableEq, Repr

structure OperationInput where
  trigger : Trigger
  state : SessionState
  target : ProviderTarget
  extensionReplacementPresent : Bool
  requestedCoverage : Nat
  remoteResult : RemoteResult
  classicResult : ClassicFoldResult
  everyRawItemFitsDestination : Bool
  everyClassicRequestFitsDestination : Bool
  classicFinalContextFitsDestination : Bool
  commitGate : CommitGate
  deriving DecidableEq, Repr

structure PublicObservation where
  tuiKind : CompactionKind
  compactionEndKind : CompactionKind
  sessionCompactKind : CompactionKind
  rpcSdkKind : CompactionKind
  sessionEntryKind : CompactionKind
  htmlKind : CompactionKind
  opaqueCheckpointVisible : Bool
  compatibilityIdentityVisible : Bool
  deriving DecidableEq, Repr

structure OperationResult where
  decision : Decision
  finalState : SessionState
  providerRequestAllowed : Bool
  publicBoundaryKind : Option CompactionKind
  committedObservation : Option PublicObservation
  source : Option CompactionSource
  classicProviderPasses : Nat
  fallbackNotice : Bool
  privateCheckpointExposed : Bool
  providerErrorExposed : Bool
  remoteFailureCommitted : Bool
  commitTrace : List CommitStep
  deriving DecidableEq, Repr

-- Guards and range selectors choose compatible replay, full raw re-derivation, or prior-boundary-plus-delta exactly once.
def compactionThresholdReached (input : ContinuationInput) : Bool :=
  input.compactionEnabled && input.hasNextProviderRequest &&
    decide (input.contextWindow ≤ input.liveContextTokens + input.reserveTokens)

def runContinuation (input : ContinuationInput) : ContinuationResult :=
  if !input.hasNextProviderRequest then
    { decision := .stopWithoutDispatch, providerRequestAllowed := false,
      usedRebuiltContext := false, toolExecutionRepeated := false, committedBoundaryCount := 0 }
  else if _thresholdReached : compactionThresholdReached input then
    if input.compactionPrepared && input.compactionCommitted &&
        input.rebuiltContextMatchesCommittedBoundary then
      { decision := .compactThenDispatch, providerRequestAllowed := true,
        usedRebuiltContext := true, toolExecutionRepeated := false, committedBoundaryCount := 1 }
    else
      { decision := .stopWithoutDispatch, providerRequestAllowed := false,
        usedRebuiltContext := false, toolExecutionRepeated := false, committedBoundaryCount := 0 }
  else
    { decision := .dispatchCurrent, providerRequestAllowed := true,
      usedRebuiltContext := false, toolExecutionRepeated := false, committedBoundaryCount := 0 }

def normalizedReasoningTokens (details : CompactUsageDetails) : Nat :=
  details.outputReasoningTokens.getD 0

def boundaryKind : Boundary → Option CompactionKind
  | .none => none
  | .compacted kind _ => some kind

def boundaryCoverage : Boundary → Nat
  | .none => 0
  | .compacted _ coveredPrefix => coveredPrefix

def stateValid (state : SessionState) : Prop :=
  boundaryCoverage state.boundary ≤ state.rawItemCount

def remoteReusable (state : SessionState) (target : ProviderTarget) : Bool :=
  match state.boundary with
  | .compacted .remote _ =>
      target.remoteEnabled && target.responsesCapable && state.privateRemotePresent &&
        target.remoteCheckpointCompatible
  | _ => false

def targetCoverage (state : SessionState) (requestedCoverage : Nat) : Nat :=
  max (boundaryCoverage state.boundary) (min requestedCoverage state.rawItemCount)

def remoteSource (input : OperationInput) : CompactionSource :=
  let covered := targetCoverage input.state input.requestedCoverage
  match input.state.boundary with
  | .none => .rawPrefix covered
  | .compacted .remote prior =>
      if remoteReusable input.state input.target then
        .priorBoundaryAndDelta prior covered
      else
        .rawPrefix covered
  | .compacted .classic prior => .priorBoundaryAndDelta prior covered
  | .compacted .extension prior => .priorBoundaryAndDelta prior covered

def classicSource (input : OperationInput) : CompactionSource :=
  let covered := targetCoverage input.state input.requestedCoverage
  match input.state.boundary with
  | .none => .rawPrefix covered
  | .compacted .remote _ => .rawPrefix covered
  | .compacted .classic prior => .priorBoundaryAndDelta prior covered
  | .compacted .extension prior => .priorBoundaryAndDelta prior covered

def extensionSource (input : OperationInput) : CompactionSource :=
  .extensionProjection (targetCoverage input.state input.requestedCoverage)

def sourceValid (state : SessionState) (source : CompactionSource) (coveredPrefix : Nat) : Prop :=
  match source with
  | .rawPrefix endExclusive => endExclusive = coveredPrefix
  | .priorBoundaryAndDelta startInclusive endExclusive =>
      startInclusive = boundaryCoverage state.boundary ∧
      startInclusive ≤ endExclusive ∧
      endExclusive = coveredPrefix
  | .extensionProjection endExclusive => endExclusive = coveredPrefix

-- Freshness checks are producer-aware: extensions require exact raw identity; Pi producers permit only irrelevant tail appends.
def authSnapshotCoherent (auth : AuthResolution) : Bool :=
  auth.resolvedBeforeProducerSnapshot &&
    decide (auth.modelChangesDuringResolution ≤ 1) &&
    auth.authModelMatchesSnapshotModel

def tailAcceptableForPi : TailChange → Bool
  | .none => true
  | .irrelevantAppend _ => true
  | .relevantAppend => false

def currentGenerationAfterTail (state : SessionState) : TailChange → Nat
  | .none => state.generation
  | .irrelevantAppend count => state.generation + count
  | .relevantAppend => state.generation + 1

def currentLeafAfterTail (state : SessionState) : TailChange → Nat
  | .none => state.leaf
  | .irrelevantAppend count => state.leaf + count
  | .relevantAppend => state.leaf + 1

def snapshotFresh (kind : CompactionKind) (gate : CommitGate) : Bool :=
  let evidence := gate.freshness
  let common :=
    evidence.sameSession &&
      authSnapshotCoherent evidence.auth &&
      evidence.sourceLeafOnCurrentLineage &&
      evidence.anchorOnSourceLineage
  match kind with
  | .extension =>
      common &&
        evidence.sameGeneration &&
        evidence.sameLeaf &&
        evidence.rawBranchContentUnchanged
  | .classic | .remote =>
      common &&
        evidence.canonicalFilteredSourceUnchanged &&
        evidence.effectiveModelUnchanged &&
        evidence.effectiveThinkingUnchanged &&
        tailAcceptableForPi evidence.tailChange

-- Public projection repeats only safe kind metadata across TUI, events, RPC/SDK, session views, and HTML.
def publicObservation (kind : CompactionKind) : PublicObservation :=
  {
    tuiKind := kind
    compactionEndKind := kind
    sessionCompactKind := kind
    rpcSdkKind := kind
    sessionEntryKind := kind
    htmlKind := kind
    opaqueCheckpointVisible := false
    compatibilityIdentityVisible := false
  }

def observationConsistent (observation : PublicObservation) : Prop :=
  observation.tuiKind = observation.compactionEndKind ∧
  observation.tuiKind = observation.sessionCompactKind ∧
  observation.tuiKind = observation.rpcSdkKind ∧
  observation.tuiKind = observation.sessionEntryKind ∧
  observation.tuiKind = observation.htmlKind ∧
  observation.opaqueCheckpointVisible = false ∧
  observation.compatibilityIdentityVisible = false

def decisionForKind : CompactionKind → Decision
  | .remote => .commitRemote
  | .classic => .commitClassic
  | .extension => .commitExtension

-- Commit transitions validate one captured snapshot, persist one boundary, then advance generation and leaf once.
def committedState
    (state : SessionState)
    (kind : CompactionKind)
    (coveredPrefix currentGeneration currentLeaf : Nat) : SessionState :=
  {
    boundary := .compacted kind coveredPrefix
    privateRemotePresent := kind == .remote
    rawHistoryIntact := state.rawHistoryIntact
    rawItemCount := state.rawItemCount
    committedBoundaryCount := state.committedBoundaryCount + 1
    generation := currentGeneration + 1
    leaf := currentLeaf + 1
    lastBoundaryParent := some currentLeaf
  }

def noCommit
    (input : OperationInput)
    (decision : Decision)
    (providerRequestAllowed : Bool)
    (fallbackNotice : Bool) : OperationResult :=
  {
    decision
    finalState := input.state
    providerRequestAllowed
    publicBoundaryKind := boundaryKind input.state.boundary
    committedObservation := none
    source := none
    classicProviderPasses := 0
    fallbackNotice
    privateCheckpointExposed := false
    providerErrorExposed := false
    remoteFailureCommitted := false
    commitTrace := []
  }

def commitOperation
    (input : OperationInput)
    (kind : CompactionKind)
    (source : CompactionSource)
    (providerRequestAllowed : Bool)
    (fallbackNotice : Bool)
    (classicProviderPasses : Nat) : OperationResult :=
  let coveredPrefix := targetCoverage input.state input.requestedCoverage
  let nextState := committedState input.state kind coveredPrefix
    input.commitGate.freshness.currentGeneration input.commitGate.freshness.currentLeaf
  {
    decision := decisionForKind kind
    finalState := nextState
    providerRequestAllowed
    publicBoundaryKind := some kind
    committedObservation := some (publicObservation kind)
    source := some source
    classicProviderPasses
    fallbackNotice
    privateCheckpointExposed := false
    providerErrorExposed := false
    remoteFailureCommitted := false
    commitTrace := [.persistBoundary, .publishBoundary]
  }

def tryCommit
    (input : OperationInput)
    (kind : CompactionKind)
    (source : CompactionSource)
    (providerRequestAllowed : Bool)
    (fallbackNotice : Bool)
    (classicProviderPasses : Nat) : OperationResult :=
  if !snapshotFresh kind input.commitGate then
    noCommit input .stale false fallbackNotice
  else if !input.commitGate.persistenceSucceeded then
    noCommit input .failed false fallbackNotice
  else
    commitOperation input kind source providerRequestAllowed fallbackNotice classicProviderPasses

-- Classic recovery accepts only fitting requests, a fitting final context, and one through thirty-two provider passes.
def maxClassicProviderPasses : Nat := 32

def classicFoldValid (input : OperationInput) (providerPasses : Nat) : Bool :=
  input.everyRawItemFitsDestination &&
    input.everyClassicRequestFitsDestination &&
    input.classicFinalContextFitsDestination &&
    0 < providerPasses &&
    providerPasses ≤ maxClassicProviderPasses

def runClassic
    (input : OperationInput)
    (providerRequestAllowedAfterCommit : Bool)
    (fallbackNotice : Bool) : OperationResult :=
  if !input.state.rawHistoryIntact || !input.everyRawItemFitsDestination then
    noCommit input .failed false fallbackNotice
  else
    match input.classicResult with
    | .succeeded providerPasses =>
        if classicFoldValid input providerPasses then
          tryCommit input .classic (classicSource input) providerRequestAllowedAfterCommit fallbackNotice
            providerPasses
        else
          noCommit input .failed false fallbackNotice
    | .failed => noCommit input .failed false fallbackNotice
    | .cancelled => noCommit input .cancelled false fallbackNotice

def runMigration (input : OperationInput) : OperationResult :=
  if input.extensionReplacementPresent then
    tryCommit input .extension (extensionSource input) true false 0
  else
    runClassic input true false

def runExplicitCompaction (input : OperationInput) : OperationResult :=
  if input.extensionReplacementPresent then
    tryCommit input .extension (extensionSource input) false false 0
  else if input.target.remoteEnabled && input.target.responsesCapable then
    match input.remoteResult with
    | .succeeded => tryCommit input .remote (remoteSource input) false false 0
    | .failed => runClassic input false true
    | .cancelled => noCommit input .cancelled false false
  else
    runClassic input false false

-- Provider requests are the sole migration boundary; target switching alone never mutates session state.
def runProviderRequest (input : OperationInput) : OperationResult :=
  match input.state.boundary with
  | .compacted .remote _ =>
      if remoteReusable input.state input.target then
        noCommit input .replayRemote true false
      else
        runMigration input
  | _ => noCommit input .sendNormally true false

def runOperation (input : OperationInput) : OperationResult :=
  match input.trigger with
  | .explicitCompaction => runExplicitCompaction input
  | .providerRequest => runProviderRequest input

def switchTarget (state : SessionState) (_target : ProviderTarget) : SessionState :=
  state

def appendRawItems (state : SessionState) (count : Nat) : SessionState :=
  {
    state with
    rawItemCount := state.rawItemCount + count
    generation := state.generation + count
    leaf := state.leaf + count
  }

-- Invariants require intact raw history, producer-aware freshness, durable single-boundary publication, consistent public kind, and opaque privacy.
-- Commit invariants require persistence before publication and attach one boundary beneath current ignored tail.
def commitPublicationOrdered (input : OperationInput) (result : OperationResult) : Prop :=
  match result.committedObservation with
  | none => result.commitTrace = []
  | some _ =>
      input.commitGate.persistenceSucceeded = true ∧
      result.commitTrace = [.persistBoundary, .publishBoundary] ∧
      result.finalState.lastBoundaryParent = some input.commitGate.freshness.currentLeaf

def committedSourceValid (input : OperationInput) (result : OperationResult) : Prop :=
  match result.committedObservation, result.source with
  | none, none => True
  | some _, some source => sourceValid input.state source (boundaryCoverage result.finalState.boundary)
  | _, _ => False

def publicSafe (result : OperationResult) : Prop :=
  result.privateCheckpointExposed = false ∧
  result.providerErrorExposed = false ∧
  result.remoteFailureCommitted = false ∧
  match result.committedObservation with
  | none => True
  | some observation => observationConsistent observation

def coreInvariant (input : OperationInput) (result : OperationResult) : Prop :=
  stateValid result.finalState ∧
  result.finalState.rawHistoryIntact = input.state.rawHistoryIntact ∧
  result.finalState.rawItemCount = input.state.rawItemCount ∧
  (result.finalState.committedBoundaryCount = input.state.committedBoundaryCount ∨
    result.finalState.committedBoundaryCount = input.state.committedBoundaryCount + 1) ∧
  committedSourceValid input result ∧
  commitPublicationOrdered input result ∧
  publicSafe result

-- Supporting lemmas prove exact producer freshness, bounded auth churn, coverage, source continuity, state preservation, and every state-machine branch.
theorem extension_freshness_is_exact (gate : CommitGate) :
    snapshotFresh .extension gate =
      (gate.freshness.sameSession &&
        authSnapshotCoherent gate.freshness.auth &&
        gate.freshness.sourceLeafOnCurrentLineage &&
        gate.freshness.anchorOnSourceLineage &&
        gate.freshness.sameGeneration &&
        gate.freshness.sameLeaf &&
        gate.freshness.rawBranchContentUnchanged) := by
  rfl

theorem pi_freshness_is_filtered_and_dependency_aware (kind : CompactionKind)
    (piProof : kind = .classic ∨ kind = .remote) (gate : CommitGate) :
    snapshotFresh kind gate =
      (gate.freshness.sameSession &&
        authSnapshotCoherent gate.freshness.auth &&
        gate.freshness.sourceLeafOnCurrentLineage &&
        gate.freshness.anchorOnSourceLineage &&
        gate.freshness.canonicalFilteredSourceUnchanged &&
        gate.freshness.effectiveModelUnchanged &&
        gate.freshness.effectiveThinkingUnchanged &&
        tailAcceptableForPi gate.freshness.tailChange) := by
  rcases piProof with rfl | rfl <;> rfl

theorem irrelevant_tail_is_acceptable_for_pi (count : Nat) :
    tailAcceptableForPi (.irrelevantAppend count) = true := by
  rfl

theorem relevant_tail_is_rejected_for_pi :
    tailAcceptableForPi .relevantAppend = false := by
  rfl

theorem irrelevant_tail_commit_uses_current_leaf
    (input : OperationInput)
    (kind : CompactionKind)
    (source : CompactionSource)
    (providerRequestAllowed fallbackNotice : Bool)
    (classicProviderPasses count : Nat)
    (currentLeafProof : input.commitGate.freshness.currentLeaf = input.state.leaf + count)
    (freshProof : snapshotFresh kind input.commitGate = true)
    (persistenceProof : input.commitGate.persistenceSucceeded = true) :
    let result := tryCommit input kind source providerRequestAllowed fallbackNotice classicProviderPasses
    result.finalState.lastBoundaryParent = some (input.state.leaf + count) := by
  simp [tryCommit, freshProof, persistenceProof, commitOperation, committedState, currentLeafProof]

theorem bounded_auth_model_churn_rejects (auth : AuthResolution)
    (churnProof : 1 < auth.modelChangesDuringResolution) :
    authSnapshotCoherent auth = false := by
  simp [authSnapshotCoherent, Nat.not_le.mpr churnProof]

theorem threshold_continuation_dispatches_only_rebuilt_context
    (input : ContinuationInput)
    (thresholdProof : compactionThresholdReached input = true)
    (preparedProof : input.compactionPrepared = true)
    (committedProof : input.compactionCommitted = true)
    (rebuiltProof : input.rebuiltContextMatchesCommittedBoundary = true) :
    let result := runContinuation input
    result.decision = .compactThenDispatch ∧
    result.providerRequestAllowed = true ∧
    result.usedRebuiltContext = true ∧
    result.toolExecutionRepeated = false ∧
    result.committedBoundaryCount = 1 := by
  have thresholdParts :
      (input.compactionEnabled = true ∧ input.hasNextProviderRequest = true) ∧
        input.contextWindow ≤ input.liveContextTokens + input.reserveTokens := by
    simpa [compactionThresholdReached] using thresholdProof
  have nextProof : input.hasNextProviderRequest = true := thresholdParts.1.2
  simp [runContinuation, thresholdProof, nextProof, preparedProof, committedProof, rebuiltProof]

theorem failed_threshold_compaction_never_dispatches
    (input : ContinuationInput)
    (thresholdProof : compactionThresholdReached input = true)
    (failureProof : input.compactionPrepared = false ∨ input.compactionCommitted = false ∨
      input.rebuiltContextMatchesCommittedBoundary = false) :
    let result := runContinuation input
    result.decision = .stopWithoutDispatch ∧
    result.providerRequestAllowed = false ∧
    result.committedBoundaryCount = 0 := by
  have thresholdParts :
      (input.compactionEnabled = true ∧ input.hasNextProviderRequest = true) ∧
        input.contextWindow ≤ input.liveContextTokens + input.reserveTokens := by
    simpa [compactionThresholdReached] using thresholdProof
  have nextProof : input.hasNextProviderRequest = true := thresholdParts.1.2
  rcases failureProof with preparedProof | committedProof | rebuiltProof
  · simp [runContinuation, thresholdProof, nextProof, preparedProof]
  · simp [runContinuation, thresholdProof, nextProof, committedProof]
  · simp [runContinuation, thresholdProof, nextProof, rebuiltProof]

theorem no_continuation_never_compacts_or_dispatches
    (input : ContinuationInput)
    (nextProof : input.hasNextProviderRequest = false) :
    let result := runContinuation input
    result.decision = .stopWithoutDispatch ∧
    result.providerRequestAllowed = false ∧
    result.committedBoundaryCount = 0 := by
  simp [runContinuation, nextProof]

theorem missing_usage_details_normalize_to_zero :
    normalizedReasoningTokens { outputReasoningTokens := none } = 0 := by
  rfl

theorem target_coverage_preserves_existing_prefix
    (state : SessionState)
    (requestedCoverage : Nat) :
    boundaryCoverage state.boundary ≤ targetCoverage state requestedCoverage := by
  exact Nat.le_max_left _ _

theorem target_coverage_stays_inside_raw_history
    (state : SessionState)
    (requestedCoverage : Nat)
    (validState : stateValid state) :
    targetCoverage state requestedCoverage ≤ state.rawItemCount := by
  unfold targetCoverage
  exact (Nat.max_le).2 ⟨validState, Nat.min_le_right _ _⟩

theorem remote_source_covers_prefix_once
    (input : OperationInput)
    (_validState : stateValid input.state) :
    sourceValid input.state (remoteSource input) (targetCoverage input.state input.requestedCoverage) := by
  cases boundaryProof : input.state.boundary with
  | none => simp [remoteSource, sourceValid, boundaryProof]
  | compacted kind prior =>
      cases kind with
      | remote =>
          by_cases reusableProof : remoteReusable input.state input.target
          · simp only [remoteSource, boundaryProof, reusableProof, if_pos, sourceValid,
              boundaryCoverage, true_and]
            simpa [boundaryProof, boundaryCoverage] using
              target_coverage_preserves_existing_prefix input.state input.requestedCoverage
          · simp [remoteSource, sourceValid, boundaryProof, reusableProof]
      | classic =>
          simp only [remoteSource, boundaryProof, sourceValid, boundaryCoverage, true_and]
          simpa [boundaryProof, boundaryCoverage] using
            target_coverage_preserves_existing_prefix input.state input.requestedCoverage
      | extension =>
          simp only [remoteSource, boundaryProof, sourceValid, boundaryCoverage, true_and]
          simpa [boundaryProof, boundaryCoverage] using
            target_coverage_preserves_existing_prefix input.state input.requestedCoverage

theorem classic_source_covers_prefix_once
    (input : OperationInput)
    (_validState : stateValid input.state) :
    sourceValid input.state (classicSource input) (targetCoverage input.state input.requestedCoverage) := by
  cases boundaryProof : input.state.boundary with
  | none => simp [classicSource, sourceValid, boundaryProof]
  | compacted kind prior =>
      cases kind with
      | remote => simp [classicSource, sourceValid, boundaryProof]
      | classic =>
          simp only [classicSource, boundaryProof, sourceValid, boundaryCoverage, true_and]
          simpa [boundaryProof, boundaryCoverage] using
            target_coverage_preserves_existing_prefix input.state input.requestedCoverage
      | extension =>
          simp only [classicSource, boundaryProof, sourceValid, boundaryCoverage, true_and]
          simpa [boundaryProof, boundaryCoverage] using
            target_coverage_preserves_existing_prefix input.state input.requestedCoverage

theorem extension_source_covers_prefix_once (input : OperationInput) :
    sourceValid input.state (extensionSource input) (targetCoverage input.state input.requestedCoverage) := by
  simp [extensionSource, sourceValid]

theorem committed_state_is_valid
    (input : OperationInput)
    (kind : CompactionKind)
    (validState : stateValid input.state) :
    stateValid (committedState input.state kind (targetCoverage input.state input.requestedCoverage)
      input.commitGate.freshness.currentGeneration input.commitGate.freshness.currentLeaf) := by
  simpa [stateValid, committedState, boundaryCoverage] using
    target_coverage_stays_inside_raw_history input.state input.requestedCoverage validState

theorem no_commit_preserves_core
    (input : OperationInput)
    (decision : Decision)
    (providerRequestAllowed fallbackNotice : Bool)
    (validState : stateValid input.state) :
    coreInvariant input (noCommit input decision providerRequestAllowed fallbackNotice) := by
  simp [coreInvariant, noCommit, validState, committedSourceValid, commitPublicationOrdered, publicSafe]

theorem try_commit_preserves_core
    (input : OperationInput)
    (kind : CompactionKind)
    (source : CompactionSource)
    (providerRequestAllowed fallbackNotice : Bool)
    (classicProviderPasses : Nat)
    (validState : stateValid input.state)
    (validSource : sourceValid input.state source (targetCoverage input.state input.requestedCoverage)) :
    coreInvariant input
      (tryCommit input kind source providerRequestAllowed fallbackNotice classicProviderPasses) := by
  by_cases freshProof : snapshotFresh kind input.commitGate
  · by_cases persistenceProof : input.commitGate.persistenceSucceeded
    · simp only [tryCommit, freshProof, Bool.not_true, persistenceProof]
      constructor
      · exact committed_state_is_valid input kind validState
      constructor
      · rfl
      constructor
      · rfl
      constructor
      · exact Or.inr rfl
      constructor
      · change sourceValid input.state source (targetCoverage input.state input.requestedCoverage)
        exact validSource
      constructor
      · simp [commitPublicationOrdered, commitOperation, committedState, persistenceProof]
      · simp [commitOperation, publicSafe, publicObservation, observationConsistent]
    · simpa [tryCommit, freshProof, persistenceProof] using
        no_commit_preserves_core input .failed false fallbackNotice validState
  · simpa [tryCommit, freshProof] using
      no_commit_preserves_core input .stale false fallbackNotice validState

theorem successful_try_commit_is_durable_once_under_current_tail
    (input : OperationInput)
    (kind : CompactionKind)
    (source : CompactionSource)
    (providerRequestAllowed fallbackNotice : Bool)
    (classicProviderPasses : Nat)
    (freshProof : snapshotFresh kind input.commitGate = true)
    (persistenceProof : input.commitGate.persistenceSucceeded = true) :
    let result := tryCommit input kind source providerRequestAllowed fallbackNotice classicProviderPasses
    result.finalState.committedBoundaryCount = input.state.committedBoundaryCount + 1 ∧
    result.finalState.lastBoundaryParent = some input.commitGate.freshness.currentLeaf ∧
    result.commitTrace = [.persistBoundary, .publishBoundary] := by
  simp [tryCommit, freshProof, persistenceProof, commitOperation, committedState]

theorem classic_run_preserves_core
    (input : OperationInput)
    (providerRequestAllowedAfterCommit fallbackNotice : Bool)
    (validState : stateValid input.state) :
    coreInvariant input (runClassic input providerRequestAllowedAfterCommit fallbackNotice) := by
  by_cases historyProof : input.state.rawHistoryIntact
  · by_cases itemFitProof : input.everyRawItemFitsDestination
    · cases classicProof : input.classicResult with
      | succeeded providerPasses =>
          by_cases validFoldProof : classicFoldValid input providerPasses
          · simpa [runClassic, historyProof, itemFitProof, classicProof, validFoldProof] using
              try_commit_preserves_core input .classic (classicSource input)
                providerRequestAllowedAfterCommit fallbackNotice providerPasses validState
                (classic_source_covers_prefix_once input validState)
          · simpa [runClassic, historyProof, itemFitProof, classicProof, validFoldProof] using
              no_commit_preserves_core input .failed false fallbackNotice validState
      | failed =>
          simpa [runClassic, historyProof, itemFitProof, classicProof] using
            no_commit_preserves_core input .failed false fallbackNotice validState
      | cancelled =>
          simpa [runClassic, historyProof, itemFitProof, classicProof] using
            no_commit_preserves_core input .cancelled false fallbackNotice validState
    · simpa [runClassic, historyProof, itemFitProof] using
        no_commit_preserves_core input .failed false fallbackNotice validState
  · simpa [runClassic, historyProof] using
      no_commit_preserves_core input .failed false fallbackNotice validState

theorem migration_preserves_core
    (input : OperationInput)
    (validState : stateValid input.state) :
    coreInvariant input (runMigration input) := by
  by_cases extensionProof : input.extensionReplacementPresent
  · simpa [runMigration, extensionProof] using
      try_commit_preserves_core input .extension (extensionSource input) true false 0 validState
        (extension_source_covers_prefix_once input)
  · simpa [runMigration, extensionProof] using
      classic_run_preserves_core input true false validState

theorem explicit_compaction_preserves_core
    (input : OperationInput)
    (validState : stateValid input.state) :
    coreInvariant input (runExplicitCompaction input) := by
  by_cases extensionProof : input.extensionReplacementPresent
  · simpa [runExplicitCompaction, extensionProof] using
      try_commit_preserves_core input .extension (extensionSource input) false false 0 validState
        (extension_source_covers_prefix_once input)
  · by_cases enabledProof : input.target.remoteEnabled
    · by_cases responsesProof : input.target.responsesCapable
      · cases remoteProof : input.remoteResult with
        | succeeded =>
            simpa [runExplicitCompaction, extensionProof, enabledProof, responsesProof, remoteProof] using
              try_commit_preserves_core input .remote (remoteSource input) false false 0 validState
                (remote_source_covers_prefix_once input validState)
        | failed =>
            simpa [runExplicitCompaction, extensionProof, enabledProof, responsesProof, remoteProof] using
              classic_run_preserves_core input false true validState
        | cancelled =>
            simpa [runExplicitCompaction, extensionProof, enabledProof, responsesProof, remoteProof] using
              no_commit_preserves_core input .cancelled false false validState
      · simpa [runExplicitCompaction, extensionProof, enabledProof, responsesProof] using
          classic_run_preserves_core input false false validState
    · simpa [runExplicitCompaction, extensionProof, enabledProof] using
        classic_run_preserves_core input false false validState

theorem provider_request_preserves_core
    (input : OperationInput)
    (validState : stateValid input.state) :
    coreInvariant input (runProviderRequest input) := by
  cases boundaryProof : input.state.boundary with
  | none =>
      simpa [runProviderRequest, boundaryProof] using
        no_commit_preserves_core input .sendNormally true false validState
  | compacted kind prior =>
      cases kind with
      | remote =>
          by_cases reusableProof : remoteReusable input.state input.target
          · simpa [runProviderRequest, boundaryProof, reusableProof] using
              no_commit_preserves_core input .replayRemote true false validState
          · simpa [runProviderRequest, boundaryProof, reusableProof] using
              migration_preserves_core input validState
      | classic =>
          simpa [runProviderRequest, boundaryProof] using
            no_commit_preserves_core input .sendNormally true false validState
      | extension =>
          simpa [runProviderRequest, boundaryProof] using
            no_commit_preserves_core input .sendNormally true false validState

theorem every_operation_preserves_core
    (input : OperationInput)
    (validState : stateValid input.state) :
    coreInvariant input (runOperation input) := by
  cases triggerProof : input.trigger with
  | explicitCompaction =>
      simpa [runOperation, triggerProof] using explicit_compaction_preserves_core input validState
  | providerRequest =>
      simpa [runOperation, triggerProof] using provider_request_preserves_core input validState

theorem target_switch_without_request_is_inert
    (state : SessionState)
    (away back : ProviderTarget) :
    switchTarget (switchTarget state away) back = state := by
  rfl

theorem compatible_remote_request_replays_without_commit
    (input : OperationInput)
    (triggerProof : input.trigger = .providerRequest)
    (boundaryProof : ∃ covered, input.state.boundary = .compacted .remote covered)
    (reusableProof : remoteReusable input.state input.target = true) :
    let result := runOperation input
    result.decision = .replayRemote ∧
    result.providerRequestAllowed = true ∧
    result.finalState.committedBoundaryCount = input.state.committedBoundaryCount := by
  rcases boundaryProof with ⟨covered, boundaryProof⟩
  simp [runOperation, runProviderRequest, triggerProof, boundaryProof, reusableProof, noCommit]

theorem incompatible_remote_request_classic_migrates_before_dispatch
    (input : OperationInput)
    (triggerProof : input.trigger = .providerRequest)
    (boundaryProof : ∃ covered, input.state.boundary = .compacted .remote covered)
    (reusableProof : remoteReusable input.state input.target = false)
    (extensionProof : input.extensionReplacementPresent = false)
    (historyProof : input.state.rawHistoryIntact = true)
    (fitProof : input.everyRawItemFitsDestination = true)
    (requestFitProof : input.everyClassicRequestFitsDestination = true)
    (finalFitProof : input.classicFinalContextFitsDestination = true)
    (classicProof : ∃ passes, 0 < passes ∧ passes ≤ maxClassicProviderPasses ∧
      input.classicResult = .succeeded passes)
    (freshProof : snapshotFresh .classic input.commitGate = true)
    (persistenceProof : input.commitGate.persistenceSucceeded = true) :
    let result := runOperation input
    result.decision = .commitClassic ∧
    result.providerRequestAllowed = true ∧
    result.source = some (.rawPrefix (targetCoverage input.state input.requestedCoverage)) ∧
    result.publicBoundaryKind = some .classic := by
  rcases boundaryProof with ⟨covered, boundaryProof⟩
  rcases classicProof with ⟨passes, positiveProof, capProof, classicProof⟩
  simp [runOperation, runProviderRequest, runMigration, runClassic, classicFoldValid, triggerProof,
    boundaryProof, reusableProof, extensionProof, historyProof, fitProof, requestFitProof,
    finalFitProof, classicProof, positiveProof, capProof, tryCommit, freshProof, persistenceProof,
    commitOperation, classicSource, decisionForKind]

theorem remote_failure_commits_only_classic
    (input : OperationInput)
    (triggerProof : input.trigger = .explicitCompaction)
    (extensionProof : input.extensionReplacementPresent = false)
    (enabledProof : input.target.remoteEnabled = true)
    (responsesProof : input.target.responsesCapable = true)
    (remoteProof : input.remoteResult = .failed)
    (historyProof : input.state.rawHistoryIntact = true)
    (fitProof : input.everyRawItemFitsDestination = true)
    (requestFitProof : input.everyClassicRequestFitsDestination = true)
    (finalFitProof : input.classicFinalContextFitsDestination = true)
    (classicProof : ∃ passes, 0 < passes ∧ passes ≤ maxClassicProviderPasses ∧
      input.classicResult = .succeeded passes)
    (freshProof : snapshotFresh .classic input.commitGate = true)
    (persistenceProof : input.commitGate.persistenceSucceeded = true) :
    let result := runOperation input
    result.decision = .commitClassic ∧
    result.remoteFailureCommitted = false ∧
    result.fallbackNotice = true ∧
    result.finalState.committedBoundaryCount = input.state.committedBoundaryCount + 1 ∧
    result.publicBoundaryKind = some .classic := by
  rcases classicProof with ⟨passes, positiveProof, capProof, classicProof⟩
  simp [runOperation, runExplicitCompaction, runClassic, classicFoldValid, triggerProof,
    extensionProof, enabledProof, responsesProof, remoteProof, historyProof, fitProof, requestFitProof,
    finalFitProof, classicProof, positiveProof, capProof, tryCommit, freshProof, persistenceProof,
    commitOperation, committedState, decisionForKind]

theorem remote_cancellation_never_falls_back
    (input : OperationInput)
    (triggerProof : input.trigger = .explicitCompaction)
    (extensionProof : input.extensionReplacementPresent = false)
    (enabledProof : input.target.remoteEnabled = true)
    (responsesProof : input.target.responsesCapable = true)
    (remoteProof : input.remoteResult = .cancelled) :
    let result := runOperation input
    result.decision = .cancelled ∧
    result.committedObservation = none ∧
    result.classicProviderPasses = 0 ∧
    result.finalState = input.state := by
  simp [runOperation, runExplicitCompaction, triggerProof, extensionProof, enabledProof, responsesProof,
    remoteProof, noCommit]

theorem oversized_indivisible_history_fails_without_commit
    (input : OperationInput)
    (triggerProof : input.trigger = .providerRequest)
    (boundaryProof : ∃ covered, input.state.boundary = .compacted .remote covered)
    (reusableProof : remoteReusable input.state input.target = false)
    (extensionProof : input.extensionReplacementPresent = false)
    (historyProof : input.state.rawHistoryIntact = true)
    (fitProof : input.everyRawItemFitsDestination = false) :
    let result := runOperation input
    result.decision = .failed ∧
    result.providerRequestAllowed = false ∧
    result.finalState = input.state := by
  rcases boundaryProof with ⟨covered, boundaryProof⟩
  simp [runOperation, runProviderRequest, runMigration, runClassic, triggerProof, boundaryProof,
    reusableProof, extensionProof, historyProof, fitProof, noCommit]

theorem invalid_classic_bounds_fail_without_commit
    (input : OperationInput)
    (providerPasses : Nat)
    (historyProof : input.state.rawHistoryIntact = true)
    (classicProof : input.classicResult = .succeeded providerPasses)
    (invalidFoldProof : classicFoldValid input providerPasses = false) :
    let result := runClassic input true false
    result.decision = .failed ∧ result.providerRequestAllowed = false ∧ result.finalState = input.state := by
  by_cases itemFitProof : input.everyRawItemFitsDestination
  · simp [runClassic, historyProof, itemFitProof, classicProof, invalidFoldProof, noCommit]
  · simp [runClassic, historyProof, itemFitProof, noCommit]

theorem thirty_three_passes_cannot_commit
    (input : OperationInput)
    (historyProof : input.state.rawHistoryIntact = true)
    (classicProof : input.classicResult = .succeeded 33) :
    let result := runClassic input true false
    result.decision = .failed ∧ result.providerRequestAllowed = false ∧ result.finalState = input.state := by
  apply invalid_classic_bounds_fail_without_commit input 33 historyProof classicProof
  simp [classicFoldValid, maxClassicProviderPasses]

-- Concrete multi-round trace covers remote, repeated remote, inert switch, then request-time classic migration.
private def fullyOpenAuth : AuthResolution :=
  {
    resolvedBeforeProducerSnapshot := true
    modelChangesDuringResolution := 0
    authModelMatchesSnapshotModel := true
  }

private def fullyFreshEvidence (state : SessionState) (tailChange : TailChange := .none) : FreshnessEvidence :=
  {
    sameSession := true
    sameGeneration := true
    sameLeaf := true
    rawBranchContentUnchanged := true
    canonicalFilteredSourceUnchanged := true
    effectiveModelUnchanged := true
    effectiveThinkingUnchanged := true
    sourceLeafOnCurrentLineage := true
    anchorOnSourceLineage := true
    currentGeneration := currentGenerationAfterTail state tailChange
    currentLeaf := currentLeafAfterTail state tailChange
    tailChange
    auth := fullyOpenAuth
  }

private def fullyOpenGate (state : SessionState) (tailChange : TailChange := .none) : CommitGate :=
  { freshness := fullyFreshEvidence state tailChange, persistenceSucceeded := true }

private def remoteTarget (compatible : Bool) : ProviderTarget :=
  { responsesCapable := true, remoteEnabled := true, remoteCheckpointCompatible := compatible }

private def initialState : SessionState :=
  {
    boundary := .none
    privateRemotePresent := false
    rawHistoryIntact := true
    rawItemCount := 12
    committedBoundaryCount := 0
    generation := 12
    leaf := 12
    lastBoundaryParent := none
  }

private def firstRemoteInput : OperationInput :=
  {
    trigger := .explicitCompaction
    state := initialState
    target := remoteTarget false
    extensionReplacementPresent := false
    requestedCoverage := 8
    remoteResult := .succeeded
    classicResult := .succeeded 1
    everyRawItemFitsDestination := true
    everyClassicRequestFitsDestination := true
    classicFinalContextFitsDestination := true
    commitGate := fullyOpenGate initialState
  }

private def firstRemoteResult : OperationResult := runOperation firstRemoteInput

private def secondRemoteState : SessionState := appendRawItems firstRemoteResult.finalState 4

private def secondRemoteInput : OperationInput :=
  {
    trigger := .explicitCompaction
    state := secondRemoteState
    target := remoteTarget true
    extensionReplacementPresent := false
    requestedCoverage := 12
    remoteResult := .succeeded
    classicResult := .succeeded 1
    everyRawItemFitsDestination := true
    everyClassicRequestFitsDestination := true
    classicFinalContextFitsDestination := true
    commitGate := fullyOpenGate secondRemoteState
  }

private def secondRemoteResult : OperationResult := runOperation secondRemoteInput

private def migratedState : SessionState := switchTarget secondRemoteResult.finalState (remoteTarget false)

private def migrationInput : OperationInput :=
  {
    trigger := .providerRequest
    state := migratedState
    target := remoteTarget false
    extensionReplacementPresent := false
    requestedCoverage := 12
    remoteResult := .succeeded
    classicResult := .succeeded 3
    everyRawItemFitsDestination := true
    everyClassicRequestFitsDestination := true
    classicFinalContextFitsDestination := true
    commitGate := fullyOpenGate migratedState
  }

private def migrationResult : OperationResult := runOperation migrationInput

def multiRoundRemoteThenRequestTimeClassicPreservesRanges : Prop :=
    firstRemoteResult.decision = .commitRemote ∧
    firstRemoteResult.source = some (.rawPrefix 8) ∧
    secondRemoteResult.decision = .commitRemote ∧
    secondRemoteResult.source = some (.priorBoundaryAndDelta 8 12) ∧
    migrationResult.decision = .commitClassic ∧
    migrationResult.source = some (.rawPrefix 12) ∧
    migrationResult.classicProviderPasses = 3 ∧
    migrationResult.providerRequestAllowed = true ∧
    migrationResult.finalState.committedBoundaryCount = 3

theorem multi_round_remote_then_request_time_classic_preserves_ranges :
    multiRoundRemoteThenRequestTimeClassicPreservesRanges := by
  simp [multiRoundRemoteThenRequestTimeClassicPreservesRanges, firstRemoteResult, firstRemoteInput,
    secondRemoteResult, secondRemoteInput, secondRemoteState, migratedState, migrationResult,
    migrationInput, runOperation, runExplicitCompaction, runProviderRequest, runMigration, runClassic,
    classicFoldValid, maxClassicProviderPasses, tryCommit, commitOperation, remoteSource, classicSource,
    remoteReusable, targetCoverage,
    boundaryCoverage, appendRawItems, switchTarget, fullyOpenGate, fullyFreshEvidence, fullyOpenAuth,
    authSnapshotCoherent, tailAcceptableForPi, remoteTarget, initialState, firstRemoteInput,
    firstRemoteResult, committedState, decisionForKind, snapshotFresh]

-- Termination and top-level correctness combine freshness, auth coherence, durable publication, migration, range, observability, safety, and liveness guarantees.
theorem process_terminates_with_one_result (input : OperationInput) :
    ∃ result, runOperation input = result := by
  exact ⟨runOperation input, rfl⟩

theorem process_is_correct :
    (∀ input, stateValid input.state → coreInvariant input (runOperation input)) ∧
    (∀ state away back, switchTarget (switchTarget state away) back = state) ∧
    (∀ input, stateValid input.state → sourceValid input.state (remoteSource input)
      (targetCoverage input.state input.requestedCoverage)) ∧
    (∀ input, stateValid input.state → sourceValid input.state (classicSource input)
      (targetCoverage input.state input.requestedCoverage)) ∧
    (∀ gate, snapshotFresh .extension gate =
      (gate.freshness.sameSession && authSnapshotCoherent gate.freshness.auth &&
        gate.freshness.sourceLeafOnCurrentLineage && gate.freshness.anchorOnSourceLineage &&
        gate.freshness.sameGeneration && gate.freshness.sameLeaf &&
        gate.freshness.rawBranchContentUnchanged)) ∧
    (∀ gate, snapshotFresh .classic gate =
      (gate.freshness.sameSession && authSnapshotCoherent gate.freshness.auth &&
        gate.freshness.sourceLeafOnCurrentLineage && gate.freshness.anchorOnSourceLineage &&
        gate.freshness.canonicalFilteredSourceUnchanged && gate.freshness.effectiveModelUnchanged &&
        gate.freshness.effectiveThinkingUnchanged && tailAcceptableForPi gate.freshness.tailChange)) ∧
    (∀ gate, snapshotFresh .remote gate =
      (gate.freshness.sameSession && authSnapshotCoherent gate.freshness.auth &&
        gate.freshness.sourceLeafOnCurrentLineage && gate.freshness.anchorOnSourceLineage &&
        gate.freshness.canonicalFilteredSourceUnchanged && gate.freshness.effectiveModelUnchanged &&
        gate.freshness.effectiveThinkingUnchanged && tailAcceptableForPi gate.freshness.tailChange)) ∧
    (∀ count, tailAcceptableForPi (.irrelevantAppend count) = true) ∧
    tailAcceptableForPi .relevantAppend = false ∧
    (∀ input kind source requestAllowed notice passes count,
      input.commitGate.freshness.currentLeaf = input.state.leaf + count →
      snapshotFresh kind input.commitGate = true → input.commitGate.persistenceSucceeded = true →
      let result := tryCommit input kind source requestAllowed notice passes
      result.finalState.lastBoundaryParent = some (input.state.leaf + count)) ∧
    (∀ auth, 1 < auth.modelChangesDuringResolution → authSnapshotCoherent auth = false) ∧
    (∀ input kind source requestAllowed notice passes,
      snapshotFresh kind input.commitGate = true → input.commitGate.persistenceSucceeded = true →
      let result := tryCommit input kind source requestAllowed notice passes
      result.finalState.committedBoundaryCount = input.state.committedBoundaryCount + 1 ∧
      result.finalState.lastBoundaryParent = some input.commitGate.freshness.currentLeaf ∧
      result.commitTrace = [.persistBoundary, .publishBoundary]) ∧
    multiRoundRemoteThenRequestTimeClassicPreservesRanges ∧
    (∀ input, input.state.rawHistoryIntact = true → input.classicResult = .succeeded 33 →
      let result := runClassic input true false
      result.decision = .failed ∧ result.providerRequestAllowed = false ∧ result.finalState = input.state) ∧
    normalizedReasoningTokens { outputReasoningTokens := none } = 0 ∧
    (∀ input, compactionThresholdReached input = true → input.compactionPrepared = true →
      input.compactionCommitted = true → input.rebuiltContextMatchesCommittedBoundary = true →
      let result := runContinuation input
      result.decision = .compactThenDispatch ∧ result.providerRequestAllowed = true ∧
      result.usedRebuiltContext = true ∧ result.toolExecutionRepeated = false ∧
      result.committedBoundaryCount = 1) ∧
    (∀ input, compactionThresholdReached input = true →
      (input.compactionPrepared = false ∨ input.compactionCommitted = false ∨
        input.rebuiltContextMatchesCommittedBoundary = false) →
      let result := runContinuation input
      result.decision = .stopWithoutDispatch ∧ result.providerRequestAllowed = false ∧
      result.committedBoundaryCount = 0) ∧
    (∀ input, input.hasNextProviderRequest = false →
      let result := runContinuation input
      result.decision = .stopWithoutDispatch ∧ result.providerRequestAllowed = false ∧
      result.committedBoundaryCount = 0) ∧
    (∀ input, ∃ result, runOperation input = result) := by
  constructor
  · exact every_operation_preserves_core
  constructor
  · exact target_switch_without_request_is_inert
  constructor
  · intro input validState
    exact remote_source_covers_prefix_once input validState
  constructor
  · intro input validState
    exact classic_source_covers_prefix_once input validState
  constructor
  · exact extension_freshness_is_exact
  constructor
  · intro gate
    exact pi_freshness_is_filtered_and_dependency_aware .classic (Or.inl rfl) gate
  constructor
  · intro gate
    exact pi_freshness_is_filtered_and_dependency_aware .remote (Or.inr rfl) gate
  constructor
  · exact irrelevant_tail_is_acceptable_for_pi
  constructor
  · exact relevant_tail_is_rejected_for_pi
  constructor
  · exact irrelevant_tail_commit_uses_current_leaf
  constructor
  · exact bounded_auth_model_churn_rejects
  constructor
  · exact successful_try_commit_is_durable_once_under_current_tail
  constructor
  · exact multi_round_remote_then_request_time_classic_preserves_ranges
  constructor
  · exact thirty_three_passes_cannot_commit
  constructor
  · exact missing_usage_details_normalize_to_zero
  constructor
  · exact threshold_continuation_dispatches_only_rebuilt_context
  constructor
  · exact failed_threshold_compaction_never_dispatches
  constructor
  · exact no_continuation_never_compacts_or_dispatches
  · exact process_terminates_with_one_result

#print axioms process_is_correct

-- Executable summary reports the modeled request-time migration outcome.
private def describeDecision : Decision → String
  | .sendNormally => "send normally"
  | .replayRemote => "replay compatible Responses compaction"
  | .commitRemote => "commit Responses compaction"
  | .commitClassic => "commit classic compaction before request"
  | .commitExtension => "commit extension compaction"
  | .cancelled => "cancel without fallback"
  | .failed => "fail without commit"
  | .stale => "reject stale commit"

end ProviderTransparentCompaction

def main : IO Unit := do
  let result := ProviderTransparentCompaction.migrationResult
  IO.println s!"Example: {ProviderTransparentCompaction.describeDecision result.decision}"
  IO.println s!"Boundary count: {result.finalState.committedBoundaryCount}; classic passes: {result.classicProviderPasses}; request allowed: {result.providerRequestAllowed}"
  IO.println "Proved: producer-aware freshness, bounded auth/model coherence, inert target switching, request-boundary migration, compatible remote replay, exact range coverage, request/final-context fit with 1..32 classic passes, invalid-fold no-commit/no-dispatch, persist-before-publish single-boundary commit, pre-provider threshold compaction with rebuilt-context dispatch, no repeated tool execution, public kind consistency, opaque-state privacy, and zero-default optional usage details."
