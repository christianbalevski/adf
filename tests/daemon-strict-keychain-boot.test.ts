/**
 * ADF_SECRET_STORE=keychain at the daemon's real entry point
 * (src/main/daemon/index.ts under Node + tsx, as `npm run daemon` runs it):
 * a store it cannot honour ends the process with exit code 1 before it
 * listens, and the fallback passphrase file next to the settings keeps its
 * bytes. A throw alone would reach index.ts's log-only uncaughtException
 * handler, which exits 0.
 *
 * Isolated state per run (temp settings, home, temp dir, token, ports).
 * The parity fence is not used: it refuses the esbuild service tsx spawns
 * for its first transform. The conflict, unknown-value and control runs set
 * ADF_KEYCHAIN=0 (no keyring load); the control run is killed at its owner
 * identity line, before it listens. The Linux run loads the real
 * @napi-rs/keyring against a session bus address that points at a missing
 * socket in the run's root, so its one read reaches no Secret Service on
 * this machine.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { FileSecretBackend, OWNER_MNEMONIC_ACCOUNT } from '../src/main/services/owner-secret-store'
import { generateMnemonic } from '../src/main/crypto/mnemonic-identity'

const REPO = resolve(__dirname, '..')
const ENTRY = resolve(REPO, 'src/main/daemon/index.ts')
const PASSPHRASE = 'fallback file passphrase 0123'
const children: ChildProcess[] = []
const roots: string[] = []

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.pid !== undefined) try { process.kill(-child.pid, 'SIGKILL') } catch { /* gone */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer()
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => done(typeof address === 'object' && address ? address.port : 0))
    })
  })
}

interface Run { code: number | null; output: string; fallbackBytes: Buffer; secretFile: string }

/**
 * Start the daemon with `vars` and wait until it exits or prints `until`
 * (then it is killed: code null). A fallback file sealed with the
 * ADF_OWNER_PASSPHRASE the daemon gets is put next to the settings first.
 */
async function runDaemon(vars: Record<string, string> | ((root: string) => Record<string, string>), opts: { until?: RegExp } = {}): Promise<Run & { mnemonic: string }> {
  const root = mkdtempSync(join(tmpdir(), 'adf-strict-keychain-boot-'))
  roots.push(root)
  const userData = join(root, 'user-data')
  const home = join(root, 'home')
  const temp = join(root, 'temp')
  for (const d of [userData, home, temp]) mkdirSync(d, { recursive: true })
  const settingsFile = join(userData, 'adf-settings.json')
  writeFileSync(settingsFile, JSON.stringify({ meshEnabled: false, updateChecksEnabled: false, remoteCatalogsEnabled: false, providerChecksEnabled: false }))
  const secretFile = join(userData, 'owner-secrets.json')
  const mnemonic = generateMnemonic()
  const file = new FileSecretBackend(secretFile)
  file.unlock(PASSPHRASE)
  file.set(OWNER_MNEMONIC_ACCOUNT, mnemonic)
  file.lock()
  const fallbackBytes = readFileSync(secretFile)
  const port = await freePort()
  const meshPort = await freePort()
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    TMPDIR: temp,
    TEMP: temp,
    TMP: temp,
    ADF_USER_DATA_DIR: userData,
    ADF_DAEMON_SETTINGS: settingsFile,
    ADF_DAEMON_PORT: String(port),
    ADF_DAEMON_HOST: '127.0.0.1',
    ADF_DAEMON_TOKEN: randomBytes(32).toString('base64url'),
    ADF_LEASE_DIR: join(root, 'leases'),
    ADF_TEST_SEAMS: '1',
    ADF_COMPUTE: 'fake',
    ADF_OWNER_PASSPHRASE: PASSPHRASE,
    MESH_PORT: String(meshPort),
    MESH_HOST: '127.0.0.1',
    ...(typeof vars === 'function' ? vars(root) : vars),
  }
  const args = ['--import', 'tsx', ENTRY]
  const child = spawn(process.execPath, args, { env, cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  children.push(child)
  let output = ''
  const code = await new Promise<number | null>((done) => {
    const timer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL') } catch { /* gone */ } done(null) }, 45_000)
    const onData = (chunk: Buffer) => {
      output += chunk.toString()
      if (opts.until && opts.until.test(output)) { clearTimeout(timer); try { process.kill(-child.pid!, 'SIGKILL') } catch { /* gone */ } done(null) }
    }
    child.stdout!.on('data', onData)
    child.stderr!.on('data', onData)
    child.once('exit', (c) => { clearTimeout(timer); done(c) })
  })
  return { code, output, fallbackBytes, secretFile, mnemonic }
}

function expectRefusedStart(run: Run & { mnemonic: string }, message: string): void {
  expect(run.code, run.output).toBe(1)
  expect(run.output).toContain(`[ADF Daemon] Owner secret store: ${message}`)
  expect(run.output).not.toContain('Listening on')
  expect(run.output).not.toContain('Owner identity:')
  expect(run.output).not.toContain('Uncaught exception')
  expect(readFileSync(run.secretFile).equals(run.fallbackBytes)).toBe(true)
  expect(existsSync(`${run.secretFile}.tmp`)).toBe(false)
  expect(run.output).not.toContain(PASSPHRASE)
  expect(run.output).not.toContain(run.mnemonic)
}

describe('daemon start with ADF_SECRET_STORE=keychain', () => {
  it('ADF_KEYCHAIN=0 conflicts: exit code 1 before listening, fallback file untouched', async () => {
    const run = await runDaemon({ ADF_SECRET_STORE: 'keychain', ADF_KEYCHAIN: '0' })
    expectRefusedStart(run, 'ADF_SECRET_STORE=keychain conflicts with ADF_KEYCHAIN=0')
  }, 60_000)

  it('an unknown ADF_SECRET_STORE value: exit code 1, the value not printed', async () => {
    const run = await runDaemon({ ADF_SECRET_STORE: 'keychain-please', ADF_KEYCHAIN: '0' })
    expectRefusedStart(run, 'ADF_SECRET_STORE has an unsupported value')
    expect(run.output).not.toContain('keychain-please')
  }, 60_000)

  it('control: the same run without ADF_SECRET_STORE starts on the passphrase file and unlocks it', async () => {
    const run = await runDaemon({ ADF_KEYCHAIN: '0' }, { until: /Owner identity: .*\n/ })
    expect(run.output).toMatch(/Owner identity: ready \(did:[^)]+\), file storage/)
    expect(run.output).not.toContain('Owner secret store:')
  }, 60_000)

  it.skipIf(process.platform !== 'linux')('Linux with no Secret Service (real keyring binding, no session bus): exit code 1, fallback file untouched', async () => {
    const run = await runDaemon((root) => ({ ADF_SECRET_STORE: 'keychain', DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(root, 'no-session-bus')}` }))
    expectRefusedStart(run, 'ADF_SECRET_STORE=keychain, but the OS keychain could not be read (')
    expect(run.output).not.toContain('after 3 tries')
  }, 60_000)
})
