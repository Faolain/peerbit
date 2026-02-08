Peerbit Architecture Visualization Tool - Implementation Plan

 Context

 Peerbit is a complex P2P database framework with many layers (libp2p transport, pubsub, blocks, programs, SharedLog, document store,
 replication ranges). Newcomers struggle to understand the data flow and architecture. This tool will be an interactive, animated
 visualization that lets users create peer nodes, connect them, open programs, append entries, and watch replication happen in real time —
 with a step-through timeline and React-DevTools-like state inspectors.

 Decisions Made
 Decision: Simulation model
 Choice: Hybrid — pure simulation engine now, designed so data model can later be backed by real Peerbit nodes
 ────────────────────────────────────────
 Decision: Scope
 Choice: Full stack — all layers (transport, pubsub, blocks, programs, SharedLog, documents, replication) with toggleable visibility
 ────────────────────────────────────────
 Decision: Deployment
 Choice: Standalone HTML file — self-contained, CDN dependencies only
 ────────────────────────────────────────
 Decision: Renderer
 Choice: D3 + Canvas hybrid — Canvas for network graph, HTML/CSS for inspector panels and UI
 ────────────────────────────────────────
 Decision: Inspector
 Choice: Floating panels per node — multiple open simultaneously
 ────────────────────────────────────────
 Decision: Actions
 Choice: Context menu + action bar — right-click nodes/connections, global buttons
 ────────────────────────────────────────
 Decision: Timeline
 Choice: Event-based steps — discrete events, play/pause/step, speed control
 File Location

 /Users/aristotle/Documents/Projects/peerbit/docs/architecture-viz.html

 Single HTML file (~3,600 lines). Only external dependency: D3.js v7 from CDN.

 Architecture Overview

 ┌──────────────────────────────────────────────────────┐
 │                   HTML/CSS Shell                      │
 │  ┌─────────────┐ ┌────────────────────────────────┐  │
 │  │ Action Bar   │ │        Canvas Container        │  │
 │  │ (top)        │ │                                │  │
 │  │ [+Node]      │ │  Canvas: nodes, connections,   │  │
 │  │ [Scenario]   │ │  particles, replication arcs   │  │
 │  │ [Layers]     │ │                                │  │
 │  └─────────────┘ │  HTML Overlay: floating         │  │
 │                   │  inspector panels per node      │  │
 │                   └────────────────────────────────┘  │
 │  ┌────────────────────────────────────────────────┐   │
 │  │ Timeline Panel (bottom)                         │   │
 │  │ |< < [▶] > >|  [1x] [2x]  ───●──────────     │   │
 │  │ Event: "Node A: entry appended [hash: e005]"   │   │
 │  └────────────────────────────────────────────────┘   │
 └──────────────────────────────────────────────────────┘
          │                    │
          ▼                    ▼
 ┌─────────────────┐  ┌─────────────────┐
 │ SimulationEngine │  │  CanvasRenderer  │
 │ (state machine)  │  │  (D3 + Canvas)   │
 │                  │  │                  │
 │ - nodes          │  │ - force layout   │
 │ - connections    │  │ - node circles   │
 │ - programs       │  │ - connection lines│
 │ - sharedLogs     │  │ - particles      │
 │ - eventLog[]     │  │ - range arcs     │
 │ - pendingEvents  │  │ - hit testing    │
 └─────────────────┘  └─────────────────┘

 Data Model (Key Interfaces)

 Modeled directly from the Peerbit codebase:

 SimNode (mirrors Peerbit class in peer.ts)
 ├── identity: { peerId, publicKeyHash, displayName, color }
 ├── programs: Map<address, SimProgram>
 ├── connections: Set<connectionId>
 ├── pubsub: { subscriptions, topicSubscribers }
 ├── blockStore: { blocks, totalSize }
 ├── position: { x, y }
 └── status: 'active' | 'stopping' | 'stopped'

 SimProgram (mirrors Program in program.ts)
 ├── address, type, name, closed
 ├── sharedLogs: Map<id, SimSharedLog>
 ├── topics: string[]
 └── children: string[]

 SimSharedLog (mirrors SharedLog in shared-log/src/index.ts)
 ├── entries: Map<hash, SimEntry>
 ├── heads: Set<hash>
 ├── replicationRanges: Map<id, SimReplicationRange>
 ├── replicas: { min, max }
 └── syncState: { pendingSync, syncedWith }

 SimEntry (mirrors Entry in log/src/entry.ts)
 ├── hash, gid, data, creatorPeerId
 ├── clock: { timestamp, counter }
 ├── next: string[]  (DAG links)
 ├── coordinate: number (0..1, position in replication space)
 └── replicatedBy: Set<peerId>

 SimReplicationRange (mirrors ReplicationRangeIndexableU32 in ranges.ts)
 ├── offset: number (0..1)
 ├── width: number (0..1)
 ├── mode: 'strict' | 'non-strict'
 └── matured: boolean

 SimConnection (mirrors libp2p connection + service readiness)
 ├── fromPeerId, toPeerId
 ├── state: 'connecting' | 'connected' | 'disconnecting'
 ├── layers: { transport, pubsub, blocks }
 └── latencyMs, bandwidth

 Event System

 Every state change is a discrete event on the timeline:

 Event types (grouped by layer):
 - Transport: node:create, node:destroy, connection:dial, connection:established, connection:hangup
 - PubSub: pubsub:subscribe, pubsub:unsubscribe, pubsub:message, connection:pubsub-ready
 - Blocks: block:request, block:deliver, connection:blocks-ready
 - Program: program:open, program:close, program:drop
 - SharedLog: sharedlog:append, sharedlog:exchange-heads, sharedlog:sync-request, sharedlog:sync-complete
 - Replication: replication:range-announce, replication:entry-replicate, replication:prune, replicator:join, replicator:leave,
 replicator:mature
 - Document: document:put, document:delete
 - RPC: rpc:request, rpc:response

 Cascading events (modeled from actual Peerbit behavior):
 User clicks "Connect A to B"
   → connection:dial
   → (after latency) connection:established       (transport layer up)
   → connection:pubsub-ready                       (DirectSub streams)
   → connection:blocks-ready                       (DirectBlock streams)
   → IF both nodes share a program:
     → sharedlog:exchange-heads                    (exchange log heads)
     → FOR each missing entry:
       → replication:entry-replicate               (sync entry)
     → replicator:join                             (new replicator announced)

 Timeline scrubbing: Checkpoint-and-replay strategy. Full state snapshot every 50 events. Rewind replays from nearest checkpoint.

 Canvas Rendering Strategy

 - Canvas handles: node circles, connection lines, animated particles, replication range arcs, labels
 - HTML overlay handles: inspector panels, context menus, tooltips, action bar, timeline
 - D3 handles: force-directed layout only (positions). Drawing is native Canvas 2D API.
 - Hit testing: Simple distance-to-node check (sufficient for 10-30 nodes)
 - Pan/zoom: Canvas transform matrix via ctx.translate() + ctx.scale()

 Visual encoding:
 - Transport connections: solid blue lines (#4a9eff)
 - PubSub traffic: animated green dots (#00cc88)
 - Block transfers: animated orange dots (#ff8844)
 - Replication ranges: colored arcs around node circles
 - Wrapped ranges (offset+width > 1.0): two arc segments per getSegmentsFromOffsetAndRange() in ranges.ts

 Implementation Phases

 Phase 1: Core Foundation (~1000 lines)

 - HTML skeleton, CSS dark theme, all container elements
 - SimulationState, SimNode, SimConnection data structures
 - SimulationEngine core: addNode(), removeNode(), addConnection(), removeConnection()
 - CanvasRenderer: render nodes as circles, connections as lines
 - D3 force layout (auto-position nodes)
 - Mouse interaction: drag nodes, pan, zoom
 - Action bar: "Add Node" button
 - Basic context menu: right-click node → Connect to..., Destroy
 - Event log array

 Phase 2: Programs & SharedLog (~800 lines)

 - SimProgram, SimSharedLog, SimEntry data structures
 - Context menu: "Open Program" → SharedLog / Documents
 - Program open event cascade (create log, subscribe to topic)
 - "Append Entry" action with coordinate assignment
 - Basic replication: connected peers with same program auto-sync entries
 - exchangeHeads simulation on connection
 - Replication range data structures (offset, width, wrapping)
 - Canvas: replication range arcs around nodes
 - Event cascading system (connect → exchange heads → replicate)

 Phase 3: Inspector & Timeline (~800 lines)

 - Floating inspector panel (draggable, multiple simultaneous)
 - Recursive collapsible tree renderer for node state
 - Auto-update on events with highlight flash animation
 - Timeline slider (HTML range input + custom track rendering)
 - Event markers on timeline (color-coded by layer)
 - Play/pause/step-forward/step-backward controls
 - Speed control (0.5x, 1x, 2x, 5x)
 - State checkpoint system for efficient scrubbing
 - Event description display
 - Toast notifications for events

 Phase 4: Advanced Visualization (~600 lines)

 - Animated particles along connections (speed, direction, color by layer)
 - Layer visibility toggle buttons in action bar
 - Layer-based rendering: show/hide transport, pubsub, blocks, ranges, entries
 - Range arc grow-in animations
 - Connection styling (dashed=connecting, solid=connected)
 - Node badges (program count, entry count)
 - Glow effects for active nodes
 - Entry replication animation (particle from source → target)
 - Simplified PID controller simulation for dynamic range adjustment

 Phase 5: Documents, RPC & Scenarios (~400 lines)

 - Document store simulation (PutOperation/DeleteOperation wrapping SharedLog)
 - "Put Document" / "Delete Document" context menu actions
 - RPC request/response visualization
 - Pre-built scenarios:
   - "3-Node Replication" — 3 nodes, connected, shared program, entries replicating
   - "Dynamic Sharding" — 5 nodes, ranges rebalancing as nodes join/leave
   - "Entry Lifecycle" — append, replicate, prune
 - "Load Scenario" dropdown in action bar
 - Keyboard shortcuts (Space=play/pause, arrows=step, N=new node, ?=help)
 - Help overlay with architecture guide

 Key Codebase References
 Concept: Peer client API
 Source File: packages/clients/peerbit/src/peer.ts
 Key Lines/Details: dial() (lines 296-325), open(), hangUp()
 ────────────────────────────────────────
 Concept: libp2p setup
 Source File: packages/clients/peerbit/src/libp2p.ts
 Key Lines/Details: DirectSub, DirectBlock, Noise, Yamux services
 ────────────────────────────────────────
 Concept: Program base
 Source File: packages/programs/program/program/src/program.ts
 Key Lines/Details: Lifecycle: beforeOpen(), open(), afterOpen(), close()
 ────────────────────────────────────────
 Concept: Program handler
 Source File: packages/programs/program/program/src/handler.ts
 Key Lines/Details: items Map, open/close lifecycle management
 ────────────────────────────────────────
 Concept: SharedLog
 Source File: packages/programs/data/shared-log/src/index.ts
 Key Lines/Details: State (lines 446-586), append() (1509-1570), topic = log.idString (line 2335)
 ────────────────────────────────────────
 Concept: Replication ranges
 Source File: packages/programs/data/shared-log/src/ranges.ts
 Key Lines/Details: ReplicationRangeIndexableU32 (lines 664-800), wrapping logic, getSegmentsFromOffsetAndRange() (lines 47-67)
 ────────────────────────────────────────
 Concept: Log & Entry
 Source File: packages/log/src/log.ts, packages/log/src/entry.ts
 Key Lines/Details: Entry structure: hash, meta.gid, meta.clock, meta.next, payload
 ────────────────────────────────────────
 Concept: Change events
 Source File: packages/log/src/change.ts
 Key Lines/Details: Change<T> = { added, removed }
 ────────────────────────────────────────
 Concept: SharedLog events
 Source File: packages/programs/data/shared-log/test/events.spec.ts
 Key Lines/Details: replicator:join, replicator:leave, replicator:mature
 ────────────────────────────────────────
 Concept: PubSub
 Source File: packages/transport/pubsub/src/index.ts
 Key Lines/Details: topics, peerToTopic, topicsToPeers maps
 ────────────────────────────────────────
 Concept: Documents
 Source File: packages/programs/data/document/document/src/program.ts
 Key Lines/Details: Wraps SharedLog with PutOperation/DeleteOperation
 ────────────────────────────────────────
 Concept: Bootstrap
 Source File: packages/clients/peerbit/src/bootstrap.ts
 Key Lines/Details: resolveBootstrapAddresses()
 Verification Plan

 1. Open the file: open docs/architecture-viz.html in a modern browser (Chrome/Firefox/Safari)
 2. Add nodes: Click "+ Add Node" 3 times. Verify nodes appear and auto-arrange via D3 force
 3. Connect nodes: Right-click Node A → "Connect to..." → click Node B. Verify connection line appears with 3-phase animation (transport →
 pubsub → blocks)
 4. Open program: Right-click Node A → "Open Program" → "SharedLog". Verify program appears in inspector
 5. Append entry: Right-click Node A → "Append Entry". Verify entry appears in inspector and on the timeline
 6. Replication: Open same program on Node B. Verify entries replicate (particle animation from A to B, entry appears in B's inspector)
 7. Timeline: Use slider to scrub backwards. Verify state reverts correctly. Step forward one event at a time.
 8. Layer toggles: Toggle off "transport" layer. Verify connection lines hide but nodes remain
 9. Inspector: Open inspectors for 2 nodes simultaneously. Verify both update in real-time
 10. Scenarios: Load "3-Node Replication" scenario. Verify pre-built nodes, connections, and programs set up correctly

## Implementation Results

**File:** `/docs/architecture-viz.html` — 2,168 lines, single self-contained HTML file with only D3.js v7 as external dependency.

### Features Implemented

**Core Engine:**
- `SimulationEngine` state machine with nodes, connections, programs, shared logs, entries
- Discrete event system with 20+ event types matching Peerbit's actual architecture
- Cascading events (connect → transport → pubsub → blocks → exchange heads → replicate)

**Canvas Rendering:**
- D3 force-directed layout for auto-positioning nodes
- Canvas 2D drawing for nodes, connections, particles, replication arcs
- Pan, zoom, drag interactions
- Animated particles along connections (color-coded by layer)
- Replication range arcs with wraparound support (mirrors `getSegmentsFromOffsetAndRange()`)
- Node badges showing program/entry counts, glow effects

**Inspector Panels:**
- Floating, draggable panels per node
- Recursive collapsible tree view showing full node state
- Real-time updates on events

**Timeline:**
- Event-based slider with play/pause/step-forward/step-backward
- Speed control (0.5x, 1x, 2x, 5x)
- Color-coded event markers
- Event description display

**Interactions:**
- Right-click context menus for nodes, connections, and canvas
- Actions: Connect, Open SharedLog/Documents, Append Entry, Put/Delete Document, Disconnect, Destroy
- Connection mode with visual indicator
- Layer visibility toggles (Transport, PubSub, Blocks, Ranges, Entries)

**Scenarios:**
- **3-Node Replication** — 3 connected nodes sharing a program with replicating entries
- **Dynamic Sharding** — 5 nodes in a ring with cross-links, each contributing to sharding
- **Entry Lifecycle** — 2 nodes showing DAG-linked entries replicating

**Keyboard Shortcuts:** `N` (add node), `Space` (play/pause), arrows (step), `?` (help), `Esc` (cancel), `+/-` (zoom)