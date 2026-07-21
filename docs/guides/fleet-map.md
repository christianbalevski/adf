# Fleet Map

The fleet map is ADF Studio's RTS-style command surface for your agent fleet. Every agent in your tracked directories appears as a unit on a hex-tile world: tracked folders become territories, subfolders become districts, messages travel visible traces between tiles, and the channels connecting your fleet to the outside world stand as stations on the perimeter. You select agents like units, command them with hotkeys, and answer their approval requests without leaving the map.

Open it with the hexagon button in the toolbar (currently titled **Age of Agents**). The map requires the mesh — if it isn't enabled yet you'll get an **Enable Mesh** button instead of the world.

## Overview

The map is built for standing fleets: dozens of agents across folders, some running, some parked, some waiting on you. Its design borrows deliberately from real-time strategy games:

- **Single click selects, double-click opens.** Selection never moves the camera unless you ask.
- **Marquee, control groups, and batch commands** work on many agents at once.
- **Alerts come to you** — a "Needs you" queue pings when an agent blocks on your input, wherever you're looking.
- **Geography is stable.** Agents keep their hexes across sessions; growth appears at the edges instead of reshuffling the world.

The map polls fleet status every 5 seconds and streams live events (messages, tool calls, state changes) between polls. Accumulated telemetry — trace heat, token burn totals, and the world's geography — is saved to app settings every 60 seconds and when you close the map, so the world survives restarts.

Press `?` at any time for the built-in keyboard command card.

## The map at a glance

| Element | What it is |
|---------|------------|
| **Territory** | A tracked folder — a contiguous landmass of tinted hexes, one hue per folder |
| **District** | A subfolder — a distinct plot on the same landmass, in a shifted shade of the folder's hue |
| **Agent tile** | One hex per agent: icon, name + state dot, a live line (the current tool call while active, the status quote otherwise), token burn, and a context-window gauge. Dashed/grey when offline (a "ghost"). Detail text appears as you zoom in |
| **Station** | A perimeter platform: one per configured channel adapter (Telegram, email, Discord…), plus the web gateway and one per discovered peer runtime |
| **Trace** | A message route along the hex lattice — accumulates heat with traffic |
| **Street** | On a peer platform: the persistent last hop from the platform gate to a recipient tile |
| **Top bar** | Doubles as the window titlebar: app navigation (Home / map / Settings) and the agent count. While an agent file is open, the title becomes that agent's identity cluster (icon, name, state, status) — click it to fly to the tile, or the ✕ beside it to close the agent (the side panel and status bar return to the fleet). The open tile also wears a blue corner badge, and the bottom status bar leads with the same name |
| **Map controls** (bottom left) | Zoom, fit view, `?` shortcuts, full screen (F — the real thing, not windowed), and the Log drawer |
| **Alert bar** | Fleet state counts, token burn, tool/message rates, named-group chips, the "Needs you" queue |
| **Left rail** | Stewards panel (group voices) and the burn leaderboard |
| **Lens legend** (top right) | Explains the active lens coloring; hosts the lens cycle button |
| **Command bar** (bottom center) | Batch commands for the current selection |
| **Minimap** (bottom right) | Overview with state colors; needs-input beats state so alerts stay visible zoomed out |

## Reading the map

### Agent states

Under the default **terrain** lens, each tile's color is its live state:

| Color | State |
|-------|-------|
| Warm yellow | **Active** — working right now |
| Green | **Idle** — ready |
| Red | **Error** |
| Grey, dashed | **Offline** — not started (a ghost tile; hover it for a start button) |
| Amber ring / amber tile | **Needs your attention** — a pending approval or question |

A tile waiting on you goes amber under *every* lens — an agent that can't proceed without you outranks whatever metric you're looking at — and its text layer carries a `!` badge.

### Tile anatomy

Each occupied hex is a unit plate, and its text adapts to zoom — icons and state lighting read from orbit, names join at mid zoom, and the detail lines appear once you're close enough to read them:

- **Name + state dot** — the dot doubles the state encoding (color fill alone shouldn't have to carry it); it pulses while the agent works.
- **The live line** — an *active* agent shows the tool call it's executing right now (`▸ fs_write reports/patrol-log.md`); everyone else shows their status line, wrapped onto up to two lines.
- **Burn** — lifetime Σ tokens plus live rate (`Σ 16.3M · 37.3k/m`) when the agent has consumed any.
- **Context gauge** — a thin bar showing how full the agent's context window is against its auto-compact threshold: green, then amber past 60%, red past 85%. When it fills, the agent compacts.

The model id lives in the hover card and the readout (and has its own lens) rather than on the tile.

### Lenses

Lenses recolor the same geography to answer different questions. Press `L` to cycle, or click the lens name in the legend (top right). The legend swaps its key to match the active lens.

| Lens | Colors by | Notes |
|------|-----------|-------|
| `terrain` | Live state (default) | The everyday view; voices show by default |
| `burn` | Token heat per agent | Log scale, cold blue → hot red; the hottest tile pulses |
| `model` | Which LLM runs each hex | One hue per model; legend lists models with counts |
| `health` | Where the problems are | error / needs you / held / offline / fine |
| `lineage` | Agent dynasties | One hue per family, darkest = founder, lighter = younger generations; dashed = broken chain or offline; solo agents stay neutral |

Foreign runtimes keep their allegiance hue under every lens (see [Foreign runtimes](#foreign-runtimes)) — you always need to know whose agents you're looking at.

### Voices

Voice chips are floating group-status lines over each territory — what the folder is collectively working on. They're on by default for the terrain lens and hidden on the diagnostic lenses; press `V` (or the **voices** pill in the alert bar) to override either way. Changing lens resets the override to automatic.

The chip speaks with the group's **steward** if one is appointed, otherwise with the most recently active member. Clicking a chip opens the full [group readout](#group-readout).

### Traces and streets

Messages don't fly in straight lines — they travel **circuit-style traces routed along the hex lattice**, with a rounded bend, plugging into tile borders like traces meeting component pads. Routes are deterministic per pair of cells, so busy corridors stack into visible trunks.

- **Heat.** Every delivered message heats its trace. Heat is log-scaled by volume and decays over a ~4-hour window (never fully vanishing inside it), so the fleet's communication backbone builds up visibly rather than evaporating between bursts. Heat persists across sessions (7-day retention).
- **Direction.** Traces are shared per pair; an **arrowhead marks each end that receives traffic**, and a solder-pad dot marks an end that only sends.
- **Live pulses.** Each message replays a bright packet animation along the trace.
- **Selection lights the web.** Selecting an agent accents every trace touching it — its whole communication web — and those traces survive far-zoom culling. (At territory-overview zoom, faint traces are culled to near-invisible so trunks stay legible.)
- **Channel edges.** An agent holding an open WebSocket to the outside renders a dashed line to the web gateway — "has a live connection out" is a different statement than "sent a request".
- **Streets.** On peer-runtime platforms, delivered cross-runtime messages leave persistent **delivery streets** from the platform gate to the exact recipient tile, with the same heat/decay semantics. Trunk to the settlement, streets to the door.

Lineage is *not* drawn as permanent lines — use the lineage lens. Only live traffic draws edges.

### Say bubbles

When an agent ends a turn with plain text, its words pop up over its tile in a comic-style bubble for up to ~75 seconds. Bubbles are **pointer-transparent** — clicks and drags pass through to the tiles beneath — except for their ✕ dismiss button. Hover cards and the cursor-hex highlight politely stay quiet while your pointer is reading a bubble.

### Serving badges

An agent serving a website carries a 🌐 corner badge — click it to open the page. Remote agents on peer platforms get the same badge; their link opens on the runtime URL the peer was actually discovered at.

## Selecting and commanding

### Selection

| Action | Effect |
|--------|--------|
| Click a tile | Select it (camera stays put) |
| ⇧-click | Add or remove from the selection |
| Left-drag on open ground | Marquee select |
| `A` | Select all running agents |
| `Esc` | Clear selection |
| `Space` | Jump the camera to the selection (or fit the whole world) |

Right- or middle-drag pans; two-finger scroll pans; pinch or ⌃/Ctrl-scroll zooms; `+`/`-` zoom from the keyboard; arrow keys pan. In full screen (`F`), parking the cursor at a screen edge pans the camera RTS-style (edge scrolling is fullscreen-only — in a window the cursor constantly exits past the edges and it would misfire).

### Control groups

Session-scoped, StarCraft rules:

| Keys | Effect |
|------|--------|
| ⌘1–9 | Assign the selection to that group (replaces) |
| ⇧1–9 | Add the selection to the group |
| 1–9 | Recall the group — selects **without moving the camera**, so you can command one group while watching another |
| 1–9, tapped twice quickly | Recall *and* jump the camera to it |

For groups that should outlive the session, use **More ▾ → Save as group…** in the command bar. Named groups persist in settings and appear as chips in the alert bar (collapsing into a dropdown when you have more than three); click one to select and fly to its members, ✕ to forget it.

### The command bar

Selecting any agents raises the command bar at the bottom:

| Command | Effect |
|---------|--------|
| **Open** (single selection) | Open the agent's document and right panel |
| **Details** (single selection) | Full agent readout (same as `I`) |
| **Fly to** | Center the map on the selection |
| **Start** | Start the selected offline agents |
| **Stop** | Shut down the selected running agents |
| **Hold / Resume** | Hold: the current turn finishes, then triggers queue until resumed. Resume: queued triggers fire immediately |
| **Message** | Open the composer — the message is delivered into each selected agent's inbox over the normal mesh rails. Messaging offline agents boots them |
| **More ▾ → Hibernate** | Only timers wake them |
| **More ▾ → Wake** | Leave hibernate, then nudge each agent with a real user turn to continue its work |
| **More ▾ → Restart** | Stop, then start |
| **More ▾ → Halt** | Abort the current turn *and* hold — the strong "stop what you're doing" without killing the process |
| **More ▾ → Steward of …** | Appoint the single selected agent steward of its folder, a parent, or the tracked root (see [Stewards](#stewards)) |
| **More ▾ → Move agents / group / territory…** | Click-to-place moves (see [Moving things](#moving-things)) |
| **More ▾ → Reset layout** | Forget every manual move and re-pack the world automatically |

### Command hotkeys

With a selection active:

| Key | Command |
|-----|---------|
| `M` | Message the selection |
| `H` | Hold / resume (toggles against live status, so a quick H-H round-trips correctly) |
| `G` | Go — start the selected offline agents |
| `S` | **Halt** — abort the turn + hold. The unit stays alive |
| ⇧`S` | **Stop** — process shutdown. Deliberately behind Shift so a mashed reflex key can't kill agents |
| `Enter` | Open the focused agent |
| `I` | Inspect — full readout for the focused (or single selected) agent |

Two more RTS staples:

- **Right-click a tile** to open the message composer addressed to that agent (right-*drag* still pans).
- **Double-click a tile** to open the agent's document plus the right panel. The panel keeps whatever tab you were on — only the agent context swaps.

### Cycling: `.` and `,`

- `.` — jump to the **next agent needing you** (pending approval or question).
- `,` — jump to the **next idle agent** (the RTS idle-worker key).

Both center the camera *and* select the agent, so your command keys (M/H/G/S) work the moment you arrive. If the approval modal is open, `.` advances it through the queue — the modal's content follows the cycle.

## Moving things

Tiles are movable, and the map uses the RTS building-placement idiom: while you drag, a hex **ghost** previews every cell the move would claim — **violet when the drop is legal, red when any target cell would land on an agent outside the moving set**. An illegal drop flashes the red ghost for a beat and snaps everything back; moves are all-or-nothing, never half-applied.

| Drag | Moves |
|------|-------|
| Drag a tile | Just that agent (or every selected agent, if you drag one of a multi-selection) — each gets a solo pin on its dropped hex |
| ⌥-drag a tile | Its whole **group** (district — the subfolder plot) rigidly |
| ⌘-drag a tile | Its whole **territory** (the tracked root) rigidly |
| Drag a station by its pads | Re-pins the platform to the dropped cell |

If dragging is awkward (deep zoom, trackpads, precision moves), use **More ▾ → Move agents… / Move group… / Move territory…** instead: the ghost follows your cursor hex, a click places, `Esc` cancels. Same rules, same ghost.

### Frozen geography

Layout is deterministic *and* frozen. The map remembers:

- **Region origins** — where each territory sits on the world lattice. A territory never moves because a neighbor grew.
- **District anchors** — where each subfolder plot sits within its region. One district growing never re-packs its siblings.
- **Cell pins** — the exact hex you founded or dragged an agent to.
- **Station pins** — where each platform stands.

All of this persists in settings across sessions. New agents take the tail of their district's spiral, so growth appears at the edge instead of reshuffling the cluster. New territories pack into free space without moving anyone.

A few consequences worth knowing:

- **Districts can become exclaves.** ⌥-drag a district out into open water and it stays there as a separate island — still wearing its family's tint, still part of the same folder.
- **Stations resolve conflicts politely.** If a returning peer runtime finds its old ground claimed, the loser bumps along a spiral to the nearest clear ground *without* rewriting its pin — when the occupant leaves, the displaced station simply returns home. A user-dragged pin outranks a frozen auto-slot, which outranks a new arrival.
- **Reset layout** (More ▾) wipes every pin, anchor, and origin: the world re-packs automatically from scratch, and the new automatic geography freezes again.

## Founding agents

Double-click empty land to found a new agent there — city-style. An inline naming card appears on the hex; **Enter creates, Esc (or clicking away) abandons**. The newborn is pinned to the clicked hex, and on creation its document and loop panel open so you can brief it immediately.

*Where* you double-click decides *which folder* the agent is created in:

| Click location | Result |
|----------------|--------|
| Empty hex inside a district | Agent created in that subfolder |
| Empty hex on the capital (root-level land) | Agent created in the tracked root |
| Open ocean near a coastline | A **new group**: the name creates a new subfolder under the nearest territory's root. A plain name founds a group of the same name; `group-name/agent-name` names both explicitly |
| Far ocean (well clear of every coastline — roughly 3–4 hex rows) | A **brand-new tracked root**, created beside the nearest existing root and auto-tracked — its own territory |

Names may contain `/` anywhere to nest freely (`research/scout-1` creates `research/scout-1.adf` under the target folder).

## Approvals on the map (HIL)

When an agent blocks on a tool approval or a question, the map makes sure you can't miss it and can answer from wherever you are:

- The tile goes **amber under every lens**, with a pulsing ring and a `!` badge; the minimap paints it amber too.
- The **"Needs you" queue** appears at the right of the alert bar — `handle wants tool` or `handle asks` chips. When the queue *grows*, it flashes an amber ring (the RTS alert ping) so new requests register even while you're watching elsewhere. Two or fewer show inline; more collapse into a dropdown.
- Press `.` to cycle through agents needing you.

### Answering inline

At close and medium zoom, the tile carries a compact **pending card**:

- **Questions** (`ask`): the question plus a text field — type and send right on the map.
- **Approvals**: the tool name, the agent's stated reason (its `_reason`, clamped to two lines), and Approve / Always approve / Reject-with-feedback controls, plus a "view full context" link.

Clicking the card's dead space (anything that isn't a button or input) opens the full-context modal. At far zoom the card isn't rendered — there, a single click on an amber tile opens the modal after a beat (a double-click still wins and opens the agent instead).

### The full-context approval modal

The modal is the map's tool inspector — the decision shouldn't be made off a tile-sized summary:

- Who wants what: agent icon, handle, tool name, file path.
- The agent's stated **reason**.
- The **complete arguments**, formatted for judgment rather than parsing: string values read as prose, scalars get a tint, nested structures fall back to pretty-printed JSON.
- **Approve**, **Always approve**, or **Reject with feedback**.
- **Open agent** jumps to the agent's document and loop — the approval stays pending.

Closing the modal (Esc, ✕, click-away) does **not** resolve the approval — it just returns you to the map. With the modal open, `.` advances it to the next pending agent.

**Always approve** removes the HIL gate for that tool on that agent (the tool becomes enabled and unrestricted in its config), then approves the pending call. Use it when you've decided the tool no longer needs a human in the loop — it's a config change, not a one-off.

## Readouts and cards

### Hover cards

Hovering a tile or station arms a preview card after **550ms** (so sweeping the cursor across the map doesn't strobe cards). Leaving the hex fades the card on a short grace timer rather than instantly — you can travel your pointer *onto* the card and click it. Hover cards yield to an open approval card on the same tile, and never appear mid-drag.

### Agent readout

Press `I` (or click **Details**, or click through the hover card) for the full single-agent readout — the deep-dive modal for one local agent.

### Group readout

Click a voice chip to open the group readout: the complete (untruncated) group status line, who's speaking (steward or voice), cluster vitals (online, active, errors, need-you, Σ tokens, burn rate, last activity), and the member roster. **Members sort working-first: needs-you → errors → active → idle → offline, alphabetical within each band** — a 90-ghost folder can't bury the two agents actually doing things. Clicking a member flies to it.

### The alert bar

Under the top bar, always on:

- **State counts** — active / idle / error / offline dots.
- **Fleet burn** — Σ tokens this session plus live in/out tokens per minute (5-minute window).
- **Rates** — fleet tool calls and agent-to-agent messages per minute.
- **Hottest burner** — the agent with the highest current burn; click to fly there.
- **Named group chips** and the **Needs you** queue, described above.

### Stewards

A steward is one agent per directory whose status line speaks for the whole group — on voice chips, in the stewards panel (left rail), and in group readouts. Select a single agent and use **More ▾ → Steward of …**; an agent can steward any level of its ancestor chain (its own folder, a parent, or the tracked root), so nested fleets get a voice at every layer.

Appointment is delivered as a real owner message over the normal chat rails: the agent is charged to survey its group with `agent_discover`, distill a group status via `sys_set_meta`, and keep it fresh on a recurring timer. Relieving a steward sends the matching stand-down order. Offline stewards are started first so the orders land; the appointment itself persists in settings either way.

## Foreign runtimes

Other ADF runtimes discovered on your LAN appear as **satellite platforms** on the perimeter ring. Each platform renders **one tile per remote agent** — another machine's runtime reads as a settlement, not a monolith. (If the peer's directory is unreachable, you get a plain platform and an amber "directory unreachable" status instead.)

How to read a peer platform:

| Signal | Meaning |
|--------|---------|
| **Violet** ground/border | A runtime sharing **your owner identity** — the player color, same violet as your selection and message pulses. Yours-at-a-glance; no caption needed |
| **Cool blue hue** | A foreign runtime — one deterministic hue per runtime (the legend lists them under "foreign runtimes"), never colliding with your warm folder palette |
| **Dashed perimeter** | Not controllable from here — whatever the hue says about allegiance, this base takes no orders from this window. Your local territories draw solid borders |
| **Green corner dot** on a tile | That agent's card signature verified |
| **🌐 corner badge** | The agent serves a site; click opens it |
| **"owned by …"** caption | Verified owner attestation. `name · unverified` marks a self-claim |
| **Green / amber status dot** | Directory reachable (agent count known) vs not |

Hovering a remote tile arms its card on the same 550ms contract as local tiles; clicking pins the full card readout. Clicking the platform itself opens the runtime readout (alias, owner, agents, traffic).

Cross-runtime messages fly the map trace to the platform's gate, then a bright last-hop connector sweeps to the exact recipient tile — and leave a persistent [delivery street](#traces-and-streets) behind.

Channel stations (Telegram, email, Discord, the web gateway…) hold fixed compass slots around the fleet so starting a new adapter never re-deals the ring. Busy channels **annex extra pads** like a growing settlement — tiles accrete at traffic thresholds and dissolve as the channel goes quiet. All stations can be dragged by their pads to a new spot, which they keep.

Clicking any station **selects** it — the platform rings in violet and every trace and channel link plugged into it lights up, so "who uses telegram?" is one click. Adapter and gateway stations pin their stats card on click; clicking the card opens the full station readout (health, traffic ledger, and the agents that use it, click-through to their readouts). Esc or clicking elsewhere clears the selection.

## Keyboard reference

The authoritative in-app list is the `?` command card. On Windows/Linux, ⌘ / ⌥ / ⇧ read as **Ctrl / Alt / Shift** — the commands accept both modifiers everywhere; only the labels differ.

### Camera

| Keys | Command |
|------|---------|
| ↑ ↓ ← → | Pan the map |
| Right- or middle-drag | Pan |
| Scroll | Two-finger pan · pinch or ⌃/Ctrl-scroll to zoom |
| `+` `-` | Zoom in / out |
| `Space` | Jump to selection / fit world |
| `F` | Full screen — cursor at edge pans |

### Selection

| Keys | Command |
|------|---------|
| `A` | Select all running agents |
| ⇧ click | Add or remove from selection |
| Drag | Marquee select |
| ⌘1–9 | Assign control group |
| ⇧1–9 | Add selection to group |
| 1–9 | Recall group · tap twice to jump there |
| `Esc` | Clear selection |

### Command

| Keys | Command |
|------|---------|
| `M` | Message the selection |
| `H` | Hold / resume |
| `G` | Start selected (offline) |
| `S` | Halt selected — abort turn + hold |
| ⇧`S` | Stop selected (shut down) |
| `Enter` | Open focused agent |
| `I` | Inspect — full agent readout |
| Double-click | Open agent + panel |
| Right-click | Message that agent |

### Move

| Keys | Command |
|------|---------|
| Drag tile | Move agent to a free hex (stays there) |
| ⌥ drag | Move its whole group |
| ⌘ drag | Move its whole territory |
| Drag base | Move a runtime or channel platform |
| Double-click land | Found a new agent on an empty hex |

### View

| Keys | Command |
|------|---------|
| `L` | Cycle lens (terrain · burn · model · health · lineage) |
| `V` | Toggle voices (group status chips) |
| `.` | Next agent needing you |
| `,` | Next idle agent |
| `?` | Keyboard command card |

`Esc` peels one layer at a time: an open founding card, then move mode, then the command card, then full screen, and finally focus + selection.

## Related

- [Messaging](messaging.md) — the mesh rails fleet messages travel on.
- [LAN Discovery](lan-discovery.md) — how peer runtimes end up on your perimeter.
- [Agent States](agent-states.md) — hold, hibernate, error, and the rest of the state model.
- [Serving](serving.md) — what the 🌐 badge points at.
