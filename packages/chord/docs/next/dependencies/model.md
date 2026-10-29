# Dependency resolution in Chord v2: one model (draft 7, redesign session, 2026-10-29)

Status: proposal for the owner, not decided. Built in slice 7 with reload and rollout. Sources: the owner's direction
("park until resolved"; "no difference between local and remote resolution: a link going is like a plugin
unloading"), the reviews (`/tmp/dep-mechanism-*.md`, `/tmp/dep-graph-*.md`, `/tmp/barrier-*.md`,
`/tmp/model/review{1,2}-*.md`), the code at pi `358f7d46a`. **Owner** marks an open decision.

Draft 7 (round 6): (A) also retries in lockstep without finding the cycle (Fable); the probe's recovery after a
suppressed search becomes a choice between (B1) a re-search backoff for probes only (recommended) and (B2) a full
search lifecycle without timers, since `dead` notices alone need recovery state that eviction may not drop (Astra, Sol).
Causes are compared by value on wakes (Opus).
Round 7: a returned search is accepted while its initiator is parked, whatever its round (Astra: re-searches must not
invalidate searches under way); detection is eventual, not within one backoff period; the local walk stays (Opus).

Draft 6 (round 5): cycles across hosts become an owner choice between (A) the owner's slice 4b decision (simultaneous
starts across hosts time out, no probe message), narrowed to one deadline, and (B) the probe, completed with edge
tokens, no revisits, and `dead` notices back to the initiator (Astra: a check that dies silently can lose the only
search that survived dedupe). (A) turned out to either poll chains across hosts again or miss a ring of `waiting`
attempts, so (B) is recommended, pending its review.

Draft 5 (round 4, Sol's phantom cycle): the second round is replaced by a check along the recorded trail of
`(attempt, edge generation)` hops; a reported ring existed at one moment; probes grow with their path.

Draft 4 after round 4 (probe only): round numbers per attempt, forwarded only when newer than the stored one; probes
honoured on parent and route links, dropped on child links; completeness stated under an eventually stable graph; the
repair caveat broadened to any concurrent edge removal; a new edge generation resets confirmation; a bounded display
trail.

Draft 4 changes (round 3): the probe starts a fresh round on every new or changed wait edge (a ring closes at its last
edge, whose source finds it), keeps one seen entry per initiator, accepts only its current round, and states its
cost honestly; every host drops probes from untrusted links; local forwarding is iterative; no-placement remote
requests are re-placed when a host's first parent link connects; a cohort object that ends before its first outcome
settles the barrier; the last-good refinement is marked for the owner.

Draft 3 changes (round 2): remote types without placement keep today's fallback (here if served, else the parent);
hydration stays before parking; no copied `retryAt`; a dependency `ended` breaks its dependent; a reload's handover
binds new requests before releasing old ones; retry passes only to `broken` and `transient` blockers, once per
operation; `installing` re-evaluated at every install end (commit or rejection); a registry's last good value dropped
when one of its contributors leaves; the probe with round ids, bounded seen sets, edge-generation triggers, attempt
ids on every non-live answer and relays dropping probes from untrusted links; one cycle mechanism, local and remote.

## 0. The problem

The same situation, "what I need is not there", has five outcomes today, depending only on how it is declared:

| Declared as | Provider missing | Today |
| --- | --- | --- |
| `self.get(LocalType)` | no facet serves it | `self.get` throws, the factory throws: `broken` |
| `self.get(RemoteType)` | the worker does not serve it | the hold is refused `broken`; the dependent `transient`, polled 1-60 s forever |
| `self.registry(R)` | no provider | `transient`, woken at R's first value only |
| `self.registry(R)`, reader newer | | `broken` |
| a reload removes the type | | holders get `gone`: ended for good |

And the startup barrier deadlocks an acyclic graph across two hosts (Sol, `/tmp/dep-graph-sol-barrier.log`): S's eager
A needs W's B, B needs S's C; W's hold for C waits for S's whole `load`, which waits for A. Only `readyTimeout` ends it.

## 1. Requests and one resolver

- **A request** is what a reference stands for: type (or registry), params, principal, the consumer's contract version.
  Its holder makes it and owns it: an attempt (`self.get`, `self.registry`, keyed pins), a call (`ctx.get`), outside
  code (`host.get`, `host.hold`, `host.registry`), a link's peer (`hold`). **It ends only when its holder ends it** (the
  attempt ends, the call settles, `release()`, a getter gives up, the peer's link or origin closes, revocation, the
  holding host closes), never because its provider is missing, went away or does not fit.
- **Placement by address** (round 1): a `local` type goes here; a `remote` type with a placement goes to the address
  its placement (computed from the consumer's own contract) gives: here if that is this host's address, whether served
  here or not, else over the route for that kind or the parent (design §3). A `remote` type **without placement** keeps
  today's rule (round 2: Fable, Opus, Astra; no feature removed): here if served here, otherwise over the parent. A
  request of that kind made before the host has a parent link waits here `not_served` and is **re-placed when the
  host's first parent link connects** (round 3: Opus N5, Sol 3: a tab loads before it connects); on a host that never
  connects (the root), it stays here. Opus would rather require a placement on every `remote()`; that removes a
  supported declaration, so the draft keeps the fallback. A hold arriving for an address that is not this host's is relayed or
  refused (`invalid/placement`) as today; a relay never captures a hold because it serves the same name.
- **Then the selected provider is checked** (served, version or accepted version and fingerprint, `authorize`, the
  provider's own placement check). Version checks never look at a same-name registration elsewhere.
- **The publication gate:** a request made on this host, or arriving on its links, before the host's first
  publication (§6) is not placed yet; it shows `loading` and is placed by the publication. The gate lasts only for the
  synchronous setups, never for activation, so it cannot deadlock.
- **Outcomes of the check:**

  | The check finds | Request |
  | --- | --- |
  | a fitting provider | bound (to the object here, or to the hold over a path) |
  | not published yet | unbound `unpublished`: `loading` |
  | nobody serves the name at its address | unbound `not_served`: `failed { waiting }` |
  | no fitting version, a fingerprint that differs at the same version, a placement the provider computes elsewhere (code skew) | unbound `version`: `failed { waiting }` |
  | the registry is served, but its first `compose` (or the reader's version mapping) threw | unbound `compose`: `failed { waiting }` |
  | the provider host is installing a revision and the hold does not fit its current code | unbound `installing` at the provider: `loading` |
  | the path has no link (a drop, a route resolving) | on the path: `loading` |
  | `authorize` refused, invalid params | `failed { broken, forbidden \| invalid }`, as today, never indexed |

  The unbound reasons that wait for a name (`unpublished`, `not_served`, `version`, `compose`) are indexed under it on
  the host that decided them: the consumer's host for a local request; the provider's host for a hold that arrived
  over a link (it already keeps such holds as refused: `remote/hold.ts`). `installing` is the provider host's own,
  re-evaluated at its install's end; `no_link` lives on the path, where the next link holds it again. Indexes drop an
  entry when its request ends; GC-tested.

## 2. States

`ref.state` keeps its four kinds; `FailureCause` gains one kind, `waiting`:

```ts
type RefState =
  | { kind: "loading" }
  | { kind: "live" }
  | { kind: "failed"; cause: FailureCause; retryAt: number | undefined }
  | { kind: "ended"; error: ChordError };

type FailureCause =
  | { kind: "transient"; error: ChordError }   // the object's own effect failed (an open, a follow): backoff
  | { kind: "broken"; error: ChordError }      // the object's own code, a cycle, or authority: retry() or a reload
  | { kind: "waiting"; error: ChordError };    // not the object's fault: no provider, no fitting version, a
                                               //   dependency failed; retryAt undefined, woken by an event
```

| The request is | `ref.state` | Calls |
| --- | --- | --- |
| bound, its object activating or parked with no failed blocker | `loading` | park, bounded |
| unbound `unpublished` or `installing`, or its path has no link | `loading` | park, bounded |
| unbound `not_served`, `version` or `compose` | `failed { waiting }` | reject at once |
| bound, its object failed | `failed` with the object's cause, as today | reject at once |
| bound, its object live | `live` | run |
| ended by its holder, revoked, or its host closed | `ended` | reject |

**Owner:** `waiting` as a new cause kind (Opus, Fable; recommended: the cause says "not your fault, an event will wake
you" and a UI can say what is missing) or no new kind: `transient` with no `retryAt` (Astra; today's wire already
carries a `transient` cause without `retryIn`, `remote-object.ts`), or `loading` with a diagnostic (Sol; parks every
call on a missing plugin for its full `readyTimeout`).

## 3. Dependents: parked until their dependencies resolve

A **dependency** is what an attempt declares and needs before it goes live: `self.get` (local or remote),
`self.registry`, keyed pins (`at(key)` on another object's keyed member). `self.follow` is the attempt's own step (its
attach runs Durable's code), not a dependency; a follower declares `retryOn` on the registry it reads the harness
through, or recovers by its own backoff.

1. **Order, as today up to the check:** the factory runs; persisted singletons hydrate (the object's documents, kept
   across attempts); the requests are made. The attempt is **parked** while any dependency is not `live` (hydrated):

   | Its dependencies | The dependent shows |
   | --- | --- |
   | any `loading`, none failed | `loading` |
   | any `failed` | `failed { waiting, "waiting for X: <X's cause>" }`, `retryAt` undefined; the message keeps the nearest blocker and the root cause within the 500-character rule |
   | one failed with `invalid/cycle` (a dependent off the ring) | `broken` with the same error: it would wait on a ring that never heals by itself |
   | one `ended` (revoked, or its host closed) | `broken` with that error: the request cannot come back; `retry()` or a reload makes new requests (a guard: a dependency ends only with its holder's principal or host, so the dependent ends too; Fable) |

2. **The dependency check is the activation boundary:** once every dependency is `live`, the attempt runs its own
   steps (natives in order, follow attaches, member checks, derives), bounded by its own `readyTimeout` deadline, and
   goes live. A dependency that leaves `live` after the check is treated as after live (R18): the attempt goes on. This
   is a deliberate rule (Astra: a weakening of "live means every dependency is live"): an object can finish opening
   after a dependency went away, and its calls through that reference meet its state. So a parked attempt holds no
   natives, and an attempt that opened natives is never parked.
3. **No timer while parked:** no dependency deadline, no backoff. The attempt's deadline is paused while parked (as
   eager migrations pause it) and resumes with the budget left.
4. **Wakes, one rule:** the dependent re-evaluates on every state change of any of its dependencies (live, loading,
   failed, a new cause compared by value, ended; Opus: otherwise a ring of waiting attempts passes its causes round and
   round), updating what it shows; it leaves parking when all are live. The factory never re-runs
   while parked. Wakes are coalesced per object and run after the batch that caused them; a change during the
   attempt's own steps or its teardown is remembered.
5. **Kept while parked:** its documents (the object's), its declarations and requests, its seal token; no natives.
   Ended with the object (its last holder; a host-lifetime object when its plugin is removed or the host closes).
6. **`broken` only for the object's own code** (a throwing factory, a derive throwing at activation, hydration,
   `migrate`, a document fingerprint mismatch, an `open` throwing `broken(...)`), **cycles** (§7) and **authority**
   (`forbidden`, an ended dependency).
7. **Retry passes on:** `ref.retry()` on a `failed { waiting }` object retries its `broken` and `transient` blockers,
   hop by hop (the existing `retry` message over links), once per retry operation (an id dedupes diamonds); `waiting`
   blockers pass it on; nothing else is touched. Retry of a `broken` or `transient` object starts a new attempt, as
   today.
8. **`retryOn`** wakes failed objects as decided in slice 8 (a value call retries a `transient` or `broken` object);
   while the object is parked `waiting`, a value call does nothing: its dependencies decide.
9. **Own-code reload of a parked object:** its plugin's reload replaces the parked attempt with the new factory's,
   as one handover: the new requests are made and bound first, then the old ones released (round 2, Astra N4: an
   unchanged dependency held only by this object must not end in between; today's `#activate` binds before
   `#releasePrevious`).
10. **After live, R18 unchanged:** a dependency leaving `live` leaves its dependent live.

## 4. Wakes: two events

| Event | Re-evaluates |
| --- | --- |
| **a target changes state**: a dependency's object goes live, loading, fails, gets a new cause or ends; a hold's `bound`, `loading`, `failed` arrive, also after a re-hold on a new link | the requests bound to it, and their dependents (§3.4) |
| **a name becomes usable, an install ends, or the first parent link connects, on a host**: a publication (`load`'s setups, a reload's commit, an install's commit) serves a type, a registry, a version; a registry composes or maps a value at a version; an install ends without a commit (rejected) | the unbound requests indexed under those names; the provider's `installing` holds; at the first parent link, the
no-placement remote requests waiting here; a refused hold re-runs its start and sends `loading`, then `bound` or `failed` |

No new message kind for wakes: `loading`, `bound`, `failed` and `retry` exist. The wire's `failed` carries the new cause
kind `waiting`; `loading` and a `waiting` `failed` carry the provider's attempt id for the probe (§7).

## 5. Removal, versions, rollout

- **A reload that removes a type:** its objects end as today (natives close, reason `end`; callers rejected at once;
  handlers drain). Their requests are not ended: each becomes unbound `not_served` and binds again if a later commit
  serves the name.
  - **Locally:** a `Binding` whose target ended by removal becomes unbound and accepts a second `bind`: member sources
    re-bind by name (one frame from the last value, as on a restart), keyed pins re-pin, parked calls flush or
    reject, presence re-lists. The one new piece of machinery.
  - **Over a link:** a `failed` on a bound hold unbinds it (Fable: one message, one rule; the consumer applies it as
    `#startOver` plus `failed`); the provider detaches the hold's sources and drops its unsent pending ops and queued
    `bound`; the ack slots of `bound`/`state` messages already sent stay counted until their `ack` or the link's loss;
    calls in flight on it are rejected and free their slots once.
- **A reload that stops accepting a version** unbinds only the requests on that version (`version`); the object stays
  (its own plugin's reload still restarts it if it has natives, §21).
- **A type moved to another host kind:** the request carries the address its own consumer code computed; the old host
  answers `not_served`; the consumer's own reload makes a new request. No redirect.
- **A consumer whose code moves to a new version** releases its old request and makes a new one (today).
- **Rollout, without revision fields:** each host knows only its own install. A provider host that installs keeps
  holds that do not fit its current code `installing` (`loading`) and re-evaluates them when the install ends, by its
  commit or by its rejection. A provider host that is queued but not installing yet answers a mismatch `failed
  { waiting, version }` until its install commits and wakes it: a visible blip of at most one install, accepted (Opus).
  An install never waits for activations (a reverse-order rollout would deadlock); a host whose own install was
  rejected fails its own requests at once with the reason (design §21). The loader keeps its own duties (the desired
  code set, digests, serialized installs).
- **Old calls across a reload** follow §21 unchanged: a pure swap lets them finish on old handles; a native restart
  drains them first; a removal rejects their callers at once and drains the handlers. Calls are never resent.

## 6. Startup: publication, then first outcomes

1. **Publication:** `load` runs every facet's setup, then publishes all at once in one batch (types served,
   registries served and composed once, contributions in their tables), then wakes (§4) after that batch. Nothing
   activates inside it.
2. **No gate beyond it:** holds and `host.hold` wait only for the publication, never for the barrier. This ends the
   startup deadlock: W's hold for C binds as soon as S's setups published; B goes live, then A.
3. **The barrier** (**Owner:** (a) or (b); recommended (a), three reviewers of four):
   - **(a):** `load` resolves when every host-lifetime object of this `load` has a first outcome:
     `firstOutcome(o) = o.live || o.ownFailure || (o.parked && o.blockers.every((b) => !b.local || firstOutcome(b)))`,
     where `local` means executing on this host (an object here, a keyed pin still loading here), not the contract's
     kind. So `CodeMode → Harness` waits for the harness's outcome; a wait on another host or on a failed dependency
     ends the first pass. One `firstOutcome` signal per object, separate from the readiness dependents wait for (Sol),
     counted once, never reopened by retries. An object of the cohort that ends before its first outcome (its plugin
     removed, the host closing) settles its entry as ended; `host.close` settles the waiting `load` (Astra R3).
   - **What (a) promises:** every host-lifetime object on this host had its first try, and the contributions of those
     that went live are in their tables. **Not:** every tool that will arrive (a parked or slow contributor, tools found
     in `onLive`, MCP; Sol's probe `/tmp/barrier-sol-first-outcome.log`). What a first turn needs is p3's explicit
     admission check.
   - **(b):** `load` resolves after the publication; Chord adds `host.startup`, a watchable of the host-lifetime
     objects' first outcomes with their causes; the app decides (Fable). The same tracker, awaited by the app.
   - p2 today resumes its harness without waiting for all host objects (`apps/p2/src/hosts/worker.ts`), because its
     worker objects that need server types are reachable only after `control.ready()`.

## 7. Cycles

On one host, cycles are found exactly as today: at `self.get`, following the waiting edges of activating and parked
attempts. Across hosts, a hold carries the activation chain it was made in (today), which finds every cycle whose
objects start one after another. What remains is the documented gap (design §6): objects on two hosts that start at
the same moment and need each other. The owner decided on 2026-10-24 (slice 4b review decisions (2)) that this is a
documented limitation that times out and retries, with no probe message. Without dependency deadlines that timeout no
longer exists, so the gap needs one of two answers (**Owner**):

- **(A) The 4b decision, narrowed.** One deadline stays: an attempt parked on a dependency held over a link whose target
  attempt is known and still activating or parked fails `transient` after its `readyTimeout` and retries with backoff;
  its next attempt usually starts after the other side and its chain finds the cycle. It has a cost that decides
  against it: the target being *parked* is the common case of a chain across hosts waiting for a missing plugin (a
  tab's view on a worker object that waits for an uninstalled type), and those dependents would time out and poll
  again, as today, so "local = remote" would not hold across hosts. Narrowing it to targets that are `loading` (not
  `failed { waiting }`) avoids that but misses a real ring: A and B on two hosts wait on each other, B also on a
  missing X; B is `failed { waiting }`, so A is too; when X appears, both stay `failed { waiting }` on each other, with
  no deadline and no chain to find it. And even the timeout does not find what it is meant to (round 6, Fable): an
  object's chain is fixed when it is created and its instance id survives retries, so a retried attempt sends the same
  hold with the same chain; two simultaneous starts time out and retry in lockstep and are never found.
- **(B) The probe (recommended)**, below: no deadline at all, one new message kind, the most intricate rule set in the
  model. Five
  review rounds found a counterexample in each of the first four drafts; draft 6's version answers all of them, but it
  has not been reviewed again, and slice 7 would have to prove it with tests before the deadline could go.

### (B) The probe

Replaces the activation chain in holds. On one host the `self.get` walk stays (it is synchronous and exact: a ring
with no remote edge is found there, where (B1)'s timer does not run; Opus, round 7); the probe serves the rings that
cross a link. It replaces draft 1's bounded chain too
draft 1's bounded chain (a ring of 33 is never found with chains cut at 32; chains keep stale ancestry). Draft 5 replaces the
second round by a check along the recorded path (round 4, Sol: two rounds through different stale paths can report a
ring that never existed, `/tmp/model/sol-probe4.log`).

1. **Attempts, edges, tokens.** Every attempt has its own id (uuidv7 per attempt: a retry or reload is a new
   attempt). A **wait edge** runs from a parked attempt to the parked or activating attempt it waits for, through a
   bound request (unbound waits and registry reads are never edges; they are not deadlocks). Each edge carries an **edge
   token** (round 5, Astra, Sol): a number from a counter per attempt, never reused, replaced by a fresh one on any
   interruption or change of that edge, so two requests to one object are two edges: a new target attempt (also a
   local target's retry, without a re-bind), any `loading` on a bound or pending hold (a relay's upstream re-hold
   included), an unbinding, a rebinding, a re-hold after a reconnect. An attempt is parked for one interval only (one
   that passed its dependency check never parks again) and ids are never reused. A provider tells its consumers the attempt they wait for on
   every non-live answer: `loading { hold, attempt }` and a `waiting` `failed { hold, cause, attempt }`.
2. **A search per edge change.** Whenever a parked attempt gets a new edge or a new token on one, it starts a
   search: `probe { kind: "search", round, initiator, trail }` along each of its wait edges, `round` the next number of
   a counter the attempt keeps, `trail` the list of `(attempt, edge token)` hops it crossed, starting with
   the initiator's own. A ring closes at its last
   edge, and that edge's source starts the search that finds it. Coalesced per batch. Locally a call on the target
   attempt, forwarded through a queue (no recursion); over a link the message `probe { hold, to, ... }`, consumer to
   provider, relayed by hold id with the origin. **Probes are honoured on parent and route links and dropped on child
   links** (`accept`), whatever `trusted` says.
3. **Forwarding.** An attempt receiving a search drops it if `to` is not its current attempt or it is not parked. If
   the initiator is itself, the search returned (4). If the attempt is already in the trail, it drops it (a ring that does not contain the initiator is
   found by its own members' searches; Opus). Otherwise it forwards it along every wait edge, appending `(itself, the edge's
   token)` to the trail, only if the round number is higher than the one it stored for that
   initiator (older or equal rounds are dropped: the initiator superseded them), and stores it. The seen map holds one
   number per initiator, up to 256 initiators, and goes with the attempt.
4. **The check.** A returned search is accepted while its initiating attempt is still parked, whatever round it
   carries (round 7, Astra: a re-search must not invalidate an older search still under way); the check decides. The
   initiator then sends `probe { kind: "check", round, trail }` along the recorded trail: the initiator first verifies its own hop; each hop passes it on only if it is still
   that attempt, still parked, still has the recorded edge token, pointing at the next hop's attempt; otherwise the
   check dies (also on a `to` mismatch). The check follows the trail by position and bypasses the seen
   map. The initiator verifies its own hop again when the check returns. If the check returns, the initiator fails `broken invalid/cycle`, the path named for display from the trail,
   and today's propagation breaks the other activating objects on the ring and the dependents off it. 5. **No silent loss.** Dedupe can drop the copy of a search that travelled the ring in favour of a copy whose path
   later breaks (Astra, round 5); then the check dies and nothing is left to find the ring. Round 6 tried `dead`
   notices back to the initiator; Sol and Astra showed that reliable notices need recovery state per search that
   eviction may not drop and that a long-parked attempt would otherwise keep for every initiator that ever passed (a
   leak), i.e. a full search lifecycle with cancellation. Two ways (**Owner**, part of decision 6):
   - **(B1) Re-search with backoff (recommended).** An attempt parked on a remote attempt starts a fresh search again
     after a backoff (1 s doubling to 60 s, reset by an edge change), whether it shows `loading` or `failed { waiting }`;
     the timer stops when the attempt leaves parking. No `dead` messages, no recovery state, eviction
     only costs work; a new search starts within one backoff period, so every stable ring that crosses a link is
     eventually found (no wall-clock bound: delivery is only fair; a ring on one host is the walk's). The timer runs as long as the attempt stays parked on a remote attempt: a view on a worker object that
     waits for a missing plugin re-searches every 60 s until a reload (Fable: cheap, but for as long as it waits). The timer sends probes only: it never
     fails an object, re-holds or polls a provider. Cost: one probe per parked remote dependent per period, which
     crosses the downstream wait graph and dies at its leaves (an unbound wait is not an edge).
   - **(B2) Events only.** Each search is owned until it settles: branches report completion or abort back along their
     trails, a dropped probe answers `dead { initiator, round }` with a reverse route, an edge records the searches it
     carries until they settle, and an initiator that ends or starts a new round cancels its old one along the same
     routes. Complete without a timer, bounded by the searches in flight, and the most intricate protocol in Chord; not
     yet specified to the reviewers' satisfaction.
   Rejected: enumerating every simple trail without dedupe (Sol's correctness reference): no ring copy is ever
   suppressed, but work is exponential on chains of diamonds.
- **Why a reported ring existed:** every edge of the trail kept its token from the moment the search crossed it
  to the moment the check crossed it; the search crossed all of them before the check started, so at the moment the
  check started every edge of the ring existed at once. A token changes on every interruption and is never reused, so an edge cannot
  vanish and come back unnoticed. Sol's counterexample fails at the check: `C1` is no longer `B`'s target.
- **Why every ring is found** (under an eventually stable wait graph and fair delivery; endless edge churn can keep
  invalidating searches; with rule 5's (B1) or (B2) for a search suppressed behind a path that broke): a ring is closed by its last edge; its source starts a search when the edge appears; every
  other edge exists then and every attempt on the ring waits transitively on the source, so none goes live before the
  search and the check return. Rings of any length, local and remote mixed. On a DAG searches die at the leaves; on a
  diamond the second arrival is dropped.
- **What it does not promise:** (1) a ring that existed when the check started may be broken up by a concurrent reload,
  retry, unbinding or revocation just after; it is still reported (it did exist). Its broken objects recover as every
  broken object does: `ref.retry()` or a reload of their plugin. (2) Linear work under every schedule: with more than
  256 initiators passing one attempt at once, an evicted entry lets a search be forwarded again, so work can grow with
  the number of simple paths (never endlessly: a search never revisits an attempt in its trail). (3) Constant message size: a probe carries its trail, so its size grows with the length of the
  path it crossed (a returning search's trail is as long as its ring); no cap cuts it, since the trail is the proof.
- **Cost:** one search per edge change, crossing each downstream edge once, one check per returned search; with (B1),
  one more search per backoff period for every attempt parked on a remote attempt, also while an acyclic chain waits
  for a missing plugin, plus the trail bytes. The bounded memory is the seen map's; probes in flight are bounded by
  the searches started.
- **Transition:** today's dependency deadline for activations waiting across links stays until the probe's tests pass
  in slice 7 (long rings, diamonds, a ring closed after a reconnect with unchanged attempt ids, Sol's phantom schedule,
  300 concurrent initiators, edges added and removed, reloads, relays, forged probes); then it goes in the same slice.

## 8. Getters, holds, calls: one rule

- **`host.hold`** returns a reference at once; only invalid params throw (also before `load`). A missing local type
  gives `failed { waiting }` after the publication, `loading` before it.
- **`host.get`, `ctx.get` and `host.registry`:** resolve when live; wait while `loading`, or `failed { transient }`
  (its own retry is under way), up to their `readyTimeout`; reject at once on `failed { waiting }` or `{ broken }`. On
  success, rejection or timeout their temporary wait goes; `host.registry` returns the `RegistryValue` with its
  ordinary watch ownership (no `release()`). **Owner:** recommended (nobody waits 60 s for a plugin that is not
  there; code that wants to wait holds instead), or wait through `waiting` too.
- **Calls** on a `loading` reference park, each bounded by the reference's `readyTimeout` from when it was made; on a
  `failed` one they reject at once with the cause; sent calls are never resent.

## 9. Registries

- The same resolver on one host: a reader's request for R at its version is bound while R is served and has a usable
  value at that version (composed; mapped by `accepts[old].value` for an older reader), otherwise unbound
  `not_served`, `version` or `compose`, or `loading` before the publication. Woken at every transition to usable
  (`#valued`'s first-value latch goes). S2's `broken` and S3's backoff go.
- **Version skew within one host:** a reload of the registry's plugin alone leaves other plugins' contributors and
  readers on their bundled versions; `accepts[old].contribution` and `.value` keep them working, unsupported
  contributions are left out and reported, unsupported readers are `waiting` (`version`).
- A registry waits for a value, never for a particular contribution (an empty table composes). After live, a later
  `compose` failure changes nothing for the reader: `.value` keeps the last good composition, **but only while every
  contribution it was built from is still in the table** (round 2, Astra N2): when one of them leaves (its
  contributor ended or was reloaded), the last good value is dropped and `.value` throws until `compose` succeeds, so
  it never hands out a native whose contributor ended. `compose` represents a missing contributor as a value.
- Registries stay host-local (contributions are in-process values).

## 10. Keep-alive, presence, revocation, jobs

- A request over a link counts once in `host.activity.references` from its arrival to its end, bound or unbound;
  presence (`host.references`) lists only bound references.
- Revocation ends the requests of a revoked principal, bound and unbound, at every hop; nothing revives them.
- `gone` stays only for revocation (a provider host closing closes its links and sends nothing; its consumers see a
  drop, `loading`, and hold again on the next link).
- Persisted job runs of a parked host-lifetime object are loaded with its documents; `run` and `finish` start only
  once it is live; the run count keeps the object as today.

## 11. Timeouts after the model

| Timeout or backoff | After | Why |
| --- | --- | --- |
| `readyTimeout` of an attempt | only its own steps; paused while parked | a slow dependency is bounded where it runs |
| `readyTimeout` of `host.get`, `ctx.get`, `host.registry` | kept | a caller gets an answer |
| `readyTimeout` of a parked call | kept | an action must not run long after it was asked for |
| identity backoff 1-60 s | only for the object's own `transient` failures | nothing else says the disk or network is back |
| dependency backoff, polling of refused holds | removed | recovery is an event |
| dependency deadline across links | (A): only for a parked attempt whose remote target attempt stays activating or parked; (B): until the probe's tests pass, then removed | the simultaneous-cycle gap |
| probe re-search backoff (B1) | new, only with (B1): 1 s doubling to 60 s while parked on a remote attempt | finds a ring whose search was suppressed; sends probes only, never fails or re-holds |
| route backoff, heartbeat, `closeTimeout`, routine and `finish` backoffs, `linger` | kept | not dependency waits |
| rollout install timeout (not built) | a watchdog on the install only | never a deadline for dependencies |

## 12. What changes in the design

R18 (dependency failures `waiting`, no backoff, the deadline paused while parked, the dependency check as boundary,
wakes on every change, an ended dependency breaks), S2 and S3 (`waiting`, woken at every usable value), slice 8's
last-good rule (dropped when a contribution leaves), §3's placement table (by address; the publication gate), §6 (the
simultaneous-cycle gap: (A) one narrowed deadline or (B) the probe), §7 (`host.hold`, getters, calls), §21 (no `gone` on
removal; a dropped version unbinds only its requests; installs never await activations; rollout without revision
fields; the reload handover), the start barrier (R17, W6), `FailureCause` (+ `waiting`), `loading`/`failed` with the
attempt id, one message kind (`probe`, tagged `search` or `check`). Unchanged: what an object's own code reload does (§21), R18 after live,
`retryOn` outside parking, `self.follow`'s R4, the call window and flow control, revocation, no client providers.

## 13. Open for the owner

1. The barrier: (a) or (b) (§6.3).
2. Getters on `waiting`: reject at once (recommended) or wait up to `readyTimeout` (§8).
3. `waiting` as a new cause kind (recommended) or not (§2).
4. A pure swap whose new factory declares a dependency that is not there: the object parks (its gate closes, holders
   see `loading` or `failed { waiting }`, calls park or reject; recommended) or stays on the old code until it
   resolves (old and new code would overlap without bound, against §21's "a host is at R or R−1").
5. **The last good value** (§9): kept only while every contribution it was built from is still in the table (draft;
   Astra), or kept as slice 8 decided, with natives in a registry looked up at use through their owner (Sol).
6. **Cycles across hosts** (§7): (B) the probe, with (B1) a re-search backoff for probes only (recommended) or (B2) a
   full search lifecycle without any timer; or (A) the slice 4b decision narrowed to one deadline, which polls chains
   across hosts again, misses a ring of `waiting` attempts, and retries in lockstep without finding the cycle it is for.
