Use this as a running log of all findings.

# Learnings
- 2026-02-06: Repo state: on branch `debug-connectivity` at `07ba57225` (`git log -1 --oneline`). `shared-log-debug.md` + `shared-log-debug-plan.md` are untracked local notes.
- 2026-02-06: `node_modules/` was missing initially (need `pnpm install` before running tests).
- 2026-02-06: `pnpm install` completed with warnings about failing to create `peerbit` bin symlink under `packages/clients/peerbit-server/frontend/node_modules/.bin/peerbit` due to missing `dist/src/bin.js` in `@peerbit/server`. (May be irrelevant for node tests, but flag in case build is required.)
- 2026-02-06: Local `DirectSub` pubsub code does **not** match the behavior described in PR #589 yet:
  - `packages/transport/pubsub/src/index.ts:126` `subscribe(topic)` only enqueues into the debounced accumulator; it does **not** call `initializeTopic(topic)` eagerly.
  - `packages/transport/pubsub/src/index.ts:729` Subscribe handler responds to `requestSubscribers` using only `getSubscriptionOverlap()` (based on `this.subscriptions`), with no inclusion of “pending debounced subscribes”.
  - `packages/transport/pubsub/src/index.ts:799` GetSubscribers handler likewise uses only `getSubscriptionOverlap()`.
  - `packages/transport/pubsub/src/index.ts:178` `unsubscribe()` cancels pending debounced subscribe via `debounceSubscribeAggregator.has(topic)`, but that is separate from requestSubscribers response behavior.
- 2026-02-06: Running shared-log tests requires a working aegir config and a built `dist/test/**` output. With `--no-build`, aegir/mocha only looks for `test/**/*.spec.*js` and `dist/test/**/*.spec.*js`, so TypeScript tests (`test/**/*.ts`) are ignored unless we build/emit JS first.
- 2026-02-06: `pnpm run build` succeeded after fixing `.aegir.js` worktree handling in multiple packages (`.aegir.js`, `packages/utils/any-store/any-store/.aegir.js`, `packages/clients/peerbit/.aegir.js`, `packages/utils/indexer/sqlite3/.aegir.js`). This produced `dist/test/**` outputs so `--no-build` test runs work locally.
- 2026-02-06: Test run: `shared-log` `events` `replicate:join not emitted on update` PASSED locally (`node ./node_modules/aegir/src/index.js run test --roots ./packages/programs/data/shared-log -- -t node --no-build --grep "replicate:join not emitted on update"`). This suggests the CI failure is flaky/timing-sensitive rather than deterministic in current local timing.
- 2026-02-06: Test run: `shared-log` `migration-8-9` suite PASSED locally (`--grep "migration-8-9"`). The CI timeouts likely require a narrower reproduction (timing/ordering) or are only triggered under different pubsub timing (e.g., PR #589 changes).
- 2026-02-06: Implemented pubsub debounce-race regression tests and ran them: PASSED (`node ./node_modules/aegir/src/index.js run test --roots ./packages/transport/pubsub -- -t node --no-build --grep "BUG: subscribe debounce race"`). This directly validates (1) eager `initializeTopic()` in `subscribe()`, (2) pending subscribes being advertised via `GetSubscribers`/requestSubscribers, and (3) subscribe->unsubscribe within debounce does not leak/retain a ghost topic.
- 2026-02-06: After applying the pubsub fix, shared-log flake is now locally reproducible: `events > replicate:join not emitted on update` **FAILED** with a duplicate `replicator:join` entry for the same peer hash (`node ./node_modules/aegir/src/index.js run test --roots ./packages/programs/data/shared-log -- -t node --no-build --grep "replicate:join not emitted on update"`). This strongly supports the hypothesis that pubsub timing changes expose a latent shared-log race (TOCTOU around “new replicator” detection).
- 2026-02-06: After applying the pubsub fix, shared-log migration flake is now locally reproducible: `migration-8-9 > 8-9, replicates database of 1 entry` **FAILED** with `expected +0 to equal 1` (timeout waiting for replication) (`node ./node_modules/aegir/src/index.js run test --roots ./packages/programs/data/shared-log -- -t node --no-build --grep "migration-8-9"`). This matches the CI symptom where replication never converges within `waitForResolved`'s default timeout.
- 2026-02-06: Shared-log fix iteration:
  - Added per-peer serialization for replication-info apply + buffering of replication-info on NotStartedError, drained in `afterOpen()`.
  - Result: `events > replicate:join not emitted on update` now PASSED (`--grep "replicate:join not emitted on update"`).
- 2026-02-06: Migration root cause (local repro) was *not* fixed by shared-log serialization alone. The missing piece was pubsub message processing during the debounce window: RPC messages sent to a peer during pending subscribe were not treated as “for me”. After changing `DirectSub` to treat pending subscribes as subscribed for PubSubData delivery, `migration-8-9` now PASSED (both `8-9` and `9-8`) and remains quick/stable in local runs.

# Claims
## Claim1 (Unique Triple-Failure Signature Only Once)
- Verdict: **False** (appears in at least 2 PR #589 CI runs).
- Evidence:
  - PR `dao-xyz/peerbit#589` run `21732319700` (job `62689580781`, `test:ci:part-4`) shows the triple failure (events + 2x migration).
  - PR `dao-xyz/peerbit#589` run `21738359696` (job `62708216873`, `test:ci:part-4`) shows the same triple failure.

## Claim2 (PR #589 Complete + All Tests Pass + “Definitive” Root Cause)
- Verdict: **Partially true**.
- Evidence:
  - True: PR #589 has 4 commits on `fix/pubsub-initialize-topic-on-subscribe` (GitHub PR metadata).
  - False: “All tests pass” (CI `test:ci:part-4` fails on shared-log in at least the runs above).
  - Supported: pubsub tests pass in that PR run (`@peerbit/pubsub: 43 passing` in part-3 job output).
  - Local repo cross-check: this repo does **not** contain PR #589 code changes yet (see Learnings).
  - Local repo cross-check: shared-log has a plausible TOCTOU/serialization issue (replication-info fire-and-forget IIFE around `packages/programs/data/shared-log/src/index.ts:2971` + racy `isNewReplicator` check around `packages/programs/data/shared-log/src/index.ts:1200`).
  - Note: PR #589 does **not** “remove the debounce delay”; it keeps debounced subscribe but changes initialization/advertising semantics.

## Claim3 (waitForReplicator maturity timing + duplicate join “as expected”)
- Verdict: **Partially true**.
- Evidence:
  - True: the test asserts ~3s wait (`packages/programs/data/shared-log/test/replicate.spec.ts` expects `>= 3000ms - 100ms`).
  - False for the cited CI runs: in the failing PR #589 runs, `waitForReplicator waits until maturity` is shown as passing at ~3054-3056ms.
  - Supported: CI failure output for the `events` assertion is consistent with a duplicate `replicator:join` emission (same peer hash twice).

## Claim4 (“PR #3 persistCoordinate guard doesn’t fix TOCTOU race”)
- Verdict: **Partially true** (the “doesn’t fix TOCTOU race” conclusion is supported; the exact PR reference is likely misidentified).
- Evidence:
  - The closest matching change appears to be `dao-xyz/peerbit#591` (`fix(shared-log): avoid unhandled rejection...`) which adjusts `persistCoordinate` and related shutdown handling, but does not touch replication-info IIFE / `addReplicationRange` join emission logic.
  - Local repo cross-check: the replication-info IIFE begins at `packages/programs/data/shared-log/src/index.ts:2971`.

# Ahas/Gotchas
- Aegir config bug: `.aegir.js` assumed `.git` is a directory; in this worktree `.git` is a file, causing `Error finding your config file` on any `aegir` command. Fixed by resolving root from the config file directory and falling back to `.git` file (`.aegir.js`).
- Aegir test gotcha: `--no-build` skips compilation, but tests live in TypeScript. Until `dist/test/**` exists, `aegir test --no-build` reports `Error: No test files found`.

# Tests
## Proposed Quick Regression Tests (Additions)

### PubSub / DirectSub
- Add: `packages/transport/pubsub/test/bug-pending-subscribe-requestSubscribers.spec.ts` (or inline into existing `packages/transport/pubsub/test/index.spec.ts`).
- Purpose: deterministically validate the PR #589 hypothesis:
  - Eager topic initialization in `subscribe()` prevents incoming `Subscribe` drop during debounce.
  - “Pending subscribe” is advertised via Subscribe(requestSubscribers) and GetSubscribers responses.
- Sketches (from subagent proposal):
  - `requestSubscribers includes pending debounced subscribe`: block `(a as any)._subscribe` with a deferred promise; call `a.subscribe(TOPIC)` (pending); then from B call `await b.requestSubscribers(TOPIC, a.publicKey)`; assert B records A as a subscriber while A’s subscribe promise is still unresolved.
  - `incoming Subscribe not dropped during local debounce window`: with A pending subscribe (topic initialized), let B do `await b.subscribe(TOPIC)`; assert A records B under `a.topics.get(TOPIC)` even though A’s `_subscribe` has not run.
  - `subscribe then unsubscribe within debounce does not advertise/leak`: with A pending subscribe then `await a.unsubscribe(TOPIC)`, from B do `requestSubscribers(TOPIC, a.publicKey)`; assert B does not record A as subscriber.

- 2026-02-06 Update:
  - Added deterministic regression coverage in `packages/transport/pubsub/test/bug1-subscribe-debounce-race.spec.ts` (blocks `_subscribe()` to force the debounce window and asserts pending-subscribe behavior).
  - Incorporated PR #589’s pubsub test into this worktree as `packages/transport/pubsub/test/bug1-initializeTopic-race.spec.ts` (`--grep "BUG: initializeTopic race"`).

### Shared-Log
- Add: `packages/programs/data/shared-log/test/replication-info-race.spec.ts`.
- Purpose: deterministically validate the shared-log TOCTOU hypothesis:
  - Two concurrent “replication-info apply” executions for the same peer must not emit duplicate `replicator:join`.
- Preferred shape:
  - Call internal `addReplicationRange(...)` twice concurrently for the same `from` key (TS `private` is runtime-accessible), and deliberately widen the critical section by gating `replicationIndex.del` so both calls compute “new replicator” off the same empty state.
- Add (optional): `packages/programs/data/shared-log/test/replication-info-not-started-buffer.spec.ts`.
- Purpose: validate the “don’t drop replication-info on NotStartedError” hypothesis by forcing a `NotStarted`/`IndexNotStarted` error once and asserting it is retried/applied later.

## Optional Existing Test Tightening
- `packages/programs/data/shared-log/test/events.spec.ts`: replace fixed `delay(2e3)` waits with `waitForResolved()` on concrete state (join/leave arrays length, replicationIndex contents). This reduces flakiness but shouldn’t be the primary fix.

# Reviews
```md
## Review1/Review2 Cross-Check (Against Local Repo)

### Validated (Local Code)
- The debounce window exists: `DirectSub.subscribe()` enqueues via `debounceSubscribeAggregator` and does not immediately set `topics`/`subscriptions` (`packages/transport/pubsub/src/index.ts:96`, `packages/transport/pubsub/src/index.ts:126`).
- `_subscribe()` is where `subscriptions` is set and `listenForSubscribers()` is called (`packages/transport/pubsub/src/index.ts:134`), which initializes topic tracking via `initializeTopic()` (`packages/transport/pubsub/src/index.ts:265`).
- Incoming `Subscribe` drops remote subscription info for uninitialized topics (`packages/transport/pubsub/src/index.ts:685-689`).
- Replies for `requestSubscribers` / `GetSubscribers` are computed from `this.subscriptions` only (`getSubscriptionOverlap()`), so pending debounced subscribes aren’t advertised (`packages/transport/pubsub/src/index.ts:451`, `packages/transport/pubsub/src/index.ts:727`, `packages/transport/pubsub/src/index.ts:798`).
- There is a known flaky concurrent subscribe/connect test already (currently commented out) (`packages/transport/pubsub/test/index.spec.ts:1370`).

### Not True Locally
- PR #589 changes are not present in this repo: no eager `initializeTopic()` in `subscribe()` and no inclusion of pending topics in requestSubscribers responses.
- The PR #589 regression test files referenced in Review1/2 don’t exist locally.

### Action Items
- Implement PR #589-style fix in this repo:
  - eager `initializeTopic(topic)` in `subscribe()`.
  - include pending topics (debounce aggregator) in overlap when responding to `Subscribe{requestSubscribers:true}` and `GetSubscribers`.
- Add tests for the above plus `subscribe()` then immediate `unsubscribe()` (ensure no “ghost topic” advertising).
- Re-enable/replace the disabled concurrent subscribe/connect test once the fix lands.
```

## 2026-02-06 Update: Reviews vs Current Repo State

### PubSub (debounce + pending subscribe)

- Confirmed: the review’s debounce-window hypothesis was correct (topic not initialized yet => inbound `Subscribe` can be dropped; subscribe handshakes can miss “pending” intent).
- Implemented in `packages/transport/pubsub/src/index.ts`: `subscribe()` now eagerly initializes topic tracking and keeps `pendingSubscriptions` until `_subscribe()` commits.
- Tests added in `packages/transport/pubsub/test/bug1-subscribe-debounce-race.spec.ts` now directly assert two review concerns: pending subscribes are discoverable via `Subscribe{requestSubscribers:true}` responses (even with `_subscribe()` blocked) and subscribe→unsubscribe within the debounce window does not advertise or retain a ghost topic.
- Extra nuance found while debugging shared-log: pending subscribes also must count as “local interest” for `PubSubData` delivery filtering; otherwise RPC traffic can be ignored during the debounce window (this was the missing piece for `migration-8-9` stability).

Outdated/incorrect in the `Review1/Review2 Cross-Check` block above (now historical):

- “PR #589 changes are not present in this repo” is no longer true in this worktree.
- “The PR #589 regression test files referenced in Review1/2 don’t exist locally” is now outdated in intent: equivalent coverage exists in `packages/transport/pubsub/test/bug1-subscribe-debounce-race.spec.ts`.
- “requestSubscribers / GetSubscribers replies are computed from `subscriptions` only” is now partially outdated: responses to `Subscribe{requestSubscribers:true}` include pending topics; responses to `GetSubscribers` still only reflect `subscriptions` (so the `requestSubscribers()` API still won’t surface a remote pending subscribe).

### Shared-log (replication-info handling)

- Confirmed: with pubsub timing improved, shared-log’s latent replication-info TOCTOU became reproducible locally (matching CI: duplicate `replicator:join` + migration replication timeouts).
- Implemented in `packages/programs/data/shared-log/src/index.ts`: replication-info apply is serialized per peer; `NotStartedError` replication-info is buffered and drained in `afterOpen()`; subscription-change handling is idempotent with delayed/cancellable `RequestReplicationInfoMessage`.
- Local cross-check (2026-02-06): `replicate:join not emitted on update`, `migration-8-9`, `will set replicaiton info on load`, and `applies replication segments even if waitFor() fails` all pass with `--no-build` greps.

# 2026-02-06 Shared-Log Regression Failures (Post Replication-Info Queue/Buffer)
- Repro: `node ./node_modules/aegir/src/index.js run test --roots ./packages/programs/data/shared-log -- -t node --no-build --grep "will set replicaiton info on load"` fails with `expected 1 to equal 2` (`packages/programs/data/shared-log/test/load.spec.ts:213`). The test observes `uniqueReplicators.size === 2` but `replicationIndex.count() === 1`, which implies inconsistent in-memory vs persisted replication state.
- Repro: `node ./node_modules/aegir/src/index.js run test --roots ./packages/programs/data/shared-log -- -t node --no-build --grep "applies replication segments even if waitFor\\(\\) fails"` fails for both `u32-simple` and `u64-iblt` at the "clear segments" step (`packages/programs/data/shared-log/test/replication.spec.ts:216-224`): after sending `AllReplicatingSegmentsMessage({ segments: [] })`, db2 still reports `count({hash: fromHash}) === 1` instead of `0`.
- Hypothesis: `addReplicationRange()` mutates `uniqueReplicators` before `replicationIndex.put()`/`del()` completes (`packages/programs/data/shared-log/src/index.ts`), so tests that wait on `uniqueReplicators` can observe "replicator present" while the index is still incomplete. If `addReplicationRange()` throws `NotStartedError`, the new buffering path can also leave partial in-memory changes without a retry outside `afterOpen()`.
- Planned fix: make `addReplicationRange()` update `uniqueReplicators` only after index operations succeed and delete the peer when a `reset` results in zero ranges; add a read-only "index ready" probe in `_enqueueApplyReplicationInfo()` before calling `addReplicationRange()` to avoid partial mutations on `NotStartedError`.
- Note: `node ./node_modules/aegir/src/index.js run test --roots ./packages/programs/data/shared-log -- -t node --no-build --grep "does not lose entries when ranges rotate with delayed replication updates"` passed for both `u32-simple` and `u64-iblt` (~43s each) in a local run, so that previously observed failure may be flaky/timing-dependent.

# Attack Plan

## Root-Cause Summary (Definitive)

### PubSub: `DirectSub` Pending-Subscribe Window

During the subscribe debounce window we were in a "pending" state that was not treated as subscribed:
- `topics` not initialized yet, so inbound `Subscribe` could be dropped as "unknown topic".
- Pending subscribe not included in `Subscribe{requestSubscribers:true}` overlap responses.
- `PubSubData` delivery filtering only checked committed `subscriptions`, not pending subscribes (so shared-log RPC traffic could be ignored during the window).

Net effect: timing-sensitive joins could miss the handshake or drop RPC traffic, surfacing as shared-log replication timeouts (notably `migration-8-9`) once connectivity got faster.

### Shared-log: Replication-Info Apply Was Concurrent + Lossy

Replication-info (`AllReplicatingSegmentsMessage` / `AddedReplicationSegmentMessage`) was applied via a fire-and-forget async IIFE, so multiple messages from the same peer could overlap and race through `addReplicationRange()` (TOCTOU on "isNewReplicator"). Startup-time `NotStartedError` could also effectively drop replication-info without a retry.

Net effect: duplicate `replicator:join` for the same peer (CI `events.spec.ts` failure) and missing replication ranges leading to `waitForResolved` timeouts (CI `migration.spec.ts` failures).

### Shared-log: Subscription Request Scheduling Amplified Races

`handleSubscriptionChange()` could run multiple times for the same peer during startup and would request replication info immediately, creating redundant request/response pairs right as peers join.

Net effect: amplified the concurrency window above by producing more replication-info traffic closer together.

## Fix Inventory (What We Changed)

- PubSub `DirectSub` (`packages/transport/pubsub/src/index.ts`): track `pendingSubscriptions`, eagerly `initializeTopic()` in `subscribe()`, advertise pending topics in `Subscribe{requestSubscribers:true}` overlap responses, treat pending topics as local interest for `PubSubData` delivery filtering, and clean up eager topic state when a debounced subscribe is cancelled (subscribe then unsubscribe within the window).
- Shared-log (`packages/programs/data/shared-log/src/index.ts`): serialize replication-info apply per peer, buffer latest replication-info per peer on `NotStartedError` and drain after `afterOpen()`, make subscription-change handling idempotent, and schedule/dedupe `RequestReplicationInfoMessage` to avoid redundant request/response pairs during startup.

## Status (2026-02-06 Local)

After `pnpm run build`, the sentinel greps below pass locally with `--no-build`.

## Step-By-Step Attack Plan

1. Build once (keep `dist/test/**` in sync; all `--no-build` greps assume this):

```bash
pnpm run build
```

2. Smoke test the three fixes (fast, deterministic greps):

```bash
# PubSub: pending-subscribe handling + PubSubData delivery while pending
node ./node_modules/aegir/src/index.js run test \
  --roots ./packages/transport/pubsub -- -t node --no-build \
  --grep "BUG: subscribe debounce race"

# Shared-log: replication-info concurrency should not duplicate join
node ./node_modules/aegir/src/index.js run test \
  --roots ./packages/programs/data/shared-log -- -t node --no-build \
  --grep "replicate:join not emitted on update"

# Shared-log: handshake should converge (no 10s waitForResolved timeout)
node ./node_modules/aegir/src/index.js run test \
  --roots ./packages/programs/data/shared-log -- -t node --no-build \
  --grep "migration-8-9"
```

3. Flake-proofing loops (cheap confidence that we closed the timing window):

```bash
# Very fast loop (pubsub)
for i in {1..50}; do
  node ./node_modules/aegir/src/index.js run test \
    --roots ./packages/transport/pubsub -- -t node --no-build \
    --grep "BUG: subscribe debounce race" || exit 1
done

# Shared-log join event (previously the CI symptom)
for i in {1..50}; do
  node ./node_modules/aegir/src/index.js run test \
    --roots ./packages/programs/data/shared-log -- -t node --no-build \
    --grep "replicate:join not emitted on update" || exit 1
done

# Shared-log migration convergence (slower; fewer iterations is fine)
for i in {1..20}; do
  node ./node_modules/aegir/src/index.js run test \
    --roots ./packages/programs/data/shared-log -- -t node --no-build \
    --grep "migration-8-9" || exit 1
done
```

4. Lock in regressions with 2 shared-log tests (so we never reintroduce these).
Test 1: `replication-info is serialized per peer (no duplicate replicator:join)`. Arrange two replication-info applies for the same `from` to overlap; assert exactly one `replicator:join` and stable `replicationIndex` state.
Test 2: `replication-info is buffered on NotStarted and drained afterOpen()`. Force `replicationIndex` to throw `NotStartedError` once, deliver replication-info, then open fully; assert the buffered message eventually applies (replication ranges appear; join/replication converges).

5. Keep a short "sentinel" grep set for future edits (run before/after any touch to pubsub/shared-log):

```bash
node ./node_modules/aegir/src/index.js run test --roots ./packages/transport/pubsub -- -t node --no-build --grep "BUG: subscribe debounce race"
node ./node_modules/aegir/src/index.js run test --roots ./packages/programs/data/shared-log -- -t node --no-build --grep "replicate:join not emitted on update"
node ./node_modules/aegir/src/index.js run test --roots ./packages/programs/data/shared-log -- -t node --no-build --grep "migration-8-9"
node ./node_modules/aegir/src/index.js run test --roots ./packages/programs/data/shared-log -- -t node --no-build --grep "will set replicaiton info on load"
node ./node_modules/aegir/src/index.js run test --roots ./packages/programs/data/shared-log -- -t node --no-build --grep "applies replication segments even if waitFor\\(\\) fails"
```

# 2026-02-06 Resolution (Local)
- Shared-log full suite: `1743 passing (17m)` (`node ./node_modules/aegir/src/index.js run test --roots ./packages/programs/data/shared-log -- -t node --no-build`).
- PubSub full suite: `44 passing (1m)` (`node ./node_modules/aegir/src/index.js run test --roots ./packages/transport/pubsub -- -t node --no-build`).
- Shared-log regressions from the earlier “Regression Failures” section are now fixed (`will set replicaiton info on load`, `applies replication segments even if waitFor() fails` now pass).
- Added an additional pubsub regression test for the “pending subscribe should still receive strict PubSubData” class:
  - `packages/transport/pubsub/test/bug1-subscribe-debounce-race.spec.ts` `--grep "pending subscribe receives strict PubSubData"`.

## Claims -> Tests Coverage
| Claim | Validated By (Existing Tests) | Gap / Missing Minimal Test |
|---|---|---|
| **Claim1:** “Triple-failure signature only happened once in CI” | None (CI-history, not runtime behavior) | Not testable as a unit/integration test in this repo; would need CI log mining tooling. |
| **Claim2 (pubsub):** debounce-window race is real; fix is eager topic init + advertise “pending subscribe” in subscriber-discovery handshake | `packages/transport/pubsub/test/bug1-subscribe-debounce-race.spec.ts` (eager init prevents dropped inbound `Subscribe`; pending advertised via `Subscribe{requestSubscribers:true}` response; subscribe→unsubscribe doesn’t leak ghost topic; pending receives strict `PubSubData`) | Still unclear/untested whether `requestSubscribers()` (GetSubscribers path) should include pending topics (currently: no). Add a minimal test to assert intended behavior. |
| **Claim2 (shared-log):** shared-log CI failures are from pre-existing TOCTOU race (concurrent replication-info apply) rather than pubsub logic | Symptom-level: `packages/programs/data/shared-log/test/events.spec.ts` `--grep "replicate:join not emitted on update"` | Missing deterministic regression: add `replication-info-race.spec.ts` that forces two concurrent replication-info applies for same peer and asserts only one `replicator:join`. |
| **Claim2 subclaim:** “pubsub fix removes the ~50ms debounce delay” | None | Not validated by tests; also contradicts current implementation (subscribe still debounced). |
| **Claim3:** “waitForReplicator waits until maturity” behavior | `packages/programs/data/shared-log/test/replicate.spec.ts` `--grep "waitForReplicator waits until maturity"` | Covered. |
| **Claim3 subclaim:** “duplicate `replicator:join` is expected from the TOCTOU race” | `packages/programs/data/shared-log/test/events.spec.ts` `--grep "replicate:join not emitted on update"` | Still missing the deterministic race test above (current is timing-sensitive). |
| **Claim4:** “persistCoordinate guard PR doesn’t fix the TOCTOU race” | None (depends on external patch/PR) | Minimal validation path: run the deterministic TOCTOU regression test with/without that guard change applied. |
| **Key pubsub/shared-log connectivity claim:** pending subscribe must count as “local interest” for `PubSubData` delivery (RPC during debounce otherwise ignored) | `packages/transport/pubsub/test/bug1-subscribe-debounce-race.spec.ts` `--grep "pending subscribe receives strict PubSubData"` | Covered. |
| **Key shared-log connectivity claim:** migration timeouts come from missed handshake and/or replication-info dropped on `NotStartedError` | Symptom-level: `packages/programs/data/shared-log/test/migration.spec.ts` `--grep "migration-8-9"` | Missing targeted tests: 1) force `NotStartedError` during replication-info apply and assert it’s buffered+applied later; 2) simulate missed subscribe event and assert startup backfill recovers (if/when implemented). |

## 2026-02-06 Note: Replication-Info Timestamp “Strictness”
- The replication-info “newer wins” guard in shared-log is **per-sender**, based on `context.message.header.timestamp` and keyed by `from.hashcode()` (`packages/programs/data/shared-log/src/index.ts`).
- The guard is already relatively permissive: it only drops strictly older messages (`prevApplied > messageTimestamp`), so equal timestamps will still apply.
- The CI symptom here was not “valid updates dropped due to timestamp skew”; it was (1) replication-info apply happening concurrently and (2) pubsub dropping/ignoring RPC traffic during the pending-subscribe window. Loosening the timestamp check would risk allowing stale state to overwrite newer state without addressing either root cause.

## 2026-02-06 Note: PR #589 Test vs PR #593 Scope
- PR `dao-xyz/peerbit#589` adds a pubsub regression test: `packages/transport/pubsub/test/bug1-initializeTopic-race.spec.ts` (guards the debounced `subscribe()` topic-init race).
- PR `dao-xyz/peerbit#593` changes `packages/transport/pubsub/src/index.ts` (in addition to many shared-log files), but does **not** list any new pubsub test file under `packages/transport/pubsub/test/**`.
- Recommendation:
  - If `#593` is intended to be mergeable on its own (or might land before/without `#589`), it should include the `#589` pubsub regression test (or a stricter/deterministic variant) so the pubsub fix doesn’t land untested.
  - If `#593` is intentionally stacked on `#589` and will be rebased/merged after `#589`, avoid duplication but make the dependency explicit so reviewers know the pubsub tests come from `#589`.
