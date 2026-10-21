# Multi-runtime Studio

Status: implemented. Step 2 of [#149](https://github.com/christianbalevski/adf/issues/149) (phase 1 of [#148](https://github.com/christianbalevski/adf/issues/148)). Phases 1 to 4 (§10) are built; §13, §14, §15 and §16 record how they meet the code. Step 1 is [agent-windows.md](agent-windows.md).

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are used as in RFC 2119.

Read with: [agent-windows.md](agent-windows.md) (window and session map, `ctxFor`), [settings-scopes.md](settings-scopes.md) (Connections page, runtime indicator, remote-mode rules), [remote-access.md](remote-access.md) (device tokens, pinning), [studio-backend.md](../guides/studio-backend.md) (the switch this design removes), [daemon-backend.md](daemon-backend.md) D5 (client sessions).

## 1. Scope

### 1.1 Goals

- Studio holds one connection per runtime in its runtime set: This computer, plus each saved connection. Windows are views on those connections.
- The main window shows the agents of every runtime. An agent window shows one agent of one runtime.
- An unreachable runtime affects only its own agents and surfaces.
- With This computer only, Studio is the Studio of today: same UI, same IPC traffic, same files.

### 1.2 Non-goals

- Per-agent sharing, access grants, client DIDs, the ledger ([#148](https://github.com/christianbalevski/adf/issues/148)). §11 says how this design leaves room for them.
- Studio relaying messages between runtimes. Agents on different runtimes reach each other through their runtimes' mesh, as today (#148 open question 2).
- Moving or copying an agent from one runtime to another.
- Inside Studio (legacy) in the runtime set. It stays a whole-Studio mode (§7.2).
- Any change to `adf` or the terminal app. Each `adf` command still targets one runtime (`--remote`, `ADF_REMOTE`, the `default` in `cli-remotes.json`). Nothing in this design requires Studio.

### 1.3 Terms

- **Runtime set**: the runtimes Studio connects to: This computer, plus every saved connection (§3.1).
- **Runtime id**: the connection id of settings-scopes.md §5.4: `local`, `remote:<name>` (a saved connection in `cli-remotes.json`) or `remote` (the one connection without a fingerprint in `studio-backend.json`).
- **Multi-runtime**: the runtime set has more than one entry. A runtime in the set counts while it is down.
- **Runtime name** (owner decision 2026-10-21): the local runtime (`local`) is shown as `<runtime name> (Local)`, e.g. "laptop-1 (Local)". The runtime name is the runtime alias (Settings → Identity), else the computer's host name (`local-runtime-name.ts`); with neither, "Local". A remote runtime is shown as its saved name with the remote icon (tooltip "Remote"), never "(Remote)". Text-only places (window titles, OS notifications, menus) show the name alone. `local` stays the id and what users type (`adf remotes use local`).
- **Agent ref**: `{runtimeId, agentId, filePath}`. Two refs name the same agent when the runtime ids are equal and the agent ids are equal; when either agent id is null, when the file paths are equal under that runtime's path rule (`samePath(a, b, kind === 'remote')`).

### 1.4 User-visible behaviour

| Surface | This computer only | Multi-runtime |
|---|---|---|
| Sidebar, Go to Agent | Tracked folders, as today | One group per runtime, headed with its name and, while down, its state; tracked folders inside |
| Mesh view | As today | One region per runtime, labelled with its name (§6.4) |
| Status bar | One unnamed group: `( [Mesh] [Kill] )`, a problem in the state's words | One group, the open agent's runtime: `( [name] [Mesh] [Kill] )`, and a **Runtimes** popover of every runtime with Kill all (§6.2) |
| Approvals bell, toasts, OS notifications | As today | One list; each row and notification carries its runtime's name (§6.1) |
| Settings | Runtime pages unheaded | Group heading **Runtime** with a picker of runtime names; the picked runtime's name on each runtime page (§6.3) |
| Agent window title | Agent name | Agent name · runtime name |
| Connections | One row, **Add** (SimpleConnections) | One row per runtime, found computers, **Add** (§6.5) |
| Add | Pairs, then connects; no restart | Same |

UI copy MUST NOT describe the runtime set as additive or explain that This computer stays connected. Labels are one word (**Add**, **Remove**, **Runtime**, **Runtimes**), with a tooltip at most.

### 1.5 Before and after

Before: Studio runs agents on This computer or on one other computer. Choosing box-1 in Settings → Connections asks to switch, lists what stops, and restarts Studio. Afterwards the agents of this laptop are gone from Studio until the next switch and restart. To watch both, the owner runs a second Studio with `ADF_INSTANCE`.

After: the owner adds box-1 (**Add**, then the code shown on box-1). Nothing restarts. The sidebar now shows two groups, laptop-1 (Local) and box-1, and the status bar's **Runtimes** popover shows a Mesh and Kill for each. Approvals from both arrive in one bell, each marked with its computer. An agent window can show an agent of either. When box-1 goes offline, its group says "Not connected, retrying" and its agents grey out; the laptop's agents keep working.

An owner who never adds another computer sees no change.

## 2. Decisions

| # | Decision | Section |
|---|---|---|
| M1 | One `RuntimeConnection` per runtime in the set, created at launch or when a connection is saved, disposed on Remove or quit. Each owns its connector, client, token source, pin check, sessions, bridges, exit watch and failure state. | §3 |
| M2 | Every runtime-scoped invoke, send and push carries a runtime tag as its first argument. No tag means `local`. Local traffic is never tagged. | §4.1 |
| M3 | Handlers are registered once. The registrar strips the tag and serves the call with the context of (sender window, runtime). Handler code is unchanged. | §4.3 |
| M4 | The main window has one client session per runtime in the set. An agent window has one session, on its agent's runtime. | §3.2 |
| M5 | Handler variant (local or remote, channel-map.ts classes) is chosen per call from the runtime's kind in main's table, never from the renderer. | §4.3, §8 |
| M6 | Approvals, notifications and the connection list are aggregated in main. Their pushes are untagged; each entry carries `runtimeId`, omitted for `local`. | §4.2, §6.1 |
| M7 | Agent identity is the agent ref everywhere in the renderer and in main's window, queue, notice and restore maps. | §5 |
| M8 | Names, tags, picker and grouping depend on one selector, `useMultiRuntime()`. | §5.1 |
| M9 | Saving a connection (Studio's **Add**, `adf pair`) connects it; removing it (Studio's **Remove**, `adf remotes forget`) disconnects and forgets it. There is no saved-but-not-connected state. The switch-and-restart flow and `mode-switch.ts` are removed. | §3.1, §6.5, §7.1 |
| M10 | Studio never stops a remote daemon. Background (`keepDaemonRunning`) is This computer's only. | §3.3 |
| M11 | A local-only install's `studio-backend.json` and `studio-client-settings.json` are not rewritten by this change. | §7.3, §9.3 |

## 3. Main process

### 3.1 Runtime set

- The set is `local`, every connection in `cli-remotes.json`, and the `remote` slot of `studio-backend.json` when it holds a URL. Studio keeps no separate list of which connections to use.
- `SavedConnectionsCache` follows `cli-remotes.json`. A connection that appears (`adf pair`, `adf remotes add`, Studio's **Add**) connects at once; one that disappears (`adf remotes forget`, Studio's **Remove**) disconnects, and its agent windows close.
- Order is fixed: `local` first, then the remotes in the order Studio first saw them. `studio-backend.json` gains `runtimeOrder: string[]`, the remote ids in that order. A saved id missing from it is appended, in `pairedAt` order; an id no longer saved is dropped. It is written only when it changes, so it is never written while no remote is saved.

### 3.2 Connection manager

`registerDaemonModeHandlers` (daemon-mode/index.ts) splits into a `RuntimeManager` (Studio-wide) and one `RuntimeConnection` per runtime.

| Part | Today | After |
|---|---|---|
| `DaemonConnection`, connector, `DaemonClient`, token source, pin check, 401 handling (`onUnauthorized`) | One | Per runtime |
| Main window's `DaemonModeSession`, `EventBridge`, `BackgroundEventBatcher`, `ClientSession` | One | Per runtime. Opened when the runtime connects; `exitDaemonWhenClosed` for `local` only, per `keepDaemonRunning` |
| Agent window sessions (`windowSessions`) | Map by webContents id | Map by webContents id, each entry bound to one runtime |
| Exit watch, revive, respawn window (`checkDaemonExit`, `reviveDaemon`) | Local mode | `local` only |
| `ConnectionStatusUi`, turn grace (`TURN_DISCONNECT_GRACE_MS`), `failAllTurns`, `reconnectStreams` | One | Per runtime; acts on that runtime's windows only |
| `RemoteServices` (picker, OAuth relay, upload), `McpOAuthAuthorizeOpener` | Remote mode | Per remote runtime; `local` keeps the direct opener |
| `InstallProgressRelay` | One | Per runtime; pushes tagged |
| `ClientSettingsStore`, `ApprovalsUi`, `NoticeOwners`, menu, `adf-file` handler, quit | One | One, in `RuntimeManager` |
| Local proof (`withLocalProof`), `sharedMnemonic`, `afterOwnerImport`, `reloadCredentials`, remote-access host IPC | Local mode | `local` only |

`RuntimeManager` exposes `runtimes()`, `get(id)`, `sync(saved)` (connect what appeared, dispose what disappeared), `contextFor(windowId, runtimeId)` and `shutdown()`. `RuntimeConnection` exposes what `DaemonModeHandle` exposes today, for one runtime.

### 3.3 Lifecycle

| Event | Result |
|---|---|
| Launch | Every runtime in the set gets a `RuntimeConnection`, started in parallel. The main window loads without waiting for any remote. |
| Connection saved (Studio's **Add**, `adf pair` or `adf remotes add` while Studio runs) | It gets a `RuntimeConnection` and connects. |
| A remote connects | Its token is read from the keychain (`savedConnectionTarget`). A refusal fails that runtime with the existing sentence ("The OS keychain did not give the token for <name>; ..."); the others connect. |
| Remove (Studio's **Remove**, or `adf remotes forget`) | Agent windows of the runtime close and leave the saved list; its sessions end (bounded, `AGENT_SESSION_END_TIMEOUT_MS`); `forgetConnection` (settings-scopes.md §5.3); the `RuntimeConnection` is disposed. |
| Agent window opened | Its session opens on its agent's runtime, as `DaemonWindows.open` today. |
| Quit | Every runtime in parallel: agent-window sessions end first, then the main window's session. `local`: `quit(stopDaemon)` per `keepDaemonRunning` and the remote-access quit question, as today. Remote: `end()`, bounded by `AGENT_SESSION_END_TIMEOUT_MS`; the daemon expires a session that did not end. A remote daemon keeps running. |
| Main window closed (Windows, Linux) | Quit |

### 3.4 Reconnect and backoff

- Each runtime keeps today's loops, with its own timers: the remote connector (2 s doubling to 30 s, `remote/connector.ts`), the client stream (`sse.ts`), the pinned-address check before the token (1 s, `verifyListenerLoop`).
- `powerMonitor` `resume` runs each runtime's `onSystemResume`.
- **Reconnect** on a `failed` runtime disposes its `RuntimeConnection` and creates a new one. Studio MUST NOT restart for it. Before the dispose, that runtime's windows keep their unsaved editor text as recovery copies (`stash-edits`, as `restartKeepingEdits` does today).
- Run Inside Studio for This Session stays offered for `local` only, and restarts Studio (legacy, §7.2).

### 3.5 Auth and token storage

- Unchanged stores: `cli-remotes.json` plus the OS keychain (`ADF` / `remote-token:<fingerprint>`) or `cli-remote-tokens.json`; the `remote` slot in `studio-backend.json` (safeStorage); This computer's `daemon-token` and local proof.
- A runtime reads its token only when it connects (settings-scopes.md §12 item 1). The token stays in that runtime's token source.
- A 401 (other than `/health`) from a remote fails that runtime only, with `refusedTokenSentence`. Other runtimes are not touched.

### 3.6 A runtime that is down

- `connecting`, `disconnected` or `failed` is shown in that runtime's sidebar group header, status-bar group and Connections row, in `CONNECTION_STATE_LABELS` words.
- Its agents stay listed from the last list of this launch, greyed; their actions are disabled with the state as tooltip. A remote that never connected this launch shows its header only.
- Its pending approvals stay listed, disabled, until it answers again; then its snapshot replaces them.
- Its agent windows stay open and show the connection state; their waiting chats end after `TURN_DISCONNECT_GRACE_MS`, as today.
- Failure dialogs (`ConnectionStatusUi`) are shown for `local` only. A remote's failure is a notice and its group state. A remote MUST NOT open a modal dialog by failing.

## 4. IPC

### 4.1 Runtime tag

- The tag is `{ $runtime: '<runtime id>' }`, the first argument. `isRuntimeTag(x)`: a plain object with exactly the key `$runtime` and a string value.
- Preload builds `adfApi` from one factory over `invoke`, `send` and `on`. `window.adfApi` is the `local` facade: it sends no tag, and its `on` delivers untagged pushes only. `adfApi.runtime(id)` returns the same surface bound to `id`: it sends the tag (none for `local`), and its `on` delivers pushes tagged with `id` (untagged for `local`). `adfApi.onAnyRuntime(channel, cb)` delivers every push with its runtime id.
- An agent window's preload reads `runtime=<id>` from its page query (set by main, §5.5) and binds `window.adfApi` to it.
- Main tags a push from runtime `id ≠ local` as `webContents.send(channel, { $runtime: id }, ...args)`.
- Renderer code reaches a runtime through `apiFor(runtimeId)` (`window.adfApi` for `local`).

### 4.2 Channel scopes

`ChannelEntry` gains `scope`, checked by `tests/backend/channel-map.test.ts`:

| Scope | Classes | Count today | Tag |
|---|---|---|---|
| `runtime` | `proxied`, `remote-variant`, `remote-unsupported` | 233 invoke, 17 push | Accepted; pushes tagged |
| `studio` | `local` | 60 invoke, 15 push, 1 send | Refused: the invoke rejects with "This call has no runtime."; a send is dropped and logged |
| `aggregate` | `local`, listed | `APPROVALS_CHANGED`, `CONNECTION_CHANGED`, `WINDOW_AGENTS_CHANGED`, `APPROVALS_REVEAL` | Untagged; entries carry `runtimeId` |

A `local` channel that reads a runtime's state (a `local` entry with `reads`) is reviewed in phase 1 and moved to `runtime` where it acts on one runtime.

### 4.3 Routing

`ctxFor(event)` becomes `ctxFor(event, runtimeId)`:

| Sender | Tag | Context |
|---|---|---|
| Main window, or a sender never registered as an agent window | none or `local` | Main window's `local` context (today's `ctx`) |
| Main window | `remote:…` / `remote` in the set | Main window's context on that runtime |
| Agent window | none, or its own runtime | That window's context |
| Agent window | another runtime | Refused: "This window shows an agent on <name>." |
| Agent window that closed | any | Refused: "This agent window is closed." (sends dropped) |
| Any | a runtime not in the set | Refused: "<id> is not connected." |

- The handler is chosen per call: `(kind === 'remote' ? REMOTE_MODE_HANDLERS[ch] : undefined) ?? DAEMON_MODE_HANDLERS[ch]`, with `kind` from `RuntimeManager`. `ctx.mode` is that kind.
- Pending (`DaemonModeUnavailableError`) handlers are unchanged.
- The main window opens one agent at a time. Main records the runtime of the main window's open file (`mainOpenRuntime`). Opening an agent on another runtime first closes the open file on the previous runtime (`FILE_CLOSE`, tagged), as `useAdfFile.openFile` does within one runtime today.

### 4.4 `adf-file://`

`createAdfFileHandler` `sessionFor(request)` reads `X-ADF-Window` as today and returns that window's session on its runtime: an agent window's own session, the main window's session on `mainOpenRuntime`. The header is still always overwritten by main.

### 4.5 Changed and new channels

| Channel | Change |
|---|---|
| `CONNECTION_LIST` / `CONNECTION_CHANGED` | `ConnectionsView` gains `runtimes: RuntimeView[]` (`{id, kind, name, url, state}`, in the order of §3.1). `current` stays: the sender's runtime (agent window), else `local`. `next` names only a saved mode that differs from the running one (§7.2). |
| `CONNECTION_ADD`, `REMOTE_PAIR_SUBMIT_CODE` | On success the connection is saved and connects (§3.3) |
| `CONNECTION_USE {id}` | `local` or `embedded` only: saves the mode for the next launch (§7.2). Any other id: `not_found` |
| `CONNECTION_REMOVE {id}` | Disconnects and forgets (§3.3); no switch |
| `RUNTIMES_MOVED` (new, `studio` push) | `{moves, replaced}`: ids that are the same computer under another id now, and ids that are another computer. Sent before the `CONNECTION_CHANGED` that follows (§17 item 10) |
| `SETTINGS_SET` | `runtimeFleet` is merged per runtime and per field into what main holds (§17 item 10) |
| `WINDOW_OPEN_AGENT` | Request gains `runtimeId?` |
| `WINDOW_LIST_AGENTS` / `WINDOW_AGENTS_CHANGED` | Entries gain `runtimeId?` |
| `WINDOW_OPEN_SETTINGS` | Request gains `runtimeId?`: the picker starts there (§6.3) |
| `WINDOW_QUEUE_SYNC`, `QUEUE_HANDOVER_*` | Entries gain `runtimeId?` |
| `RECOVERY_STASH` / `RECOVERY_LIST` | Copies gain `runtimeId?`, so a copy is offered on its runtime |
| `APPROVALS_CHANGED` | Each `pending` and `history` entry gains `runtimeId?` |
| `REMOTE_PICKER_REQUEST` | Tagged: the picker browses that runtime |
| `REMOTE_ACCESS_*`, `NETWORK_*` | `studio` scope, This computer's host only, unchanged |

### 4.6 Backward compatibility

- No channel is renamed and no argument shape changes. Every new field is optional, and omitted means `local`.
- With This computer only, main sends no tag and no `runtimeId` field: every push and invoke is byte-identical to today's (§9.1).
- Code that calls `window.adfApi` keeps working and talks to This computer. Phase 2 moves agent-bound call sites to `apiFor(ref.runtimeId)`.

## 5. Renderer state

### 5.1 Runtimes store

- `runtimes.store.ts`: `runtimes: RuntimeView[]` from `CONNECTION_LIST` / `CONNECTION_CHANGED`.
- `useMultiRuntime()`: `runtimes.length > 1`. It replaces `useRemoteConnectionsSaved()` everywhere: the Settings heading, the status bar, Kill's tooltip, every runtime name and the Connections layout. A saved connection is always in the set, so the two conditions are the same.
- `useRuntime(id)`, `runtimeName(id)`, `runtimeDown(id)`.

### 5.2 Agent refs

- `AgentRef` and `agentKey(ref)` (`runtimeId` and `agentId ?? filePath`, encoded so no name can collide) in `src/shared/types/agent-ref.ts`.
- Every map and list keyed by file path today is keyed by `agentKey`. A path is compared only within its runtime.

### 5.3 Stores

| Store | Change |
|---|---|
| `document.store`, `agent.store`, `editor-tabs.store` | The open agent gains `runtimeId` |
| `background-agents.store`, `tracked-dirs.store`, `mesh.store`, `inbox.store` | State becomes `byRuntime: Record<RuntimeId, Slice>`; each tagged push updates its runtime's slice |
| `approvals.store` | One merged snapshot (main aggregates); toasts keyed by `runtimeId` and `id` |
| `fleet.store`, `mesh-graph.store` | `selection`, `controlGroups`, `namedGroups`, `stewards`, `starting`, readouts hold agent keys; burn and baselines per runtime |
| `message-queue.store` | Queues keyed by `agentKey` |
| `open-agent-windows.store` | Entries carry `runtimeId`; `isInAgentWindow` compares refs |
| `connection.store` | Superseded by `runtimes.store`; `runtimeIndicator` takes a `RuntimeView` |

Selectors: `selectRuntimeSlice(state, id)`, `selectAllAgents(state)` (each with its ref), `selectLocal(state)`. Existing components that read the old fields read `selectLocal` until phase 2 moves them.

### 5.4 Grouping

- Multi-runtime only. With one runtime the sidebar, Go to Agent and the Mesh view render as today.
- Sidebar: one collapsible group per runtime, in the order of §3.1, headed with the runtime name; state while down. Tracked folders inside, as today. **Track Folder** acts on the group it is chosen from; the File menu's acts on This computer.
- Go to Agent: results show the runtime name after the agent name.
- The Mesh view: §6.4.

### 5.5 Agent windows

- `WINDOW_OPEN_AGENT {runtimeId, filePath, agentId, name}`. One window per agent ref.
- The page query is `window=agent&runtime=<id>&file=<path>`. Main binds the window's webContents id to that runtime; the query only tells the page.
- Title: the agent name; multi-runtime: `<agent> · <runtime name>`.
- Opening an agent of any runtime from inside an agent window opens that agent's window (`useAdfFile.openFile`), as today.

## 6. Cross-runtime surfaces

### 6.1 Approvals and notifications

- Each runtime's main-window stream feeds its snapshot into `ApprovalsAggregator` in main. The merged snapshot lists pending entries oldest first and history newest first, each with `runtimeId` (omitted for `local`).
- `NoticeOwners` keys by `runtimeId` and notification id. The notice window rule (agent-windows.md §6) compares agent refs.
- `ApprovalsUi` (native notifier, macOS menu bar, reveal) takes the merged snapshot. The badge counts all pending entries. The menu bar's token totals add the runtimes' totals.
- Multi-runtime: each bell row, toast and OS notification names its runtime before the agent (`box-1 · agent-1`). The local runtime is named too (`laptop-1 (Local) · agent-1`).
- Answering resolves through `apiFor(entry.runtimeId)`.
- A runtime's entries that cannot be answered (runtime down) are shown disabled (§3.6).

### 6.2 Status bar

- One group: the runtime of the window's agent (main window: the open agent's, else `local`; agent window: its own). `( [name] [Mesh] [Kill] )`. Mesh and Kill call that runtime (`MESH_*`, `emergencyStop`, tagged). Kill's tooltip: "Stops all agents and mesh on <name>". Kill stays armed while that runtime's mesh runs.
- Name: plain text; remote icon for a remote; state added while down; tooltip the address. Click: Settings → Connections.
- Main window: an up-arrow icon button beside the group (Tooltip "Runtimes"; danger colour while a runtime not shown is down) opens a popover (ContextMenu, anchored above it) listing every runtime in the set's order: name and icon, state, Mesh count, its own Kill. **Kill all** at its top calls `emergencyStop` on every connected runtime at once; its result is shown (summed "Stopped N agents · Mesh off"; "Partial stop · Not reached: <names>" for runtimes down or not answering). Kill results are shown in the group and the row alike. Arrow keys move between the Kills; Escape closes it and focuses the arrow.
- An agent window reaches its own runtime only (§4.1): its group, no arrow.
- This computer only: one group with no name, exactly settings-scopes.md §4.1.

### 6.3 Settings runtime picker

- Multi-runtime: the runtime group's heading is **Runtime** with a picker of runtime names. Every runtime page calls `apiFor(picked)`. The remote-mode rules of settings-scopes.md §7 follow the picked runtime's kind.
- Settings opens on the runtime of the main window's open agent, else This computer. Opened from an agent window (`WINDOW_OPEN_SETTINGS {runtimeId}`), on that window's runtime. The choice is not saved.
- Multi-runtime: every runtime page shows a one-line banner at the top of the page frame with the picked runtime's name and icon. None with This computer only.
- A picked runtime that is down: "Not connected to <name>." and disabled controls, as today.
- Studio pages (Appearance … Connections) are not affected by the picker.

### 6.4 The Mesh view

- One map. Multi-runtime: each runtime's tracked folders form one region, labelled with the runtime name. A region is placed next to the existing ones; its placement is saved per runtime (§7.4).
- Each runtime's fleet poll reports its mesh peers. A peer that is a runtime in the set is drawn as that runtime's region, not as a peer station. Other peers are stations, one per `runtime_id` across all polls.
- A peer is a runtime in the set only when it matches what that runtime's connection checked: its `runtime_did` and the runtime DID read over the connection (`GET /identity`), or its remote access fingerprint (mDNS TXT `fp`) and the fingerprint pinned when the connection was paired (checked by the authenticated hello). An address, a directory listing the map's agent DIDs, or a match in an earlier poll MUST NOT match: any host on the LAN can announce them. The matches are rebuilt every poll; a `runtime_id` matched in one list is that runtime in every list of the same poll. A runtime DID read that fails or returns none is read again after 5 s, doubling to 5 min. An id that RUNTIMES_MOVED reports moved or replaced (§17) loses its DID, its retry and its matches at once.
- A stub whose agent DID is a tile on the map is not drawn. The match runs against the runtime set and tiles of the same render, so a peer that becomes a runtime in the set is never drawn twice; its region, with no saved place yet, takes the cell its station held.
- Edges between agents on different runtimes come only from traffic a runtime reports. Studio MUST NOT forward messages between runtimes. Egress (`toFilePaths: ['station:peer:<runtime_id>']`, `toPeerAgent`) and ingress (`filePath: 'station:peer:<runtime_id>'`, `fromPeerAgent`) with a peer that is a runtime in the set are drawn tile to tile: the `runtime_id` gives the runtime, the agent's DID or handle the tile, looked up within that runtime only. A runtime names the sender of an arrival (`fromPeerAgent`) only when it verified it: the message signature checked against the `from` DID, or a transport that authenticated that DID. An unsigned arrival (allowed by default) is drawn from the peer station; the sending runtime's own egress report draws it tile to tile. When both runtimes report one message, the second report is not drawn (a report waits 15 s for its twin). Traffic with other peers keeps its station, street heat and stub ping.
- Handles in This computer's message log name This computer's agents only; an equal handle on another runtime is another agent.
- Multi-runtime: every region has a solid border in `--ink-faint`; a peer station has a dashed one in the same token and the tooltip "Peer". No reach or allow/block badges, no bridge lines. With This computer only, nothing changes.
- A down runtime's region is greyed with its state.
- Batch commands on a selection are sent per runtime, one call each. A refusal on one runtime is reported; the others proceed.

### 6.5 Connections page

Settings-scopes.md §5 stands, with these rows:

| Row | State | Action | More menu |
|---|---|---|---|
| `<runtime name> (Local)` | Connected (or the state while down) | none | Inside Studio (legacy) |
| A saved connection | Connected, Connecting, Not connected, retrying, Not connected | none | Remove |

- **Add** (owner decision 2026-10-21) is the page's one button. It opens one dialog, titled "Add", with two choices: **Connect** ("Use a runtime on another computer.": the computers found on the network, or an address, then the code; a token under Details; settings-scopes.md §5.3) and **Share** ("Let another computer use this runtime.": remote-access.md §7). Found computers are listed in Connect, not as rows. On success the connection is saved and connects; the dialog shows **Done** only.
- **Devices** under the list: the computers using this runtime, each with **Revoke** (remote-access.md §7).
- Remove: "Removes the address and token from Studio and adf." When the runtime has agent windows or unsaved editor text, the dialog adds "Closes 2 agent windows." Buttons **Remove**, **Cancel**. The switch-first sentence goes.
- With no remote saved the page is SimpleConnections, unchanged.

### 6.6 Menus

- Help: the status line names each runtime that is down. **Reconnect** acts on the runtime that is down; with more than one down, it is a submenu of their names. Open Daemon Log is the local runtime's.
- Open Recent: This computer's files; multi-runtime adds each remote's files under its name (§7.4).

## 7. Upgrade

### 7.1 The switch flow

Phase 4 deletes the switch-and-restart flow for every target, and `mode-switch.ts`:

- Removed: the switch dialog, Switch and Restart, Wait for Them to Finish, Stop Them Now, Finish switch now, Cancel switch, "Restart to connect to <name>.", `createModeSwitcher`, `resumeSwitchedAgents`, `resumesAgents`, `restartingMessage`, `SWITCH_DAEMON_EXIT_WAIT_MS`, `studio-switch-resume.json`, and the backend-settings hooks that call them (`confirmModeSwitch`, `applyModeSwitch`, `pendingSwitch`, `finishSwitchNow`, `cancelSwitch`, `restarting`).
- Moved, unchanged, to `src/main/backend/boot-handover.ts`: what the boot and the embedded backend still use (`runBootHandover`, `showHandoverSummary`, `handoverDeps`, `studioSecretCodec`, `isObfuscationOnly`, `sessionBackendEnv`, `SESSION_BACKEND_ARG`, `runningDaemonOnSettings`, `askVersionMismatch`, `relaunchStudio`, `relaunchEmbeddedForSession`, `isRelaunching`, `notifyDaemonOfHandover`, `syncRuntimeEntryAfterImport`).
- A remote's turns are never interrupted by adding or removing another runtime: they run in its daemon.

### 7.2 Inside Studio (legacy)

- It stays where #171 put it: under Details in SimpleConnections, and in the Local row's More menu.
- It is a whole-Studio mode. The embedded backend code stays; its removal is a later PR.
- Choosing it (or the Local row while it runs) saves `mode`; the page shows "Next launch: <name>." with Restart (`ConnectionsView.next`). Studio does not restart and shows no switch dialog. The boot handover (`runBootHandover`) moves the credentials at the next launch, as it does today. Running agents are not carried across.
- In embedded mode the runtime set is not loaded. Saved connections are listed with no state; they connect at the next launch in This computer mode.

### 7.3 `studio-backend.json`

| Before | After |
|---|---|
| `mode: local`, no saved connection | Unchanged. The file is not rewritten. |
| `mode: local`, saved connections | `runtimeOrder` written (§3.1). Every saved connection connects, including ones paired with `adf pair` and never used by Studio |
| `mode: remote`, `remote.name: X` | `mode: local`, `remote.name` removed, `runtimeOrder` written |
| `mode: remote`, the `remote` slot | `mode: local`, `runtimeOrder` written |
| `mode: embedded` | Unchanged |
| `ADF_STUDIO_BACKEND=remote` | Read as `local` with the saved set; logged |

- The migration runs once, at the first launch of this version, before any connector, and writes atomically: `studio-client-settings.json` (§7.4, §7.5) first, then `studio-backend.json`.
- On the first launch after migrating from `mode: remote`, This computer's daemon starts, with its agents set to start automatically, as on any launch.
- An older Studio reading the migrated file runs This computer only. The remotes stay saved in `cli-remotes.json`.

### 7.4 Client keys

| Key | This computer | Remotes |
|---|---|---|
| `recentFiles` | Unchanged | n/a |
| `remoteRecentFiles` | n/a | Migrated to `runtimeRecentFiles: {<id>: string[]}` under the id of the remote it was written for (the old `remote.name`, else `remote`) |
| `fleetGroups`, `fleetStewards`, `fleetMapState` | Unchanged | `runtimeFleet: {<id>: {fleetGroups, fleetStewards, fleetMapState}}`. On migration from `mode: remote` the plain keys move there, under the old remote's id |
| `runtimeFingerprints` | n/a | `{<id>: <fingerprint>}` of each remote with keys above, written by Studio main; the keys follow that fingerprint (§18 item 4) |

Settings-scopes.md §10's "keyed by connection" items are these.

### 7.5 `agentWindows`

- Shape: `{runtime, windows: [{agentId, filePath, bounds, runtimeId?, fingerprint?}]}`. An entry without `runtimeId` is on `runtime`. A local-only list is byte-identical to today's.
- Migration of a list with `runtime: 'remote:<name or URL>'`: `runtime` becomes `local`, and each entry gets `runtimeId` (`remote:<name>`; a URL equal to the slot's becomes `remote`, any other URL is dropped) and the saved fingerprint.
- Each runtime's entries are checked (`checkSavedAgent`) when that runtime first connects in the launch. Entries of a runtime in the set that does not connect are carried. Entries of a runtime not in the set are dropped. An entry whose `runtimeId` is unknown but whose fingerprint matches a runtime in the set is moved to it.
- "A list saved for another runtime is ignored" (agent-windows.md §7) no longer applies.

## 8. Security

### 8.1 Trust per runtime

- Each saved remote is pinned to its fingerprint. `pinCheck` runs before its token goes out on every new connection (connection.ts). A mismatch fails that runtime only (`PinMismatchError`); the owner removes and pairs again.
- The `remote` slot has no fingerprint ("No fingerprint; identity not checked."), as today.

### 8.2 Token scoping

- A runtime's client sends its token only to its own origin (`DaemonClient`, `ctx.raw`). No handler sends one runtime's token, local proof, response or file to another runtime.
- The local proof is sent to `local` only (`withLocalProof` wraps `local`'s connector only).
- Device tokens keep their limits on the host (remote-access.md §4.5).

### 8.3 A compromised remote

It can:

- show its own agents, approvals, notices and files with any text, in Studio's renderer;
- ask to open a sign-in page (the OAuth relay's confirm names its host), and ask the renderer to browse its own files (remote picker);
- receive what the owner sends it: messages, settings edits on its pages, files the owner uploads to it.

It cannot:

- reach another runtime's sessions, token or agents: its pushes are tagged with its id by main, and main resolves every call's runtime from its own table;
- read files on this computer: every handler that touches the local filesystem, shell or OS (reveal, recents, drag-out, the native pickers) is `remote-variant` or `remote-unsupported` and is chosen from the runtime's kind in main (M5). A path from a remote MUST NOT reach a local-filesystem call;
- change Studio's client settings, the runtime set or the saved connections: those are `studio`-scope calls the renderer makes;
- pass for another runtime in a notification: a connected remote makes Studio multi-runtime, and then every notification carries its runtime's name.

Residual risk: one renderer serves every runtime. A script-injection bug in rendering agent content would give a remote's content the whole `adfApi`, `local` included. Agent content MUST stay rendered as escaped text or sanitized markdown; this design raises the cost of a regression there.

## 9. Testing

### 9.1 Parity harness

- Every existing scenario and recording runs unchanged against the refactored main process. Any diff fails: with This computer only, no tag and no `runtimeId` field appears in a step, push or recording.
- `multiDaemonBackend()` (`tests/parity/harness/`): two built daemon bundles in fenced child processes, each with its own isolated root (`createParityEnv`) and its own loopback port from `env.allowPort`; never 7385. One is `local` (master token, local proof). The other is a remote: remote access on, a device token, a saved connection whose token is in `cli-remote-tokens.json` in the isolated root (`ADF_KEYCHAIN=0`, `ADF_SECRET_STORE=file`). The real keychain is never opened (`@napi-rs/keyring` refused, as today).
- Scenarios under `tests/parity/multi/`: open and chat on each runtime, concurrently, with the mock LLM; approvals from both, answered from the merged list; kill the remote daemon: the local runtime's turn completes and its recording equals the single-runtime one; a 401 from the remote; a pin mismatch (another daemon with another fingerprint on the remote's port); a connection saved and one forgotten in `cli-remotes.json` while Studio runs (it connects; it disconnects); Remove with an agent window open; quit with the remote unreachable stays within budget.

### 9.2 Unit and backend tests

- Tag parsing and the refusals of §4.3, for invoke and send; tagged and untagged pushes in the preload factory.
- `channel-map.test.ts`: every entry has a `scope`; `studio` channels refuse a tag.
- `RuntimeManager`: `sync` on save and forget, fixed order, failed-runtime recreate, quit order and bounds, per-runtime 401, per-kind handler choice.
- `ApprovalsAggregator` and `NoticeOwners` with refs; notification ids equal on two runtimes stay distinct.
- Migrations of §7.3, §7.4, §7.5, including the downgrade read by the previous `parseSavedAgentWindows`.
- Renderer: selectors; `agentKey`; sidebar, status bar, Settings nav and approvals rows rendered with one runtime equal today's snapshots.

### 9.3 "Local-only unchanged" checks

- With no saved connection: no runtime name, picker, group heading or tag in the DOM (sidebar, status bar, Settings, bell, toasts, titles, Go to Agent, Mesh view).
- `studio-backend.json` and `studio-client-settings.json` keep their bytes across a launch and quit of the new version (M11).
- Connections is SimpleConnections.
- `tests/backend/adf-file-window-header.test.ts` (real Electron) still passes.
- A user-testing section (MRT) in [daemon-backend-user-testing.md](daemon-backend-user-testing.md) walks the same on a packaged build.

## 10. Phased PR plan

Difficulty is on a 1-10 scale. Time is agent time.

| Phase | Scope | Risk | Difficulty | Time |
|---|---|---|---|---|
| 1. Connection manager and runtime-aware IPC | `RuntimeManager` / `RuntimeConnection` split of daemon-mode/index.ts; registrar with tags and `ctxFor(window, runtime)`; per-kind handler choice; `ApprovalsAggregator`; channel-map `scope`; preload factory and `adfApi.runtime(id)`; the runtime set from the saved connections, behind a development flag; `agentWindows` and recovery entries with `runtimeId`. No UI change. | High: quit, exit watch, revive, approvals and window routing all move. Parity recordings MUST stay identical. | 7 | 4 h |
| 2. Renderer stores and grouping | `runtimes.store`, `useMultiRuntime`, `AgentRef` across stores and call sites (`apiFor`); sidebar groups, Go to Agent, agent window title, Mesh view regions and peer de-duplication; per-runtime client keys (§7.4) | Medium-high: wide renderer change; local-only snapshots guard it | 6 | 3 h |
| 3. Per-runtime surfaces | Saving a connection connects it; the **Add** dialog; Remove disconnects and forgets; flag removed; status-bar groups and **Runtimes** overflow; Settings picker; bell, toasts and OS notifications tagged; Help menu; multi-daemon parity scenarios | Medium | 5 | 2.5 h |
| 4. Remove the switch flow | Delete the switch flow and `mode-switch.ts`, move the boot helpers (§7.1, §7.2); `studio-backend.json`, client-key and `agentWindows` migrations; guides (studio-backend.md, settings.md, remote-daemon.md), settings-scopes.md §5.3 and §10, user-testing MRT | Medium: migration of remote-mode installs | 4 | 1.5 h |

Overall 7/10, about 11 hours of agent time. Each phase ships alone; phases 1 and 2 change nothing visible.

## 11. Fit with #148

Out of scope here; this design does not block it:

- Every agent-bound call and entry names its runtime, so a per-agent grant (view, interact, admin) attaches to an agent ref without a new identity scheme.
- Credentials are per `RuntimeConnection`. A client DID that answers a runtime's signed challenge replaces that runtime's bearer token without touching IPC or the renderer.
- A runtime that refuses an action under a future grant answers an ordinary error on a runtime-scoped call; surfaces already show per-runtime refusals (§6.4).
- Studio never relays between runtimes (§1.2), so #148 open question 2 stays open.

## 12. Decisions

Owner answers, 2026-10-20:

1. **Upgrade autostart.** No hold. The first launch after migrating from `mode: remote` starts This computer's daemon and its autostart agents as on any launch (§7.3). No new daemon start option.
2. **Adding connects.** A connection saved by Studio's **Add** or by `adf pair` joins the runtime set and connects at once. **Remove** disconnects and forgets it. There is no Paired state and no Connect button (§3.1, §6.5).
3. **Embedded.** Phase 4 deletes the switch-and-restart flow and `mode-switch.ts` (§7.1). The Inside Studio (legacy) backend code stays until a later PR (§7.2).
4. **Kill** is per runtime only (§6.2).
5. **Order** is fixed: This computer first, then the remotes in the order added (§3.1).

## 13. Phase 1 notes

Choices made where this design met the code. Each is the simplest option consistent with §12.

1. **Primary runtime.** Until phase 4 migrates `mode: remote`, an untagged call is served by the runtime the saved mode selects: `local` in local mode, the saved remote in remote mode. Its pushes are untagged. In remote mode the runtime set is that remote only.
2. **Flag.** `ADF_MULTI_RUNTIME=1` puts every connection in `cli-remotes.json` into the runtime set, in local mode only. Without it the set is the primary runtime only. Phase 3 removes the flag.
3. **Order.** Kept in memory for the launch: the primary first, then remotes in the order first seen, those seen together by `pairedAt`, then name (`runtimeOrder`, runtime-manager.ts). `studio-backend.json` is not written in phase 1; `runtimeOrder` is written from phase 3.
4. **Scopes.** `REMOTE_PICKER_REQUEST` and `REMOTE_PICKER_RESPOND` are `runtime`: the request is tagged (§4.5) and the answer settles that runtime's picker. The reviewed `local` entries with `reads` and `MESH_FIREWALL_CHECK`, which reads This computer's firewall, stay `studio`. Counts: `runtime` 234 invoke and 17 push; `studio` 59 invoke, 11 push and 1 send; `aggregate` 4 push.
5. **Studio calls outside the registrar.** The `studio` channels that main/index.ts, the Connections, remote-access, recovery, updater, spellcheck and orbital-cache code register go through `studio-ipc.ts`, which refuses a tag. `channel-map.test.ts` checks this. The embedded backend (ipc/index.ts) reads no tag; it never runs with a runtime set (§7.2).
6. **Preload.** A surface bound to a runtime other than `local` delivers its own tagged pushes and every untagged `studio` or `aggregate` push. It tells them apart with `RUNTIME_PUSH_CHANNELS` (src/shared/constants), which `channel-map.test.ts` keeps equal to the map. An agent window of This computer gets no `runtime=` in its page query, so it loads the URL it loaded before.
7. **Notices.** `NoticeOwners` keys a notice by `<runtime id>
<id>`, the plain id for the primary runtime. The `notify` list of `APPROVALS_CHANGED` holds these keys.
8. **Main window's open runtime.** `mainOpenRuntime` moves to a runtime when a main-window `FILE_OPEN`, `FILE_CREATE` or `FILE_CREATE_QUICK` on it resolves. Closing the open file on the previous runtime first is the renderer's step (`useAdfFile.openFile`, phase 2).
9. **Agent windows.** Restore runs at the primary runtime's first connect, as before. An entry of another runtime is checked on that runtime: kept and not opened while it is not connected, dropped when it is not in the set. Opening such entries when their runtime first connects is phase 3; the fingerprint move of §7.5 is phase 4.
10. **A runtime other than the primary.** It keeps no recent files (local-open grants are This computer's, §8.3), and the fleet map's saved burn totals are not handed to it (per-runtime keys are §7.4, phase 2). Its connector stops when it leaves the set. Reconnect on it when failed replaces its `RuntimeConnection` after its agent windows kept their unsaved text; those windows close, and phase 3 reopens them.
11. **Recovery copies.** A copy of another runtime's agent is kept in a folder whose hash covers the runtime id, with `<folder>.runtime` next to it holding the id.
12. **Harness.** `multiDaemonBackend()` and the `tests/parity/multi/` scenarios come with phase 3, which §10 gives the multi-daemon parity scenarios. Phase 1 tests two and three runtimes against fake daemons (tests/backend/multi-runtime.test.ts); the existing parity recordings are unchanged.

## 14. Phase 2 notes

Choices made where this design met the code. Each is the simplest option consistent with §12.

1. **Condition.** Grouping, runtime names and tags follow `useMultiRuntime()`: the runtime set has more than one runtime, which needs `ADF_MULTI_RUNTIME=1` until phase 3 (§13 item 2). `useRemoteConnectionsSaved()` stays for the Settings heading, the status bar and Connections until phase 3 removes the flag: without the flag a saved connection is not in the set, so the two conditions of §5.1 are the same only from then.
2. **Runtime list.** Main sends `ConnectionsView.runtimes` only while the set has more than one runtime. With one, the renderer's set is the runtime the window uses, under the id `local`. CONNECTION_CHANGED is pushed when the set, its order or the state of a runtime other than the primary changes.
3. **Agent keys.** `agentKey` is the file path on This computer and `<runtime id>\n<path>` on any other runtime, not `agentId ?? filePath`: maps keyed by path keep their keys, and client keys and local storage keep their bytes (M11). Two refs are the same agent by `sameAgent` (§1.3). An agent window shows one runtime; its maps are keyed by path.
4. **Store slices.** In the stores of §5.3 the top-level fields stay This computer's slice (an agent window's: its own runtime's), and `byRuntime` holds every other runtime. `selectLocal` is the store itself. `useRuntimeFeeds` (main window) fills the other slices and makes no call with This computer only.
5. **Open agent.** `document.store.runtimeId` is the open agent's runtime. The agent, editor-tabs and inbox stores hold the open agent only, so they keep one slice; their subscriptions follow that runtime (`openApi()`, `useOpenRuntime()`). Saved editor tabs are keyed by agent key.
6. **Bound surfaces.** A surface bound to a runtime sends Studio-scope calls untagged (`STUDIO_CALL_CHANNELS`, kept equal to the channel map by tests/backend/multi-runtime-phase2.test.ts). One surface then serves a whole agent view, and an agent window of another runtime can make Studio calls. `apiFor('local')` in such a window is the untagged surface.
7. **Call sites.** Calls about the main window's open agent go through `openApi()`; sidebar rows, Go to Agent, the bell and the remote picker call the row's runtime. Settings pages, Home and the status bar stay on This computer until phase 3's picker and status-bar groups.
8. **Bell, toasts and OS notifications.** They name their runtime in phase 2, not phase 3 (§10): the merged list already carries `runtimeId`. The rows of a runtime that is down are shown with their answers disabled (§3.6).
9. **Share.** Share and drag-out are This computer's only: a path of another runtime never reaches a local file call (§8.3).
10. **Recent files.** `runtimeRecentFiles` comes with Open Recent of each runtime (§6.6), in phase 3. A runtime other than the primary keeps no recent files (§13 item 10).
11. **The Mesh view.** A runtime other than This computer is one region rooted at its runtime, one district per tracked folder; its tiles are keyed by agent key. A peer is drawn as a region, not a station, when its `runtime_did` is the DID of a runtime in the set (`getOwnerIdentityStatus().runtimeDid`); a peer without one, or a runtime whose DID could not be read, stays a station. New agents are founded on This computer's land only. Trace heat, routes and street heat that touch another runtime's agents last for the session. The map reads only the tail of a remote's message log.
12. **`runtimeFleet`.** A remote's groups, stewards, burn totals and placement are kept under `runtimeFleet[<id>]` with that runtime's paths; entries of runtimes not in the set are kept. The primary's keys are unchanged, and nothing writes `runtimeFleet` with This computer only. A runtime other than the primary is handed its own saved burn totals (§13 item 10).

## 15. Phase 3 notes

Choices made where this design met the code. Each is the simplest option consistent with §12.

1. **Flag.** `ADF_MULTI_RUNTIME` is removed. In local mode the runtime set is `local`, every connection in `cli-remotes.json`, and the remote slot (`remote`) while `studio-backend.json` holds a URL, unless the slot's paired fingerprint is a saved connection (`runtimeSlot`, connections.ts). Remote mode keeps its one runtime until phase 4 migrates it (§13 item 1).
2. **Connect.** In local mode `CONNECTION_USE` refuses a saved connection and the slot: `not_found`, "Already connected." `local` and `embedded` keep today's switch until phase 4. Remote mode keeps its switch and its rows (Paired, **Connect**).
3. **Names.** The status bar and Settings name runtimes while the set has more than one runtime, or while the one runtime is another computer (remote mode). Connections stays SimpleConnections while `remoteConnectionsSaved` is false: in local mode that equals `useMultiRuntime()`, and it also covers Inside Studio with saved connections (§7.2). `useRemoteConnectionsSaved()` is removed.
4. **Settings picker.** The Settings body is drawn anew for each pick (a React key on the picked id). Runtime pages, and the panels they render (providers, MCP servers, channels, templates, usage), call `useSettingsApi()` (settings-runtime.tsx); outside Settings it is `window.adfApi`. Studio pages read and write This computer, Privacy's two backend keys included; the firewall, platform, spellcheck and `keepDaemonRunning` calls stay This computer's. An agent window's Settings link: main resolves the window's runtime and delivers `settings-runtime:<id>` before the open action.
5. **Status bar.** One group, the window's agent's runtime (`FocusedRuntime`, StatusBar.tsx), and in the main window the **Runtimes** arrow and popover (`RuntimesPopover`, on ContextMenu) with every runtime's row and Kill all (`killAll`). Kill on a runtime that is down is disabled with its state as tooltip. After a Kill only that runtime's slices are reset. Kill results are kept per runtime (`useKillResultsStore`), so the group and the row show the same one. The fold of earlier builds (one group per runtime, folding when the bar overflowed) is gone. An agent window shows its own runtime's group only.
6. **Agent windows.** The primary's restore runs at its first connect, as before. A remote's saved entries reopen when its RuntimeConnection first connects (hook `runtimeConnected`), after the main window first showed; `AgentWindows.restore(runtimeId)` restores that runtime's entries only, and a restore asked for while another runs follows it. Reconnect closes a remote's windows with `keep`, so they stay saved and reopen when the new connection connects. Remove closes them and drops them.
7. **Remove.** The dialog counts the runtime's agent windows only ("Closes 2 agent windows."). Unsaved editor text in the main window is not counted: main does not know it.
8. **`runtimeOrder`.** The initial order is read from `studio-backend.json`; `BackendSettingsStore.setRuntimeOrder` writes it when it differs from the saved one, never while none was saved and the order is empty (M11).
9. **Recent files.** A remote's are kept under `runtimeRecentFiles[<id>]` (menu.ts) and opened through `OPEN_FILE_REQUEST` with `runtimeId`. They never reach the OS recent list, a local-open grant or `existsSync`. A moved file follows (`DaemonModeContext.renameRecentFile`). Clear Menu clears the lists of the runtimes in the set. The migration of `remoteRecentFiles` stays phase 4.
10. **Add.** One dialog for a typed address and a found row; on a found row the hello must show the found fingerprint. `PairDialog` is removed. A token without a fingerprint (the remote slot) joins the set at once (`slotChanged` in connections-ipc.ts); the slot at another address replaces its connection.
11. **Help.** With more than one runtime: one disabled line per runtime that is down (`<name>: <problem>`), then **Reconnect** for one, or a **Reconnect** submenu of their names. With one runtime: today's items.
12. **Open agent.** When the main window's open agent is on a runtime that leaves the set, the renderer resets to Home (`syncRuntimeFeeds`).
13. **Harness.** `multiDaemonBackend()` and the eight scenarios in tests/parity/multi/multi.test.ts (tests/parity/README.md). Deviation from §9.1: the remote daemon runs with remote access off, because with it on a fenced daemon spawns `tailscale`, the firewall probe and the network-category tools, which the fence refuses. Studio reaches it through the loopback proxy that acts as another computer (public Host, X-Forwarded-For, a local proof recorded as a leak); the proxy answers `/remote/hello` with a fixed name and fingerprint only while the daemon behind it answers `/health`. The saved connection's token, in `cli-remote-tokens.json` (`ADF_KEYCHAIN=0`, `ADF_SECRET_STORE=file`), is that daemon's master token, not a device token; a device token needs a test seam with fake tailscale, firewall and network probes in the daemon's RemoteAccessService. The killed-remote scenario compares This computer's recording with the single-daemon one after leaving out repeated application-menu rebuilds and local calls that name the remote (Help names it while it is down, and its notices).
14. **Stop.** The composer's Stop calls `interruptOpenTurn()` (utils/turn-interrupt.ts) through `openApi()`; its test asserts which surface is called and what each answer shows.

## 16. Phase 4 notes

Choices made where this design met the code. Each is the simplest option consistent with §12.

1. **Migration (§7.3).** `runtime-migration.ts`, called from main/index.ts after `migratePairedSlot` and the first read of `cli-remotes.json`, before any connector and before the client settings are loaded. It runs only on a launch of This computer: `resolveBootBackend` reads `mode: remote` as `local`, and a launch Inside Studio (`ADF_STUDIO_BACKEND=embedded`, a session-only launch) leaves the file for the next launch. `ADF_STUDIO_BACKEND=remote` is read as `local` and logged. The connection the file used is `remote:<remote.name>`, else the remote slot (`remote`), else the saved connection the slot's pairing became. `runtimeOrder` starts with it, then the other saved connections by `pairedAt` (`runtimeOrder()`, runtime-manager.ts). The client keys are written first (`migrateRemoteModeInstall`), then `studio-backend.json`; a client file that cannot be written leaves `studio-backend.json` in remote mode. A file that cannot be written (`writeBlocked`, a failed write) is migrated in memory for this launch, said in Settings → Connections ("studio-backend.json still says remote …"), and migrated again at the next launch.
2. **Notice.** One dialog over the main window once it is shown (`showBootNotices`), title "Connections", one sentence: "<name> is in Settings → Connections.", or "<name> is no longer saved; add it again in Settings → Connections." when that connection was forgotten with `adf remotes forget`. It is shown at the launch that migrates, and logged; it is not kept for a later launch.
3. **Client keys (§7.4, §7.5).** Migrated only from `mode: remote`, in `studio-client-settings.json`, written atomically and only when a key changed: `remoteRecentFiles` into `runtimeRecentFiles[<id>]`, the plain `fleetGroups`, `fleetStewards` and `fleetMapState` into `runtimeFleet[<id>]` (only while that runtime has no entry there; only a key copied is deleted), and an `agentWindows` list of `remote:<name or URL>` into `{runtime: 'local'}` with `runtimeId` and the fingerprint on each entry. A list of another URL or of a name not saved loses its entries. While `studio-backend.json` still says remote after the client keys moved, the client file holds `remoteModeMigrated: true` and is not migrated again, so the plain fleet keys This computer writes meanwhile stay its own; the mark goes once `studio-backend.json` says local. A local install that ran remote mode before this version and chose This computer again keeps its `remoteRecentFiles` unread: the file no longer names the connection they belong to.
   - The keys of a runtime that goes go with it: Remove of a saved connection or the slot, the slot replaced by another address (`forgetRuntimeKeysOf`), and, at launch and whenever `cli-remotes.json` changes, a connection no longer saved or saved again as another computer under the same name (`forgetGoneRuntimeKeys`). A connection saved again under another name with the same fingerprint takes them to its new id (from the saved agent windows at launch, from the previous list while Studio runs). Nothing goes while `cli-remotes.json` cannot be read or parsed.
4. **Agent windows (§7.5).** Opening an agent window on a remote saves that connection's fingerprint with it. At every launch `relinkSavedAgentWindows` moves an entry whose `runtimeId` is not in the set to the saved connection with its fingerprint; the list is written only when an entry moves, so a list of This computer only keeps its bytes. Restore is as in §15 item 6.
5. **Connections page.** **Connect** on the Local row or Inside Studio (legacy) saves the mode ("Saved." for the mode this launch runs). The page then shows "Next launch: <name>." with **Restart** (`BACKEND_RESTART_STUDIO`, `relaunchStudio`); <name> is the row's name ("Inside Studio (legacy)"), and no other notice is shown. `CONNECTION_USE` on a saved connection or the slot is `not_found` in every mode. Saved rows have no action; Inside Studio lists them with no state (§7.2). The state `paired` is gone. Remove has no switch-first wording.
6. **Removed with the switch.** `mode-switch.ts`, moved to `boot-handover.ts` with the §7.1 list; `planHandover` (the dialog's plan) and `syncStudioRuntimeEntry`'s `dryRun`; `DaemonModeHandle.agentActivity` and `startBackgroundAgent`; `shutdown`'s `waitForDaemonExitMs`; `BackendSettingsView.pendingSwitch`; the patch fields `switchAction` and `remoteName` and the error codes `switch_cancelled` and `restarting`; `connectionKey`; the remote-mode branches of `buildConnectionsView`, `currentConnection`, `remoteConnectionsSaved`, the status bar, the Settings runtime heading (`runtimeGroupLabel`) and the identity restore banner. A patch with `mode: remote` is refused: "Remote mode is gone; use Add in Settings → Connections."
7. **Kept.** The embedded backend, including `hostActions` in ipc/index.ts, which nothing reads now; it goes with the embedded backend. Reconnect on This computer after a failed launch still restarts Studio, and Run Inside Studio for This Session stays (§3.4); a remote runtime is replaced without a restart (§15 item 6). `RECOVERY_HINT` says Inside Studio applies at the next launch.
8. **Remote primary.** Studio's boot always passes `mode: 'local'` to `registerDaemonModeHandlers`. `DaemonModeDeps.mode: 'remote'` (with `runtimeName`, `runtimeId`, and the menu's `remoteRecents`) stays as the test seam of the remote handler variants: tests/parity/remote and tests/backend/daemon-mode-remote*.test.ts run one remote daemon as the primary and compare its recordings with embedded's. Moving them onto a non-primary runtime would tag every call and push of those recordings. Only the remote primary's own UI is removed: Help's Open Settings → Connections (`openBackendSettings`, the `open-settings-backend` menu action) and `REMOTE_RECOVERY_HINT`.
9. **§15 deviations.** Resolved: item 1 (remote mode keeps one runtime), item 2 (the switch kept for `local`, `embedded` and remote mode) and item 3 (names shown while the one runtime is another computer).
10. **Device token (§9.1, §15 item 13).** `multiDaemonBackend({ deviceToken: true })` turns remote access on in the remote daemon (`PUT /remote-access` through its management routes: loopback, master token, local proof), saves a device token from `POST /remote-access/devices` as the connection's token, and lets the proxy forward the real `/remote/hello`. Remote access runs in the fenced daemon through the test seam `ADF_TEST_REMOTE_ACCESS_PROBES` (src/main/daemon/remote-access/test-probes.ts). It is honoured only with that variable, the test-seam gate (`ADF_TEST_SEAMS=1`, an unpackaged build) and the fence's mark (`Symbol.for('adf.parity.fence')`, set by tests/parity/harness/fence.cjs); otherwise it is ignored with a log line. It replaces the probes that spawn or open sockets (interfaces, gateways, Wi-Fi names, network categories, Tailscale, the mDNS announcer, the firewall query) with "nothing found"; the daemon then listens on loopback only, and pairing, device tokens, revocation and the request checks are the real ones. Scenario `multi-device-token`: Studio connects and chats with the device token; revoked on the host, that runtime fails with `refusedTokenSentence` and no dialog, and This computer keeps working. The 6-digit code is not in parity: the host opens a pairing window only while it listens on a LAN or tailnet address (`openPairing`), and the fence allows loopback only. Code pairing stays covered by the backend tests with fakes (tests/backend/remote-access-studio.test.ts).
11. **CLI.** No `adf` command read Studio's connection mode; each still targets one runtime (`--remote`, `ADF_REMOTE`, the `default` in `cli-remotes.json`). No change.
12. **Tests.** tests/backend/runtime-migration.test.ts (§7.3 to §7.5, the windows restored on their runtime, local and Inside Studio files untouched), main-boot-remote-migration.test.ts (the migration at boot and its one notice), main-boot-local-unchanged.test.ts (a local-only install's `studio-backend.json` and `studio-client-settings.json` keep their bytes across a launch, M11), remote-access-test-probes.test.ts (the seam's gate), and the reworked backend-config, connections, connection-settings, boot-handover (was mode-switch), handover and failed-launch tests.

## 17. Adversarial review fixes

An adversarial review of phases 1 to 4 found the gaps below; each is fixed with a test that failed first.

1. **Connection lifecycle (main).** A removed or replaced runtime sends nothing more, and quit waits for runtimes still retiring. `RuntimeManager.replace(id, expected)` replaces a runtime only while it is still the one the caller saw. The pin check is re-armed on every drop until the next connect, and only on a failed re-dial. A session call on a runtime that is not connected fails as not connected instead of waiting. Restart into Inside Studio waits for the daemon to exit.
2. **Approvals and menus.** An approval answered in a remote's agent window goes to that window's runtime; an explicit `$runtime: 'local'` from an agent window is honoured on the approval channels (`ANY_RUNTIME_CHANNELS`). The macOS menu bar opens a remote's agent on that remote.
3. **Unreadable `cli-remotes.json`.** It is not "no connections": the list last read stays, the runtime set keeps its saved connections, a launch does not migrate remote mode, and Settings → Connections says which file to fix. Studio and `adf` read the file through one reader (`readRemotes`, `readRemotesAsync` in cli/remotes.ts; `savedConnectionNames` uses it). `updateRemotes` never writes over such a file (`RemotesUnreadableError`); `adf remotes`, `adf pair` and the choice of the default remote fail with the file named, and an `adf` command given `--url` does not read the list.
4. **Twin slot.** A remote slot paired with a computer that is also a saved connection is that connection. Remove of the connection clears the slot, token included. Studio also drops such a slot as soon as it sees both, at launch (`migratePairedSlot`, without replacing the connection's token) and while it runs (`clearTwinSlot`), so `adf remotes forget` of the connection brings no slot back.
5. **Migration crash safety (§7.3).** The client keys are written first, then `studio-backend.json`; the client file is marked `remoteModeMigrated` while `studio-backend.json` still says remote (`migrateRemoteModeInstall`).
6. **Per-runtime keys (§7.4).** `runtimeRecentFiles` and `runtimeFleet` entries go on Remove, forget and slot replacement, and follow a connection saved again under another name with the same fingerprint, the slot's included (the rule: §18 item 4). `ClientSettingsStore` does not write a value equal to the saved one.
7. **Renderer.** A remote agent survives Reconnect in the main window, which reopens it; main answers the main window's `FILE_GET_CURRENT` from `mainOpenRuntime()` with its `runtimeId`. Queued messages keep their `runtimeId`. Caches are per runtime. An open overtaken by a later one applies nothing (generation token). Remove closes that runtime's agents and keeps recovery copies of unsaved text (`forgetRuntimeFleet(id)`). Settings runtime pages read the picked runtime's templates; the provider sheet, start guards and drafts use their own runtime.
8. **Copy.** One banner; "<name> is in Settings → Connections."; **Remotes**; "Saved <name>."; Connections lists saved rows in the order added.
9. **Tests.** tests/backend/multi-runtime-harness.ts and multi-runtime-lifecycle.test.ts, main-boot-remote-migration-retry.test.ts, main-boot-runtime-keys.test.ts, remotes-unreadable.test.ts, twin-slot-forget.test.ts, new parity scenarios in tests/parity/multi, and local-only renderer recordings compared with those before multi-runtime (`d00491a0`).
10. **Second review (renderer).** A reconnect or a move reopens the open agent without a dialog: its unsaved editors are kept as recovery copies first (`openFile(..., { kept: true })`), and those copies are handed off, so closing their editors never removes them. Remove closes the agent only after the copies are written. A reopen overtaken by the user's own open answers `{ overtaken: true }` and says nothing. A rename in `cli-remotes.json` or the slot cleared for its twin is a move, not a Remove: main sends `RUNTIMES_MOVED` before the runtime set, and the main window re-keys queues, drafts, marks, the fleet map's keys and the open agent ("<old> is now <new>."). A fleet save sends only the fields it saves for the runtimes of the set, and main merges them; the Mesh view's copy of `runtimeFleet` is read again when the set changes. A runtime that leaves the set or is another computer loses its config caches, model lists and templates. The local-only recordings cover Settings, the approvals bell and panel, Go to Agent and the status bar while This computer is not connected.

## 18. Second review fixes

A second adversarial review found the gaps below; each is fixed with a test that failed first.

1. **Pending migration of `studio-backend.json` (§7.3).** While the migration is not written (the client keys could not be, or the file cannot be), `BootBackend.remoteModePending` holds the old `remote.name`. Every write of the settings store in that launch (`setRuntimeOrder`, Connections saves, `clearTwinSlot`) writes `mode: remote` with that name, so the next launch still migrates and the notice stays true. A save of another mode ends it.
2. **Client keys while pending (§7.4, §7.5).** A client file that cannot be written at boot is migrated in memory (`RemoteModeMigration.clientKeys`, `ClientSettingsStore` `migrate`) and marked; its next write holds the keys. A launch that cannot read `cli-remotes.json` still migrates the client keys and marks the file (they need only `remote.name`; a slot without one becomes `remote`, relinked by fingerprint later), and leaves `studio-backend.json` for the first launch that can read the list. Settings → Connections says so in one notice. `AgentWindows.save` never writes over a list saved for `remote:…` while the runtime is `local`.
3. **`remoteModeMigrated`.** It gates the plain fleet keys only; `remoteRecentFiles` and a `remote:…` agent windows list move whenever they are there. Any launch that reads a `studio-backend.json` not in remote mode removes the mark.
4. **Keys follow the fingerprint.** `runtimeFingerprints` (client key, written by Studio main only) holds the fingerprint of each remote runtime that has `runtimeRecentFiles` or `runtimeFleet` entries, as last seen saved. When Studio sees a name gone, at launch (`launchRuntimeKeyChanges`: the record, the saved agent windows, the slot) or when `cli-remotes.json` changes (`savedConnectionChanges`, any name with that fingerprint), and another saved name has that fingerprint, the keys move there unless that name has its own; otherwise they go. A name that holds another fingerprint is another computer: its keys go. So forget, then pair under another name, while Studio runs removes them at the forget; with Studio closed, the next launch sees only the result and moves them.
5. **`adf remotes forget`.** `forgetRemote` (cli/remotes.ts), used by adf and Studio's Remove, writes the list first and deletes the token only when no other name, malformed entries included, has that fingerprint. A list that cannot be written (locked, unreadable) keeps both.
6. **Malformed entries.** `readRemotes` reports them (`malformed`). `updateRemotes` keeps each one as read, in its place, and a default that names it; `forgetRemote` removes one; a new name never takes one's name. `adf remotes` and Settings → Connections name them.
7. **Notices of `cli-remotes.json`.** "Saved connections could not be read" and the malformed-entry notices are replaced at each read, so a file fixed while Studio runs is no longer reported.
8. **adf help.** The daemon URL, and so the saved remotes list, is resolved only for a command that talks to a daemon: `adf help`, `adf --help` and `adf tui --help` work while `cli-remotes.json` cannot be read.
9. **Tests.** main-boot-remote-migration-pending.test.ts, main-boot-remote-migration-deferred.test.ts, runtime-keys-follow.test.ts, remotes-forget-and-malformed.test.ts, cli-help-remotes-unreadable.test.ts, and a case in agent-windows.test.ts.

## 19. Round-2 review fixes

The three round-2 fixer branches are merged together (`ux/mr-fix2A`, `ux/mr-fix2B`, `ux/mr-fix2C`; items in §17 item 10, §18 and remote-access.md §5.2.1). The integration adds the following.

1. **Protocol change.** A saved remote's token goes only after the authenticated hello (remote-access.md §5.2.1). A remote computer MUST run this version or newer; an older one is refused with "<name> runs an older ADF; update it." There is no unsigned fallback.
2. **The CLI's environment.** Every lookup `adf` makes for a command (the daemon URL, the token, the local proof, the tunnel hint) reads the environment it was given (`CliIo.env`, else `process.env`), the same one the pin check reads. A saved remote's token is sent on the request after the hello proof passed, and only then.
3. **Terminal app reconnects.** The token of a saved remote (no `--token`, no `ADF_DAEMON_TOKEN`) goes only after the hello proof, at the first connection and again after every failed request or dropped event stream (`DaemonCredentials.ready` and `dropped`, `daemonCredentials` in cli/daemon-url.ts; `EventStreamOptions.beforeConnect` and `onDrop`). A refusal fails that request or stream attempt with its sentence, and nothing is sent; the stream retries with backoff and checks again. `/url` to a saved remote is checked the same way. A hello answered 429 says "<name> is rate-limiting connections; retrying.", never that the host is down; nothing is sent until a later hello proves the pin (remote-access.md §5.2.1, review round 3).
4. **Tests.** tests/backend/main-boot-runtimes-moved.test.ts (a rename while Studio runs: the windows get `RUNTIMES_MOVED`, then the runtime set without the old id, and `runtimeRecentFiles` and `runtimeFleet` move to the new id), a case in tests/cli-remote-access.test.ts (the saved token goes to the paired host, after the hello), and tests/tui/remote-pin-reconnect.test.ts.

## 20. Round-3 review fixes

A third adversarial review found the gaps below in runtime state, the client keys and the renderer; each is fixed with a test that failed first.

1. **A move keeps the agent windows.** A runtime that leaves the set because it moved (a rename in `cli-remotes.json`, or the remote slot cleared for its twin: the moves of `RUNTIMES_MOVED`) closes its agent windows as Reconnect does: they stay saved, under the new id (`AgentWindows.moveRuntime`), and reopen once the new id connects, or at once when it is connected already. `RuntimeManager.sync(saved, slot, { moves })` keeps each move until its old id leaves the set, so the slot cleared at a later sync is a move too. A Remove still drops them.
2. **Fingerprints are recorded when keys are written.** A write of the client settings that gives a saved connection's runtime `runtimeRecentFiles` or `runtimeFleet` entries for the first time records its fingerprint in `runtimeFingerprints` in the same write (`recordRuntimeFingerprintsOnWrite`; `ClientSettingsStore.onWrite`), from the cached saved connections. So keys created after the launch's record step move, not go, when the connection is renamed while Studio is closed (§18 item 4).
3. **Hand-off copies.** The recovery copies a reconnect, a move or Remove keeps (`stashUnsavedEditors`) name the hand-off (`kept`, a time stamp) and go to a folder of their own, `<agent>-<hash>~kept-<stamp>`. A later "changed elsewhere" notice on the same file, its removal, and the next hand-off never write over or remove them; a removal that names a hand-off is refused. The notice's own copy is removed with its editor as for any resolved notice. The recovered-edits notice lists a hand-off's copies at once, with the copies the launch found ("Studio kept your unsaved version of <files>."); a copy a notice still holds is not listed.
4. **Main's key cleanup reads the keys again.** `forgetGoneRuntimeKeys` reads `runtimeRecentFiles`, `runtimeFleet` and `runtimeFingerprints` after it read `cli-remotes.json`, and patches them in the same synchronous stretch, changing only the ids that go or move. A window's merge while the file is read is kept.
5. **A failed open or create.** The main window's open runtime moves only on an open or create that succeeded. A create (New agent, the home composer) that fails after the open agent of another runtime was closed for it clears that agent's view, as a failed open does; the error shows as before.
6. **Tests.** tests/backend/runtime-move-windows.test.ts, tests/backend/main-boot-runtime-fingerprints.test.ts, cases in main-boot-runtimes-moved.test.ts, runtime-keys-follow.test.ts, edit-recovery.test.ts and multi-runtime-lifecycle.test.ts, and in tests/unit/renderer/editor-save.test.ts and multi-runtime-review.test.tsx.
