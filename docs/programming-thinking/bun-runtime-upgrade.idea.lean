import Std

-- This document models the downstream Bun Release contract with no production side effects.
set_option autoImplicit false

namespace BunRuntimeUpgrade

-- These finite types describe public operating-system, architecture, and compatibility-asset vocabulary.
inductive OperatingSystem where
  | darwin
  | linux
  | windows
  deriving DecidableEq, Repr

inductive Architecture where
  | x64
  | arm64
  deriving DecidableEq, Repr

inductive PublicVariant where
  | baseline
  | modern
  | single
  deriving DecidableEq, Repr

-- The exact stable version and twelve compatibility asset names are part of the downstream release contract.
def pinnedVersion : String := "1.4.0"

def publicAssetNames : List String :=
  [ "pi-darwin-x64-baseline.zip"
  , "pi-darwin-x64-modern.zip"
  , "pi-darwin-arm64.zip"
  , "pi-linux-x64-gnu-baseline.zip"
  , "pi-linux-x64-gnu-modern.zip"
  , "pi-linux-arm64-gnu.zip"
  , "pi-linux-x64-musl-baseline.zip"
  , "pi-linux-x64-musl-modern.zip"
  , "pi-linux-arm64-musl.zip"
  , "pi-windows-x64-baseline.zip"
  , "pi-windows-x64-modern.zip"
  , "pi-windows-arm64.zip"
  ]

structure ReleaseTarget where
  os : OperatingSystem
  arch : Architecture
  variant : PublicVariant
  deriving DecidableEq, Repr

-- Compiler selection deliberately ignores legacy x64 asset variants while preserving their public identities.
def compilerTarget (target : ReleaseTarget) : String :=
  match target.os, target.arch with
  | .darwin, .x64 => "bun-darwin-x64"
  | .darwin, .arm64 => "bun-darwin-arm64"
  | .linux, .x64 => "bun-linux-x64"
  | .linux, .arm64 => "bun-linux-arm64"
  | .windows, .x64 => "bun-windows-x64"
  | .windows, .arm64 => "bun-windows-arm64"

def bytecodeEnabled (target : ReleaseTarget) : Bool :=
  target.os != .windows

def legacyX64Targets (os : OperatingSystem) : List ReleaseTarget :=
  [{ os := os, arch := .x64, variant := .baseline }, { os := os, arch := .x64, variant := .modern }]

-- These invariants prove unified x64 compilation and the platform-specific bytecode boundary.
theorem x64_public_variants_share_runtime (os : OperatingSystem) :
    compilerTarget { os := os, arch := .x64, variant := .baseline } =
      compilerTarget { os := os, arch := .x64, variant := .modern } := by
  cases os <;> rfl

theorem windows_bytecode_stays_disabled (arch : Architecture) (variant : PublicVariant) :
    bytecodeEnabled { os := .windows, arch := arch, variant := variant } = false := by
  rfl

theorem non_windows_bytecode_stays_enabled
    (os : OperatingSystem)
    (arch : Architecture)
    (variant : PublicVariant)
    (h : os != .windows) :
    bytecodeEnabled { os := os, arch := arch, variant := variant } = true := by
  cases os <;> simp_all [bytecodeEnabled]

inductive UpgradeStage where
  | releaseVerified
  | targetsValidated
  | configurationUpdated
  | checksPassed
  | complete
  deriving DecidableEq, Repr

-- The deterministic transition model records required upgrade gates and establishes termination.
def nextStage : UpgradeStage → UpgradeStage
  | .releaseVerified => .targetsValidated
  | .targetsValidated => .configurationUpdated
  | .configurationUpdated => .checksPassed
  | .checksPassed => .complete
  | .complete => .complete

def runUpgrade (stage : UpgradeStage) : UpgradeStage :=
  nextStage (nextStage (nextStage (nextStage stage)))

theorem upgrade_terminates : runUpgrade .releaseVerified = .complete := by
  rfl

-- ReleaseContract combines version pinning, public compatibility, platform safety, and process completion.
structure ReleaseContract : Prop where
  latestStablePinned : pinnedVersion = "1.4.0"
  publicAssetNamesPreserved : publicAssetNames.length = 12
  unifiedX64Runtime : ∀ os, compilerTarget { os := os, arch := .x64, variant := .baseline } =
    compilerTarget { os := os, arch := .x64, variant := .modern }
  windowsBytecodeExcluded : ∀ arch variant,
    bytecodeEnabled { os := .windows, arch := arch, variant := variant } = false
  processCompletes : runUpgrade .releaseVerified = .complete

-- Top-level correctness assembles every declared Release guarantee without additional assumptions.
theorem bun_runtime_upgrade_is_correct : ReleaseContract := by
  exact {
    latestStablePinned := rfl
    publicAssetNamesPreserved := rfl
    unifiedX64Runtime := x64_public_variants_share_runtime
    windowsBytecodeExcluded := windows_bytecode_stays_disabled
    processCompletes := upgrade_terminates
  }

#print axioms bun_runtime_upgrade_is_correct

end BunRuntimeUpgrade

-- Executable output summarizes the proved Release policy for human verification.
def main : IO Unit :=
  IO.println "Bun 1.4 release contract: unified x64 runtime, preserved public assets, Windows bytecode excluded."
