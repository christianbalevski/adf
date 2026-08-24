import { spawn as nodeSpawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'
import { existsSync } from 'fs'
import { createServer } from 'net'
import type { Server, Socket } from 'net'
import type { McpServerConfig } from '../../shared/types/adf-v02.types'
import { trackChild, killTree } from '../utils/child-registry'

/**
 * Interactive-auth preflight for stdio MCP servers (OAuth etc.): spawn the
 * server once in its auth mode, surface the authorization URL to the user,
 * and wait for authorization to finish before the real connect.
 *
 * Runtime-agnostic core — MUST NOT import 'electron'. Each runtime supplies
 * its IO:
 *  - Studio (foreground AND background agents) passes an interactive IO whose
 *    `confirm` shows the dialog and whose `openUrl` is shell.openExternal.
 *  - Headless runtimes (daemon/CLI) use createHeadlessMcpAuthPreflight():
 *    best-effort browser open, log the URL, and wait for the auth subcommand
 *    to exit on its own (most OAuth `auth` subcommands exit after storing
 *    tokens), failing plainly on nonzero exit or timeout.
 */
export interface McpAuthPreflightIO {
  /** Open the scraped authorization URL (e.g. shell.openExternal). */
  openUrl: (url: string) => void | Promise<void>
  /**
   * Interactive mode: block until the user confirms authorization completed.
   * When absent, headless mode: wait for the child to exit instead.
   */
  confirm?: (info: { serverName: string; authUrlOpened: boolean }) => Promise<void>
  log?: (msg: string) => void
  /** Headless mode only: max wait for the auth subcommand to exit. */
  waitForExitTimeoutMs?: number
  /**
   * Startup grace (default 3s). No scraped URL is opened before it elapses —
   * an auth command that exits first fails the install with its stderr
   * instead of sending the browser to a link from error text. Interactive
   * mode also waits this long before showing the confirm dialog.
   */
  startupGraceMs?: number
}

/** Where to run the auth subcommand when routing containerizes the server. */
export interface ContainerAuthTarget {
  podmanBin: string
  containerName: string
  /** In-container command from resolveContainerCommand (npx/uvx/custom). */
  command: string
  args: string[]
  /** Agent-scoped HOME (containerAgentHome) — exported first so an explicit serverCfg.env.HOME wins. */
  home?: string
}

export interface McpAuthPreflightOpts {
  authArgs?: string[]
  resolvedEnv?: Record<string, string>
  uvBinPath?: string
  /**
   * When set, the auth subcommand runs INSIDE this container via `podman
   * exec` so credentials persist where the server will actually run, and an
   * ephemeral loopback tunnel forwards the OAuth callback port from the host
   * browser into the container.
   */
  container?: ContainerAuthTarget
  /**
   * Host loopback port to tunnel into the container for the OAuth callback.
   * When absent the port is auto-detected from the auth URL's redirect_uri.
   */
  authPort?: number
}

export type McpAuthPreflightRunner = (
  serverCfg: McpServerConfig,
  opts: McpAuthPreflightOpts,
) => Promise<void>

const DEFAULT_WAIT_FOR_EXIT_TIMEOUT_MS = 300_000
const DEFAULT_STARTUP_GRACE_MS = 3000
/** Failed-auth stderr is the agent's instruction channel — keep plenty of it. */
const STDERR_TAIL_MAX_LINES = 40
const STDERR_HINT_MAX_CHARS = 4000

/**
 * Query params an OAuth authorization URL uses to name its redirect target.
 * If one parses as a URL on localhost/127.0.0.1 with an explicit port, that
 * port is the loopback callback the flow expects to reach.
 */
const REDIRECT_PARAM_KEYS = ['redirect_uri', 'redirect_url', 'callback', 'callback_url']

/**
 * Extract the loopback callback port an auth URL redirects to, or null when
 * the URL has no localhost redirect with an explicit port (device-code flows,
 * hosted callbacks, malformed URLs).
 */
export function extractLoopbackPort(authUrl: string): number | null {
  try {
    const u = new URL(authUrl)
    for (const key of REDIRECT_PARAM_KEYS) {
      const val = u.searchParams.get(key)
      if (!val) continue
      try {
        const r = new URL(val)
        if ((r.hostname === 'localhost' || r.hostname === '127.0.0.1') && r.port) {
          const p = Number(r.port)
          if (Number.isInteger(p) && p > 0 && p < 65536) return p
        }
      } catch { /* param is not a URL — keep scanning */ }
    }
  } catch { /* malformed auth URL */ }
  return null
}

/**
 * In-container half of the loopback tunnel: connects to the callback port on
 * the container's loopback and pipes stdin/stdout. Runs via `node -e` inside
 * the MCP container (node is guaranteed there — it runs npx servers).
 */
const BRIDGE_SRC =
  "const net=require('net');const p=+process.argv[1];const s=net.connect(p,'127.0.0.1');" +
  'process.stdin.pipe(s);s.pipe(process.stdout);' +
  "const bye=()=>process.exit(0);s.on('close',bye);s.on('error',bye);process.stdin.on('close',bye);process.stdin.on('error',bye);"

/**
 * Ephemeral host→container TCP tunnel for OAuth loopback callbacks: listens
 * on 127.0.0.1:hostPort on the host and bridges each connection into
 * 127.0.0.1:containerPort inside the container via `podman exec node -e`.
 *
 * `ready` rejects plainly on listen errors (EADDRINUSE names the port);
 * `close()` stops listening and reaps live bridges.
 */
export function startLoopbackTunnel(opts: {
  podmanBin: string
  containerName: string
  hostPort: number
  containerPort?: number
  log?: (m: string) => void
}): { close(): void; ready: Promise<void> } {
  const { podmanBin, containerName, hostPort } = opts
  const containerPort = opts.containerPort ?? hostPort
  const log = opts.log ?? (() => {})
  const bridges = new Set<ChildProcess>()
  const sockets = new Set<Socket>()

  const server: Server = createServer((socket) => {
    const bridge = nodeSpawn(podmanBin, ['exec', '-i', containerName, 'node', '-e', BRIDGE_SRC, String(containerPort)], {
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    bridges.add(bridge)
    sockets.add(socket)
    socket.pipe(bridge.stdin!)
    bridge.stdout!.pipe(socket)
    const teardown = () => {
      bridges.delete(bridge)
      sockets.delete(socket)
      try { socket.destroy() } catch { /* already gone */ }
      try { bridge.kill() } catch { /* already gone */ }
    }
    socket.on('close', teardown)
    socket.on('error', teardown)
    bridge.on('close', teardown)
    bridge.on('error', teardown)
    // .pipe() attaches no error handler to its destination: a bridge that
    // exits mid-transfer (the normal OAuth shape — the in-container listener
    // answers and closes) raises EPIPE on stdin, and an unhandled stream
    // 'error' would crash the whole process.
    bridge.stdin!.on('error', teardown)
    bridge.stdout!.on('error', teardown)
  })

  const ready = new Promise<void>((resolve, reject) => {
    let listening = false
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (listening) {
        // Post-bind errors are rare on a bound server; log rather than crash.
        log(`[MCP] Auth tunnel listener error on 127.0.0.1:${hostPort}: ${err.message}`)
        return
      }
      reject(new Error(
        err.code === 'EADDRINUSE'
          ? `Cannot listen on 127.0.0.1:${hostPort} for the MCP auth callback — another process is already using that port. Free the port (or pass a different auth_port matching the server's redirect URI) and retry.`
          : `Cannot listen on 127.0.0.1:${hostPort} for the MCP auth callback: ${err.message}`,
      ))
    })
    server.listen(hostPort, '127.0.0.1', () => {
      listening = true
      log(`[MCP] Auth tunnel: forwarding 127.0.0.1:${hostPort} (host) → 127.0.0.1:${containerPort} (${containerName})`)
      resolve()
    })
  })

  return {
    ready,
    close() {
      try { server.close() } catch { /* already closed */ }
      for (const socket of sockets) { try { socket.destroy() } catch { /* ignore */ } }
      for (const bridge of bridges) { try { bridge.kill() } catch { /* ignore */ } }
      sockets.clear()
      bridges.clear()
    },
  }
}

export async function runMcpAuthPreflight(
  serverCfg: McpServerConfig,
  opts: McpAuthPreflightOpts,
  io: McpAuthPreflightIO,
): Promise<void> {
  const serverName = serverCfg.name
  const log = io.log ?? (() => {})
  log(`[MCP] Auth preflight for "${serverName}" — spawning for interactive auth`)

  // Resolve the command the way the historical preflight did. NOTE: this
  // deliberately re-derives the command inline rather than calling
  // resolveMcpSpawnConfig — a pre-existing divergence from the connect path
  // (managed-install fast paths are not consulted here), kept for parity.
  // (Container mode below skips this entirely: the in-container command comes
  // from resolveContainerCommand at the call site.)
  const expandHome = (p: string) => p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
  let preflightCmd = serverCfg.command ? expandHome(serverCfg.command) : 'npx'
  let preflightArgs = (serverCfg.args ?? []).map(expandHome)

  // For npm packages without a resolved command, use npx
  if (serverCfg.npm_package && !serverCfg.command) {
    preflightCmd = 'npx'
    preflightArgs = ['-y', serverCfg.npm_package, ...preflightArgs.filter(a => a !== '-y' && a !== serverCfg.npm_package)]
  }
  // For pypi packages, use uv tool run
  if (serverCfg.pypi_package && opts.uvBinPath) {
    preflightCmd = opts.uvBinPath
    // Keep user args as-is — they already contain the right pypi invocation args
  }

  // Append auth-specific args (e.g. ["auth"] for servers with a dedicated auth subcommand)
  if (opts.authArgs?.length) {
    preflightArgs = [...preflightArgs, ...opts.authArgs]
  }

  const preflightEnv = { ...process.env, ...(serverCfg.env ?? {}), ...(opts.resolvedEnv ?? {}) }
  log(`[MCP] Auth preflight: ${preflightCmd} ${preflightArgs.join(' ')}`)

  // No blanket shell:true — on Windows that routes through cmd.exe with
  // a concatenated string (injection surface) and orphans grandchildren.
  // Resolve the real binary via PATH/PATHEXT; .cmd/.bat shims (npx.cmd)
  // still need cmd.exe (Node refuses to spawn them directly), but with
  // explicitly quoted args, and killTree reaps the whole tree either way.
  const resolveWinBinary = (cmd: string): string => {
    if (/[\\/]/.test(cmd) || /\.[a-z0-9]+$/i.test(cmd)) return cmd
    const dirs = (process.env.PATH ?? '').split(';')
    const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')
    for (const dir of dirs) {
      if (!dir) continue
      for (const ext of exts) {
        const candidate = join(dir, cmd + ext.toLowerCase())
        if (existsSync(candidate)) return candidate
      }
    }
    return cmd
  }
  let spawnCmd = preflightCmd
  let spawnArgs = preflightArgs
  let verbatim = false
  const quoteEnvExtra: Record<string, string> = {}
  if (process.platform === 'win32' && !opts.container) {
    spawnCmd = resolveWinBinary(preflightCmd)
    if (/\.(cmd|bat)$/i.test(spawnCmd)) {
      // cmd.exe quoting rules (verified against real cmd.exe):
      // - %VAR% expands even inside quotes, with no in-quote escape
      //   → indirect such args through a child-env variable; the
      //   expanded text is inserted verbatim and not re-scanned for %.
      //   (! is included: it expands too when delayed expansion is on.)
      // - a trailing backslash before the closing quote reads as \"
      //   in the final child's argv parser and swallows the following
      //   args → double trailing backslashes.
      // - embedded quotes: "" is the in-quote escape (cmd and msvcrt).
      // Env-indirected values get the same backslash/quote escaping,
      // since expansion pastes them inside the surrounding quotes.
      const escapeQuoted = (s: string) => s.replace(/(\\*)$/, '$1$1').replace(/"/g, '""')
      let envArgIdx = 0
      const quoteArg = (s: string): string => {
        if (/[%!]/.test(s)) {
          const name = `ADF_ARG_${envArgIdx++}`
          quoteEnvExtra[name] = escapeQuoted(s)
          return `"%${name}%"`
        }
        if (!/[\s"^&|<>()]/.test(s) && !s.endsWith('\\')) return s
        return `"${escapeQuoted(s)}"`
      }
      const line = [quoteArg(spawnCmd), ...preflightArgs.map(quoteArg)].join(' ')
      spawnArgs = ['/d', '/s', '/c', `"${line}"`]
      spawnCmd = process.env.comspec || 'cmd.exe'
      verbatim = true
    }
  }
  let spawnEnv: NodeJS.ProcessEnv = { ...preflightEnv, ...quoteEnvExtra }
  if (opts.container) {
    // Container mode: run the auth subcommand INSIDE the container the server
    // will run in, so its stored credentials land where the server reads them.
    // Only the server's own env + identity-resolved credentials cross the
    // boundary (as explicit -e flags) — NEVER the host process.env, which
    // carries runtime API keys that must not leak into agent-reachable code.
    const c = opts.container
    const containerEnv = { ...(c.home ? { HOME: c.home } : {}), ...(serverCfg.env ?? {}), ...(opts.resolvedEnv ?? {}) }
    const envFlags = Object.entries(containerEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`])
    spawnCmd = c.podmanBin
    spawnArgs = ['exec', '-i', ...envFlags, c.containerName, c.command, ...c.args, ...(opts.authArgs ?? [])]
    // The podman client itself runs host-side and needs the host env (PATH,
    // machine connection); none of it is forwarded into the container.
    spawnEnv = process.env
    verbatim = false
    log(`[MCP] Auth preflight (container ${c.containerName}): ${c.command} ${[...c.args, ...(opts.authArgs ?? [])].join(' ')}`)
  }
  const preflight = trackChild(nodeSpawn(spawnCmd, spawnArgs, {
    env: spawnEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    // POSIX: own process group so killTree can signal -pid
    detached: process.platform !== 'win32',
    windowsVerbatimArguments: verbatim,
    windowsHide: true,
  }))
  // Registered before any await (the explicit-authPort tunnel bind below) so
  // a spawn failure can never surface as an uncaught 'error'. Interactive
  // mode treats it as non-fatal (parity with the historical flow — the user
  // may complete auth out of band and connect surfaces real failures);
  // headless mode's settle handler additionally rejects on it below.
  preflight.on('error', (err) => {
    log(`[MCP] Auth preflight "${serverName}" spawn error: ${err}`)
  })

  // --- OAuth loopback tunnel (container mode only) ---
  // Killing the host-side `podman exec` on settle may orphan the in-container
  // auth process; acceptable — it is sandboxed and auth subcommands exit on
  // their own after the callback.
  let tunnel: { close(): void; ready: Promise<void> } | null = null
  let tunnelClosed = false
  const closeTunnel = () => {
    tunnelClosed = true
    try { tunnel?.close() } catch { /* ignore */ } finally { tunnel = null }
  }
  const startTunnel = async (hostPort: number): Promise<void> => {
    if (tunnel || tunnelClosed || !opts.container) return
    const t = startLoopbackTunnel({
      podmanBin: opts.container.podmanBin,
      containerName: opts.container.containerName,
      hostPort,
      log,
    })
    tunnel = t
    await t.ready
    // A fast-exiting child can settle while the listener was still binding —
    // don't leave the late tunnel open.
    if (tunnelClosed) t.close()
  }
  if (opts.container && opts.authPort) {
    // Explicit port: the flow cannot work without the tunnel — fail plainly.
    try {
      await startTunnel(opts.authPort)
    } catch (err) {
      closeTunnel()
      killTree(preflight)
      throw err
    }
  }

  // Track the child finishing on its own. Gates URL opening below, and lets
  // interactive mode skip a dead-end "click Continue" dialog for an auth
  // command that already failed (or already succeeded) before the user acts.
  let earlyExit: { code: number | null; signal: NodeJS.Signals | null } | null = null
  preflight.on('close', (code, signal) => { if (!earlyExit) earlyExit = { code, signal } })

  // Watch stdout/stderr for the auth URL. No content heuristics — the runtime
  // is deterministic: the FIRST URL the process prints is its auth URL. But it
  // is only OPENED once the process has survived the startup grace. A process
  // that exits first never gets a browser tab — its output was error/help text
  // (which routinely embeds documentation links, e.g. a missing-credentials
  // error pointing at the provider console), and the install fails with that
  // text so the agent can walk the user through the fix.
  // Child-process `open` may not work from the runtime context, so browser
  // opening goes through io.openUrl.
  let authUrlOpened = false
  let scrapedUrl: string | null = null
  let graceElapsed = false
  const stderrTail: string[] = []
  const maybeOpenAuthUrl = () => {
    if (authUrlOpened || !scrapedUrl || !graceElapsed || earlyExit) return
    {
      authUrlOpened = true
      const url = scrapedUrl
      void (async () => {
        // Container mode without an explicit auth_port: detect the loopback
        // callback port from the auth URL and start the tunnel BEFORE the
        // browser opens, so the redirect finds a listener.
        if (opts.container && !tunnel) {
          const port = extractLoopbackPort(url)
          if (port != null) {
            try {
              await startTunnel(port)
            } catch (err) {
              log(`[MCP] Auth tunnel failed: ${err instanceof Error ? err.message : String(err)} — the OAuth callback will not reach the container.`)
            }
          } else {
            log('[MCP] Auth preflight: no loopback callback detected in auth URL — proceeding without a tunnel (device-code flows need none)')
          }
        }
        log(`[MCP] Auth preflight: opening auth URL in browser: ${url}`)
        await Promise.resolve(io.openUrl(url))
      })().catch(() => { /* best effort */ })
    }
  }
  const scrapeAuthUrl = (line: string) => {
    if (scrapedUrl) return
    const match = line.match(/https:\/\/\S+/)
    if (!match) return
    scrapedUrl = match[0].replace(/[.,;)}\]]+$/, '') // strip trailing punctuation
    maybeOpenAuthUrl()
  }
  preflight.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim()
    log(`[MCP] Auth preflight "${serverName}" stdout: ${text}`)
    scrapeAuthUrl(text)
  })
  preflight.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim()
    log(`[MCP] Auth preflight "${serverName}" stderr: ${text}`)
    stderrTail.push(...text.split('\n').filter(Boolean))
    if (stderrTail.length > STDERR_TAIL_MAX_LINES) stderrTail.splice(0, stderrTail.length - STDERR_TAIL_MAX_LINES)
    scrapeAuthUrl(text)
  })

  // The stderr of a failed auth command is the agent's instruction channel —
  // provider errors spell out exactly what the user must configure (consoles
  // to visit, files to place, APIs to enable). Pass it through generously.
  const stderrHint = () => {
    if (!stderrTail.length) return ''
    let text = stderrTail.join('\n')
    if (text.length > STDERR_HINT_MAX_CHARS) text = text.slice(-STDERR_HINT_MAX_CHARS)
    return `\nAuth command output:\n${text}`
  }

  const graceMs = io.startupGraceMs ?? DEFAULT_STARTUP_GRACE_MS
  const graceTimer = setTimeout(() => { graceElapsed = true; maybeOpenAuthUrl() }, graceMs)
  graceTimer.unref?.()

  if (io.confirm) {
    // --- Interactive mode (Studio) ---
    // (Spawn errors are logged by the always-on 'error' listener above.)
    const failFromExit = (exit: { code: number | null; signal: NodeJS.Signals | null }): never => {
      throw new Error(
        `MCP auth preflight for "${serverName}" exited with ${exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`} before authorization completed.${stderrHint()}`,
      )
    }

    // Give the process a moment to start and potentially open the browser itself
    await new Promise((r) => setTimeout(r, graceMs))

    // Auth command already finished: skip the pointless dialog. Exit 0 means
    // it stored its tokens (or was already authorized); nonzero means the
    // flow failed — surface the stderr instead of success-with-no-auth.
    if (earlyExit) {
      closeTunnel()
      killTree(preflight)
      if (earlyExit.code === 0) {
        log(`[MCP] Auth preflight for "${serverName}" completed on its own — proceeding to connect`)
        return
      }
      failFromExit(earlyExit)
    }

    try {
      // Blocks until the user confirms completion (e.g. dialog "Continue")
      await io.confirm({ serverName, authUrlOpened })
      // The dialog cannot be retracted once shown; if the auth command died
      // with an error while it was up, fail after the click rather than
      // pretending authorization happened.
      if (earlyExit && earlyExit.code !== 0) failFromExit(earlyExit)
    } finally {
      closeTunnel()
      // Kill the preflight process tree (grandchildren included — a plain
      // .kill() leaves npx/cmd.exe grandchildren orphaned on Windows)
      killTree(preflight)
    }
    log(`[MCP] Auth preflight for "${serverName}" complete — proceeding to connect`)
    return
  }

  // --- Headless mode (daemon/CLI) ---
  // No UI to confirm completion: wait for the auth subcommand to exit on its
  // own. Most OAuth `auth` subcommands exit after storing tokens; a server
  // that keeps serving hits the timeout and fails plainly with the URL.
  const timeoutMs = io.waitForExitTimeoutMs ?? DEFAULT_WAIT_FOR_EXIT_TIMEOUT_MS
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      closeTunnel()
      fn()
    }
    const timer = setTimeout(() => {
      killTree(preflight)
      const urlHint = scrapedUrl
        ? ` Authorization URL: ${scrapedUrl} — complete it in a browser, then call mcp_restart.`
        : ''
      settle(() => reject(new Error(
        `Interactive MCP authorization timed out after ${Math.round(timeoutMs / 1000)}s for "${serverName}".${urlHint}` +
        ' Alternatively authorize once from ADF Studio, then call mcp_restart.',
      )))
    }, timeoutMs)
    preflight.on('error', (err) => {
      settle(() => reject(new Error(`MCP auth preflight for "${serverName}" failed to spawn: ${err instanceof Error ? err.message : String(err)}`)))
    })
    // 'close' rather than 'exit': it fires after the stdio streams flush, so a
    // fast-exiting child's final stdout/stderr chunk (auth URL, error detail)
    // is scraped before we settle. The timeout above still bounds the wait if
    // a grandchild holds the pipes open.
    preflight.on('close', (code, signal) => {
      if (code === 0) {
        log(`[MCP] Auth preflight for "${serverName}" exited cleanly — proceeding to connect`)
        settle(resolve)
      } else {
        settle(() => reject(new Error(
          `MCP auth preflight for "${serverName}" exited with ${signal ? `signal ${signal}` : `code ${code}`}.${stderrHint()}`,
        )))
      }
    })
  })
}

/**
 * Headless preflight runner for plain-Node runtimes (daemon/CLI): best-effort
 * platform browser open + log the URL, then wait for the auth subcommand to
 * exit. No Electron involved.
 */
export function createHeadlessMcpAuthPreflight(log?: (msg: string) => void): McpAuthPreflightRunner {
  const emit = log ?? ((msg: string) => console.log(msg))
  const openUrl = (url: string) => {
    emit(`[MCP] Auth preflight authorization URL: ${url}`)
    try {
      const [cmd, args] =
        process.platform === 'darwin' ? ['open', [url]] as const :
        process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] as const :
        ['xdg-open', [url]] as const
      const child = nodeSpawn(cmd, [...args], { detached: true, stdio: 'ignore' })
      child.on('error', () => { /* no browser available — URL already logged */ })
      child.unref()
    } catch { /* best effort */ }
  }
  return (serverCfg, opts) => runMcpAuthPreflight(serverCfg, opts, { openUrl, log: emit })
}
