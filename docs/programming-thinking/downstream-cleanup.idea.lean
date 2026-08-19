-- The model uses only Lean's standard library and forbids implicit undeclared process vocabulary.
import Std

set_option autoImplicit false

namespace DownstreamCleanup

-- Participants name the human, branch, workflow, evidence, and release responsibilities involved in cleanup.
inductive Participant where
  | forkMaintainer
  | persistentFeatureBranch
  | syncWorkflow
  | publicSeamTests
  | boundaryProofs
  | releaseGates
  deriving DecidableEq, Repr

-- Feature and input data keep each persistent branch limited to one independently retireable behavior.
inductive FeatureKind where
  | ordinaryBehavior
  | providerTransparentResponsesCompaction
  deriving DecidableEq, Repr

structure FeatureBranch where
  kind : FeatureKind
  featureCount : Nat
  deriving DecidableEq, Repr

structure CleanupInput where
  branch : FeatureBranch
  blackBoxIntegrationPassesOnUpstream : Bool
  boundaryInvariantsProved : Bool
  deriving DecidableEq, Repr

-- Process states make the unblock, verified release, evidence decision, archive, and deletion order explicit.
inductive BranchDisposition where
  | retain
  | retire
  deriving DecidableEq, Repr

inductive ProcessPhase where
  | failureObserved
  | unblockPrepared
  | releaseCandidateBuilt
  | releaseVerified
  | branchEvaluated
  | oldRefArchived
  | liveRefDeleted
  | retainedDone
  | retiredDone
  deriving DecidableEq, Repr

structure ProcessState where
  input : CleanupInput
  phase : ProcessPhase
  deriving DecidableEq, Repr

-- Guards accept only one-feature branches and require stronger evidence for Responses remote compaction.
def admitted (input : CleanupInput) : Prop :=
  input.branch.featureCount = 1

def retirementEvidenceSufficient (input : CleanupInput) : Bool :=
  match input.branch.kind with
  | .ordinaryBehavior => input.blackBoxIntegrationPassesOnUpstream
  | .providerTransparentResponsesCompaction =>
      input.blackBoxIntegrationPassesOnUpstream && input.boundaryInvariantsProved

def chooseDisposition (input : CleanupInput) : BranchDisposition :=
  if retirementEvidenceSufficient input then .retire else .retain

-- Derived state observations expose release and ref-cleanup facts without storing contradictory flags.
def initialState (input : CleanupInput) : ProcessState :=
  { input, phase := .failureObserved }

def persistentBranchReady (state : ProcessState) : Bool :=
  state.phase != .failureObserved

def generatedMainRebuilt (state : ProcessState) : Bool :=
  match state.phase with
  | .failureObserved | .unblockPrepared => false
  | _ => true

def releaseGatesPassed (state : ProcessState) : Bool :=
  match state.phase with
  | .failureObserved | .unblockPrepared | .releaseCandidateBuilt => false
  | _ => true

def oldRefArchived (state : ProcessState) : Bool :=
  match state.phase with
  | .oldRefArchived | .liveRefDeleted | .retiredDone => true
  | _ => false

def oldRefDeleted (state : ProcessState) : Bool :=
  match state.phase with
  | .liveRefDeleted | .retiredDone => true
  | _ => false

def disposition (state : ProcessState) : Option BranchDisposition :=
  match state.phase with
  | .retainedDone => some .retain
  | .oldRefArchived | .liveRefDeleted | .retiredDone => some .retire
  | _ => none

-- Invariants and forbidden states encode branch independence, evidence-gated retirement, and archive-before-delete safety.
def terminal (state : ProcessState) : Prop :=
  state.phase = .retainedDone ∨ state.phase = .retiredDone

def retirementPhase (phase : ProcessPhase) : Prop :=
  phase = .oldRefArchived ∨ phase = .liveRefDeleted ∨ phase = .retiredDone

def processInvariant (state : ProcessState) : Prop :=
  state.input.branch.featureCount = 1 ∧
  (retirementPhase state.phase →
    retirementEvidenceSufficient state.input = true)

def forbiddenState (state : ProcessState) : Prop :=
  state.input.branch.featureCount ≠ 1 ∨
  (oldRefDeleted state = true ∧ oldRefArchived state = false) ∨
  (oldRefDeleted state = true ∧ releaseGatesPassed state = false) ∨
  (state.phase = .retiredDone ∧
    retirementEvidenceSufficient state.input = false)

-- The deterministic activity flow unblocks and verifies a release before evaluating and cleaning one feature branch.
def step (state : ProcessState) : ProcessState :=
  match state.phase with
  | .failureObserved => { state with phase := .unblockPrepared }
  | .unblockPrepared => { state with phase := .releaseCandidateBuilt }
  | .releaseCandidateBuilt => { state with phase := .releaseVerified }
  | .releaseVerified => { state with phase := .branchEvaluated }
  | .branchEvaluated =>
      match chooseDisposition state.input with
      | .retain => { state with phase := .retainedDone }
      | .retire => { state with phase := .oldRefArchived }
  | .oldRefArchived => { state with phase := .liveRefDeleted }
  | .liveRefDeleted => { state with phase := .retiredDone }
  | .retainedDone => state
  | .retiredDone => state

def runSteps : Nat → ProcessState → ProcessState
  | 0, state => state
  | steps + 1, state => runSteps steps (step state)

def runToCompletion (input : CleanupInput) : ProcessState :=
  runSteps 7 (initialState input)

-- Allowed outcomes retain unsupported features or retire supported features only after release verification and archival.
def allowedFinalState (state : ProcessState) : Prop :=
  (state.phase = .retainedDone ∧
    disposition state = some .retain ∧
    retirementEvidenceSufficient state.input = false ∧
    oldRefDeleted state = false) ∨
  (state.phase = .retiredDone ∧
    disposition state = some .retire ∧
    retirementEvidenceSufficient state.input = true ∧
    releaseGatesPassed state = true ∧
    oldRefArchived state = true ∧
    oldRefDeleted state = true)

-- Initialization and decision lemmas establish the invariant and the exact evidence policy for both feature classes.
theorem initialization_establishes_invariant
    (input : CleanupInput) (h : admitted input) :
    processInvariant (initialState input) := by
  constructor
  · exact h
  · simp [initialState, retirementPhase]

theorem retirement_guards_are_complete_and_exclusive (input : CleanupInput) :
    (retirementEvidenceSufficient input = true ∨
      retirementEvidenceSufficient input = false) ∧
    ¬(retirementEvidenceSufficient input = true ∧
      retirementEvidenceSufficient input = false) := by
  cases retirementEvidenceSufficient input <;> simp

theorem selected_retirement_has_required_evidence (input : CleanupInput) :
    chooseDisposition input = .retire →
      retirementEvidenceSufficient input = true := by
  simp [chooseDisposition]

theorem ordinary_behavior_uses_black_box_evidence
    (input : CleanupInput)
    (hkind : input.branch.kind = .ordinaryBehavior) :
    retirementEvidenceSufficient input =
      input.blackBoxIntegrationPassesOnUpstream := by
  simp [retirementEvidenceSufficient, hkind]

theorem responses_compaction_requires_both_evidence_classes
    (input : CleanupInput)
    (hkind : input.branch.kind = .providerTransparentResponsesCompaction) :
    retirementEvidenceSufficient input = true ↔
      input.blackBoxIntegrationPassesOnUpstream = true ∧
      input.boundaryInvariantsProved = true := by
  simp [retirementEvidenceSufficient, hkind, Bool.and_eq_true]

-- Preservation, progress, and safety lemmas prove that every permitted transition advances without entering a forbidden state.
theorem step_preserves_invariant
    (state : ProcessState) (h : processInvariant state) :
    processInvariant (step state) := by
  rcases state with ⟨input, phase⟩
  rcases h with ⟨hcount, hretirement⟩
  have hstepInput : (step { input := input, phase := phase }).input = input := by
    cases phase <;> simp [step] <;> cases chooseDisposition input <;> rfl
  constructor
  · rw [hstepInput]
    exact hcount
  · intro hnext
    cases phase with
    | failureObserved => simp [step, retirementPhase] at hnext
    | unblockPrepared => simp [step, retirementPhase] at hnext
    | releaseCandidateBuilt => simp [step, retirementPhase] at hnext
    | releaseVerified => simp [step, retirementPhase] at hnext
    | branchEvaluated =>
        cases hevidence : retirementEvidenceSufficient input with
        | false =>
            simp [step, chooseDisposition, hevidence, retirementPhase] at hnext
        | true =>
            rw [hstepInput]
            exact hevidence
    | oldRefArchived =>
        exact hretirement (by simp [retirementPhase])
    | liveRefDeleted =>
        exact hretirement (by simp [retirementPhase])
    | retainedDone => simp [step, retirementPhase] at hnext
    | retiredDone =>
        exact hretirement (by simp [retirementPhase])

theorem run_steps_preserves_invariant
    (state : ProcessState) (h : processInvariant state) (steps : Nat) :
    processInvariant (runSteps steps state) := by
  induction steps generalizing state with
  | zero => exact h
  | succ steps ih =>
      exact ih (step state) (step_preserves_invariant state h)

theorem process_makes_progress
    (state : ProcessState) (h : ¬terminal state) :
    step state ≠ state := by
  rcases state with ⟨input, phase⟩
  cases phase <;>
    simp_all [terminal, step, chooseDisposition] <;>
    cases retirementEvidenceSufficient input <;> simp

theorem invariant_excludes_forbidden_states
    (state : ProcessState) (h : processInvariant state) :
    ¬forbiddenState state := by
  rcases state with ⟨input, phase⟩
  cases phase <;>
    simp_all [processInvariant, forbiddenState, retirementPhase,
      oldRefDeleted, oldRefArchived, releaseGatesPassed]

-- Termination and postcondition lemmas prove that every input reaches exactly an allowed retained or retired result.
theorem process_reaches_terminal_state
    (input : CleanupInput) :
    terminal (runToCompletion input) := by
  cases hevidence : retirementEvidenceSufficient input <;>
    simp [runToCompletion, runSteps, initialState, step, terminal,
      chooseDisposition, hevidence]

theorem final_state_satisfies_contract
    (input : CleanupInput) :
    allowedFinalState (runToCompletion input) := by
  cases hevidence : retirementEvidenceSufficient input <;>
    simp [runToCompletion, runSteps, initialState, step, allowedFinalState,
      disposition, oldRefDeleted, oldRefArchived, releaseGatesPassed,
      chooseDisposition, hevidence]

theorem deleted_refs_were_archived_after_release (state : ProcessState) :
    oldRefDeleted state = true →
      oldRefArchived state = true ∧ releaseGatesPassed state = true := by
  rcases state with ⟨input, phase⟩
  cases phase <;>
    simp [oldRefDeleted, oldRefArchived, releaseGatesPassed]

theorem unsupported_retirement_finishes_retained
    (input : CleanupInput)
    (hunsupported : retirementEvidenceSufficient input = false) :
    let finalState := runToCompletion input
    finalState.phase = .retainedDone ∧ oldRefDeleted finalState = false := by
  have hretain : chooseDisposition input = .retain := by
    simp [chooseDisposition, hunsupported]
  simp [runToCompletion, runSteps, initialState, step, hretain, oldRefDeleted]

-- Branch roles separate independently retireable features, cross-feature glue, and CI orchestration ownership.
inductive BranchRole where
  | feature
  | compatibility
  | ciInfrastructure
  deriving DecidableEq, Repr

structure IntegrationPlan where
  role : BranchRole
  standaloneFeatureCount : Nat
  compatibilityObligationCount : Nat
  dependencyCount : Nat
  dependenciesIntegrated : Bool
  dependencyRetired : Bool
  glueRequired : Bool
  publicSeamEvidencePasses : Bool
  ownsRuntimeOrTestSemantics : Bool
  allChangedRuntimePathsAllowed : Bool
  deriving DecidableEq, Repr

inductive IntegrationDecision where
  | retain
  | integrate
  | retire
  | reject
  deriving DecidableEq, Repr

-- Role contracts forbid compatibility branches from owning standalone features and forbid CI from owning runtime or test semantics.
def branchRoleContract (plan : IntegrationPlan) : Prop :=
  match plan.role with
  | .feature =>
      plan.standaloneFeatureCount = 1 ∧
      plan.compatibilityObligationCount = 0
  | .compatibility =>
      plan.standaloneFeatureCount = 0 ∧
      plan.compatibilityObligationCount = 1 ∧
      plan.dependencyCount = 2 ∧
      plan.allChangedRuntimePathsAllowed = true
  | .ciInfrastructure =>
      plan.standaloneFeatureCount = 0 ∧
      plan.compatibilityObligationCount = 0 ∧
      plan.ownsRuntimeOrTestSemantics = false

-- Compatibility guards require named dependencies, a still-needed obligation, public-seam evidence, and an allowed path boundary.
def compatibilityEligible (plan : IntegrationPlan) : Prop :=
  plan.role = .compatibility ∧
  plan.dependenciesIntegrated = true ∧
  plan.dependencyRetired = false ∧
  plan.glueRequired = true ∧
  plan.publicSeamEvidencePasses = true ∧
  plan.allChangedRuntimePathsAllowed = true

def compatibilityRetirementTriggered (plan : IntegrationPlan) : Prop :=
  plan.role = .compatibility ∧
  (plan.dependencyRetired = true ∨
    (plan.glueRequired = false ∧ plan.publicSeamEvidencePasses = true))

def decideIntegration (plan : IntegrationPlan) : IntegrationDecision :=
  match plan.role with
  | .feature => .retain
  | .ciInfrastructure =>
      if plan.ownsRuntimeOrTestSemantics then .reject else .retain
  | .compatibility =>
      if plan.dependencyRetired then
        .retire
      else if !plan.glueRequired && plan.publicSeamEvidencePasses then
        .retire
      else if plan.dependenciesIntegrated && plan.glueRequired &&
          plan.publicSeamEvidencePasses && plan.allChangedRuntimePathsAllowed then
        .integrate
      else
        .reject

-- Governance lemmas establish CI ownership limits, compatibility ordering, and safe retirement triggers.
theorem ci_contract_forbids_runtime_and_test_semantics
    (plan : IntegrationPlan)
    (hrole : plan.role = .ciInfrastructure)
    (hcontract : branchRoleContract plan) :
    plan.ownsRuntimeOrTestSemantics = false := by
  simp [branchRoleContract, hrole] at hcontract
  exact hcontract.2.2

theorem compatibility_contract_preserves_feature_boundary
    (plan : IntegrationPlan)
    (hrole : plan.role = .compatibility)
    (hcontract : branchRoleContract plan) :
    plan.standaloneFeatureCount = 0 ∧
    plan.compatibilityObligationCount = 1 ∧
    plan.dependencyCount = 2 := by
  simp [branchRoleContract, hrole] at hcontract
  exact ⟨hcontract.1, hcontract.2.1, hcontract.2.2.1⟩

theorem eligible_compatibility_integrates_after_dependencies
    (plan : IntegrationPlan)
    (heligible : compatibilityEligible plan) :
    plan.dependenciesIntegrated = true ∧
    plan.publicSeamEvidencePasses = true ∧
    decideIntegration plan = .integrate := by
  rcases heligible with ⟨hrole, hdependencies, hactive, hrequired,
    hevidence, hpaths⟩
  exact ⟨hdependencies, hevidence, by
    simp [decideIntegration, hrole, hdependencies, hactive, hrequired,
      hevidence, hpaths]⟩

theorem triggered_compatibility_retires
    (plan : IntegrationPlan)
    (htriggered : compatibilityRetirementTriggered plan) :
    decideIntegration plan = .retire := by
  rcases htriggered with ⟨hrole, hretired | ⟨hnotRequired, hevidence⟩⟩
  · simp [decideIntegration, hrole, hretired]
  · cases hretired : plan.dependencyRetired <;>
      simp [decideIntegration, hrole, hretired, hnotRequired, hevidence]

theorem eligible_compatibility_has_no_retirement_trigger
    (plan : IntegrationPlan)
    (heligible : compatibilityEligible plan) :
    ¬compatibilityRetirementTriggered plan := by
  rcases heligible with ⟨hrole, hdependencies, hactive, hrequired,
    hevidence, hpaths⟩
  simp [compatibilityRetirementTriggered, hrole, hactive, hrequired]

-- This theorem combines all branch-role guarantees into one integration-governance contract.
theorem integration_governance_is_correct
    (plan : IntegrationPlan)
    (hcontract : branchRoleContract plan) :
    branchRoleContract plan ∧
    (plan.role = .ciInfrastructure →
      plan.ownsRuntimeOrTestSemantics = false) ∧
    (compatibilityEligible plan →
      decideIntegration plan = .integrate) ∧
    (compatibilityRetirementTriggered plan →
      decideIntegration plan = .retire) ∧
    ¬(compatibilityEligible plan ∧
      compatibilityRetirementTriggered plan) := by
  exact ⟨
    hcontract,
    fun hrole => ci_contract_forbids_runtime_and_test_semantics plan hrole hcontract,
    fun heligible => (eligible_compatibility_integrates_after_dependencies plan heligible).2.2,
    triggered_compatibility_retires plan,
    fun hboth => eligible_compatibility_has_no_retirement_trigger plan hboth.1 hboth.2
  ⟩

-- The top-level theorem combines invariant preservation, termination, postconditions, safety, and the one-feature boundary.
theorem process_is_correct
    (input : CleanupInput) (h : admitted input) :
    processInvariant (runToCompletion input) ∧
    terminal (runToCompletion input) ∧
    allowedFinalState (runToCompletion input) ∧
    ¬forbiddenState (runToCompletion input) ∧
    (runToCompletion input).input.branch.featureCount = 1 := by
  have hinvariant : processInvariant (runToCompletion input) := by
    exact run_steps_preserves_invariant
      (initialState input)
      (initialization_establishes_invariant input h)
      7
  exact ⟨
    hinvariant,
    process_reaches_terminal_state input,
    final_state_satisfies_contract input,
    invariant_excludes_forbidden_states (runToCompletion input) hinvariant,
    hinvariant.1
  ⟩

-- The authoritative top-level theorem combines feature cleanup correctness with compatibility and CI governance.
theorem downstream_cleanup_is_correct
    (input : CleanupInput) (hinput : admitted input)
    (plan : IntegrationPlan) (hplan : branchRoleContract plan) :
    (processInvariant (runToCompletion input) ∧
      terminal (runToCompletion input) ∧
      allowedFinalState (runToCompletion input) ∧
      ¬forbiddenState (runToCompletion input) ∧
      (runToCompletion input).input.branch.featureCount = 1) ∧
    (branchRoleContract plan ∧
      (plan.role = .ciInfrastructure →
        plan.ownsRuntimeOrTestSemantics = false) ∧
      (compatibilityEligible plan →
        decideIntegration plan = .integrate) ∧
      (compatibilityRetirementTriggered plan →
        decideIntegration plan = .retire) ∧
      ¬(compatibilityEligible plan ∧
        compatibilityRetirementTriggered plan)) := by
  exact ⟨process_is_correct input hinput,
    integration_governance_is_correct plan hplan⟩

#print axioms downstream_cleanup_is_correct

end DownstreamCleanup

-- The executable summary demonstrates ordinary retirement and compaction retention when boundary proof is absent.
def main : IO Unit := do
  let ordinary : DownstreamCleanup.CleanupInput := {
    branch := { kind := .ordinaryBehavior, featureCount := 1 }
    blackBoxIntegrationPassesOnUpstream := true
    boundaryInvariantsProved := false
  }
  let compactionWithoutBoundaryProof : DownstreamCleanup.CleanupInput := {
    branch := {
      kind := .providerTransparentResponsesCompaction
      featureCount := 1
    }
    blackBoxIntegrationPassesOnUpstream := true
    boundaryInvariantsProved := false
  }
  IO.println s!"ordinary behavior: {repr (DownstreamCleanup.disposition (DownstreamCleanup.runToCompletion ordinary))}"
  let compatibility : DownstreamCleanup.IntegrationPlan := {
    role := .compatibility
    standaloneFeatureCount := 0
    compatibilityObligationCount := 1
    dependencyCount := 2
    dependenciesIntegrated := true
    dependencyRetired := false
    glueRequired := true
    publicSeamEvidencePasses := true
    ownsRuntimeOrTestSemantics := true
    allChangedRuntimePathsAllowed := true
  }
  let ciInfrastructure : DownstreamCleanup.IntegrationPlan := {
    role := .ciInfrastructure
    standaloneFeatureCount := 0
    compatibilityObligationCount := 0
    dependencyCount := 0
    dependenciesIntegrated := true
    dependencyRetired := false
    glueRequired := false
    publicSeamEvidencePasses := true
    ownsRuntimeOrTestSemantics := false
    allChangedRuntimePathsAllowed := true
  }
  IO.println s!"responses compaction without boundary proof: {repr (DownstreamCleanup.disposition (DownstreamCleanup.runToCompletion compactionWithoutBoundaryProof))}"
  IO.println s!"eligible compatibility: {repr (DownstreamCleanup.decideIntegration compatibility)}"
  IO.println s!"CI infrastructure without runtime semantics: {repr (DownstreamCleanup.decideIntegration ciInfrastructure)}"
  IO.println "proved: release first, one feature per branch, governed compatibility, archive before permanent delete"
