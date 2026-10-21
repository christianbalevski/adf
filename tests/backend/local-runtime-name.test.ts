/**
 * The local runtime's name (docs/design/multi-runtime.md §1.3):
 * `<runtime name> (Local)`, the runtime name being the runtime alias, else
 * the host name; "Local" with no name. Settings in a temp dir only.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { localRuntimeName, LOCAL_LABEL, REMOTE_TIP } from '../../src/shared/runtime-name'
import { LocalRuntimeName, machineName } from '../../src/main/backend/local-runtime-name'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function settingsDir(settings?: Record<string, unknown> | string): string {
  const dir = mkdtempSync(join(tmpdir(), 'adf-runtime-name-'))
  dirs.push(dir)
  if (settings !== undefined) writeFileSync(join(dir, 'adf-settings.json'), typeof settings === 'string' ? settings : JSON.stringify(settings))
  return dir
}

describe('localRuntimeName', () => {
  it('is `<name> (Local)`, or Local alone with no name', () => {
    expect(localRuntimeName('host-0')).toBe('host-0 (Local)')
    expect(localRuntimeName('  host-0 ')).toBe('host-0 (Local)')
    expect(localRuntimeName('')).toBe('Local')
    expect(localRuntimeName(null)).toBe('Local')
    expect(LOCAL_LABEL).toBe('Local')
    expect(REMOTE_TIP).toBe('Remote')
  })
})

describe('machineName', () => {
  it('the runtime alias, else the host name', () => {
    expect(machineName(settingsDir({ runtimeAlias: 'host-0' }), () => 'host-9')).toBe('host-0')
    expect(machineName(settingsDir({ runtimeAlias: '  ' }), () => 'host-9')).toBe('host-9')
    expect(machineName(settingsDir(), () => 'host-9')).toBe('host-9')
    expect(machineName(settingsDir('{not json'), () => 'host-9')).toBe('host-9')
    expect(machineName(undefined, () => 'host-9')).toBe('host-9')
  })
})

describe('LocalRuntimeName', () => {
  it('reads the name once, and again on refresh: true only when it changed', async () => {
    const dir = settingsDir({ runtimeAlias: 'host-0' })
    const name = new LocalRuntimeName(dir, () => 'host-9')
    expect(name.display()).toBe('host-0 (Local)')
    expect(await name.refresh()).toBe(false)
    writeFileSync(join(dir, 'adf-settings.json'), JSON.stringify({ runtimeAlias: 'host-1' }))
    expect(name.display()).toBe('host-0 (Local)')
    expect(await name.refresh()).toBe(true)
    expect(name.display()).toBe('host-1 (Local)')
    // The alias cleared: the host name.
    writeFileSync(join(dir, 'adf-settings.json'), JSON.stringify({}))
    expect(await name.refresh()).toBe(true)
    expect(name.display()).toBe('host-9 (Local)')
  })

  it('no alias and no host name: Local', async () => {
    const name = new LocalRuntimeName(settingsDir(), () => '')
    expect(name.display()).toBe('Local')
    expect(await name.refresh()).toBe(false)
    name.dispose()
  })
})
