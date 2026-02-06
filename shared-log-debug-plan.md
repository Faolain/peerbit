Use this as a running log of all findings.

# Learnings

## PR #3 (Faolain/peerbit) - `fix/rootcause-b-persistcoordinate-guard`
- **What it does:** Adds shutdown guards to `persistCoordinate` to prevent TypeError when `_close()` nullifies internal indices during async operations.
- **Base branch:** `fix/pubsub-subscribe-race` (NOT master)
- **Does it fix the TOCTOU race?** NO. The persistCoordinate guard is in a completely different code path from the TOCTOU race in `onMessage()` line 2971.
- **CI Failures (3 runs):**
  - Run 1: Part 2 FAIL (`@peerbit/document` redundancy flake), Parts 3/4 CANCELLED
  - Run 2: Part 4 FAIL (3 shared-log failures: events + migration)
  - Run 3: Part 4 FAIL (same 3 shared-log failures)
- **All failures are inherited from the base branch** (`fix/pubsub-subscribe-race`). The same 3 shared-log failures appear identically on the base branch run 21738358691.
- **Conclusion:** PR #3 itself introduces zero new test failures. It's a valid shutdown hardening fix but doesn't address the TOCTOU race.

## PR #4 (Faolain/peerbit) - `fix/rootcause-c-comprehensive-shutdown-guards`
- **What it does:** Comprehensive shutdown guards for all async operations in shared-log.
- **Base branch:** `fix/pubsub-subscribe-race` (NOT master)
- **Does it fix the TOCTOU race?** NO. Same 3 failures persist deterministically (100% repro across 6+ CI runs).
- **CI Failures (2 runs):**
  - Both runs: Part 4 FAIL with the identical 3 shared-log failures
  - Parts 1, 2, 3, 5 all pass
- **All failures inherited from base branch.** Cross-verified:
  - Faolain/master: all 1743 tests pass (run 21729156838)
  - `fix/pubsub-subscribe-race` base: same 3 failures
  - upstream dao-xyz/peerbit master: all pass
- **Conclusion:** PR #4 itself introduces zero new test failures. Shutdown guards are valid but orthogonal to the TOCTOU race.

## PR #591 (dao-xyz/peerbit) - `fix/shared-log-unhandled-persistcoordinate`
- **What it does:** Avoids unhandled rejection when `entry.hash` is missing.
- **Base branch:** master
- **Files changed:** Only `packages/programs/data/shared-log/src/index.ts` + new test file
- **CI Failures (1 run):**
  - Part 2 FAIL: `@peerbit/document` > "can search while keeping minimum amount of replicas" (`Failed to collect all messages 557 < 1000`)
  - Parts 3, 4, 5 CANCELLED (fail-fast behavior)
- **Is this a regression?** NO. The failing test is in `@peerbit/document` -- a completely different package from what PR #591 modifies.
- **Pre-existing flake?** YES, definitively. Same test fails on:
  - upstream master (Jan 28 run): `998 < 1000`
  - research/pubsub-large-network-testing branch: `379 < 600`
  - Multiple other branches with varying counts
- **Conclusion:** PR #591 is safe to merge. The sole CI failure is a well-known pre-existing flake in an unrelated package.

## TOCTOU Race Analysis (Source Code)

### Root Cause: Fire-and-Forget Async IIFE in onMessage (line 2971)
The replication-info handler at `packages/programs/data/shared-log/src/index.ts:2971` uses an un-awaited async IIFE. When two `AllReplicatingSegmentsMessage` messages arrive from the same peer close together, two concurrent IIFEs can both call `addReplicationRange()` simultaneously.

### The TOCTOU Window in addReplicationRange (lines 1139-1408)
1. **CHECK (line 1172):** `prevCount = deleted.length` reads current index state
2. **DECISION (line 1200):** `isNewReplicator = prevCount === 0 && ranges.length > 0`
3. **WRITE (line 1188):** `await this.replicationIndex.del(...)` -- happens LATER, with awaits in between
4. **EMIT (line 1382-1387):** `replicator:join` event fired based on stale decision

Two concurrent IIFEs both see `prevCount === 0` before either writes, both decide `isNewReplicator = true`, both emit `replicator:join`.

### Why Two Messages Arrive Close Together
`handleSubscriptionChange()` (line 3954-3985) sends BOTH:
1. `AllReplicatingSegmentsMessage` (proactive announcement)
2. `RequestReplicationInfoMessage` (which triggers a response `AllReplicatingSegmentsMessage` from the remote)

This creates two `AllReplicatingSegmentsMessage` objects arriving within milliseconds.

### Error Swallowing (line 2999)
`isNotStartedError(e)` silently drops replication-info messages when the index isn't ready yet. No retry mechanism exists -- messages are permanently lost.

### afterOpen Snapshot (line 2237)
Only takes a single snapshot of current subscribers via `getSubscribers()`. Does not call `requestSubscribers()`. If subscription events arrive during init (before listener attached), they're missed.

## Failing Tests Analysis

### events.spec.ts:84-122 ("replicate:join not emitted on update")
- Opens store on 2 peers, both with replication factor 1
- Listens for `replicator:join` events on store1
- Waits for initial join from peer[1]
- Updates peer[1]'s replication to factor 0.5 with `reset: true`
- **Asserts:** `db1JoinEvents` should contain exactly 1 entry (the initial join)
- **Fails when:** Duplicate join event emitted (array has 2 entries with same hash)
- **Root cause:** The TOCTOU race -- two concurrent `addReplicationRange()` calls both see `prevCount === 0`

### migration.spec.ts:124-140 ("8-9 / 9-8, replicates database of 1 entry")
- Sets up v8-compatible peer (drops AllReplicatingSegmentsMessage, AddedReplicationSegmentMessage)
- Sets up v9 peer using standard behavior
- Adds "hello" on one side, expects it to replicate to other
- **Fails when:** `waitForResolved(() => expect(logLength).equal(1))` times out with `expected +0 to equal 1`
- **Root cause:** Likely a combination of handshake timing changes (pubsub fix makes subscriptions resolve faster) and the v8 compatibility layer not handling the changed message ordering

# Claims

## Claim: All 3 CI failures on PRs #3 and #4 are caused by the pubsub fix base branch, not by the shared-log PRs themselves
**CONFIRMED.** Evidence:
- Faolain/master (without pubsub fix): All 1743 tests PASS
- `fix/pubsub-subscribe-race` base branch: Same 3 failures (1740 pass, 3 fail)
- PR #3 on top of base: Same 3 failures
- PR #4 on top of base: Same 3 failures
- upstream dao-xyz/peerbit master: All pass (recent runs 21415435239, 21415236895)

## Claim: The document "redundancy" test is a repo-wide pre-existing flake
**CONFIRMED.** Appears on:
- upstream master (Jan 28): `998 < 1000`
- PR #591 branch: `557 < 1000`
- fix/pubsub-subscribe-race: `997 < 1000`
- PR #3 run 1: `549 < 1000`
- Various research branches with different counts

## Claim: PR #3's persistCoordinate guard does NOT fix the TOCTOU race
**CONFIRMED.** The TOCTOU race is in `onMessage()` line 2971 (fire-and-forget async IIFE calling `addReplicationRange()`). PR #3's guard is in `persistCoordinate()` -- a completely different code path. Test results confirm: same 3 failures with PR #3 applied.

## Claim: The fix requires per-peer serialization of replication-info processing
**STRONGLY SUPPORTED.** The race occurs because two async IIFEs for the same peer can run `addReplicationRange()` concurrently. A per-peer mutex/queue (`Map<string, Promise<void>>`) around the IIFE body would serialize processing and prevent the duplicate `prevCount === 0` read.

# Ahas/Gotchas
- Aegir config bug: `.aegir.js` assumed `.git` is a directory; in this worktree `.git` is a file, causing `Error finding your config file` on any `aegir` command. Fixed by resolving root from the config file directory and falling back to `.git` file (`.aegir.js`).
- Aegir test gotcha: `--no-build` skips compilation, but tests live in TypeScript. Until `dist/test/**` exists, `aegir test --no-build` reports `Error: No test files found`.
- CI fail-fast behavior: When one part fails, other parts may be CANCELLED (not FAILED). Don't assume cancelled parts had failures -- check the part that actually failed.
- PR #3 and #4 both target `fix/pubsub-subscribe-race` (not master). Any CI failures on the base branch will appear on both PRs. Must compare against the correct base, not just master.
- The `@peerbit/document` "can search while keeping minimum amount of replicas" test is flaky across the ENTIRE repo (master, feature branches, PRs). It's a timing-sensitive test that occasionally fails to collect all messages. Should not block merges.
- `uniqueReplicators.add()` at line 1284 happens AFTER the `isNewReplicator` decision at line 1200, so it cannot prevent the race. The add is unconditional and doesn't return whether the value was new.
- `handleSubscriptionChange()` sends both a proactive `AllReplicatingSegmentsMessage` AND a `RequestReplicationInfoMessage` on every subscription change. This guarantees at least 2 replication-info messages per join, making the TOCTOU window very likely to be hit with faster subscription discovery (PR #589).
- The `latestReplicationInfoMessage` timestamp check at line 2972-2974 is NOT inside the serialized section, so it's also racy -- two IIFEs can both pass the check before either sets the new timestamp.

# Tests

## CI Test Results Summary

### PR #3 (fix/rootcause-b-persistcoordinate-guard)
| Run | Part | Package | Test | Result | Error |
|-----|------|---------|------|--------|-------|
| 1 | 2 | @peerbit/document | can search while keeping minimum amount of replicas | FAIL | `549 < 1000` (pre-existing flake) |
| 2 | 4 | @peerbit/shared-log | replicate:join not emitted on update | FAIL | duplicate join event (base branch) |
| 2 | 4 | @peerbit/shared-log | 8-9, replicates database of 1 entry | FAIL | `expected +0 to equal 1` (base branch) |
| 2 | 4 | @peerbit/shared-log | 9-8, replicates database of 1 entry | FAIL | `expected +0 to equal 1` (base branch) |
| 3 | 4 | @peerbit/shared-log | (same 3 as run 2) | FAIL | (same errors) |

### PR #4 (fix/rootcause-c-comprehensive-shutdown-guards)
| Run | Part | Package | Test | Result | Error |
|-----|------|---------|------|--------|-------|
| 1 | 4 | @peerbit/shared-log | replicate:join not emitted on update | FAIL | duplicate join event (base branch) |
| 1 | 4 | @peerbit/shared-log | 8-9, replicates database of 1 entry | FAIL | `expected +0 to equal 1` (base branch) |
| 1 | 4 | @peerbit/shared-log | 9-8, replicates database of 1 entry | FAIL | `expected +0 to equal 1` (base branch) |
| 2 | 4 | @peerbit/shared-log | (same 3 as run 1) | FAIL | (same errors) |

### PR #591 (fix/shared-log-unhandled-persistcoordinate)
| Run | Part | Package | Test | Result | Error |
|-----|------|---------|------|--------|-------|
| 1 | 2 | @peerbit/document | can search while keeping minimum amount of replicas | FAIL | `557 < 1000` (pre-existing flake) |
| 1 | 3-5 | - | - | CANCELLED | (fail-fast from part 2) |

### Upstream master (dao-xyz/peerbit) - Recent
| Run | Part 1 | Part 2 | Part 3 | Part 4 | Part 5 |
|-----|--------|--------|--------|--------|--------|
| 21415435239 | PASS | PASS | PASS | PASS | PASS |
| 21415236895 | PASS | PASS | PASS | PASS | PASS |

### Action Items (IMPLEMENTED)
- [x] Implement per-peer serialization in onMessage handler (step 1)
  - Added `_replicationInfoQueue: Map<string, Promise<void>>` field
  - Replaced fire-and-forget async IIFE at line 2971 with per-peer promise chain
  - Each new message for the same peer waits for the previous to complete
  - Timestamp check moved inside the serialized section
- [x] Make replicator:join emission idempotent (step 2)
  - Added `wasAlreadyReplicator = uniqueReplicators.has()` check before `uniqueReplicators.add()` in `addReplicationRange()`
  - Guarded `replicator:join` emission with `isNewReplicator && !wasAlreadyReplicator`
  - REVERTED `!wasKnown` guard in `pruneOfflineReplicators()` -- it broke restart-join semantics (see regression note below)
- [x] Stop losing replication-info on NotStartedError (step 3)
  - Added `_pendingReplicationInfo: Map<string, {...}>` to store latest message per peer on NotStartedError
  - On successful application, clears pending info for that peer
  - In `afterOpen()`, drains all pending messages after subscriber snapshot
- [x] Created pubsub test files (bug2 and bug3 specs)
  - `bug2-requestSubscribers-pendingSubscribe.spec.ts`: tests pending subscribe visibility + design guard
  - `bug3-subscribe-then-unsubscribe-before-debounce.spec.ts`: tests subscribe-then-unsubscribe edge case
- [x] Validate: run events.spec + migration.spec multiple times to confirm stability
  - events.spec "replicate:join not emitted on update": 5/5 PASS (513ms, 311ms, 332ms, 332ms, 319ms)
  - migration.spec "replicates database of 1 entry": 5/5 PASS (all 4 subtests per run)
  - Pubsub full suite: 42/43 pass (1 expected fail: bug2 tests pubsub-layer pending subscribe, not shared-log)
- [x] Run full test:ci:part-4 to check for regressions
  - First run: 1741 pass, 2 fail (regression from `wasKnown` guard in `pruneOfflineReplicators`)
  - Failing tests: "segments updated while offline" + "will re-check replication segments on restart"
  - Root cause: On restart, `pruneOfflineReplicators` is the INTENDED path to fire `replicator:join` for persisted peers. But `addReplicationRange()` (from message exchange) adds the peer to `uniqueReplicators` first, so `wasKnown=true` by the time `pruneOfflineReplicators` checks.
  - Fix: Reverted the `wasKnown` guard in `pruneOfflineReplicators` -- it's unnecessary there since it's called once per open with internal `checkedIsAlive` dedup. The guard remains in `addReplicationRange()` only.
  - After fix: persistance tests 5/5 PASS, events 3/3 PASS, migration 3/3 PASS
  - Second run: **1743 passing, 0 failing** (17m) -- ALL TESTS PASS
