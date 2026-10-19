# Agent windows

Status: step 1 of [#149](https://github.com/christianbalevski/adf/issues/149), on branch `feat/agent-windows`. Daemon mode (Local or a remote runtime) only.

## 1. Scope

**Open in new window** on an agent opens a window with that agent's chat and loop (middle) and its panels (right). The window has no sidebar, no Home, no Settings and no fleet map. Its title is the agent's name. One Studio process, one runtime connection; every window is a view on it.

Entry points: the agent's row in the sidebar (context menu) and the agent title bar of the main window (icon button). Both are shown only in daemon mode.

## 2. Decisions

1. Each window is its own client session on the daemon (daemon-backend.md D5). The daemon already serves several sessions per client; it is not changed.
2. Studio main maps a window to its session by the window's `webContents` id. An IPC call is served by its sender's session; a call from an unknown sender is served by the main window's.
3. The main window keeps today's session, bridge and quit behaviour. Agent windows add sessions beside it.
4. One window per agent. Opening an agent that has a window focuses that window. The main window may show the same agent: both are live views.
5. Shared across windows: client settings, UI preferences (one `localStorage`, one Electron session), approvals, notifications, the connection and its state.
6. A pending approval or question has one notice window: the focused window that shows its agent, else the main window. It is decided once, when the request arrives.
7. Quitting saves the open agent windows; the next launch reopens those whose agent still exists.
8. Inside Studio (legacy) stays single-window. Nothing in this design runs there.

## 3. Window and session map

Code: `src/main/backend/daemon-mode/index.ts` (`openWindow`, `closeWindow`, `ctxFor`), `src/main/backend/daemon-mode/windows.ts`.

| Window | Session | Bridge | Handler context |
|---|---|---|---|
| Main | The session opened at connect, `exitDaemonWhenClosed` per `keepDaemonRunning` (§8.3) | `bridge` | `ctx` |
| Agent window | Opened by `DaemonWindows.open` before the page loads, once the daemon is reached; `exitDaemonWhenClosed: false` | Its own `EventBridge` and batcher | `contextFor(session, bridge, ready)` |

- `DaemonWindows.open({id, send, focused})` creates the window's `DaemonModeSession`, `EventBridge` and `BackgroundEventBatcher` at once, and its `ClientSession` when `started` resolves. Its `ready()` waits for that session, so a FILE_OPEN from the new page always holds the document on it.
- The context of an agent window differs from the main context in `session`, `bridge`, `ready` and `raw` (requests carry that window's `X-ADF-Client-Session`, so the daemon does not echo the window's own writes to it, D5.1). Settings, approvals UI, install relay, connection and remote services are shared.
- `DaemonWindows.close(id)`: the session's documents are released (`releaseAll`), the session ends (`DELETE /client/sessions/:id`), the bridge and batcher are disposed.

## 4. IPC routing

- Every daemon-mode `invoke` and `send` handler is registered once. The registered function looks up `event.sender.id` in the window map and passes that window's context to the handler (`ctxFor`). Handlers are unchanged.
- `adf-file://` requests: `protocol.handle` has no window. In daemon mode `session.defaultSession.webRequest.onBeforeSendHeaders` adds `X-ADF-Window: <webContentsId>` to each `adf-file:` request; the handler serves the file from that window's agent (`createAdfFileHandler` `sessionFor`). The header is always overwritten, so a page cannot name another window.
- `APP_GET_FULLSCREEN` and `APP_SET_FULLSCREEN` act on the sender's window.
- `WINDOW_OPEN_AGENT` (`{filePath, agentId?, name?}` → `{success, created}`) is registered in `main/index.ts` in daemon mode only.
- Application menu (`menu.ts` `setMenuWindowResolver`): Save acts on the focused window; every other item (New, Open, Open Recent, Track Folder, Close Agent, Settings) acts on the main window.

## 5. Event routing

- Each session has its own stream (D5.1: own ring, cursor, focus). An agent window's bridge sends its pushes to that window only (`target.send`); the main window's bridge sends to the main window, as before.
- Daemon-wide side effects run once, from the main window's bridge: tracking the folder of a file an agent created (`trackCreatedFiles: false` on agent bridges), the orphan-hold notice, the remote-access push, and the remote-mode browser-session notice.
- Connection events reach every session: a reconnect, resume, revive or listener check re-dials every stream (`reconnectStreams`); a failed connection, the disconnect grace period or a daemon exit ends every window's waiting chats (`failAllTurns`); a reconnect rechecks every window's ended chats. The connection state is the main stream's.
- An agent window's renderer opens its file from the page query (`window=agent&file=<path>`). Opening any other agent from inside it opens that agent's window instead (`useAdfFile.openFile`).

## 6. Approvals and notifications

Code: `NoticeOwners` and `noticeWindow` in `windows.ts`; `publishApprovals`, `applyApprovals` in `index.ts`; `ApprovalsUi` `noticeWindow`, `noticeFocused`.

- Only the main window's stream feeds approvals: the native notifier, the macOS menu bar and the MCP sign-in opener read it, as before. Agent bridges drop `APPROVALS_CHANGED`.
- On each snapshot, before the native notifier runs, every request not seen before gets its notice window: the focused window that shows its agent, else the main window (no main window, macOS: a window that shows the agent). The choice stays until the request is answered.
- `publishApprovals` sends the snapshot to every window. With agent windows open, each copy carries `notify`: the ids whose notice that window shows. The renderer shows an in-app toast only for those (and never for its own open agent, which shows the request in its chat). With no agent window open the push is exactly embedded's (no `notify`).
- OS notification: shown when the notice window does not have focus (`NativeNotifier` asks per request). A click focuses the notice window: an agent window gets `APPROVALS_REVEAL` and shows its chat; else the main window, as before.
- Agent windows show no approvals menu and no toasts. Their agent's requests show in their chat.
- An agent window that closes passes its pending notices to the main window. They stay in its list and the fleet map badge; no new toast is shown for them.
- Result: a notice is shown in one window, and a request is never without a window that lists it.

## 7. Restore

Code: `src/main/backend/agent-windows.ts`.

- Client key `agentWindows` (studio-client-settings.json, client file only): `{runtime, windows: [{agentId, filePath, bounds}]}`. `runtime` is `local`, or `remote:<connection name or URL>`.
- Written when an agent window opens or closes, 500 ms after it moves or is resized, and at quit (`freeze()`, before the shutdown closes any window). After `freeze()`, closes do not change it.
- Read when the main window is ready and the daemon is reached. A list saved for another runtime is ignored. Each entry is checked with `GET /files/agent/config?path=`: the file must exist and, when an id was saved, carry the same agent id. Entries that fail are dropped and the list is rewritten. Saved bounds are used when they overlap a display; otherwise only the size.
- An agent that already has a window is not opened twice.

## 8. Lifecycle

| Event | Result |
|---|---|
| Open in new window | `AgentWindows.open`: focus the agent's window, or create it (`BrowserWindow`, then `DaemonWindows.open`, then the page) |
| Agent window closed | Its session ends and releases its documents; it leaves the saved list |
| Main window closed, Windows and Linux | Studio quits, as today; agent windows close with it and stay saved |
| Main window closed, macOS | Studio stays open, as today; agent windows close and stay saved; reopening the main window (Dock) reopens them |
| Quit | The list is frozen and written; agent sessions end before the main session's quit request, so the daemon's "no other client session" rule (§8.3) sees only Studio's main session |
| Windows logoff | Same as quit, fast path |
| Remote runtime | Same as Local; all sessions use the one connection. A 401 ends every session |

## 9. Inside Studio (legacy)

Not offered. The main window's page has no `agentWindows=1` query, so the menu item and the title bar button are not shown, and `WINDOW_OPEN_AGENT` has no handler. The embedded boot is unchanged.

## 10. Not in step 1

- Several runtimes at once (step 2).
- Unsaved editor text of agent windows when the connection fails and Studio restarts: only the main window keeps recovery copies.
- Open in new window from the fleet map.
