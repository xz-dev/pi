-- The model uses Lean's standard library and forbids undeclared implicit process vocabulary.
import Std

set_option autoImplicit false

namespace UpdateCleanWin32Safety

-- Both self-update and cleanup contend for one install-root lock; no second owner may enter.
inductive InstallOperation where
  | selfUpdate
  | cleanup
  deriving DecidableEq, Repr

structure InstallLockState where
  owner : Option InstallOperation
  deriving DecidableEq, Repr

def acquireInstallLock
    (operation : InstallOperation)
    (state : InstallLockState) : Option InstallLockState :=
  match state.owner with
  | none => some { owner := some operation }
  | some _ => none

def releaseInstallLock (state : InstallLockState) : InstallLockState :=
  { state with owner := none }

def SharedInstallLockContract : Prop :=
  (∀ operation : InstallOperation,
    acquireInstallLock operation { owner := none } =
      some { owner := some operation }) ∧
  (∀ (first second : InstallOperation),
    acquireInstallLock second { owner := some first } = none) ∧
  (∀ operation : InstallOperation,
    releaseInstallLock { owner := some operation } = { owner := none })

theorem shared_install_lock_is_correct : SharedInstallLockContract := by
  simp [SharedInstallLockContract, acquireInstallLock, releaseInstallLock]

-- Activation outcomes distinguish destination validation, isolated helper probing, pointer snapshot changes, publication, and restoration failure.
inductive ActivationFailure where
  | invalidDestination
  | invalidHelperProbe
  | invalidPointer
  | publicationFailure
  | restorationFailure
  deriving DecidableEq, Repr

inductive ActivationPublicationOutcome where
  | success
  | publicationFailsRestoreSucceeds
  | publicationFailsRestoreFails
  deriving DecidableEq, Repr

-- Activation input and state separate a legacy flat install from a validated managed current and recovery evidence.
structure BundleActivationInput where
  current : Option Nat
  previous : Option Nat
  destination : Nat
  destinationValid : Bool
  helperProbeValid : Bool
  pointerSnapshotStable : Bool
  publicationOutcome : ActivationPublicationOutcome
  deriving DecidableEq, Repr

structure BundleActivationState where
  current : Option Nat
  previous : Option Nat
  lockHeld : Bool
  currentPublished : Bool
  previousPublished : Bool
  recoveryDataRetained : Bool
  failure : Option ActivationFailure
  deriving DecidableEq, Repr

-- Activation transitions run while locked, omit first-update rollback, and preserve or retain pointer recovery state.
def initialBundleActivationState
    (input : BundleActivationInput) : BundleActivationState :=
  { current := input.current
    previous := input.previous
    lockHeld := false
    currentPublished := false
    previousPublished := false
    recoveryDataRetained := false
    failure := none }

def validateAndPublishBundleActivation
    (input : BundleActivationInput) : BundleActivationState :=
  let locked := { initialBundleActivationState input with lockHeld := true }
  if !input.destinationValid then
    { locked with failure := some .invalidDestination }
  else if !input.helperProbeValid then
    { locked with failure := some .invalidHelperProbe }
  else if !input.pointerSnapshotStable then
    { locked with failure := some .invalidPointer }
  else
    match input.publicationOutcome with
    | .publicationFailsRestoreSucceeds =>
        { locked with failure := some .publicationFailure }
    | .publicationFailsRestoreFails =>
        { locked with
          previous := none
          recoveryDataRetained := true
          failure := some .restorationFailure }
    | .success =>
        match input.current with
        | none =>
            { locked with
              current := some input.destination
              previous := none
              currentPublished := true }
        | some current =>
            { locked with
              current := some input.destination
              previous := if current = input.destination then input.previous else some current
              currentPublished := true
              previousPublished := current != input.destination }

def releaseBundleActivationLock
    (state : BundleActivationState) : BundleActivationState :=
  { state with lockHeld := false }

def runBundleActivation
    (input : BundleActivationInput) : BundleActivationState :=
  releaseBundleActivationLock (validateAndPublishBundleActivation input)

-- The activation contract proves fail-closed destination and isolated-helper validation, pointer stability, restoration, first-update omission, and later rollback publication.
def BundleActivationContract : Prop :=
  (∀ input : BundleActivationInput,
    input.destinationValid = false →
      let finalState := runBundleActivation input
      finalState.current = input.current ∧
      finalState.previous = input.previous ∧
      finalState.lockHeld = false ∧
      finalState.currentPublished = false ∧
      finalState.previousPublished = false ∧
      finalState.failure = some .invalidDestination) ∧
  (∀ input : BundleActivationInput,
    input.destinationValid = true →
    input.helperProbeValid = false →
      let finalState := runBundleActivation input
      finalState.current = input.current ∧
      finalState.previous = input.previous ∧
      finalState.lockHeld = false ∧
      finalState.currentPublished = false ∧
      finalState.previousPublished = false ∧
      finalState.failure = some .invalidHelperProbe) ∧
  (∀ input : BundleActivationInput,
    input.destinationValid = true →
    input.helperProbeValid = true →
    input.pointerSnapshotStable = false →
      let finalState := runBundleActivation input
      finalState.current = input.current ∧
      finalState.previous = input.previous ∧
      finalState.lockHeld = false ∧
      finalState.currentPublished = false ∧
      finalState.previousPublished = false ∧
      finalState.failure = some .invalidPointer) ∧
  (∀ input : BundleActivationInput,
    input.destinationValid = true →
    input.helperProbeValid = true →
    input.pointerSnapshotStable = true →
    input.publicationOutcome = .publicationFailsRestoreSucceeds →
      let finalState := runBundleActivation input
      finalState.current = input.current ∧
      finalState.previous = input.previous ∧
      finalState.lockHeld = false ∧
      finalState.currentPublished = false ∧
      finalState.previousPublished = false ∧
      finalState.recoveryDataRetained = false ∧
      finalState.failure = some .publicationFailure) ∧
  (∀ input : BundleActivationInput,
    input.destinationValid = true →
    input.helperProbeValid = true →
    input.pointerSnapshotStable = true →
    input.publicationOutcome = .publicationFailsRestoreFails →
      let finalState := runBundleActivation input
      finalState.current = input.current ∧
      finalState.previous = none ∧
      finalState.lockHeld = false ∧
      finalState.currentPublished = false ∧
      finalState.recoveryDataRetained = true ∧
      finalState.failure = some .restorationFailure) ∧
  (∀ input : BundleActivationInput,
    input.destinationValid = true →
    input.helperProbeValid = true →
    input.pointerSnapshotStable = true →
    input.publicationOutcome = .success →
    input.current = none →
    input.previous = none →
      let finalState := runBundleActivation input
      finalState.current = some input.destination ∧
      finalState.previous = none ∧
      finalState.lockHeld = false ∧
      finalState.currentPublished = true ∧
      finalState.previousPublished = false) ∧
  (∀ (input : BundleActivationInput) (current : Nat),
    input.destinationValid = true →
    input.helperProbeValid = true →
    input.pointerSnapshotStable = true →
    input.publicationOutcome = .success →
    input.current = some current →
    current ≠ input.destination →
      let finalState := runBundleActivation input
      finalState.current = some input.destination ∧
      finalState.previous = some current ∧
      finalState.lockHeld = false ∧
      finalState.currentPublished = true ∧
      finalState.previousPublished = true) ∧
  (∀ (input : BundleActivationInput) (current : Nat),
    input.destinationValid = true →
    input.helperProbeValid = true →
    input.pointerSnapshotStable = true →
    input.publicationOutcome = .success →
    input.current = some current →
    current = input.destination →
      let finalState := runBundleActivation input
      finalState.current = some input.destination ∧
      finalState.previous = input.previous ∧
      finalState.lockHeld = false ∧
      finalState.currentPublished = true ∧
      finalState.previousPublished = false ∧
      finalState.failure = none)

theorem bundle_activation_is_correct : BundleActivationContract := by
  constructor
  · intro input hinvalid
    simp [runBundleActivation, releaseBundleActivationLock,
      validateAndPublishBundleActivation, initialBundleActivationState,
      hinvalid]
  constructor
  · intro input hvalid hprobe
    simp [runBundleActivation, releaseBundleActivationLock,
      validateAndPublishBundleActivation, initialBundleActivationState,
      hvalid, hprobe]
  constructor
  · intro input hvalid hprobe hpointers
    simp [runBundleActivation, releaseBundleActivationLock,
      validateAndPublishBundleActivation, initialBundleActivationState,
      hvalid, hprobe, hpointers]
  constructor
  · intro input hvalid hprobe hpointers houtcome
    simp [runBundleActivation, releaseBundleActivationLock,
      validateAndPublishBundleActivation, initialBundleActivationState,
      hvalid, hprobe, hpointers, houtcome]
  constructor
  · intro input hvalid hprobe hpointers houtcome
    simp [runBundleActivation, releaseBundleActivationLock,
      validateAndPublishBundleActivation, initialBundleActivationState,
      hvalid, hprobe, hpointers, houtcome]
  constructor
  · intro input hvalid hprobe hpointers houtcome hcurrent hprevious
    simp [runBundleActivation, releaseBundleActivationLock,
      validateAndPublishBundleActivation, initialBundleActivationState,
      hvalid, hprobe, hpointers, houtcome, hcurrent, hprevious]
  constructor
  · intro input current hvalid hprobe hpointers houtcome hcurrent hdifferent
    simp [runBundleActivation, releaseBundleActivationLock,
      validateAndPublishBundleActivation, initialBundleActivationState,
      hvalid, hprobe, hpointers, houtcome, hcurrent, hdifferent]
  · intro input current hvalid hprobe hpointers houtcome hcurrent hsame
    subst hsame
    simp [runBundleActivation, releaseBundleActivationLock,
      validateAndPublishBundleActivation, initialBundleActivationState,
      hvalid, hprobe, hpointers, houtcome, hcurrent]

-- Cleanup outcomes distinguish candidate protection, quarantine validation, restoration, conflict, and deletion failure.
inductive BundleFailure where
  | invalidPointer
  | invalidTarget
  | invalidCandidate
  | quarantineFailure
  | revalidationFailure
  | restorationFailure
  | originalPathConflict
  | deletionFailure
  deriving DecidableEq, Repr

inductive CandidateLocation where
  | visible
  | quarantined
  | conflictAndQuarantined
  | deleted
  deriving DecidableEq, Repr

inductive PostRenameOutcome where
  | valid
  | revalidationFailsRestoreSucceeds
  | revalidationFailsRestoreFails
  | revalidationFailsOriginalPathConflicts
  deriving DecidableEq, Repr

-- Candidate input and state carry the protected pointers, validation decisions, location, lock, and preserved failure evidence.
structure BundleCandidateInput where
  executing : Nat
  current : Nat
  previous : Option Nat
  candidate : Nat
  pointerSnapshotBounded : Bool
  pointerTargetValid : Bool
  candidateValid : Bool
  quarantineUnique : Bool
  postRenameOutcome : PostRenameOutcome
  deletionSucceeds : Bool
  deriving DecidableEq, Repr

structure BundleCandidateState where
  current : Nat
  previous : Option Nat
  location : CandidateLocation
  lockHeld : Bool
  recursivelyDeleted : Bool
  originalValidationFailureRetained : Bool
  failure : Option BundleFailure
  deriving DecidableEq, Repr

-- Cleanup transitions validate pointers and candidates while locked, restore failed revalidation, then delete only after unlock.
def initialBundleCandidateState
    (input : BundleCandidateInput) : BundleCandidateState :=
  { current := input.current
    previous := input.previous
    location := .visible
    lockHeld := false
    recursivelyDeleted := false
    originalValidationFailureRetained := false
    failure := none }

def protectedCandidate (input : BundleCandidateInput) : Bool :=
  input.candidate = input.executing ||
    input.candidate = input.current ||
    input.previous == some input.candidate

def validateAndQuarantineCandidate
    (input : BundleCandidateInput) : BundleCandidateState :=
  let initial := initialBundleCandidateState input
  let locked := { initial with lockHeld := true }
  if !input.pointerSnapshotBounded then
    { locked with failure := some .invalidPointer }
  else if !input.pointerTargetValid then
    { locked with failure := some .invalidTarget }
  else if protectedCandidate input then
    locked
  else if !input.candidateValid then
    { locked with failure := some .invalidCandidate }
  else if !input.quarantineUnique then
    { locked with failure := some .quarantineFailure }
  else
    match input.postRenameOutcome with
    | .valid =>
        { locked with location := .quarantined }
    | .revalidationFailsRestoreSucceeds =>
        { locked with
          location := .visible
          originalValidationFailureRetained := true
          failure := some .revalidationFailure }
    | .revalidationFailsRestoreFails =>
        { locked with
          location := .quarantined
          originalValidationFailureRetained := true
          failure := some .restorationFailure }
    | .revalidationFailsOriginalPathConflicts =>
        { locked with
          location := .conflictAndQuarantined
          originalValidationFailureRetained := true
          failure := some .originalPathConflict }

def releaseCandidateLock
    (state : BundleCandidateState) : BundleCandidateState :=
  { state with lockHeld := false }

def recursivelyDeleteQuarantine
    (input : BundleCandidateInput)
    (state : BundleCandidateState) : BundleCandidateState :=
  if state.lockHeld then
    state
  else if state.location != .quarantined || state.failure.isSome then
    state
  else if input.deletionSucceeds then
    { state with location := .deleted, recursivelyDeleted := true }
  else
    { state with failure := some .deletionFailure }

def runBundleCandidateCleanup
    (input : BundleCandidateInput) : BundleCandidateState :=
  let validated := validateAndQuarantineCandidate input
  let released := releaseCandidateLock validated
  recursivelyDeleteQuarantine input released

-- The cleanup contract covers every modeled validation, protection, deletion, and recovery outcome while preserving pointers.
def BundleCleanupContract : Prop :=
  (∀ input : BundleCandidateInput,
    input.pointerSnapshotBounded = false →
      let finalState := runBundleCandidateCleanup input
      finalState.current = input.current ∧
      finalState.previous = input.previous ∧
      finalState.location = .visible ∧
      finalState.lockHeld = false ∧
      finalState.recursivelyDeleted = false ∧
      finalState.failure = some .invalidPointer) ∧
  (∀ input : BundleCandidateInput,
    input.pointerSnapshotBounded = true →
    input.pointerTargetValid = false →
      let finalState := runBundleCandidateCleanup input
      finalState.current = input.current ∧
      finalState.previous = input.previous ∧
      finalState.location = .visible ∧
      finalState.lockHeld = false ∧
      finalState.recursivelyDeleted = false ∧
      finalState.failure = some .invalidTarget) ∧
  (∀ input : BundleCandidateInput,
    input.pointerSnapshotBounded = true →
    input.pointerTargetValid = true →
    protectedCandidate input = true →
      let finalState := runBundleCandidateCleanup input
      finalState.current = input.current ∧
      finalState.previous = input.previous ∧
      finalState.location = .visible ∧
      finalState.lockHeld = false ∧
      finalState.recursivelyDeleted = false ∧
      finalState.failure = none) ∧
  (∀ input : BundleCandidateInput,
    input.pointerSnapshotBounded = true →
    input.pointerTargetValid = true →
    protectedCandidate input = false →
    input.candidateValid = false →
      let finalState := runBundleCandidateCleanup input
      finalState.current = input.current ∧
      finalState.previous = input.previous ∧
      finalState.location = .visible ∧
      finalState.lockHeld = false ∧
      finalState.recursivelyDeleted = false ∧
      finalState.failure = some .invalidCandidate) ∧
  (∀ input : BundleCandidateInput,
    input.pointerSnapshotBounded = true →
    input.pointerTargetValid = true →
    protectedCandidate input = false →
    input.candidateValid = true →
    input.quarantineUnique = false →
      let finalState := runBundleCandidateCleanup input
      finalState.current = input.current ∧
      finalState.previous = input.previous ∧
      finalState.location = .visible ∧
      finalState.lockHeld = false ∧
      finalState.recursivelyDeleted = false ∧
      finalState.failure = some .quarantineFailure) ∧
  (∀ input : BundleCandidateInput,
    input.pointerSnapshotBounded = true →
    input.pointerTargetValid = true →
    protectedCandidate input = false →
    input.candidateValid = true →
    input.quarantineUnique = true →
    input.postRenameOutcome = .valid →
    input.deletionSucceeds = true →
      let finalState := runBundleCandidateCleanup input
      finalState.current = input.current ∧
      finalState.previous = input.previous ∧
      finalState.location = .deleted ∧
      finalState.lockHeld = false ∧
      finalState.recursivelyDeleted = true ∧
      finalState.failure = none) ∧
  (∀ input : BundleCandidateInput,
    input.pointerSnapshotBounded = true →
    input.pointerTargetValid = true →
    protectedCandidate input = false →
    input.candidateValid = true →
    input.quarantineUnique = true →
    input.postRenameOutcome = .valid →
    input.deletionSucceeds = false →
      let finalState := runBundleCandidateCleanup input
      finalState.current = input.current ∧
      finalState.previous = input.previous ∧
      finalState.location = .quarantined ∧
      finalState.lockHeld = false ∧
      finalState.recursivelyDeleted = false ∧
      finalState.failure = some .deletionFailure) ∧
  (∀ input : BundleCandidateInput,
    input.pointerSnapshotBounded = true →
    input.pointerTargetValid = true →
    protectedCandidate input = false →
    input.candidateValid = true →
    input.quarantineUnique = true →
    input.postRenameOutcome = .revalidationFailsRestoreSucceeds →
      let finalState := runBundleCandidateCleanup input
      finalState.current = input.current ∧
      finalState.previous = input.previous ∧
      finalState.location = .visible ∧
      finalState.lockHeld = false ∧
      finalState.recursivelyDeleted = false ∧
      finalState.originalValidationFailureRetained = true ∧
      finalState.failure = some .revalidationFailure) ∧
  (∀ input : BundleCandidateInput,
    input.pointerSnapshotBounded = true →
    input.pointerTargetValid = true →
    protectedCandidate input = false →
    input.candidateValid = true →
    input.quarantineUnique = true →
    input.postRenameOutcome = .revalidationFailsRestoreFails →
      let finalState := runBundleCandidateCleanup input
      finalState.current = input.current ∧
      finalState.previous = input.previous ∧
      finalState.location = .quarantined ∧
      finalState.lockHeld = false ∧
      finalState.recursivelyDeleted = false ∧
      finalState.originalValidationFailureRetained = true ∧
      finalState.failure = some .restorationFailure) ∧
  (∀ input : BundleCandidateInput,
    input.pointerSnapshotBounded = true →
    input.pointerTargetValid = true →
    protectedCandidate input = false →
    input.candidateValid = true →
    input.quarantineUnique = true →
    input.postRenameOutcome = .revalidationFailsOriginalPathConflicts →
      let finalState := runBundleCandidateCleanup input
      finalState.current = input.current ∧
      finalState.previous = input.previous ∧
      finalState.location = .conflictAndQuarantined ∧
      finalState.lockHeld = false ∧
      finalState.recursivelyDeleted = false ∧
      finalState.originalValidationFailureRetained = true ∧
      finalState.failure = some .originalPathConflict)

theorem bundle_cleanup_is_correct : BundleCleanupContract := by
  constructor
  · intro input hpointers
    simp [runBundleCandidateCleanup, recursivelyDeleteQuarantine,
      releaseCandidateLock, validateAndQuarantineCandidate,
      initialBundleCandidateState, hpointers]
  constructor
  · intro input hpointers htarget
    simp [runBundleCandidateCleanup, recursivelyDeleteQuarantine,
      releaseCandidateLock, validateAndQuarantineCandidate,
      initialBundleCandidateState, hpointers, htarget]
  constructor
  · intro input hpointers htarget hprotected
    simp [runBundleCandidateCleanup, recursivelyDeleteQuarantine,
      releaseCandidateLock, validateAndQuarantineCandidate,
      initialBundleCandidateState, hpointers, htarget, hprotected]
  constructor
  · intro input hpointers htarget hunprotected hcandid
    simp [runBundleCandidateCleanup, recursivelyDeleteQuarantine,
      releaseCandidateLock, validateAndQuarantineCandidate,
      initialBundleCandidateState, hpointers, htarget, hunprotected,
      hcandid]
  constructor
  · intro input hpointers htarget hunprotected hcandid hquarantine
    simp [runBundleCandidateCleanup, recursivelyDeleteQuarantine,
      releaseCandidateLock, validateAndQuarantineCandidate,
      initialBundleCandidateState, hpointers, htarget, hunprotected,
      hcandid, hquarantine]
  constructor
  · intro input hpointers htarget hunprotected hcandid hquarantine
      houtcome hdelete
    simp [runBundleCandidateCleanup, recursivelyDeleteQuarantine,
      releaseCandidateLock, validateAndQuarantineCandidate,
      initialBundleCandidateState, hpointers, htarget, hunprotected,
      hcandid, hquarantine, houtcome, hdelete]
  constructor
  · intro input hpointers htarget hunprotected hcandid hquarantine
      houtcome hdelete
    simp [runBundleCandidateCleanup, recursivelyDeleteQuarantine,
      releaseCandidateLock, validateAndQuarantineCandidate,
      initialBundleCandidateState, hpointers, htarget, hunprotected,
      hcandid, hquarantine, houtcome, hdelete]
  constructor
  · intro input hpointers htarget hunprotected hcandid hquarantine
      houtcome
    simp [runBundleCandidateCleanup, recursivelyDeleteQuarantine,
      releaseCandidateLock, validateAndQuarantineCandidate,
      initialBundleCandidateState, hpointers, htarget, hunprotected,
      hcandid, hquarantine, houtcome]
  constructor
  · intro input hpointers htarget hunprotected hcandid hquarantine
      houtcome
    simp [runBundleCandidateCleanup, recursivelyDeleteQuarantine,
      releaseCandidateLock, validateAndQuarantineCandidate,
      initialBundleCandidateState, hpointers, htarget, hunprotected,
      hcandid, hquarantine, houtcome]
  · intro input hpointers htarget hunprotected hcandid hquarantine
      houtcome
    simp [runBundleCandidateCleanup, recursivelyDeleteQuarantine,
      releaseCandidateLock, validateAndQuarantineCandidate,
      initialBundleCandidateState, hpointers, htarget, hunprotected,
      hcandid, hquarantine, houtcome]

-- Shared-lock wrappers connect activation and cleanup to the same acquisition and release transition.
def runActivationWithSharedLock
    (input : BundleActivationInput)
    (lock : InstallLockState) : Option (BundleActivationState × InstallLockState) :=
  match acquireInstallLock .selfUpdate lock with
  | none => none
  | some acquired => some (runBundleActivation input, releaseInstallLock acquired)

def runCleanupWithSharedLock
    (input : BundleCandidateInput)
    (lock : InstallLockState) : Option (BundleCandidateState × InstallLockState) :=
  match acquireInstallLock .cleanup lock with
  | none => none
  | some acquired => some (runBundleCandidateCleanup input, releaseInstallLock acquired)

theorem bundle_activation_releases_internal_lock
    (input : BundleActivationInput) :
    (runBundleActivation input).lockHeld = false := by
  simp [runBundleActivation, releaseBundleActivationLock]

theorem bundle_cleanup_releases_internal_lock
    (input : BundleCandidateInput) :
    (runBundleCandidateCleanup input).lockHeld = false := by
  simp only [runBundleCandidateCleanup]
  generalize validateAndQuarantineCandidate input = state
  cases state with
  | mk current previous location lockHeld recursivelyDeleted
      originalValidationFailureRetained failure =>
      cases location <;> cases failure <;>
        cases hdelete : input.deletionSucceeds <;>
        simp [releaseCandidateLock, recursivelyDeleteQuarantine, hdelete]

def SharedProcessIntegrationContract : Prop :=
  (∀ input : BundleActivationInput,
    ∃ finalState : BundleActivationState,
      runActivationWithSharedLock input { owner := none } =
        some (finalState, { owner := none }) ∧
      finalState.lockHeld = false) ∧
  (∀ input : BundleCandidateInput,
    ∃ finalState : BundleCandidateState,
      runCleanupWithSharedLock input { owner := none } =
        some (finalState, { owner := none }) ∧
      finalState.lockHeld = false) ∧
  (∀ (input : BundleActivationInput) (owner : InstallOperation),
    runActivationWithSharedLock input { owner := some owner } = none) ∧
  (∀ (input : BundleCandidateInput) (owner : InstallOperation),
    runCleanupWithSharedLock input { owner := some owner } = none)

theorem shared_process_integration_is_correct : SharedProcessIntegrationContract := by
  constructor
  · intro input
    exact ⟨runBundleActivation input, by simp [runActivationWithSharedLock,
      acquireInstallLock, releaseInstallLock],
      bundle_activation_releases_internal_lock input⟩
  constructor
  · intro input
    exact ⟨runBundleCandidateCleanup input, by simp [runCleanupWithSharedLock,
      acquireInstallLock, releaseInstallLock],
      bundle_cleanup_releases_internal_lock input⟩
  constructor
  · intro input owner
    simp [runActivationWithSharedLock, acquireInstallLock]
  · intro input owner
    simp [runCleanupWithSharedLock, acquireInstallLock]

-- The top-level theorem combines shared exclusion and gating, activation safety, and cleanup recovery guarantees.
theorem update_clean_win32_safety_is_correct :
    SharedInstallLockContract ∧
    SharedProcessIntegrationContract ∧
    BundleActivationContract ∧
    BundleCleanupContract := by
  exact ⟨shared_install_lock_is_correct,
    shared_process_integration_is_correct,
    bundle_activation_is_correct,
    bundle_cleanup_is_correct⟩

#print axioms update_clean_win32_safety_is_correct

end UpdateCleanWin32Safety

-- The executable summary demonstrates first-update pointer omission and retained quarantine after failed restoration.
def main : IO Unit := do
  let firstActivation : UpdateCleanWin32Safety.BundleActivationInput := {
    current := none
    previous := none
    destination := 2
    destinationValid := true
    helperProbeValid := true
    pointerSnapshotStable := true
    publicationOutcome := .success
  }
  let restorationFailure : UpdateCleanWin32Safety.BundleCandidateInput := {
    executing := 2
    current := 2
    previous := some 1
    candidate := 0
    pointerSnapshotBounded := true
    pointerTargetValid := true
    candidateValid := true
    quarantineUnique := true
    postRenameOutcome := .revalidationFailsRestoreFails
    deletionSucceeds := true
  }
  IO.println s!"first activation previous: {repr (UpdateCleanWin32Safety.runBundleActivation firstActivation).previous}"
  IO.println s!"failed restoration location: {repr (UpdateCleanWin32Safety.runBundleCandidateCleanup restorationFailure).location}"
  IO.println "proved: shared lock gating and exclusion, isolated helper probing, activation pointer recovery, quarantine restoration safety"
