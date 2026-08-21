-- Core Lean facilities keep this configured-OmniRoute refresh model self-contained and explicit.
import Std

set_option autoImplicit false

namespace ModelCatalogRefresh

-- Process vocabulary separates endpoint outcomes from the aggregate command status.
inductive EndpointResult where
  | ready
  | failed
  | timedOut
  deriving DecidableEq, Repr

inductive RefreshStatus where
  | succeeded
  | failed
  deriving DecidableEq, Repr

-- Process data scopes publication counts to OmniRoute while recording failures from other providers separately.
structure OmniRouteRefreshInput where
  extensionLoaded : Bool
  primaryCatalog : EndpointResult
  supplementalCatalog : EndpointResult
  otherProviderFailed : Bool
  cachedOmniRouteModelCount : Nat
  discoveredOmniRouteModelCount : Nat
  deriving Repr

structure RefreshOutput where
  commandStatus : RefreshStatus
  persistedOmniRouteModelCount : Nat
  deriving DecidableEq, Repr

-- Guards and transitions require extension loading plus both OmniRoute endpoints before publishing that provider's snapshot.
def endpointsReady (input : OmniRouteRefreshInput) : Bool :=
  input.primaryCatalog == .ready && input.supplementalCatalog == .ready

def runRefresh (input : OmniRouteRefreshInput) : RefreshOutput :=
  if !input.extensionLoaded then
    { commandStatus := .failed, persistedOmniRouteModelCount := input.cachedOmniRouteModelCount }
  else if !endpointsReady input then
    { commandStatus := .failed, persistedOmniRouteModelCount := input.cachedOmniRouteModelCount }
  else
    {
      commandStatus := if input.otherProviderFailed then .failed else .succeeded
      persistedOmniRouteModelCount := input.discoveredOmniRouteModelCount
    }

-- Aggregate command success excludes extension, endpoint, and other-provider failures.
def successful (output : RefreshOutput) : Prop := output.commandStatus = .succeeded

-- Supporting lemmas prove command success preconditions, OmniRoute atomicity, and intentional per-provider publication.
theorem command_success_requires_complete_refresh
    (input : OmniRouteRefreshInput)
    (success : successful (runRefresh input)) :
    input.extensionLoaded = true ∧
    input.primaryCatalog = .ready ∧
    input.supplementalCatalog = .ready ∧
    input.otherProviderFailed = false ∧
    (runRefresh input).persistedOmniRouteModelCount = input.discoveredOmniRouteModelCount := by
  cases loaded : input.extensionLoaded <;>
    cases primary : input.primaryCatalog <;>
      cases supplemental : input.supplementalCatalog <;>
        cases other : input.otherProviderFailed <;>
          simp [successful, runRefresh, endpointsReady, loaded, primary, supplemental, other] at success ⊢

theorem omniRoute_failure_preserves_cached_catalog
    (input : OmniRouteRefreshInput)
    (failure : input.extensionLoaded = false ∨ endpointsReady input = false) :
    (runRefresh input).persistedOmniRouteModelCount = input.cachedOmniRouteModelCount := by
  cases loaded : input.extensionLoaded <;>
    cases primary : input.primaryCatalog <;>
      cases supplemental : input.supplementalCatalog <;>
        simp [runRefresh, endpointsReady, loaded, primary, supplemental] at failure ⊢

theorem omniRoute_success_publishes_discovered_catalog
    (input : OmniRouteRefreshInput)
    (loaded : input.extensionLoaded = true)
    (ready : endpointsReady input = true) :
    (runRefresh input).persistedOmniRouteModelCount = input.discoveredOmniRouteModelCount := by
  simp [runRefresh, loaded, ready]

theorem other_provider_failure_does_not_rollback_omniRoute
    (input : OmniRouteRefreshInput)
    (loaded : input.extensionLoaded = true)
    (ready : endpointsReady input = true)
    (otherFailure : input.otherProviderFailed = true) :
    (runRefresh input).commandStatus = .failed ∧
    (runRefresh input).persistedOmniRouteModelCount = input.discoveredOmniRouteModelCount := by
  simp [runRefresh, loaded, ready, otherFailure]

-- Top-level correctness distinguishes command-wide status from OmniRoute's provider-local all-or-nothing publication.
theorem model_catalog_refresh_is_correct (input : OmniRouteRefreshInput) :
    (successful (runRefresh input) →
      input.extensionLoaded = true ∧
      input.primaryCatalog = .ready ∧
      input.supplementalCatalog = .ready ∧
      input.otherProviderFailed = false ∧
      (runRefresh input).persistedOmniRouteModelCount = input.discoveredOmniRouteModelCount) ∧
    ((input.extensionLoaded = false ∨ endpointsReady input = false) →
      (runRefresh input).persistedOmniRouteModelCount = input.cachedOmniRouteModelCount) ∧
    ((input.extensionLoaded = true ∧ endpointsReady input = true) →
      (runRefresh input).persistedOmniRouteModelCount = input.discoveredOmniRouteModelCount) ∧
    ((input.extensionLoaded = true ∧ endpointsReady input = true ∧ input.otherProviderFailed = true) →
      (runRefresh input).commandStatus = .failed ∧
      (runRefresh input).persistedOmniRouteModelCount = input.discoveredOmniRouteModelCount) := by
  exact ⟨
    command_success_requires_complete_refresh input,
    omniRoute_failure_preserves_cached_catalog input,
    fun ⟨loaded, ready⟩ => omniRoute_success_publishes_discovered_catalog input loaded ready,
    fun ⟨loaded, ready, otherFailure⟩ =>
      other_provider_failure_does_not_rollback_omniRoute input loaded ready otherFailure
  ⟩

#print axioms model_catalog_refresh_is_correct

-- Deterministic executable input demonstrates a successful cached-to-discovered OmniRoute transition.
def exampleInput : OmniRouteRefreshInput := {
  extensionLoaded := true
  primaryCatalog := .ready
  supplementalCatalog := .ready
  otherProviderFailed := false
  cachedOmniRouteModelCount := 350
  discoveredOmniRouteModelCount := 351
}

end ModelCatalogRefresh

-- Executable summary exposes the modeled result without performing network or filesystem effects.
def main : IO Unit :=
  IO.println s!"model catalog refresh: {repr (ModelCatalogRefresh.runRefresh ModelCatalogRefresh.exampleInput)}; correctness theorem accepted"
