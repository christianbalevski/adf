// Generates docs/cli/reference.md from the code: `adf help`, `adf daemon
// --help`, `adf tui --help`, the terminal app's command registry (builtin
// commands + the six views), its palette actions, the shell keys
// (app/shell-keys.ts) and every view's helpKeys, plus the environment
// variables the CLI and terminal app read.
//
//   npm run docs:cli            regenerate
//   npm run docs:cli -- --check exit 1 when the file on disk is stale (CI)
//
// Deterministic: no timestamps, no machine paths, no daemon, no TTY.

import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { runCli } from '../src/main/cli/index'

const ROOT = resolve(__dirname, '..')
const OUT = join(ROOT, 'docs', 'cli', 'reference.md')

// ---------------------------------------------------------------------------
// Help texts
// ---------------------------------------------------------------------------

async function cliHelp(): Promise<string> {
  let out = ''
  const code = await runCli(['help'], { fetch: globalThis.fetch, stdout: t => { out += t }, stderr: t => { out += t } })
  if (code !== 0) throw new Error(`adf help exited ${code}`)
  return out.trimEnd()
}

/** `adf daemon --help` lives in bin.ts (which runs on import), so run it. */
function daemonHelp(): string {
  const res = spawnSync(process.execPath, [...process.execArgv, join(ROOT, 'src', 'main', 'cli', 'bin.ts'), 'daemon', '--help'], {
    cwd: ROOT,
    encoding: 'utf-8',
    env: { ...process.env, ADF_NO_AUTOSTART: '1' },
    windowsHide: true,
  })
  if (res.status !== 0) throw new Error(`adf daemon --help exited ${res.status}: ${res.stderr}`)
  return res.stdout.replace(/\r\n/g, '\n').trimEnd()
}

// ---------------------------------------------------------------------------
// Help-text parsing: "  name   description" rows with continuation lines
// ---------------------------------------------------------------------------

interface Row { name: string; desc: string }

/** Rows of one `Title:` section of a help text. */
function sectionRows(help: string, title: string): Row[] {
  const lines = help.split('\n')
  const start = lines.findIndex(l => l.trim() === `${title}:`)
  if (start < 0) throw new Error(`No "${title}:" section in help`)
  const body: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || !line.startsWith(' ')) break
    body.push(line)
  }
  // The description column: where most rows' descriptions start. A name that
  // runs right up to it is separated by one space only.
  const starts = new Map<number, number>()
  for (const line of body) {
    const m = /^ {2}\S.*?\s{2,}(\S)/.exec(line)
    if (m) starts.set(m[0].length - 1, (starts.get(m[0].length - 1) ?? 0) + 1)
  }
  const descCol = [...starts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? -1
  const rows: Row[] = []
  for (const line of body) {
    const indent = line.length - line.trimStart().length
    let [name, ...rest] = line.trim().split(/\s{2,}/)
    if (indent <= 2 && rest.length === 0 && descCol > 0 && line.length > descCol && line[descCol - 1] === ' ' && line[descCol] !== ' ') {
      name = line.slice(0, descCol).trim()
      rest = [line.slice(descCol).trim()]
    }
    if (indent <= 2) rows.push({ name, desc: rest.join(' ') })
    else if (indent < 20 && rows.length) {
      const row = rows[rows.length - 1]
      row.name = `${row.name} ${name}`
      row.desc = [row.desc, rest.join(' ')].filter(Boolean).join(' ')
    } else if (rows.length) {
      const row = rows[rows.length - 1]
      row.desc = [row.desc, line.trim()].filter(Boolean).join(' ')
    }
  }
  return rows
}

// ---------------------------------------------------------------------------
// Markdown helpers
// ---------------------------------------------------------------------------

const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()
const code = (text: string): string => `\`${cell(text)}\``

function table(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
    ...rows.map(r => `| ${r.join(' | ')} |`),
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Environment variables
// ---------------------------------------------------------------------------

type Scope = 'CLI' | 'terminal app' | 'daemon' | 'CLI, terminal app'

/** Every variable the scan finds must be described here; the generator fails otherwise. */
const ENV_DOCS: Record<string, { scope: Scope; desc: string }> = {
  ADF_DAEMON_URL: { scope: 'CLI, terminal app', desc: 'Daemon URL (default `http://127.0.0.1:7385`); `--url` wins' },
  ADF_DAEMON_TOKEN: { scope: 'CLI, terminal app', desc: 'Daemon access token. Clients: sent as the bearer token (`--token` wins). Daemon: used instead of the `<data dir>/daemon-token` file; required with a non-loopback `--host`' },
  ADF_NO_AUTOSTART: { scope: 'CLI, terminal app', desc: '`1`: never start the daemon automatically (same as `--no-daemon`)' },
  ADF_DAEMON_PORT: { scope: 'daemon', desc: 'Port for `adf daemon` (default `7385`); `adf daemon <sub>` also uses it when no `--url` / `--port` is given' },
  ADF_DAEMON_HOST: { scope: 'daemon', desc: 'Bind address for `adf daemon` (default `127.0.0.1`). Non-loopback needs `ADF_DAEMON_TOKEN`' },
  ADF_DAEMON_SETTINGS: { scope: 'daemon', desc: 'Settings file path; its folder is the data dir (token, pid file, logs, identity file). Clients use it to find the local token file' },
  ADF_USER_DATA_DIR: { scope: 'daemon', desc: 'Overrides the user data folder that holds the default settings file (shared with ADF Studio)' },
  ADF_DAEMON_PIDFILE: { scope: 'daemon', desc: 'Pid file path (default `<data dir>/adf-daemon.pid`, `adf-daemon-<port>.pid` for other ports)' },
  ADF_DAEMON_ALLOWED_HOSTS: { scope: 'daemon', desc: 'Extra Host names a non-loopback daemon accepts (comma or space separated, `name` or `name:port`): the names remote clients or a proxy use' },
  ADF_OWNER_PASSPHRASE: { scope: 'daemon', desc: 'Unlocks a passphrase-file owner identity at daemon start (machines without an OS keychain)' },
  ADF_OWNER_PASSPHRASE_FILE: { scope: 'daemon', desc: 'Same, read from the first line of this file' },
  ADF_SECRET_STORE: { scope: 'daemon', desc: '`file` or `keychain`: where the owner phrase and provider keys are kept (default: the OS keychain when usable, else the passphrase file)' },
  ADF_KEYCHAIN: { scope: 'daemon', desc: '`0` or `off`: never use the OS keychain' },
  ADF_TUI_THEME: { scope: 'terminal app', desc: 'Same as `--theme`' },
  ADF_TUI_ASCII: { scope: 'terminal app', desc: '`1`: same as `--ascii`' },
  ADF_TUI_MOUSE: { scope: 'terminal app', desc: '`0`: the terminal\'s own mouse, `1`: mouse mode; wins over the saved `/mouse` choice' },
  ADF_TUI_KITTY: { scope: 'terminal app', desc: '`0`: same as `--no-kitty`' },
  ADF_TUI_SHIFT_ENTER: { scope: 'terminal app', desc: '`1`: treat Shift+Enter as working from the start (your terminal sends it through a keybinding)' },
  ADF_TUI_FULL_HEIGHT: { scope: 'terminal app', desc: '`1`: Windows: also use the bottom terminal row' },
  ADF_TUI_CLIPBOARD: { scope: 'terminal app', desc: '`osc52`: copy only through the terminal (OSC 52), never pbcopy / clip / wl-copy / xclip' },
  ADF_TUI_PREFS: { scope: 'terminal app', desc: 'Where sidebar, mouse, stopped-agents filter and welcome choices are kept (default `<config dir>/adf-studio/tui-prefs.json`); `off`: session only' },
  ADF_EDITOR: { scope: 'terminal app', desc: 'External editor, before `VISUAL` and `EDITOR` (default `notepad` on Windows, else `nano`, then `vi`)' },
  VISUAL: { scope: 'terminal app', desc: 'External editor when `ADF_EDITOR` is not set' },
  EDITOR: { scope: 'terminal app', desc: 'External editor when `ADF_EDITOR` and `VISUAL` are not set' },
  NO_COLOR: { scope: 'terminal app', desc: 'Any value: no color (same as `--mono`); wins over `--theme`' },
  TERM: { scope: 'terminal app', desc: '`dumb`: no color' },
}

/** Read by the code but not user settings. */
const ENV_IGNORED = new Set(['ADF_NODE_ENV_DEFAULTED'])
/** Relevant to CLI users though read outside src/main/{cli,tui}. */
const ENV_EXTRA = ['ADF_OWNER_PASSPHRASE', 'ADF_OWNER_PASSPHRASE_FILE', 'ADF_SECRET_STORE', 'ADF_KEYCHAIN']

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
    else if (/\.tsx?$/.test(name)) out.push(path)
  }
  return out
}

/** Variables the CLI / terminal app code reads, plus those its help texts name. */
function scanEnv(helpTexts: string[]): string[] {
  const found = new Set<string>(ENV_EXTRA)
  for (const text of helpTexts) {
    for (const m of text.matchAll(/\b(ADF_[A-Z0-9_]+)\b/g)) if (!ENV_IGNORED.has(m[1])) found.add(m[1])
  }
  const files = [...sourceFiles(join(ROOT, 'src', 'main', 'cli')), ...sourceFiles(join(ROOT, 'src', 'main', 'tui'))]
  for (const file of files) {
    const text = readFileSync(file, 'utf-8')
    for (const m of text.matchAll(/\benv(?:\.|\[['"])([A-Z][A-Z0-9_]*)/g)) {
      const name = m[1]
      if (ENV_IGNORED.has(name)) continue
      if (name.startsWith('ADF_') || name in ENV_DOCS) found.add(name)
    }
  }
  const missing = [...found].filter(name => !ENV_DOCS[name])
  if (missing.length) {
    throw new Error(`Undocumented environment variable(s): ${missing.join(', ')}. Describe them in ENV_DOCS in ${relative(ROOT, __filename)}.`)
  }
  return Object.keys(ENV_DOCS).filter(name => found.has(name))
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

async function build(): Promise<string> {
  const [
    { tuiUsage },
    { VIEWS },
    { BUILTIN_COMMANDS },
    { collectCommands },
    shellKeys,
    { keyLabel },
  ] = await Promise.all([
    import('../src/main/tui/index'),
    import('../src/main/tui/views/registry'),
    import('../src/main/tui/commands/builtin/index'),
    import('../src/main/tui/commands/registry'),
    import('../src/main/tui/app/shell-keys'),
    import('../src/main/tui/app/keys'),
  ])

  const keys = (spec: string): string => spec.split(' ').filter(Boolean).map(k => code(k === 'space' ? 'Space' : keyLabel(k))).join(' ')
  const help = await cliHelp()
  const dHelp = daemonHelp()
  const tHelp = tuiUsage()

  const out: string[] = []
  const h = (text: string) => out.push(text, '')

  h('# ADF CLI reference')
  h('<!-- GENERATED by scripts/gen-cli-docs.ts from the code. Do not edit: run `npm run docs:cli`. CI fails when this file is stale. -->')
  h('Everything `adf` accepts, and every command and key of the terminal app, generated from the code. For task-oriented guides see the [ADF CLI docs](index.md).')
  h('- [Command line](#command-line): [commands](#commands), [daemon](#daemon), [options](#options), [terminal app options](#terminal-app-options), [environment](#environment)\n- [Terminal app](#terminal-app): [views](#views), [slash commands](#slash-commands), [palette actions](#palette-actions), [keys](#keys)')

  // --- command line --------------------------------------------------------
  h('## Command line')
  h('```text\n' + help.split('\n').filter(l => l.startsWith('Usage:') || l.startsWith('       adf')).join('\n') + '\n```')
  h('With no command, `adf` opens the terminal app. Commands that talk to the daemon start a local one in the background first when none answers (not with `--no-daemon` / `ADF_NO_AUTOSTART=1`, a remote `--url`, or next to a running ADF Studio). `<agent>` is an agent id, handle or name.')

  h('### Commands')
  h(table(['Command', 'Description'], sectionRows(help, 'Commands').map(r => [code(`adf ${r.name}`), cell(r.desc)])))

  h('### Daemon')
  h(table(['Command', 'Description'], sectionRows(help, 'Daemon').map(r => [code(`adf ${r.name}`), cell(r.desc)])))
  h('`adf daemon --help`:')
  h('```text\n' + dHelp + '\n```')

  h('### Options')
  h(table(['Option', 'Description'], sectionRows(help, 'Options').map(r => [code(r.name), cell(r.desc)])))

  h('### Terminal app options')
  h('`adf [tui] [options]` (`adf tui --help`). Any of these flags opens the terminal app.')
  h(table(['Option', 'Description'], sectionRows(tHelp, 'Options').map(r => [code(r.name), cell(r.desc)])))

  h('### Environment')
  h(table(['Variable', 'Used by', 'Effect'], scanEnv([help, dHelp, tHelp]).map(name => [code(name), ENV_DOCS[name].scope, ENV_DOCS[name].desc])))

  // --- terminal app ---------------------------------------------------------
  h('## Terminal app')

  h('### Views')
  h(table(['Key', 'View', 'Id (`--view`, `/view`)'], VIEWS.map(v => [code(v.key), cell(v.title), code(v.id)])))

  const registry = collectCommands(VIEWS, [BUILTIN_COMMANDS])
  if (registry.conflicts.length) throw new Error(`Command registry conflicts:\n${registry.conflicts.join('\n')}`)
  const owners = ['builtin', ...VIEWS.map(v => v.id)]
  const ownerTitle = (owner: string) => owner === 'builtin' ? 'Shell (every view)' : `${VIEWS.find(v => v.id === owner)?.title ?? owner} view`

  h('### Slash commands')
  h('Type `/` in the prompt; `Tab` completes names and arguments. Commands work from any view (some need a selected agent); the group is the view that owns it, and usually the one it opens. Unknown commands are reported, never sent to an agent.')
  for (const owner of owners) {
    const commands = registry.commands.filter(c => (c.view ?? 'builtin') === owner)
    if (!commands.length) continue
    h(`#### ${ownerTitle(owner)}`)
    h(table(['Command', 'Aliases', 'Description'], commands.map(c => [
      code(`/${c.name}${c.args ? ` ${c.args}` : ''}`),
      (c.aliases ?? []).map(a => code(`/${a}`)).join(' '),
      cell(c.description),
    ])))
  }

  h('### Palette actions')
  h('`Ctrl+K` (or `Ctrl+P`, or `:` outside the prompt) searches these, plus views, agents, loops, slash commands and recent files.')
  for (const owner of owners) {
    const actions = registry.actions.filter(a => (a.view ?? 'builtin') === owner)
    if (!actions.length) continue
    h(`#### ${ownerTitle(owner)}`)
    h(table(['Action', 'Group', 'Shortcut'], actions.map(a => [cell(a.title), cell(a.group ?? ''), a.shortcut ? keys(a.shortcut) : ''])))
  }

  h('### Keys')
  h('The same lists as `?` / `/help` in the app.')
  h('#### Global')
  h(table(['Keys', 'Action'], shellKeys.SHELL_KEYS.map(k => [keys(k.keys), cell(k.label)])))
  h('#### Tab bar')
  h('`Esc` focuses the view tabs in the header once nothing else takes it.')
  h(table(['Keys', 'Action'], shellKeys.TAB_BAR_KEYS.map(k => [keys(k.keys), cell(k.label)])))
  h('#### Sidebar')
  h(table(['Keys', 'Action'], shellKeys.SIDEBAR_KEYS.map(k => [keys(k.keys), cell(k.label)])))
  h('#### Dialogs')
  h(table(['Keys', 'Action'], shellKeys.CONFIRM_KEYS.map(k => [keys(k.keys), cell(k.label)])))
  for (const view of VIEWS) {
    h(`#### ${view.key} ${view.title}`)
    const sections = view.helpKeys ?? [{ keys: Array.isArray(view.keyHints) ? view.keyHints : [] }]
    for (const section of sections) {
      if (section.title) h(`${cell(section.title)}:`)
      h(table(['Keys', 'Action'], section.keys.map(k => [keys(k.keys), cell(k.label)])))
    }
  }
  h('#### Legend')
  h(table(['Glyph', 'Meaning'], shellKeys.GLYPHS.map(g => [code(g.glyph), cell(g.label)])))

  return `${out.join('\n').trimEnd()}\n`
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check')
  const text = await build()
  if (check) {
    let current = ''
    try { current = readFileSync(OUT, 'utf-8').replace(/\r\n/g, '\n') } catch { /* missing */ }
    if (current !== text) {
      process.stderr.write(`${relative(ROOT, OUT)} is stale. Run: npm run docs:cli\n`)
      process.exitCode = 1
      return
    }
    process.stdout.write(`${relative(ROOT, OUT)} is up to date.\n`)
    return
  }
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, text)
  process.stdout.write(`Wrote ${relative(ROOT, OUT)}\n`)
}

main().then(() => {
  // ink / the TUI modules may leave handles open; the work is done.
  process.exit(process.exitCode ?? 0)
}, err => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  process.exit(1)
})
