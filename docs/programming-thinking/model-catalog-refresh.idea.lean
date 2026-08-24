-- Core definitions model command scope, provider origin, refresh results, and observable output.
import Std

set_option autoImplicit false

namespace ModelCatalogRefresh

inductive Command where
  | updateManagedCatalogs
  | listModels
  deriving DecidableEq, Repr

inductive CatalogSource where
  | managed
  | extension
  deriving DecidableEq, Repr

inductive RefreshResult where
  | succeeded
  | failed
  deriving DecidableEq, Repr

structure ProviderCatalog where
  source : CatalogSource
  cachedModelCount : Nat
  refreshedModelCount : Nat
  refreshResult : RefreshResult
  deriving DecidableEq, Repr

structure Invocation where
  command : Command
  refreshRequested : Bool
  offline : Bool
  providers : List ProviderCatalog
  deriving DecidableEq, Repr

structure Outcome where
  extensionLifecycleLoaded : Bool
  networkRefreshCount : Nat
  modelsListed : Bool
  exitSuccess : Bool
  visibleModelCounts : List Nat
  deriving DecidableEq, Repr

-- Guards separate Pi-managed catalog maintenance from full extension-aware listing.
def managedProviders (providers : List ProviderCatalog) : List ProviderCatalog :=
  providers.filter fun provider => provider.source == .managed

def refreshSucceeded (provider : ProviderCatalog) : Bool :=
  provider.refreshResult == .succeeded

def allRefreshesSucceeded (providers : List ProviderCatalog) : Bool :=
  providers.all refreshSucceeded

def visibleModelCount (refreshRequested : Bool) (provider : ProviderCatalog) : Nat :=
  if refreshRequested then
    match provider.refreshResult with
    | .succeeded => provider.refreshedModelCount
    | .failed => provider.cachedModelCount
  else
    provider.cachedModelCount

-- Transition semantics keep update managed-only and make list refresh extension-aware, cache-preserving, and observable.
def run (invocation : Invocation) : Outcome :=
  match invocation.command with
  | .updateManagedCatalogs =>
      let providers := managedProviders invocation.providers
      {
        extensionLifecycleLoaded := false
        networkRefreshCount := providers.length
        modelsListed := false
        exitSuccess := allRefreshesSucceeded providers
        visibleModelCounts := []
      }
  | .listModels =>
      if invocation.refreshRequested && invocation.offline then
        {
          extensionLifecycleLoaded := false
          networkRefreshCount := 0
          modelsListed := false
          exitSuccess := false
          visibleModelCounts := []
        }
      else
        {
          extensionLifecycleLoaded := true
          networkRefreshCount := if invocation.refreshRequested then invocation.providers.length else 0
          modelsListed := true
          exitSuccess := if invocation.refreshRequested then allRefreshesSucceeded invocation.providers else true
          visibleModelCounts := invocation.providers.map (visibleModelCount invocation.refreshRequested)
        }

-- Scope lemmas prove update never substitutes for extension loading or model-list output.
theorem update_does_not_load_extensions_or_list (invocation : Invocation) :
    let outcome := run { invocation with command := .updateManagedCatalogs }
    outcome.extensionLifecycleLoaded = false ∧ outcome.modelsListed = false := by
  simp [run]

-- Cached-list lemmas prove default list behavior restores registered providers without network access.
theorem cached_list_uses_full_lifecycle_without_network
    (invocation : Invocation) :
    let outcome := run {
      invocation with
      command := .listModels
      refreshRequested := false
    }
    outcome.extensionLifecycleLoaded = true ∧
      outcome.networkRefreshCount = 0 ∧
      outcome.modelsListed = true ∧
      outcome.visibleModelCounts = invocation.providers.map (fun provider => provider.cachedModelCount) := by
  simp [run, visibleModelCount]

-- Online-refresh lemmas prove every loaded provider participates before list output.
theorem refreshed_list_attempts_every_loaded_provider
    (invocation : Invocation)
    (online : invocation.offline = false) :
    let outcome := run {
      invocation with
      command := .listModels
      refreshRequested := true
    }
    outcome.extensionLifecycleLoaded = true ∧
      outcome.networkRefreshCount = invocation.providers.length ∧
      outcome.modelsListed = true := by
  simp [run, online]

-- Provider-local publication lemmas distinguish successful replacement from failed cached fallback.
theorem successful_provider_shows_refreshed_models
    (provider : ProviderCatalog)
    (success : provider.refreshResult = .succeeded) :
    visibleModelCount true provider = provider.refreshedModelCount := by
  simp [visibleModelCount, success]

theorem failed_provider_keeps_cached_models
    (provider : ProviderCatalog)
    (failure : provider.refreshResult = .failed) :
    visibleModelCount true provider = provider.cachedModelCount := by
  simp [visibleModelCount, failure]

-- Command-result lemmas prove partial failure remains visible through list output and a failing exit status.
theorem incomplete_refresh_still_lists_but_fails
    (invocation : Invocation)
    (online : invocation.offline = false)
    (failure : allRefreshesSucceeded invocation.providers = false) :
    let outcome := run {
      invocation with
      command := .listModels
      refreshRequested := true
    }
    outcome.modelsListed = true ∧ outcome.exitSuccess = false := by
  simp [run, online, failure]

-- Offline safety rejects requested network work before extension loading, refresh, or output.
theorem offline_refresh_rejects_before_network_or_listing
    (invocation : Invocation)
    (offline : invocation.offline = true) :
    let outcome := run {
      invocation with
      command := .listModels
      refreshRequested := true
    }
    outcome.extensionLifecycleLoaded = false ∧
      outcome.networkRefreshCount = 0 ∧
      outcome.modelsListed = false ∧
      outcome.exitSuccess = false := by
  simp [run, offline]

-- Top-level correctness combines command separation, cache-only listing, full-provider refresh, and offline rejection.
theorem model_catalog_refresh_is_correct
    (invocation : Invocation) :
    (let updateOutcome := run {
        invocation with
        command := .updateManagedCatalogs
      };
      updateOutcome.extensionLifecycleLoaded = false ∧ updateOutcome.modelsListed = false) ∧
    (let cachedOutcome := run {
        invocation with
        command := .listModels
        refreshRequested := false
      };
      cachedOutcome.extensionLifecycleLoaded = true ∧
        cachedOutcome.networkRefreshCount = 0 ∧
        cachedOutcome.modelsListed = true ∧
        cachedOutcome.visibleModelCounts = invocation.providers.map (fun provider => provider.cachedModelCount)) ∧
    (invocation.offline = false →
      let refreshedOutcome := run {
        invocation with
        command := .listModels
        refreshRequested := true
      };
      refreshedOutcome.extensionLifecycleLoaded = true ∧
        refreshedOutcome.networkRefreshCount = invocation.providers.length ∧
        refreshedOutcome.modelsListed = true) ∧
    (invocation.offline = true →
      let rejectedOutcome := run {
        invocation with
        command := .listModels
        refreshRequested := true
      };
      rejectedOutcome.networkRefreshCount = 0 ∧ rejectedOutcome.modelsListed = false) := by
  exact ⟨
    update_does_not_load_extensions_or_list invocation,
    cached_list_uses_full_lifecycle_without_network invocation,
    fun online => refreshed_list_attempts_every_loaded_provider invocation online,
    fun offline => ⟨
      (offline_refresh_rejects_before_network_or_listing invocation offline).2.1,
      (offline_refresh_rejects_before_network_or_listing invocation offline).2.2.1
    ⟩
  ⟩

#print axioms model_catalog_refresh_is_correct

end ModelCatalogRefresh

-- Executable summary demonstrates one refreshed managed provider and one failed extension provider retaining cache.
def main : IO Unit := do
  let invocation : ModelCatalogRefresh.Invocation := {
    command := .listModels
    refreshRequested := true
    offline := false
    providers := [
      {
        source := .managed
        cachedModelCount := 10
        refreshedModelCount := 11
        refreshResult := .succeeded
      },
      {
        source := .extension
        cachedModelCount := 350
        refreshedModelCount := 351
        refreshResult := .failed
      }
    ]
  }
  IO.println s!"list refresh: {repr (ModelCatalogRefresh.run invocation)}"
  IO.println "proved: update is managed-only; list refresh loads extensions, preserves failed caches, and reports incomplete refresh"
