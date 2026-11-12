import { describe, it, expect, vi, afterEach, afterAll } from 'vitest'

// Pass-through spy: the real host process is spawned; the spy only records the
// env it was given.
const spawnCalls = vi.hoisted(() => [] as Array<{ env?: NodeJS.ProcessEnv }>)
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    spawn: ((...args: Parameters<typeof actual.spawn>) => {
      const opts = args.find((a, i) => i > 0 && a && typeof a === 'object' && !Array.isArray(a)) as { env?: NodeJS.ProcessEnv } | undefined
      spawnCalls.push({ env: opts?.env })
      return (actual.spawn as (...a: unknown[]) => unknown)(...args)
    }) as typeof actual.spawn,
  }
})

import { CodeSandboxService } from '../../../src/main/runtime/code-sandbox'
import { shutdownSandboxHosts } from '../../../src/main/runtime/sandbox-host'

/**
 * Cron timers are evaluated in the runtime's local zone, which honours TZ.
 * Code in the sandbox (sys_code, lambdas) must report that same zone, so the
 * sandbox host process gets TZ from the parent when it is set — and nothing
 * else from the parent's environment.
 */
describe('sandbox host time zone', () => {
  const originalTz = process.env.TZ
  const agentId = '7d0f2b3a-9c41-4e8a-8b6e-2f1d4c5a6b70'
  let sandbox: CodeSandboxService

  // Neither the machine zone (/etc/localtime) nor a typical CI/dev TZ.
  const ZONE = 'Pacific/Chatham'
  // minimalEnv's existing Windows-only passthrough.
  const WINDOWS_KEYS = ['SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR']
  const probe = `return JSON.stringify({ zone: Intl.DateTimeFormat().resolvedOptions().timeZone, offset: new Date(Date.UTC(2026, 0, 1)).getTimezoneOffset() })`

  function restoreTz(): void {
    if (originalTz === undefined) delete process.env.TZ
    else process.env.TZ = originalTz
  }

  async function runProbe(): Promise<{ zone: string; offset: number }> {
    // A fresh host per case: hosts are cached per allowlist and keep the env
    // they were started with.
    shutdownSandboxHosts()
    spawnCalls.length = 0
    sandbox = new CodeSandboxService()
    const result = await sandbox.execute(agentId, probe, 10_000)
    expect(result.error).toBeUndefined()
    return JSON.parse(String(result.result))
  }

  afterEach(() => {
    sandbox?.destroyAll()
    shutdownSandboxHosts()
    restoreTz()
  })
  afterAll(restoreTz)

  it('reports the parent TZ zone when TZ is set', async () => {
    process.env.TZ = ZONE
    const parentZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    expect(parentZone).toBe(ZONE)
    const out = await runProbe()
    // UTC+13:45 on 1 January (Chatham daylight time).
    expect(out).toEqual({ zone: ZONE, offset: -825 })
    expect(spawnCalls).toHaveLength(1)
    // TZ is the only addition: no other parent variable reaches the host.
    const keys = Object.keys(spawnCalls[0].env ?? {})
    expect(keys).toContain('TZ')
    for (const k of keys) expect(['ELECTRON_RUN_AS_NODE', 'TZ', ...WINDOWS_KEYS]).toContain(k)
    if (process.platform !== 'win32') expect(keys.sort()).toEqual(['ELECTRON_RUN_AS_NODE', 'TZ'])
    expect(spawnCalls[0].env?.TZ).toBe(ZONE)
  }, 30_000)

  it('adds no TZ key when TZ is unset in the parent (unchanged behaviour)', async () => {
    delete process.env.TZ
    const parentZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const out = await runProbe()
    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0].env).not.toHaveProperty('TZ')
    for (const k of Object.keys(spawnCalls[0].env ?? {})) expect(['ELECTRON_RUN_AS_NODE', ...WINDOWS_KEYS]).toContain(k)
    // Both fall back to the system zone (/etc/localtime on Linux).
    expect(out.zone).toBe(parentZone)
  }, 30_000)

  it('passes an empty TZ through, so both processes run in UTC', async () => {
    process.env.TZ = ''
    const out = await runProbe()
    expect(spawnCalls[0].env?.TZ).toBe('')
    expect(out.offset).toBe(0)
  }, 30_000)
})
