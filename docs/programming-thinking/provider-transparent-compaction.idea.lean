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

-- Durable process data keeps raw history authoritative while tracking one public boundary and private remote availability.
structure SessionState where
  boundary : Boundary
  privateRemotePresent : Bool
  rawHistoryIntact : Bool
  rawItemCount : Nat
  committedBoundaryCount : Nat
  generation : Nat
  leaf : Nat
  deriving DecidableEq, Repr

structure ProviderTarget where
  responsesCapable : Bool
  remoteEnabled : Bool
  remoteCheckpointCompatible : Bool
  deriving DecidableEq, Repr

structure CommitGate where
  sameSession : Bool
  sameGeneration : Bool
  sameLeaf : Bool
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
  deriving DecidableEq, Repr

-- Guards and range selectors choose compatible replay, full raw re-derivation, or prior-boundary-plus-delta exactly once.
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

def snapshotFresh (gate : CommitGate) : Bool :=
  gate.sameSession && gate.sameGeneration && gate.sameLeaf

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
def committedState (state : SessionState) (kind : CompactionKind) (coveredPrefix : Nat) : SessionState :=
  {
    boundary := .compacted kind coveredPrefix
    privateRemotePresent := kind == .remote
    rawHistoryIntact := state.rawHistoryIntact
    rawItemCount := state.rawItemCount
    committedBoundaryCount := state.committedBoundaryCount + 1
    generation := state.generation + 1
    leaf := state.leaf + 1
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
  }

def tryCommit
    (input : OperationInput)
    (kind : CompactionKind)
    (source : CompactionSource)
    (providerRequestAllowed : Bool)
    (fallbackNotice : Bool)
    (classicProviderPasses : Nat) : OperationResult :=
  if !snapshotFresh input.commitGate then
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

-- Invariants require intact raw history, valid range coverage, bounded single commit, consistent public kind, and opaque privacy.
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
  publicSafe result

-- Supporting lemmas prove coverage bounds, source continuity, state preservation, and every state-machine branch.
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
    stateValid (committedState input.state kind (targetCoverage input.state input.requestedCoverage)) := by
  simpa [stateValid, committedState, boundaryCoverage] using
    target_coverage_stays_inside_raw_history input.state input.requestedCoverage validState

theorem no_commit_preserves_core
    (input : OperationInput)
    (decision : Decision)
    (providerRequestAllowed fallbackNotice : Bool)
    (validState : stateValid input.state) :
    coreInvariant input (noCommit input decision providerRequestAllowed fallbackNotice) := by
  simp [coreInvariant, noCommit, validState, committedSourceValid, publicSafe]

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
  by_cases freshProof : snapshotFresh input.commitGate
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
      · simp [commitOperation, publicSafe, publicObservation, observationConsistent]
    · simpa [tryCommit, freshProof, persistenceProof] using
        no_commit_preserves_core input .failed false fallbackNotice validState
  · simpa [tryCommit, freshProof] using
      no_commit_preserves_core input .stale false fallbackNotice validState

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
    (freshProof : snapshotFresh input.commitGate = true)
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
    (freshProof : snapshotFresh input.commitGate = true)
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
private def fullyOpenGate : CommitGate :=
  { sameSession := true, sameGeneration := true, sameLeaf := true, persistenceSucceeded := true }

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
    commitGate := fullyOpenGate
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
    commitGate := fullyOpenGate
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
    commitGate := fullyOpenGate
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
    boundaryCoverage, appendRawItems, switchTarget, fullyOpenGate, remoteTarget,
    initialState, firstRemoteInput, firstRemoteResult, committedState, decisionForKind, snapshotFresh]

-- Termination and top-level correctness combine all modeled safety, migration, range, observability, and liveness guarantees.
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
    multiRoundRemoteThenRequestTimeClassicPreservesRanges ∧
    (∀ input, input.state.rawHistoryIntact = true → input.classicResult = .succeeded 33 →
      let result := runClassic input true false
      result.decision = .failed ∧ result.providerRequestAllowed = false ∧ result.finalState = input.state) ∧
    normalizedReasoningTokens { outputReasoningTokens := none } = 0 ∧
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
  · exact multi_round_remote_then_request_time_classic_preserves_ranges
  constructor
  · exact thirty_three_passes_cannot_commit
  constructor
  · exact missing_usage_details_normalize_to_zero
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
  IO.println "Proved: inert target switching, request-boundary migration, compatible remote replay, exact range coverage, request/final-context fit with 1..32 classic passes, invalid-fold no-commit/no-dispatch, atomic single commit, public kind consistency, opaque-state privacy, and zero-default optional usage details."
