# ADF TUI — contract for feature work

The TUI is a **client of the ADF daemon** (`docs/daemon/http-api.md`). It is
fleet-first: many agents, each with several **cognition loops**. Six feature
views sit on this foundation, one directory each. User docs:
`docs/cli/` (key reference: `docs/cli/reference.md`).

Run it: `npm run adf` (no command) · `npm run adf -- tui --view loops` ·
`npm run tui` · `npm run tui:mock` (in-memory mock daemon, no real daemon needed).

## 1. Ownership map

| Feature | Owns (edit freely) | View id / hotkey |
|---|---|---|
| fleet | `views/fleet/**` | `fleet` / `1` |
| chat | `views/chat/**` | `chat` / `2` |
| files | `views/files/**` (document, mind, files) | `files` / `3` |
| loops | `views/loops/**` | `loops` / `4` |
| commands / palette / inspect (the selected agent) | `views/inspect/**`, `commands/builtin/**`, `app/palette.tsx` | `inspect` / `5` |
| runtime (the daemon, every agent) | `views/runtime/**` (pages from `commands/builtin/reports.ts`) | `runtime` / `6` |

Shared (foundation — change deliberately, keep every view working): `api/**`, `state/**`, `identity/**` (owner identity + new agent dialogs), `auth/**` (provider sign-in), `web/**` (agent websites + the web server toggle), `setup/**` (welcome, channels, API-key providers), `app/**` (except
`app/palette.tsx`), `ui/**`, `commands/types.ts`, `commands/registry.ts`,
`views/types.ts`, `views/registry.ts`, `index.tsx`, `interop.ts`, `package.json`
(this dir), `CONTRACT.md`, and everything outside `src/main/tui` (daemon, CLI,
tests/tui/fixtures).

A view needing a shared change (store action, client method, primitive prop,
daemon endpoint) adds it there rather than working around it locally; tests
go in `tests/tui/`.

Each view directory default-exports a `ViewDefinition` from
`views/<id>/index.tsx`; `views/registry.ts` imports all six. Inspect is
about the selected agent only; anything daemon-wide (status, owner identity,
sign-in, providers, usage across agents, network, compute, daemon MCP /
adapters, settings, every agent's events) is a Runtime tab. Put
commands in `views/<id>/commands.ts` and spread them into the definition.

## 2. Loops (core concept — every conversation surface is loop-aware)

An agent's loops are its parallel chat sessions/threads, each with its own
history. `main` is the implicit host loop that talks to the owner. **Inner
loops** (`AgentConfig.loops`, `LoopConfig {name, goal, enabled, autostart?,
autonomous?, model?, compact_threshold?, tools?}`) are interior workers: a
`consolidator` that tidies memory on a timer, a `researcher`, a `critic`. A
timer with `loop` (or a trigger target with `loop`) is how an inner loop runs
on a schedule. Design: `docs/design/agent-loops-mvp.md`. User-facing prose says
"inner loops".

- Selection is **(agent, loop)**: `useSelectedAgentId()` + `useSelectedLoop()`
  (default `'main'`). `actions.selectLoop(agentId, name)` switches.
- Transcripts are keyed per (agent, loop): `useTranscript(agentId, loop)`.
- `actions.sendChat(text)` goes to the selected loop; `actions.interrupt()`
  ends the selected loop's turn and leaves it idle (daemon `/interrupt`).
  `actions.abort()` is the daemon's hard abort (the loop stays stopped until
  the agent is reloaded): only behind a confirmed fleet action.
- Events carry `event.loop` for inner loops (absent = main); the store routes
  them. `agent.state.changed` with a loop is that loop's state, not the agent's.
- Loop CRUD goes through the daemon's loop pool (validation, attenuation,
  owner locks, archive-on-delete): `createLoop / updateLoop / setLoopEnabled /
  deleteLoop / scheduleLoop`.

## 3. Views

```ts
// views/types.ts
interface ViewDefinition {
  id: string; title: string; key: string            // key: '1'..'9'
  component: ComponentType<ViewProps>
  sidebar?: ComponentType<SidebarProps>             // replaces the default (views/fleet/Sidebar: FleetSidebar)
  fullWidth?: boolean                               // hide the sidebar
  prompt?: PromptConfig | false                     // shell prompt config; false hides it
  keyHints?: KeyHintSpec[] | ((scope: CommandScope) => KeyHintSpec[])  // status bar
  commands?: SlashCommand[]; actions?: PaletteAction[]
  overlays?: Record<string, ComponentType<OverlayProps>>  // kind '<id>.<name>'
}
interface ViewProps { width: number; height: number; focused: boolean }   // focused = main zone (false while the tab bar has focus)
interface SidebarProps { width: number; height: number; focused: boolean }
interface PromptConfig {
  placeholder?: string | ((scope: CommandScope) => string)
  onSubmit?: (text: string, ctx: CommandContext) => boolean | Promise<boolean> // true = handled
  historyKey?: (scope) => string   // ↑ history per key (chat: per agent + loop)
  draftKey?: (scope) => string     // unsent text parked per key, restored on return
  complete?: (value, cursor, scope) => PromptCompletion[] | Promise<…>  // e.g. @path, Tab accepts
}
interface OverlayProps { overlay: Overlay; close(): void; width: number; height: number }
```

- The shell renders `component` inside the main pane with exact `width` ×
  `height`; a crash is contained by an error boundary.
- The **prompt** belongs to the shell (history, slash completion, paste,
  multiline). Slash input runs commands; other text goes to your
  `prompt.onSubmit`, else is sent as chat to the selected agent + loop.
- Open a dialog: `actions.pushOverlay({ kind: 'loops.new', props })`; register
  the component under `overlays['loops.new']`. Built-in kinds: `palette`,
  `help` (full keys/commands reference, also `?` and `/help`), `confirm` (use
  `await actions.confirm({...})`), `identity` (owner identity status /
  create / restore / unlock; props `IdentityOverlayProps`) and `new-agent`
  (the new-agent wizard) from `src/main/tui/identity/` — open them with
  `openIdentity(store, props)` / `openNewAgent(store, name?)`, and `auth`
  (provider sign-in, `src/main/tui/auth/`; props `{ login?: 'chatgpt'|'grok' }`),
  `terminal-setup` (Shift+Enter help, `app/terminal-setup.tsx`), and from
  `setup/`: `welcome` (`openWelcome(store)`), `channels` (`openChannels(store,
  {agentId?, channel?})`: the agent's channels, or one channel's setup form)
  and `provider.add` (`openProviderAdd(store, {preset?})`), `mcp`
  (`openMcp(store, {agentId?, add?, server?, view?})`); `templates` (agent
  templates, `src/main/tui/templates/`; props `{ id? }` opens one's details;
  `openTemplates(store, props)` routes through the identity dialog when it is
  not ready); `skills` (`openSkills(store, {agentId?, add?, skill?})` from
  `src/main/tui/skills/ops.ts`: installed skills; `add: ''` browses the
  catalog, a name searches it, an https SKILL.md URL or a local path previews
  that package; file-backed like Studio: install = resources then
  `skills/<name>/SKILL.md`, remove = SKILL.md first, mute = merge
  `skills-state.json`, never writes the registry; pure logic shared with
  Studio in `src/shared/utils/skills-panel.ts` / `skill-preview.ts`).
  `context` (`src/main/tui/context/`: one loop's context usage from GET
  /agents/:id/context; `openContext(store, {agentId, loop})`).
  `fleet.track` with props `{ folder, result? }` lists a tracked folder's
  agents and their next step (`openFolderAgents(store, folder, result?)` in
  `views/fleet/folders.ts`). Openers that take
  secrets route to the identity dialog first when it is not ready: its props
  `then` (an overlay kind) and `thenProps` open the dialog afterwards (never
  put secrets there).
  Dialogs are opaque (`ui/Modal` paints a fill
  layer), y/Enter confirms and n/Esc cancels everywhere, Ctrl+C cancels.
- Views are unmounted when switched away; keep cursor/filter state in
  `useViewState(viewId, initial)`.

## 4. Commands and palette

```ts
// commands/types.ts
interface SlashCommand {
  name: string; aliases?: string[]; args?: string; description: string
  available?(scope): boolean; complete?(partial, scope): string[]
  run(ctx: CommandContext): void | Promise<void>
}
interface PaletteAction { id: string /* '<view>.<verb>' */; title; hint?; group?; keywords?; shortcut?; available?; run(ctx) }
interface CommandContext {
  store; actions; client; state(): TuiState
  agentId: string | null; loop: string       // current selection
  args: string[]; rest: string                // quotes respected
  print(text, level?): void                   // toast
  exit(): void
}
```

`commands/registry.ts` collects builtins first, then views in registry order;
first registration of a name wins and collisions are listed in
`registry.conflicts` (a test asserts it is empty). Reserved names: builtins
`help ? quit exit q view agent a refresh r theme url auth login logout json
identity new sidebar mouse terminal-setup terminal web open-site site copy-site
welcome channels provider mcp templates skills context`; `runtime status usage
providers network compute settings events` belong to runtime; `loop main loops timers timer triggers history`
belong to loops; `abort interrupt clear compact trigger copy thinking approve reject` to
chat; `agents start stop unload load switch sw autostart` to fleet; `files
open edit doc document mind new-file rm mv` to files; `inspect model config tasks
instructions tools compaction` to inspect; `track untrack` to fleet. Pick new names inside your domain (`/loop …`, `/file …`,
`/task …`). Unknown `/x` is reported, never sent to an agent.

## 5. Store (`state/`)

One store per process (`createTuiStore({ client })`): reducer + effects + SSE.
Views read with hooks and act through `useActions()` only.

Hooks (`state/hooks.ts`): `useConnection() · useAgents() · useAgent(id) ·
useSelectedAgentId() · useSelectedAgent() · useSelectedLoop(agentId?) ·
useSelectedLoops() · useLoops(agentId) · useLoop(agentId, loop) ·
useTranscript(agentId, loop) · useActiveView() · useFocus() · useToasts() ·
useOverlays() · useTopOverlay() · useActivity() · usePendingHilCount() ·
useIdentity() ·
useViewState(viewId, initial) · useThrottledSelector(selector, ms)` (re-renders
at most every `ms`: firehose views like the event tail); plus `useTuiSelector(selector, isEqual?)`,
`shallowEqual`, `useStore()`, `useActions()`, `useClient()` from
`state/store.tsx`.

Actions (`TuiActions`): `refreshAgents · refreshAgent · refreshLoops ·
refreshHil · loadConfig · startAgent · stopAgent · interrupt(agentId?, loop?) · abort(agentId?, loop?) ·
setDisplayState · loadAgentFile · selectAgent · selectLoop · setView ·
setFocus · pushOverlay · popOverlay · confirm · toast · dismissToast ·
setViewState · prefillPrompt · ensureTranscript · loadTranscript · loadOlder ·
sendChat(text, {agentId?, loop?}) · clearLoopHistory · compactLoop ·
createLoop · updateLoop · setLoopEnabled · deleteLoop · scheduleLoop ·
resolveTask(agentId, taskId, action, reason?) (a deny reason reaches the agent as
feedback) · alwaysApproveTask · approveAllTasks(agentId, loop?) ·
answerAsk(agentId, requestId, answer, loop?) · respondSuspend ·
notice(agentId, loop, text, level?) · setDaemonUrl(url, token?) · refreshWeb ·
setWebServer(on) ·
run(label, client => …)`. `store.client` is a getter: `setDaemonUrl` swaps it. Every daemon-calling
action reports its outcome (toast or transcript item); `run` wraps any other
client call with the same policy.

Provider sign-in: `refreshAuth` (on connect, resync, `llm.failed` /
`agent.error`) · `logoutSubscription(provider)`; `useAuthNeed(agentId)` says
which subscription an agent needs and the daemon lacks. The sign-in flows
themselves are `auth/flow.ts` `signIn(client, provider, signal, handlers)`
over `cli/auth-flow.ts` (the same code as `adf auth login`); tests swap the
browser and poll sleep with `setAuthFlowSeams`.

Owner identity + agent creation: `refreshIdentity` (on connect and every
resync) · `createIdentity(passphrase?)` · `restoreIdentity(mnemonic,
passphrase?)` · `unlockIdentity` · `lockIdentity` · `confirmIdentityBackup` ·
`listTemplates` · `createAgent(input)`. These return an `Outcome<T>` (`{ ok,
value }` or `{ ok: false, error, code }`) because their dialogs show failures
inline by the daemon's `code`. **The seed phrase is returned to the caller of
`createIdentity` only**: keep it in component state, never in state, overlay
props, toasts, transcripts, logs or the clipboard.

Agent websites (`web/`): `refreshWeb` (on connect, resync, agent load /
unload, `config.changed` of serving, `mesh.*`, an agent's `sys_set_meta`, and
every 20s) reads `GET /network/mesh` (`meshServer` + per-agent
`publicEnabled / apiRouteCount / sharedCount / status`; falls back to `GET
/network/server`) and, on a `0.0.0.0` bind, `GET /network/mesh/lan-addresses`
into `state.web`. `setWebServer(on)` POSTs start / stop and toasts the state
(no confirm: `web/ops.ts` `toggleWebServer` asks before stopping).
`web/model.ts` `siteOf(state, agentId)` → `Site | null` (null = serves
nothing: show nothing) with `url` (the actual bound port; null while
stopped), `lanUrls`, what it serves; `web/ops.ts` `openSite` / `copySiteUrl`
start a stopped server first and open via `auth/flow.ts` `openUrl` (the CLI's
browser opener).

Stopped agents (`state/tracked.ts`): `state.tracked` holds the tracked
folders' agents that are not loaded (`stopped` in display order, `errors`
from failed loads, `busy`), refreshed by `refreshTracked` (connect, resync,
agent load / unload, track / untrack, every 15s). They are selectable:
`selectedAgentId` is then a `file:<path>` key (`isTrackedKey`), never a
daemon id, so guard per-agent calls; `useSelectedTracked()` /
`useTrackedAgent(key)` / `useTracked()` read them, and the reducer moves the
selection to the loaded agent when that file loads (and back when it
unloads). `startTracked(key, {start?})` loads (+ starts) one, or opens the
folder dialog's review (`fleet.track` with `{folder, review}`) when it needs
review; `sendChat` to a stopped agent starts it first. Command scopes give
such a selection as `stoppedKey` (with `agentId: null`). Views without an
agent show `StoppedAgentPanel` from `views/fleet/stopped.tsx` (s / Enter
start). The Fleet / sidebar filter (`all` | `running`) is
`useAgentsFilter` / `setAgentsFilter` there (pref `agents`).

State (`state/types.ts`): `TuiState { daemonUrl, connection, daemonReachable,
identity (GET /identity status, null on daemons without it), auth (GET
/runtime/auth), web (mesh web server + what agents serve, null until read), agents: Record<id, AgentEntry>, agentOrder, selectedAgentId, selectedLoop,
transcripts: Record<TranscriptKey, Transcript>, activeView, focus, overlays,
toasts, activity, lastEvents, viewState, tracked }`. `AgentEntry { summary, status?,
executorState?, loops?: LoopState[], config?, pendingTasks, pendingAsks,
tokens, lastModel?, unreadInbox, error? }`. `LoopState { info: LoopInfo,
executorState? }`.

Transcript items (`TranscriptItem`, discriminated by `kind`): `user {text,
origin: owner|loop|runtime, from?, pending?}` · `assistant {text, streaming,
model?}` · `thinking {text, streaming}` · `tool {toolUseId?, name, input,
status: running|ok|error, result?}` · `notice {text, level, event?}` · `hil
{taskId, tool, input, reason?, status: pending|approved|denied}` · `ask
{requestId, question, status, answer?}` · `error {text}` · `context {category,
text}` (system prompt, loop_inject, compaction summaries — render collapsed,
never drop). History comes from `GET /agents/:id/loop?loop=` (parsed by the
same `parseLoopToDisplay` Studio uses); live events add streaming text, tools,
HIL, asks and notices; `turn.completed` triggers a reconciling refetch. An
owner message sent here keeps the chat 202's `turnId`: events with that
`turn_id` mark it taken (no longer `[queued]`), its non-interrupted
`turn.completed` (or `absorbed_turn_ids`) marks it answered.
**Never hide model output** — every item kind must be renderable.

## 6. Daemon client (`api/`)

`runtime()` is normalized (`api/normalize.ts`): a partial or older daemon's
GET /runtime (missing sections, `providers: {}`) reads as empty, never
crashes a view. Read other responses defensively too.

`new DaemonClient({ baseUrl?, token?, fetch?, timeoutMs? })` — `baseUrl`
defaults like the CLI (`--url` → `ADF_DAEMON_URL` → `http://127.0.0.1:7385`),
token from `ADF_DAEMON_TOKEN`. All methods reject with `DaemonError { status,
body, unreachable }`. Types in `api/types.ts` are type-imported from the daemon
(`RuntimeService` / `http-api.ts`), so they track the real shapes.

- daemon: `health runtime providers authStatus runtimeSettings runtimeMcp
  runtimeAdapters network usage models settings setting putSetting`
  · compute / mesh: `computeStatus computeContainers meshStatus setMesh(on)
  meshServer meshServerAction(start|stop|restart) lanAddresses`
  · `withBaseUrl(url, token?)` (same transport, other daemon)
- sign-in: `subscriptionStatus(provider) logoutSubscription(provider)`
  (`authStatus` = GET /runtime/auth)
- owner identity + creation: `identity createIdentity(passphrase?)
  restoreIdentity(mnemonic, passphrase?) unlockIdentity lockIdentity
  confirmIdentityBackup templates createAgent({name?, template?, provider?,
  model?, start?})` (create/restore/unlock: loopback daemons only)
- agents: `agents agent status agentUsage load review acceptReview start stop
  unload interrupt(id, loop?) abort(id, loop?) compact(id, loop?) autostart(dirs, maxDepth?) setState`
- conversation: `chat(id, text, loop?) chatHistory(id, {loop, limit})
  clearChat(id, loop?) loopHistory(id, {loop, limit, offset}) trigger`
- loops: `loops loop createLoop updateLoop setLoopEnabled deleteLoop`
- resources: `config putConfig document putDocument mind putMind files file
  writeFile deleteFile renameFile renameFolder setFileProtection
  setFileAuthorized inbox clearInbox outbox timers createTimer({…, loop})
  updateTimer (a `loop` moves the timer) deleteTimer meta setMeta deleteMeta identities (metadata only)
  logs logsAfter tables table umbilicalReplay`
- HIL: `tasks task (pending entries carry canAlwaysApprove /
  alwaysApproveBlockedReason) resolveTask alwaysApproveTask(id, taskId)
  approveAllTasks(id, loop?) asks (each with its loop) answerAsk(…, loop?)
  respondSuspend`
- tracked folders: `trackedDirs trackDir(path) untrackDir(path, {unload?})
  folderAgents(path)` (GET /tracked-dirs/agents: each agent's status —
  loaded, needs_review, not_autostart, stopped + error, password_protected,
  unreadable) · `trackedAgents()` (GET /tracked-dirs/agents/all: every
  folder with its agents; falls back to per-folder reads on older daemons)
- tools: `agentTools(id)` (GET /agents/:id/tools: built-in + MCP + declared
  tools with declared state, source and description; read-only, writes go
  through `putConfig`; Inspect › Settings re-reads, applies Studio's lock /
  protection rules client-side — the owner PUT path does no lock checks —
  and PUTs only the edited fields)
- context: `agentContext(id, loop?, items?)` (GET /agents/:id/context:
  categories with top items, compactThreshold + source, totalTokens,
  percent, Studio's raw breakdown; computed by `src/shared/utils/context-breakdown.ts`)
- templates: `templates templateDetail(id) createTemplate({name, fromId?})
  updateTemplate(id, {name?, description?, warning?}) (a rename returns the
  new id) deleteTemplate(id) (moves the file to the daemon's templates-trash)
  setDefaultTemplate(id) resetTemplate(id) templateReview(id)
  acceptTemplateReview(id, password?) putTemplateConfig(id, config)
  putTemplateFile(id, path, content) removeTemplateFile(id, path)`
- channels (per agent; "channel adapters" in the API): `setAdapterCredential(id,
  type, envKey, value, {replace?})` (sealed in the agent's identity store) ·
  `adapterCredentials(id, type)` (metadata per env key: present, sealed,
  locked, length; never values) ·
  `attachAdapter(id, type, config)` (switches it on) · `detachAdapter(id,
  type)` (also deletes its credentials); live state: `agentAdapters`
- MCP servers (per agent): `attachMcpServer(id, server)` · `restartMcpServer(id,
  name)` (connects it now; the outcome has tools found or the error) ·
  `detachMcpServer(id, name, credentialNamespace?)` · `setMcpCredential(id,
  namespace, key, value, {replace?})` (sealed, `mcp:<package or name>:<KEY>`) ·
  `mcpCredentials(id, namespace)` (metadata only, like `adapterCredentials`) ·
  `installMcpPackage('npm'|'python', pkg)` (long timeout); live state:
  `agentMcp`
- locked credentials: a credential save answers 409 `credentials_locked`
  (`isCredentialsLocked(err)`) while the agent's credentials envelope is
  locked on the daemon. The channel / MCP dialogs then offer Unlock (identity
  flow, the setup resumes after) · Replace (confirmed; re-sends with
  `replace: true`, the old value is discarded unread) · Cancel (back to the
  form as typed). Edit forms show "set • (hidden)" / "set • locked" / "not
  set" from the metadata readers, never a value.
- API-key providers: `addProvider({type, name?, baseUrl?, defaultModel?,
  preset?, apiKey?})` (POST /runtime/providers: the key goes to the daemon's
  secret store, never the settings file, never returned) · `removeProvider(id)`
- diagnostics: `agentRuntime agentTriggers agentMcp agentAdapters agentWs`
- escape hatch: `request<T>(method, path, {query, body})`

SSE: `client.events({ onEvent, onState, agentId?, since?, replay? }).start()`
→ `EventStream` (fetch streaming, backoff reconnect with
`?since=<cursor>&epoch=<epoch>`, `onResume` verdict from `stream.hello` /
`stream.gap`: exact → refresh snapshots only, gap or daemon restart → full
resync incl. transcripts; a daemon without `stream.hello` gets the full resync
after 1.5 s; dedupe by `agent_id+seq`, idle watchdog, `connection` getter,
`close()`, `reconnect()`). The store owns the one live stream — views never open another.

## 7. Primitives (`ui/`)

`Panel` (titled border, focus accent) · `List` (↑↓/jk, PgUp/PgDn, Home/End,
Enter, `/` filter, windowed; controlled or not; `onKey` for row actions; the
wheel scrolls rows, or moves the selection with `wheelSelects`) · `TabStrip`
(tab row that slides to keep the active tab visible) ·
`ListRow` · `Table` (fixed/flex columns, selection) · `ScrollView`
(bottom-anchored, virtualized, key-anchored; `estimateHeight` per item;
`onReachTop` to page older history) · `TextInput` (multiline, history, paste, `mask` for secrets,
`onKey` pre-handler) · `views/loops/Form` (text / choice / combo / bool /
checklist fields; a text field with `mask: true` shows dots and the length,
never the value; used by the setup and identity dialogs too) ·
`Modal` / `Confirm` · `Markdown` / `Inline`
(markdown-lite) · `Spinner` · `KeyHint` / `KeyHints` · text helpers
(`displayWidth truncate fit oneLine wrappedHeight formatCount formatAgo
formatClock formatEveryMs previewJson wrapText`). Import from `ui/index.ts`.

## 8. Theme (`app/theme.ts`)

`useTheme()` → `{ name, mono, ascii, color, glyph }`. Use **semantic tokens
only**: `color.text muted dim accent live loop user assistant thinking tool
success warn error info border borderFocus selectionFg selectionBg surface
overlay`; `stateColor(theme, state)`. In mono (`NO_COLOR`, `--mono`,
`TERM=dumb`) every color is `undefined` — carry emphasis with `bold`,
`inverse` (`inverse={theme.mono && selected}`), `underline`. Glyphs:
`glyph.wordmark dot ring pointer bullet check cross warn arrow loop sep vbar
hbar ellipsis collapsed expanded spinner[]` with ASCII fallbacks
(`--ascii`, `ADF_TUI_ASCII=1`). No emoji; never lay out by glyph width.

## 9. Keys (`app/keys.tsx`)

The shell owns the only `useInput` and routes each key through layers until a
handler returns `true`: **overlay** (top dialog only) → **focused zone**
(`input` | `sidebar` | `main` | `tabs`, the header tab bar) → **view** (active
view, skipped while the prompt or the tab bar has focus) → **global**. Register with `useKeys(handler, { layer,
active })`; return `true` only for keys you consumed.

Reserved by the shell (never consume these unless in a text-entry mode); the
list lives in `app/shell-keys.ts` and feeds /help and docs/cli/reference.md:
`Ctrl+C` (cancel dialog / clear prompt / twice to quit), `Ctrl+K`, `Ctrl+P`
and `:` (palette), `Ctrl+B` (hide / show the sidebar, `app/layout.ts`), `Shift+←/→` and `Ctrl+←/→` (previous/next loop of the
selected agent; in a prompt with text Ctrl+←/→ jump words),
`Tab`/`Shift+Tab` (focus cycle; a hidden sidebar is skipped), digits `1`–`9` and `Alt+digit` (views), `?`
(help), `/` (prompt with slash; lists may claim `/` to filter while focused),
`Esc`: dialogs and the completion menu take it first, then the focused
zone / view (a filter, the file viewer, chat's interrupt from `view` and
`input` layers) — return `true` only when your view used it. Unclaimed, the
shell (global layer) moves focus to the tab bar (`tabs`) from the sidebar,
the main pane or an empty prompt; a prompt with text needs `Esc` twice to
clear (`DOUBLE_ESC_MS`), then the next `Esc` goes up. On the tab bar `←/→`
switch views live (`setView` then `setFocus('tabs')`), `Enter`/`↓` enter the
view (Chat: `input`, else `main`), digits jump in, `Tab`/`Shift+Tab` go to
the first / last pane, `w` toggles the web server. `setView('chat')` focuses
the prompt. Status-bar hints switch to `TAB_BAR_HINTS` while `tabs` has focus;
the list is `TAB_BAR_KEYS` in `app/shell-keys.ts`.

View-local conventions: `↑↓`/`j k` move, `Enter` open/act, `Space` toggle,
`n` new, `e` edit, `d`/`Del` delete (always via `actions.confirm`), `r`
refresh, `x` enable/disable, `/` filter within lists. Show them via `keyHints`.

External editor: `util/editor.ts` (`resolveEditor`: ADF_EDITOR → VISUAL →
EDITOR → notepad / nano / vi; `editText`; `runEditorProcess`). Hand the
terminal over with ink's `useApp().suspendTerminal(async () => …)`: ink turns
the kitty keyboard protocol off and back on around it, and mouse capture
follows raw mode (`app/terminal.ts`), so nothing else is needed.

Terminal modes (`app/terminal.ts`, installed by `index.tsx`): the kitty
keyboard protocol (flag 1) when the terminal answers ink's `CSI ? u` query, so
Shift+Enter arrives as `key.return && key.shift` (TextInput inserts a newline;
Ctrl+J also arrives as `ctrl` + `j`). The shell records every keypress's raw
bytes first (`lastRawInput()`): ink folds Backspace (DEL) and Ctrl+Backspace
(BS) together and reads a legacy `CSI 1;9D` (Cmd+←) as Alt+←; `ui/edit.ts`
maps the composer's line-editing keys from key + raw bytes.

Mouse mode is the default (`/mouse off`, `--no-mouse`, pref turn it off): SGR
mouse reporting with drags (1002 + 1006). The shell parses reports before any
key handler (they never reach a prompt): wheel notches go to the innermost
`useWheel` region under the pointer; presses, drags and releases go to the
selection controller (`app/selection.ts`): a drag highlights cells inside the
pane it started in and copies on release (double-click word, triple-click
line), a plain click goes to the innermost `useClick(ref, event => used)`
region (chat: select + expand an item; the approval card's buttons) and then
focuses the pane (the prompt keeps focus when the click was used), header
clicks switch tabs / toggle the web server (`HeaderHits` from
`app/Header.tsx`), right-click pastes the clipboard into the prompt (or the
focused dialog input). The cells come from `app/screen.ts`: every TUI write
is mirrored into an in-process `@xterm/headless` terminal (a runtime
dependency, bundled into the npm package); the highlight is painted as
reverse video straight to the terminal after each frame and cleared by
ink's full repaint; it drops itself when the text under it moves. Tests set
`setScreenText(frameScreen(frame, cols))` and swap the clipboard with
`setClipboardWriter` / `setClipboardReader` (`app/clipboard.ts`: native tools,
OSC 52 fallback and over SSH, `ADF_TUI_CLIPBOARD=osc52`). With mouse mode off
the terminal keeps its mouse and alternate scroll mode (DECSET 1007) sends
the wheel as ↑/↓ for the focused pane: chat coalesces a burst of arrows from
one read into a line scroll (never an item move, even over composer text; a
lone arrow selects an item or is replayed to the prompt).

Make a box scrollable with `useWheel(ref, delta => …, { layer })` (`delta` -1
up / +1 down per notch, move `WHEEL_STEP` rows; `layer: 'overlay'` inside
dialogs). `List`, `ScrollView`, `LinesView`, the sidebar, the files viewer,
the palette and the chat transcript already do. Chat moves an item selection
with ↑/↓ while the prompt is empty (`isPromptEmpty()`) or the transcript has
focus (Enter / Space expand, Esc lets go, a taller-than-view item scrolls
inside first: `navigate()` in `views/chat/model.ts`); prompt history is
Ctrl+↑/↓.

Persisted choices (`app/prefs.ts`, `<config dir>/adf-studio/tui-prefs.json`
or `ADF_TUI_PREFS`): sidebar hidden, the stopped-agents filter (`agents`), mouse mode (default on; `/mouse off`
is remembered), one-time tips, the welcome (`welcome.launches`: shown while
<= 3; `welcome.dismissed`: "don't show again"). Nothing secret goes there.

Status bar: a view's first `MAX_VIEW_HINTS` (5) `keyHints`, then `Tab` focus
and `Ctrl+K` palette (`GLOBAL_HINTS`). Put the primary keys first; the rest
belong in `helpKeys` (/help, which filters as you type).

## 10. Runtime notes

- `src/main/tui` is an **ES module scope** (`package.json` `"type":"module"`,
  ink is ESM with top-level await). Type-only imports from `src/main/**` /
  `src/shared/**` are fine; **value** imports from outside `src/main/tui` must
  use `import * as ns from '…'` + `cjs(ns)` from `interop.ts`.
- JSX: automatic runtime via `tsconfig.node.json` (`npm run adf|tui` pass
  `--tsconfig`); the entry also sets `globalThis.React` as a fallback.
- Typecheck: `npx tsc --noEmit -p tsconfig.node.json` (compare error counts;
  add zero). Tests: `npx vitest run tests/tui` (pure TUI tests don't touch
  better-sqlite3).
- Tests run in worker threads (`vitest.config.ts` project `tui`): the forks
  pool's workers die at teardown on Windows.
- Test tools: `tests/tui/fixtures/mock-daemon.ts` (`startMockDaemon()` →
  agent-1 with loops main/consolidator/researcher, a website (public/ + GET
  and WS routes), host access and a status line, agent-2 serving nothing;
  scripted streaming turns; `emit()`, `dropEventStreams()`; the web server
  as `mock.web` / option `web: {running, host, port}`; providers + models;
  `PUT config`), `tests/tui/fixtures/render.tsx`
  (`renderTui(<App …/>, {columns, rows})` → `press`, `raw`, `type`, `waitFor`,
  `resize`; mouse: write `\u001b[<64;x;yM` wheel reports, see
  `tests/tui/terminal.test.tsx`); see `tests/tui/shell.test.tsx` for the pattern.
  `tests/tui/fixtures/setup-daemon.ts` (`createSetupFetch(opts, next)`):
  channels (credentials, attach / detach, live state that comes up after a
  poll) and POST/DELETE /runtime/providers with the keys kept apart.
  `tests/tui/fixtures/templates-daemon.ts` (`createTemplatesFetch({locked?,
  passwordProtected?}, next)`: every /templates route in memory, `trash`,
  `state.defaultId`); `tests/tui/fixtures/settings-daemon.ts` (tools catalog,
  loop PATCH with compact_threshold, loop pages with tokens); the mock
  daemon's `folderFiles` (tracked folder autostart pass, review gate,
  GET /tracked-dirs/agents); skills: `setSkillsFetchSeams({catalog?, text?})`
  from `skills/catalog.ts` swaps the network.
  Fixtures use handles `agent-1`, `agent-2` and UUID ids — never personal
  names.
- Never hide model output or take silent auto-actions: anything the TUI does
  on its own (reconnect, resync, refetch) is visible (connection dot, toast,
  notice).
