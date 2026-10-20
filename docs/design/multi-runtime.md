# Multi-runtime Studio

Status: design for step 2 of [#149](https://github.com/christianbalevski/adf/issues/149) (phase 1 of [#148](https://github.com/christianbalevski/adf/issues/148)). Not built. Step 1 is [agent-windows.md](agent-windows.md).

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are used as in RFC 2119.

Read with: [agent-windows.md](agent-windows.md) (window and session map, `ctxFor`), [settings-scopes.md](settings-scopes.md) (Connections page, runtime indicator, remote-mode rules), [remote-access.md](remote-access.md) (device tokens, pinning), [studio-backend.md](../guides/studio-backend.md) (the switch this design removes), [daemon-backend.md](daemon-backend.md) D5 (client sessions).

## 1. Scope

### 1.1 Goals

- Studio holds one connection per runtime in its runtime set: This computer, plus each remote the owner connected. Windows are views on those connections.
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

- **Runtime set**: the runtimes Studio connects to. Always This computer; plus each remote added with **Connect**. Stored in `studio-backend.json` `runtimes` (§3.1).
- **Runtime id**: the connection id of settings-scopes.md §5.4: `local`, `remote:<name>` (a saved connection in `cli-remotes.json`) or `remote` (the one connection without a fingerprint in `studio-backend.json`).
- **Multi-runtime**: the runtime set has more than one entry. A runtime in the set counts while it is down.
- **Agent ref**: `{runtimeId, agentId, filePath}`. Two refs name the same agent when the runtime ids are equal and the agent ids are equal; when either agent id is null, when the file paths are equal under that runtime's path rule (`samePath(a, b, kind === 'remote')`).

### 1.4 User-visible behaviour

| Surface | This computer only | Multi-runtime |
|---|---|---|
| Sidebar, Go to Agent | Tracked folders, as today | One group per runtime, headed with its name and, while down, its state; tracked folders inside |
| Mesh view | As today | One region per runtime, labelled with its name (§6.4) |
| Status bar | One unnamed group: `( [Mesh] [Kill] )`, a problem in the state's words | One group per runtime: `( [name] [Mesh] [Kill] )` (§6.2) |
| Approvals bell, toasts, OS notifications | As today | One list; each row and notification carries its runtime's name (§6.1) |
| Settings | Runtime pages unheaded | Group heading **Runtime** with a picker of runtime names (§6.3) |
| Agent window title | Agent name | Agent name · runtime name |
| Connections | One row, **Add** (SimpleConnections) | Rows per settings-scopes.md §5.1, with **Connect** adding a runtime and **Disconnect** in More (§6.5) |
| Connect | n/a | No dialog, no restart |

UI copy MUST NOT describe the runtime set as additive or explain that This computer stays connected. Labels are one word (**Add**, **Connect**, **Disconnect**, **Remove**, **Runtime**, **Runtimes**), with a tooltip at most.

### 1.5 Before and after

Before: Studio runs agents on This computer or on one other computer. Choosing rawl-hub in Settings → Connections asks to switch, lists what stops, and restarts Studio. Afterwards the agents of this laptop are gone from Studio until the next switch and restart. To watch both, the owner runs a second Studio with `ADF_INSTANCE`.

After: the owner pairs rawl-hub and presses **Connect**. Nothing restarts. The sidebar now shows two groups, This computer and rawl-hub, and the status bar shows a Mesh and Kill for each. Approvals from both arrive in one bell, each marked with its computer. An agent window can show an agent of either. When rawl-hub goes offline, its group says "Not connected, retrying" and its agents grey out; the laptop's agents keep working.

An owner who never adds another computer sees no change.

## 2. Decisions

| # | Decision | Section |
|---|---|---|
| M1 | One `RuntimeConnection` per runtime in the set, created at launch or on Connect, disposed on Disconnect, Remove or quit. Each owns its connector, client, token source, pin check, sessions, bridges, exit watch and failure state. | §3 |
| M2 | Every runtime-scoped invoke, send and push carries a runtime tag as its first argument. No tag means `local`. Local traffic is never tagged. | §4.1 |
| M3 | Handlers are registered once. The registrar strips the tag and serves the call with the context of (sender window, runtime). Handler code is unchanged. | §4.3 |
| M4 | The main window has one client session per runtime in the set. An agent window has one session, on its agent's runtime. | §3.2 |
| M5 | Handler variant (local or remote, channel-map.ts classes) is chosen per call from the runtime's kind in main's table, never from the renderer. | §4.3, §8 |
| M6 | Approvals, notifications and the connection list are aggregated in main. Their pushes are untagged; each entry carries `runtimeId`, omitted for `local`. | §4.2, §6.1 |
| M7 | Agent identity is the agent ref everywhere in the renderer and in main's window, queue, notice and restore maps. | §5 |
| M8 | Names, tags, picker and grouping depend on one selector, `useMultiRuntime()`. | §5.1 |
| M9 | Connect adds a runtime to the set; Disconnect takes it out. The switch-and-restart flow between This computer and a remote is removed. | §6.5, §7.1 |
| M10 | Studio never stops a remote daemon. Background (`keepDaemonRunning`) is This computer's only. | §3.3 |
| M11 | A local-only install's `studio-backend.json` and `studio-client-settings.json` are not rewritten by this change. | §7.3, §9.3 |

## 3. Main process

### 3.1 Runtime set

- `studio-backend.json` gains `runtimes: string[]`: the runtime ids besides `local`, in the order added. Absent means `[]`. Studio writes it only on Connect, Disconnect and Remove, and on the migration of §7.3.
- `local` is always in the set and MUST NOT be written to `runtimes`.
- An id in `runtimes` whose connection is no longer saved (removed with `adf remotes forget`) is dropped from the set at the next read of `cli-remotes.json` (`SavedConnectionsCache` change), and its windows close.
- A remote paired with `adf pair` is a Paired row with **Connect**. Studio MUST NOT add it to the set by itself.

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

`RuntimeManager` exposes `runtimes()`, `get(id)`, `add(id)`, `remove(id)`, `contextFor(windowId, runtimeId)` and `shutdown()`. `RuntimeConnection` exposes what `DaemonModeHandle` exposes today, for one runtime.

### 3.3 Lifecycle

| Event | Result |
|---|---|
| Launch | `local` and every id in `runtimes` get a `RuntimeConnection`, started in parallel. The main window loads without waiting for any remote. |
| Connect | The token is read (keychain, `savedConnectionTarget`), then the id is added to `runtimes` and the runtime connects. A keychain refusal ends the Connect with the existing sentence; nothing is saved. |
| Disconnect | Agent windows of the runtime close and leave the saved list; its sessions end (bounded, `AGENT_SESSION_END_TIMEOUT_MS`); the id leaves `runtimes`. |
| Remove | Disconnect, then `forgetConnection` (settings-scopes.md §5.3). |
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
| `CONNECTION_LIST` / `CONNECTION_CHANGED` | `ConnectionsView` gains `runtimes: RuntimeView[]` (`{id, kind, name, url, state}`, `local` first, then the order added). `current` stays: the sender's runtime (agent window), else `local`. `next` is removed (§7.1). |
| `CONNECTION_USE {id}` | Adds the runtime (§3.3). `embedded` keeps the switch dialog and restart (§7.2). |
| `CONNECTION_DISCONNECT {id}` | New, `studio` scope |
| `CONNECTION_REMOVE {id}` | Disconnects first; no switch |
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
- `useMultiRuntime()`: `runtimes.length > 1`. It replaces `useRemoteConnectionsSaved()` for the Settings heading, the status bar, Kill's tooltip and every runtime name. `remoteConnectionsSaved()` stays only to choose the Connections layout (SimpleConnections or the list).
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
- Sidebar: one collapsible group per runtime, in `runtimes` order, headed with the runtime name; state while down. Tracked folders inside, as today. **Track Folder** acts on the group it is chosen from; the File menu's acts on This computer.
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
- Multi-runtime: each bell row, toast and OS notification names its runtime before the agent (`rawl-hub · agent-1`). This computer is named too.
- Answering resolves through `apiFor(entry.runtimeId)`.
- A runtime's entries that cannot be answered (runtime down) are shown disabled (§3.6).

### 6.2 Status bar

- One group per runtime, `local` first: `( [name] [Mesh] [Kill] )`. Mesh and Kill call that runtime (`MESH_*`, `emergencyStop`, tagged). Kill's tooltip: "Stops all agents and mesh on <name>".
- Name: plain text; remote icon for a remote; state added while down; tooltip the address. Click: Settings → Connections.
- This computer only: one group with no name, exactly settings-scopes.md §4.1.
- When the groups do not fit, the remote groups collapse into one **Runtimes** button; its popover lists the same groups.

### 6.3 Settings runtime picker

- Multi-runtime: the runtime group's heading is **Runtime** with a picker of runtime names. Every runtime page calls `apiFor(picked)`. The remote-mode rules of settings-scopes.md §7 follow the picked runtime's kind.
- Settings opens on the runtime of the main window's open agent, else This computer. Opened from an agent window (`WINDOW_OPEN_SETTINGS {runtimeId}`), on that window's runtime. The choice is not saved.
- A picked runtime that is down: "Not connected to <name>." and disabled controls, as today.
- Studio pages (Appearance … Connections) are not affected by the picker.

### 6.4 The Mesh view

- One map. Multi-runtime: each runtime's tracked folders form one region, labelled with the runtime name. A region is placed next to the existing ones; its placement is saved per runtime (§7.4).
- Each runtime's fleet poll reports its mesh peers. A peer whose `runtime_id` is a runtime in the set is drawn as that runtime's region, not as a peer station. Other peers are stations, one per `runtime_id` across all polls.
- Edges between agents on different runtimes come only from traffic a runtime reports (peer street heat). Studio MUST NOT forward messages between runtimes.
- A down runtime's region is greyed with its state.
- Batch commands on a selection are sent per runtime, one call each. A refusal on one runtime is reported; the others proceed.

### 6.5 Connections page

Settings-scopes.md §5 stands, with these rows:

| Row | State | Action | More menu |
|---|---|---|---|
| This computer | Connected (or the state while down) | none | Inside Studio (legacy) |
| A runtime in the set | Connected, Connecting, Not connected, retrying, Not connected | none | Disconnect, Remove |
| Saved, not in the set | Paired | Connect | Remove |
| Found, not paired | Not paired | Pair | none |

- Connect: no dialog and no restart. The Pair and Add connection dialogs' **Connect** does the same.
- Disconnect: no dialog unless the runtime has agent windows or unsaved editor text; then "Disconnect rawl-hub" with "Closes 2 agent windows." and **Disconnect** / **Cancel**.
- Remove: "Removes the address and token from Studio and adf." The switch-first sentence goes.
- With no remote saved the page is SimpleConnections, unchanged.

### 6.6 Menus

- Help: the status line names each runtime that is down. **Reconnect** acts on the runtime that is down; with more than one down, it is a submenu of their names. Open Daemon Log is This computer's.
- Open Recent: This computer's files; multi-runtime adds each remote's files under its name (§7.4).

## 7. Upgrade

### 7.1 The switch flow

Removed between This computer and a remote: the switch dialog for those targets, Switch and Restart, Wait for Them to Finish, Finish switch now, Cancel switch, "Restart to connect to <name>.", `ConnectionsView.next`, `studio-switch-resume.json` entries for those targets, and `mode-switch.ts` paths that only serve them. A remote's turns are never interrupted by Connect or Disconnect: they run in its daemon.

### 7.2 Inside Studio (legacy)

- It stays where #171 put it: under Details in SimpleConnections, and in This computer's More menu.
- It is a whole-Studio mode. Choosing it keeps today's switch dialog, handover and restart. In embedded mode the runtime set is not loaded; remote rows show Paired with Connect, which switches back to This computer (the switch dialog) and adds the remote at that launch.
- When Embedded is deleted, `mode-switch.ts`, the handover's reverse direction and `studio-switch-resume.json` go with it (Q3).

### 7.3 `studio-backend.json`

| Before | After |
|---|---|
| `mode: local` | Unchanged. `runtimes` absent. The file is not rewritten. |
| `mode: remote`, `remote.name: X` | `mode: local`, `runtimes: ['remote:X']`, `remote.name` removed |
| `mode: remote`, the `remote` slot | `mode: local`, `runtimes: ['remote']` |
| `mode: embedded` | Unchanged; `runtimes` kept, unused while embedded |
| `ADF_STUDIO_BACKEND=remote` | Read as `local` with the saved set; logged |

- The migration runs once, at the first launch of this version, before any connector, and writes atomically.
- On the first launch after migrating from `mode: remote`, This computer's daemon may start where it did not run before (Q1).
- An older Studio reading the migrated file runs This computer only. The remotes stay saved in `cli-remotes.json`.

### 7.4 Client keys

| Key | This computer | Remotes |
|---|---|---|
| `recentFiles` | Unchanged | n/a |
| `remoteRecentFiles` | n/a | Migrated to `runtimeRecentFiles: {<id>: string[]}` under the id of the remote it was written for (the old `remote.name`, else `remote`) |
| `fleetGroups`, `fleetStewards`, `fleetMapState` | Unchanged | `runtimeFleet: {<id>: {fleetGroups, fleetStewards, fleetMapState}}`. On migration from `mode: remote` the plain keys move there, under the old remote's id |

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
- Scenarios under `tests/parity/multi/`: open and chat on each runtime, concurrently, with the mock LLM; approvals from both, answered from the merged list; kill the remote daemon: the local runtime's turn completes and its recording equals the single-runtime one; a 401 from the remote; a pin mismatch (another daemon with another fingerprint on the remote's port); Disconnect with an agent window open; quit with the remote unreachable stays within budget.

### 9.2 Unit and backend tests

- Tag parsing and the refusals of §4.3, for invoke and send; tagged and untagged pushes in the preload factory.
- `channel-map.test.ts`: every entry has a `scope`; `studio` channels refuse a tag.
- `RuntimeManager`: add, remove, failed-runtime recreate, quit order and bounds, per-runtime 401, per-kind handler choice.
- `ApprovalsAggregator` and `NoticeOwners` with refs; notification ids equal on two runtimes stay distinct.
- Migrations of §7.3, §7.4, §7.5, including the downgrade read by the previous `parseSavedAgentWindows`.
- Renderer: selectors; `agentKey`; sidebar, status bar, Settings nav and approvals rows rendered with one runtime equal today's snapshots.

### 9.3 "Local-only unchanged" checks

- With `runtimes` absent: no runtime name, picker, group heading or tag in the DOM (sidebar, status bar, Settings, bell, toasts, titles, Go to Agent, Mesh view).
- `studio-backend.json` and `studio-client-settings.json` keep their bytes across a launch and quit of the new version (M11).
- Connections is SimpleConnections.
- `tests/backend/adf-file-window-header.test.ts` (real Electron) still passes.
- A user-testing section (MRT) in [daemon-backend-user-testing.md](daemon-backend-user-testing.md) walks the same on a packaged build.

## 10. Phased PR plan

Difficulty is on a 1-10 scale. Time is agent time.

| Phase | Scope | Risk | Difficulty | Time |
|---|---|---|---|---|
| 1. Connection manager and runtime-aware IPC | `RuntimeManager` / `RuntimeConnection` split of daemon-mode/index.ts; registrar with tags and `ctxFor(window, runtime)`; per-kind handler choice; `ApprovalsAggregator`; channel-map `scope`; preload factory and `adfApi.runtime(id)`; `runtimes` read; `agentWindows` and recovery entries with `runtimeId`. No UI change; `runtimes` can only be set by hand. | High: quit, exit watch, revive, approvals and window routing all move. Parity recordings MUST stay identical. | 7 | 4 h |
| 2. Renderer stores and grouping | `runtimes.store`, `useMultiRuntime`, `AgentRef` across stores and call sites (`apiFor`); sidebar groups, Go to Agent, agent window title, Mesh view regions and peer de-duplication; per-runtime client keys (§7.4) | Medium-high: wide renderer change; local-only snapshots guard it | 6 | 3 h |
| 3. Per-runtime surfaces | Connect adds, Disconnect, Remove without switch; status-bar groups and **Runtimes** overflow; Settings picker; bell, toasts and OS notifications tagged; Help menu; multi-daemon parity scenarios | Medium | 5 | 2.5 h |
| 4. Remove the switch flow | Delete §7.1; `studio-backend.json`, client-key and `agentWindows` migrations; guides (studio-backend.md, settings.md, remote-daemon.md), settings-scopes.md §5.3 and §10, user-testing MRT | Medium: migration of remote-mode installs | 4 | 1.5 h |

Overall 7/10, about 11 hours of agent time. Each phase ships alone; phases 1 and 2 change nothing visible.

## 11. Fit with #148

Out of scope here; this design does not block it:

- Every agent-bound call and entry names its runtime, so a per-agent grant (view, interact, admin) attaches to an agent ref without a new identity scheme.
- Credentials are per `RuntimeConnection`. A client DID that answers a runtime's signed challenge replaces that runtime's bearer token without touching IPC or the renderer.
- A runtime that refuses an action under a future grant answers an ordinary error on a runtime-scoped call; surfaces already show per-runtime refusals (§6.4).
- Studio never relays between runtimes (§1.2), so #148 open question 2 stays open.

## 12. Open questions

1. **Upgrade from Remote computer mode.** The migrated install starts This computer's daemon, which starts its agents set to start automatically; one of them may also run on the remote (two pollers of one bot). Hold autostart for that first launch, with one notice listing the held agents and **Start** (needs a daemon start option, also offered as an `adf daemon start` flag), or start normally? Recommended: hold.
2. **Remotes paired in the terminal.** A remote paired with `adf pair` is a Paired row until **Connect** (§3.1). Keep that, or add it to the runtime set automatically? Recommended: keep.
3. **Embedded removal order.** Delete Inside Studio (legacy) before phase 4, so phase 4 deletes `mode-switch.ts` whole, or keep its restart switch until its own PR? Recommended: delete first.
4. **Kill.** One Kill per runtime only, or also one that stops every runtime? Recommended: per runtime only.
5. **Order.** Runtime groups follow the order added, This computer first. Allow reordering (drag in Connections), or keep it fixed? Recommended: fixed.
