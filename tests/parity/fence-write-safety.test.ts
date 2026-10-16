import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, parse } from 'node:path'
import { createRequire } from 'node:module'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { createParityEnv, parityDaemonLogDir, type ActiveParityEnv } from './harness/env'

const req = createRequire(import.meta.url)
// Load and initialize the native binding before installing a fence. Cached
// constructors must have the same protection as newly imported ones.
new Database(':memory:').close()

function outsideState() {
  const root = mkdtempSync(join(tmpdir(), 'adf-fence-state-'))
  const leases = join(root, 'adf', 'leases')
  const hosts = join(leases, 'hosts')
  mkdirSync(hosts, { recursive: true })
  const settings = join(root, 'settings.json')
  writeFileSync(settings, '{"keep":true}')
  return { root, leases, hosts, settings, realState: { files: [settings], trees: [leases] } }
}

async function independentWriter(): Promise<{ child: ChildProcessWithoutNullStreams; change(command: object): Promise<void>; close(): Promise<void> }> {
  const child = spawn(process.execPath, ['-e', `
    const fs = require('node:fs');
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const c = JSON.parse(line);
      if (c.kind === 'touch') { const now = new Date(); fs.utimesSync(c.path, now, now); }
      if (c.kind === 'write') fs.writeFileSync(c.path, c.text);
      if (c.kind === 'delete') fs.unlinkSync(c.path);
      if (c.kind === 'mkdir') fs.mkdirSync(c.path);
      if (c.kind === 'link') fs.symlinkSync(c.source, c.path, 'junction');
      console.log('done');
    });
    console.log('ready');
  `], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'pipe', windowsHide: true })
  const next = () => new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('error', reject) })
  await next()
  return {
    child,
    async change(command) { const done = next(); child.stdin.write(`${JSON.stringify(command)}\n`); await done },
    async close() { const done = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill('SIGKILL'); await done },
  }
}

function hostRecord(pid: number) {
  return { v: 1, kind: 'daemon', mode: 'daemon', pid, runtimeId: '0123456789abcdef', hostname: 'test-host', settingsPath: '/isolated/settings.json', startedAt: 1, endpoint: null, version: 'test', containers: [] }
}

async function guarded(label: string, run: (env: ActiveParityEnv, state: ReturnType<typeof outsideState>) => Promise<void>) {
  const state = outsideState()
  const env = await createParityEnv(label, { realState: state.realState })
  try { await run(env, state) } finally { env.dispose(); rmSync(state.root, { recursive: true, force: true }) }
}

describe('parity causal filesystem fence', () => {
  it('blocks synchronous, promise, stream, fd, rename and link writes outside its isolated roots', async () => {
    const state = outsideState()
    const descriptor = openSync(state.settings, 'r+')
    const env = await createParityEnv('write-apis', { realState: state.realState })
    try {
      const fs = req('node:fs') as typeof import('node:fs')
      expect(() => writeFileSync(state.settings, 'lost')).toThrow(/refused filesystem/)
      expect(() => appendFileSync(state.settings, 'lost')).toThrow(/refused filesystem/)
      await expect(fsPromises.writeFile(state.settings, 'lost')).rejects.toThrow(/refused filesystem/)
      expect(() => fs.createWriteStream(state.settings)).toThrow(/refused filesystem/)
      expect(() => fs.writeSync(descriptor, 'lost')).toThrow(/refused filesystem/)
      const source = join(env.root, 'source')
      writeFileSync(source, 'safe')
      expect(() => fs.renameSync(source, state.settings)).toThrow(/refused filesystem/)
      expect(() => fs.symlinkSync(state.root, join(env.root, 'escape'), 'junction')).toThrow(/refused filesystem/)
      expect(() => utimesSync(state.settings, new Date(), new Date())).toThrow(/refused filesystem/)
      expect(() => env.assertRealStateUntouched()).toThrow(/fence violation/)
      expect(readFileSync(state.settings, 'utf8')).toBe('{"keep":true}')
    } finally { env.dispose(); closeSync(descriptor); rmSync(state.root, { recursive: true, force: true }) }
  })

  it('refuses audit-log tampering while preserving caught refusal records', async () => {
    await guarded('audit-tamper', async (env, state) => {
      expect(() => writeFileSync(state.settings, 'lost')).toThrow(/refused filesystem/)
      expect(() => writeFileSync(env.violationsLog, '')).toThrow(/fence audit log is read-only/)
      const fs = req('node:fs') as typeof import('node:fs')
      expect(() => fs.unlinkSync(env.violationsLog)).toThrow(/fence audit log is read-only/)
      expect(() => fs.rmSync(env.root, { recursive: true, force: true })).toThrow(/fence audit log is read-only/)
      expect(env.violations()).toHaveLength(4)
      expect(readFileSync(env.violationsLog, 'utf8').trim().split('\n')).toHaveLength(4)
      expect(() => env.assertRealStateUntouched()).toThrow(/fence violation/)
    })
  })

  it('fails closed when its audit writer cannot persist a caught refusal', async () => {
    const state = outsideState()
    const writer = await independentWriter()
    const savedExitCode = process.exitCode
    const env = await createParityEnv('audit-failure', { realState: state.realState })
    try {
      await writer.change({ kind: 'delete', path: env.violationsLog })
      await writer.change({ kind: 'mkdir', path: env.violationsLog })
      expect(() => writeFileSync(state.settings, 'lost')).toThrow(/refused filesystem/)
      expect(() => env.assertRealStateUntouched()).toThrow(/log is missing or unreadable|log could not be written/)
      expect(env.violations().join('\n')).toMatch(/writeFileSync/)
      expect(process.exitCode).toBe(1)
    } finally {
      env.dispose()
      process.exitCode = savedExitCode
      await writer.close()
      rmSync(state.root, { recursive: true, force: true })
    }
  })

  it('copies a readonly source into isolated storage without permitting source mutations', async () => {
    await guarded('copy-source', async (env, state) => {
      const fs = req('node:fs') as typeof import('node:fs')
      const target = join(env.root, 'copy.json')
      fs.copyFileSync(state.settings, target)
      expect(readFileSync(target, 'utf8')).toBe('{"keep":true}')
      expect(() => env.assertRealStateUntouched()).not.toThrow()
      expect(() => fs.renameSync(state.settings, target)).toThrow(/refused filesystem/)
    })
  })

  it('checks a preexisting symlink escape and permits ordinary in-root FileHandle writes', async () => {
    const state = outsideState()
    const writer = await independentWriter()
    const env = await createParityEnv('symlink-write', { realState: state.realState })
    const alias = join(env.root, 'alias')
    // Use the control directory allocator only for isolated storage; it cannot
    // whitelist an existing real-state directory.
    const control = env.createIsolatedDirectory('control')
    const handle = await fsPromises.open(join(control, 'safe'), 'w+')
    try {
      await handle.writeFile('safe')
      await handle.sync()
      expect(readFileSync(join(control, 'safe'), 'utf8')).toBe('safe')
      // Simulate a preexisting alias without using any fenced write API.
      await writer.change({ kind: 'link', source: state.root, path: alias })
      expect(() => writeFileSync(join(alias, 'settings.json'), 'lost')).toThrow(/refused filesystem/)
      await writer.change({ kind: 'delete', path: alias })
      expect(() => env.assertRealStateUntouched()).toThrow(/fence violation/)
    } finally {
      await handle.close()
      if (existsSync(alias)) await writer.change({ kind: 'delete', path: alias })
      env.dispose()
      await writer.close()
      rmSync(state.root, { recursive: true, force: true })
    }
  })

  it('protects native SQLite cached constructors, backups and SQL file escapes', async () => {
    await guarded('sqlite-write', async (env, state) => {
      const outside = join(state.root, 'outside.adf')
      expect(() => new Database(outside)).toThrow(/refused filesystem: sqlite open/)
      const newlyRequired = req('better-sqlite3') as typeof Database
      expect(() => new newlyRequired(outside)).toThrow(/refused filesystem: sqlite open/)
      expect(existsSync(outside)).toBe(false)
      const db = new Database(join(env.agentsDir, 'agent-1.adf'))
      try {
        db.exec('CREATE TABLE safe (id INTEGER)')
        await expect(db.backup(outside)).rejects.toThrow(/refused filesystem: sqlite backup/)
        expect(() => db.exec(`ATTACH DATABASE '${outside}' AS escaped`)).toThrow(/SQL file access/)
        expect(() => db.exec(`VACUUM INTO '${outside}'`)).toThrow(/SQL file access/)
      } finally { db.close() }
      expect(() => env.assertRealStateUntouched()).toThrow(/fence violation/)
    })
  })

  it('refuses a native statement prepared before the fence on an outside database', async () => {
    const state = outsideState()
    const db = new Database(join(state.root, 'preopened.adf'))
    db.exec('CREATE TABLE protected (value TEXT)')
    const insert = db.prepare('INSERT INTO protected VALUES (?)')
    const env = await createParityEnv('cached-statement', { realState: state.realState })
    try {
      expect(() => insert.run('lost')).toThrow(/refused filesystem: sqlite statement run/)
      expect(() => env.assertRealStateUntouched()).toThrow(/fence violation/)
    } finally { env.dispose(); expect(db.prepare('SELECT * FROM protected').all()).toEqual([]); db.close(); rmSync(state.root, { recursive: true, force: true }) }
  })

  it('propagates write confinement to workers, clean-env children and grandchildren', async () => {
    await guarded('descendant-write', async (env, state) => {
      const code = `try { require('node:fs').writeFileSync(${JSON.stringify(state.settings)}, 'lost'); console.log('wrote') } catch (e) { console.log(e.message) }`
      const { execFileSync } = await import('node:child_process')
      const out = execFileSync(process.execPath, ['-e', code], { env: { ELECTRON_RUN_AS_NODE: '1', SystemRoot: process.env.SystemRoot ?? '' }, encoding: 'utf8', windowsHide: true })
      expect(out).toMatch(/refused filesystem/)
      const grandchild = `console.log(require('node:child_process').execFileSync(process.execPath, ['-e', ${JSON.stringify(code)}], { env: { ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' }))`
      expect(execFileSync(process.execPath, ['-e', grandchild], { env: { ELECTRON_RUN_AS_NODE: '1', SystemRoot: process.env.SystemRoot ?? '' }, encoding: 'utf8', windowsHide: true })).toMatch(/refused filesystem/)
      const workerCode = `try { require('node:fs').writeFileSync(${JSON.stringify(state.settings)}, 'lost'); require('node:worker_threads').parentPort.postMessage('wrote') } catch (e) { require('node:worker_threads').parentPort.postMessage(e.message) }`
      const { Worker: GuardedWorker } = await import('node:worker_threads')
      const worker = new GuardedWorker(workerCode, { eval: true, env: {}, execArgv: [] })
      try { expect(await new Promise(resolve => worker.once('message', resolve))).toMatch(/refused filesystem/) } finally { await worker.terminate() }
      expect(() => env.assertRealStateUntouched()).toThrow(/fence violation/)
      expect(readFileSync(state.settings, 'utf8')).toBe('{"keep":true}')
    })
  })

  it('installs the fence before inherited and explicit child/worker preloads', async () => {
    const state = outsideState()
    const preload = join(state.root, 'preload.cjs')
    writeFileSync(preload, `try { require('node:fs').writeFileSync(${JSON.stringify(state.settings)}, 'lost') } catch (e) { console.log(e.message) }`)
    // NODE_OPTIONS unescapes backslashes inside quotes: forward slashes (valid on every OS).
    const preloadOption = `--require "${preload.replace(/\\/g, '/')}"`
    const savedOptions = process.env.NODE_OPTIONS
    process.env.NODE_OPTIONS = preloadOption
    const env = await createParityEnv('preload-write', { realState: state.realState })
    try {
      const { execFileSync } = await import('node:child_process')
      expect(execFileSync(process.execPath, ['-e', 'console.log("ready")'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })).toMatch(/refused filesystem/)
      expect(execFileSync(process.execPath, ['-e', 'console.log("ready")'], { encoding: 'utf8', windowsHide: true, env: { ELECTRON_RUN_AS_NODE: '1', SystemRoot: process.env.SystemRoot ?? '', NODE_OPTIONS: preloadOption } })).toMatch(/refused filesystem/)
      const { Worker } = await import('node:worker_threads')
      const worker = new Worker(`require('node:worker_threads').parentPort.postMessage('ready')`, { eval: true, env: {}, execArgv: ['--require', preload] })
      try { expect(await new Promise(resolve => worker.once('message', resolve))).toBe('ready') } finally { await worker.terminate() }
      expect(readFileSync(state.settings, 'utf8')).toBe('{"keep":true}')
      expect(env.violations()).toHaveLength(3)
      expect(() => env.assertRealStateUntouched()).toThrow(/fence violation/)
    } finally {
      env.dispose()
      if (savedOptions === undefined) delete process.env.NODE_OPTIONS
      else process.env.NODE_OPTIONS = savedOptions
      rmSync(state.root, { recursive: true, force: true })
    }
  })

  it('lets the harness process alone write the PARITY_DAEMON_LOG_DIR copy', async () => {
    const state = outsideState()
    const logDir = join(state.root, 'parity-daemon-logs')
    const saved = process.env.PARITY_DAEMON_LOG_DIR
    process.env.PARITY_DAEMON_LOG_DIR = logDir
    const env = await createParityEnv('daemon-log-dir', { realState: state.realState })
    try {
      // daemon-backend.ts shutdown(): mkdir, then copy the run's daemon log.
      const source = join(env.root, 'adf-daemon.log')
      writeFileSync(source, 'log')
      mkdirSync(logDir, { recursive: true })
      const { copyFileSync } = req('node:fs') as typeof import('node:fs')
      copyFileSync(source, join(logDir, 'adf-daemon-1.log'))
      expect(readFileSync(join(logDir, 'adf-daemon-1.log'), 'utf8')).toBe('log')
      expect(env.violations()).toEqual([])
      // Only that directory: its parent stays refused.
      expect(() => writeFileSync(join(state.root, 'beside.log'), 'lost')).toThrow(/refused filesystem/)
      // And only this process: a fenced child may not write there.
      const { execFileSync } = await import('node:child_process')
      const script = `try { require('node:fs').writeFileSync(${JSON.stringify(join(logDir, 'child.log'))}, 'lost') } catch (e) { console.log(e.message) }`
      expect(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })).toMatch(/refused filesystem/)
      expect(existsSync(join(logDir, 'child.log'))).toBe(false)
      expect(env.violations()).toHaveLength(2)
    } finally {
      env.dispose()
      if (saved === undefined) delete process.env.PARITY_DAEMON_LOG_DIR
      else process.env.PARITY_DAEMON_LOG_DIR = saved
      rmSync(state.root, { recursive: true, force: true })
    }
  })

  it('accepts PARITY_DAEMON_LOG_DIR only as an absolute directory inside the OS temp dir or RUNNER_TEMP', () => {
    const home = homedir()
    const repo = join(__dirname, '..', '..')
    const runnerTemp = mkdtempSync(join(tmpdir(), 'adf-runner-temp-'))
    const check = (dir: string, extra: Record<string, string> = {}) => parityDaemonLogDir({ ...process.env, PARITY_DAEMON_LOG_DIR: dir, ...extra })
    try {
      expect(parityDaemonLogDir({ ...process.env, PARITY_DAEMON_LOG_DIR: '' })).toBeNull()
      expect(check(join(tmpdir(), 'parity-daemon-logs'))).toMatch(/parity-daemon-logs$/)
      expect(check(join(runnerTemp, 'parity-daemon-logs'), { RUNNER_TEMP: runnerTemp })).toMatch(/parity-daemon-logs$/)
      expect(() => check('parity-daemon-logs')).toThrow(/absolute/)
      expect(() => check(parse(tmpdir()).root)).toThrow(/filesystem root/)
      expect(() => check(home)).toThrow(/home directory/)
      expect(() => check(dirname(home))).toThrow(/home directory/)
      expect(() => check(repo)).toThrow(/repository/)
      expect(() => check(join(repo, 'logs'))).toThrow(/repository/)
      expect(() => check(join(home, 'parity-daemon-logs'))).toThrow(/OS temp dir or RUNNER_TEMP/)
      expect(() => check(tmpdir())).toThrow(/OS temp dir or RUNNER_TEMP/) // the temp dir itself, not inside it
    } finally { rmSync(runnerTemp, { recursive: true, force: true }) }
  })

  it('rejects shell/non-Node helpers which would otherwise write outside the Node fence', async () => {
    await guarded('shell-write', async (env, state) => {
      const { exec, spawn } = await import('node:child_process')
      expect(() => exec(`echo unsafe > ${state.settings}`)).toThrow(/unfenced executable/)
      expect(() => spawn('sh', ['-c', 'true'])).toThrow(/unfenced executable/)
      expect(() => env.assertRealStateUntouched()).toThrow(/fence violation/)
    })
  })
})

describe.runIf(process.platform === 'win32')('parity spawn fence: Windows production helpers', () => {
  const DOCUMENTS_KEY = ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', '/v', 'Personal']

  it('lets the daemon mint its local proof (icacls on a file inside the run root)', async () => {
    await guarded('icacls-proof', async (env) => {
      const { mintLocalProof, readLocalProof } = await import('../../src/main/daemon/local-access')
      const settingsDir = join(env.root, 'proof-settings')
      const minted = mintLocalProof(settingsDir, 41234)
      expect(readLocalProof(settingsDir, 41234)).toBe(minted.proof)
      expect(env.violations()).toEqual([])
    })
  })

  it('lets the Documents-folder lookup run reg with exactly its argv', async () => {
    await guarded('reg-documents', async (env) => {
      const { execFileSync } = await import('node:child_process')
      // The value may be missing on a runner; only the fence's verdict matters.
      try { execFileSync('reg', DOCUMENTS_KEY, { windowsHide: true, stdio: 'ignore' }) } catch (err) { expect(String(err)).not.toMatch(/parity fence/) }
      expect(env.violations()).toEqual([])
    })
  })

  it('allows them only when they resolve to the System32 binaries', async () => {
    await guarded('windows-helpers-resolution', async (env) => {
      const { execFileSync } = await import('node:child_process')
      const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
      // By absolute path: allowed.
      try { execFileSync(join(system32, 'reg.exe'), DOCUMENTS_KEY, { windowsHide: true, stdio: 'ignore' }) } catch (err) { expect(String(err)).not.toMatch(/parity fence/) }
      expect(env.violations()).toEqual([])
      // A planted reg.exe in the spawn's cwd, or in a PATH entry before System32: refused.
      const planted = join(env.root, 'planted')
      mkdirSync(planted)
      writeFileSync(join(planted, 'reg.exe'), '')
      expect(() => execFileSync('reg', DOCUMENTS_KEY, { cwd: planted, windowsHide: true, stdio: 'ignore' })).toThrow(/unfenced executable/)
      expect(() => execFileSync('reg.exe', DOCUMENTS_KEY, { cwd: planted, windowsHide: true, stdio: 'ignore' })).toThrow(/unfenced executable/)
      const pathFirst = { ...process.env, PATH: `${planted};${process.env.PATH ?? ''}` }
      delete (pathFirst as Record<string, string | undefined>).Path
      expect(() => execFileSync('reg', DOCUMENTS_KEY, { env: pathFirst, windowsHide: true, stdio: 'ignore' })).toThrow(/unfenced executable/)
      // Another absolute path: refused.
      expect(() => execFileSync(join(planted, 'reg.exe'), DOCUMENTS_KEY, { windowsHide: true, stdio: 'ignore' })).toThrow(/unfenced executable/)
      expect(env.violations()).toHaveLength(4)
    })
  })

  it('refuses every other icacls and reg shape', async () => {
    await guarded('windows-helpers-refused', async (env, state) => {
      const { execFile, execFileSync } = await import('node:child_process')
      const { userInfo } = await import('node:os')
      const user = process.env.USERDOMAIN && process.env.USERNAME ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : userInfo().username
      const inRoot = join(env.root, 'secret')
      writeFileSync(inRoot, '')
      const refused: Array<[string, string[]]> = [
        ['icacls', [state.settings, '/inheritance:r', '/grant:r', `${user}:F`]], // outside every write root
        ['icacls', [inRoot, '/inheritance:r', '/grant:r', 'Everyone:F']],
        ['icacls', [inRoot, '/reset']],
        ['icacls', [inRoot, '/inheritance:r', '/grant:r', `${user}:F`, '/T']],
        ['reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid']],
        ['reg', ['add', ...DOCUMENTS_KEY.slice(1), '/d', 'x']],
        ['reg', [...DOCUMENTS_KEY, '/s']],
      ]
      for (const [file, args] of refused) {
        expect(() => execFileSync(file, args, { windowsHide: true, stdio: 'ignore' })).toThrow(/unfenced executable/)
        expect(() => execFile(file, args, { windowsHide: true }, () => {})).toThrow(/unfenced executable/)
      }
      // Never through a shell.
      expect(() => execFileSync('reg', DOCUMENTS_KEY, { shell: true, windowsHide: true, stdio: 'ignore' })).toThrow(/unfenced executable/)
      expect(env.violations()).toHaveLength(refused.length * 2 + 1)
    })
  })
})

describe('parity live-host heartbeat fingerprints', () => {
  it('allows only an independent live host to touch unchanged host-record bytes', async () => {
    const state = outsideState()
    const writer = await independentWriter()
    const host = join(state.hosts, `${writer.child.pid}.json`)
    writeFileSync(host, JSON.stringify(hostRecord(writer.child.pid!)))
    const env = await createParityEnv('external-heartbeat', { realState: state.realState })
    try {
      await writer.change({ kind: 'touch', path: host })
      expect(() => env.assertRealStateUntouched()).not.toThrow()
      // An identical operation originating in the test is still a violation,
      // even though its exception is caught and the file bytes remain intact.
      expect(() => utimesSync(host, new Date(), new Date())).toThrow(/refused filesystem/)
      expect(() => env.assertRealStateUntouched()).toThrow(/fence violation/)
    } finally { env.dispose(); await writer.close(); rmSync(state.root, { recursive: true, force: true }) }
  })

  it.each(['content', 'dead-pid', 'new', 'deleted', 'nonhost', 'hardlink'] as const)('keeps the fingerprint failure for %s mutations', async change => {
    const state = outsideState()
    const writer = await independentWriter()
    const pid = change === 'dead-pid' ? 2_147_483_647 : writer.child.pid!
    const host = join(state.hosts, `${pid}.json`)
    writeFileSync(host, JSON.stringify(hostRecord(pid)))
    if (change === 'hardlink') linkSync(host, join(state.root, 'host-alias.json'))
    const env = await createParityEnv('unknown-mutation', { realState: state.realState })
    try {
      if (change === 'content') await writer.change({ kind: 'write', path: host, text: JSON.stringify({ ...hostRecord(pid), mode: 'embedded' }) })
      else if (change === 'new') await writer.change({ kind: 'write', path: join(state.hosts, '999.json'), text: '{}' })
      else if (change === 'deleted') await writer.change({ kind: 'delete', path: host })
      else await writer.change({ kind: 'touch', path: change === 'nonhost' ? state.settings : host })
      expect(() => env.assertRealStateUntouched()).toThrow(/real state changed/)
      expect(env.violations()).toEqual([])
    } finally { env.dispose(); await writer.close(); rmSync(state.root, { recursive: true, force: true }) }
  })
})
