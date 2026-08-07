import { dirname, extname, join, resolve, sep } from 'path'
import { readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { createRequire } from 'module'
import { EventEmitter } from 'events'
import { Client } from '@modelcontextprotocol/sdk/client'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport'
import type {
  McpServerConfig,
  McpToolInfo,
  McpServerStatus,
  McpServerLogEntry,
  McpServerState
} from '../../shared/types/adf-v02.types'
import { resolveMcpRequestHeaders } from './mcp-spawn-utils'
import { killTree } from '../utils/child-registry'

// The SDK's package.json wildcard export (./*) doesn't append .js, breaking
// CJS require() for subpath imports like /client/stdio.  Resolve the path
// from the working /client entry instead.
const _require = createRequire(import.meta.url)
const clientDir = dirname(_require.resolve('@modelcontextprotocol/sdk/client'))
const { StdioClientTransport } = _require(join(clientDir, 'stdio.js')) as typeof import('@modelcontextprotocol/sdk/client/stdio')
const { StreamableHTTPClientTransport } = _require(join(clientDir, 'streamableHttp.js')) as typeof import('@modelcontextprotocol/sdk/client/streamableHttp')

/** Env vars that user-supplied MCP config must never override. */
const BLOCKED_ENV_VARS = new Set([
  'ELECTRON_RUN_AS_NODE',
  'NODE_OPTIONS',
  'LD_PRELOAD',
  'DYLD_INSERT_LIBRARIES',
  'LD_LIBRARY_PATH',
  'DYLD_LIBRARY_PATH',
])

const MAX_LOG_ENTRIES = 500
const MAX_RETRIES = 3
const INITIAL_BACKOFF_MS = 2000
// 20s default — npx/uvx packages are pre-warmed/cached at install time, so a
// healthy server should connect fast.  Slow setups (cold first-run downloads)
// can raise it via ADF_MCP_CONNECT_TIMEOUT_MS.
const CONNECTION_TIMEOUT_MS = (() => {
  const raw = Number(process.env.ADF_MCP_CONNECT_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 20_000
})()
const HEALTH_CHECK_INTERVAL_MS = 60_000
const TOOL_CALL_TIMEOUT_MS = 60_000

/** Claude rejects images over ~5MB — skip larger linked files rather than poison the turn. */
const MAX_LINKED_IMAGE_BYTES = 4.5 * 1024 * 1024
const MAX_LINKED_IMAGES = 3
const IMAGE_EXT_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/**
 * Stdio MCP servers run with cwd = the agent's MCP scratch dir. Some tools
 * (e.g. Playwright's browser_take_screenshot when given a filename) save the
 * image there and return only a file link with no inline image block, leaving
 * the agent unable to see what it captured. Recover them: resolve image-file
 * references in the result text against the scratch dir and load the ones
 * that actually live inside it.
 */
function loadLinkedScratchImages(
  text: string,
  scratchDir: string
): { images: Array<{ data: string; mimeType: string }>; notes: string[] } {
  const images: Array<{ data: string; mimeType: string }> = []
  const notes: string[] = []
  const root = resolve(scratchDir)
  const rootPrefix = (root + sep).toLowerCase()
  const seen = new Set<string>()
  const refs = text.match(/[^\s"'`()[\]]+\.(?:png|jpe?g|webp|gif)/gi) ?? []
  for (const ref of refs) {
    if (images.length >= MAX_LINKED_IMAGES) break
    const resolved = resolve(root, ref)
    if (!resolved.toLowerCase().startsWith(rootPrefix)) continue
    if (seen.has(resolved.toLowerCase())) continue
    seen.add(resolved.toLowerCase())
    try {
      const stat = statSync(resolved)
      if (!stat.isFile()) continue
      if (stat.size > MAX_LINKED_IMAGE_BYTES) {
        notes.push(`[Image "${ref}" is ${Math.round(stat.size / 1024)}KB — too large to attach inline. Retake without a filename (or not fullPage) to view it.]`)
        continue
      }
      images.push({
        data: readFileSync(resolved).toString('base64'),
        mimeType: IMAGE_EXT_MIME[extname(resolved).toLowerCase()] ?? 'image/png',
      })
    } catch { /* file not present — link didn't refer to a scratch file */ }
  }
  return { images, notes }
}

/** Strip security-sensitive env vars that MCP server configs must not override. */
function filterBlockedEnv(env: Record<string, string>): Record<string, string> {
  const filtered: Record<string, string> = {}
  const blocked: string[] = []
  for (const [key, value] of Object.entries(env)) {
    if (BLOCKED_ENV_VARS.has(key)) {
      blocked.push(key)
    } else {
      filtered[key] = value
    }
  }
  if (blocked.length) {
    console.warn(`[MCP] Blocked security-sensitive env vars: ${blocked.join(', ')}`)
  }
  return filtered
}

export interface McpConnectOptions {
  /** Pre-built transport (e.g. PodmanStdioTransport for container execution).
   *  When provided, the manager skips StdioClientTransport creation and uses
   *  this transport instead.  Everything else (health checks, auto-restart,
   *  tool discovery) works identically. */
  externalTransport?: Transport
}

interface McpManagedServer {
  config: McpServerConfig
  client: Client | null
  transport: InstanceType<typeof StdioClientTransport> | InstanceType<typeof StreamableHTTPClientTransport> | Transport | null
  status: McpServerStatus
  error?: string
  tools: McpToolInfo[]
  logs: McpServerLogEntry[]
  restartCount: number
  connectedAt?: number
  healthCheckTimer?: ReturnType<typeof setInterval>
  /** Pending background retry after a failed connection attempt. */
  retryTimer?: ReturnType<typeof setTimeout>
  /** Whether the server should auto-restart on unexpected disconnection */
  autoRestart: boolean
  /** Preserved connect options for auto-restart with external transport. */
  connectOptions?: McpConnectOptions
}

export interface McpClientManagerEvents {
  'status-changed': (name: string, status: McpServerStatus, error?: string) => void
  'tools-discovered': (name: string, tools: McpToolInfo[]) => void
  'log': (name: string, entry: McpServerLogEntry) => void
}

/**
 * Full process supervisor for MCP servers.
 *
 * Features:
 * - Auto-restart with exponential backoff (up to 3 retries)
 * - Per-server status tracking
 * - Ring buffer log capture (500 entries per server)
 * - Health check via periodic listTools()
 * - Event emitter for status changes
 */
export class McpClientManager extends EventEmitter {
  private servers = new Map<string, McpManagedServer>()
  private scratchDir: string | undefined

  constructor(scratchDir?: string) {
    super()
    this.scratchDir = scratchDir
  }

  getScratchDir(): string | undefined {
    return this.scratchDir
  }

  // Type-safe event emitter overrides
  override on<K extends keyof McpClientManagerEvents>(event: K, listener: McpClientManagerEvents[K]): this {
    return super.on(event, listener)
  }
  override emit<K extends keyof McpClientManagerEvents>(event: K, ...args: Parameters<McpClientManagerEvents[K]>): boolean {
    return super.emit(event, ...args)
  }

  /**
   * Connect to an MCP server, discover tools, and return them.
   * The server is then managed with auto-restart and health checks.
   * Returns null on failure (graceful degradation).
   */
  async connect(serverConfig: McpServerConfig, options?: McpConnectOptions): Promise<McpToolInfo[] | null> {
    // Skip command check when an external transport is provided (e.g. container)
    // — the command is embedded in the transport, not in the server config
    if (!options?.externalTransport && serverConfig.transport === 'stdio' && !serverConfig.command) {
      console.warn(`[MCP] Missing command for stdio server "${serverConfig.name}"`)
      return null
    }
    if (!options?.externalTransport && serverConfig.transport === 'http' && !serverConfig.url) {
      console.warn(`[MCP] Missing URL for HTTP server "${serverConfig.name}"`)
      return null
    }
    if (!options?.externalTransport && serverConfig.transport !== 'stdio' && serverConfig.transport !== 'http') {
      console.warn(`[MCP] Unsupported transport for "${serverConfig.name}": ${serverConfig.transport}`)
      return null
    }

    // If already managed, disconnect first
    if (this.servers.has(serverConfig.name)) {
      await this.disconnect(serverConfig.name)
    }

    const managed: McpManagedServer = {
      config: serverConfig,
      client: null,
      transport: null,
      status: 'connecting',
      tools: [],
      logs: [],
      restartCount: 0,
      autoRestart: true,
      connectOptions: options
    }
    this.servers.set(serverConfig.name, managed)
    this.emitStatusChange(managed)
    const mode = options?.externalTransport ? ' (container)' : serverConfig.transport === 'http' ? ' (http)' : ''
    const target = serverConfig.transport === 'http'
      ? `url: ${serverConfig.url ?? '(none)'}`
      : `command: ${serverConfig.command ?? '(none)'}, args: ${JSON.stringify(serverConfig.args ?? [])}`
    this.addLog(managed, 'system', `Connecting to "${serverConfig.name}"${mode} — ${target}`)

    const tools = await this.attemptConnection(managed)
    if (tools) {
      this.startHealthCheck(managed)
    }
    return tools
  }

  /**
   * Single connection attempt.  On failure, schedules the next attempt in the
   * background (exponential backoff 2s, 4s) instead of blocking the caller —
   * connect() returns null after the first failure and background success is
   * surfaced through 'status-changed'/'tools-discovered' events, exactly like
   * the auto-restart path.
   */
  private async attemptConnection(managed: McpManagedServer, retryIndex = 0): Promise<McpToolInfo[] | null> {
    let client: Client | null = null
    let transport: InstanceType<typeof StdioClientTransport> | InstanceType<typeof StreamableHTTPClientTransport> | Transport | null = null

    try {
      managed.status = 'connecting'
      this.emitStatusChange(managed)

      if (managed.connectOptions?.externalTransport) {
        // Use pre-built transport (e.g. PodmanStdioTransport for container execution)
        transport = managed.connectOptions.externalTransport
      } else if (managed.config.transport === 'http') {
        const headers = resolveMcpRequestHeaders(managed.config)
        transport = new StreamableHTTPClientTransport(new URL(managed.config.url!), {
          requestInit: Object.keys(headers).length ? { headers } : undefined
        })
      } else {
        // Default: spawn directly on host via StdioClientTransport
        const expandHome = (p: string) => p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
        const command = expandHome(managed.config.command!)
        const args = managed.config.args?.map(expandHome)

        transport = new StdioClientTransport({
          command,
          args,
          env: { ...process.env, ...filterBlockedEnv(managed.config.env ?? {}) } as Record<string, string>,
          stderr: 'pipe',
          cwd: this.scratchDir
        })
      }

      // Capture stderr output (works for both StdioClientTransport and
      // PodmanStdioTransport — both expose a .stderr stream)
      const stderrStream = (transport as { stderr?: import('stream').Stream }).stderr
      if (stderrStream) {
        stderrStream.on('data', (chunk: Buffer) => {
          const lines = chunk.toString().split('\n').filter(Boolean)
          for (const line of lines) {
            this.addLog(managed, 'stderr', line)
          }
        })
      }

      client = new Client({
        name: 'adf-app',
        version: '0.1.0'
      })

      // Connect with timeout
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Connection timeout (${CONNECTION_TIMEOUT_MS / 1000}s)`)), CONNECTION_TIMEOUT_MS)
        client!.connect(transport!).then(
          () => { clearTimeout(timer); resolve() },
          (err) => { clearTimeout(timer); reject(err) }
        )
      })

      const result = await client.listTools()
      const tools: McpToolInfo[] = (result.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: (t.inputSchema ?? {}) as Record<string, unknown>
      }))

      managed.client = client
      managed.transport = transport
      managed.status = 'connected'
      managed.tools = tools
      managed.error = undefined
      managed.connectedAt = Date.now()
      this.emitStatusChange(managed)
      this.addLog(managed, 'system', `Connected, discovered ${tools.length} tools`)
      this.emit('tools-discovered', managed.config.name, tools)

      // Listen for unexpected disconnection
      client.onclose = () => {
        if (managed.status === 'connected' && managed.autoRestart) {
          this.addLog(managed, 'system', 'Connection lost unexpectedly')
          managed.client = null
          managed.transport = null
          managed.status = 'error'
          managed.error = 'Connection lost'
          this.emitStatusChange(managed)
          this.handleAutoRestart(managed).catch((err) =>
            console.error(`[MCP] Auto-restart error for "${managed.config.name}":`, err)
          )
        }
      }

      console.log(`[MCP] Connected to "${managed.config.name}", discovered ${tools.length} tools`)
      return tools
    } catch (error) {
      // Clean up failed attempt — close both client and transport to prevent orphan processes
      if (client) {
        try { client.onclose = () => {}; await client.close() } catch { /* ignore */ }
      }
      if (transport) {
        const pid = this.stdioTransportPid(transport)
        try { await transport.close() } catch { /* ignore */ }
        this.sweepPidTree(pid)
      }

      const errorMsg = String(error instanceof Error ? error.message : error)
      this.addLog(managed, 'system', `Connection attempt ${retryIndex + 1} failed: ${errorMsg}`)

      managed.status = 'error'
      managed.error = errorMsg
      managed.client = null
      managed.transport = null
      this.emitStatusChange(managed)

      if (retryIndex < MAX_RETRIES - 1) {
        this.scheduleBackgroundRetry(managed, retryIndex + 1)
      } else {
        console.warn(`[MCP] Failed to connect to "${managed.config.name}" after ${MAX_RETRIES} attempts:`, error)
      }
      return null
    }
  }

  /**
   * Schedule the next connection attempt without blocking the caller.
   * The timer is unref'd so it can't hold the process open; on eventual
   * success the attempt registers the connection, resumes health checks, and
   * emits 'tools-discovered' just like a successful auto-restart.
   */
  private scheduleBackgroundRetry(managed: McpManagedServer, retryIndex: number): void {
    this.clearRetryTimer(managed)
    const backoff = INITIAL_BACKOFF_MS * Math.pow(2, retryIndex - 1)
    this.addLog(managed, 'system', `Retrying in ${backoff / 1000}s (background attempt ${retryIndex + 1}/${MAX_RETRIES})...`)
    const timer = setTimeout(() => {
      managed.retryTimer = undefined
      // Server may have been disconnected or replaced while we waited
      if (this.servers.get(managed.config.name) !== managed) return
      if (!managed.autoRestart || managed.status === 'connected' || managed.status === 'stopped') return
      this.attemptConnection(managed, retryIndex)
        .then((tools) => { if (tools) this.startHealthCheck(managed) })
        .catch((err) => console.error(`[MCP] Background retry error for "${managed.config.name}":`, err))
    }, backoff)
    timer.unref?.()
    managed.retryTimer = timer
  }

  private clearRetryTimer(managed: McpManagedServer): void {
    if (managed.retryTimer) {
      clearTimeout(managed.retryTimer)
      managed.retryTimer = undefined
    }
  }

  /**
   * Handle auto-restart after unexpected disconnection.
   */
  private async handleAutoRestart(managed: McpManagedServer): Promise<void> {
    if (managed.restartCount >= MAX_RETRIES) {
      this.addLog(managed, 'system', `Max restart attempts (${MAX_RETRIES}) reached, giving up`)
      managed.autoRestart = false
      return
    }

    managed.restartCount++
    const backoff = INITIAL_BACKOFF_MS * Math.pow(2, managed.restartCount - 1)
    this.addLog(managed, 'system', `Auto-restart ${managed.restartCount}/${MAX_RETRIES} in ${backoff / 1000}s...`)

    await new Promise((r) => { setTimeout(r, backoff).unref?.() })

    // Check if still managed and wants restart
    if (!this.servers.has(managed.config.name) || !managed.autoRestart) return

    const tools = await this.attemptConnection(managed)
    if (tools) {
      managed.restartCount = 0  // Reset on successful reconnect
      this.startHealthCheck(managed)
      this.emit('tools-discovered', managed.config.name, tools)
    }
  }

  /**
   * Start periodic health checks for a connected server.
   */
  private startHealthCheck(managed: McpManagedServer): void {
    this.stopHealthCheck(managed)
    managed.healthCheckTimer = setInterval(async () => {
      if (managed.status !== 'connected' || !managed.client) return
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Health check timeout (10s)')), 10_000)
          managed.client!.ping().then(
            () => { clearTimeout(timer); resolve() },
            (err: unknown) => { clearTimeout(timer); reject(err) }
          )
        })
      } catch (error) {
        this.addLog(managed, 'system', `Health check failed: ${String(error)}`)
        // Don't auto-restart here — the onclose handler will fire
      }
    }, HEALTH_CHECK_INTERVAL_MS)
    // Never let a health-check timer hold the process open during shutdown
    managed.healthCheckTimer.unref?.()
  }

  private stopHealthCheck(managed: McpManagedServer): void {
    if (managed.healthCheckTimer) {
      clearInterval(managed.healthCheckTimer)
      managed.healthCheckTimer = undefined
    }
  }

  /**
   * Call a tool on a connected MCP server.
   */
  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{ content: string; isError: boolean }> {
    const managed = this.servers.get(serverName)
    if (!managed?.client || managed.status !== 'connected') {
      const status = managed?.status ?? 'unknown'
      const reason = managed?.error ? `: ${managed.error}` : ''
      return { content: `MCP server "${serverName}" is not connected (status: ${status}${reason}). The server may have crashed or failed to start.`, isError: true }
    }

    const argsStr = JSON.stringify(args)
    this.addLog(managed, 'system', `→ ${toolName}(${argsStr.length > 200 ? argsStr.slice(0, 200) + '...' : argsStr})`)

    try {
      const timeout = managed.config.tool_call_timeout_ms ?? TOOL_CALL_TIMEOUT_MS
      const result = await managed.client.callTool(
        { name: toolName, arguments: args },
        undefined,
        { timeout, resetTimeoutOnProgress: true }
      )

      // Extract all MCP content block types
      const contentBlocks = result.content as Array<Record<string, unknown>>
      const textParts: string[] = []
      const images: Array<{ data: string; mimeType: string }> = []
      const audio: Array<{ data: string; mimeType: string }> = []
      const resources: Array<{ data: string; mimeType: string; uri: string }> = []

      for (const block of contentBlocks) {
        switch (block.type) {
          case 'text':
            if (block.text) textParts.push(block.text as string)
            break
          case 'image':
            if (block.data && block.mimeType) {
              images.push({ data: block.data as string, mimeType: block.mimeType as string })
            }
            break
          case 'audio':
            if (block.data && block.mimeType) {
              audio.push({ data: block.data as string, mimeType: block.mimeType as string })
            }
            break
          case 'resource': {
            // Embedded resource — extract text content or preserve blob data
            const res = block.resource as Record<string, unknown> | undefined
            if (res?.text) {
              textParts.push(`[Resource ${res.uri ?? ''}]\n${res.text}`)
            } else if (res?.blob) {
              resources.push({
                data: res.blob as string,
                mimeType: (res.mimeType ?? 'application/octet-stream') as string,
                uri: (res.uri ?? '') as string
              })
            }
            break
          }
          case 'resource_link': {
            const name = block.name as string ?? block.uri
            const desc = block.description ? ` — ${block.description}` : ''
            textParts.push(`[Resource link: ${name}${desc} (${block.uri})]`)
            break
          }
          default:
            // Don't silently drop unknown types — include as text note
            textParts.push(`[Unsupported content type: ${block.type}]`)
            break
        }
      }

      // Recover images the server saved to its scratch cwd but only linked
      // (e.g. Playwright screenshots taken with a filename attach no image block).
      if (images.length === 0 && this.scratchDir && textParts.length > 0) {
        const recovered = loadLinkedScratchImages(textParts.join('\n'), this.scratchDir)
        images.push(...recovered.images)
        textParts.push(...recovered.notes)
      }

      const isError = result.isError === true
      const hasMedia = images.length > 0 || audio.length > 0 || resources.length > 0
      const mediaSuffix = [
        images.length > 0 ? `${images.length} image(s)` : '',
        audio.length > 0 ? `${audio.length} audio` : '',
        resources.length > 0 ? `${resources.length} resource(s)` : '',
      ].filter(Boolean).join(', ')
      const logSuffix = hasMedia ? ` [+${mediaSuffix}]` : ''
      const textPreview = textParts.join('\n')
      const preview = textPreview.length > 200 ? textPreview.slice(0, 200) + '...' : textPreview
      this.addLog(managed, isError ? 'stderr' : 'system', `← ${toolName}: ${isError ? '[ERROR] ' : ''}${preview || '(empty)'}${logSuffix}`)

      // When media/resources are present, return structured JSON so downstream
      // consumers (code/shell) can access the raw base64 data.  The executor
      // strips the binary data for the LLM loop and shows text summaries instead.
      let content: string
      if (hasMedia) {
        const structured: Record<string, unknown> = { text: textParts.join('\n') }
        if (images.length > 0) structured.images = images
        if (audio.length > 0) structured.audio = audio
        if (resources.length > 0) structured.resources = resources
        content = JSON.stringify(structured)
      } else {
        content = textParts.join('\n') || '(empty response)'
      }

      return { content, isError }
    } catch (error) {
      const errorMsg = `MCP tool call failed: ${String(error)}`
      this.addLog(managed, 'stderr', `← ${toolName}: ${errorMsg}`)
      return { content: errorMsg, isError: true }
    }
  }

  /**
   * Manually restart a specific server.
   */
  async restart(serverName: string): Promise<McpToolInfo[] | null> {
    const managed = this.servers.get(serverName)
    if (!managed) return null

    this.addLog(managed, 'system', 'Manual restart requested')
    await this.closeConnection(managed)
    managed.restartCount = 0
    managed.autoRestart = true

    const tools = await this.attemptConnection(managed)
    if (tools) {
      this.startHealthCheck(managed)
    }
    return tools
  }

  /**
   * Disconnect a specific server. Times out after 5s to avoid hanging.
   */
  async disconnect(serverName: string): Promise<void> {
    const managed = this.servers.get(serverName)
    if (managed) {
      managed.autoRestart = false
      this.stopHealthCheck(managed)
      await this.closeConnection(managed)
      managed.status = 'stopped'
      this.emitStatusChange(managed)
      this.addLog(managed, 'system', 'Disconnected')
      this.servers.delete(serverName)
    }
  }

  /**
   * Disconnect all servers. Called on agent stop.
   */
  async disconnectAll(): Promise<void> {
    const names = Array.from(this.servers.keys())
    await Promise.allSettled(names.map((name) => this.disconnect(name)))
  }

  /**
   * Get the state of all managed servers.
   */
  getServerStates(): McpServerState[] {
    return Array.from(this.servers.values()).map((m) => ({
      name: m.config.name,
      status: m.status,
      error: m.error,
      connectedAt: m.connectedAt,
      restartCount: m.restartCount,
      toolCount: m.tools.length,
      logs: [...m.logs]
    }))
  }

  /**
   * Get the state of a specific server.
   */
  getServerState(name: string): McpServerState | null {
    const managed = this.servers.get(name)
    if (!managed) return null
    return {
      name: managed.config.name,
      status: managed.status,
      error: managed.error,
      connectedAt: managed.connectedAt,
      restartCount: managed.restartCount,
      toolCount: managed.tools.length,
      logs: [...managed.logs]
    }
  }

  /**
   * Get logs for a specific server.
   */
  getServerLogs(name: string): McpServerLogEntry[] {
    return [...(this.servers.get(name)?.logs ?? [])]
  }

  /**
   * Check if a server is connected and healthy.
   */
  isConnected(serverName: string): boolean {
    const managed = this.servers.get(serverName)
    return managed?.status === 'connected' && managed.client !== null
  }

  // --- Internal helpers ---

  private async closeConnection(managed: McpManagedServer): Promise<void> {
    const { client, transport } = managed
    // Detach up front: a second (concurrent or repeated) call no-ops, and any
    // pending background retry is cancelled.
    managed.client = null
    managed.transport = null
    this.clearRetryTimer(managed)
    if (!client && !transport) return

    // Capture the child pid before close() — the transport drops it afterwards
    const pid = this.stdioTransportPid(transport)

    if (client) {
      try {
        client.onclose = () => { /* detached */ }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 4000)
          timer.unref?.()
          client.close().then(
            () => { clearTimeout(timer); resolve() },
            () => { clearTimeout(timer); resolve() }  // resolve on error too — best-effort close
          )
        })
      } catch {
        // Ignore close errors
      }
    }

    // Always close transport independently to prevent orphan child processes
    // (bounded so the ~5s total budget holds even if close() hangs)
    if (transport) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1000)
        timer.unref?.()
        Promise.resolve()
          .then(() => transport.close())
          .then(() => { clearTimeout(timer); resolve() }, () => { clearTimeout(timer); resolve() })
      })
    }

    // Runs even when client.close()/transport.close() threw or timed out
    this.sweepPidTree(pid)
  }

  /** Pid of the child spawned by our own StdioClientTransport, else null. */
  private stdioTransportPid(transport: McpManagedServer['transport']): number | null {
    if (!transport || !(transport instanceof StdioClientTransport)) return null
    const pid = (transport as { pid?: number | null }).pid
    return typeof pid === 'number' && pid > 0 ? pid : null
  }

  /**
   * win32 post-close sweep: npx/uvx fallback configs spawn through a
   * cross-spawn cmd.exe shim, and transport.close() only kills the shim —
   * the real server survives as an orphan.  killTree runs
   * `taskkill /pid <pid> /T /F` to reap the whole tree.  No-op on POSIX:
   * group-kill there needs a detached spawn, which the SDK doesn't use.
   */
  private sweepPidTree(pid: number | null): void {
    if (pid == null || process.platform !== 'win32') return
    killTree({ pid } as unknown as import('child_process').ChildProcess)
  }

  private addLog(managed: McpManagedServer, stream: McpServerLogEntry['stream'], message: string): void {
    const entry: McpServerLogEntry = {
      timestamp: Date.now(),
      stream,
      message
    }
    managed.logs.push(entry)
    // Ring buffer: batch-trim at 20% over capacity to amortise the O(n) splice
    if (managed.logs.length > MAX_LOG_ENTRIES + 100) {
      managed.logs.splice(0, managed.logs.length - MAX_LOG_ENTRIES)
    }
    this.emit('log', managed.config.name, entry)
  }

  private emitStatusChange(managed: McpManagedServer): void {
    this.emit('status-changed', managed.config.name, managed.status, managed.error)
  }
}
