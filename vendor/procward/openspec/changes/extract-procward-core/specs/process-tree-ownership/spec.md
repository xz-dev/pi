## Purpose

Give arbitrary commands a bounded owned process-tree lifetime without signalling unrelated processes, retaining adopted zombies or losing the command's actual result.

## ADDED Requirements

### Requirement: Run an owned command
Procward SHALL support `procward run [options] -- <cmd> [args...]`, execute argv directly without adding a shell, and clean up its owned tree on primary exit, owner death, termination signals or terminal loss. On macOS this guarantee SHALL cover observed descendants within the documented best-effort boundary.

#### Scenario: Primary exits before a detached descendant
- **WHEN** a fresh fixture creates a detached descendant, ownership/observation is established and the primary exits with status 23
- **THEN** procward cleans up the owned descendant before reporting successful completion with status 23

#### Scenario: Owner dies during active work
- **WHEN** an owner is killed while its tree contains running and stopped descendants and an independent cleanup role survives
- **THEN** the tree is cleaned up within the teardown bound without requiring `fg` or cooperation from the command

### Requirement: Support nested ownership
`procward run` inside another procward-managed tree SHALL add an independent ownership layer by default. Both layers SHALL preserve the payload result after successful cleanup. Outer-owner loss SHALL clean the whole nested tree within the outer configured deadline, and inner-owner loss SHALL clean the inner subtree while the outer layer reports its primary's native result. The inner payload SHALL receive only the inner contract metadata and SHALL NOT inherit the outer lifecycle fd/HANDLE. macOS SHALL retain its documented observed-tree best-effort boundary rather than claim kernel containment. Stale, closed or mismatched inherited application metadata SHALL NOT authorize managed state or prevent a fresh ownership layer. Explicit native/task endpoints and a consumer accepting its own READY SHALL remain strictly validated.

#### Scenario: Ordinary intermediary closes inherited descriptors
- **WHEN** a shell or Python subprocess launches an inner procward while retaining stale outer application metadata
- **THEN** the inner procward establishes fresh ownership, cleans its tree, and supplies only its own contract to its payload

#### Scenario: Nested payload exits
- **WHEN** `procward run -- procward run -- <fixture tree>` has a payload that exits 23 with descendants still running
- **THEN** both layers report 23 after cleanup and no owned process survives within the platform's documented guarantee

#### Scenario: Outer owner is lost
- **WHEN** the outer owner is killed after nested startup
- **THEN** its surviving cleanup role or kernel Job cleans the inner layer and its descendants within the outer configured deadline

#### Scenario: Inner owner is lost
- **WHEN** the inner owner is killed after nested startup
- **THEN** its subtree is cleaned and the outer layer reports the inner primary's native termination result after completing its own cleanup

#### Scenario: Inner payload accepts readiness
- **WHEN** the nested payload validates its lifecycle READY record
- **THEN** owner identity, launch ID and transport refer only to the inner layer and no outer lifecycle endpoint is inherited

### Requirement: Preserve inputs and fail startup safely
Procward SHALL preserve argument boundaries, cwd, environment and stdio destinations except for the documented managed handoff and necessary terminal isolation. Invalid options, missing commands, invalid explicit native/task endpoints or required ownership setup failure SHALL fail visibly before payload side effects, without silently launching unmanaged.

#### Scenario: Argument contains spaces and option-like text
- **WHEN** `procward run -- <fixture> "two words" --literal` runs with stderr redirected
- **THEN** the fixture receives exactly those two arguments and stderr keeps its destination

#### Scenario: Required ownership setup fails
- **WHEN** startup cannot acquire its required backend or validate its launch permission
- **THEN** procward reports failure and the fixture's payload marker is absent

### Requirement: Use live identity as signal authority
Procward MUST NOT signal unrelated processes through stale PIDs/PGIDs. Nondirect targets SHALL be birth-validated or held by stable OS handles; unreaped direct-child ownership or a kernel-owned subtree SHALL provide corresponding authority. Query failure SHALL NOT prove absence. Stopped processes SHALL count as alive.

#### Scenario: Numeric PID is reused
- **WHEN** a previously owned process exits and its PID is reused by unrelated work
- **THEN** the stale observation cannot authorize signalling the new process

#### Scenario: Process inventory is denied
- **WHEN** an inventory or identity query fails
- **THEN** cleanup reports the failure rather than declaring the target gone

### Requirement: Keep teardown bounded and ordered
Unix cleanup SHALL deliver TERM before any teardown CONT to a stopped target, then escalate to KILL at the selected grace boundary. `procward run` SHALL accept `--grace <dur>`, `--fatal-grace <dur>` and `--cleanup-deadline <dur>`, with defaults 6 seconds, 3 seconds and 7.5 seconds respectively; durations use integer `ms` or `s` suffixes. Startup SHALL validate `0 < fatal-grace <= grace < cleanup-deadline`; invalid durations/order SHALL return 2 before payload execution. Linux/FreeBSD abnormal-owner cleanup SHALL select configured ordinary grace, or configured fatal grace only when an already saved helper wait status proves fatal signal termination at selection. EOF alone SHALL NOT select fatal grace. One system-wide monotonic start and selected policy SHALL govern the owned tree across native-role failover: adoption, role loss and later status discovery SHALL NOT restart or extend grace/deadline. No rescue CONT SHALL occur after that policy permits it or repeatedly during active shutdown. With default timings, native fault teardown SHALL complete within 8 seconds of fault injection in acceptance tests; non-default failover tests SHALL enforce the original configured cleanup deadline, not a replacement role-relative budget.

#### Scenario: Fatal helper status is already known
- **WHEN** cleanup selects policy with a saved signalled helper status
- **THEN** it selects configured fatal grace (3 seconds by default), delivers TERM before permitted CONT and retains the original configured cleanup deadline (7.5 seconds by default)

#### Scenario: EOF precedes waitable exit
- **WHEN** cleanup begins on EOF before fatal helper status is available
- **THEN** it selects configured ordinary grace (6 seconds by default) and does not reselect it when status later arrives

#### Scenario: Native role dies during active cleanup
- **WHEN** the anchor publishes the original monotonic cleanup start/policy and then dies while cleanup is already active
- **THEN** the surviving owner uses only the remaining original budget, retaining selected grace and going directly to KILL if grace already elapsed
- **AND** the private one-shot policy record is separate from application/lease transports and never inherited by the payload

#### Scenario: Anchor dies after the first teardown CONT
- **WHEN** a retained identity has received TERM then one CONT and the anchor dies during grace
- **THEN** fallback retains that identity's progress, does not repeat CONT and completes under the original configured deadline
- **AND** genuinely untreated identities still receive their first ordered TERM/CONT if adopted during grace

#### Scenario: Anchor dies before policy publication
- **WHEN** an anchor dies without having started/published cleanup
- **THEN** the surviving owner selects its first policy from that fault observation rather than inventing a prior start

#### Scenario: Cleanup timings are invalid
- **WHEN** durations are malformed, missing, duplicated or violate `0 < fatal-grace <= grace < cleanup-deadline`
- **THEN** procward returns 2 and no payload side effect occurs

#### Scenario: Adoption occurs after grace
- **WHEN** a stopped descendant is adopted after the selected grace expires
- **THEN** cleanup continues escalation/reaping without a fresh grace or rescue CONT

### Requirement: Reap orphans during healthy work
Reaper-capable Unix backends SHALL promptly reap exited adopted children while the primary remains alive, without consuming or overwriting the primary's result. Reaping SHALL NOT wait until overall shutdown.

#### Scenario: Adopted grandchild exits first
- **WHEN** a fixture orphans a grandchild that exits while the primary continues running
- **THEN** the owning reaper removes the zombie during healthy operation and later preserves the primary's result

### Requirement: Separate primary exit from tree completion
Procward SHALL preserve primary exit status after successful cleanup, including Unix signal-derived status and native Windows 32-bit status. Primary exit, helper close or a drop guard alone SHALL NOT be accepted as proof of whole-tree cleanup. Known survivors, denied signals and expired deadlines SHALL fail cleanup; macOS completion SHALL explicitly mean a completed best-effort sweep.

#### Scenario: Primary exited but descendants remain
- **WHEN** a primary exit is observed before its descendants are gone
- **THEN** procward starts/finishes tree cleanup rather than resolving on primary exit alone

#### Scenario: Command dies from signal 15
- **WHEN** a Unix primary dies from signal 15 and cleanup succeeds
- **THEN** the CLI reports status 143

#### Scenario: Completion cannot be proved in time
- **WHEN** cleanup reaches its deadline with a known survivor or missing required completion evidence
- **THEN** procward returns cleanup failure, not a successful acknowledgement

### Requirement: Expose a generic managed-child contract
Procward SHALL expose a versioned managed-child environment and fd/handle handoff, without a pi-specific mode. Readiness SHALL require a bounded complete record and matching live immediate-parent identity; environment strings alone SHALL NOT prove managed state. Stale, incomplete, oversized and unsupported records SHALL fail closed. Application transports SHALL be distinct from native leases and Job handles; ordinary children SHALL inherit neither private ownership endpoints nor reusable direct-primary claims.

#### Scenario: Direct primary accepts managed readiness
- **WHEN** a standalone primary receives a complete supported ready record matching its live immediate parent and identity
- **THEN** it can accept managed state without depending on pi

#### Scenario: Invalid or truncated handoff
- **WHEN** a record is stale, incomplete, oversized, unsupported or ends at transport EOF before readiness
- **THEN** the consumer rejects managed state before application side effects

#### Scenario: Primary launches an ordinary child
- **WHEN** a managed primary starts a tool
- **THEN** no private native lease or Job handle leaks and inherited metadata cannot authorize a reusable direct-primary claim

### Requirement: Notify primary before bounded owner-loss termination
Procward SHALL notify the primary of owner loss and allow cooperative shutdown within the already selected `--grace`, `--fatal-grace` and `--cleanup-deadline` policy. A blocked or unresponsive primary SHALL NOT prevent independent native cleanup at the configured deadline. Notification and retries SHALL NOT restart or extend that policy. Fixed application hook/watchdog durations SHALL remain application policy, not procward requirements.

#### Scenario: Primary cooperates after owner loss
- **WHEN** a standalone primary observes owner-loss notification and finishes within selected grace
- **THEN** native cleanup permits that response while retaining the original deadline

#### Scenario: Primary cannot respond
- **WHEN** a standalone primary blocks after readiness and owner loss occurs
- **THEN** independent cleanup terminates it within the configured deadline without waiting for an application hook

#### Scenario: Response remains not ready or silent
- **WHEN** interaction receives explicit not-ready replies or no reply
- **THEN** retries remain response-driven and silence or endless hints fail at the original bounded deadline

### Requirement: Expose generic per-task completion
Per-task `procward run` SHALL report control, primary result and cleanup as distinct facts, support cancellation and preserve native status. Success SHALL require valid cleanup acknowledgement plus transport drain/close; primary exit alone SHALL NOT prove completion. Darwin completion SHALL explicitly mean best-effort cleanup.

#### Scenario: Task result arrives before cleanup
- **WHEN** a task reports a primary result but closes transport without required cleanup acknowledgement
- **THEN** its consumer reports unconfirmed cleanup instead of task success
