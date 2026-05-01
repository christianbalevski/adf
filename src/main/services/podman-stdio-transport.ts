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

import { spawn, type ChildProcess } from 'child_process'
import { PassThrough, type Stream } from 'stream'
import { createRequire } from 'module'
import { dirname, join } from 'path'
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types'

// The SDK's subpath exports break CJS require().  Resolve from the working
// /client entry and navigate to ../shared/ — same workaround as mcp-client-manager.ts.
const _require = createRequire(import.meta.url)
const clientDir = dirname(_require.resolve('@modelcontextprotocol/sdk/client'))
const sharedDir = join(clientDir, '..', 'shared')
const { ReadBuffer, serializeMessage } = _require(join(sharedDir, 'stdio.js')) as typeof import('@modelcontextprotocol/sdk/shared/stdio')

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

  async start(): Promise<void> {
    if (this._process) {
      throw new Error('PodmanStdioTransport already started')
    }

    const execArgs = this.buildExecArgs()

    return new Promise<void>((resolve, reject) => {
      this._process = spawn(this._opts.podmanBin, execArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      })

      this._process.on('error', (error) => {
        reject(error)
        this.onerror?.(error)
      })

      this._process.on('spawn', () => resolve())

      this._process.on('close', () => {
        this._process = undefined
        this.onclose?.()
      })

      this._process.stdin?.on('error', (error) => {
        this.onerror?.(error)
      })

      this._process.stdout?.on('data', (chunk: Buffer) => {
        this._readBuffer.append(chunk)
        this.processReadBuffer()
      })

      this._process.stdout?.on('error', (error) => {
        this.onerror?.(error)
      })

      // Pipe stderr through the PassThrough so listeners attached before
      // start() receive output.
      if (this._process.stderr) {
        this._process.stderr.pipe(this._stderrStream)
      }
    })
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (!this._process?.stdin) {
      throw new Error('Not connected')
    }

    const json = serializeMessage(message)

    return new Promise<void>((resolve) => {
      if (this._process!.stdin!.write(json)) {
        resolve()
      } else {
        this._process!.stdin!.once('drain', resolve)
      }
    })
  }

  async close(): Promise<void> {
    if (!this._process) return

    const proc = this._process
    this._process = undefined

    const closePromise = new Promise<void>((resolve) => {
      proc.once('close', () => resolve())
    })

    // Signal EOF
    try { proc.stdin?.end() } catch { /* ignore */ }

    // Wait 2s for graceful close
    await Promise.race([
      closePromise,
      new Promise<void>((resolve) => setTimeout(resolve, 2000).unref()),
    ])

    // SIGTERM if still running
    if (proc.exitCode === null) {
      try { proc.kill('SIGTERM') } catch { /* ignore */ }
      await Promise.race([
        closePromise,
        new Promise<void>((resolve) => setTimeout(resolve, 2000).unref()),
      ])
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

    // Container name, then command + args
    args.push(this._opts.containerName)
    args.push(this._opts.command)
    if (this._opts.args?.length) {
      args.push(...this._opts.args)
    }

    return args
  }

  /** Drain buffered data into JSON-RPC messages. */
  private processReadBuffer(): void {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const message = this._readBuffer.readMessage()
        if (!message) break
        this.onmessage?.(message)
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)))
      }
    }
  }
}
