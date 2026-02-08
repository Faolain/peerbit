# Architecture Visualization — Implementation Plan (Phase 2)

Findings from comparing `docs/architecture-viz.html` against the real Peerbit codebase.
Goal: bring the viz closer to the actual system behavior.

---

## Accuracy Audit

### What the viz gets right
- Layered architecture: transport, pubsub, blocks
- Programs with shared logs subscribing to topics for peer discovery
- Replication ranges in circular coordinate space with wraparound
- Bidirectional information exchange when peers connect
- Documents as put/delete operations on top of SharedLog
- DAG-linked entries with heads tracking

### Critical inaccuracies to fix

| # | Issue | Viz behavior | Real behavior | Priority |
|---|-------|-------------|---------------|----------|
| 1 | Replication targeting | Floods entries to all connected peers with same program | Leader-based targeted delivery — entries sent only to replicators whose ranges cover the entry's coordinates | **High** |
| 2 | Cascading replication | Peer relays to its other peers (gossip) | Originator sends directly to all relevant leaders; no relay chain | **High** |
| 3 | Connection cascade | Sequential: transport → pubsub → blocks with fixed offsets | Pubsub and blocks are independent protocols negotiating in parallel | **Medium** |
| 4 | Program addressing | Random string (`program-<hash>`) | Content-addressed CID from serialized program | **Low** |
| 5 | Range space | Float `[0, 1]` | Integer u32 `[0, 4294967295]` or u64 | **Low** (conceptually equivalent) |

---

## Implementation Tasks

### Phase 2a — Fix replication model (High priority)

#### 2a.1 Leader-based entry delivery
Replace the current `replicateEntry()` flood with leader computation:
- When appending an entry, compute its coordinate (already exists)
- Find which replicators' ranges cover that coordinate (`rangeContains()` already exists)
- Send the entry only to those leaders, not to all connected peers
- Update `replicateEntry(sourceNodeId, programAddress, entry)` to:
  1. Collect all replication ranges across all nodes for the program
  2. Filter to ranges that contain `entry.coordinate`
  3. Send only to nodes owning those ranges (that are reachable via connections)
- Add event type `replication:leader-send` to distinguish from generic replication

#### 2a.2 Remove cascading replication
- Delete the cascading relay logic in `replicateEntry()` (the inner loop at lines 951-964)
- Delete `replicateEntryDirect()` (only used for cascading)
- Instead, have the originator iterate all known leaders and send directly
- If a leader is not directly connected, show a "no route" indicator or skip (defer multi-hop to Phase 2c)

#### 2a.3 Visualize leader selection
- When an entry is appended, briefly highlight the leaders on the canvas (flash their replication arcs)
- Show particle animations only to the targeted leaders, not all peers
- Add a tooltip or event description showing why each leader was chosen ("range [0.2..0.5] covers coordinate 0.35")

### Phase 2b — Fix connection model (Medium priority)

#### 2b.1 Parallel protocol negotiation
- Change `addConnection()` so pubsub and blocks negotiate independently (not sequentially)
- Both start after transport is established, with independent random latencies
- Replace the fixed `+30ms` / `+60ms` offsets with two independent timers starting from transport-ready
- Head exchange triggers when **both** pubsub and blocks are ready (not just blocks)

#### 2b.2 Connection state display
- Show protocol negotiation status on connection hover: "transport: ready, pubsub: negotiating, blocks: ready"
- Dashed line segments during negotiation, solid when fully connected

### Phase 2c — Add missing systems (Lower priority)

#### 2c.1 RPC layer abstraction
- Add visual indication that messages go through an RPC layer
- Show message types in particles: `ExchangeHeadsMessage`, `AllReplicatingSegmentsMessage`, `RequestReplicationInfoMessage`
- Color-code particles by message type

#### 2c.2 Synchronizer (simplified)
- After initial head exchange, run a periodic "sync check" between connected peers
- Compare entry sets and request missing entries
- Show sync status in inspector: "synced with: [Alice, Bob]", "pending: [Carol]"
- Event types: `sync:request`, `sync:complete`

#### 2c.3 Pruning protocol
- If a node holds an entry outside its replication range, schedule a prune check
- Send prune request to peers: "Can I drop entry X? Do you have it?"
- If confirmed, remove entry from local store
- Event types: `prune:request`, `prune:confirm`, `prune:drop`
- Show pruned entries fading out in the inspector

#### 2c.4 Adaptive replication
- Add a "load" simulation to nodes (memory/CPU proxy)
- Replication range width adjusts based on load: high load → narrower range, low load → wider range
- Animate range arc width changes
- Show the PID controller concept in inspector: "target width: 0.33, current: 0.28, adjusting..."

#### 2c.5 Multi-hop routing
- If a leader is not directly connected but reachable via intermediate nodes, route through them
- Show multi-hop particle paths traversing intermediate connections
- Event type: `route:relay`

### Phase 2d — Polish (Low priority)

#### 2d.1 Content-addressed program IDs
- Generate program addresses as CID-like hashes instead of random strings
- Show in inspector: "address: bafy..."

#### 2d.2 Entry types
- Support `APPEND` and `CUT` entry types
- `CUT` entries render with strikethrough in inspector
- Document delete creates a `CUT` entry instead of a regular append

#### 2d.3 Delivery modes
- Add delivery mode selection in context menu: Acknowledge / Silent / Seek
- Acknowledge mode: show return particle (ACK) from leader back to sender
- Silent mode: no ACK particle

#### 2d.4 GID grouping
- Group entries by GID in inspector view
- Show GID-based leader computation: "GID g-abc123 → leaders: [Alice, Bob]"

---

## Files to modify
- `docs/architecture-viz.html` — baseline (Phase 1), keep unchanged
- `docs/architecture-viz-phase2.html` — Phase 2 parallel implementation (all Phase 2 changes go here)

## Key functions to change
- `engine.replicateEntry()` — replace flood with leader targeting (2a.1, 2a.2)
- `engine.replicateEntryDirect()` — remove (2a.2)
- `engine.addConnection()` — parallel protocol negotiation (2b.1)
- `engine.exchangeHeadsIfNeeded()` — add replication segment exchange (2c.1)
- `engine.appendEntry()` — add leader computation before replication (2a.1)
- `renderer.drawParticle()` — message type labels (2c.1)
- `renderer.drawNode()` — leader highlight flash (2a.3)
- New: `engine.findLeaders(coordinate, programAddress)` — compute leaders from ranges (2a.1)
- New: `engine.syncCheck(nodeIdA, nodeIdB)` — simplified synchronizer (2c.2)
- New: `engine.pruneEntry(nodeId, entryHash)` — pruning protocol (2c.3)

---

## Reference: Real implementation files
- `packages/clients/peerbit/src/peer.ts` — `Peerbit.dial()`, `open()`
- `packages/transport/stream/src/index.ts` — `DirectStream`, connection lifecycle
- `packages/transport/pubsub/src/index.ts` — `DirectSub`, subscriptions
- `packages/transport/blocks/src/libp2p.ts` — `DirectBlock`
- `packages/programs/program/program/src/program.ts` — `Program` base class lifecycle
- `packages/programs/data/shared-log/src/index.ts` — `SharedLog.append()`, `handleSubscriptionChange()`, `onMessage()`
- `packages/programs/data/shared-log/src/exchange-heads.ts` — `ExchangeHeadsMessage`
- `packages/programs/data/shared-log/src/ranges.ts` — `ReplicationRangeIndexable`, segment math
- `packages/programs/data/shared-log/src/replication.ts` — `MinReplicas`, replication messages
- `packages/programs/data/document/document/src/program.ts` — `Documents.put()`, `del()`

---

## Parallel Implementation Artifact

Baseline (Phase 1): `docs/architecture-viz.html` (do not edit)

Parallel implementation (Phase 2): `docs/architecture-viz-phase2.html`

---

## Running Log

### Learnings
- 2026-02-08: In `docs/architecture-viz.html`, `exchangeHeadsIfNeeded()` currently syncs missing entries by directly calling `replicateEntryDirect()` (so `replicateEntryDirect()` is not only used for cascading replication today).
- 2026-02-08: `openProgram()` triggers head exchange against any connection with `conn.state === 'connected'` (set at transport-ready), even when `pubsub`/`blocks` negotiation is not yet complete.
- 2026-02-08: Connection visualization currently only differentiates `conn.state` (`connecting` vs `connected`) and partially uses `conn.layers.blocks` for alpha; there is no existing connection hover/tooltip system.
- 2026-02-08: Timeline scrubbing (`timeline.seekTo`) restores snapshots and only re-spawns animations for a small subset of event types; new “leader send” visuals need explicit handling so they show up while stepping/scrubbing.
- 2026-02-08: In the real code, “pubsub” (`DirectSub`) and “blocks” (`DirectBlock`) are Peerbit implementations registered as libp2p services (they run *over* libp2p connections/streams, but are not libp2p’s gossipsub/bitswap).
- 2026-02-08: The layer toggle UI benefits from explicitly labeling “libp2p” vs “Peerbit” ownership to avoid confusing Peerbit’s DirectSub/DirectBlock with libp2p gossipsub/bitswap.

### Ahas
- 2026-02-08: The cleanest “parallel implementation” is a new HTML file that starts as a copy of `docs/architecture-viz.html`, so Phase 2 changes can iterate without breaking the baseline demo.
- 2026-02-08: To make leader-selection visuals actually visible during timeline stepping, hook the effects to `replication:leader-send` in `timeline.seekTo` (similar to how `replication:entry-replicate` spawns particles today).

### Answers To Questions
- 2026-02-08: “Do not edit the existing one” interpreted as: keep `docs/architecture-viz.html` unchanged; implement Phase 2 behaviors in a new `docs/architecture-viz-phase2.html` file.
- 2026-02-08: Layer ownership (what is Peerbit vs libp2p?):
  - Transport: libp2p connection + stream mux/encryption (Peerbit uses libp2p underneath)
  - PubSub: Peerbit `DirectSub` (`packages/transport/pubsub/...`) running over libp2p streams
  - Blocks: Peerbit `DirectBlock` (`packages/transport/blocks/...`) running over libp2p streams
  - Entries: Peerbit log entries (`packages/log/...`) stored as content-addressed blocks
  - Ranges: Peerbit SharedLog replication ranges (`packages/programs/data/shared-log/src/ranges.ts`)

### Next Steps
- Done: Create `docs/architecture-viz-phase2.html` by copying the baseline file.
- Done: Phase 2a leader-based replication targeting (and remove cascading replication) implemented in `docs/architecture-viz-phase2.html`.
- Done: Phase 2b connection protocol negotiation in parallel (and gate head exchange on both pubsub+blocks ready) implemented in `docs/architecture-viz-phase2.html`.
- Done: Leader-selection visualization (range arc flash), `replication:leader-send` event, and connection hover status tooltip implemented in `docs/architecture-viz-phase2.html`.
- Next: Implement Phase 2c.1 (RPC message types) by tagging particles/events with message-type labels and updating the particle renderer accordingly.
