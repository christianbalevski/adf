import { createHash, randomUUID } from 'node:crypto'
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
 * - Machine: `ADF_MACHINE_ID` is a random id per run (no reg.exe / ioreg lookup).
 * - Secrets: `ADF_KEYCHAIN=0` makes every OS-keychain opener in Studio code
 *   return null, `ADF_SECRET_STORE=file` forces the daemon's passphrase-file
 *   backend, and any load of `@napi-rs/keyring` is refused and recorded.
 * - Real state: the owner's settings, backend selection, daemon token and pid
 *   files, lease registry, `~/.adf`, and Claude/Codex credential files are
 *   fingerprinted before the run and checked after. Credentials and settings
 *   are never read; validated non-secret host records are hashed for heartbeat checks.
 *   Test-origin filesystem writes are confined to isolated roots, including
 *   native SQLite opens. Only unchanged live-host heartbeat records may
 *   advance their mtime; all other ambient fingerprint changes still fail.
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
  /** Allocate a fresh harness-control directory outside backend state. */
  createIsolatedDirectory(label: string): string
  /** Electron `app.getPath(name)` for this run. */
  appPath(name: string): string
  /** Let the fence accept connections to one more loopback port (a backend's own server). */
  allowPort(port: number): void
}

type Fence = {
  install(o: { logFile: string; root: string; ports: number[] }): unknown
  uninstall(): void
  allowPort(port: number): void
  createIsolatedDirectory(label: string): string
  violations(): Array<{ kind: string; detail: string; pid: number }>
}
export const FENCE_PATH = join(__dirname, 'fence.cjs')
const fence = createRequire(__filename)('./fence.cjs') as Fence

/** Variables the harness sets; every other `ADF_*` is removed for the run. */
const OWN_ENV = [
  'ADF_USER_DATA_DIR', 'ADF_LEASE_DIR', 'ADF_TEMP_DIR', 'ADF_SECRET_STORE', 'ADF_KEYCHAIN', 'ADF_MACHINE_ID', 'ADF_TEST_ENVELOPE_SWEEP', 'ADF_TEST_SEAMS',
  'MESH_PORT', 'MESH_HOST', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'TMPDIR', 'TEMP', 'TMP',
  'PARITY_FENCE_LOG', 'PARITY_FENCE_ROOT', 'PARITY_FENCE_PORTS', 'PARITY_FENCE_WRITE_ROOTS', 'NODE_OPTIONS',
] as const

/** The owner's real per-user paths; settings and credential contents are never read. */
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

interface TreeEntry {
  stamp: string
  identity: string
  mtimeMs: number
  heartbeat?: { pid: number; digest: string }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** Host records carry no secrets. All other real-state files remain metadata-only. */
function hostHeartbeat(path: string, name: string): TreeEntry['heartbeat'] {
  if (!/^hosts[\\/][1-9]\d*\.json$/.test(name)) return undefined
  try {
    const entry = statSync(path)
    if (entry.size > 64 * 1024 || entry.nlink !== 1) return undefined
    const bytes = readFileSync(path)
    const record = JSON.parse(bytes.toString())
    const pid = Number(name.split(/[\\/]/).pop()!.slice(0, -5))
    if (record.v !== 1 || record.pid !== pid || pid === process.pid || !pidAlive(pid)
      || !['daemon', 'studio-embedded'].includes(record.kind) || !/^[0-9a-f]{16}$/.test(record.runtimeId)
      || typeof record.startedAt !== 'number' || typeof record.settingsPath !== 'string'
      || typeof record.hostname !== 'string' || !['daemon', 'embedded'].includes(record.mode)) return undefined
    return { pid, digest: createHash('sha256').update(bytes).digest('hex') }
  } catch { return undefined }
}

function fingerprintTree(path: string, leaseRegistry: boolean, limit = 5000): Map<string, TreeEntry> {
  const out = new Map<string, TreeEntry>()
  const walk = (dir: string): void => {
    let entries: string[]
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries.sort()) {
      if (out.size >= limit) throw new Error(`parity harness: real-state fingerprint exceeds ${limit} entries: ${path}`)
      const p = join(dir, name)
      let s
      try { s = lstatSync(p) } catch { continue }
      const key = relative(path, p)
      out.set(key, {
        stamp: `${s.size}:${s.mtimeMs}`,
        identity: `${s.dev}:${s.ino}:${s.mode}:${s.uid}:${s.gid}:${s.nlink}:${s.size}`,
        mtimeMs: s.mtimeMs,
        ...(leaseRegistry && s.isFile() ? { heartbeat: hostHeartbeat(p, key) } : {}),
      })
      if (s.isDirectory()) walk(p)
    }
  }
  try {
    const root = lstatSync(path)
    out.set('', { stamp: `${root.size}:${root.mtimeMs}`, identity: `${root.dev}:${root.ino}:${root.mode}:${root.uid}:${root.gid}:${root.nlink}:${root.size}`, mtimeMs: root.mtimeMs })
  } catch { /* absent */ }
  walk(path)
  return out
}

function sameTree(before: Map<string, TreeEntry>, after: Map<string, TreeEntry>, startedAt: number): boolean {
  if (before.size !== after.size) return false
  for (const [name, old] of before) {
    const current = after.get(name)
    if (!current) return false
    if (old.stamp === current.stamp && old.identity === current.identity
      && (!old.heartbeat || old.heartbeat.digest === current.heartbeat?.digest)) continue
    // compute-users only utimes an existing host record. Preserve every other
    // fingerprint check: contents, identity, membership and PID liveness.
    if (!old.heartbeat || !current.heartbeat || old.heartbeat.pid !== current.heartbeat.pid
      || old.heartbeat.digest !== current.heartbeat.digest || old.identity !== current.identity
      || current.mtimeMs < old.mtimeMs || current.mtimeMs < startedAt
      || current.mtimeMs > Date.now() + 1000 || !pidAlive(old.heartbeat.pid)) return false
  }
  return true
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

/**
 * Where run roots are made: os.tmpdir() on Windows, /var/tmp on macOS and
 * Linux. Studio and the daemon refuse an agents folder setting under `/tmp`
 * (a temp location; Linux's os.tmpdir()), and macOS's os.tmpdir() is so long
 * that `<root>/leases/hosts/<runtimeId>.sock` passes the socket path limit
 * and the lease endpoint moves out of the root.
 */
function rootParent(): string {
  if (process.platform !== 'win32') {
    try {
      if (statSync('/var/tmp').isDirectory()) return '/var/tmp'
    } catch { /* no /var/tmp */ }
  }
  return tmpdir()
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

export async function createParityEnv(label: string, options: { realState?: { files: string[]; trees: string[] } } = {}): Promise<ActiveParityEnv> {
  const startedAt = Date.now()
  const real = options.realState ?? realStatePaths()
  const realFingerprints = new Map(real.files.map(p => [p, fingerprintFile(p)]))
  const isLeaseRegistry = (p: string): boolean => /[\\/]adf[\\/]leases$/.test(p)
  const realTrees = new Map(real.trees.map(p => [p, fingerprintTree(p, isLeaseRegistry(p))]))
  const rawRoot = mkdtempSync(join(rootParent(), `adf-parity-${label}-`))
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
  writeFileSync(violationsLog, '', { flag: 'wx', mode: 0o600 })

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
    // The lease records' machine id, without reg.exe / ioreg: on a loaded
    // runner the lookup took seconds and a record was written without it, or
    // after the snapshot (CI run 38749217035). Unit-tested in
    // tests/runtime/agent-lease-machine-id.test.ts.
    ADF_MACHINE_ID: randomUUID(),
    // ADF_MACHINE_ID is a test seam (runtime/agent-lease.ts): honoured only with it.
    ADF_TEST_SEAMS: '1',
    // The boot envelope sweep: `off` unless the scenario asks for `boot`
    // (ParityScenario.envelopeSweep). Embedded: backend.ts; the daemon child
    // reads it as a test seam (daemon/index.ts).
    ADF_TEST_ENVELOPE_SWEEP: 'off',
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
    PARITY_FENCE_WRITE_ROOTS: JSON.stringify([root]),
    // Every Node / Electron-as-Node child (and grandchild) loads the fence
    // first. NODE_OPTIONS unescapes backslashes inside quotes, so the path is
    // written with forward slashes (valid on every OS).
    NODE_OPTIONS: [`--require "${FENCE_PATH.replace(/\\/g, '/')}"`, saved.get('NODE_OPTIONS')].filter(Boolean).join(' '),
  }
  for (const [k, v] of Object.entries(set)) process.env[k] = v

  keyringTripwire?.restore()
  keyringTripwire = installKeyringTripwire()
  const tripwire = keyringTripwire
  const ports = [meshPort]
  const outsideDirectories: string[] = []
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
    try { text = readFileSync(violationsLog, 'utf-8') } catch {
      text = JSON.stringify({ kind: 'audit', detail: 'fence violation log is missing or unreadable', pid: process.pid })
    }
    const logged = text.split('\n').filter(Boolean)
    // Keep multiplicity while merging the in-process audit fallback. The
    // file also contains child/worker refusals absent from this instance.
    const counts = new Map<string, number>()
    for (const entry of logged) counts.set(entry, (counts.get(entry) ?? 0) + 1)
    for (const entry of fence.violations().map(value => JSON.stringify(value))) {
      const remaining = counts.get(entry) ?? 0
      if (remaining > 0) counts.set(entry, remaining - 1)
      else logged.push(entry)
    }
    return [...logged, ...tripwire.hits.map(h => `keychain addon requested: ${h}`)]
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
    createIsolatedDirectory(label: string): string {
      // Allocation is harness-owned; expose only a freshly minted directory.
      // The fence offers this primitive so arbitrary existing roots cannot be allowed.
      const p = fence.createIsolatedDirectory(label)
      outsideDirectories.push(p)
      process.env.PARITY_FENCE_WRITE_ROOTS = JSON.stringify([root, ...outsideDirectories])
      return p
    },
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
      const changed = [
        ...[...realFingerprints].filter(([p, before]) => fingerprintFile(p) !== before).map(([p]) => p),
        ...[...realTrees].filter(([p, before]) => !sameTree(before, fingerprintTree(p, isLeaseRegistry(p)), startedAt)).map(([p]) => p),
      ]
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
      for (const p of outsideDirectories) {
        const links = removeTreeWithoutLinks(p)
        if (links.length) throw new Error(`parity harness: refusing to delete ${p}; it contains links: ${links.join(', ')}`)
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
