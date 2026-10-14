/**
 * Settings-page MCP connect checks: the probe (temporary connect, tool list)
 * and the registration "Connect" test. Shared by Studio's MCP_PROBE_SERVER /
 * MCP_REGISTRATION_TEST handlers and the daemon's /admin/mcp routes; the
 * host supplies the interactive pieces (the OAuth browser hop, the auth
 * preflight's Continue prompt), the podman service and a log sink so the
 * Logs panel can show a probe's output after its manager is gone.
 *
 * The registration test runs the real pipeline for a registration draft:
 * credential-file materialization + auth preflight on host-located servers,
 * containerized launch for shared-located ones (ephemeral test home, cleaned
 * up), plain HTTP connect for remote servers. See deriveRegistrationTestPlan
 * for what each location can meaningfully verify.
 */

import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { z } from 'zod'
import { McpClientManager } from './mcp-client-manager'
import type { McpAuthPreflightRunner } from './mcp-auth-preflight'
import { expandCredentialPath, CREDENTIAL_FILE_MAX_BYTES } from './mcp-credential-files'
import { buildOAuthProviderFactory } from './mcp-oauth-connect'
import { runMcpHttpOAuthFlow, type McpHttpOAuthIO } from './mcp-http-oauth'
import type { McpOAuthStore } from './mcp-oauth.types'
import { PodmanStdioTransport } from './podman-stdio-transport'
import type { ComputeSettings } from './container-routing'
import { resolveContainerCommand } from './container-command-resolver'
import { buildMcpServerConfigFromRegistration, deriveRegistrationTestPlan } from '../../shared/utils/mcp-config'
import type { McpServerLogEntry } from '../../shared/types/adf-v02.types'
import type { McpRegistrationTestResult, McpServerRegistration } from '../../shared/types/ipc.types'

/** Receives every log line a probe or test run's manager emits. */
export type McpLogSink = (name: string, entry: McpServerLogEntry) => void

/** Max log entries kept per server name by appendMcpLog. */
export const MCP_LOG_CACHE_MAX_ENTRIES = 500

/** Append one entry to a per-server log cache, keeping the newest MCP_LOG_CACHE_MAX_ENTRIES. */
export function appendMcpLog(cache: Map<string, McpServerLogEntry[]>, name: string, entry: McpServerLogEntry): void {
  const cached = cache.get(name) ?? []
  cached.push(entry)
  if (cached.length > MCP_LOG_CACHE_MAX_ENTRIES) cached.splice(0, cached.length - MCP_LOG_CACHE_MAX_ENTRIES)
  cache.set(name, cached)
}

/** Validate args against a Zod schema, returning parsed data or an error response. */
function validateArgs<T>(schema: z.ZodType<T>, args: unknown): { data: T } | { error: string } {
  const result = schema.safeParse(args)
  if (!result.success) return { error: `Invalid arguments: ${result.error.issues.map((i) => i.message).join(', ')}` }
  return { data: result.data }
}

export const McpProbeArgs = z.object({
  transport: z.enum(['stdio', 'http']).optional(),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  url: z.string().url().optional(),
  name: z.string().min(1),
  env: z.record(z.string()).optional(),
  headers: z.record(z.string()).optional(),
  headerEnv: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
  bearerTokenEnvVar: z.string().optional()
}).refine((value) => {
  const transport = value.transport ?? 'stdio'
  return transport === 'http' ? !!value.url : !!value.command
}, { message: 'HTTP probes require url; stdio probes require command.' })

export interface McpProbeDeps {
  uvManager: { ensureUv(): Promise<string> }
  onLog: McpLogSink
}

export async function probeMcpServer(rawArgs: unknown, deps: McpProbeDeps): Promise<{ success: boolean; tools: unknown[]; error?: string }> {
  const v = validateArgs(McpProbeArgs, rawArgs)
  if ('error' in v) return { success: false, tools: [], error: v.error }
  const args = v.data
  const transport = args.transport ?? 'stdio'

  if (transport === 'http') {
    console.log(`[MCP:probe] "${args.name}": url=${args.url}`)
    const tempManager = new McpClientManager()
    tempManager.on('log', (name, entry) => deps.onLog(name, entry))
    try {
      const tools = await tempManager.connect({
        name: args.name,
        transport: 'http',
        url: args.url,
        env: args.env,
        headers: args.headers,
        header_env: args.headerEnv?.map((entry) => ({ header: entry.key, env: entry.value, required: true })),
        bearer_token_env_var: args.bearerTokenEnvVar
      })
      const serverState = tempManager.getServerState(args.name)
      await tempManager.disconnectAll()
      if (tools) return { success: true, tools }
      return { success: false, tools: [], error: serverState?.error ?? 'Failed to connect' }
    } catch (error) {
      await tempManager.disconnectAll()
      return { success: false, tools: [], error: String(error) }
    }
  }

  // Resolve uvx command to actual uv binary (uvx may not be on PATH inside Electron)
  let probeCommand = args.command!
  let probeArgs = args.args ?? []
  if (probeCommand === 'uvx') {
    try {
      const uvPath = await deps.uvManager.ensureUv()
      probeCommand = uvPath
      // No args: the spread throws and the catch below keeps uv with no args (as before the move).
      probeArgs = ['tool', 'run', ...(args.args as string[])]
    } catch (e) {
      console.warn('[MCP:probe] Failed to resolve uv binary for uvx command:', e)
    }
  }

  console.log(`[MCP:probe] "${args.name}": command=${probeCommand}, args=${JSON.stringify(probeArgs)}`)
  const tempManager = new McpClientManager()
  // Cache logs from the probe so the Logs panel can show them
  tempManager.on('log', (name, entry) => deps.onLog(name, entry))
  try {
    const tools = await tempManager.connect({
      name: args.name,
      transport: 'stdio',
      command: probeCommand,
      args: probeArgs,
      env: args.env
    })
    const serverState = tempManager.getServerState(args.name)
    await tempManager.disconnectAll()
    if (tools) {
      return { success: true, tools }
    }
    const errorMsg = serverState?.error ?? 'Failed to connect'
    return { success: false, tools: [], error: errorMsg }
  } catch (error) {
    await tempManager.disconnectAll()
    return { success: false, tools: [], error: String(error) }
  }
}

export const McpRegistrationTestArgs = z.object({
  registration: z.object({
    id: z.string().optional(),
    name: z.string().min(1),
    type: z.enum(['npm', 'uvx', 'pip', 'custom', 'http']).optional(),
    npmPackage: z.string().optional(),
    pypiPackage: z.string().optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    url: z.string().url().optional(),
    headers: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
    headerEnv: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
    bearerTokenEnvVar: z.string().optional(),
    env: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
    toolCallTimeout: z.number().optional(),
    runLocation: z.enum(['host', 'shared']).optional(),
    // OAuth remote (Streamable HTTP): without these, Zod strips the flags at
    // the IPC boundary and the handler's `reg.oauth` check below is never
    // true — the interactive sign-in is silently skipped and the connect goes
    // out with no Authorization header (401 "Missing or invalid authorization
    // header"). Keep in sync with McpServerRegistration.
    oauth: z.boolean().optional(),
    oauthClientId: z.string().optional(),
    oauthScopes: z.array(z.string()).optional(),
    auth: z.boolean().optional(),
    authArgs: z.array(z.string()).optional(),
    authPort: z.number().int().min(1).max(65535).optional(),
    credentialFiles: z.array(z.object({
      path: z.string().min(1),
      required: z.boolean().optional(),
      writeBack: z.boolean().optional(),
    })).optional(),
  }),
  credentialFiles: z.array(z.object({
    path: z.string().min(1),
    contentB64: z.string(),
  })).optional(),
})

/** The podman calls the shared-container branch makes (PodmanService). */
export interface McpTestPodman {
  ensureRunning(): Promise<void>
  findPodman(): Promise<string | null>
  ensureWorkspace(containerName: string, path: string): Promise<unknown>
  execInContainer(containerName: string, cwd: string, command: string): Promise<unknown>
}

export interface McpRegistrationTestDeps {
  /** settings.compute (only hostAccessEnabled is read). */
  computeSettings: () => ComputeSettings
  uvManager: { ensureUv(): Promise<string> }
  podman: McpTestPodman
  /**
   * The app-level OAuth store: a Settings-only test has no agent context, so
   * the app store IS the token store. Null: no store on this host, and an
   * OAuth remote cannot be signed in to.
   */
  appOAuthStore: McpOAuthStore | null
  /** Opens the authorization URL (Studio: the OS browser). */
  oauthIO: McpHttpOAuthIO
  /** Interactive stdio auth preflight (Studio: browser + Continue dialog). */
  authPreflight: McpAuthPreflightRunner
  onLog: McpLogSink
  /**
   * Cancels the test (daemon jobs). The run stops waiting at its next step,
   * disconnects the server it started and answers `error: 'Cancelled'`. An
   * OAuth callback listener already open stays until its own timeout.
   */
  signal?: AbortSignal
}

class McpTestCancelled extends Error {
  constructor() { super('Cancelled') }
}

export async function runMcpRegistrationTest(rawArgs: unknown, deps: McpRegistrationTestDeps): Promise<McpRegistrationTestResult> {
  const v = validateArgs(McpRegistrationTestArgs, rawArgs)
  if ('error' in v) {
    // Type-complete failure: McpRegistrationTestResult declares
    // location/authRan/notes non-optional, and this exit runs before the
    // test plan exists — derive location best-effort from the raw input.
    const rawReg = (rawArgs as { registration?: { url?: unknown; type?: unknown; runLocation?: unknown } } | null | undefined)?.registration
    const location: McpRegistrationTestResult['location'] =
      rawReg?.type === 'http' || typeof rawReg?.url === 'string'
        ? 'remote http'
        : rawReg?.runLocation === 'host' ? 'host' : 'shared container'
    return { success: false, tools: [], error: v.error, location, authRan: false, notes: [] } satisfies McpRegistrationTestResult
  }
  const { registration, credentialFiles } = v.data
  const reg = registration as McpServerRegistration
  const testComputeSettings = deps.computeSettings()
  const plan = deriveRegistrationTestPlan(reg, { hostAccessEnabled: testComputeSettings.hostAccessEnabled })
  const notes = [...plan.notes]
  // Whether an interactive OAuth sign-in was driven during this test.
  let oauthRan = false
  const serverCfg = buildMcpServerConfigFromRegistration(reg)

  const env: Record<string, string> = {}
  for (const e of reg.env ?? []) { if (e.key && e.value) env[e.key] = e.value }

  // The connect factory attaches the token stored by the interactive flow
  // below; it returns undefined for non-oauth servers, so it is harmless on
  // the host/container branches.
  const appOAuthStore = deps.appOAuthStore
  const tempManager = new McpClientManager(undefined, buildOAuthProviderFactory(
    () => appOAuthStore ?? undefined,
  ))
  tempManager.on('log', (name, entry) => deps.onLog(name, entry))
  // Each awaited step races the cancel signal (no signal: the step as is).
  const signal = deps.signal
  const cancelled = signal
    ? new Promise<never>((_resolve, reject) => {
        if (signal.aborted) reject(new McpTestCancelled())
        else signal.addEventListener('abort', () => reject(new McpTestCancelled()), { once: true })
      })
    : null
  cancelled?.catch(() => { /* observed by step() */ })
  const step = <T>(work: Promise<T>): Promise<T> => (cancelled ? Promise.race([work, cancelled]) : work)
  const finish = async (result: { success: boolean; tools: unknown[]; error?: string }): Promise<McpRegistrationTestResult> => {
    // Capture state BEFORE disconnect — teardown clears the log buffer.
    const state = tempManager.getServerState(reg.name)
    const stderrTail = state?.logs.filter((l) => l.stream === 'stderr').slice(-10).map((l) => l.message)
    // Version from the initialize handshake (serverInfo.version) — the
    // truthful version for host npx/uvx and remote HTTP servers whose
    // registration never gets a resolvable package version.
    const serverVersion = tempManager.getServerReportedVersion(reg.name)
    await tempManager.disconnectAll().catch(() => {})
    return { ...result, location: plan.location, authRan: plan.authMode === 'run', oauthRan, notes, ...(serverVersion ? { serverVersion } : {}), ...(stderrTail?.length && !result.success ? { stderrTail } : {}) } as McpRegistrationTestResult
  }

  try {
    if (plan.location === 'remote http') {
      // Interactive OAuth sign-in BEFORE connect when this is an OAuth remote.
      // Idempotent: runMcpHttpOAuthFlow returns AUTHORIZED with no browser hop
      // when a valid token/refresh is already stored. The app store is the
      // "signed-in" source of truth; the connect factory built above then
      // attaches the freshly-stored token to the transport.
      if (reg.oauth && serverCfg.url) {
        const oauthReg = reg as { oauthClientId?: string; oauthScopes?: string[] }
        oauthRan = true
        if (!appOAuthStore) {
          return finish({ success: false, tools: [], error: 'MCP OAuth sign-in is not available on this host: it has no app-level OAuth token store.' })
        }
        const flow = await step(runMcpHttpOAuthFlow(serverCfg.url, appOAuthStore, deps.oauthIO, {
          clientId: oauthReg.oauthClientId,
          scopes: oauthReg.oauthScopes,
        }))
        if (!flow.authorized) {
          return finish({ success: false, tools: [], error: flow.error ?? 'OAuth sign-in did not complete.' })
        }
      }
      const tools = await step(tempManager.connect({ ...serverCfg, env: Object.keys(env).length ? env : undefined }))
      if (tools) return finish({ success: true, tools })
      return finish({ success: false, tools: [], error: tempManager.getServerState(reg.name)?.error ?? 'Failed to connect' })
    }

    if (plan.location === 'host') {
      // Materialize provided credential files into the real host home —
      // for a host-located server the host FS IS the runtime credential
      // store, so these persist (write-if-absent: never clobber existing
      // credentials). Paths are ~-confined by expandCredentialPath.
      for (const f of credentialFiles ?? []) {
        const dest = expandCredentialPath(f.path, { kind: 'host' })
        if (existsSync(dest)) { notes.push(`${f.path} already exists on the host — kept the existing file.`); continue }
        const content = Buffer.from(f.contentB64, 'base64')
        if (content.length > CREDENTIAL_FILE_MAX_BYTES) {
          return finish({ success: false, tools: [], error: `Credential file ${f.path} exceeds the ${Math.round(CREDENTIAL_FILE_MAX_BYTES / 1024)}KiB cap.` })
        }
        mkdirSync(dirname(dest), { recursive: true })
        writeFileSync(dest, content, { mode: 0o600 })
        notes.push(`Wrote ${f.path} to the host home.`)
      }

      // Resolve the launch command the way the probe does — BEFORE the auth
      // preflight, which needs the exact invocation. A registration-shaped
      // serverCfg has package fields but no command, and runMcpAuthPreflight
      // would fall through to `npx <authArgs>` for a pypi package (executing
      // an unrelated npm package literally named e.g. "auth").
      let command: string
      let args: string[]
      const userArgs = (reg.args ?? []).filter(Boolean)
      if (reg.pypiPackage) {
        try {
          const uvPath = await step(deps.uvManager.ensureUv())
          command = uvPath
          args = ['tool', 'run', reg.pypiPackage, ...userArgs]
        } catch {
          command = 'uvx'
          args = [reg.pypiPackage, ...userArgs]
        }
      } else if (reg.npmPackage) {
        command = 'npx'
        args = ['-y', reg.npmPackage, ...userArgs]
      } else {
        command = reg.command ?? ''
        args = userArgs
      }
      if (!command) return finish({ success: false, tools: [], error: 'No command or package to launch.' })

      if (plan.authMode === 'run') {
        // Pass the fully resolved invocation: with command set, the
        // preflight's own npx/uv fallbacks never fire, so the auth run is
        // exactly `<command> <args> <authArgs>` — e.g.
        // `uv tool run <pkg> <userArgs> <authArgs>` for pypi.
        await step(deps.authPreflight({ ...serverCfg, command, args }, { authArgs: reg.authArgs, authPort: reg.authPort, resolvedEnv: env }))
      }
      const tools = await step(tempManager.connect({ name: reg.name, transport: 'stdio', command, args, env: Object.keys(env).length ? env : undefined }))
      if (tools) return finish({ success: true, tools })
      return finish({ success: false, tools: [], error: tempManager.getServerState(reg.name)?.error ?? 'Failed to connect' })
    }

    // Shared container: real containerized launch under an ephemeral test
    // home (auth + credential capture are per-agent concerns — see plan
    // notes). Cleaned up afterwards.
    await step(deps.podman.ensureRunning())
    const podmanBin = await step(deps.podman.findPodman())
    if (!podmanBin) return finish({ success: false, tools: [], error: 'Podman is unavailable — install it (https://podman.io/docs/installation) or start the compute environment in ADF Studio → Settings → Compute.' })
    // Per-invocation test dir so overlapping Connect/Reconnect tests never
    // delete each other's ephemeral home.
    const testDir = `/workspace/_settings_test_${randomUUID()}`
    const testHome = `${testDir}/home`
    try { await deps.podman.ensureWorkspace('adf-mcp', testHome) } catch { /* mkdir in wrapper */ }
    const containerCmd = resolveContainerCommand(serverCfg)
    try {
      const tools = await step(tempManager.connect(
        { name: reg.name, transport: 'stdio', env },
        { externalTransport: new PodmanStdioTransport({ podmanBin, containerName: 'adf-mcp', command: containerCmd.command, args: containerCmd.args, env: { HOME: testHome, ...env }, cwd: testDir }) },
      ))
      if (tools) return finish({ success: true, tools })
      return finish({ success: false, tools: [], error: tempManager.getServerState(reg.name)?.error ?? 'Failed to connect' })
    } finally {
      deps.podman.execInContainer('adf-mcp', '/workspace', `rm -rf ${testDir}`).catch(() => {})
    }
  } catch (error) {
    return finish({ success: false, tools: [], error: error instanceof Error ? error.message : String(error) })
  }
}

/** The uv calls MCP_ENSURE_PYTHON_RUNTIME makes (UvManager). */
export interface PythonRuntimeUv {
  ensureUv(): Promise<string>
  getUvVersion(): Promise<string | null>
  isPythonAvailable(): Promise<boolean>
  ensurePython(): Promise<unknown>
}

/** Make sure uv and a Python it manages exist on this host (downloads them when missing). */
export async function ensurePythonRuntime(uvManager: PythonRuntimeUv) {
  try {
    const uvPath = await uvManager.ensureUv()
    const uvVersion = await uvManager.getUvVersion()
    const pythonAvailable = await uvManager.isPythonAvailable()

    if (!pythonAvailable) {
      await uvManager.ensurePython()
    }

    return {
      success: true,
      uvAvailable: true,
      uvVersion,
      pythonAvailable: true,
      uvPath
    }
  } catch (error) {
    return {
      success: false,
      error: String(error),
      uvAvailable: false,
      pythonAvailable: false
    }
  }
}

/**
 * Whether a valid token is stored (app store) for a remote server URL: lets
 * the client show a "signed in" indicator. Never returns the token.
 */
export async function mcpOAuthStatus(store: Pick<McpOAuthStore, 'get'>, rawArgs: unknown): Promise<{ signedIn: boolean }> {
  const url = (rawArgs as { url?: unknown } | null | undefined)?.url
  if (typeof url !== 'string' || !url) return { signedIn: false }
  try {
    const record = await store.get(url)
    return { signedIn: !!record?.tokens }
  } catch {
    return { signedIn: false }
  }
}

/**
 * Clear the stored token for a remote server URL ("Sign out"). Clears the
 * app-level store, the sign-in source of truth; agent-sealed copies are
 * re-captured on the next attach.
 */
export async function mcpOAuthSignOut(store: Pick<McpOAuthStore, 'invalidate'>, rawArgs: unknown): Promise<{ success: boolean; error?: string }> {
  const url = (rawArgs as { url?: unknown } | null | undefined)?.url
  if (typeof url !== 'string' || !url) return { success: false, error: 'A server url is required to sign out.' }
  try {
    await store.invalidate(url, 'all')
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
