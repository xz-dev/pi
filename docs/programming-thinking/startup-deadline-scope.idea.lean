import Std

-- This document models staged startup deadlines and fatal-error presentation without performing runtime work.
set_option autoImplicit false

namespace StartupDeadlineScope

-- StartupPhase names the ordered core phases whose budgets must not leak into one another.
inductive StartupPhase where
  | initialModelRefresh
  | extensionLoading
  | registrationRefresh
  | ready
  deriving DecidableEq, Repr

structure DeadlinePlan where
  initialCreatedAt : Nat
  extensionsFinishedAt : Nat
  registrationCreatedAt : Nat
  deriving DecidableEq, Repr

-- Deadline predicates distinguish a fresh registration budget from the old shared absolute deadline.
def registrationDeadlineIsFresh (plan : DeadlinePlan) : Prop :=
  plan.registrationCreatedAt = plan.extensionsFinishedAt

def extensionTimeConsumesRegistrationBudget (plan : DeadlinePlan) : Bool :=
  plan.registrationCreatedAt < plan.extensionsFinishedAt

theorem fresh_deadline_excludes_extension_time
    (plan : DeadlinePlan)
    (fresh : registrationDeadlineIsFresh plan) :
    extensionTimeConsumesRegistrationBudget plan = false := by
  unfold registrationDeadlineIsFresh at fresh
  unfold extensionTimeConsumesRegistrationBudget
  rw [fresh]
  simp

-- Startup outcomes preserve explicit caller cancellation while making the local registration timeout nonfatal.
inductive StartupOutcome where
  | readyWithFreshModels
  | readyWithCachedModels
  | callerCancelled
  deriving DecidableEq, Repr

def finishStartup (callerCancelled registrationTimedOut : Bool) : StartupOutcome :=
  if callerCancelled then
    .callerCancelled
  else if registrationTimedOut then
    .readyWithCachedModels
  else
    .readyWithFreshModels

def isReady : StartupOutcome → Bool
  | .readyWithFreshModels => true
  | .readyWithCachedModels => true
  | .callerCancelled => false

theorem caller_cancellation_wins (registrationTimedOut : Bool) :
    finishStartup true registrationTimedOut = .callerCancelled := by
  simp [finishStartup]

theorem registration_timeout_is_nonfatal :
    finishStartup false true = .readyWithCachedModels := by
  rfl

theorem successful_refresh_is_ready :
    finishStartup false false = .readyWithFreshModels := by
  rfl

theorem every_non_cancelled_startup_is_ready (registrationTimedOut : Bool) :
    isReady (finishStartup false registrationTimedOut) = true := by
  cases registrationTimedOut <;> rfl

-- Fatal presentation records that DOM exceptions occupy one concise terminal line instead of a raw object dump.
inductive FatalErrorKind where
  | domException
  | ordinaryError
  | nonError
  deriving DecidableEq, Repr

def fatalOutputLineCount : FatalErrorKind → Nat
  | .domException => 1
  | .ordinaryError => 2
  | .nonError => 1

theorem dom_exception_output_is_single_line :
    fatalOutputLineCount .domException = 1 := by
  rfl

-- StartupContract combines deadline freshness, cancellation, cached-state fallback, readiness, and concise failure output.
structure StartupContract (plan : DeadlinePlan) : Prop where
  registrationDeadlineFresh : registrationDeadlineIsFresh plan
  extensionTimeExcluded : extensionTimeConsumesRegistrationBudget plan = false
  timeoutContinuesWithCache : finishStartup false true = .readyWithCachedModels
  cancellationStopsStartup : ∀ timedOut, finishStartup true timedOut = .callerCancelled
  normalStartupReady : finishStartup false false = .readyWithFreshModels
  domExceptionOutputConcise : fatalOutputLineCount .domException = 1

-- Top-level correctness assembles every declared startup guarantee from a fresh per-phase deadline.
theorem startup_deadline_scope_is_correct
    (plan : DeadlinePlan)
    (fresh : registrationDeadlineIsFresh plan) :
    StartupContract plan := by
  exact {
    registrationDeadlineFresh := fresh
    extensionTimeExcluded := fresh_deadline_excludes_extension_time plan fresh
    timeoutContinuesWithCache := registration_timeout_is_nonfatal
    cancellationStopsStartup := caller_cancellation_wins
    normalStartupReady := successful_refresh_is_ready
    domExceptionOutputConcise := dom_exception_output_is_single_line
  }

#print axioms startup_deadline_scope_is_correct

end StartupDeadlineScope

-- Executable output summarizes the proved startup policy for human verification.
def main : IO Unit :=
  IO.println "Startup deadline contract: fresh registration budget, cached-state timeout fallback, caller cancellation preserved."
