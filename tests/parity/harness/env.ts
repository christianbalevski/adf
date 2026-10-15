import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import Module from 'node:module'

/**
 * One isolated machine for one scenario run.
 *
 * Every directory a backend may read or write lives under `root`: user data
 * (settings, templates, subscription tokens), the lease registry, temp, the
 * OS home and app-data directories, and the agents folder. Every inherited
 * `ADF_*` variable is removed and only the harness's own are set; the
 * process env is restored afterwards.
 *
 * Fences (all fail the run when hit):
 * - `fence.cjs`: no podman/wsl spawn, no connection except to this run's own
 *   loopback ports, never 7385. Also in child processes and workers
 *   (NODE_OPTIONS and Worker execArgv carry `--require fence.cjs`).
 * - Secrets: `ADF_KEYCHAIN=0` makes every OS-keychain opener in Studio code
 *   return null, `ADF_SECRET_STORE=file` forces the daemon's passphrase-file
 *   backend, and any load of `@napi-rs/keyring` is refused and recorded.
 * - Real state: the owner's settings, backend selection, daemon token and pid
 *   files, lease registry, `~/.adf`, and Claude/Codex credential files are
 *   fingerprinted (size + mtime, never read) before the run and checked after.
 *   A real Studio running on the same machine can write its own settings
 *   during a run and trip this check; rerun when that happens.
 */
export interface ParityEnv {
  /** Canonical (realpath) root of everything this run touches. */
  readonly root: string
  /** Every spelling of `root` code may produce, each with its own token (see normalize R1). */
  readonly rootSpellings: readonly { spelling: string; token: string }[]
  readonly userDataDir: string
  readonly leaseDir: string
  readonly tempDir: string
  readonly homeDir: string
  /** Where fixture agents live. */
  readonly agentsDir: string
  /** Free loopback port handed to the mesh server through MESH_PORT. */
  readonly meshPort: number
  /** Wall clock when the run began; timestamps outside the run window stay raw. */
  readonly startedAt: number
  /** Fence violations land here, one JSON line each (also from fenced child processes). */
  readonly violationsLog: string
  /** Electron `app.getPath(name)` for this run. */
  appPath(name: string): string
  /** Let the fence accept connections to one more loopback port (a backend's own server). */
  allowPort(port: number): void
}

type Fence = {
  install(o: { logFile: string; root: string; ports: number[] }): unknown
  uninstall(): void
  allowPort(port: number): void
}
export const FENCE_PATH = join(__dirname, 'fence.cjs')
const fence = createRequire(__filename)('./fence.cjs') as Fence

/** Variables the harness sets; every other `ADF_*` is removed for the run. */
const OWN_ENV = [
  'ADF_USER_DATA_DIR', 'ADF_LEASE_DIR', 'ADF_TEMP_DIR', 'ADF_SECRET_STORE', 'ADF_KEYCHAIN',
  'MESH_PORT', 'MESH_HOST', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'TMPDIR', 'TEMP', 'TMP',
  'PARITY_FENCE_LOG', 'PARITY_FENCE_ROOT', 'PARITY_FENCE_PORTS', 'NODE_OPTIONS',
] as const

/** The owner's real per-user state. Fingerprinted, never read. */
function realStatePaths(): { files: string[]; trees: string[] } {
  const home = process.env.USERPROFILE || process.env.HOME || homedir()
  const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming')
  const configBases = [
    appData,
    join(home, 'Library', 'Application Support'),
    process.env.XDG_CONFIG_HOME || join(home, '.config'),
  ]
  const files: string[] = []
  const trees: string[] = []
  for (const base of configBases) {
    for (const product of ['ADF Studio', 'adf-studio']) {
      const dir = join(base, product)
      for (const name of [
        'adf-settings.json', 'studio-backend.json', 'studio-client-settings.json', 'studio-handover.json', 'daemon-token',
        'owner-secrets.json', 'runtime-enc-key',
        join('chatgpt-subscription', 'auth.json'), join('chatgpt-subscription', 'auth.daemon.json'),
        join('grok-subscription', 'auth.json'), join('grok-subscription', 'auth.daemon.json'),
      ]) files.push(join(dir, name))
      // adf-daemon.pid, adf-daemon-<port>.pid
      try {
        for (const f of readdirSync(dir)) if (/^adf-daemon.*\.pid$/.test(f)) files.push(join(dir, f))
      } catch { /* absent */ }
    }
    trees.push(join(base, 'adf', 'leases'))
  }
  trees.push(join(home, '.adf'))
  files.push(join(home, '.claude', '.credentials.json'), join(home, '.codex', 'auth.json'))
  return { files, trees }
}

function fingerprintFile(path: string): string {
  try {
    const s = statSync(path)
    return `${s.size}:${s.mtimeMs}`
  } catch {
    return 'absent'
  }
}

function fingerprintTree(path: string, limit = 5000): string {
  const out: string[] = []
  const walk = (dir: string) => {
    let entries: string[]
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries.sort()) {
      if (out.length >= limit) return
      const p = join(dir, name)
      let s
      try { s = lstatSync(p) } catch { continue }
      out.push(`${relative(path, p)}:${s.size}:${s.mtimeMs}`)
      if (s.isDirectory()) walk(p)
    }
  }
  walk(path)
  return out.join('|') || 'absent'
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

let keyringTripwire: { hits: string[]; restore: () => void } | null = null

/** Refuse and record any load of the keyring addon. */
function installKeyringTripwire(): { hits: string[]; restore: () => void } {
  const mod = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown }
  const original = mod._load
  const hits: string[] = []
  mod._load = function patchedLoad(request: string, ...rest: unknown[]) {
    if (request === '@napi-rs/keyring' || request.startsWith('@napi-rs/keyring-')) {
      hits.push(request)
      throw new Error('parity harness: OS keychain access is forbidden')
    }
    return original.call(this, request, ...rest)
  }
  return { hits, restore: () => { mod._load = original } }
}

/**
 * Delete `root` only if nothing under it is a symlink or junction: on
 * Windows a recursive rm follows junctions and deletes their targets.
 * Returns the links found (then nothing is deleted).
 */
export function removeTreeWithoutLinks(root: string): string[] {
  const links: string[] = []
  const walk = (dir: string) => {
    let entries: string[]
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries) {
      const p = join(dir, name)
      let s
      try { s = lstatSync(p) } catch { continue }
      if (s.isSymbolicLink()) links.push(p)
      else if (s.isDirectory()) walk(p)
    }
  }
  walk(root)
  if (links.length === 0) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  return links
}

export interface ActiveParityEnv extends ParityEnv {
  /** Restore process.env, remove the fences and delete `root` (throws if it holds a link). */
  dispose(): void
  /** Throws on a fence violation or a changed real-state fingerprint. */
  assertRealStateUntouched(): void
  /** Fence violations so far (from the log file, so fenced children count too). */
  violations(): string[]
}

function rootSpellingsOf(rawRoot: string, root: string): { spelling: string; token: string }[] {
  const out: { spelling: string; token: string }[] = []
  const add = (spelling: string, token: string) => {
    if (spelling && !out.some((s) => s.spelling === spelling)) out.push({ spelling, token })
  }
  add(root, '<ROOT>')
  add(rawRoot, '<ROOT:tmpdir-spelling>')
  add(realpathSync(rawRoot), '<ROOT:js-realpath>')
  if (process.platform === 'win32') {
    for (const { spelling, token } of [...out]) {
      add(spelling.replace(/\\/g, '/'), token.replace('>', ':fwd>'))
      if (/^[A-Z]:/.test(spelling)) add(spelling[0].toLowerCase() + spelling.slice(1), token.replace('>', ':lower-drive>'))
    }
  }
  return out.sort((a, b) => b.spelling.length - a.spelling.length)
}

export async function createParityEnv(label: string): Promise<ActiveParityEnv> {
  const startedAt = Date.now()
  const real = realStatePaths()
  const realFingerprints = new Map<string, string>([
    ...real.files.map((p) => [p, fingerprintFile(p)] as [string, string]),
    ...real.trees.map((p) => [p, fingerprintTree(p)] as [string, string]),
  ])
  const rawRoot = mkdtempSync(join(tmpdir(), `adf-parity-${label}-`))
  const root = realpathSync.native(rawRoot)
  const dir = (...parts: string[]) => {
    const p = join(root, ...parts)
    mkdirSync(p, { recursive: true })
    return p
  }
  const userDataDir = dir('user-data')
  const leaseDir = dir('leases')
  const tempDir = dir('temp')
  const homeDir = dir('home')
  const agentsDir = dir('agents')
  const appDataDir = dir('home', 'AppData', 'Roaming')
  const localAppDataDir = dir('home', 'AppData', 'Local')
  const meshPort = await freePort()
  const violationsLog = join(root, 'violations.log')

  const saved = new Map<string, string | undefined>()
  for (const k of Object.keys(process.env)) if (k.startsWith('ADF_')) saved.set(k, process.env[k])
  for (const k of OWN_ENV) saved.set(k, process.env[k])
  for (const k of saved.keys()) delete process.env[k]
  const set: Partial<Record<(typeof OWN_ENV)[number], string>> = {
    ADF_USER_DATA_DIR: userDataDir,
    ADF_LEASE_DIR: leaseDir,
    ADF_TEMP_DIR: tempDir,
    ADF_SECRET_STORE: 'file',
    ADF_KEYCHAIN: '0',
    MESH_PORT: String(meshPort),
    MESH_HOST: '127.0.0.1',
    HOME: homeDir,
    USERPROFILE: homeDir,
    APPDATA: appDataDir,
    LOCALAPPDATA: localAppDataDir,
    XDG_CONFIG_HOME: dir('home', '.config'),
    XDG_DATA_HOME: dir('home', '.local', 'share'),
    CLAUDE_CONFIG_DIR: dir('home', '.claude'),
    CODEX_HOME: dir('home', '.codex'),
    TMPDIR: tempDir,
    TEMP: tempDir,
    TMP: tempDir,
    // For fenced child processes (`-r fence.cjs`); ports are added as backends allow them.
    PARITY_FENCE_LOG: violationsLog,
    PARITY_FENCE_ROOT: root,
    PARITY_FENCE_PORTS: String(meshPort),
    // Every Node / Electron-as-Node child (and grandchild) loads the fence
    // first. NODE_OPTIONS unescapes backslashes inside quotes, so the path is
    // written with forward slashes (valid on every OS).
    NODE_OPTIONS: [saved.get('NODE_OPTIONS'), `--require "${FENCE_PATH.replace(/\\/g, '/')}"`].filter(Boolean).join(' '),
  }
  for (const [k, v] of Object.entries(set)) process.env[k] = v

  keyringTripwire?.restore()
  keyringTripwire = installKeyringTripwire()
  const tripwire = keyringTripwire
  const ports = [meshPort]
  fence.install({ logFile: violationsLog, root, ports })
  // SettingsService adds a process 'exit' flush per instance; each run boots
  // a fresh module graph, so listeners of finished runs are removed at dispose.
  const exitListenersBefore = new Set(process.listeners('exit'))

  const appPaths: Record<string, string> = {
    userData: userDataDir,
    appData: appDataDir,
    temp: tempDir,
    home: homeDir,
    documents: dir('home', 'Documents'),
    downloads: dir('home', 'Downloads'),
    desktop: dir('home', 'Desktop'),
    logs: dir('user-data', 'logs'),
    crashDumps: dir('user-data', 'crashes'),
    sessionData: userDataDir,
  }

  const readViolations = (): string[] => {
    let text = ''
    try { text = readFileSync(violationsLog, 'utf-8') } catch { /* none */ }
    return [
      ...text.split('\n').filter(Boolean),
      ...tripwire.hits.map((h) => `keychain addon requested: ${h}`),
    ]
  }

  return {
    root,
    rootSpellings: rootSpellingsOf(rawRoot, root),
    userDataDir,
    leaseDir,
    tempDir,
    homeDir,
    agentsDir,
    meshPort,
    startedAt,
    violationsLog,
    appPath(name: string): string {
      const p = appPaths[name]
      if (!p) throw new Error(`parity harness: app.getPath('${name}') is not mapped`)
      return p
    },
    allowPort(port: number): void {
      ports.push(port)
      fence.allowPort(port)
      process.env.PARITY_FENCE_PORTS = ports.join(',')
    },
    violations: readViolations,
    assertRealStateUntouched(): void {
      const changed = [...realFingerprints].filter(([p, before]) =>
        (real.trees.includes(p) ? fingerprintTree(p) : fingerprintFile(p)) !== before).map(([p]) => p)
      const v = readViolations()
      if (changed.length || v.length) {
        throw new Error([
          ...changed.map((p) => `parity harness: real state changed during the run: ${p}`),
          ...v.map((x) => `parity harness: fence violation: ${x}`),
        ].join('\n'))
      }
    },
    dispose(): void {
      for (const listener of process.listeners('exit')) {
        if (!exitListenersBefore.has(listener)) process.removeListener('exit', listener)
      }
      fence.uninstall()
      tripwire.restore()
      if (keyringTripwire === tripwire) keyringTripwire = null
      for (const k of OWN_ENV) delete process.env[k]
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      const links = removeTreeWithoutLinks(root)
      if (links.length) throw new Error(`parity harness: refusing to delete ${root}; it contains links: ${links.join(', ')}`)
    },
  }
}

/** Write the run's settings file before any backend boots. */
export function writeSettingsFile(env: ParityEnv, settings: Record<string, unknown>): string {
  const path = join(env.userDataDir, 'adf-settings.json')
  writeFileSync(path, JSON.stringify(settings, null, 2))
  return path
}
