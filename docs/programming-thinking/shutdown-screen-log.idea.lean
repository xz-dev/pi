-- Lean 4 process model for interactive vs noninteractive session_shutdown diagnostics.
import Std

set_option autoImplicit false

namespace ShutdownScreenLog

-- Vocabulary: shutdown kind, one awaited handler, and the host-owned control steps.
inductive ShutdownKind where
  | interactive
  | signal
  | reload
  | print
  | rpc
  | headless
  deriving Repr, DecidableEq

structure Hook where
  elapsedMs : Nat
  deriving Repr, DecidableEq

-- Inputs are the shutdown path, the existing slow-hook threshold, and serial handlers.
structure Input where
  kind : ShutdownKind
  thresholdMs : Nat
  hooks : List Hook
  deriving Repr, DecidableEq

inductive Step where
  | drainInput
  | stop
  | enableProgress
  | dispose
  | disableProgress
  deriving Repr, DecidableEq

-- Outputs record order, terminal visibility, JSONL, session cards, and forbidden payload/context writes.
structure Output where
  steps : List Step
  waitingShown : Nat → Bool
  leftOnTerminal : Nat → Bool
  writtenToJsonl : Nat → Bool
  writesSessionEntry : Nat → Bool
  usesInteractiveSink : Bool
  writesModelContext : Bool
  writesPrivatePayload : Bool

-- Guards: known handlers exist; slow means strictly above the existing threshold.
private def isKnownHandler (input : Input) (index : Nat) : Bool :=
  index < input.hooks.length

private def isSlowHandler (input : Input) (index : Nat) : Bool :=
  match input.hooks[index]? with
  | some hook => input.thresholdMs < hook.elapsedMs
  | none => false

private def usesInteractiveSink (kind : ShutdownKind) : Bool :=
  match kind with
  | .interactive => true
  | .signal | .reload | .print | .rpc | .headless => false

-- Interactive path: drain, stop TUI, enable sink, dispose, disable sink. Terminal diagnostics are session-free.
-- Signal path: dispose first and never attach the interactive terminal sink.
-- Other noninteractive paths keep legacy slow custom entries and never use the post-TUI sink.
def run (input : Input) : Output :=
  let sessionEntry := fun index =>
    !usesInteractiveSink input.kind && isKnownHandler input index && isSlowHandler input index
  match input.kind with
  | .interactive =>
    {
      steps := [.drainInput, .stop, .enableProgress, .dispose, .disableProgress]
      waitingShown := isKnownHandler input
      leftOnTerminal := fun index =>
        isKnownHandler input index && isSlowHandler input index
      writtenToJsonl := isKnownHandler input
      writesSessionEntry := sessionEntry
      usesInteractiveSink := true
      writesModelContext := false
      writesPrivatePayload := false
    }
  | .signal =>
    {
      steps := [.dispose, .drainInput, .stop]
      waitingShown := fun _ => false
      leftOnTerminal := fun _ => false
      writtenToJsonl := isKnownHandler input
      writesSessionEntry := sessionEntry
      usesInteractiveSink := false
      writesModelContext := false
      writesPrivatePayload := false
    }
  | .reload | .print | .rpc | .headless =>
    {
      steps := [.dispose]
      waitingShown := fun _ => false
      leftOnTerminal := fun _ => false
      writtenToJsonl := isKnownHandler input
      writesSessionEntry := sessionEntry
      usesInteractiveSink := false
      writesModelContext := false
      writesPrivatePayload := false
    }

-- Contract: interactive sink is session-free; noninteractive legacy slow entries stay context-excluded.
def processContract (input : Input) (output : Output) : Prop :=
  (input.kind = .interactive →
    output.steps = [.drainInput, .stop, .enableProgress, .dispose, .disableProgress] ∧
    output.usesInteractiveSink = true ∧
    (∀ index, output.waitingShown index = isKnownHandler input index) ∧
    (∀ index, output.leftOnTerminal index = (isKnownHandler input index && isSlowHandler input index)) ∧
    (∀ index, output.writesSessionEntry index = false)) ∧
  (input.kind = .signal →
    output.steps = [.dispose, .drainInput, .stop] ∧
    output.usesInteractiveSink = false ∧
    (∀ index, output.waitingShown index = false) ∧
    (∀ index, output.leftOnTerminal index = false)) ∧
  (input.kind = .reload ∨ input.kind = .print ∨ input.kind = .rpc ∨ input.kind = .headless →
    output.usesInteractiveSink = false ∧
    (∀ index, output.waitingShown index = false) ∧
    (∀ index, output.leftOnTerminal index = false)) ∧
  (input.kind ≠ .interactive →
    (∀ index, output.writesSessionEntry index =
      (isKnownHandler input index && isSlowHandler input index))) ∧
  (∀ index, output.writtenToJsonl index = isKnownHandler input index) ∧
  output.writesModelContext = false ∧
  output.writesPrivatePayload = false

-- Whole-process correctness: every valid input yields an output that satisfies the contract.
theorem process_is_correct (input : Input) : processContract input (run input) := by
  rcases input with ⟨kind, thresholdMs, hooks⟩
  cases kind <;> simp [processContract, run, usesInteractiveSink]

#check process_is_correct
#print axioms process_is_correct

-- Deterministic examples used by the executable summary.
def sampleInteractive : Input := {
  kind := .interactive
  thresholdMs := 100
  hooks := [{ elapsedMs := 12 }, { elapsedMs := 30041 }]
}

def sampleSignal : Input := {
  kind := .signal
  thresholdMs := 100
  hooks := [{ elapsedMs := 30041 }]
}

def sampleReload : Input := {
  kind := .reload
  thresholdMs := 100
  hooks := [{ elapsedMs := 30041 }]
}

def summarize : IO Unit := do
  let interactive := run sampleInteractive
  let signal := run sampleSignal
  let reload := run sampleReload
  IO.println s!"interactive waiting={interactive.waitingShown 0},{interactive.waitingShown 1}; retained={interactive.leftOnTerminal 0},{interactive.leftOnTerminal 1}; sink={interactive.usesInteractiveSink}; session={interactive.writesSessionEntry 0},{interactive.writesSessionEntry 1}; context={interactive.writesModelContext}; private={interactive.writesPrivatePayload}"
  IO.println s!"signal waiting={signal.waitingShown 0}; retained={signal.leftOnTerminal 0}; sink={signal.usesInteractiveSink}; session={signal.writesSessionEntry 0}; jsonl={signal.writtenToJsonl 0}; context={signal.writesModelContext}"
  IO.println s!"reload waiting={reload.waitingShown 0}; retained={reload.leftOnTerminal 0}; sink={reload.usesInteractiveSink}; session={reload.writesSessionEntry 0}; context={reload.writesModelContext}"

end ShutdownScreenLog

def main : IO Unit := ShutdownScreenLog.summarize
