import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { probeClaudeCode, requireClaudeCode, claudeCodeEnv, MIN_CLAUDE_CODE_VERSION, CLAUDE_CODE_INSTALL_URL } from './claude-code'
import type { ClaudeAuthStatus, ClaudeAuthFlow } from './types'

/**
 * Claude sign-in, delegated entirely to Claude Code.
 *
 * Anthropic's terms require that sign-in to a Claude account complete through
 * Anthropic's own flow and that third-party apps never collect, store or
 * intermediate Claude credentials. So this manager holds no tokens: it runs
 * `claude auth login|status|logout` and reports what Claude Code says. The
 * session lives in Claude Code's own credential store and is shared with the
 * user's normal Claude Code use.
 */

const LOGIN_TIMEOUT_MS = 10 * 60_000
const STATUS_CACHE_MS = 30_000

interface CliAuthStatus {
  loggedIn?: boolean
  authMethod?: string
  email?: string
  orgName?: string
  subscriptionType?: string
}

/** Remove ANSI CSI/OSC sequences (Claude Code prints the URL as an OSC 8 link). */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
}

/** First sign-in URL in Claude Code's login output. */
export function extractLoginUrl(output: string): string | undefined {
  // OSC 8 links carry the URL in the escape itself; search the raw text first.
  const match = output.match(/https:\/\/[^\s\u0007\u001b"']+\/oauth\/authorize\?[^\s\u0007\u001b"']+/)
  return match?.[0]
}

function runCli(path: string, args: string[], timeoutMs = 20_000): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(path, args, { timeout: timeoutMs, windowsHide: true, env: claudeCodeEnv() }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0
      resolve({ stdout: String(stdout), stderr: String(stderr), code })
    })
  })
}

interface ActiveFlow {
  child: ChildProcessWithoutNullStreams
  ready: Promise<ClaudeAuthFlow>
  url?: string
  output: string
  cancelled: boolean
}

class ClaudeAuthManager {
  private active: ActiveFlow | null = null
  private starting: Promise<ClaudeAuthFlow> | null = null
  private startGen = 0
  private lastFlowError?: string
  private statusCache: { status: ClaudeAuthStatus; at: number } | null = null
  private statusInflight: Promise<ClaudeAuthStatus> | null = null
  private statusGen = 0

  /**
   * Claude Code's sign-in state. `claude auth status` is a process spawn and
   * this is polled by every status view and agent preflight, so results are
   * cached briefly and concurrent callers share one read. While a sign-in is
   * pending nothing is cached. `fresh` re-detects Claude Code and re-reads.
   */
  getAuthStatus(opts?: { fresh?: boolean }): Promise<ClaudeAuthStatus> {
    const fresh = opts?.fresh === true
    if (!fresh && !this.active && this.statusCache && Date.now() - this.statusCache.at < STATUS_CACHE_MS) {
      return Promise.resolve(this.statusCache.status)
    }
    if (!fresh && this.statusInflight) return this.statusInflight
    const gen = this.statusGen
    const run = this.readAuthStatus(fresh).then((status) => {
      if (gen === this.statusGen && !this.active && !('flowPending' in status && status.flowPending)) {
        this.statusCache = { status, at: Date.now() }
      }
      return status
    }).finally(() => {
      if (this.statusInflight === run) this.statusInflight = null
    })
    this.statusInflight = run
    return run
  }

  private invalidateStatus(): void {
    this.statusGen++
    this.statusCache = null
    this.statusInflight = null
  }

  private async readAuthStatus(fresh: boolean): Promise<ClaudeAuthStatus> {
    const probe = await probeClaudeCode(fresh)
    if (!probe.found) {
      return { authenticated: false, installed: false, installUrl: CLAUDE_CODE_INSTALL_URL }
    }
    const { version: installed, path } = probe.install
    const version = { version: installed, minVersion: MIN_CLAUDE_CODE_VERSION }
    if (!probe.supported) {
      return {
        authenticated: false,
        installed: true,
        ...version,
        updateRequired: true,
        flowError: `Claude Code ${installed} is installed; ADF needs ${MIN_CLAUDE_CODE_VERSION} or newer. Run \`claude update\`.`,
      }
    }
    const { stdout } = await runCli(path, ['auth', 'status', '--json'])
    const pending = this.active
      ? { flowPending: true as const, ...(this.active.url ? { flowUrl: this.active.url } : {}) }
      : {}
    let cli: CliAuthStatus = {}
    try {
      cli = JSON.parse(stdout) as CliAuthStatus
    } catch {
      // Not JSON (older/odd build) — treat as signed out.
    }
    if (!cli.loggedIn) {
      return { authenticated: false, installed: true, ...version, ...pending, ...(this.lastFlowError ? { flowError: this.lastFlowError } : {}) }
    }
    if (cli.authMethod !== 'claude.ai') {
      // Claude Code is signed in with a Console API key, not a Claude plan.
      return {
        authenticated: false,
        installed: true,
        ...version,
        ...pending,
        flowError: 'Claude Code is signed in with an Anthropic Console account, not a Claude plan. Sign in with Claude to use your subscription.',
      }
    }
    return {
      authenticated: true,
      installed: true,
      ...version,
      ...pending,
      ...(cli.email ? { email: cli.email } : {}),
      ...(cli.subscriptionType ? { plan: cli.subscriptionType } : {}),
    }
  }

  async isAuthenticated(): Promise<boolean> {
    return (await this.getAuthStatus()).authenticated
  }

  /**
   * Start `claude auth login`. Claude Code opens the browser itself; the
   * returned URL is the fallback for when it cannot (remote daemon, headless
   * box). If the browser page shows a code instead of finishing on its own,
   * the user pastes it and it is handed to Claude Code via `submitCode`.
   */
  startAuthFlowDetached(): Promise<ClaudeAuthFlow> {
    if (this.active) return this.active.ready
    if (!this.starting) {
      const starting = this.spawnFlow().finally(() => {
        if (this.starting === starting) this.starting = null
      })
      this.starting = starting
    }
    return this.starting
  }

  private async spawnFlow(): Promise<ClaudeAuthFlow> {
    const gen = this.startGen
    const { path } = await requireClaudeCode()
    if (gen !== this.startGen) throw new Error('Claude sign-in was cancelled.')
    this.lastFlowError = undefined

    const child = spawn(path, ['auth', 'login', '--claudeai'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: claudeCodeEnv(),
    })

    let resolveUrl!: (url: string | undefined) => void
    const urlReady = new Promise<string | undefined>((r) => { resolveUrl = r })
    const state: ActiveFlow = { child, output: '', cancelled: false, ready: undefined as unknown as Promise<ClaudeAuthFlow> }
    const onData = (d: Buffer) => {
      state.output += d.toString()
      const url = extractLoginUrl(state.output)
      if (url) {
        state.url ??= url
        resolveUrl(url)
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)

    const completion = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error('Claude sign-in timed out. Try again.'))
      }, LOGIN_TIMEOUT_MS)
      child.on('error', (err) => {
        clearTimeout(timer)
        resolveUrl(undefined)
        reject(err)
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        resolveUrl(undefined)
        if (code === 0) return resolve()
        if (state.cancelled) return reject(new Error('Claude sign-in was cancelled.'))
        const tail = stripAnsi(state.output).trim().split('\n').filter(Boolean).pop()
        reject(new Error(tail && !/paste code/i.test(tail) ? `Claude sign-in failed: ${tail}` : 'Claude sign-in was cancelled.'))
      })
    }).then(
      () => {
        if (this.active === state) this.active = null
        this.invalidateStatus()
      },
      (err: unknown) => {
        if (this.active === state) {
          this.active = null
          if (!state.cancelled) this.lastFlowError = err instanceof Error ? err.message : String(err)
        }
        this.invalidateStatus()
        throw err
      },
    )
    // A detached caller may never await completion; the error is kept for
    // getAuthStatus instead of surfacing as an unhandled rejection.
    completion.catch(() => {})

    // Claude Code prints the URL immediately; don't hang if it never does.
    state.ready = Promise.race([urlReady, new Promise<undefined>((r) => setTimeout(() => r(undefined), 15_000))])
      .then((url) => ({ url, completion }))
    this.active = state
    this.invalidateStatus()
    return state.ready
  }

  async startAuthFlow(): Promise<void> {
    const flow = await this.startAuthFlowDetached()
    await flow.completion
  }

  /** Hand the code shown on Claude's sign-in page to the waiting Claude Code. */
  submitCode(code: string): void {
    const trimmed = code.trim()
    if (!this.active) throw new Error('No Claude sign-in is in progress.')
    if (!trimmed) throw new Error('Paste the code shown on the Claude sign-in page.')
    this.active.child.stdin.write(`${trimmed}\n`)
  }

  cancelAuthFlow(): void {
    this.startGen++
    this.starting = null
    if (this.active) {
      this.active.cancelled = true
      this.active.child.kill()
      this.active = null
    }
    this.invalidateStatus()
  }

  /** Signs Claude Code out on this machine (shared with the user's own Claude Code use). */
  async logout(): Promise<void> {
    this.cancelAuthFlow()
    this.lastFlowError = undefined
    try {
      const { path } = await requireClaudeCode()
      const { code, stderr } = await runCli(path, ['auth', 'logout'])
      if (code !== 0) throw new Error(`Claude sign-out failed: ${stripAnsi(stderr).trim() || `exit ${code}`}`)
    } finally {
      this.invalidateStatus()
    }
  }
}

let instance: ClaudeAuthManager | null = null

export function getClaudeAuthManager(): ClaudeAuthManager {
  if (!instance) instance = new ClaudeAuthManager()
  return instance
}

export type { ClaudeAuthManager }
