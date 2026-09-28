// The one-shot CLI and TUI dispatch. The `adf` executable is bin.ts; it
// calls runCli (this module never runs itself).

import { DEFAULT_DAEMON_URL, resolveDaemonUrl } from './daemon-url'
import {
  AUTH_PROVIDER_LABELS,
  loginChatGpt,
  loginGrok,
  normalizeAuthProvider,
  openBrowser,
  type AuthFlowDeps,
  type AuthOutcome,
  type AuthProvider,
} from './auth-flow'

export interface CliIo {
  fetch: typeof fetch
  stdout: (text: string) => void
  stderr: (text: string) => void
  /** Test seam for the device-code poll loop. */
  sleep?: (ms: number) => Promise<void>
  /** Test seam for the relay sign-in's local OAuth callback server. */
  startCallbackServer?: () => Promise<CliCallbackServer>
  /** Test seam for opening the user's browser. */
  openBrowser?: (url: string) => void
  /** Test seam for the interactive TUI (no command, `tui`, or a TUI-only flag). */
  launchTui?: (argv: string[]) => Promise<number>
  /**
   * Test seam for interactive input (seed phrase, passphrase, confirmations).
   * hidden: do not echo what is typed. Input never goes through argv, so it
   * stays out of shell history and process listings.
   */
  prompt?: (question: string, opts?: { hidden?: boolean }) => Promise<string>
  /**
   * Make sure a daemon answers at `url` before a command or the TUI runs:
   * the `adf` binary starts a local one in the background (daemon-control).
   * Returns the started daemon's pid, or null when it was already up (or
   * may not be started). Absent (tests) = never start anything.
   */
  ensureDaemon?: (url: string) => Promise<{ pid: number } | null>
}

export interface CliCallbackServer {
  port: number
  waitForCallback: () => Promise<{ code: string; state: string }>
  close: () => void
}

interface CliOptions {
  daemonUrl: string
  json: boolean
}

interface ParsedArgs {
  command: string
  args: string[]
  options: CliOptions
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

const defaultIo: CliIo = {
  fetch: globalThis.fetch.bind(globalThis),
  stdout: text => process.stdout.write(text),
  stderr: text => process.stderr.write(text),
}

/** Flags only the TUI understands; `adf --view chat` means "open the TUI". */
const TUI_FLAGS = new Set(['--view', '--agent', '--loop', '--theme', '--mono', '--no-color', '--ascii', '--no-alt-screen', '--token', '--no-mouse', '--mouse', '--no-kitty'])

/** The argv to hand the TUI, or null when this is a one-shot command (or help). */
export function tuiInvocation(argv: string[]): string[] | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--url' || arg === '-u') { i++; continue }
    if (arg.startsWith('--url=') || arg === '--json') continue
    if (arg === 'tui' || TUI_FLAGS.has(arg) || [...TUI_FLAGS].some(flag => arg.startsWith(`${flag}=`))) {
      return argv.filter(a => a !== '--json')
    }
    return null
  }
  return argv.filter(a => a !== '--json')
}

async function defaultLaunchTui(argv: string[]): Promise<number> {
  const { runTui } = await import('../tui/index')
  return await runTui(argv)
}

/** The `--url` in argv (TUI and CLI both take it), else ADF_DAEMON_URL, else the default. */
function urlFromArgv(argv: string[]): string {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url' || argv[i] === '-u') return resolveDaemonUrl(argv[i + 1])
    if (argv[i].startsWith('--url=')) return resolveDaemonUrl(argv[i].slice(6))
  }
  return resolveDaemonUrl(undefined)
}

/** Start the daemon when needed; false when that failed (the error is printed). */
async function daemonReady(io: CliIo, url: string): Promise<{ ok: boolean; started: number | null }> {
  if (!io.ensureDaemon) return { ok: true, started: null }
  try {
    const started = await io.ensureDaemon(url)
    return { ok: true, started: started?.pid ?? null }
  } catch (err) {
    const advice = (err as { advice?: string }).advice
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n${advice ? `${advice}\n` : ''}`)
    return { ok: false, started: null }
  }
}

export async function runCli(argv = process.argv.slice(2), io: CliIo = defaultIo): Promise<number> {
  const tuiArgv = tuiInvocation(argv)
  if (tuiArgv) {
    const wantsHelp = tuiArgv.includes('--help') || tuiArgv.includes('-h')
    const ready = wantsHelp ? { ok: true, started: null } : await daemonReady(io, urlFromArgv(tuiArgv))
    if (!ready.ok) return 1
    try {
      const code = await (io.launchTui ?? defaultLaunchTui)(tuiArgv)
      if (ready.started) io.stdout(`The daemon (pid ${ready.started}) keeps running in the background. Stop it with: adf daemon stop\n`)
      return code
    } catch (err) {
      io.stderr(`${err instanceof Error ? err.message : String(err)}\n`)
      return 1
    }
  }

  let parsed: ParsedArgs
  try {
    parsed = parseArgs(argv)
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n\n${usage()}\n`)
    return 2
  }

  const { command, args, options } = parsed
  if (!['help', '--help', '-h'].includes(command) && !(await daemonReady(io, options.daemonUrl)).ok) return 1

  try {
    switch (command) {
      case 'help':
      case '--help':
      case '-h':
        io.stdout(`${usage()}\n`)
        return 0
      case 'agents':
        return await printGet(io, options, '/agents', formatAgents)
      case 'status':
        return await withAgent(args, io, async agent => printGet(io, options, `/agents/${enc(agent)}/status`, formatStatus))
      case 'start':
        return await controlAgent(io, options, args, 'start')
      case 'stop':
      case 'unload':
        return await controlAgent(io, options, args, 'stop')
      case 'abort':
        return await controlLoop(io, options, args, 'abort')
      case 'interrupt':
        return await controlLoop(io, options, args, 'interrupt')
      case 'loops':
        return await withAgent(args, io, async agent => printGet(io, options, `/agents/${enc(agent)}/loops`, formatLoops))
      case 'config':
        return await withAgent(args, io, async agent => printGet(io, options, `/agents/${enc(agent)}/config`, formatJsonPretty))
      case 'providers':
        return await printGet(io, options, '/runtime/providers', formatProviders)
      case 'auth':
        if (args[0]) return await authCommand(io, options, args)
        return await printGet(io, options, '/runtime/auth', formatAuth)
      case 'settings':
        return await printGet(io, options, '/runtime/settings', formatJsonPretty)
      case 'network':
        if (args[0]) return await networkAdmin(io, options, args)
        return await printGet(io, options, '/runtime/network', formatNetwork)
      case 'usage':
        if (!args[0]) return await printGet(io, options, '/runtime/usage', formatUsage)
        return await withAgent(args, io, async agent => printGet(io, options, `/agents/${enc(agent)}/usage`, formatUsage))
      case 'files':
        return await withAgent(args, io, async agent => printGet(io, options, `/agents/${enc(agent)}/files`, formatFiles))
      case 'file':
        return await withAgentAndValue(args, 'file path', io, async (agent, path) => {
          const data = await requestJson(io, options, `/agents/${enc(agent)}/files/content?path=${enc(path)}`)
          if (options.json) io.stdout(`${JSON.stringify(data, null, 2)}\n`)
          else if (isRecord(data) && data.encoding === 'utf-8' && typeof data.content === 'string') io.stdout(data.content)
          else if (isRecord(data) && typeof data.content_base64 === 'string') io.stdout(`${data.content_base64}\n`)
          else io.stdout(`${JSON.stringify(data, null, 2)}\n`)
          return 0
        })
      case 'inbox':
        return await withAgent(args, io, async agent => printGet(io, options, `/agents/${enc(agent)}/inbox`, formatMessages('inbox')))
      case 'outbox':
        return await withAgent(args, io, async agent => printGet(io, options, `/agents/${enc(agent)}/outbox`, formatMessages('outbox')))
      case 'timers':
        return await withAgent(args, io, async agent => printGet(io, options, `/agents/${enc(agent)}/timers`, formatTimers))
      case 'tasks':
        return await withAgent(args, io, async agent => printGet(io, options, `/agents/${enc(agent)}/tasks`, formatTasks))
      case 'task':
        return await withAgentAndValue(args, 'task id', io, async (agent, taskId) => printGet(io, options, `/agents/${enc(agent)}/tasks/${enc(taskId)}`, formatJsonPretty))
      case 'approve':
        return await resolveTask(io, options, args, 'approve')
      case 'deny':
        return await resolveTask(io, options, args, 'deny')
      case 'asks':
        return await withAgent(args, io, async agent => printGet(io, options, `/agents/${enc(agent)}/asks`, formatAsks))
      case 'answer':
        return await answerAsk(io, options, args)
      case 'identities':
        return await withAgent(args, io, async agent => printGet(io, options, `/agents/${enc(agent)}/identities`, formatIdentities))
      case 'runtime':
        if (!args[0]) return await printGet(io, options, '/runtime', formatJsonPretty)
        return await withAgent(args, io, async agent => printGet(io, options, `/agents/${enc(agent)}/runtime`, formatJsonPretty))
      case 'mcp':
        if (!args[0]) return await printGet(io, options, '/runtime/mcp', formatGlobalMcp)
        return await withAgent(args, io, async agent => printGet(io, options, `/agents/${enc(agent)}/runtime/mcp`, formatMcp))
      case 'adapters':
        if (!args[0]) return await printGet(io, options, '/runtime/adapters', formatGlobalAdapters)
        return await withAgent(args, io, async agent => printGet(io, options, `/agents/${enc(agent)}/runtime/adapters`, formatAdapters))
      case 'events':
        return await streamEvents(io, options, args)
      case 'chat':
        return await sendChat(io, options, args)
      case 'identity':
        return await identityCommand(io, options, args)
      case 'templates':
        return await printGet(io, options, '/templates', formatTemplates)
      case 'new':
        return await newAgent(io, options, args)
      default:
        io.stderr(`Unknown command: ${command}\n\n${usage()}\n`)
        return 2
    }
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = [...argv]
  let daemonUrl = process.env.ADF_DAEMON_URL ?? DEFAULT_DAEMON_URL
  let json = false
  const positional: string[] = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--json') {
      json = true
    } else if (arg === '--url' || arg === '-u') {
      const value = args[++i]
      if (!value) throw new Error(`${arg} requires a daemon URL`)
      daemonUrl = value
    } else if (arg.startsWith('--url=')) {
      daemonUrl = arg.slice('--url='.length)
    } else {
      positional.push(arg)
    }
  }

  return {
    command: positional[0] ?? 'help',
    args: positional.slice(1),
    options: {
      daemonUrl: daemonUrl.replace(/\/+$/, ''),
      json,
    },
  }
}

async function printGet(
  io: CliIo,
  options: CliOptions,
  path: string,
  formatter: (value: JsonValue) => string,
): Promise<number> {
  const data = await requestJson(io, options, path)
  io.stdout(options.json ? `${JSON.stringify(data, null, 2)}\n` : formatter(data))
  return 0
}

async function requestJson(io: CliIo, options: CliOptions, path: string, init?: RequestInit): Promise<JsonValue> {
  const token = process.env.ADF_DAEMON_TOKEN
  let response: Response
  try {
    response = await io.fetch(`${options.daemonUrl}${path}`, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    })
  } catch (err) {
    if (err instanceof TypeError) throw new Error(`Cannot reach the ADF daemon at ${options.daemonUrl} (${err.message}). Start it with: adf daemon start`)
    throw err
  }
  const text = await response.text()
  let body: JsonValue = null
  if (text.trim()) {
    try { body = JSON.parse(text) as JsonValue } catch { body = text }
  }
  if (!response.ok) {
    const message = isRecord(body) && typeof body.error === 'string'
      ? body.error
      : `HTTP ${response.status} ${response.statusText}`
    throw new Error(message)
  }
  return body
}

/** Pull `--loop <name>` / `--loop=<name>` out of a command's arguments. */
function takeLoop(args: string[]): { loop: string | undefined; rest: string[] } {
  const rest: string[] = []
  let loop: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--loop') {
      loop = args[++i]
      if (!loop) throw new Error('--loop requires a loop name')
    } else if (arg.startsWith('--loop=')) {
      loop = arg.slice('--loop='.length)
    } else {
      rest.push(arg)
    }
  }
  return { loop: loop && loop !== 'main' ? loop : undefined, rest }
}

async function sendChat(io: CliIo, options: CliOptions, args: string[]): Promise<number> {
  const { loop, rest } = takeLoop(args)
  const agent = rest[0]
  const text = rest.slice(1).join(' ')
  if (!agent || !text) throw new Error('Usage: adf chat <agent> [--loop <name>] <message>')
  const data = await requestJson(io, options, `/agents/${enc(agent)}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, ...(loop ? { loop } : {}) }),
  })
  io.stdout(options.json ? `${JSON.stringify(data, null, 2)}\n` : formatChatAck(data))
  return 0
}

/** `abort` (hard stop of that loop until reload) or `interrupt` (turn ends, loop stays idle) one loop. */
async function controlLoop(io: CliIo, options: CliOptions, args: string[], action: 'abort' | 'interrupt'): Promise<number> {
  const { loop, rest } = takeLoop(args)
  const agent = rest[0]
  if (!agent) throw new Error(`Usage: adf ${action} <agent> [--loop <name>]`)
  const query = loop ? `?loop=${enc(loop)}` : ''
  const data = await requestJson(io, options, `/agents/${enc(agent)}/${action}${query}`, { method: 'POST' })
  if (options.json) io.stdout(`${JSON.stringify(data, null, 2)}\n`)
  else if (action === 'abort') io.stdout(formatAgentControl('abort', loop ? `${agent} (loop ${loop})` : agent, data))
  else io.stdout(isRecord(data) && data.interrupted === false ? `Nothing running in ${agent} ${loop ?? 'main'}\n` : `Interrupted ${agent} ${loop ?? 'main'}: the loop is idle and keeps accepting work\n`)
  return 0
}

function formatLoops(value: JsonValue): string {
  const loops = isRecord(value) && Array.isArray(value.loops) ? value.loops.filter(isRecord) : []
  if (loops.length === 0) return 'No loops\n'
  return table(['loop', 'kind', 'enabled', 'status', 'entries', 'goal'], loops.map(loop => [
    String(loop.name ?? ''),
    loop.isMain === true || loop.name === 'main' ? 'main' : 'inner',
    String(loop.enabled ?? true),
    String(loop.status ?? ''),
    String(loop.entryCount ?? ''),
    truncateCell(String(loop.goal ?? ''), 60),
  ]))
}

function truncateCell(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

async function resolveTask(
  io: CliIo,
  options: CliOptions,
  args: string[],
  action: 'approve' | 'deny',
): Promise<number> {
  const agent = args[0]
  const taskId = args[1]
  const reason = action === 'deny' ? args.slice(2).join(' ') : undefined
  if (!agent || !taskId) throw new Error(`Usage: adf ${action} <agent> <taskId>${action === 'deny' ? ' [reason]' : ''}`)
  const data = await requestJson(io, options, `/agents/${enc(agent)}/tasks/${enc(taskId)}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...(reason ? { reason } : {}) }),
  })
  io.stdout(options.json ? `${JSON.stringify(data, null, 2)}\n` : formatTaskResolution(action, taskId, data))
  return 0
}

async function answerAsk(io: CliIo, options: CliOptions, args: string[]): Promise<number> {
  const agent = args[0]
  const requestId = args[1]
  const answer = args.slice(2).join(' ')
  if (!agent || !requestId || !answer) throw new Error('Usage: adf answer <agent> <requestId> <answer>')
  const data = await requestJson(io, options, `/agents/${enc(agent)}/asks/${enc(requestId)}/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer }),
  })
  io.stdout(options.json ? `${JSON.stringify(data, null, 2)}\n` : `Answered ${requestId}\n`)
  return 0
}

async function controlAgent(
  io: CliIo,
  options: CliOptions,
  args: string[],
  action: 'start' | 'stop' | 'abort',
): Promise<number> {
  const agent = args[0]
  if (!agent) throw new Error(`Usage: adf ${action} <agent>`)
  const data = await requestJson(io, options, `/agents/${enc(agent)}/${action}`, { method: 'POST' })
  io.stdout(options.json ? `${JSON.stringify(data, null, 2)}\n` : formatAgentControl(action, agent, data))
  return 0
}

/** Test seams and the daemon transport for the shared sign-in flows (./auth-flow). */
function authDeps(io: CliIo, options: CliOptions): AuthFlowDeps {
  return {
    request: (method, path, body) => requestJson(io, options, path, body === undefined
      ? { method }
      : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    sleep: io.sleep,
    openBrowser: io.openBrowser ?? openBrowser,
    startCallbackServer: io.startCallbackServer,
  }
}

function requireAuthProvider(value: string | undefined): AuthProvider {
  const provider = normalizeAuthProvider(value)
  if (!provider) throw new Error('Specify a provider: chatgpt or grok')
  return provider
}

async function authCommand(io: CliIo, options: CliOptions, args: string[]): Promise<number> {
  const flags = new Set(args.filter(arg => arg.startsWith('--')))
  const positional = args.filter(arg => !arg.startsWith('--'))
  const action = positional[0]

  if (action === 'status') return await printGet(io, options, '/runtime/auth', formatAuth)

  if (action === 'login') {
    const provider = requireAuthProvider(positional[1])
    return provider === 'chatgpt'
      ? await loginChatGptCli(io, options, flags)
      : await loginGrokCli(io, options)
  }

  if (action === 'logout') {
    const provider = requireAuthProvider(positional[1])
    const data = await requestJson(io, options, `/auth/${provider}/logout`, { method: 'POST' })
    io.stdout(options.json
      ? `${JSON.stringify(data, null, 2)}\n`
      : `Signed out of ${AUTH_PROVIDER_LABELS[provider]}.\n`)
    return 0
  }

  throw new Error('Usage: adf auth [status | login <chatgpt|grok> | logout <chatgpt|grok>]')
}

/** Print the outcome of a sign-in; exit code. */
function reportAuth(io: CliIo, provider: AuthProvider, outcome: AuthOutcome): number {
  if (outcome.ok) {
    io.stdout(`Signed in to ${AUTH_PROVIDER_LABELS[provider]}${outcome.email ? ` as ${outcome.email}` : ''}.\n`)
    return 0
  }
  if (outcome.timedOut) {
    io.stderr(`Timed out waiting for ${AUTH_PROVIDER_LABELS[provider]} sign-in. Run "adf auth" to check status.\n`)
    return 1
  }
  io.stderr(`Sign-in failed: ${outcome.error}\n`)
  return 1
}

async function loginChatGptCli(io: CliIo, options: CliOptions, flags: Set<string>): Promise<number> {
  // --json prints the start answer (loopback) or the completion (relay) as-is.
  const stop = new AbortController()
  let printedStart = false
  const outcome = await loginChatGpt({ ...authDeps(io, options), signal: stop.signal }, {
    daemonUrl: options.daemonUrl,
    mode: flags.has('--relay') ? 'relay' : flags.has('--loopback') ? 'loopback' : 'auto',
    onStart: (info) => {
      if (options.json) {
        if (info.mode === 'loopback') {
          io.stdout(`${JSON.stringify(info.raw, null, 2)}\n`)
          printedStart = true
          stop.abort()
        }
        return
      }
      io.stdout(info.mode === 'relay'
        ? `Open this URL to sign in to ChatGPT:\n\n  ${info.authUrl}\n\nWaiting for the callback on ${info.redirectUri} ...\n`
        : `Open this URL to sign in to ChatGPT:\n\n  ${info.authUrl}\n\nWaiting for sign-in to complete...\n`)
    },
  })
  if (printedStart) return 0
  if (options.json && outcome.ok) {
    io.stdout(`${JSON.stringify(outcome.raw, null, 2)}\n`)
    return 0
  }
  return reportAuth(io, 'chatgpt', outcome)
}

async function loginGrokCli(io: CliIo, options: CliOptions): Promise<number> {
  // Device code (RFC 8628) — no callback server, so a remote daemon works as-is.
  const stop = new AbortController()
  const outcome = await loginGrok({ ...authDeps(io, options), signal: stop.signal }, {
    onStart: (info) => {
      if (options.json) {
        io.stdout(`${JSON.stringify(info.raw, null, 2)}\n`)
        stop.abort()
        return
      }
      io.stdout(`Open this URL to sign in to Grok:\n\n  ${info.verificationUri}\n\nAnd enter the code: ${info.userCode}\n\nWaiting for approval...\n`)
    },
  })
  if (options.json) return 0
  return reportAuth(io, 'grok', outcome)
}

async function networkAdmin(io: CliIo, options: CliOptions, args: string[]): Promise<number> {
  const area = args[0]
  const action = args[1]
  if (area === 'mesh') {
    if (action === 'enable' || action === 'disable') {
      return await postAndPrint(io, options, `/network/mesh/${action}`, formatJsonPretty)
    }
    if (!action || action === 'status') return await printGet(io, options, '/network/mesh', formatJsonPretty)
  }
  if (area === 'server') {
    if (action === 'start' || action === 'stop' || action === 'restart') {
      return await postAndPrint(io, options, `/network/server/${action}`, formatJsonPretty)
    }
    if (!action || action === 'status') return await printGet(io, options, '/network/server', formatJsonPretty)
  }
  if (area === 'tools') return await printGet(io, options, '/network/mesh/recent-tools', formatJsonPretty)
  if (area === 'lan') return await printGet(io, options, '/network/mesh/lan-addresses', formatJsonPretty)
  if (area === 'runtimes') return await printGet(io, options, '/network/mesh/discovered-runtimes', formatJsonPretty)
  throw new Error('Usage: adf network [mesh [status|enable|disable] | server [status|start|stop|restart] | tools | lan | runtimes]')
}

async function postAndPrint(
  io: CliIo,
  options: CliOptions,
  path: string,
  formatter: (value: JsonValue) => string,
): Promise<number> {
  const data = await requestJson(io, options, path, { method: 'POST' })
  io.stdout(options.json ? `${JSON.stringify(data, null, 2)}\n` : formatter(data))
  return 0
}

async function streamEvents(io: CliIo, options: CliOptions, args: string[]): Promise<number> {
  const agent = args[0]
  const path = agent ? `/events?agentId=${enc(agent)}` : '/events'
  const response = await io.fetch(`${options.daemonUrl}${path}`, {
    headers: { Accept: 'text/event-stream' },
  })
  if (!response.ok || !response.body) {
    throw new Error(`Event stream failed: HTTP ${response.status} ${response.statusText}`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split(/\n\n/)
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      const dataLine = part.split(/\n/).find(line => line.startsWith('data: '))
      if (!dataLine) continue
      const payload = dataLine.slice('data: '.length)
      if (options.json) io.stdout(`${payload}\n`)
      else {
        try { io.stdout(`${formatEvent(JSON.parse(payload) as JsonValue)}\n`) }
        catch { io.stdout(`${payload}\n`) }
      }
    }
  }
  return 0
}

async function withAgent(
  args: string[],
  io: CliIo,
  run: (agent: string) => Promise<number>,
): Promise<number> {
  const agent = args[0]
  if (!agent) {
    io.stderr('Missing agent id or handle.\n')
    return 2
  }
  return await run(agent)
}

async function withAgentAndValue(
  args: string[],
  label: string,
  io: CliIo,
  run: (agent: string, value: string) => Promise<number>,
): Promise<number> {
  const agent = args[0]
  const value = args[1]
  if (!agent || !value) {
    io.stderr(`Missing agent id/handle or ${label}.\n`)
    return 2
  }
  return await run(agent, value)
}

// ---------------------------------------------------------------------------
// Owner identity + agent creation
// ---------------------------------------------------------------------------

/** Lines of a piped (non-TTY) stdin, read once and handed out in order. */
let pipedLines: string[] | null = null
let pipedLineIndex = 0

async function defaultPrompt(question: string, opts: { hidden?: boolean } = {}): Promise<string> {
  const { createInterface } = await import('readline')
  if (!process.stdin.isTTY) {
    if (pipedLines === null) {
      const chunks: Buffer[] = []
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer))
      pipedLines = Buffer.concat(chunks).toString('utf-8').split(/\r?\n/)
    }
    return pipedLines[pipedLineIndex++] ?? ''
  }
  // historySize 0: nothing typed here is kept, even in memory.
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true, historySize: 0 })
  const internals = rl as unknown as { _writeToOutput: (text: string) => void }
  let muted = false
  if (opts.hidden) {
    const write = internals._writeToOutput.bind(rl)
    internals._writeToOutput = (text: string) => { if (!muted) write(text) }
  }
  try {
    return await new Promise<string>((resolve) => {
      rl.question(question, resolve)
      muted = !!opts.hidden
    })
  } finally {
    rl.close()
    if (opts.hidden) process.stdout.write('\n')
  }
}

function ask(io: CliIo, question: string, hidden = false): Promise<string> {
  return (io.prompt ?? defaultPrompt)(question, { hidden })
}

function postJson(io: CliIo, options: CliOptions, path: string, body: Record<string, unknown> = {}): Promise<JsonValue> {
  return requestJson(io, options, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Ask for the file-storage passphrase when the daemon has no OS keychain. */
async function passphraseIfNeeded(io: CliIo, identity: JsonValue, confirmNew: boolean): Promise<string | undefined> {
  if (!isRecord(identity) || identity.passphraseRequired !== true) return undefined
  io.stdout('This machine has no usable OS keychain, so the owner identity is kept in a passphrase-protected file.\n')
  const passphrase = await ask(io, confirmNew ? 'Choose a passphrase (8+ characters): ' : 'Passphrase: ', true)
  if (confirmNew) {
    const again = await ask(io, 'Repeat the passphrase: ', true)
    if (again !== passphrase) throw new Error('The passphrases do not match.')
  }
  return passphrase
}

async function identityCommand(io: CliIo, options: CliOptions, args: string[]): Promise<number> {
  const action = args[0] ?? 'status'

  if (action === 'status') return await printGet(io, options, '/identity', formatIdentity)

  if (action === 'new' || action === 'create') {
    const current = await requestJson(io, options, '/identity')
    if (isRecord(current) && current.status !== 'none') {
      io.stdout(formatIdentity(current))
      io.stderr('An owner identity already exists here; nothing was created.\n')
      return 1
    }
    const passphrase = await passphraseIfNeeded(io, current, true)
    const created = await postJson(io, options, '/identity/create', passphrase ? { passphrase } : {})
    if (options.json) {
      io.stdout(`${JSON.stringify(created, null, 2)}\n`)
      return 0
    }
    const words = isRecord(created) && Array.isArray(created.words) ? created.words.map(String) : []
    const identity = isRecord(created) && isRecord(created.identity) ? created.identity : {}
    io.stdout(
      `Owner identity created: ${String(identity.ownerDid ?? '')}\n\n` +
      'Your seed phrase — write these 12 words down, in order, and keep them somewhere safe.\n' +
      'Anyone with this phrase can act as you; without it, your owner identity cannot be\n' +
      'recovered if this machine is lost. It will NOT be shown again.\n\n' +
      `${formatWords(words)}\n\n` +
      'Use the same phrase in ADF Studio (Settings → Import Identity) or `adf identity restore`\n' +
      'on another machine to be the same owner there.\n\n',
    )
    const answer = (await ask(io, 'Type "yes" once you have written the words down: ')).trim().toLowerCase()
    if (answer === 'yes' || answer === 'y') {
      await postJson(io, options, '/identity/confirm-backup')
      io.stdout('Backup confirmed.\n')
    } else {
      io.stdout('Backup not confirmed. The phrase cannot be shown again by the daemon; if you did not save it,\n' +
        'you can reveal it in ADF Studio on this machine (Settings → Back Up Seed Phrase).\n')
    }
    return 0
  }

  if (action === 'restore' || action === 'import') {
    const current = await requestJson(io, options, '/identity')
    if (isRecord(current) && current.status === 'ready') {
      io.stdout(formatIdentity(current))
      return 0
    }
    if (isRecord(current) && typeof current.ownerDid === 'string' && current.ownerDid) {
      io.stdout(`This machine's owner is ${current.ownerDid}; enter the seed phrase for that owner.\n`)
    }
    const mnemonic = (await ask(io, 'Seed phrase (12 words, input hidden): ', true)).trim()
    if (!mnemonic) throw new Error('No seed phrase entered.')
    const passphrase = await passphraseIfNeeded(io, current, isRecord(current) && current.status !== 'locked')
    const restored = await postJson(io, options, '/identity/restore', { mnemonic, ...(passphrase ? { passphrase } : {}) })
    const identity = isRecord(restored) && isRecord(restored.identity) ? restored.identity : restored
    io.stdout(options.json ? `${JSON.stringify(restored, null, 2)}\n` : `Owner identity restored.\n${formatIdentity(identity)}`)
    return 0
  }

  if (action === 'unlock') {
    const passphrase = await ask(io, 'Passphrase: ', true)
    const unlocked = await postJson(io, options, '/identity/unlock', { passphrase })
    const identity = isRecord(unlocked) && isRecord(unlocked.identity) ? unlocked.identity : unlocked
    io.stdout(options.json ? `${JSON.stringify(unlocked, null, 2)}\n` : formatIdentity(identity))
    return 0
  }

  if (action === 'lock') {
    const locked = await postJson(io, options, '/identity/lock')
    const identity = isRecord(locked) && isRecord(locked.identity) ? locked.identity : locked
    io.stdout(options.json ? `${JSON.stringify(locked, null, 2)}\n` : formatIdentity(identity))
    return 0
  }

  throw new Error('Usage: adf identity [status | new | restore | unlock | lock]')
}

async function newAgent(io: CliIo, options: CliOptions, args: string[]): Promise<number> {
  const body: Record<string, unknown> = {}
  const valueFlags: Record<string, string> = {
    '--template': 'template', '-t': 'template',
    '--provider': 'provider', '--model': 'model',
    '--dir': 'directory', '--directory': 'directory',
  }
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const eq = arg.indexOf('=')
    const flag = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg
    if (flag === '--start') { body.start = true; continue }
    const key = valueFlags[flag]
    if (key) {
      const value = eq > 0 && flag !== arg ? arg.slice(eq + 1) : args[++i]
      if (!value) throw new Error(`${flag} requires a value`)
      body[key] = value
      continue
    }
    if (arg.startsWith('-')) throw new Error(`Unknown option for adf new: ${arg}`)
    positional.push(arg)
  }
  if (positional.length > 0) body.name = positional.join(' ')
  const created = await postJson(io, options, '/agents/create', body)
  if (options.json) {
    io.stdout(`${JSON.stringify(created, null, 2)}\n`)
    return 0
  }
  const row = isRecord(created) ? created : {}
  io.stdout(table(['field', 'value'], [
    ['name', String(row.name ?? '')],
    ['agentId', String(row.agentId ?? '')],
    ['did', String(row.did ?? '')],
    ['filePath', String(row.filePath ?? '')],
    ['started', String(row.started ?? false)],
  ]))
  return 0
}

function formatWords(words: string[]): string {
  const cells = words.map((word, i) => `${String(i + 1).padStart(2)}. ${word}`.padEnd(16))
  const rows: string[] = []
  for (let i = 0; i < cells.length; i += 4) rows.push(`  ${cells.slice(i, i + 4).join(' ').trimEnd()}`)
  return rows.join('\n')
}

function formatIdentity(value: JsonValue): string {
  if (!isRecord(value)) return formatJsonPretty(value)
  return `${table(['field', 'value'], [
    ['status', String(value.status ?? '')],
    ['ownerDid', String(value.ownerDid ?? '')],
    ['runtimeDid', String(value.runtimeDid ?? '')],
    ['storage', String(value.storage ?? '')],
    ['backupConfirmed', String(value.backupConfirmed ?? false)],
  ])}${typeof value.message === 'string' ? `${value.message}\n` : ''}`
}

function formatTemplates(value: JsonValue): string {
  const templates = isRecord(value) && Array.isArray(value.templates) ? value.templates.filter(isRecord) : []
  if (templates.length === 0) return 'No templates.\n'
  const defaultId = isRecord(value) ? String(value.defaultId ?? '') : ''
  return table(['id', 'name', 'default', 'model', 'about'], templates.map(t => [
    String(t.id ?? ''),
    String(t.name ?? ''),
    t.id === defaultId ? 'yes' : '',
    [t.modelProvider, t.modelId].filter(Boolean).map(String).join('/'),
    truncate(String(t.templateDescription ?? t.description ?? ''), 60),
  ]))
}

function formatAgents(value: JsonValue): string {
  const rows = Array.isArray(value) ? value.filter(isRecord) : []
  if (rows.length === 0) return 'No agents loaded.\n'
  return table(['id', 'handle', 'name', 'autostart'], rows.map(row => [
    String(row.id ?? ''),
    String(row.handle ?? ''),
    String(row.name ?? ''),
    String(row.autostart ?? false),
  ]))
}

function formatStatus(value: JsonValue): string {
  if (!isRecord(value)) return formatJsonPretty(value)
  return table(['field', 'value'], [
    ['id', String(value.id ?? '')],
    ['handle', String(value.handle ?? '')],
    ['name', String(value.name ?? '')],
    ['runtimeState', String(value.runtimeState ?? '')],
    ['targetState', String(value.targetState ?? '')],
    ['loopCount', String(value.loopCount ?? '')],
    ['filePath', String(value.filePath ?? '')],
  ])
}

function formatFiles(value: JsonValue): string {
  const files = isRecord(value) && Array.isArray(value.files) ? value.files.filter(isRecord) : []
  if (files.length === 0) return 'No files.\n'
  return table(['path', 'size', 'mime', 'protection'], files.map(file => [
    String(file.path ?? ''),
    String(file.size ?? ''),
    String(file.mime_type ?? ''),
    String(file.protection ?? ''),
  ]))
}

function formatProviders(value: JsonValue): string {
  if (!isRecord(value)) return formatJsonPretty(value)
  const providers = Array.isArray(value.providers) ? value.providers.filter(isRecord) : []
  const usage = Array.isArray(value.agentUsage) ? value.agentUsage.filter(isRecord) : []
  const providerTable = providers.length === 0
    ? 'Providers: none\n'
    : `Providers:\n${table(['id', 'type', 'name', 'model', 'key'], providers.map(provider => [
      String(provider.id ?? ''),
      String(provider.type ?? ''),
      String(provider.name ?? ''),
      String(provider.defaultModel ?? ''),
      String(provider.hasApiKey ?? false),
    ]))}`
  const usageTable = usage.length === 0
    ? 'Agent usage: none\n'
    : `Agent usage:\n${table(['agent', 'provider', 'model', 'source'], usage.map(row => [
      String(row.handle ?? row.agentId ?? ''),
      String(row.providerId ?? ''),
      String(row.modelId ?? ''),
      String(row.source ?? ''),
    ]))}`
  return `${providerTable}\n${usageTable}`
}

function formatAuth(value: JsonValue): string {
  if (!isRecord(value)) return formatJsonPretty(value)
  const chatgpt = isRecord(value.chatgpt) ? value.chatgpt : {}
  const grok = isRecord(value.grok) ? value.grok : {}
  const providers = Array.isArray(value.providers) ? value.providers.filter(isRecord) : []
  const chatgptTable = `ChatGPT:\n${table(['field', 'value'], [
    ['authenticated', String(chatgpt.authenticated ?? false)],
    ['email', String(chatgpt.email ?? '')],
  ])}`
  const grokTable = `Grok:\n${table(['field', 'value'], [
    ['authenticated', String(grok.authenticated ?? false)],
    ['email', String(grok.email ?? '')],
  ])}`
  const providersTable = providers.length === 0
    ? 'Provider credentials: none\n'
    : `Provider credentials:\n${table(['id', 'type', 'storage', 'apiKey'], providers.map(provider => [
      String(provider.id ?? ''),
      String(provider.type ?? ''),
      String(provider.credentialStorage ?? ''),
      String(provider.hasApiKey ?? false),
    ]))}`
  return `${chatgptTable}\n${grokTable}\n${providersTable}`
}

function formatNetwork(value: JsonValue): string {
  if (!isRecord(value)) return formatJsonPretty(value)
  const mesh = isRecord(value.mesh) ? value.mesh : {}
  const websocket = isRecord(value.websocket) ? value.websocket : {}
  const agents = Array.isArray(value.agents) ? value.agents.filter(isRecord) : []
  const summary = table(['field', 'value'], [
    ['meshEnabledSetting', String(mesh.enabledSetting ?? '')],
    ['meshLan', String(mesh.lan ?? '')],
    ['meshPort', String(mesh.port ?? '')],
    ['wsActive', String(websocket.activeConnections ?? 0)],
    ['wsInbound', String(websocket.inboundConnections ?? 0)],
    ['wsOutbound', String(websocket.outboundConnections ?? 0)],
  ])
  const agentTable = agents.length === 0
    ? 'Network agents: none\n'
    : `Network agents:\n${table(['agent', 'receive', 'mode', 'ws', 'routes'], agents.map(agent => [
      String(agent.handle ?? agent.agentId ?? ''),
      String(agent.receive ?? false),
      String(agent.sendMode ?? ''),
      String(agent.wsConnectionsConfigured ?? 0),
      String(agent.servingRoutes ?? 0),
    ]))}`
  return `${summary}\n${agentTable}`
}

function formatUsage(value: JsonValue): string {
  if (!isRecord(value)) return formatJsonPretty(value)
  const totals = isRecord(value.totals) ? value.totals : {}
  const summaryRows = [
    ['source', String(value.source ?? '')],
    ['input', formatNumber(totals.input)],
    ['output', formatNumber(totals.output)],
    ['cacheRead', formatNumber(totals.cacheRead)],
    ['cacheWrite', formatNumber(totals.cacheWrite)],
    ['total', formatNumber(totals.total)],
  ]
  if (value.agentId) summaryRows.unshift(['agentId', String(value.agentId)])
  if (typeof value.loopRows === 'number') summaryRows.push(['loopRows', formatNumber(value.loopRows)])
  if (typeof value.usageRows === 'number') summaryRows.push(['usageRows', formatNumber(value.usageRows)])

  const rows = Array.isArray(value.byModel)
    ? value.byModel.filter(isRecord).map(row => [
      String(row.provider ?? ''),
      String(row.model ?? ''),
      formatNumber(row.input),
      formatNumber(row.output),
      formatNumber(row.cacheRead),
      formatNumber(row.cacheWrite),
      formatNumber(row.total),
      formatNumber(row.rows ?? row.days),
    ])
    : []
  const modelTable = rows.length === 0
    ? 'Models: none\n'
    : `Models:\n${table(['provider', 'model', 'input', 'output', 'cacheRead', 'cacheWrite', 'total', 'rows/days'], rows)}`
  return `${table(['field', 'value'], summaryRows)}\n${modelTable}`
}

function formatMessages(label: 'inbox' | 'outbox'): (value: JsonValue) => string {
  return value => {
    const messages = isRecord(value) && Array.isArray(value.messages) ? value.messages.filter(isRecord) : []
    if (messages.length === 0) return `No ${label} messages.\n`
    return table(['id', 'status', label === 'inbox' ? 'from' : 'to', 'content'], messages.map(message => [
      String(message.id ?? ''),
      String(message.status ?? ''),
      String(label === 'inbox' ? message.from ?? '' : message.to ?? ''),
      truncate(String(message.content ?? ''), 80),
    ]))
  }
}

function formatTimers(value: JsonValue): string {
  const timers = isRecord(value) && Array.isArray(value.timers) ? value.timers.filter(isRecord) : []
  if (timers.length === 0) return 'No timers.\n'
  return table(['id', 'next_wake_at', 'runs', 'payload'], timers.map(timer => [
    String(timer.id ?? ''),
    typeof timer.next_wake_at === 'number' ? new Date(timer.next_wake_at).toISOString() : String(timer.next_wake_at ?? ''),
    String(timer.run_count ?? ''),
    truncate(String(timer.payload ?? ''), 80),
  ]))
}

function formatTasks(value: JsonValue): string {
  const tasks = isRecord(value) && Array.isArray(value.tasks) ? value.tasks.filter(isRecord) : []
  if (tasks.length === 0) return 'No tasks.\n'
  return table(['id', 'status', 'tool', 'origin', 'auth'], tasks.map(task => [
    String(task.id ?? ''),
    String(task.status ?? ''),
    String(task.tool ?? ''),
    truncate(String(task.origin ?? ''), 32),
    String(task.requires_authorization ?? false),
  ]))
}

function formatAsks(value: JsonValue): string {
  const asks = isRecord(value) && Array.isArray(value.asks) ? value.asks.filter(isRecord) : []
  if (asks.length === 0) return 'No pending asks.\n'
  return table(['requestId', 'question'], asks.map(ask => [
    String(ask.requestId ?? ''),
    truncate(String(ask.question ?? ''), 100),
  ]))
}

function formatIdentities(value: JsonValue): string {
  const identities = isRecord(value) && Array.isArray(value.identities) ? value.identities.filter(isRecord) : []
  if (identities.length === 0) return 'No identities.\n'
  return table(['purpose', 'encrypted', 'code_access'], identities.map(identity => [
    String(identity.purpose ?? ''),
    String(identity.encrypted ?? false),
    String(identity.code_access ?? false),
  ]))
}

function formatMcp(value: JsonValue): string {
  if (!isRecord(value)) return formatJsonPretty(value)
  const configured = Array.isArray(value.configured) ? value.configured.filter(isRecord) : []
  const states = Array.isArray(value.states) ? value.states.filter(isRecord) : []
  const configuredTable = configured.length === 0
    ? 'Configured MCP: none\n'
    : `Configured MCP:\n${table(['name', 'transport', 'tools'], configured.map(server => [
      String(server.name ?? ''),
      String(server.transport ?? ''),
      String(server.toolCount ?? ''),
    ]))}`
  const stateTable = states.length === 0
    ? 'Runtime MCP: none\n'
    : `Runtime MCP:\n${table(['name', 'status', 'tools', 'error'], states.map(state => [
      String(state.name ?? ''),
      String(state.status ?? ''),
      String(state.toolCount ?? ''),
      truncate(String(state.error ?? ''), 80),
    ]))}`
  return `${configuredTable}\n${stateTable}`
}

function formatGlobalMcp(value: JsonValue): string {
  const servers = isRecord(value) && Array.isArray(value.servers) ? value.servers.filter(isRecord) : []
  if (servers.length === 0) return 'No daemon MCP servers registered.\n'
  return table(['id', 'name', 'type', 'package', 'storage', 'env'], servers.map(server => [
    String(server.id ?? ''),
    String(server.name ?? ''),
    String(server.type ?? ''),
    String(server.npmPackage ?? server.pypiPackage ?? server.command ?? server.url ?? ''),
    String(server.credentialStorage ?? ''),
    Array.isArray(server.env) ? String(server.env.length) : '0',
  ]))
}

function formatAdapters(value: JsonValue): string {
  if (!isRecord(value)) return formatJsonPretty(value)
  const configured = Array.isArray(value.configured) ? value.configured.filter(isRecord) : []
  const states = Array.isArray(value.states) ? value.states.filter(isRecord) : []
  const configuredTable = configured.length === 0
    ? 'Configured adapters: none\n'
    : `Configured adapters:\n${table(['type', 'enabled'], configured.map(adapter => [
      String(adapter.type ?? ''),
      String(adapter.enabled ?? false),
    ]))}`
  const stateTable = states.length === 0
    ? 'Runtime adapters: none\n'
    : `Runtime adapters:\n${table(['type', 'status', 'error'], states.map(state => [
      String(state.type ?? ''),
      String(state.status ?? ''),
      truncate(String(state.error ?? ''), 80),
    ]))}`
  return `${configuredTable}\n${stateTable}`
}

function formatGlobalAdapters(value: JsonValue): string {
  const adapters = isRecord(value) && Array.isArray(value.adapters) ? value.adapters.filter(isRecord) : []
  if (adapters.length === 0) return 'No daemon adapters registered.\n'
  return table(['id', 'type', 'package'], adapters.map(adapter => [
    String(adapter.id ?? ''),
    String(adapter.type ?? ''),
    String(adapter.npmPackage ?? ''),
  ]))
}

function formatChatAck(value: JsonValue): string {
  if (!isRecord(value)) return formatJsonPretty(value)
  return value.accepted
    ? `Accepted turn ${String(value.turnId ?? '')}\n`
    : `${JSON.stringify(value, null, 2)}\n`
}

function formatAgentControl(action: 'start' | 'stop' | 'abort', agent: string, value: JsonValue): string {
  if (!isRecord(value)) return formatJsonPretty(value)
  if (value.success !== true) return `${JSON.stringify(value, null, 2)}\n`
  if (action === 'start') {
    const details = [
      value.loaded === true ? 'loaded' : '',
      value.startupTriggered === false ? 'no startup trigger fired' : '',
    ].filter(Boolean)
    return `Started ${agent}${details.length > 0 ? ` (${details.join(', ')})` : ''}\n`
  }
  if (action === 'abort') return `Aborted current turn for ${agent}\n`
  return `Stopped ${agent}\n`
}

function formatTaskResolution(action: 'approve' | 'deny', taskId: string, value: JsonValue): string {
  if (!isRecord(value)) return formatJsonPretty(value)
  const task = isRecord(value.task) ? value.task : {}
  const status = typeof task.status === 'string' ? task.status : action === 'approve' ? 'approved' : 'denied'
  return `${action === 'approve' ? 'Approved' : 'Denied'} ${taskId} (${status})\n`
}

function formatEvent(value: JsonValue): string {
  if (!isRecord(value)) return JSON.stringify(value)
  // Wire shape is { cursor, event } where event is the canonical umbilical
  // envelope. Fall back to the bare envelope if a caller hands us one.
  const envelope = isRecord(value.event) ? value.event : value
  const cursor = value.cursor ?? envelope.seq
  const seq = String(cursor ?? '')
  const type = String(envelope.event_type ?? '')
  const agent = envelope.agent_id ? ` ${String(envelope.agent_id)}` : ''
  const payload = isRecord(envelope.payload) ? envelope.payload : {}
  const detail = typeof payload.message === 'string'
    ? payload.message
    : typeof payload.type === 'string'
      ? payload.type
      : ''
  return `[${seq}] ${type}${agent}${detail ? ` ${detail}` : ''}`
}

function formatJsonPretty(value: JsonValue): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, i) => Math.max(header.length, ...rows.map(row => (row[i] ?? '').length)))
  const renderRow = (row: string[]) => row.map((cell, i) => cell.padEnd(widths[i])).join('  ')
  return `${renderRow(headers)}\n${widths.map(width => '-'.repeat(width)).join('  ')}\n${rows.map(renderRow).join('\n')}\n`
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`
}

function formatNumber(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : ''
}

function enc(value: string): string {
  return encodeURIComponent(value)
}

function isRecord(value: JsonValue | unknown): value is Record<string, JsonValue> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function usage(): string {
  return `Usage: adf [--url <daemon-url>] [--json] <command>
       adf [tui] [--view <id>] [--agent <id>] [--loop <name>]
       adf daemon [start|status|stop|restart|logs]

With no command, adf opens the interactive TUI (see \`adf tui --help\`).
When the daemon URL is on this machine and nothing answers there, adf
starts the daemon in the background first (--no-daemon or
ADF_NO_AUTOSTART=1 turn that off). Quitting leaves it running.

Commands:
  tui                            Interactive terminal UI (the default)
  agents                         List loaded agents
  status <agent>                 Show runtime status
  start <agent>                  Start an agent and fire startup when applicable
  stop <agent>                   Stop and unload an agent
  unload <agent>                 Alias for stop
  loops <agent>                  List the agent's loops: main plus its inner
                                  (side) loops, parallel threads with their own
                                  history, e.g. a memory consolidator on a timer
  interrupt <agent> [--loop <name>]
                                  End the running turn; the loop goes idle and
                                  keeps accepting chats, timers and triggers
  abort <agent> [--loop <name>]  Hard-abort the current turn without unloading;
                                  that loop stays stopped until the agent is
                                  reloaded (prefer interrupt)
  runtime [agent]                Show daemon or agent runtime diagnostics
  providers                      Show provider configuration and agent resolution
  auth                           Show auth and credential presence
  auth login <chatgpt|grok>      Sign in to a subscription provider
                                  [--relay|--loopback] chooses where the
                                  ChatGPT OAuth callback is served; defaults to
                                  relay when --url points at a remote daemon
  auth logout <chatgpt|grok>     Clear a subscription provider's tokens
  settings                       Show sanitized daemon runtime settings
  network                        Show mesh and WebSocket diagnostics
  network mesh [enable|disable]  Control daemon mesh registration
  network server [start|stop|restart]
                                  Control the mesh HTTP server
  network tools|lan|runtimes     Show mesh tools, LAN addresses, or peers
  usage [agent]                  Show runtime or agent token usage
  config <agent>                 Show agent config
  files <agent>                  List agent files
  file <agent> <path>            Print one agent file
  inbox <agent>                  List inbox messages
  outbox <agent>                 List outbox messages
  timers <agent>                 List timers
  tasks <agent>                  List tasks and pending approvals
  task <agent> <taskId>          Show one task
  approve <agent> <taskId>       Approve a pending task
  deny <agent> <taskId> [reason] Deny a pending task
  asks <agent>                   List pending ask requests
  answer <agent> <requestId> <answer>
                                  Answer a pending ask request
  identities <agent>             List identity metadata without secret values
  mcp [agent]                    Show daemon MCP registrations or agent MCP state
  adapters [agent]               Show daemon adapter registrations or agent adapter state
  events [agent]                 Follow daemon SSE events
  chat <agent> [--loop <name>] <message>
                                  Send chat (to main, or an inner loop) and
                                  print the accepted turn id
  identity                       Show the owner identity status
  identity new                   Create an owner identity; shows the 12-word
                                  seed phrase once — write it down
  identity restore               Restore the owner identity from its seed
                                  phrase (typed at a hidden prompt; the same
                                  phrase as ADF Studio = the same owner)
  identity unlock|lock           Unlock/lock a passphrase-protected identity
                                  (machines without an OS keychain)
  templates                      List agent templates
  new [name] [--template <id>] [--provider <id>] [--model <id>]
      [--dir <path>] [--start]   Create an agent from a template, sealed
                                  with the owner identity (like Studio)

Daemon:
  daemon [--port <n>] [--host <h>] [--settings <file>]
                                  Run the daemon in the foreground (Ctrl+C
                                  stops it; also ADF_DAEMON_PORT,
                                  ADF_DAEMON_HOST, ADF_DAEMON_SETTINGS,
                                  ADF_USER_DATA_DIR)
  daemon start [--port <n>] [--force]
                                  Start it in the background (what adf does
                                  on its own); --force skips the ADF Studio
                                  check
  daemon status                  Is it running: pid, uptime, version, log file
  daemon stop                    Stop it gracefully (agents unloaded,
                                  containers stopped)
  daemon restart                 Stop, then start in the background
  daemon logs [-f] [-n <lines>]  Show the background daemon's log (-f follows)

Options:
  --url, -u <url>                Daemon URL
  --json                         JSON output
  --no-daemon                    Never start the daemon automatically
  --version, -v                  Print the version

Environment:
  ADF_DAEMON_URL                 Defaults to ${DEFAULT_DAEMON_URL}
  ADF_DAEMON_TOKEN               Bearer token sent to the daemon when set
  ADF_NO_AUTOSTART=1             Same as --no-daemon`
}

