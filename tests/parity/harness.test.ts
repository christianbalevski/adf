import { mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { embeddedBackend, srcPath, type ParityBackend } from './harness/backend'
import { createFakeElectron } from './harness/electron-fake'
import { createParityEnv, removeTreeWithoutLinks, writeSettingsFile } from './harness/env'
import { createComputeLog, createFakePodmanServiceClass } from './harness/fake-compute'
import { diffRendered, renderRecording } from './harness/format'
import { normalizeRecording, toGoldenForm, type NormalizationContext } from './harness/normalize'
import type { ComparableRecording } from './harness/recording'
import { runScenario, type ParityScenario } from './harness/scenario'

/**
 * Self-tests for the parity harness: isolation and fences, and that each
 * normalizer rule replaces what it should and nothing else.
 */

const WIN = process.platform === 'win32'
const ROOT = WIN ? 'C:\\Temp\\adf-parity-x-abc123' : '/tmp/adf-parity-x-abc123'
const SHORT = WIN ? 'C:\\Temp\\ADF-PA~1' : '/private/tmp/adf-parity-x-abc123'
const OWNER = 'did:key:z6MkOwnerOwnerOwnerOwnerOwnerOwnerOwner1'
const RUNTIME = 'did:key:z6MkRuntimeRuntimeRuntimeRuntimeRuntime1'
const FIXTURE_ID = '5f1d7a3e-2c4b-4e8a-9b6d-0a1b2c3d4e01'
const T0 = Date.parse('2026-10-14T10:00:00.000Z')

const ctx: NormalizationContext = {
  rootSpellings: [
    { spelling: ROOT, token: '<ROOT>' },
    { spelling: SHORT, token: '<ROOT:tmpdir-spelling>' },
    ...(WIN ? [{ spelling: ROOT.replace(/\\/g, '/'), token: '<ROOT:fwd>' }] : []),
  ],
  ports: [{ value: '51234', name: 'LLM_PORT' }],
  named: [{ value: OWNER, name: 'did:owner' }, { value: RUNTIME, name: 'did:runtime' }],
  fixtureIds: [FIXTURE_ID],
  window: { from: T0, to: T0 + 60_000 },
}

function rec(pushes: Record<string, unknown[]> = {}, steps: unknown[] = []): ComparableRecording {
  return { scenario: 's', steps: steps as ComparableRecording['steps'], pushes, timelines: {}, local: [], llm: [], state: { adf: {}, userDataJson: {}, tree: [] } }
}
function norm(value: unknown): unknown {
  return normalizeRecording(rec({ ch: [value] }), ctx).pushes.ch[0]
}

describe('parity harness: normalizer', () => {
  it('R1 gives each root spelling its own token, exact case only', () => {
    const sep = WIN ? '\\' : '/'
    expect(norm(`${ROOT}${sep}agents${sep}agent-1.adf`)).toBe(`<ROOT>${sep}agents${sep}agent-1.adf`)
    expect(norm(`${SHORT}${sep}a`)).toBe(`<ROOT:tmpdir-spelling>${sep}a`)
    if (WIN) {
      expect(norm(`file:///${ROOT.replace(/\\/g, '/')}/x.adf`)).toBe('file:///<ROOT:fwd>/x.adf')
      // A case change is not a known spelling: the raw (random) path stays visible.
      expect(norm(ROOT.toLowerCase())).toBe(ROOT.toLowerCase())
    }
    expect(norm('C:\\Temp\\other-dir\\agent-1.adf')).toBe('C:\\Temp\\other-dir\\agent-1.adf')
  })

  it('R2 replaces run-time ports only after a loopback host', () => {
    expect(norm('http://127.0.0.1:51234/v1')).toBe('http://127.0.0.1:<LLM_PORT>/v1')
    expect(norm('size 51234 bytes')).toBe('size 51234 bytes')
    expect(norm({ port: 51234, count: 51234 })).toEqual({ port: '<LLM_PORT>', count: 51234 })
  })

  it('R3 names known DIDs by role; R4 numbers any other DID, so a foreign DID stays visible', () => {
    const other = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK'
    const third = 'did:key:z6MkThirdThirdThirdThirdThirdThird77'
    expect(norm([OWNER, RUNTIME, other, other, third])).toEqual(['<did:owner>', '<did:runtime>', '<did#1>', '<did#1>', '<did#2>'])
  })

  it('R5 numbers random UUIDs in sorted-key order and leaves fixture ids alone', () => {
    const a = '0d5e2f1c-7a6b-4c3d-8e9f-001122334455'
    const b = '1d5e2f1c-7a6b-4c3d-8e9f-001122334455'
    // Keys are visited sorted (alpha before beta) whatever their insertion order.
    expect(norm({ beta: a, alpha: b, gamma: [a, FIXTURE_ID] })).toEqual({ alpha: '<uuid#1>', beta: '<uuid#2>', gamma: ['<uuid#2>', FIXTURE_ID] })
  })

  it('R8 replaces in-window instants only, in every form', () => {
    expect(norm({ timestamp: T0 + 5, size: 1067, seq: 3, before: T0 - 1, big: 9_999_999_999_999 }))
      .toEqual({ timestamp: '<t>', size: 1067, seq: 3, before: T0 - 1, big: 9_999_999_999_999 })
    expect(norm('at 2026-10-14T10:00:01.123Z')).toBe('at <t>')
    expect(norm('[2026-10-14 10:00:02 UTC] hi')).toBe('[<t>] hi')
    expect(norm(`session-${T0 + 9}`)).toBe('session-<t>')
    expect(norm('issued 2025-01-01T00:00:00.000Z')).toBe('issued 2025-01-01T00:00:00.000Z')
    expect(norm('order 1234567890123')).toBe('order 1234567890123')
  })

  it('R9 marks a push stamped before an earlier push of the same channel', () => {
    const out = normalizeRecording(rec({ ev: [{ timestamp: T0 + 10 }, { timestamp: T0 + 10 }, { timestamp: T0 + 5 }, { timestamp: T0 + 20 }] }), ctx)
    expect(out.pushes.ev).toEqual([{ timestamp: '<t>' }, { timestamp: '<t>' }, { timestamp: '<t:earlier>' }, { timestamp: '<t>' }])
  })

  it('keeps undefined-valued properties, null, error text, counts and order', () => {
    expect(norm({ a: undefined, b: null, error: 'Provider "x" not found', list: [3, 1, 2] }))
      .toEqual({ a: undefined, b: null, error: 'Provider "x" not found', list: [3, 1, 2] })
    expect(renderRecording(rec({ ch: [{ a: undefined }] }))).toContain('a: undefined')
  })

  it('throws on non-plain values instead of rendering them as {}', () => {
    expect(() => norm(new Map([['a', 1]]))).toThrow(/non-plain value \(\[object Map\]\) at pushes\.ch\[0\]/)
    expect(() => norm({ when: new Date(T0) })).toThrow(/\[object Date\]/)
    expect(() => norm(Buffer.from('x'))).toThrow(/non-plain/)
  })

  it('G1 (golden form only) turns separators under <ROOT> into / and <ROOT:fwd> into <ROOT>', () => {
    const r = rec({ ch: ['<ROOT>\\agents\\a.adf', '<ROOT:fwd>/b', 'C:\\x\\y'] })
    expect(toGoldenForm(r).pushes.ch).toEqual(['<ROOT>/agents/a.adf', '<ROOT>/b', 'C:\\x\\y'])
  })
})

describe('parity harness: rendering and diff', () => {
  it('renders multi-line strings as blocks and diffs line by line', () => {
    const base = rec({ ev: [{ type: 'a' }, { type: 'b' }] }, [
      { kind: 'invoke', channel: 'c', args: [], result: { text: 'one\ntwo\nthree' }, pushes: { before: 0, after: 1 } },
    ])
    const changed = { ...base, pushes: { ev: [{ type: 'a' }, { type: 'x' }, { type: 'b' }] } }
    const a = renderRecording(base)
    expect(a).toContain('1. invoke c  [pushes 0→1]')
    expect(a).toContain('text: |\n      one\n      two\n      three')
    const diff = diffRendered(a, renderRecording(changed))
    expect(diff).toContain('+ ## push ev (3)')
    expect(diff).toContain('+   type: "x"')
    expect(diffRendered(a, a)).toBe('')
  })
})

describe('parity harness: isolation', () => {
  it('points every per-user location at the run root, drops inherited ADF_* and restores the env', async () => {
    process.env.ADF_DAEMON_URL = 'http://127.0.0.1:7385'
    const before = { ...process.env }
    const env = await createParityEnv('selftest')
    try {
      for (const key of ['ADF_USER_DATA_DIR', 'ADF_LEASE_DIR', 'HOME', 'USERPROFILE', 'APPDATA', 'TEMP']) {
        expect(process.env[key]?.startsWith(env.root), key).toBe(true)
      }
      expect(process.env.ADF_DAEMON_URL).toBeUndefined()
      expect(Object.keys(process.env).filter((k) => k.startsWith('ADF_')).sort())
        .toEqual(['ADF_KEYCHAIN', 'ADF_LEASE_DIR', 'ADF_SECRET_STORE', 'ADF_TEMP_DIR', 'ADF_USER_DATA_DIR'])
      expect(process.env.ADF_SECRET_STORE).toBe('file')
      expect(process.env.ADF_KEYCHAIN).toBe('0')
      expect(env.appPath('userData')).toBe(env.userDataDir)
      expect(() => env.appPath('exe')).toThrow(/not mapped/)
    } finally {
      env.dispose()
    }
    for (const key of ['ADF_USER_DATA_DIR', 'ADF_DAEMON_URL', 'HOME', 'USERPROFILE', 'APPDATA', 'TEMP', 'ADF_KEYCHAIN']) {
      expect(process.env[key], key).toBe(before[key])
    }
    delete process.env.ADF_DAEMON_URL
  })

  it('refuses to load the OS keychain addon during a run', async () => {
    const env = await createParityEnv('selftest')
    try {
      const req = createRequire(join(tmpdir(), 'x.js'))
      expect(() => req('@napi-rs/keyring')).toThrow(/keychain access is forbidden/)
      expect(() => env.assertRealStateUntouched()).toThrow(/keychain addon requested/)
    } finally {
      env.dispose()
    }
  })

  it('refuses to delete a run root that contains a link, and deletes one that does not', () => {
    const base = join(tmpdir(), `adf-parity-linktest-${process.pid}`)
    const target = join(base, 'target')
    const victim = join(target, 'keep.txt')
    const root = join(base, 'root')
    mkdirSync(target, { recursive: true })
    mkdirSync(root, { recursive: true })
    writeFileSync(victim, 'keep')
    symlinkSync(target, join(root, 'link'), 'junction')
    expect(removeTreeWithoutLinks(root)).toEqual([join(root, 'link')])
    expect(readFileSync(victim, 'utf-8')).toBe('keep')
    // Unlink the link itself, then the tree goes.
    unlinkSync(join(root, 'link'))
    expect(removeTreeWithoutLinks(root)).toEqual([])
    expect(removeTreeWithoutLinks(base)).toEqual([])
  })

  it('electron fake records pushes with seq and time, notifications and menus, and misses', async () => {
    const env = await createParityEnv('selftest')
    try {
      const electron = createFakeElectron(env)
      const m = electron.module as Record<string, any>
      expect(m.BrowserWindow.getAllWindows()).toHaveLength(0)
      electron.openWindow()
      const payload = { n: 1 }
      m.BrowserWindow.getAllWindows()[0].webContents.send('ch', payload)
      payload.n = 2
      expect(electron.pushes).toMatchObject([{ seq: 1, channel: 'ch', args: [{ n: 1 }] }])
      expect(m.Notification.isSupported()).toBe(true)
      new m.Notification({ title: 'T', body: 'B' }).show()
      m.Menu.setApplicationMenu(m.Menu.buildFromTemplate([{ label: 'File', click: () => {}, submenu: [{ label: 'Open' }] }]))
      expect(electron.localCalls.map((c) => c.api)).toEqual(['Notification.new', 'Notification.show', 'Menu.setApplicationMenu'])
      expect(electron.localCalls[2].args[0]).toEqual([{ label: 'File', submenu: [{ label: 'Open' }] }])
      expect(() => m.app.requestSingleInstanceLock).toThrow(/no app.requestSingleInstanceLock/)
      expect(() => m.webFrameMain).toThrow(/no electron.webFrameMain/)
      expect(electron.missing).toEqual(['app.requestSingleInstanceLock', 'electron.webFrameMain'])
      electron.closeWindow()
      expect(m.BrowserWindow.getAllWindows()).toHaveLength(0)
    } finally {
      env.dispose()
    }
  })
})

describe('parity harness: fences', () => {
  it('fake PodmanService answers as a Podman-less machine and records calls', async () => {
    const log = createComputeLog()
    const Fake = createFakePodmanServiceClass(log)
    const svc = new Fake() as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
    await svc.stopAll()
    expect(await svc.findPodman()).toBeNull()
    await expect(svc.ensureRunning()).rejects.toThrow(/Podman not found/)
    await expect(svc.someFutureMethod()).rejects.toThrow(/Podman not found/)
    expect(log.calls).toEqual(['stopAll', 'findPodman', 'ensureRunning', 'someFutureMethod (unsupported)'])
  })

  it('refuses podman/wsl in argv, shell lines and wrappers, through ESM and require, and logs it', async () => {
    const env = await createParityEnv('selftest')
    try {
      const esm = await import('node:child_process')
      const cjs = createRequire(join(tmpdir(), 'x.js'))('child_process') as typeof esm
      expect(() => esm.spawn('podman', ['ps'])).toThrow(/parity fence: refused spawn/)
      expect(() => cjs.execFile(String.raw`C:\Program Files\RedHat\Podman\podman.exe`, ['stop', 'adf-mcp'])).toThrow(/refused/)
      expect(() => esm.exec(String.raw`"C:\Program Files\RedHat\Podman\podman.exe" stop adf-mcp`)).toThrow(/refused/)
      expect(() => esm.spawn('cmd', ['/c', 'podman stop adf-mcp'])).toThrow(/refused/)
      expect(() => esm.spawn('sh', ['-c', 'cd /x && podman ps'])).toThrow(/refused/)
      expect(() => esm.spawn('echo podman.exe', [], { shell: true })).toThrow(/refused/)
      expect(() => esm.execSync('wsl -l')).toThrow(/refused/)
      expect(env.violations()).toHaveLength(7)
      const { promisify } = await import('node:util')
      const { stdout } = await promisify(esm.execFile)(process.execPath, ['-e', 'process.stdout.write("ok")'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
      expect(stdout).toBe('ok')
      expect(() => env.assertRealStateUntouched()).toThrow(/fence violation/)
    } finally {
      env.dispose()
    }
  })

  it('allows only the run\'s own loopback ports, never 7385, never a remote host', async () => {
    const server = createServer((s) => s.end())
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    const env = await createParityEnv('selftest')
    try {
      expect(() => connect(port, '127.0.0.1')).toThrow(/refused net/)
      env.allowPort(port)
      const ok = connect(port, '127.0.0.1')
      await new Promise((r) => ok.once('close', r))
      expect(() => connect(7385, '127.0.0.1')).toThrow(/refused net: 127.0.0.1:7385/)
      env.allowPort(7385)
      expect(() => connect(7385, '127.0.0.1')).toThrow(/refused net/)
      await expect(fetch('https://example.com/')).rejects.toThrow(/refused fetch: example.com:443/)
      const http = await import('node:http')
      expect(() => http.get('http://10.0.0.1:80/')).toThrow(/refused http: 10.0.0.1:80/)
      expect(env.violations().length).toBe(5)
    } finally {
      env.dispose()
      server.close()
    }
  })

  it('embedded boot and shutdown reach only the fake compute service', async () => {
    const env = await createParityEnv('selftest')
    try {
      writeSettingsFile(env, { meshEnabled: false, updateChecksEnabled: false, remoteCatalogsEnabled: false, providerChecksEnabled: false, menuBarEnabled: false })
      const electron = createFakeElectron(env)
      const booted = await embeddedBackend.boot(env, electron)
      const mod = await import(/* @vite-ignore */ srcPath('main/services/podman.service.ts')) as { PodmanService: new () => { getStatus(): { status: string } } }
      expect(new mod.PodmanService().getStatus().status).toBe('not_installed')
      await booted.shutdown()
      expect(booted.computeCalls()).toContain('stopAll')
      expect(booted.leaks()).toEqual([])
      env.assertRealStateUntouched()
    } finally {
      env.dispose()
    }
  }, 60_000)
})

describe('parity harness: runner', () => {
  // A minimal backend: one handler that answers and pushes once, 50 ms later;
  // shutdown pushes a goodbye while the window is still open.
  const toyBackend = (): ParityBackend => ({
    name: 'toy',
    async boot(_env, electron) {
      const ipcMain = electron.module.ipcMain as { handle(c: string, f: (...a: unknown[]) => unknown): void }
      const BrowserWindow = electron.module.BrowserWindow as { getAllWindows(): { webContents: { send(c: string, p: unknown): void } }[] }
      const send = (c: string, p: unknown) => BrowserWindow.getAllWindows()[0]?.webContents.send(c, p)
      ipcMain.handle('toy:ping', () => {
        setTimeout(() => send('toy:late', { n: 1 }), 50)
        return 'pong'
      })
      electron.openWindow()
      return {
        async shutdown() { send('toy:bye', { n: 2 }) },
        leaks: () => [],
        computeCalls: () => [],
      }
    },
  })

  it('records teardown pushes and the push watermarks of each step', async () => {
    const scenario: ParityScenario = {
      name: 'toy', description: 'toy', fixtures: [], quietMs: 200,
      async run(ctx) {
        await ctx.invoke('toy:ping')
        await ctx.waitForPush('toy:late', 'late push', () => true)
      },
    }
    const { normalized, text } = await runScenario(scenario, toyBackend())
    expect(normalized.pushes).toEqual({ 'toy:bye': [{ n: 2 }], 'toy:late': [{ n: 1 }] })
    expect(text).toContain('1. invoke toy:ping  [pushes 0→0]')
    expect(text).toContain('3. shutdown  [pushes 1→2]')
    expect(normalized.timelines.app).toEqual(['> 1 toy:ping', '< 1', '  toy:late', '> 3 shutdown', '  toy:bye', '< 3'])
  })

  it('fails a scenario that is declared done while the backend still pushes', async () => {
    const scenario: ParityScenario = {
      name: 'toy', description: 'toy', fixtures: [], quietMs: 300,
      async run(ctx) { await ctx.invoke('toy:ping') },
    }
    await expect(runScenario(scenario, toyBackend())).rejects.toThrow(/was done but the backend kept going[\s\S]*toy:late/)
  })
})
