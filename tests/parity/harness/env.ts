import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Module from 'node:module'

/**
 * One isolated machine for one scenario run.
 *
 * Every directory a backend may read or write lives under `root`: user data
 * (settings, templates, subscription tokens), the lease registry, temp, the
 * OS home and app-data directories, and the agents folder. The process env
 * points there for the duration of the run and is restored afterwards.
 *
 * Secrets: `ADF_KEYCHAIN=0` makes every OS-keychain opener in Studio code
 * return null, `ADF_SECRET_STORE=file` forces the daemon's passphrase-file
 * backend, and a module-load tripwire fails the run if `@napi-rs/keyring` is
 * loaded anyway. The real settings files are fingerprinted before the run and
 * checked after it (`assertRealStateUntouched`).
 */
export interface ParityEnv {
  /** Canonical (realpath) root of everything this run touches. */
  readonly root: string
  /** The same root as `os.tmpdir()` spells it (8.3 short names on Windows). */
  readonly rootAliases: readonly string[]
  readonly userDataDir: string
  readonly leaseDir: string
  readonly tempDir: string
  readonly homeDir: string
  /** Where fixture agents live (also the `agentsFolder` and a tracked directory when a scenario asks). */
  readonly agentsDir: string
  /** Free loopback port handed to the mesh server through MESH_PORT. */
  readonly meshPort: number
  /** Electron `app.getPath(name)` for this run. */
  appPath(name: string): string
  /** Paths of real settings files that must not change; filled by `createParityEnv`. */
  readonly realStateFingerprints: ReadonlyMap<string, string>
}

const ENV_KEYS = [
  'ADF_USER_DATA_DIR',
  'ADF_LEASE_DIR',
  'ADF_TEMP_DIR',
  'ADF_SECRET_STORE',
  'ADF_KEYCHAIN',
  'ADF_PERF_LOG',
  'MESH_PORT',
  'MESH_HOST',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
] as const

/** Real per-user settings files a run must never touch (fingerprinted, not read). */
function realStateCandidates(): string[] {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const appData = process.env.APPDATA || (home ? join(home, 'AppData', 'Roaming') : '')
  const bases = [
    appData,
    home ? join(home, 'Library', 'Application Support') : '',
    process.env.XDG_CONFIG_HOME || (home ? join(home, '.config') : ''),
  ].filter(Boolean)
  const files: string[] = []
  for (const base of bases) {
    for (const dir of ['ADF Studio', 'adf-studio']) files.push(join(base, dir, 'adf-settings.json'))
  }
  return files
}

function fingerprint(path: string): string {
  try {
    const s = statSync(path)
    return `${s.size}:${s.mtimeMs}`
  } catch {
    return 'absent'
  }
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

/** Fail loudly instead of touching the OS keychain: any load of the keyring addon is recorded. */
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

export interface ActiveParityEnv extends ParityEnv {
  /** Restore process.env, remove the tripwire and delete `root`. */
  dispose(): void
  /** Throws if a real settings file changed or the keychain addon was requested. */
  assertRealStateUntouched(): void
}

export async function createParityEnv(label: string): Promise<ActiveParityEnv> {
  const realStateFingerprints = new Map(realStateCandidates().map((p) => [p, fingerprint(p)]))
  const rawRoot = mkdtempSync(join(tmpdir(), `adf-parity-${label}-`))
  const root = realpathSync.native(rawRoot)
  const rootAliases = [...new Set([root, rawRoot, realpathSync(rawRoot)])]
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

  const saved = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]))
  const set: Record<(typeof ENV_KEYS)[number], string | undefined> = {
    ADF_USER_DATA_DIR: userDataDir,
    ADF_LEASE_DIR: leaseDir,
    ADF_TEMP_DIR: tempDir,
    ADF_SECRET_STORE: 'file',
    ADF_KEYCHAIN: '0',
    ADF_PERF_LOG: undefined,
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
  }
  for (const [k, v] of Object.entries(set)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  keyringTripwire?.restore()
  keyringTripwire = installKeyringTripwire()
  const tripwire = keyringTripwire
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

  return {
    root,
    rootAliases,
    userDataDir,
    leaseDir,
    tempDir,
    homeDir,
    agentsDir,
    meshPort,
    realStateFingerprints,
    appPath(name: string): string {
      const p = appPaths[name]
      if (!p) throw new Error(`parity harness: app.getPath('${name}') is not mapped`)
      return p
    },
    assertRealStateUntouched(): void {
      for (const [path, before] of realStateFingerprints) {
        const after = fingerprint(path)
        if (after !== before) throw new Error(`parity harness: real settings file changed during the run: ${path}`)
      }
      if (tripwire.hits.length > 0) {
        throw new Error(`parity harness: OS keychain addon was requested: ${tripwire.hits.join(', ')}`)
      }
    },
    dispose(): void {
      for (const listener of process.listeners('exit')) {
        if (!exitListenersBefore.has(listener)) process.removeListener('exit', listener)
      }
      tripwire.restore()
      if (keyringTripwire === tripwire) keyringTripwire = null
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      // SQLite handles leaked by a failed run can hold files open on Windows;
      // a leftover temp dir is better than a failing teardown.
      try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* best effort */ }
    },
  }
}

/** Write the run's settings file before any backend boots. */
export function writeSettingsFile(env: ParityEnv, settings: Record<string, unknown>): string {
  const path = join(env.userDataDir, 'adf-settings.json')
  writeFileSync(path, JSON.stringify(settings, null, 2))
  return path
}
