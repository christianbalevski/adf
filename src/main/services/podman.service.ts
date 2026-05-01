/**
 * Shared Podman container lifecycle manager for the ADF compute environment.
 *
 * - One container serves all agents, namespaced via /workspace/{agentId}/
 * - Always runs with --network=bridge (network access is the job, not the risk)
 * - Started on first need, stopped when no agents require it (with delay)
 * - Provides exec(), copyToContainer(), copyFromContainer() for the
 *   MCP transport layer and fs_transfer tool.
 */

import { execFile, spawn, type ChildProcess } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'fs'
import { EventEmitter } from 'events'
import { checkPodmanAvailability } from './podman-bootstrap'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ComputeEnvStatus =
  | 'not_installed'
  | 'machine_stopped'
  | 'stopped'
  | 'starting'
  | 'running'
  | 'error'

export interface ComputeEnvInfo {
  status: ComputeEnvStatus
  containerName: string
  activeAgents: string[]
  error?: string
}

interface PodmanServiceEvents {
  'status-changed': (info: ComputeEnvInfo) => void
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SHARED_CONTAINER = 'adf-mcp'
const STOP_DELAY_MS = 30_000

/** Build a container name for an isolated agent: adf-{sanitized-name} */
export function isolatedContainerName(agentName: string, agentId: string): string {
  const safe = agentName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 30)
  const shortId = agentId.slice(0, 8)
  return `adf-${safe || shortId}-${shortId}`
}

/** Return the workspace path inside a container.
 *  Isolated containers use /workspace/ directly.
 *  Shared container namespaces by agentId: /workspace/{agentId}/ */
export function containerWorkspacePath(isolated: boolean, agentId: string): string {
  return isolated ? '/workspace' : `/workspace/${agentId}`
}

export interface ComputeEnvSettings {
  containerPackages: string[]
  machineCpus: number
  machineMemoryMb: number
  containerImage: string
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS: ComputeEnvSettings = {
  containerPackages: ['python3-full', 'python3-pip', 'git', 'curl', 'wget', 'jq', 'unzip', 'ca-certificates', 'openssh-client', 'procps', 'chromium', 'chromium-driver', 'fonts-liberation', 'libnss3', 'libatk-bridge2.0-0', 'libdrm2', 'libgbm1', 'libasound2'],
  machineCpus: 2,
  machineMemoryMb: 2048,
  containerImage: 'docker.io/library/node:20-slim',
}

export interface ContainerExecLogEntry {
  timestamp: number
  containerName: string
  command: string
  exitCode: number
  stdout: string   // truncated
  stderr: string   // truncated
  durationMs: number
}

const MAX_EXEC_LOG = 200
const LOG_TRUNCATE = 500

export class PodmanService extends EventEmitter {
  private status: ComputeEnvStatus = 'stopped'
  private podmanBin: string | null = null
  private activeAgentIds = new Set<string>()
  private stopTimer: ReturnType<typeof setTimeout> | null = null
  private errorMessage?: string
  private _getSettings: () => ComputeEnvSettings = () => DEFAULT_SETTINGS
  /** Mutex: pending container creation promises to prevent duplicate concurrent creates. */
  private _pendingCreates = new Map<string, Promise<void>>()
  /** Recent compute_exec command history for the detail view. */
  private _execLog: ContainerExecLogEntry[] = []

  // Typed event helpers
  override on<K extends keyof PodmanServiceEvents>(event: K, listener: PodmanServiceEvents[K]): this {
    return super.on(event, listener)
  }
  override emit<K extends keyof PodmanServiceEvents>(event: K, ...args: Parameters<PodmanServiceEvents[K]>): boolean {
    return super.emit(event, ...args)
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  getStatus(): ComputeEnvInfo {
    return {
      status: this.status,
      containerName: SHARED_CONTAINER,
      activeAgents: [...this.activeAgentIds],
      error: this.errorMessage,
    }
  }

  isRunning(): boolean {
    return this.status === 'running'
  }

  /**
   * Set a callback that returns the current compute settings from the settings service.
   * Called lazily on each ensureRunning() so the latest settings are always used.
   */
  setSettingsAccessor(fn: () => ComputeEnvSettings): void {
    this._getSettings = fn
  }

  /**
   * Resolve the podman binary path (cached after first call).
   * Returns null if Podman is not installed.
   */
  async findPodman(): Promise<string | null> {
    if (this.podmanBin) return this.podmanBin
    const info = await checkPodmanAvailability()
    if (info.available && info.binPath) {
      this.podmanBin = info.binPath
    }
    return this.podmanBin
  }

  /**
   * Ensure the shared container is running.
   * Handles: machine init (macOS/Windows), image pull, container create & start.
   * No-op if already running.
   */
  async ensureRunning(): Promise<void> {
    if (this.status === 'running') return

    const bin = await this.findPodman()
    if (!bin) {
      this.setStatus('not_installed', 'Podman is not installed')
      throw new Error('Podman not found. Install Podman to use the compute environment.')
    }

    this.setStatus('starting')

    try {
      await this.ensureMachine(bin)
      await this.ensureContainerRunning(bin, SHARED_CONTAINER)
      this.setStatus('running')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.setStatus('error', msg)
      throw err
    }
  }

  /**
   * Ensure an isolated container for a specific agent is running.
   * Same provisioning as the shared container, but named per-agent.
   * Persists across restarts (fast restart on subsequent starts).
   * Serialized per container name to prevent duplicate concurrent creates.
   */
  async ensureIsolatedRunning(agentName: string, agentId: string): Promise<void> {
    const name = isolatedContainerName(agentName, agentId)

    // Deduplicate concurrent calls for the same container —
    // store promise BEFORE any async work to prevent race
    const pending = this._pendingCreates.get(name)
    if (pending) { await pending; return }

    const p = (async () => {
      const bin = await this.requirePodman()
      await this.ensureMachine(bin)
      await this.ensureContainerRunning(bin, name)
      console.log(`[Compute] Isolated container ${name} ready`)
    })().finally(() => {
      this._pendingCreates.delete(name)
    })
    this._pendingCreates.set(name, p)
    await p
  }

  /** Stop an isolated container (preserves state). */
  async stopIsolated(agentName: string, agentId: string): Promise<void> {
    const name = isolatedContainerName(agentName, agentId)
    const bin = await this.findPodman()
    if (!bin) return
    try { await this.exec0(bin, ['stop', '-t', '5', name]) } catch { /* ok */ }
  }

  /** Destroy an isolated container completely. */
  async destroyIsolated(agentName: string, agentId: string): Promise<void> {
    await this.stopIsolated(agentName, agentId)
    const bin = await this.findPodman()
    if (!bin) return
    try { await this.exec0(bin, ['rm', '-f', isolatedContainerName(agentName, agentId)]) } catch { /* ok */ }
  }

  /**
   * List all adf-mcp containers (shared + isolated) with their status.
   */
  async listContainers(): Promise<Array<{ name: string; status: string; running: boolean }>> {
    const bin = await this.findPodman()
    if (!bin) return []

    const result = await this.exec0(bin, [
      'ps', '-a', '--filter', 'name=adf-',
      '--format', '{{.Names}}|{{.State}}', '--noheading'
    ])
    if (result.code !== 0 || !result.stdout.trim()) return []

    return result.stdout.split('\n').filter(Boolean).map((line) => {
      const [name, state] = line.split('|')
      return { name: name.trim(), status: state?.trim() ?? 'unknown', running: state?.trim() === 'running' }
    })
  }

  /**
   * Ensure the workspace directory for an agent exists in the given container.
   * For isolated containers, workspacePath should be '/workspace'.
   * For shared containers, '/workspace/{agentId}'.
   */
  async ensureWorkspace(containerName: string, workspacePath: string): Promise<void> {
    const bin = await this.requirePodman()
    await this.exec0(bin, ['exec', containerName, 'mkdir', '-p', workspacePath])
  }

  /**
   * Register an agent as using the compute environment.
   * Creates its workspace directory inside the container.
   */
  async registerAgent(agentId: string): Promise<void> {
    if (this.activeAgentIds.has(agentId)) return

    // Cancel pending stop
    if (this.stopTimer) {
      clearTimeout(this.stopTimer)
      this.stopTimer = null
    }

    this.activeAgentIds.add(agentId)

    // Create workspace directory inside container
    const bin = await this.requirePodman()
    await this.exec0(bin, [
      'exec', SHARED_CONTAINER,
      'mkdir', '-p', `/workspace/${agentId}`,
    ])

    this.emitStatus()
  }

  /**
   * Unregister an agent from the shared container.
   * The shared container stays running for the app's lifetime.
   */
  unregisterAgent(agentId: string): void {
    this.activeAgentIds.delete(agentId)
    this.emitStatus()
  }

  /**
   * Stop the shared container (preserves state — fast restart next time).
   */
  async stop(): Promise<void> {
    if (this.stopTimer) {
      clearTimeout(this.stopTimer)
      this.stopTimer = null
    }

    const bin = await this.findPodman()
    if (!bin) return

    try {
      await this.exec0(bin, ['stop', '-t', '5', SHARED_CONTAINER])
    } catch { /* may already be stopped */ }

    this.activeAgentIds.clear()
    this.setStatus('stopped')
  }

  /**
   * Stop ALL adf-* containers (shared + isolated). Called on app quit.
   */
  async stopAll(): Promise<void> {
    const bin = await this.findPodman()
    if (!bin) return

    const containers = await this.listContainers()
    const running = containers.filter((c) => c.running)
    if (running.length === 0) return

    console.log(`[Compute] Stopping ${running.length} container(s): ${running.map((c) => c.name).join(', ')}`)
    await Promise.all(
      running.map((c) => this.exec0(bin, ['stop', '-t', '5', c.name]).catch(() => {}))
    )
    this.activeAgentIds.clear()
    this.setStatus('stopped')
  }

  async stopContainer(name: string): Promise<boolean> {
    const bin = await this.findPodman()
    if (!bin) return false
    const result = await this.exec0(bin, ['stop', '-t', '5', name])
    return result.code === 0
  }

  async startContainer(name: string): Promise<boolean> {
    const bin = await this.findPodman()
    if (!bin) return false
    const result = await this.exec0(bin, ['start', name])
    return result.code === 0
  }

  async destroyContainer(name: string): Promise<boolean> {
    const bin = await this.findPodman()
    if (!bin) return false
    const result = await this.exec0(bin, ['rm', '-f', name])
    return result.code === 0
  }

  /**
   * Destroy the container completely (removes all installed packages/state).
   * Next ensureRunning() will do a full first-time setup.
   */
  async destroy(): Promise<void> {
    await this.stop()
    const bin = await this.findPodman()
    if (!bin) return

    try {
      await this.exec0(bin, ['rm', '-f', SHARED_CONTAINER])
    } catch { /* may already be removed */ }
    console.log('[Compute] Container destroyed — will be recreated on next start')
  }

  async setup(
    step: 'install' | 'machine_init' | 'machine_start' | 'check',
    installCommand?: string
  ): Promise<Record<string, unknown>> {
    const run = (cmd: string, cmdArgs: string[], timeout = 300_000): Promise<{ stdout: string; stderr: string; code: number }> =>
      new Promise((resolve) => {
        execFile(cmd, cmdArgs, { timeout }, (error, stdout, stderr) => {
          resolve({ stdout: stdout?.trim() ?? '', stderr: stderr?.trim() ?? '', code: error ? 1 : 0 })
        })
      })

    const explainMachineError = (op: 'init' | 'start', stderr: string): string => {
      const normalized = stderr.replace(/\u0000/g, '')
      if (process.platform === 'win32' && /Windows Subsystem for Linux is not installed/i.test(normalized)) {
        return 'WSL is required but not installed. Run `wsl --install` in an admin terminal, reboot, then retry.'
      }
      return normalized.trim() || `podman machine ${op} failed`
    }

    if (step === 'check') {
      return { success: true, availability: await checkPodmanAvailability() }
    }

    if (step === 'install') {
      if (!installCommand) return { success: false, error: 'No install command provided' }
      const parts = installCommand.split(/\s+/).filter(Boolean)
      const startIdx = parts[0] === 'sudo' ? 1 : 0
      const cmd = parts[startIdx]
      const cmdArgs = parts.slice(startIdx + 1)
      if (!cmd) return { success: false, error: 'No install command provided' }

      console.log(`[Compute] Running: ${cmd} ${cmdArgs.join(' ')}`)
      const result = await run(cmd, cmdArgs)
      if (result.code !== 0) return { success: false, error: result.stderr || `${cmd} failed` }
      return { success: true, availability: await checkPodmanAvailability() }
    }

    if (step === 'machine_init') {
      const info = await checkPodmanAvailability()
      if (!info.binPath) return { success: false, error: 'Podman not installed' }
      const missingPrereq = info.prerequisites.find((p) => !p.installed)
      if (missingPrereq) {
        return { success: false, error: `Missing prerequisite: ${missingPrereq.name}. Run \`${missingPrereq.installCommand}\` first.`, availability: info }
      }
      const result = await run(info.binPath, ['machine', 'init', '--memory', '2048', '--cpus', '2'], 300_000)
      if (result.code !== 0 && !result.stderr.includes('already exists')) {
        return { success: false, error: explainMachineError('init', result.stderr), availability: await checkPodmanAvailability() }
      }
      return { success: true, availability: await checkPodmanAvailability() }
    }

    const info = await checkPodmanAvailability()
    if (!info.binPath) return { success: false, error: 'Podman not installed' }
    const missingPrereq = info.prerequisites.find((p) => !p.installed)
    if (missingPrereq) {
      return { success: false, error: `Missing prerequisite: ${missingPrereq.name}. Run \`${missingPrereq.installCommand}\` first.`, availability: info }
    }
    const result = await run(info.binPath, ['machine', 'start'], 120_000)
    if (result.code !== 0 && !result.stderr.includes('already running')) {
      return { success: false, error: explainMachineError('start', result.stderr), availability: await checkPodmanAvailability() }
    }
    return { success: true, availability: await checkPodmanAvailability() }
  }

  // ---------------------------------------------------------------------------
  // Exec helpers (used by PodmanStdioTransport and fs_transfer)
  // ---------------------------------------------------------------------------

  /**
   * Spawn an interactive exec inside the container (for MCP stdio transport).
   * Returns the raw ChildProcess so the caller can pipe stdin/stdout.
   */
  spawnExec(agentId: string, command: string, args: string[], env?: Record<string, string>, cwd?: string): ChildProcess {
    if (!this.podmanBin) throw new Error('Podman not initialized')

    const execArgs: string[] = ['exec', '-i', '-w', cwd ?? `/workspace/${agentId}`]

    if (env) {
      for (const [k, v] of Object.entries(env)) {
        execArgs.push('-e', `${k}=${v}`)
      }
    }

    execArgs.push(SHARED_CONTAINER, command, ...args)

    return spawn(this.podmanBin, execArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    })
  }

  /**
   * Spawn an ephemeral image-backed process. The container is removed when the
   * process exits, so the binding owns the container lifecycle.
   */
  async spawnImageProcess(image: string, command: string, args: string[], env?: Record<string, string>, cwd?: string): Promise<ChildProcess> {
    const bin = await this.requirePodman()
    await this.ensureMachine(bin)

    const imageCheck = await this.exec0(bin, ['image', 'exists', image])
    if (imageCheck.code !== 0) {
      await this.exec0(bin, ['pull', image], 120_000)
    }

    const runArgs: string[] = ['run', '--rm', '-i', '--network=bridge']
    if (cwd) runArgs.push('-w', cwd)
    if (env) {
      for (const [k, v] of Object.entries(env)) {
        runArgs.push('-e', `${k}=${v}`)
      }
    }
    runArgs.push(image, command, ...args)

    return spawn(bin, runArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    })
  }

  /**
   * Copy a file from the host into a container.
   * Creates parent directories automatically.
   */
  async copyToContainer(hostPath: string, containerPath: string, containerName = SHARED_CONTAINER): Promise<void> {
    const bin = await this.requirePodman()

    // Ensure parent directory exists inside container
    const parentDir = containerPath.substring(0, containerPath.lastIndexOf('/'))
    if (parentDir) {
      await this.exec0(bin, ['exec', containerName, 'mkdir', '-p', parentDir])
    }

    await this.exec0(bin, ['cp', hostPath, `${containerName}:${containerPath}`])
  }

  /**
   * Copy a file from a container to the host.
   */
  async copyFromContainer(containerPath: string, hostPath: string, containerName = SHARED_CONTAINER): Promise<void> {
    const bin = await this.requirePodman()
    await this.exec0(bin, ['cp', `${containerName}:${containerPath}`, hostPath])
  }

  /**
   * Copy raw bytes into a container by writing to a temp file first.
   * Returns the container-internal path.
   */
  async stageBytes(agentId: string, relativePath: string, data: Buffer, containerName = SHARED_CONTAINER): Promise<string> {
    const tmpDir = mkdtempSync(join(tmpdir(), 'adf-stage-'))
    const tmpPath = join(tmpDir, 'data')
    const containerDest = `/workspace/${agentId}/${relativePath}`

    try {
      writeFileSync(tmpPath, data)
      await this.copyToContainer(tmpPath, containerDest, containerName)
    } finally {
      try { unlinkSync(tmpPath) } catch { /* ignore */ }
      try { unlinkSync(tmpDir) } catch { /* dirs cleaned up by OS */ }
    }
    return containerDest
  }

  /**
   * Read bytes from a container via a temp file.
   */
  async ingestBytes(agentId: string, relativePath: string, containerName = SHARED_CONTAINER): Promise<Buffer> {
    const tmpDir = mkdtempSync(join(tmpdir(), 'adf-ingest-'))
    const tmpPath = join(tmpDir, 'data')
    const containerSrc = `/workspace/${agentId}/${relativePath}`

    try {
      await this.copyFromContainer(containerSrc, tmpPath, containerName)
      return readFileSync(tmpPath)
    } finally {
      try { unlinkSync(tmpPath) } catch { /* ignore */ }
    }
  }

  // ---------------------------------------------------------------------------
  // Container create/start (shared by ensureRunning and ensureIsolatedRunning)
  // ---------------------------------------------------------------------------

  /**
   * Ensure a container with the given name exists and is running.
   * If it exists stopped, start it (fast). If it doesn't exist, create and provision.
   */
  private async ensureContainerRunning(bin: string, containerName: string): Promise<void> {
    // Check if container already exists
    const inspectResult = await this.exec0(bin, ['container', 'inspect', containerName, '--format', '{{.State.Running}}'])
    if (inspectResult.code === 0) {
      if (inspectResult.stdout.trim() === 'true') return // Already running
      // Exists but stopped — fast restart
      console.log(`[Compute] Starting existing container ${containerName}...`)
      await this.exec0(bin, ['start', containerName], 30_000)
      return
    }

    // First-time setup: create + provision
    console.log(`[Compute] Creating container ${containerName}...`)
    const cfg = this._getSettings()
    const image = cfg.containerImage || DEFAULT_SETTINGS.containerImage

    const imageCheck = await this.exec0(bin, ['image', 'exists', image])
    if (imageCheck.code !== 0) {
      console.log(`[Compute] Pulling image ${image}...`)
      await this.exec0(bin, ['pull', image], 120_000)
    }

    const runArgs = ['run', '-d', '--name', containerName, '--network=bridge',
      // Puppeteer: use system Chromium, skip download, run without sandbox in container
      // Browser automation: use system Chromium + ChromeDriver, no sandbox in container
      '-e', 'PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true',
      '-e', 'PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium',
      '-e', 'PUPPETEER_ARGS=--no-sandbox --disable-setuid-sandbox',
      '-e', 'CHROME_BIN=/usr/bin/chromium',
      '-e', 'CHROMEDRIVER_PATH=/usr/bin/chromedriver',
      '-e', 'CHROMIUM_FLAGS=--no-sandbox --disable-dev-shm-usage',
      // Selenium/webdriver-manager: use system chromedriver, don't download
      '-e', 'WDM_LOCAL=1',
      '-e', 'SE_CHROMEDRIVER=/usr/bin/chromedriver',
    ]
    runArgs.push(image, 'sh', '-c', 'mkdir -p /workspace && exec sleep infinity')
    await this.exec0(bin, runArgs)

    // Provision packages
    const pkgs = cfg.containerPackages?.length ? cfg.containerPackages : DEFAULT_SETTINGS.containerPackages
    if (pkgs.length > 0) {
      console.log(`[Compute] Installing packages in ${containerName}: ${pkgs.join(', ')}`)
      // Detect package manager: apt-get for Debian-based, apk for Alpine
      const isAlpine = image.includes('alpine')
      let pkgResult: { stdout: string; stderr: string; code: number }
      if (isAlpine) {
        pkgResult = await this.exec0(bin, ['exec', containerName, 'apk', 'add', '--no-cache', ...pkgs], 300_000)
      } else {
        pkgResult = await this.exec0(bin, ['exec', containerName, 'sh', '-c',
          `apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${pkgs.join(' ')} && rm -rf /var/lib/apt/lists/*`
        ], 600_000) // 10 minutes — chromium alone is ~200MB
      }
      if (pkgResult.code !== 0) {
        console.error(`[Compute] Package install failed in ${containerName} (exit ${pkgResult.code}):`, pkgResult.stderr.slice(0, 500))
      }
    }

    // Install uv (Python package manager for uvx-based MCP servers)
    console.log(`[Compute] Installing uv in ${containerName}...`)
    const uvResult = await this.exec0(bin, [
      'exec', containerName, 'sh', '-c',
      'wget -qO- https://astral.sh/uv/install.sh | sh && ln -sf /root/.local/bin/uv /usr/local/bin/uv && ln -sf /root/.local/bin/uvx /usr/local/bin/uvx'
    ], 120_000)
    if (uvResult.code !== 0) {
      console.error(`[Compute] uv install failed in ${containerName}:`, uvResult.stderr.slice(0, 500))
    }

    console.log(`[Compute] Container ${containerName} provisioned successfully`)
  }

  // ---------------------------------------------------------------------------
  // Machine management (macOS / Windows)
  // ---------------------------------------------------------------------------

  private async ensureMachine(bin: string): Promise<void> {
    const plat = process.platform
    if (plat !== 'darwin' && plat !== 'win32') return

    // Check if any machine is already running
    const list = await this.exec0(bin, ['machine', 'list', '--format', '{{.Running}}', '--noheading'])
    if (list.code === 0 && list.stdout.toLowerCase().includes('true')) return

    // Check if a machine exists but is stopped
    const listNames = await this.exec0(bin, ['machine', 'list', '--format', '{{.Name}}', '--noheading'])
    if (listNames.code === 0 && listNames.stdout.trim()) {
      // Machine exists, start it
      console.log('[Compute] Starting Podman machine…')
      const startRes = await this.exec0(bin, ['machine', 'start'], 120_000)
      if (startRes.code !== 0 && !/already running/i.test(startRes.stderr)) {
        throw new Error(this.explainMachineError('start', startRes.stderr))
      }
      return
    }

    // No machine — init and start
    const cfg = this._getSettings()
    const mem = String(cfg.machineMemoryMb || DEFAULT_SETTINGS.machineMemoryMb)
    const cpus = String(cfg.machineCpus || DEFAULT_SETTINGS.machineCpus)
    console.log(`[Compute] Initializing Podman machine (${cpus} CPUs, ${mem}MB RAM)…`)
    const initRes = await this.exec0(bin, ['machine', 'init', '--memory', mem, '--cpus', cpus], 180_000)
    if (initRes.code !== 0 && !/already exists/i.test(initRes.stderr)) {
      throw new Error(this.explainMachineError('init', initRes.stderr))
    }
    const startRes = await this.exec0(bin, ['machine', 'start'], 120_000)
    if (startRes.code !== 0 && !/already running/i.test(startRes.stderr)) {
      throw new Error(this.explainMachineError('start', startRes.stderr))
    }
  }

  /**
   * Convert a raw `podman machine` stderr into a user-friendly message.
   * Recognises WSL-not-installed (Windows) and passes other errors through.
   */
  private explainMachineError(op: 'init' | 'start', stderr: string): string {
    // wsl.exe prints UTF-16; Node decodes that as interleaved nulls in UTF-8.
    const normalized = stderr.replace(/\u0000/g, '')
    if (process.platform === 'win32' && /Windows Subsystem for Linux is not installed/i.test(normalized)) {
      return 'WSL is required but not installed. Run `wsl --install` in an admin terminal, reboot, then retry.'
    }
    const trimmed = normalized.trim() || `podman machine ${op} failed`
    return `podman machine ${op} failed: ${trimmed}`
  }

  // ---------------------------------------------------------------------------
  // One-shot command execution
  // ---------------------------------------------------------------------------

  /**
   * Execute a one-shot shell command inside a named container and return the result.
   * The command is passed to `sh -c`, so pipes, chaining, and redirection work.
   */
  async execInContainer(
    containerName: string,
    cwd: string,
    command: string,
    timeout = 30_000
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    const bin = await this.requirePodman()
    const start = Date.now()
    const result = await this.exec0(bin, [
      'exec', '-w', cwd, containerName,
      'sh', '-c', command
    ], timeout)

    // Log for the detail view
    this._execLog.push({
      timestamp: start,
      containerName,
      command,
      exitCode: result.code,
      stdout: result.stdout.slice(0, LOG_TRUNCATE),
      stderr: result.stderr.slice(0, LOG_TRUNCATE),
      durationMs: Date.now() - start,
    })
    if (this._execLog.length > MAX_EXEC_LOG) {
      this._execLog.splice(0, this._execLog.length - MAX_EXEC_LOG)
    }

    return result
  }

  /** Get recent exec log entries, optionally filtered by container name. */
  getExecLog(containerName?: string): ContainerExecLogEntry[] {
    if (!containerName) return [...this._execLog]
    return this._execLog.filter((e) => e.containerName === containerName)
  }

  /** Query live details about a container: processes, packages, workspace, etc. */
  async getContainerDetail(containerName: string): Promise<{
    processes: string
    packages: string
    workspace: string
    info: string
  }> {
    const bin = await this.findPodman()
    if (!bin) return { processes: '', packages: '', workspace: '', info: '' }

    const [processes, packages, workspace, info] = await Promise.all([
      this.exec0(bin, ['exec', containerName, 'sh', '-c', 'ps aux --sort=-start_time 2>/dev/null || ps -ef 2>/dev/null || echo "ps not available"'], 10_000),
      this.exec0(bin, ['exec', containerName, 'sh', '-c',
        'echo "=== apt ===" && dpkg -l 2>/dev/null | grep "^ii" | wc -l && echo "=== npm global ===" && (ls /root/.npm/_npx 2>/dev/null | head -20 || echo "none") && echo "=== uv tools ===" && (ls /root/.local/share/uv/tools 2>/dev/null | head -20 || echo "none") && echo "=== pip ===" && (pip list --format=columns 2>/dev/null | tail -20 || echo "none")'
      ], 10_000),
      this.exec0(bin, ['exec', containerName, 'sh', '-c',
        'echo "=== /workspace ===" && ls -la /workspace/ 2>/dev/null && for d in /workspace/*/; do echo "--- $d ---" && ls -la "$d" 2>/dev/null | head -10; done'
      ], 10_000),
      this.exec0(bin, ['inspect', containerName, '--format',
        'Image: {{.Config.Image}}\nCreated: {{.Created}}\nState: {{.State.Status}}\nPID: {{.State.Pid}}\nNetwork: {{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'
      ], 10_000),
    ])

    return {
      processes: processes.stdout,
      packages: packages.stdout,
      workspace: workspace.stdout,
      info: info.stdout,
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async requirePodman(): Promise<string> {
    const bin = await this.findPodman()
    if (!bin) throw new Error('Podman not found')
    return bin
  }

  private exec0(cmd: string, args: string[], timeout = 30_000): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve) => {
      execFile(cmd, args, { timeout }, (error, stdout, stderr) => {
        resolve({
          stdout: stdout?.trim() ?? '',
          stderr: stderr?.trim() ?? '',
          code: error ? 1 : 0,
        })
      })
    })
  }

  private setStatus(status: ComputeEnvStatus, error?: string): void {
    this.status = status
    this.errorMessage = error
    this.emitStatus()
  }

  private emitStatus(): void {
    this.emit('status-changed', this.getStatus())
  }
}
