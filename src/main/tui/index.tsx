// ADF TUI entry: `npm run adf` (no command), `npm run adf -- tui`, `npm run tui`.
// A client of the daemon — quitting leaves every agent running.

// Only modules that do not load React are imported statically (see
// preferProductionReact); the rest come in with `import()` in runTui.
import { DaemonClient } from './api/client'
import * as daemonUrlNs from '../cli/daemon-url'
import { cjs } from './interop'
import { defaultPrefsPath, loadPrefs, savePrefs } from './app/prefs'

const { resolveDaemonUrl } = cjs(daemonUrlNs)

/**
 * React and ink pick their build when first loaded: without NODE_ENV they
 * load the development build, which renders several times slower (dev-only
 * checks, component performance tracks) and made scrolling feel laggy. The
 * TUI is a shipped program, so it runs the production build unless the
 * caller set NODE_ENV (tests: 'test'). React is therefore only imported
 * dynamically, after this runs.
 */
export function preferProductionReact(env: NodeJS.ProcessEnv = process.env): void {
  env.NODE_ENV ??= 'production'
}

export interface TuiOptions {
  url?: string
  token?: string
  view?: string
  agent?: string
  loop?: string
  mono?: boolean
  ascii?: boolean
  theme?: string
  altScreen: boolean
  /** Mouse mode this session: true (--mouse, ADF_TUI_MOUSE=1; the default), false (--no-mouse, ADF_TUI_MOUSE=0: the terminal's own mouse). */
  mouse?: boolean
  /** false: never enable the kitty keyboard protocol (--no-kitty, ADF_TUI_KITTY=0). */
  kitty?: boolean
  help: boolean
}

export interface TuiIo {
  stdout: NodeJS.WriteStream
  stdin: NodeJS.ReadStream
  stderr: NodeJS.WriteStream
  env: NodeJS.ProcessEnv
  /** Transport for the daemon client (tests and `tui:mock` layer fixtures here). */
  fetch?: typeof fetch
}

export function tuiUsage(): string {
  return `Usage: adf [tui] [options]

The ADF terminal app: your fleet of agents, each agent's
loops, chat, files, approvals and live umbilical events. Loops are an agent's
separate chat sessions (threads): main talks to you; inner loops (side loops)
such as a memory consolidator on a nightly timer or a researcher work on their
own goal, on demand or on a schedule.

Options:
  --url, -u <url>      Daemon URL (default ADF_DAEMON_URL or ${resolveDaemonUrl(undefined, {})})
  --token <token>      Bearer token (default: ADF_DAEMON_TOKEN, else the local daemon's token file)
  --view <id>          Start view: chat | files | loops | inspect | fleet | runtime
  --agent <id|handle>  Preselect an agent
  --loop <name>        Preselect one of its loops (default main)
  --theme <name>       adf (dark) | adf-light | adf-contrast | adf-mono (also ADF_TUI_THEME)
  --mono               No color (also NO_COLOR=1)
  --ascii              ASCII glyphs (also ADF_TUI_ASCII=1)
  --no-alt-screen      Render in the main screen buffer (also turns mouse mode off)
  --mouse              Mouse mode, the default: the wheel scrolls what is under the pointer, a click
                       expands a tool call or thinking, drag selects and copies, right-click pastes
                       (Shift+drag, Option+drag in iTerm2: the terminal's own selection)
  --no-mouse           The terminal's own mouse (also ADF_TUI_MOUSE=0, /mouse off; remembered)
  --no-kitty           Never enable the kitty keyboard protocol (Shift+Enter; also ADF_TUI_KITTY=0)
  -h, --help           Show this help`
}

export function parseTuiArgs(argv: string[]): TuiOptions {
  const options: TuiOptions = { altScreen: true, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => {
      const next = argv[++i]
      if (next === undefined) throw new Error(`${arg} requires a value`)
      return next
    }
    if (arg === '--url' || arg === '-u') options.url = value()
    else if (arg.startsWith('--url=')) options.url = arg.slice(6)
    else if (arg === '--token') options.token = value()
    else if (arg === '--view') options.view = value()
    else if (arg === '--agent') options.agent = value()
    else if (arg === '--loop') options.loop = value()
    else if (arg === '--theme') options.theme = value()
    else if (arg.startsWith('--theme=')) options.theme = arg.slice(8)
    else if (arg === '--mono' || arg === '--no-color') options.mono = true
    else if (arg === '--ascii') options.ascii = true
    else if (arg === '--no-alt-screen') options.altScreen = false
    else if (arg === '--no-mouse') options.mouse = false
    else if (arg === '--mouse') options.mouse = true
    else if (arg === '--no-kitty') options.kitty = false
    else if (arg === '-h' || arg === '--help') options.help = true
    else if (arg === 'tui') continue
    else throw new Error(`Unknown option: ${arg}`)
  }
  return options
}

const defaultIo = (): TuiIo => ({ stdout: process.stdout, stdin: process.stdin, stderr: process.stderr, env: process.env })

type ThemesModule = typeof import('./commands/builtin/themes')

/** `--theme` / ADF_TUI_THEME. NO_COLOR and --mono always win: color stays off. */
function resolveThemeChoice(options: TuiOptions, env: NodeJS.ProcessEnv, { THEMES, findTheme }: ThemesModule): { name?: string; error?: string } {
  const wanted = options.theme ?? env.ADF_TUI_THEME
  if (!wanted) return {}
  if (!findTheme(wanted)) return { error: `Unknown theme "${wanted}". Themes: ${THEMES.map(t => t.name).join(', ')}` }
  return { name: wanted }
}

/** Run the TUI until the user quits. Returns the process exit code. */
export async function runTui(argv: string[] = process.argv.slice(2), io: TuiIo = defaultIo()): Promise<number> {
  let options: TuiOptions
  try {
    options = parseTuiArgs(argv)
  } catch (err) {
    io.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${tuiUsage()}\n`)
    return 2
  }
  if (options.help) {
    io.stdout.write(`${tuiUsage()}\n`)
    return 0
  }
  if (!io.stdout.isTTY || !io.stdin.isTTY) {
    io.stderr.write(
      'adf: the terminal app needs a terminal (stdin and stdout must be a TTY).\n' +
      'For scripts and pipes use one-shot commands, e.g. `adf agents` or `adf --help`.\n',
    )
    return 1
  }

  preferProductionReact()
  const [
    { default: React }, { render }, { App }, themes, { createTuiStore }, { createTheme },
    { installTerminalModes, shiftEnterWorks, terminalCaps }, { LAYOUT_STATE_KEY },
  ] = await Promise.all([
    import('react'), import('ink'), import('./app/App'), import('./commands/builtin/themes'), import('./state/store'),
    import('./app/theme'), import('./app/terminal'), import('./app/layout'),
  ])
  // What is on screen, for mouse selection (alternate screen only). Best effort.
  const { installScreenMirror } = await import('./app/screen')
  const uninstallMirror = options.altScreen ? await installScreenMirror(io.stdout).catch(() => () => {}) : () => {}
  // tsx only applies tsconfig JSX settings when run with --tsconfig; the classic
  // transform then needs React in scope. Harmless under the automatic runtime.
  ;(globalThis as { React?: typeof React }).React ??= React
  const { applyTheme, findTheme } = themes

  const themeChoice = resolveThemeChoice(options, io.env, themes)
  if (themeChoice.error) {
    io.stderr.write(`${themeChoice.error}\n`)
    return 2
  }

  const client = new DaemonClient({ baseUrl: options.url, token: options.token, fetch: io.fetch, localToken: true, env: io.env })
  const store = createTuiStore({ client, initialView: options.view })
  const prefs = loadPrefs(defaultPrefsPath(io.env))
  if (prefs.sidebar === false) store.actions.setViewState(LAYOUT_STATE_KEY, { sidebarHidden: true })
  // Mouse mode is the default (in-app selection keeps drag-to-copy); /mouse off is remembered. The flag / env win over the saved choice.
  const mouse = options.mouse ?? (io.env.ADF_TUI_MOUSE === '0' ? false : io.env.ADF_TUI_MOUSE === '1' ? true : prefs.mouse ?? true)
  const kitty = options.kitty ?? io.env.ADF_TUI_KITTY !== '0'
  const uninstallModes = installTerminalModes({
    stdin: io.stdin,
    stdout: io.stdout,
    mouse,
    altScreen: options.altScreen,
    shiftEnterForced: io.env.ADF_TUI_SHIFT_ENTER === '1',
  })
  const theme = createTheme({ mono: options.mono, ascii: options.ascii, env: io.env })
  const choice = themeChoice.name ? findTheme(themeChoice.name) : undefined
  if (choice && !theme.mono) applyTheme(theme, choice)

  // Incremental rendering rewrites only the lines that changed (streaming
  // stays cheap and flicker-free). Its erase-to-end-of-line would eat a
  // full-width line's last cell, so the rightmost column stays unused. Windows
  // consoles scroll when the bottom-right cell is written, so ink clears the
  // whole screen for frames that fill it: the last row stays unused there.
  const reserveRows = process.platform === 'win32' && io.env.ADF_TUI_FULL_HEIGHT !== '1' ? 1 : 0
  const instance = render(React.createElement(App, { store, theme, reserveRows, reserveColumns: 1 }), {
    stdout: io.stdout,
    stdin: io.stdin,
    stderr: io.stderr,
    exitOnCtrlC: false,
    alternateScreen: options.altScreen,
    patchConsole: true,
    maxFps: 30,
    incrementalRendering: true,
    // Shift+Enter: ask the terminal (CSI ? u) and turn on "disambiguate" when
    // it answers. ink restores the mode on exit, crash and suspendTerminal.
    kittyKeyboard: kitty ? { mode: 'auto', flags: ['disambiguateEscapeCodes'] } : { mode: 'disabled' },
  })

  // One-time tip where Shift+Enter cannot be told from Enter.
  const tipTimer = setTimeout(() => {
    if (shiftEnterWorks(terminalCaps()) || prefs.tips?.shiftEnter) return
    savePrefs({ tips: { shiftEnter: true } })
    store.actions.toast('This terminal sends Shift+Enter as Enter: Alt+Enter or Ctrl+J add a newline · /terminal-setup to fix', 'info', 8000)
  }, 1500)

  void store.start().then(async () => {
    // First few launches: the welcome opens over the normal UI (Esc closes it).
    const { recordWelcomeLaunch } = await import('./setup/welcome')
    if (recordWelcomeLaunch()) {
      const { openWelcome } = await import('./setup/open')
      openWelcome(store)
    }
    if (!options.agent) return
    const state = store.getState()
    const id = state.agentOrder.find(agentId => {
      const summary = state.agents[agentId]?.summary
      return agentId === options.agent || summary?.handle === options.agent || summary?.name === options.agent
    })
    if (!id) {
      store.actions.toast(`No loaded agent "${options.agent}"`, 'warn')
      return
    }
    store.actions.selectAgent(id)
    if (options.loop) store.actions.selectLoop(id, options.loop)
  })

  try {
    await instance.waitUntilExit()
  } finally {
    clearTimeout(tipTimer)
    store.stop()
    uninstallMirror()
    uninstallModes()
  }
  io.stdout.write(`Left the ADF terminal app. Agents keep running in the daemon at ${client.baseUrl}.\n`)
  return 0
}

const entry = process.argv[1] ?? ''
if (/[\\/]tui[\\/]index\.tsx?$/.test(entry)) {
  runTui().then(code => { process.exitCode = code }, err => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
    process.exitCode = 1
  })
}
