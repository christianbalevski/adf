# Fleet Map Performance: Audit & Plan for 100-Agent Smooth Pan

**Symptom:** ~10 agents messaging each other in fullscreen; panning causes severe
flicker to the point of unusability.
**Goal:** buttery-smooth pan/zoom with 100 active agents.

Four parallel audits (graph construction, node/edge components, event→store
pipeline, screen-space overlays) converged on the same picture. Panning in
React Flow is just a CSS transform — it is cheap by design. The flicker is
everything else landing *during* pan frames.

## Root cause synthesis

The flicker is three problems superimposed:

### A. Layers that do real work on every pan frame

| # | What | Where | Mechanism |
|---|------|-------|-----------|
| A1 | **FleetGardenLayer full CPU repaint per frame** | `FleetGardenLayer.tsx:48,51-146` | Subscribes to RF `transform`; draw effect deliberately has no dep array → every pan frame re-noises and re-fills every visible hex (thousands of cells × ~6 `sin()` evals at overview zoom), on the React commit path |
| A2 | **FleetVoicesLayer per-frame relayout + chip pop-in/out** | `FleetVoicesLayer.tsx:67,174-204,239-240` | Transform subscription → projection + O(n²) declutter per frame; chips positioned via `left/top` (layout, not transform) each with `backdrop-filter: blur`; the ±400px screen cull returns `null` → chips **mount/unmount as they cross the boundary mid-pan** — the discrete "pop" flicker |
| A3 | **HexBackground pattern re-raster per frame** | `HexBackground.tsx:19,45` + `globals.css:361-372` | `patternTransform` rewrite on a full-viewport `userSpaceOnUse` pattern re-rasterizes each frame; two infinite `gardenBreathe` full-screen gradient washes repaint constantly even idle |
| A4 | **Forced synchronous layout per mousemove** | `MeshGraphView.tsx:580-586,1304` | `overSayBubble` runs `querySelectorAll('.fleet-say-bubble')` + `getBoundingClientRect()` per bubble per mousemove, synchronously, before the rAF. Say bubbles live **75s** (`MeshGraphNode.tsx:39`) so with 10 chatty agents several always exist → invalidate→layout thrash interleaved with the pan transform writes |
| A5 | **Fullscreen edge-scroll amplifies all of the above** | `MeshGraphView.tsx:688-717` | `setViewport()` every rAF (120Hz on ProMotion) while cursor is near an edge → every transform subscriber re-renders per frame with zero pointer movement. This is the user's exact scenario (fullscreen) |
| A6 | **Hover cards cycle during pan** | `MeshGraphView.tsx:1643-1666` | No pan gate on hover arming; slow pan over tiles mounts/unmounts `FleetHoverCard` (with fade-in replay) repeatedly |

### B. Per-event fleet-wide re-render cascade

Event volume baseline: one message exchange ≈ 25–30 IPC events. 10 chatty
agents ≈ 15–40 events/sec → 10–30 store `set()`/sec. **At 100 agents:
150–400 set()/sec.** Every one of those currently cascades:

| # | What | Where | Mechanism |
|---|------|-------|-----------|
| B1 | **`updateAgentState` rebuilds the agents array on every event** | `mesh.store.ts:53-58`; `useMeshGraph.ts:173-187,291` | Always `s.agents.map(...)` — new identity even when nothing changed; no bail like `setAgents` has. Noisy `thinking`↔`tool_use` flips are forwarded *before* the NOISY_STATES filter (it only gates the activity feed). New identity → 2360-line `MeshGraphCanvas` re-renders + 7 whole-array subscribers (`FleetTerrainNode:244`, `FleetTerrainLabelNode:62`, `FleetVoicesLayer:68`, `FleetAlertBar:53`, `FleetCommandBar:98`, `FleetHoverCard:81`, `FleetStewardsPanel:47`) |
| B2 | **`nodeActivities` wholesale replacement per activity** | `mesh-graph.store.ts:156-171` | Every tool_start/tool_result/llm/turn/message/state event from ANY agent gives the record a new identity → every territory's `FleetTerrainNode` + `FleetTerrainLabelNode` (the heaviest per-cell SVG stacks — ~15 elements per unit: icon, name-fit, status wrap, burn meta, context gauge, 5 badge types) re-render fleet-wide, several times per second. A comment at `FleetTerrainLabelNode.tsx:65-66` admits the cadence. `MeshGraphNode.tsx:182` shows the correct per-key pattern |
| B3 | **Canvas re-render → double render + full RF rediff** | `MeshGraphView.tsx:1069-1090,1331-1343` | New agents identity → `nodes` memo rebuilds → controlled-state mirror (`setControlledNodes`/`setControlledEdges`, mapping again with new identities) → a second render pass + React Flow diff of all nodes+edges per event. Un-memoized `layoutKey` (line 1329) does O(n log n) work *every render* |
| B4 | **No batching anywhere; double listener sets** | `useMeshGraph.ts:125-390` vs `App.tsx:52-54` | Every IPC event → immediate synchronous `set()`. AGENT_EVENT and BACKGROUND_AGENT_EVENT are each processed by two listener sets (app root + useMeshGraph); `background-agents.store.ts:18` also full-array-maps per state change |
| B5 | **5s poll always sets fresh identities** | `MeshGraphView.tsx:726-775`; `fleet.store.ts:186-195` | `setDebugInfo`/`setAdapters`/`setLanPeers`/`setBurn` never content-compare → `buildEdges` mints all-new edge objects (defeating `memo(MeshGraphEdge)` via fresh `data`), station nodes rebuilt → periodic whole-graph rediff hitch even when idle, worse mid-pan |

### C. Constant uncomposited animation load

| # | What | Where |
|---|------|-------|
| C1 | Infinite SVG `hexPulse` (opacity) on every active tile polygon, state dots, HIL badges, minimap pings; `hexDashFlow` stroke-dashoffset march | `FleetTerrainNode.tsx:375-396`, `FleetTerrainLabelNode.tsx:307,392`, `MeshGraphView.tsx:612`, `globals.css:223` |
| C2 | Message pulses: 3 animated SVG elements per in-flight message via `offset-path`/dasharray (uncomposited, repaint per frame); linger up to 3s past expiry | `MeshGraphEdge.tsx:290-318`, `globals.css:275` |
| C3 | The `fleet-calm` governor (`globals.css:377-385`, `FleetAmbienceLayer.tsx:193-199`) exists precisely for this cost but does not engage during pan |

SVG opacity/dashoffset/offset-path animations are not compositable — each
animated element dirties paint every frame, so the panned layer never gets a
cheap translate-only frame.

### D. Scale ceiling (matters at 100, not 10)

- No `onlyRenderVisibleElements` (`MeshGraphView.tsx:2119-2150`): the whole
  world is in the DOM — every unit hex (~15 SVG elements), every mesh node
  (260×280 DOM + 4 handles + clip-path), uncapped station cities ("a
  100-agent runtime renders a 100-tile city", `FleetStationNode.tsx:166`).
- `FleetStationNode` `extraPadCount` selector is O(all edgeHeat) per store
  change, per station (`FleetStationNode.tsx:130-141`).
- `peerAgentPings` never pruned (hourly sweep covers other maps only);
  whole-map subscriptions in stations (`FleetStationNode.tsx:117-118`).
- Pulse arrays (`activityPulse`/`messagePulse`/`agentPulse`) filter a growing
  5-minute window on every event (`mesh-graph.store.ts` `pushPulse:51`).

### Already well-done (preserve these patterns)

- `FleetAmbienceLayer` is the model: one canvas, one rAF, 30fps cap, adaptive
  calm-mode governor, reads `getViewport()` imperatively.
- `nodeTypes`/`edgeTypes` are module-level constants (the classic RF
  full-remount cause is absent); node ids are stable; the layout memo is keyed
  on structure; decorated node objects preserve identity for unchanged agents;
  `liveRoutes` keeps identity for existing pairs; `MeshGraphEdge` per-key
  animation/heat selectors; `MeshGraphNode` per-key activity selectors;
  `cursorCell` tracking is rAF-throttled and store-isolated.

### Functional gap found while tracing (not perf)

Local same-runtime agent-to-agent messages never emit `message_routed` — only
peer-station and adapter paths do (`mesh-manager.ts:1191,1236,1874`,
`ipc/index.ts:599`); local fast-path delivery (`mesh-manager.ts:1003-1119`)
emits only `inbox_updated`. Live edge animations/heat/minimap pings never fire
for local traffic; local edges appear only via the 5s debug poll. Fixing this
will *increase* event rate, so it must land **after** Phase 1 batching.

## The plan

Ordered by impact-per-risk. Phases 1+2 fix today's 10-agent flicker; 3+4 buy
the headroom to 100.

### Phase 1 — Stop the per-event cascade (difficulty 6/10)

1. **rAF-batched event flush.** Buffer IPC events in the listeners; flush to
   stores once per animation frame with a single `set()` per store. Kills the
   150–400 set()/sec extrapolation at the source. (B4)
2. **Identity discipline in stores.** `updateAgentState` bails when the mapped
   state is unchanged and preserves untouched agent objects; stop forwarding
   noisy `thinking`/`tool_use` flips to the roster store; content-compare
   `setBurn`/`setDebugInfo`/`setAdapters`/`setLanPeers` (as `setAgents`
   already does). (B1, B5)
3. **Split hot slices.** Keep a separate `lastActivityAt: Record<path, number>`
   (and pending flags) so activity recency doesn't ride the wholesale
   `nodeActivities` feed identity. (B2)
4. **Narrow selectors everywhere.** Terrain/label/voices/alert/command/hover/
   stewards/station components subscribe to per-cell / per-key primitives, not
   whole arrays/records. `MeshGraphNode` is the template. (B1, B2, D)

### Phase 2 — Make pan frames translate-only (difficulty 6/10)

5. **GardenLayer → world-space offscreen canvas.** Render the noise field once
   per zoom-bucket/theme/resize into a canvas, move it with a CSS transform
   during pan (adopt the AmbienceLayer pattern). (A1)
6. **HexBackground → same treatment** (canvas or CSS background-position);
   move the `gardenBreathe` washes onto composited transform/opacity of
   pre-rasterized layers. (A3)
7. **VoicesLayer split.** Derive chips in world coordinates event-driven;
   position via a single transformed container (chips use `transform:
   translate`, not `left/top`); cull with `visibility`/opacity, never
   unmount; drop the per-chip backdrop-filter or rasterize it. (A2)
8. **Kill the mousemove forced layout.** Track say-bubble bounds in refs
   (update on mount/expiry/viewport change) or cache rects once per rAF;
   never `getBoundingClientRect` inside the mousemove handler. (A4)
9. **Pan gating.** On RF `onMoveStart` (and while the edge-scroll ticker is
   active): suppress hover arming, drop any open hover card, and engage the
   existing `fleet-calm` class to pause pulse animations; release on
   `onMoveEnd` (+small settle delay). (A5, A6, C3)

### Phase 3 — Break the double-render/rediff chain (difficulty 7/10)

10. **Decouple live fields from node rebuilds.** Push per-agent live fields
    (state, status) into React Flow via `updateNodeData` per changed agent —
    or key the `nodes` memo on a content hash — so one agent's flip doesn't
    re-mirror the whole controlled arrays. Memoize `layoutKey`. (B3)
11. **Cache edge objects by key** in `buildEdges` so unchanged edges keep
    identity across rebuilds; dedupe `debugInfo` by content. (B5)
12. **Hoist inline RF props** (`fitViewOptions`, `proOptions`, `panOnDrag`,
    MiniMap `style`) to module constants.

### Phase 4 — Scale headroom to 100 (difficulty 6/10)

13. **Viewport culling.** Enable `onlyRenderVisibleElements` (ids/positions
    are stable so remount churn is bounded) — verify no pop-in regressions on
    fast pans; if RF's culling fights the terrain twins, do manual
    LOD-nulling instead.
14. **Zoom LOD at the JSX level.** Below thresholds, terrain units render
    polygon + color only (no text/badge SVG stack); station cities cap tile
    count. The `showName`-style flags exist but only engage at extreme zoom
    (`FleetTerrainLabelNode.tsx:227-228`) — tighten them.
15. **Message pulses on the ambience canvas.** Replace the 3-SVG-element
    per-message `offset-path` animation with dots drawn in the existing
    single-rAF ambience loop (already viewport-aware, already governed). (C2)
16. **Store hygiene at scale.** Precompute per-station quantized heat at write
    time (kill the O(all-heat) selector); prune `peerAgentPings` in the sweep;
    ring-buffer the pulse arrays.

### Phase 5 — Verify (with the fake-LLM harness)

- Drive 10 agents of chatter via the fake LLM server; CDP performance trace
  while panning; React Profiler commit counts before/after each phase.
- Acceptance: pan at 60fps with sustained traffic; store set() rate ≤ display
  rate; zero mount/unmount events during a pan gesture.
- Then a synthetic 100-agent fixture (seed script) for the Phase 4 targets.
- After all phases: decide whether to emit local `message_routed` (functional
  gap above) now that the pipeline can absorb it.

**Overall difficulty: 7/10.** Phases are independently shippable and each is
verifiable in isolation; the riskiest surgery is Phase 3 (controlled-state
rewiring) and Phase 13 (culling side effects).

## Status (2026-07-21): implemented and verified

All five phases landed on `perf/fleet-map-100` (Phases 1–4 plus a fix pass from
adversarial review). Phase 4's culling ultimately shipped as an owned overscan
pass (`data.culled` + hollow shells) instead of `onlyRenderVisibleElements`,
which would have collapsed minimap bounds and fly-to targets.

Measured on a 120Hz display (ideal frame 8.3ms), live app, fake-LLM traffic:

| Scenario | p50 | p95 | max | >33ms | longtasks |
|---|---|---|---|---|---|
| 10 agents, traffic + continuous pan | 8.3ms | 10.1ms | 10.4ms | 0 | 0 |
| 100 agents, traffic + continuous pan | 8.3ms | 9.9ms | 24.3ms | 0 | 0 |
| 100 agents, post-fix regression window | 8.3ms | 9.2ms | 25ms | 0 | 0 |

Memory stable over a 3-minute 100-agent traffic soak (GC reclaims to ~30MB).
Full feature sweep passed: hover cards, selection + command bar, station
select/readout, drag moves, LOD tiers, minimap integrity, fly-to onto culled
areas, say bubbles at viewport edges, busy-state display, calm-mode recovery.
