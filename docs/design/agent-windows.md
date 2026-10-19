# Agent windows

Status: step 1 of [#149](https://github.com/christianbalevski/adf/issues/149), on branch `feat/agent-windows`. Daemon mode (Local or a remote runtime) only.

## 1. Scope

**Open in new window** on an agent opens a window with that agent's chat and loop (middle) and its panels (right). The window has no sidebar, no Home, no Settings and no fleet map. Its title is the agent's name. One Studio process, one runtime connection; every window is a view on it.

Entry points: the agent's row in the sidebar (context menu), the agent title bar of the main window (icon button), and the fleet map's agent readout. All are shown only in daemon mode.

## 2. Decisions

1. Each window is its own client session on the daemon (daemon-backend.md D5). The daemon already serves several sessions per client; it is not changed.
2. Studio main maps a window to its session by the window's `webContents` id. An IPC call is served by its sender's session. A call from a sender that never was an agent window is served by the main window's; a call from an agent window that closed is refused.
3. The main window keeps today's session, bridge and quit behaviour. Agent windows add sessions beside it.
4. One window per agent. Opening an agent that has a window focuses that window. The main window may show the same agent: both are live views.
5. Shared across windows: client settings, UI preferences (one `localStorage`, one Electron session), approvals, notifications, the connection and its state. Appearance (theme, typeface, scale, avatars) saved in one window applies in the others at once.
6. A pending approval or question has one notice window: the focused window that shows its agent, else the main window. It is decided once, when the request arrives.
7. Quitting saves the open agent windows; the next launch reopens those whose agent is still there.
8. Inside Studio (legacy) stays single-window. Nothing in this design runs there.

## 3. Window and session map

Code: `src/main/backend/daemon-mode/index.ts` (`openWindow`, `closeWindow`, `ctxFor`), `src/main/backend/daemon-mode/windows.ts`.

| Window | Session | Bridge | Handler context |
|---|---|---|---|
| Main | The session opened at connect, `exitDaemonWhenClosed` per `keepDaemonRunning` (§8.3) | `bridge` | `ctx` |
| Agent window | Opened by `DaemonWindows.open` before the page loads, once the daemon is reached; `exitDaemonWhenClosed: false` | Its own `EventBridge` and batcher | `contextFor(session, bridge, ready)` |

- `DaemonWindows.open({id, send, focused})` creates the window's `DaemonModeSession`, `EventBridge` and `BackgroundEventBatcher` at once, and its `ClientSession` when `started` resolves. Its `ready()` waits for that session, so a FILE_OPEN from the new page always holds the document on it.
- The context of an agent window differs from the main context in `session`, `bridge`, `ready` and `raw` (requests carry that window's `X-ADF-Client-Session`, so the daemon does not echo the window's own writes to it, D5.1). Settings, approvals UI, install relay, connection and remote services are shared.
- `DaemonWindows.close(id)`: the window id is marked closed, the bridge and batcher are disposed, and the session ends (`DELETE /client/sessions/:id`), which releases its documents in the daemon. The end waits at most `AGENT_SESSION_END_TIMEOUT_MS` (1.5 s); a session that does not answer expires in the daemon.

## 4. IPC routing

- Every daemon-mode `invoke` and `send` handler is registered once. The registered function looks up `event.sender.id` (`ctxFor`): an agent window gets its own context; a closed agent window's invoke is refused ("This agent window is closed.") and its send is dropped; any other sender gets the main context. Handlers are unchanged.
- `adf-file://` requests: `protocol.handle` has no window. In daemon mode `session.defaultSession.webRequest.onBeforeSendHeaders` adds `X-ADF-Window: <webContentsId>` to each `adf-file:` request; the handler serves the file from that window's agent (`createAdfFileHandler` `sessionFor`). The header is always overwritten, so a page cannot name another window. The scheme privileges, the request filter and the header name are in `adf-file-window.json`, read by main and by `tests/electron/adf-file-window-header.cjs`, which `tests/backend/adf-file-window-header.test.ts` runs with the real Electron binary to check the behaviour this relies on.
- `APP_GET_FULLSCREEN` and `APP_SET_FULLSCREEN` act on the sender's window. `APPROVALS_GET_PENDING_REVEAL` answers the sender's own pending reveal.
- Channels registered in `main/index.ts`, daemon mode only:

| Channel | Use |
|---|---|
| `WINDOW_OPEN_AGENT` | `{filePath, agentId?, name?}` → `{success, created}`: open or focus the agent's window |
| `WINDOW_CLOSE` | Close the asking agent window (never the main window) |
| `WINDOW_OPEN_FAILED` | The asking agent window could not open its agent |
| `WINDOW_OPEN_SETTINGS` | `{section?, anchor?}`: focus the main window and open Settings there |
| `WINDOW_STASH_DONE` | The asking agent window kept its unsaved text before a restart |
| `WINDOW_QUEUE_SYNC` | The asking agent window's queued messages (§5) |
| `QUEUE_HANDOVER_TAKE` / `QUEUE_HANDOVER_READY` | The main window takes the queued messages closed agent windows left |
| `MENU_ACTION_TAKE_PENDING` | The page listens for menu actions from now on; the ones sent while it loaded |

- Application menu (`menu.ts` `setMenuWindowResolver`): Save acts on the focused window. Close Agent acts on the focused agent window (it closes that window), else on the main window. Every other item (New, Open, Open Recent, Track Folder, Settings) acts on the main window, creating it on macOS when there is none. An action for a page that is not listening yet waits in main until the page takes it (`deliverMenuAction`, `takePendingMenuActions`). A new page (a navigation of the main frame that is not in-page: a reload) waits again; a subframe, a `<webview>` or an in-page navigation does not. Open Recent goes through main's open-file flow.
- Settings links in an agent window (identity restore banner, runtime indicator, skills, compute, the Providers jump after a sign-in failure, Ctrl+,) open Settings in the main window at that section: `useAppStore.openSettingsAt` and `setShowSettings(true)` call `WINDOW_OPEN_SETTINGS` there.

## 5. Event routing and agent window state

- Each session has its own stream (D5.1: own ring, cursor, focus). An agent window's bridge sends its pushes to that window only (`target.send`); the main window's bridge sends to the main window, as before.
- An agent window's bridge re-keys its session on a rename or relocate of its agent's file (`onFileRenamed`), so its session's current file is always the agent's file.
- Daemon-wide side effects run once, from the main window's bridge: tracking the folder of a file an agent created (`trackCreatedFiles: false` on agent bridges), the orphan-hold notice, the remote-access push, and the remote-mode browser-session notice.
- Connection events reach every session: a reconnect, resume, revive or listener check re-dials every stream (`reconnectStreams`); a failed connection, the disconnect grace period or a daemon exit ends every window's waiting chats (`failAllTurns`); a reconnect rechecks every window's ended chats. The connection state is the main stream's.
- Opening: the page opens the file its session has open (FILE_GET_CURRENT; after a reload, the renamed file), else the file of its page query (`window=agent&file=<path>`). Opening any other agent from inside it opens that agent's window instead (`useAdfFile.openFile`). Closing its agent (Close Agent; Cancel on the password, owner or review dialog) closes the window (`useAdfFile.closeFile`).
- An open that is refused, rejects, or leaves no file shows "The agent did not open." with the reason, **Retry** and **Close window** (`AgentWindowStatus`), and tells main (`WINDOW_OPEN_FAILED`): such a window is not saved for the next launch until an open succeeds.
- Queued messages: a message typed while a loop is mid-turn waits in the window's queue. An agent window mirrors its queues to main on every change (`WINDOW_QUEUE_SYNC`, `queue-handover.ts`). When it closes, what it still held goes to the main window (`QUEUE_HANDOVER_READY`, then `QUEUE_HANDOVER_TAKE`; also taken when the main window's page loads, for macOS without a main window). The main window adds them after its own queue for that loop and sends them when the loop's turn ends, as for any agent in the background; a loop that is idle already gets them at once, an agent that is off keeps them until it starts. Image previews stay behind; the message content goes. A reloaded agent window (or one whose renderer crashed) first takes back the queue main holds for it (`WINDOW_QUEUE_GET`) and only then mirrors again, so its new, empty page never replaces main's copy. The mirror sends when the queues change (or the open file that names them), not on every document change.
- Restart after a failed connection: every agent window first keeps its unsaved editor text as recovery copies (`stash-edits`, answered by `WINDOW_STASH_DONE`, at most 5 s each), then the main window does the same and restarts Studio. The next launch lists all copies in the main window.

## 6. Approvals and notifications

Code: `NoticeOwners` and `noticeWindow` in `windows.ts`; `publishApprovals`, `applyApprovals` in `index.ts`; `ApprovalsUi` `revealWindow`, `noticeFocused`.

- Only the main window's stream feeds approvals: the native notifier, the macOS menu bar and the MCP sign-in opener read it, as before. Agent bridges drop `APPROVALS_CHANGED`.
- On each snapshot, before the native notifier runs, every request not seen before gets its notice window: the focused window that shows its agent, else the main window (no main window, macOS: a window that shows the agent). The choice stays until the request is answered.
- `publishApprovals` sends the snapshot to every window. With agent windows open, each copy carries `notify`: the ids whose notice that window shows. The renderer shows an in-app toast only for those (and never for its own open agent, which shows the request in its chat; `arrivalsToAnnounce`). With no agent window open the push is exactly embedded's (no `notify`).
- OS notification: shown when the notice window does not have focus (`NativeNotifier` asks per request). A click goes to the agent window that owns the notice, else to an agent window that shows the agent, which is focused and shows its chat; the main window is left as it is. Otherwise the main window, as before. A reveal for a page still loading waits for that window only.
- Agent windows show no approvals menu and no toasts. Their agent's requests show in their chat.
- An agent window that closes passes its pending notices to the main window. They stay in its list and the fleet map badge; no new toast is shown for them.
- Result: a notice is shown in one window, and a request is never without a window that lists it.

## 7. Restore

Code: `src/main/backend/agent-windows.ts`.

- Client key `agentWindows` (studio-client-settings.json, client file only): `{runtime, windows: [{agentId, filePath, bounds}]}`. `runtime` is `local`, or `remote:<connection name or URL>`.
- The list is the open windows plus the saved windows still to reopen (carried): those of a launch whose restore has not run, those whose check failed for a reason other than "gone", and those macOS closed with the main window. A write never drops a carried window, so a quit before the restore ran, a quit after macOS closed the agent windows, and a close during a restore all keep the list.
- Written when an agent window opens or closes, 500 ms after it moves or is resized, and at quit (`freeze()`, before the shutdown closes any window). After `freeze()`, closes do not change it.
- Read when the main window is ready and the daemon is reached. A list saved for another runtime is ignored. Each carried entry is checked with `GET /files/agent/config?path=` (`checkSavedAgent`):

| Answer | Result |
|---|---|
| The file holds the saved agent id (or none was saved) | Reopened, behind the main window (`showInactive`), with its bounds |
| `404 not_found`, `400 not_an_adf`, or another agent id | Dropped |
| Anything else (daemon away, timeout, a file it could not read) | Kept saved; not opened this time |

- An unnamed remote has no runtime name until it connects (its URL is the name): while the runtime is unknown the list is neither read nor written.
- A reopened window whose open then fails stays saved unless the same check says its agent is gone; a window the owner opened whose open fails is not saved.
- Saved bounds are used when at least 100 px of the window's title strip lie on one display; otherwise the window opens at its saved size where the system puts it.
- An agent that already has a window is not opened twice. `closeAll` (macOS) stops a restore in flight; the next restore starts over.

## 8. Lifecycle

| Event | Result |
|---|---|
| Open in new window | `AgentWindows.open`: focus the agent's window, or create it (`BrowserWindow`, then `DaemonWindows.open`, then the page) |
| Agent window closed | Its session ends (the daemon releases its documents); its queued messages go to the main window; it leaves the saved list |
| Main window closed, Windows and Linux | Studio quits, as today; agent windows close with it and stay saved |
| Main window closed, macOS | Studio stays open, as today; agent windows close and stay saved; reopening the main window (Dock) reopens them |
| Quit | The list is frozen and written; agent sessions end before the main session's quit request, so the daemon's "no other client session" rule (§8.3) sees only Studio's main session. Each end waits at most 1.5 s. If one has not ended by then, the quit request finds it open: with `keepDaemonRunning` off the daemon holds the stop (`holdForQuit`) and stops when that session ends, either its late DELETE or its expiry 60 s after its stream closed (D5.1). The daemon still stops; a switch to Inside Studio in that case does not wait for it, and embedded Studio reports an agent the daemon still runs as running in the daemon, as after any held stop. |
| Windows logoff | Same as quit, fast path |
| Remote runtime | Same as Local; all sessions use the one connection. A 401 ends every session |

## 9. Inside Studio (legacy)

Not offered. The main window's page has no `agentWindows=1` query, so the menu items and buttons are not shown, and none of the channels in §4 has a handler. The embedded boot is unchanged.

## 10. Known limits

- Several runtimes at once is step 2.
- Settings writes the providers list (and the default), MCP servers and channel adapters whole. Every such save, the provider setup dialog's and the picker's too, is applied onto the lists stored when it starts (`rebaseById`, `rebaseSettingsLists`), and the page then shows what was written with any edit made meanwhile on top, so a change made in another window is kept and a removal made there is not undone. Two saves of one list from two windows within the same moment can still race.
- Queued messages of agent windows open at quit are not kept, as the main window's are not.
