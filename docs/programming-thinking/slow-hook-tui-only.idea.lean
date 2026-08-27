-- Lean standard library supplies finite data, boolean guards, arithmetic, proofs, and deterministic output.
import Std

set_option autoImplicit false

namespace SlowHookTuiOnly

-- Process vocabulary distinguishes run modes, hook classes, handler return classes, and hook outcomes.
inductive Mode where
  | tui
  | print
  | rpc
  deriving DecidableEq, Repr

inductive HookKind where
  | regular
  | sessionShutdown
  deriving DecidableEq, Repr

inductive ExecutionKind where
  | sync
  | async
  deriving DecidableEq, Repr

inductive HookOutcome where
  | succeeded
  | failed
  deriving DecidableEq, Repr

-- Inputs contain measured time and the actual handler-return classification used by routing.
structure Input where
  mode : Mode
  hookKind : HookKind
  executionKind : ExecutionKind
  elapsedMs : Nat
  thresholdMs : Nat
  realUiPresent : Bool
  listenerAttached : Bool
  originalOutcome : HookOutcome
  diagnosticCallbackFailed : Bool
  deriving DecidableEq, Repr

-- Final state records terminal presentation, classified execution, preserved hook outcome, and forbidden outputs.
structure State where
  currentShutdownVisible : Bool
  transientSlowLines : Nat
  retainedShutdownSlowLines : Nat
  classifiedExecution : ExecutionKind
  finalOutcome : HookOutcome
  sessionDiagnosticEntries : Nat
  generationMutations : Nat
  modelContextMessages : Nat
  printRpcEvents : Nat
  lifecycleLogWrites : Nat
  deriving DecidableEq, Repr

def boolCount (value : Bool) : Nat :=
  if value then 1 else 0

def isTui : Mode → Bool
  | .tui => true
  | .print => false
  | .rpc => false

def isShutdown : HookKind → Bool
  | .regular => false
  | .sessionShutdown => true

-- Slow means strictly greater than threshold; equality remains fast.
def isSlow (input : Input) : Bool :=
  decide (input.thresholdMs < input.elapsedMs)

-- Settlement models listener-owned shutdown rendering and generic TUI rendering as disjoint routes.
def run (input : Input) : State :=
  let listenerSlow :=
    isTui input.mode && input.realUiPresent && isShutdown input.hookKind &&
      input.listenerAttached && isSlow input
  let genericSlow :=
    isTui input.mode && input.realUiPresent && isSlow input &&
      (!isShutdown input.hookKind || !input.listenerAttached)
  {
    currentShutdownVisible := false
    transientSlowLines := boolCount genericSlow
    retainedShutdownSlowLines := boolCount listenerSlow + boolCount (genericSlow && isShutdown input.hookKind)
    classifiedExecution := input.executionKind
    finalOutcome := input.originalOutcome
    sessionDiagnosticEntries := 0
    generationMutations := 0
    modelContextMessages := 0
    printRpcEvents := 0
    lifecycleLogWrites := 0
  }

-- Invariants prohibit persistence/foreign-channel output and require exact classification/outcome preservation.
def diagnosticsAreTransient (state : State) : Prop :=
  state.sessionDiagnosticEntries = 0 ∧
  state.generationMutations = 0 ∧
  state.modelContextMessages = 0 ∧
  state.printRpcEvents = 0 ∧
  state.lifecycleLogWrites = 0

def processInvariant (input : Input) (state : State) : Prop :=
  diagnosticsAreTransient state ∧
  state.currentShutdownVisible = false ∧
  state.classifiedExecution = input.executionKind ∧
  state.finalOutcome = input.originalOutcome

-- Supporting proofs establish strict threshold, listener retention, classification, outcome preservation, and silence.
theorem threshold_equality_is_fast
    (input : Input)
    (equal : input.elapsedMs = input.thresholdMs) :
    isSlow input = false := by
  simp [isSlow, equal]

theorem threshold_greater_is_slow
    (input : Input)
    (greater : input.thresholdMs < input.elapsedMs) :
    isSlow input = true := by
  simp [isSlow, greater]

theorem listener_rendered_slow_shutdown_retains_exactly_one_line
    (input : Input)
    (tui : input.mode = .tui)
    (shutdown : input.hookKind = .sessionShutdown)
    (ui : input.realUiPresent = true)
    (listener : input.listenerAttached = true)
    (slow : input.thresholdMs < input.elapsedMs) :
    (run input).transientSlowLines = 0 ∧
      (run input).retainedShutdownSlowLines = 1 := by
  simp [run, tui, shutdown, ui, listener, isTui, isShutdown, isSlow, slow, boolCount]

theorem execution_classification_matches_handler_return (input : Input) :
    (run input).classifiedExecution = input.executionKind := by
  simp [run]

theorem diagnostic_callback_failure_preserves_original_outcome
    (input : Input)
    (_callbackFailed : input.diagnosticCallbackFailed = true) :
    (run input).finalOutcome = input.originalOutcome := by
  simp [run]

theorem hook_diagnostics_never_persist (input : Input) :
    diagnosticsAreTransient (run input) := by
  simp [diagnosticsAreTransient, run]

theorem print_and_rpc_emit_no_hook_lines
    (input : Input)
    (nonTui : input.mode ≠ .tui) :
    (run input).transientSlowLines = 0 ∧
      (run input).retainedShutdownSlowLines = 0 := by
  cases modeProof : input.mode <;>
    simp [run, modeProof, isTui, isShutdown, isSlow, boolCount] at nonTui ⊢

-- Top-level theorem states exact modeled guarantees; terminal sanitization and signal-terminal safety remain implementation tests.
theorem process_is_correct :
    (∀ input, processInvariant input (run input)) ∧
    (∀ input, (run input).classifiedExecution = input.executionKind) ∧
    (∀ input, (run input).finalOutcome = input.originalOutcome) ∧
    (∀ input, diagnosticsAreTransient (run input)) ∧
    (∀ input,
      input.elapsedMs = input.thresholdMs →
      isSlow input = false) ∧
    (∀ input,
      input.mode = .tui →
      input.hookKind = .sessionShutdown →
      input.realUiPresent = true →
      input.listenerAttached = true →
      input.thresholdMs < input.elapsedMs →
      (run input).transientSlowLines = 0 ∧
        (run input).retainedShutdownSlowLines = 1) ∧
    (∀ input,
      input.mode ≠ .tui →
      (run input).transientSlowLines = 0 ∧
        (run input).retainedShutdownSlowLines = 0) := by
  refine ⟨?_, execution_classification_matches_handler_return,
    ?_, hook_diagnostics_never_persist, threshold_equality_is_fast,
    listener_rendered_slow_shutdown_retains_exactly_one_line,
    print_and_rpc_emit_no_hook_lines⟩
  · intro input
    simp [processInvariant, diagnosticsAreTransient, run]
  · intro input
    simp [run]

#print axioms process_is_correct

-- Executable example demonstrates one listener-retained asynchronous shutdown line with no forbidden output.
private def fixedExample : Input :=
  {
    mode := .tui
    hookKind := .sessionShutdown
    executionKind := .async
    elapsedMs := 101
    thresholdMs := 100
    realUiPresent := true
    listenerAttached := true
    originalOutcome := .failed
    diagnosticCallbackFailed := true
  }

end SlowHookTuiOnly

def main : IO Unit := do
  let input := SlowHookTuiOnly.fixedExample
  let result := SlowHookTuiOnly.run input
  IO.println s!"transient={result.transientSlowLines}; retained={result.retainedShutdownSlowLines}; class={repr result.classifiedExecution}; outcome={repr result.finalOutcome}; session={result.sessionDiagnosticEntries}; generation={result.generationMutations}; model={result.modelContextMessages}; print/rpc={result.printRpcEvents}; lifecycle={result.lifecycleLogWrites}"
  IO.println "Proved: strict threshold, exact listener retention, return-based classification, original outcome preservation, TUI routing, and non-persistence."
