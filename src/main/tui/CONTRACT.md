# ADF TUI — contract for feature work

The TUI is a **client of the ADF daemon** (`docs/daemon/http-api.md`). It is
fleet-first: many agents, each with several **cognition loops**. Six feature
views sit on this foundation, one directory each. User docs:
`docs/daemon/tui.md`.

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

Shared (foundation — change deliberately, keep every view working): `api/**`, `state/**`, `identity/**` (owner identity + new agent dialogs), `auth/**` (provider sign-in), `app/**` (except
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
interface ViewProps { width: number; height: number; focused: boolean }   // focused = main zone
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
  `terminal-setup` (Shift+Enter help, `app/terminal-setup.tsx`).
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
identity new sidebar mouse terminal-setup terminal`; `runtime status usage
providers network compute settings events` belong to runtime; `loop main loops timers timer triggers history`
belong to loops; `abort interrupt clear compact trigger copy thinking` to
chat; `agents start stop unload load switch sw autostart` to fleet; `files
open edit doc document mind new-file rm mv` to files; `inspect` to
inspect. Pick new names inside your domain (`/loop …`, `/file …`,
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
resolveTask · answerAsk(agentId, requestId, answer, loop?) · respondSuspend ·
notice(agentId, loop, text, level?) · setDaemonUrl(url, token?) ·
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

State (`state/types.ts`): `TuiState { daemonUrl, connection, daemonReachable,
identity (GET /identity status, null on daemons without it), auth (GET
/runtime/auth), agents: Record<id, AgentEntry>, agentOrder, selectedAgentId, selectedLoop,
transcripts: Record<TranscriptKey, Transcript>, activeView, focus, overlays,
toasts, activity, lastEvents, viewState }`. `AgentEntry { summary, status?,
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
HIL, asks and notices; `turn.completed` triggers a reconciling refetch.
**Never hide model output** — every item kind must be renderable.

## 6. Daemon client (`api/`)

`new DaemonClient({ baseUrl?, token?, fetch?, timeoutMs? })` — `baseUrl`
defaults like the CLI (`--url` → `ADF_DAEMON_URL` → `http://127.0.0.1:7385`),
token from `ADF_DAEMON_TOKEN`. All methods reject with `DaemonError { status,
body, unreachable }`. Types in `api/types.ts` are type-imported from the daemon
(`RuntimeService` / `http-api.ts`), so they track the real shapes.

- daemon: `health runtime providers authStatus runtimeSettings runtimeMcp
  runtimeAdapters network usage models settings setting putSetting`
  · compute / mesh: `computeStatus computeContainers meshStatus setMesh(on)
  meshServer meshServerAction(start|stop|restart)`
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
- HIL: `tasks task resolveTask asks (each with its loop) answerAsk(…, loop?)
  respondSuspend`
- diagnostics: `agentRuntime agentTriggers agentMcp agentAdapters agentWs`
- escape hatch: `request<T>(method, path, {query, body})`

SSE: `client.events({ onEvent, onState, agentId?, since?, replay? }).start()`
→ `EventStream` (fetch streaming, backoff reconnect with `?since=<cursor>`,
dedupe by `agent_id+seq`, idle watchdog, `connection` getter, `close()`,
`reconnect()`). The store owns the one live stream — views never open another.

## 7. Primitives (`ui/`)

`Panel` (titled border, focus accent) · `List` (↑↓/jk, PgUp/PgDn, Home/End,
Enter, `/` filter, windowed; controlled or not; `onKey` for row actions; the
wheel scrolls rows, or moves the selection with `wheelSelects`) · `TabStrip`
(tab row that slides to keep the active tab visible) ·
`ListRow` · `Table` (fixed/flex columns, selection) · `ScrollView`
(bottom-anchored, virtualized, key-anchored; `estimateHeight` per item;
`onReachTop` to page older history) · `TextInput` (multiline, history, paste, `mask` for secrets,
`onKey` pre-handler) · `Modal` / `Confirm` · `Markdown` / `Inline`
(markdown-lite) · `Spinner` · `KeyHint` / `KeyHints` · text helpers
(`displayWidth truncate fit oneLine wrappedHeight formatCount formatAgo
formatClock formatEveryMs previewJson`). Import from `ui/index.ts`.

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
(`input` | `sidebar` | `main`) → **view** (active view, skipped while the
prompt has focus) → **global**. Register with `useKeys(handler, { layer,
active })`; return `true` only for keys you consumed.

Reserved by the shell (never consume these unless in a text-entry mode); the
list lives in `app/shell-keys.ts` and feeds /help and docs/daemon/tui.md:
`Ctrl+C` (cancel dialog / clear prompt / twice to quit), `Ctrl+K`, `Ctrl+P`
and `:` (palette), `Ctrl+B` (hide / show the sidebar, `app/layout.ts`), `Shift+←/→` and `Ctrl+←/→` (previous/next loop of the
selected agent; in a prompt with text Ctrl+←/→ jump words),
`Tab`/`Shift+Tab` (focus cycle; a hidden sidebar is skipped), digits `1`–`9` and `Alt+digit` (views), `?`
(help), `/` (prompt with slash; lists may claim `/` to filter while focused),
`Esc` (closes dialogs and the completion menu; leaves the sidebar but never
the prompt — views may claim `Esc` first, e.g. chat interrupts a running turn
from `view` and `input` layers). `setView('chat')` focuses the prompt.

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
Ctrl+J also arrives as `ctrl` + `j`). SGR mouse reporting (1000 + 1006) in the
alternate screen: the shell parses reports before any key handler (they never
reach a prompt) and routes wheel notches to the innermost region under the
pointer. Make a box scrollable with `useWheel(ref, delta => …, { layer })`
(`delta` -1 up / +1 down per notch, move `WHEEL_STEP` rows; `layer: 'overlay'`
inside dialogs). `List`, `ScrollView`, `LinesView`, the sidebar, the files
viewer, the palette and the chat transcript already do. Chat also scrolls
its transcript with ↑/↓ while the prompt is empty (`isPromptEmpty()`); prompt
history is Ctrl+↑/↓.

Persisted choices (`app/prefs.ts`, `<config dir>/adf-studio/tui-prefs.json`
or `ADF_TUI_PREFS`): sidebar hidden, mouse capture, one-time tips. Nothing
secret goes there.

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
  agent-1 with loops main/consolidator/researcher, agent-2; scripted streaming
  turns; `emit()`, `dropEventStreams()`), `tests/tui/fixtures/render.tsx`
  (`renderTui(<App …/>, {columns, rows})` → `press`, `raw`, `type`, `waitFor`,
  `resize`; mouse: write `\u001b[<64;x;yM` wheel reports, see
  `tests/tui/terminal.test.tsx`); see `tests/tui/shell.test.tsx` for the pattern.
  Fixtures use handles `agent-1`, `agent-2` and UUID ids — never personal
  names.
- Never hide model output or take silent auto-actions: anything the TUI does
  on its own (reconnect, resync, refetch) is visible (connection dot, toast,
  notice).
