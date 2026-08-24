/**
 * MCP transport that routes stdio through `podman exec`.
 *
 * Drop-in replacement for StdioClientTransport.  Instead of spawning the
 * MCP server command directly on the host, it runs inside an existing
 * Podman container via:
 *
 *   podman exec -i -w <cwd> [-e K=V …] <container> <command> [args…]
 *
 * The MCP JSON-RPC protocol (newline-delimited JSON over stdin/stdout)
 * works identically through the `podman exec` pipe.
 */

import { execFile, spawn, type ChildProcess } from 'child_process'
import { PassThrough, type Stream } from 'stream'
import { createRequire } from 'module'
import { dirname, join } from 'path'
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types'
import { NPM_CACHE_MOUNT } from './podman.service'

// The SDK's subpath exports break CJS require().  Resolve from the working
// /client entry and navigate to ../shared/ — same workaround as mcp-client-manager.ts.
const _require = createRequire(import.meta.url)
const clientDir = dirname(_require.resolve('@modelcontextprotocol/sdk/client'))
const sharedDir = join(clientDir, '..', 'shared')
const { ReadBuffer, serializeMessage } = _require(join(sharedDir, 'stdio.js')) as typeof import('@modelcontextprotocol/sdk/shared/stdio')

/** Sentinel printed to stderr by the in-container `sh` wrapper before it execs
 *  the MCP server. `exec` keeps the PID, so parsing this once gives us the
 *  in-container PID of the server itself — `podman exec` only kills the
 *  host-side client, so close() must signal this PID to avoid leaving the
 *  server running (and, pre---init, a zombie) inside the container. */
const PID_SENTINEL_RE = /__ADF_PID_(\d+)__\r?\n?/
/** Give up scanning for the sentinel after this much early stderr. */
const PID_SCAN_LIMIT = 8192

/** OCI-runtime stderr signatures meaning the container has no usable `sh`
 *  (distroless images) — the PID-sentinel wrapper cannot run there.
 *  crun: "exec container process `/bin/sh`: No such file or directory"
 *  runc: 'exec: "sh": executable file not found in $PATH' */
const SH_MISSING_RE = /(["'`\s/]sh["'`]?|\/bin\/sh)[^\n]{0,120}(executable file not found|no such file|not found)/i

/** Max outbound messages retained for replay across the fallback respawn. */
const REPLAY_LIMIT = 32

/** Env vars that must never be forwarded into the container. */
const BLOCKED_ENV_VARS = new Set([
  'ELECTRON_RUN_AS_NODE',
  'NODE_OPTIONS',
  'LD_PRELOAD',
  'DYLD_INSERT_LIBRARIES',
  'LD_LIBRARY_PATH',
  'DYLD_LIBRARY_PATH',
])

export interface PodmanStdioTransportOptions {
  /** Absolute path to the `podman` binary. */
  podmanBin: string
  /** Name (or ID) of the running container. */
  containerName: string
  /** Command to execute inside the container (e.g. `node`). */
  command: string
  /** Arguments for the command. */
  args?: string[]
  /** Environment variables to set inside the container (passed as -e flags). */
  env?: Record<string, string>
  /** Working directory inside the container. */
  cwd?: string
}

export class PodmanStdioTransport implements Transport {
  private _process?: ChildProcess
  private _readBuffer: InstanceType<typeof ReadBuffer>
  private _stderrStream: PassThrough
  private _opts: PodmanStdioTransportOptions
  /** PID of the MCP server inside the container (captured from the sentinel). */
  private _containerPid: number | null = null
  /** Early stderr held back until the PID sentinel is found (or given up on). */
  private _stderrCarry = ''
  private _pidScanDone = false
  /** Whether the sh PID-sentinel wrapper is in use. Cleared when the container
   *  turns out to have no `sh` (distroless) and we respawn directly. */
  private _useWrapper = true
  /** Set by close() so a process exit during teardown never triggers fallback. */
  private _closing = false
  /** Bounded early-stderr capture used to classify a fast exec failure. */
  private _earlyStderr = ''
  /** Serialized outbound messages retained until the server proves alive, so
   *  the fallback respawn can replay them (e.g. the initialize request). */
  private _replayBuffer: string[] | null = []

  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  sessionId?: string

  constructor(opts: PodmanStdioTransportOptions) {
    this._opts = opts
    this._readBuffer = new ReadBuffer()
    // Create stderr PassThrough immediately so callers can attach listeners
    // before start() — prevents loss of early error output.
    this._stderrStream = new PassThrough()
  }

  /** Pre-start stderr stream (attach listeners before calling start()). */
  get stderr(): Stream {
    return this._stderrStream
  }

  /** Child process PID (available after start()). */
  get pid(): number | null {
    return this._process?.pid ?? null
  }

  /** In-container PID of the MCP server (available shortly after start()). */
  get containerPid(): number | null {
    return this._containerPid
  }

  async start(): Promise<void> {
    if (this._process) {
      throw new Error('PodmanStdioTransport already started')
    }

    return new Promise<void>((resolve, reject) => {
      this.spawnProcess(resolve, reject)
    })
  }

  /** True when stderr indicates the container has no `sh` for the wrapper. */
  static isShellMissingError(text: string): boolean {
    return SH_MISSING_RE.test(text)
  }

  private spawnProcess(resolve: () => void, reject: (error: Error) => void): void {
    const proc = spawn(this._opts.podmanBin, this.buildExecArgs(), {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    })
    this._process = proc

    proc.on('error', (error) => {
      reject(error)
      this.onerror?.(error)
    })

    proc.on('spawn', () => resolve())

    proc.on('close', (code) => {
      if (this._process === proc) this._process = undefined
      // Distroless fallback: the sh wrapper never ran because the container
      // has no `sh`. Respawn the command directly (no PID sentinel — close()
      // then skips the in-container kill) and replay early outbound messages.
      if (
        this._useWrapper && !this._closing && code !== 0 &&
        this._containerPid === null &&
        PodmanStdioTransport.isShellMissingError(this._earlyStderr + this._stderrCarry)
      ) {
        this._useWrapper = false
        this._pidScanDone = true // no sentinel will ever arrive
        this._stderrCarry = ''   // wrapper-failure noise, not server output
        this._earlyStderr = ''
        this.respawnDirect()
        return
      }
      if (this._stderrCarry) {
        this._stderrStream.write(this._stderrCarry)
        this._stderrCarry = ''
      }
      this._stderrStream.end()
      this.onclose?.()
    })

    proc.stdin?.on('error', (error) => {
      this.onerror?.(error)
    })

    proc.stdout?.on('data', (chunk: Buffer) => {
      this._readBuffer.append(chunk)
      this.processReadBuffer()
    })

    proc.stdout?.on('error', (error) => {
      this.onerror?.(error)
    })

    // Forward stderr through the PassThrough so listeners attached before
    // start() receive output — after stripping the one-line PID sentinel
    // emitted by the sh wrapper.
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      if (this._earlyStderr.length < PID_SCAN_LIMIT) {
        this._earlyStderr = (this._earlyStderr + text).slice(0, PID_SCAN_LIMIT)
      }
      const passthrough = this.filterStderrChunk(text)
      if (passthrough) this._stderrStream.write(passthrough)
    })
  }

  /** Respawn without the sh wrapper and replay buffered outbound messages. */
  private respawnDirect(): void {
    this.spawnProcess(
      () => { /* already reported started to the caller */ },
      (error) => this.onerror?.(error),
    )
    const stdin = this._process?.stdin
    if (stdin && this._replayBuffer) {
      for (const json of this._replayBuffer) {
        try { stdin.write(json) } catch { /* surfaced via stdin error handler */ }
      }
    }
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (!this._process?.stdin) {
      throw new Error('Not connected')
    }

    const json = serializeMessage(message)

    // Retain early messages so a shell-missing fallback respawn can replay
    // them; released once the server sends anything back.
    if (this._replayBuffer && this._replayBuffer.length < REPLAY_LIMIT) {
      this._replayBuffer.push(json)
    }

    return new Promise<void>((resolve) => {
      if (this._process!.stdin!.write(json)) {
        resolve()
      } else {
        this._process!.stdin!.once('drain', resolve)
      }
    })
  }

  async close(): Promise<void> {
    this._closing = true
    if (!this._process) return

    const proc = this._process
    this._process = undefined
    const containerPid = this._containerPid
    this._containerPid = null

    // When the PID sentinel never arrived (direct fallback spawn, or close()
    // racing startup), the in-container process cannot be cheaply identified:
    // killing by command name would risk hitting other agents' servers in the
    // shared container. stdin EOF below terminates well-behaved servers; one
    // that ignores EOF leaks inside the container until the container itself
    // stops (bounded by the container lifecycle; --init reaps it on exit).

    const closePromise = new Promise<void>((resolve) => {
      proc.once('close', () => resolve())
    })
    const grace = () => Promise.race([
      closePromise,
      new Promise<void>((resolve) => setTimeout(resolve, 2000).unref()),
    ])

    // Signal EOF, and TERM the server inside the container — killing the
    // host-side podman client alone leaves the in-container process running.
    try { proc.stdin?.end() } catch { /* ignore */ }
    if (containerPid !== null) await this.signalInContainer(containerPid, 'TERM')

    // Wait 2s for graceful close
    await grace()

    // Escalate: KILL in-container, SIGTERM the host client
    if (proc.exitCode === null) {
      if (containerPid !== null) await this.signalInContainer(containerPid, 'KILL')
      try { proc.kill('SIGTERM') } catch { /* ignore */ }
      await grace()
    }

    // SIGKILL as last resort
    if (proc.exitCode === null) {
      try { proc.kill('SIGKILL') } catch { /* ignore */ }
    }

    this._readBuffer.clear()
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /** Build the argument array for `podman exec`. */
  private buildExecArgs(): string[] {
    const args: string[] = ['exec', '-i']

    // Working directory inside the container
    if (this._opts.cwd) {
      args.push('-w', this._opts.cwd)
    }

    // Environment variables as -e flags (filtered for security)
    if (this._opts.env) {
      for (const [key, value] of Object.entries(this._opts.env)) {
        if (BLOCKED_ENV_VARS.has(key)) continue
        args.push('-e', `${key}=${value}`)
      }
    }

    // Container name, then a small sh wrapper that (1) picks up the shared npm
    // cache volume when mounted (containers created pre-feature lack it),
    // (2) prints its PID once to stderr so close() can signal the real server,
    // then (3) execs the server with an identical argv ("$@" preserves args,
    // exec preserves the PID). When the container has no `sh` (distroless),
    // _useWrapper is cleared and the command is spawned directly — no
    // sentinel, and close() skips the in-container kill.
    args.push(this._opts.containerName)
    if (this._useWrapper) {
      // `mkdir -p "$HOME"`: MCP servers run with an agent-scoped HOME (see
      // containerAgentHome) that may not exist yet on a fresh container.
      // Guarded on HOME being set so non-HOME callers see no change. The
      // distroless (no-sh) path relies on the call sites' ensureWorkspace.
      const wrapper = `[ -n "$HOME" ] && mkdir -p "$HOME"; [ -z "$npm_config_cache" ] && [ -d ${NPM_CACHE_MOUNT} ] && export npm_config_cache=${NPM_CACHE_MOUNT}; echo "__ADF_PID_$$__" >&2; exec "$@"`
      args.push('sh', '-c', wrapper, 'sh', this._opts.command)
    } else {
      args.push(this._opts.command)
    }
    if (this._opts.args?.length) {
      args.push(...this._opts.args)
    }

    return args
  }

  /**
   * Scan early stderr for the PID sentinel, strip it, and return the text that
   * should be forwarded to consumers. Buffers until the sentinel is complete
   * (it may be split across chunks); gives up after PID_SCAN_LIMIT bytes.
   */
  private filterStderrChunk(text: string): string {
    if (this._pidScanDone) return text
    this._stderrCarry += text
    const match = this._stderrCarry.match(PID_SENTINEL_RE)
    if (match) {
      this._containerPid = parseInt(match[1], 10)
      this._pidScanDone = true
      const rest = this._stderrCarry.replace(match[0], '')
      this._stderrCarry = ''
      return rest
    }
    if (this._stderrCarry.length > PID_SCAN_LIMIT) {
      this._pidScanDone = true
      const rest = this._stderrCarry
      this._stderrCarry = ''
      return rest
    }
    return ''
  }

  /** Send a signal to the in-container server via a short podman exec. */
  private signalInContainer(pid: number, signal: 'TERM' | 'KILL'): Promise<void> {
    return new Promise((resolve) => {
      execFile(
        this._opts.podmanBin,
        ['exec', this._opts.containerName, 'sh', '-c', `kill -${signal} ${pid} 2>/dev/null`],
        { timeout: 7_000, windowsHide: true },
        () => resolve(),
      )
    })
  }

  /** Drain buffered data into JSON-RPC messages. */
  private processReadBuffer(): void {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const message = this._readBuffer.readMessage()
        if (!message) break
        // Server is alive and talking — no fallback replay will ever be needed.
        this._replayBuffer = null
        this.onmessage?.(message)
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)))
      }
    }
  }
}
