import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { embeddedBackend, srcPath } from './harness/backend'
import { createFakeElectron } from './harness/electron-fake'
import { createParityEnv, writeSettingsFile } from './harness/env'
import { createComputeLog, createFakePodmanServiceClass, guardChildProcess } from './harness/fake-compute'
import { diffRendered, renderRecording } from './harness/format'
import { normalizeRecording, toGoldenForm, type NormalizationContext } from './harness/normalize'
import type { ComparableRecording } from './harness/recording'

/**
 * Self-tests for the parity harness: isolation, and that each normalizer
 * rule replaces what it should and nothing else.
 */

const ROOT = process.platform === 'win32' ? 'C:\\Temp\\adf-parity-x-abc123' : '/tmp/adf-parity-x-abc123'
const OWNER = 'did:key:z6MkOwnerOwnerOwnerOwnerOwnerOwnerOwner1'
const RUNTIME = 'did:key:z6MkRuntimeRuntimeRuntimeRuntimeRuntime1'
const FIXTURE_ID = '5f1d7a3e-2c4b-4e8a-9b6d-0a1b2c3d4e01'

const ctx: NormalizationContext = {
  roots: [ROOT],
  ports: [{ value: '51234', name: 'LLM_PORT' }],
  named: [{ value: OWNER, name: 'did:owner' }, { value: RUNTIME, name: 'did:runtime' }, { value: undefined, name: 'runtime-id' }],
  fixtureIds: [FIXTURE_ID],
}

function norm(value: unknown): unknown {
  const rec: ComparableRecording = { scenario: 's', steps: [], pushes: { ch: [value] }, local: [], llm: [] }
  return normalizeRecording(rec, ctx).pushes.ch[0]
}

describe('parity harness: normalizer', () => {
  it('R1 replaces the run root in every spelling and keeps the rest of the path', () => {
    const sep = process.platform === 'win32' ? '\\' : '/'
    expect(norm(`${ROOT}${sep}agents${sep}agent-1.adf`)).toBe(`<ROOT>${sep}agents${sep}agent-1.adf`)
    expect(norm(`file:///${ROOT.replace(/\\/g, '/')}/agents/x.adf`)).toBe('file:///<ROOT>/agents/x.adf')
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

  it('R5 numbers random UUIDs by first appearance and leaves fixture ids alone', () => {
    const a = '0d5e2f1c-7a6b-4c3d-8e9f-001122334455'
    const b = '1d5e2f1c-7a6b-4c3d-8e9f-001122334455'
    expect(norm([a, b, a, FIXTURE_ID])).toEqual(['<uuid#1>', '<uuid#2>', '<uuid#1>', FIXTURE_ID])
  })

  it('R6-R9 replace wall-clock values only', () => {
    expect(norm('at 2026-10-14T15:19:32.123Z')).toBe('at <iso>')
    expect(norm('[2026-10-14 15:19:32 UTC] hi')).toBe('[<utc-time>] hi')
    expect(norm('session-1791991172180')).toBe('session-<epoch-ms>')
    expect(norm('order 1234567890123')).toBe('order 1234567890123')
    expect(norm({ timestamp: 1791991172180, size: 1067, seq: 3, big: 9_999_999_999_999 }))
      .toEqual({ timestamp: '<epoch-ms>', size: 1067, seq: 3, big: 9_999_999_999_999 })
  })

  it('R10 drops undefined-valued properties and keeps null', () => {
    expect(norm({ a: undefined, b: null, c: 0 })).toEqual({ b: null, c: 0 })
  })

  it('keeps error text, counts and order', () => {
    expect(norm({ error: 'Provider "x" not found', list: [3, 1, 2] })).toEqual({ error: 'Provider "x" not found', list: [3, 1, 2] })
  })

  it('G1 (golden form only) turns separators under <ROOT> into /', () => {
    const rec: ComparableRecording = { scenario: 's', steps: [], pushes: { ch: ['<ROOT>\\agents\\a.adf', 'C:\\x\\y'] }, local: [], llm: [] }
    expect(toGoldenForm(rec).pushes.ch).toEqual(['<ROOT>/agents/a.adf', 'C:\\x\\y'])
  })
})

describe('parity harness: rendering and diff', () => {
  it('renders multi-line strings as blocks and diffs line by line', () => {
    const base: ComparableRecording = {
      scenario: 's',
      steps: [{ kind: 'invoke', channel: 'c', args: [], result: { text: 'one\ntwo\nthree' } }],
      pushes: { ev: [{ type: 'a' }, { type: 'b' }] },
      local: [],
      llm: [],
    }
    const changed: ComparableRecording = { ...base, pushes: { ev: [{ type: 'a' }, { type: 'x' }, { type: 'b' }] } }
    const a = renderRecording(base)
    expect(a).toContain('text: |\n      one\n      two\n      three')
    const diff = diffRendered(a, renderRecording(changed))
    expect(diff).toContain('+ ## push ev (3)')
    expect(diff).toContain('+   type: "x"')
    expect(diffRendered(a, a)).toBe('')
  })
})

describe('parity harness: isolation', () => {
  it('points every per-user location at the run root and restores the env', async () => {
    const before = { ...process.env }
    const env = await createParityEnv('selftest')
    try {
      for (const key of ['ADF_USER_DATA_DIR', 'ADF_LEASE_DIR', 'HOME', 'USERPROFILE', 'APPDATA', 'TEMP']) {
        expect(process.env[key]?.startsWith(env.root), key).toBe(true)
      }
      expect(process.env.ADF_SECRET_STORE).toBe('file')
      expect(process.env.ADF_KEYCHAIN).toBe('0')
      expect(process.env.MESH_PORT).toBe(String(env.meshPort))
      expect(env.appPath('userData')).toBe(env.userDataDir)
      expect(() => env.appPath('exe')).toThrow(/not mapped/)
    } finally {
      env.dispose()
    }
    for (const key of ['ADF_USER_DATA_DIR', 'HOME', 'USERPROFILE', 'APPDATA', 'TEMP', 'ADF_KEYCHAIN']) {
      expect(process.env[key], key).toBe(before[key])
    }
  })

  it('refuses to load the OS keychain addon during a run', async () => {
    const env = await createParityEnv('selftest')
    try {
      const req = createRequire(join(tmpdir(), 'x.js'))
      expect(() => req('@napi-rs/keyring')).toThrow(/keychain access is forbidden/)
      expect(() => env.assertRealStateUntouched()).toThrow(/keychain addon was requested/)
    } finally {
      env.dispose()
    }
  })

  it('electron fake records pushes, throws on unknown members, drops sends after close', async () => {
    const env = await createParityEnv('selftest')
    try {
      const electron = createFakeElectron(env)
      const { BrowserWindow, app } = electron.module as { BrowserWindow: { getAllWindows(): { webContents: { send(c: string, p: unknown): void } }[] }; app: Record<string, unknown> }
      expect(BrowserWindow.getAllWindows()).toHaveLength(0)
      electron.openWindow()
      const payload = { n: 1 }
      BrowserWindow.getAllWindows()[0].webContents.send('ch', payload)
      payload.n = 2
      expect(electron.pushes).toEqual([{ channel: 'ch', args: [{ n: 1 }] }])
      expect(() => app.requestSingleInstanceLock).toThrow(/no app.requestSingleInstanceLock/)
      electron.closeWindow()
      expect(BrowserWindow.getAllWindows()).toHaveLength(0)
    } finally {
      env.dispose()
    }
  })
})

describe('parity harness: compute safety', () => {
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

  it('child_process guard refuses podman and wsl in every form and passes everything else', async () => {
    const cp = await import('node:child_process')
    const log = createComputeLog()
    const guarded = guardChildProcess(cp as unknown as Record<string, unknown>, log) as unknown as typeof cp
    expect(() => guarded.spawn('podman', ['ps'])).toThrow(/forbidden/)
    expect(() => guarded.execFile(String.raw`C:\Program Files\RedHat\Podman\podman.exe`, ['stop', 'adf-mcp'])).toThrow(/forbidden/)
    expect(() => guarded.exec(String.raw`"C:\Program Files\RedHat\Podman\podman.exe" stop adf-mcp`)).toThrow(/forbidden/)
    expect(() => guarded.execSync('wsl -l')).toThrow(/forbidden/)
    expect(log.refusedSpawns).toHaveLength(4)
    const { promisify } = await import('node:util')
    const { stdout } = await promisify(guarded.execFile)(process.execPath, ['-e', 'process.stdout.write("ok")'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
    expect(stdout).toBe('ok')
  })

  it('embedded boot and shutdown reach only the fake compute service', async () => {
    const env = await createParityEnv('selftest')
    try {
      writeSettingsFile(env, { meshEnabled: false, updateChecksEnabled: false, remoteCatalogsEnabled: false, providerChecksEnabled: false, nativeNotificationsEnabled: false })
      const electron = createFakeElectron(env)
      const booted = await embeddedBackend.boot(env, electron)
      const mod = await import(/* @vite-ignore */ srcPath('main/services/podman.service.ts')) as { PodmanService: new () => { getStatus(): { status: string } } }
      expect(new mod.PodmanService().getStatus().status).toBe('not_installed')
      await booted.shutdown()
      expect(booted.computeCalls()).toContain('stopAll')
      expect(booted.violations()).toEqual([])
      env.assertRealStateUntouched()
    } finally {
      env.dispose()
    }
  }, 60_000)
})
