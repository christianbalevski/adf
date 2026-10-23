// The one-shot CLI and TUI dispatch. The `adf` executable is bin.ts; it
// calls runCli (this module never runs itself).

import { createInterface } from 'readline'
import { readFileSync } from 'fs'
import { basename } from 'path'
import { runPair, runRemotes, type PairIo } from './pair'
import { pinnedRemoteRefusal, RemoteMalformedError, RemotesUnreadableError } from './remotes'
import { stdinPrompt, type LinePrompt } from './prompt'
import { DEFAULT_DAEMON_URL, isLocalDaemonUrl, localProofHeaders, loopbackPort, resolveDaemonToken, resolveDaemonUrl, tunnelTokenHint } from './daemon-url'
import {
  AUTH_PROVIDER_LABELS,
  loginChatGpt,
  loginClaude,
  loginGrok,
  normalizeAuthProvider,
  openBrowser,
  submitClaudeCode,
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
  /**
   * Test seam for line input read while something else runs (the Claude
   * sign-in code). Calls onLine per line until the returned stop is called.
   * Default: stdin lines when it is a TTY, nothing otherwise.
   */
  readLines?: (onLine: (line: string) => void) => () => void
  /** Test seam for Ctrl-C. Calls fn on interrupt until the returned stop is called. */
  onInterrupt?: (fn: () => void) => () => void
  /** Test seam: daemon discovery (adf pair without a host). */
  discover?: PairIo['discover']
  /** Test seam: the environment adf reads (daemon URL, tokens, saved remotes). Default: process.env. */
  env?: NodeJS.ProcessEnv
}

export interface CliCallbackServer {
  port: number
  waitForCallback: () => Promise<{ code: string; state: string }>
  close: () => void
}

interface CliOptions {
  daemonUrl: string
  json: boolean
  /** --token; else ADF_DAEMON_TOKEN, else (loopback) the local token file. */
  token?: string
  /** io.env, else process.env: every lookup of the URL, the token and the local proof reads it. */
  env: NodeJS.ProcessEnv
}

interface ParsedArgs {
  command: string
  args: string[]
  /** All but the daemon URL: runCli resolves it only for a command that talks to a daemon. */
  options: Omit<CliOptions, 'daemonUrl' | 'env'>
  /** --url as given, else null. */
  explicitUrl: string | null
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

const defaultIo: CliIo = {
  fetch: globalThis.fetch.bind(globalThis),
  stdout: text => process.stdout.write(text),
  stderr: text => process.stderr.write(text),
}

/** Flags only the TUI understands; `adf --view chat` means "open the TUI". */
const TUI_FLAGS = new Set(['--view', '--agent', '--loop', '--theme', '--mono', '--no-color', '--ascii', '--no-alt-screen', '--no-mouse', '--mouse', '--no-kitty'])

/** The argv to hand the TUI, or null when this is a one-shot command (or help). */
export function tuiInvocation(argv: string[]): string[] | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--url' || arg === '-u' || arg === '--token') { i++; continue }
    if (arg.startsWith('--url=') || arg.startsWith('--token=') || arg === '--json') continue
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
function urlFromArgv(argv: string[], env: NodeJS.ProcessEnv): string {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url' || argv[i] === '-u') return resolveDaemonUrl(argv[i + 1], env)
    if (argv[i].startsWith('--url=')) return resolveDaemonUrl(argv[i].slice(6), env)
  }
  return resolveDaemonUrl(undefined, env)
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

/**
 * A saved remote's device token goes only to the computer it was paired with
 * (remotes.ts pinnedRemoteRefusal). False = refused, and the reason printed.
 */
async function pinnedRemoteOk(io: CliIo, url: string, explicitToken: boolean): Promise<boolean> {
  const env = io.env ?? process.env
  if (explicitToken || env.ADF_DAEMON_TOKEN) return true
  // A host rate-limiting hellos (429) is waited out twice, said each time; then the command stops (the token never sent).
  const refusal = await pinnedRemoteRefusal(url, env, io.fetch, { retries: 2, onWait: (sentence) => io.stderr(`${sentence}\n`), ...(io.sleep ? { sleep: io.sleep } : {}) })
  if (refusal) io.stderr(`${refusal}\n`)
  return refusal === null
}

export async function runCli(argv = process.argv.slice(2), io: CliIo = defaultIo): Promise<number> {
  const tuiArgv = tuiInvocation(argv)
  if (tuiArgv) {
    const wantsHelp = tuiArgv.includes('--help') || tuiArgv.includes('-h')
    let tuiUrl = ''
    try {
      if (!wantsHelp) tuiUrl = urlFromArgv(tuiArgv, io.env ?? process.env)
    } catch (err) {
      // An unknown remote name, or a saved remotes file that cannot be read.
      io.stderr(`${err instanceof Error ? err.message : String(err)}\n`)
      return 1
    }
    if (!wantsHelp && !(await pinnedRemoteOk(io, tuiUrl, tuiArgv.some(a => a === '--token' || a.startsWith('--token='))))) return 1
    const ready = wantsHelp ? { ok: true, started: null } : await daemonReady(io, tuiUrl)
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

  const { command, args } = parsed
  // help, pair and remotes talk to no daemon: only the other commands resolve the URL, and so read the saved remotes.
  const talksToDaemon = !['help', '--help', '-h', 'pair', 'remotes'].includes(command)
  let options: CliOptions
  try {
    const env = io.env ?? process.env
    options = { ...parsed.options, env, daemonUrl: talksToDaemon ? resolveDaemonUrl(parsed.explicitUrl ?? undefined, env) : '' }
  } catch (err) {
    // Not a usage mistake: the saved remotes file needs fixing.
    if (err instanceof RemotesUnreadableError || err instanceof RemoteMalformedError) {
      io.stderr(`${err.message}\n`)
      return 1
    }
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n\n${usage()}\n`)
    return 2
  }
  if (talksToDaemon && !(await pinnedRemoteOk(io, options.daemonUrl, !!options.token))) return 1
  // pair / remotes talk to other computers or read local files: they never start this machine's daemon.
  if (talksToDaemon && !(await daemonReady(io, options.daemonUrl)).ok) return 1

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
      case 'pair': {
        const prompt = io.prompt ? null : stdinPrompt()
        try {
          return await runPair(args, { fetch: io.fetch, stdout: io.stdout, stderr: io.stderr, prompt: io.prompt ? ((q) => (io.prompt as NonNullable<CliIo['prompt']>)(q)) : ((q) => (prompt as LinePrompt).ask(q)), ...(io.discover ? { discover: io.discover } : {}), ...(io.sleep ? { sleep: io.sleep } : {}), ...(io.env ? { env: io.env } : {}) })
        } finally {
          prompt?.close()
        }
      }
      case 'remotes':
        return await runRemotes(args, { stdout: io.stdout, stderr: io.stderr, ...(io.env ? { env: io.env } : {}) }, options.json)
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
  // Resolved by runCli, only without --url: a saved list that cannot be read stops no command given an address.
  let daemonUrl: string | null = null
  let json = false
  let token: string | undefined
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
    } else if (arg === '--token') {
      const value = args[++i]
      if (!value) throw new Error('--token requires a value')
      token = value
    } else if (arg.startsWith('--token=')) {
      token = arg.slice('--token='.length)
    } else {
      positional.push(arg)
    }
  }

  return {
    command: positional[0] ?? 'help',
    args: positional.slice(1),
    options: {
      json,
      ...(token ? { token } : {}),
    },
    explicitUrl: daemonUrl,
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

/** Resolved per request: an auto-started daemon writes its token file on first start. */
function authHeader(options: CliOptions): Record<string, string> {
  const token = resolveDaemonToken(options.token, options.env, options.daemonUrl)
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function requestJson(io: CliIo, options: CliOptions, path: string, init?: RequestInit): Promise<JsonValue> {
  let response: Response
  try {
    response = await io.fetch(`${options.daemonUrl}${path}`, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        Accept: 'application/json',
        ...authHeader(options),
        ...localProofHeaders(options.daemonUrl, path, options.env),
      },
    })
  } catch (err) {
    if (err instanceof TypeError) {
      const forwarded = loopbackPort(options.daemonUrl) !== null && !isLocalDaemonUrl(options.daemonUrl, options.env)
      throw new Error(`Cannot reach the ADF daemon at ${options.daemonUrl} (${err.message}). ${forwarded
        ? 'That is not this machine\'s daemon port, so adf did not start one there: check the SSH tunnel, or start a daemon on it with: adf daemon start --port <n>'
        : 'Start it with: adf daemon start'}`)
    }
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
    const hint = response.status === 401 ? tunnelTokenHint(options.daemonUrl, options.token, options.env) : null
    throw new DaemonRequestError(hint ? `${message}\n${hint}` : message, response.status, isRecord(body) && typeof body.code === 'string' ? body.code : null)
  }
  return body
}

/** A daemon error response: the message as before, plus its status and `code` for callers that branch on them. */
class DaemonRequestError extends Error {
  constructor(message: string, readonly status: number, readonly apiCode: string | null) {
    super(message)
    this.name = 'DaemonRequestError'
  }
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

/** Pull `--answers <json>` / `--answers=<json>` out of a command's arguments. */
function takeAnswersFlag(args: string[]): { answers: string | undefined; rest: string[] } {
  const rest: string[] = []
  let answers: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--answers') {
      answers = args[++i]
      if (answers === undefined) throw new Error('--answers requires a JSON array')
    } else if (arg.startsWith('--answers=')) {
      answers = arg.slice('--answers='.length)
    } else {
      rest.push(arg)
    }
  }
  return { answers, rest }
}

/** Pull every `--attach <file>` / `--attach=<file>` out of a command's arguments. */
function takeAttachments(args: string[]): { files: string[]; rest: string[] } {
  const rest: string[] = []
  const files: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--attach') {
      const file = args[++i]
      if (!file) throw new Error('--attach requires a file path')
      files.push(file)
    } else if (arg.startsWith('--attach=')) {
      files.push(arg.slice('--attach='.length))
    } else {
      rest.push(arg)
    }
  }
  return { files, rest }
}

/** Uploads land where Studio's do: `loop-upload/<name>`, numbered when the name is taken. */
function uploadName(file: string): string {
  const name = basename(file).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '') || 'attachment'
  return `loop-upload/${name}`
}

async function sendChat(io: CliIo, options: CliOptions, args: string[]): Promise<number> {
  const attached = takeAttachments(args)
  const { loop, rest } = takeLoop(attached.rest)
  const agent = rest[0]
  const text = rest.slice(1).join(' ')
  if (!agent || (!text && attached.files.length === 0)) throw new Error('Usage: adf chat <agent> [--loop <name>] [--attach <file>]... <message>')
  // Each file goes to the agent's Files first; the message carries a reference.
  const refs: Array<{ type: 'file_ref'; file_ref: { path: string; mime_type: string; size: number } }> = []
  for (const file of attached.files) {
    let bytes: Buffer
    try {
      bytes = readFileSync(file)
    } catch (err) {
      throw new Error(`Cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`)
    }
    const saved = await requestJson(io, options, `/agents/${enc(agent)}/files/raw?path=${enc(uploadName(file))}&unique=true`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(bytes),
    })
    const path = isRecord(saved) && typeof saved.path === 'string' ? saved.path : uploadName(file)
    // The runtime takes the type and size from the stored file.
    refs.push({ type: 'file_ref', file_ref: { path, mime_type: '', size: bytes.length } })
  }
  const body = refs.length > 0
    ? { content: [...(text ? [{ type: 'text', text }] : []), ...refs] }
    : { text }
  const data = await requestJson(io, options, `/agents/${enc(agent)}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, ...(loop ? { loop } : {}) }),
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

const ANSWER_USAGE = "Usage: adf answer <agent> <requestId> [--loop <name>] <answer>, or --answers '<json array>' for a form"

/**
 * A bare answer fits a one-question ask; a form takes `--answers`, one entry
 * per question (a string, an array of picks, or null to skip).
 */
async function answerAsk(io: CliIo, options: CliOptions, argv: string[]): Promise<number> {
  const { loop, rest: afterLoop } = takeLoop(argv)
  const { answers: answersJson, rest: args } = takeAnswersFlag(afterLoop)
  const agent = args[0]
  const requestId = args[1]
  const text = args.slice(2).join(' ')
  if (!agent || !requestId || (answersJson === undefined) === !text) throw new Error(ANSWER_USAGE)
  let answers: unknown
  if (answersJson !== undefined) {
    try {
      answers = JSON.parse(answersJson)
    } catch {
      throw new Error(`--answers is not valid JSON. ${ANSWER_USAGE}`)
    }
    if (!Array.isArray(answers)) throw new Error("--answers must be a JSON array with one entry per question, e.g. '[\"yes\", [\"a\", \"b\"], null]'")
  } else {
    // A bare answer only fits a one-question ask: read the form first.
    const listed = await requestJson(io, options, `/agents/${enc(agent)}/asks`)
    const asks = isRecord(listed) && Array.isArray(listed.asks) ? listed.asks.filter(isRecord) : []
    const pending = asks.find(ask => ask.requestId === requestId && (loop === undefined || ask.loop === loop))
    if (!pending) throw new Error(`No pending ask "${requestId}" on ${agent}${loop ? ` in loop "${loop}"` : ''} (already answered, or never asked).`)
    const count = Array.isArray(pending.questions) ? pending.questions.length : 1
    if (count !== 1) {
      throw new Error(`${requestId} is a form with ${count} questions: answer with --answers '<json array>', one entry per question (a string, an array of picks, or null to skip).`)
    }
    answers = [text]
  }
  const data = await requestJson(io, options, `/agents/${enc(agent)}/asks/${enc(requestId)}/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answers, ...(loop ? { loop } : {}) }),
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
  if (!provider) throw new Error('Specify a provider: chatgpt, grok or claude')
  return provider
}

async function authCommand(io: CliIo, options: CliOptions, args: string[]): Promise<number> {
  const flags = new Set(args.filter(arg => arg.startsWith('--')))
  const positional = args.filter(arg => !arg.startsWith('--'))
  const action = positional[0]

  if (action === 'status') return await printGet(io, options, '/runtime/auth', formatAuth)

  if (action === 'login') {
    const provider = requireAuthProvider(positional[1])
    if (provider === 'claude') return await loginClaudeCli(io, options)
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

  throw new Error('Usage: adf auth [status | login <chatgpt|grok|claude> | logout <chatgpt|grok|claude>]')
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

async function loginClaudeCli(io: CliIo, options: CliOptions): Promise<number> {
  // Claude Code on the daemon host runs the sign-in and opens the browser
  // there; the URL is the fallback, a pasted code is relayed to it.
  const stop = new AbortController()
  const deps: AuthFlowDeps = { ...authDeps(io, options), signal: stop.signal }
  let stopLines = () => {}
  const stopInterrupt = (io.onInterrupt ?? defaultOnInterrupt)(() => stop.abort())
  try {
    const outcome = await loginClaude(deps, {
      // --json hands out the start answer and stops waiting; the daemon's
      // sign-in keeps running (only Ctrl-C cancels it), like ChatGPT/Grok.
      wait: !options.json,
      onStart: (info) => {
        if (options.json) {
          io.stdout(`${JSON.stringify(info.raw, null, 2)}\n`)
          return
        }
        io.stdout(`Opening Claude sign-in in your browser…\n${info.url ? `If it does not open, visit:\n\n  ${info.url}\n\n` : '\n'}If the page shows a code, paste it here (or wait): `)
        stopLines = (io.readLines ?? defaultReadLines)((line) => {
          const code = line.trim()
          if (!code) return
          submitClaudeCode(deps, code)
            .then(() => io.stdout('Code sent. Waiting for Claude Code to finish...\n'))
            .catch((err: unknown) => io.stderr(`Could not send the code: ${err instanceof Error ? err.message : String(err)}\n`))
        })
      },
    })
    if (!outcome.ok && outcome.notInstalled) {
      io.stderr(`${outcome.error}\n`)
      return 1
    }
    if (options.json) return outcome.ok || outcome.detached ? 0 : outcome.cancelled ? 130 : reportAuth(io, 'claude', outcome)
    io.stdout('\n')
    if (outcome.ok) {
      const plan = isRecord(outcome.raw) && typeof outcome.raw.plan === 'string' ? outcome.raw.plan : ''
      io.stdout(`Signed in to Claude${outcome.email ? ` as ${outcome.email}` : ''}${plan ? ` (${plan} plan)` : ''}.\n`)
      return 0
    }
    if (outcome.cancelled) {
      io.stderr('Claude sign-in cancelled.\n')
      return 130
    }
    return reportAuth(io, 'claude', outcome)
  } finally {
    stopLines()
    stopInterrupt()
  }
}

function defaultReadLines(onLine: (line: string) => void): () => void {
  if (!process.stdin.isTTY) return () => {}
  const rl = createInterface({ input: process.stdin, terminal: false, historySize: 0 })
  rl.on('line', onLine)
  return () => { rl.close(); process.stdin.pause() }
}

function defaultOnInterrupt(fn: () => void): () => void {
  process.once('SIGINT', fn)
  return () => { process.removeListener('SIGINT', fn) }
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
    headers: { Accept: 'text/event-stream', ...authHeader(options) },
  })
  if (!response.ok || !response.body) {
    const detail = await response.json().catch(() => null) as { error?: unknown } | null
    const hint = response.status === 401 ? tunnelTokenHint(options.daemonUrl, options.token, options.env) : null
    throw new Error(`Event stream failed: ${typeof detail?.error === 'string' ? detail.error : `HTTP ${response.status} ${response.statusText}`}${hint ? `\n${hint}` : ''}`)
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
      // Stream control frames: the hello is bookkeeping; a gap is worth saying.
      const name = part.split(/\n/).find(line => line.startsWith('event: '))?.slice('event: '.length)
      if (name === 'stream.hello') continue
      if (name === 'stream.gap') {
        let reason = 'unknown'
        try { reason = String((JSON.parse(payload) as { reason?: unknown }).reason) } catch { /* keep unknown */ }
        io.stderr(`Some events were not replayed (${reason === 'epoch_changed' ? 'the daemon restarted' : 'the replay buffer moved past them'}).\n`)
        continue
      }
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

  if (action === 'import') return await importIdentity(io, options, args.slice(1))

  if (action === 'restore') {
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

  if (action === 'trust-daemon') return await trustDaemon(io, options, args.slice(1))

  if (action === 'untrust-daemon') {
    const answer = await postJson(io, options, '/identity/untrust-daemon')
    if (options.json) {
      io.stdout(`${JSON.stringify(answer, null, 2)}\n`)
      return 0
    }
    const result = isRecord(answer) ? answer : {}
    const trust = isRecord(result.trust) ? result.trust : {}
    io.stdout(
      `Revoked key ${String(result.retiredLabel ?? '')}: the daemon now uses a new key, and the old one no longer opens anything here.\n` +
      `Slots removed from ${String(result.agentsUpdated ?? 0)} loaded agent(s); the tracked folders are swept in the background, and\n` +
      'ADF Studio removes the slot from each agent it opens. A copy of an agent outside the tracked folders keeps the old slot\n' +
      'until it is opened, and anyone holding a copy of the old key file can open that slot until then.\n' +
      `${String(trust.message ?? '')}\n`,
    )
    return 0
  }

  throw new Error('Usage: adf identity [status | new | restore | import | unlock | lock | trust-daemon | untrust-daemon]')
}

/**
 * `adf identity trust-daemon` (K12, no OS keychain): the owner lets ADF
 * Studio wrap agent credentials to this daemon's key. Says what that means
 * and asks for "trust" first, unless --yes.
 */
async function trustDaemon(io: CliIo, options: CliOptions, args: string[]): Promise<number> {
  for (const arg of args) {
    if (arg !== '--yes') throw new Error(`Unknown option for adf identity trust-daemon: ${arg}`)
  }
  const current = await requestJson(io, options, '/identity')
  const trust = isRecord(current) && isRecord(current.trust) ? current.trust : null
  if (trust?.state === 'trusted') {
    io.stdout(`${String(trust.message ?? '')}\n`)
    return 0
  }
  if (!args.includes('--yes')) {
    io.stdout(
      'Trusting this daemon adds its key (the runtime-enc-key file next to the daemon settings) to\n' +
      'trustedDaemonEncKeys. ADF Studio then wraps every agent\'s credentials to that key, so anyone who\n' +
      'can read that file, or write the settings file, can unlock them without the owner passphrase.\n' +
      'The grant is an entry in the settings file, not a signed statement.\n' +
      'Revoke it with adf identity untrust-daemon.\n',
    )
    const answer = (await ask(io, 'Type "trust" to go ahead: ')).trim().toLowerCase()
    if (answer !== 'trust') {
      io.stdout('Nothing was changed.\n')
      return 1
    }
  }
  const answer = await postJson(io, options, '/identity/trust-daemon', { confirm: true })
  if (options.json) {
    io.stdout(`${JSON.stringify(answer, null, 2)}\n`)
    return 0
  }
  const result = isRecord(answer) ? answer : {}
  const granted = isRecord(result.trust) ? result.trust : {}
  io.stdout(`${String(granted.message ?? '')}\nSlots added to ${String(result.agentsUpdated ?? 0)} loaded agent(s).\n`)
  return 0
}

/**
 * `adf identity import`: Studio's Import identity. The same owner's phrase
 * acts as a restore; another owner's phrase replaces this machine's owner
 * after the user types "switch" (the daemon names both DIDs first). The
 * daemon refuses a switch while the previous owner's backup is unconfirmed;
 * --i-have-a-backup states that the user holds that phrase.
 */
async function importIdentity(io: CliIo, options: CliOptions, args: string[] = []): Promise<number> {
  for (const arg of args) {
    if (arg !== '--i-have-a-backup') throw new Error(`Unknown option for adf identity import: ${arg}`)
  }
  const haveBackup = args.includes('--i-have-a-backup')
  const current = await requestJson(io, options, '/identity')
  if (isRecord(current) && typeof current.ownerDid === 'string' && current.ownerDid) {
    io.stdout(`This machine's owner is ${current.ownerDid}. A phrase of another owner replaces it.\n`)
  }
  const mnemonic = (await ask(io, 'Seed phrase (12 words, input hidden): ', true)).trim()
  if (!mnemonic) throw new Error('No seed phrase entered.')
  const passphrase = await passphraseIfNeeded(io, current, isRecord(current) && current.status !== 'locked')
  const body: Record<string, unknown> = { mnemonic, ...(passphrase ? { passphrase } : {}), ...(haveBackup ? { previousOwnerBackupConfirmed: true } : {}) }
  let imported: JsonValue
  try {
    imported = await postJson(io, options, '/identity/import', body)
  } catch (err) {
    if (!(err instanceof DaemonRequestError) || err.apiCode !== 'switch_unconfirmed') throw err
    io.stdout(`${err.message}\n`)
    const answer = (await ask(io, 'Type "switch" to replace the owner: ')).trim().toLowerCase()
    if (answer !== 'switch') {
      io.stdout('Nothing was changed.\n')
      return 1
    }
    imported = await postJson(io, options, '/identity/import', { ...body, switchOwner: true })
  }
  if (options.json) {
    io.stdout(`${JSON.stringify(imported, null, 2)}\n`)
    return 0
  }
  const result = isRecord(imported) ? imported : {}
  const identity = isRecord(result.identity) ? result.identity : {}
  const restamp = isRecord(result.restamp) ? result.restamp : {}
  const failures = Array.isArray(restamp.failures) ? restamp.failures.map(String) : []
  const skipped = Array.isArray(restamp.skipped) ? restamp.skipped.map(String) : []
  const reloadFailures = Array.isArray(result.reloadFailures) ? result.reloadFailures.filter(isRecord) : []
  io.stdout(
    `${result.switched === true ? `Owner switched from ${String(result.previousOwnerDid ?? '')}.` : 'Owner identity imported.'}\n` +
    formatIdentity(identity) +
    `Restamped ${String(restamp.restamped ?? 0)} agent file(s), ${failures.length} failure(s).\n` +
    failures.map(f => `  ${f}\n`).join('') +
    (skipped.length ? `Not restamped now, another runtime runs them (restamped when next opened):\n${skipped.map(f => `  ${f}\n`).join('')}` : '') +
    reloadFailures.map(f => `Could not reload ${String(f.name ?? '')} (${String(f.filePath ?? '')}): ${String(f.error ?? '')}\n`).join(''),
  )
  return failures.length > 0 || reloadFailures.length > 0 ? 1 : 0
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
    ...(isRecord(value.runtime) ? [['runtime', `${String(value.runtime.source ?? '')} (${String(value.runtime.state ?? '')})`]] : []),
    ...(isRecord(value.trust) && value.trust.state !== 'not-applicable' ? [['daemonKey', String(value.trust.state ?? '')]] : []),
    ['storage', String(value.storage ?? '')],
    ['backupConfirmed', String(value.backupConfirmed ?? false)],
  ])}${typeof value.message === 'string' ? `${value.message}\n` : ''}` +
    // Only the actionable case: a Studio runtime entry exists but was not used.
    (isRecord(value.runtime) && value.runtime.state === 'rejected' && typeof value.runtime.message === 'string'
      ? `${value.runtime.message}\n`
      : '')
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
  const claude = isRecord(value.claude) ? value.claude : {}
  const providers = Array.isArray(value.providers) ? value.providers.filter(isRecord) : []
  const chatgptTable = `ChatGPT:\n${table(['field', 'value'], [
    ['authenticated', String(chatgpt.authenticated ?? false)],
    ['email', String(chatgpt.email ?? '')],
  ])}`
  const grokTable = `Grok:\n${table(['field', 'value'], [
    ['authenticated', String(grok.authenticated ?? false)],
    ['email', String(grok.email ?? '')],
  ])}`
  const claudeRows: string[][] = claude.installed === false
    ? [['authenticated', 'false'], ['claude code', `not installed (${String(claude.installUrl ?? '')})`]]
    : [
      ['authenticated', String(claude.authenticated ?? false)],
      ['email', String(claude.email ?? '')],
      ['plan', String(claude.plan ?? '')],
      ['claude code', claude.updateRequired
        ? `${String(claude.version ?? '')} (update required: ADF needs ${String(claude.minVersion ?? '')} or newer)`
        : String(claude.version ?? '')],
      ...(typeof claude.flowError === 'string' && claude.flowError ? [['error', claude.flowError]] : []),
    ]
  const claudeTable = `Claude:\n${table(['field', 'value'], claudeRows)}`
  const providersTable = providers.length === 0
    ? 'Provider credentials: none\n'
    : `Provider credentials:\n${table(['id', 'type', 'storage', 'apiKey'], providers.map(provider => [
      String(provider.id ?? ''),
      String(provider.type ?? ''),
      String(provider.credentialStorage ?? ''),
      String(provider.hasApiKey ?? false),
    ]))}`
  return `${chatgptTable}\n${grokTable}\n${claudeTable}\n${providersTable}`
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
  return `ADF CLI: run and talk to your ADF agents from a terminal.

Usage: adf [--url <daemon-url>] [--json] <command>
       adf [tui] [--view <id>] [--agent <id>] [--loop <name>]
       adf daemon [start|status|stop|restart|logs|token]

With no command, adf opens the terminal app (see \`adf tui --help\`).
When the daemon URL is this machine's daemon (127.0.0.1 or localhost on
port 7385 or ADF_DAEMON_PORT) and nothing answers there, adf starts the
daemon in the background first (--no-daemon or ADF_NO_AUTOSTART=1 turn
that off). Quitting leaves it running. Another local port, such as an SSH
tunnel, is never auto-started and needs --token.

Commands:
  tui                            The terminal app (the default)
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
  auth login <chatgpt|grok|claude>
                                  Sign in to a subscription provider
                                  [--relay|--loopback] chooses where the
                                  ChatGPT OAuth callback is served; defaults to
                                  relay when --url points at a remote daemon.
                                  claude signs in through Claude Code on the
                                  daemon host (ADF stores no Claude credentials)
  auth logout <chatgpt|grok|claude>
                                  Clear a subscription provider's tokens
                                  (claude: signs Claude Code out on that host)
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
  answer <agent> <requestId> [--loop <name>] <answer>
                                  Answer a pending one-question ask
  answer <agent> <requestId> [--loop <name>] --answers '<json>'
                                  Answer an ask form: a JSON array with one
                                  entry per question, in order: text or an
                                  option label, an array of labels for a
                                  multi-pick question, or null to skip
  identities <agent>             List identity metadata without secret values
  mcp [agent]                    Show daemon MCP registrations or agent MCP state
  adapters [agent]               Show daemon adapter registrations or agent adapter state
  events [agent]                 Follow daemon SSE events
  chat <agent> [--loop <name>] [--attach <file>]... <message>
                                  Send chat (to main, or an inner loop) and
                                  print the accepted turn id. --attach uploads
                                  a file to the agent's loop-upload/ folder
                                  and attaches it
  identity                       Show the owner identity status
  identity new                   Create an owner identity; shows the 12-word
                                  seed phrase once — write it down
  identity restore               Restore the owner identity from its seed
                                  phrase (typed at a hidden prompt; the same
                                  phrase as ADF Studio = the same owner)
  identity import [--i-have-a-backup]
                                  Import an owner phrase like Studio's Import
                                  identity: another owner's phrase replaces
                                  this machine's owner (asks first; needs the
                                  old phrase backed up) and restamps local
                                  agents
  identity unlock|lock          Unlock/lock a passphrase-protected identity
                                  (machines without an OS keychain)
  identity trust-daemon [--yes]  No OS keychain: let ADF Studio wrap agent
                                  credentials to this daemon's key file, so
                                  they unlock without the passphrase (asks)
  identity untrust-daemon        Revoke that trust
  templates                      List agent templates
  new [name] [--template <id>] [--provider <id>] [--model <id>]
      [--dir <path>] [--start]   Create an agent from a template, sealed
                                  with the owner identity (like Studio)
  pair [<host>[:<port>]]
      [--name <n>] [--yes]       Pair with another computer's daemon (its
                                  6-digit code); without a host, lists the
                                  ADF computers found on this network and
                                  your tailnet. Saves the device token
  remotes [use <name|local> | forget <name>]
                                  Saved remote daemons; use picks the default

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
  daemon token                   Print this machine's daemon access token
                                  (this machine only; other computers get a
                                  device token: daemon devices add / pair)
  daemon remote on|off|status    Remote access (live, no restart); also
                                  trust|untrust, serve on|off
  daemon devices [list|add <label>|revoke <id|label>]
                                  Computers with a device token
  daemon pair                    Open a pairing window and show its code

Options:
  --url, -u <url>                Daemon URL
  --remote <name>                A daemon saved by adf pair (adf remotes)
  --token <token>                Daemon access token (default: ADF_DAEMON_TOKEN,
                                  else the local daemon's token file)
  --json                         JSON output
  --no-daemon                    Never start the daemon automatically
  --version, -v                  Print the version

Environment:
  ADF_DAEMON_URL                 Defaults to ${DEFAULT_DAEMON_URL}
  ADF_DAEMON_TOKEN               Daemon access token (overrides the local
                                  <data dir>/daemon-token file)
  ADF_NO_AUTOSTART=1             Same as --no-daemon
  ADF_REMOTE                     Same as --remote (local = this computer)`
}

