/**
 * The daemon's settings store never writes Studio's client keys at their
 * defaults (§4.1, §4.2): after the switch moved them into
 * studio-client-settings.json they MUST NOT come back into adf-settings.json
 * (parity allowlist `w4a:daemon-writes-client-defaults`, now gone).
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileSettingsStore } from '../src/main/daemon/file-settings-store'
import { CLIENT_SETTINGS_KEYS } from '../src/shared/constants/client-settings-keys'

function file(data: Record<string, unknown>): string {
  const path = join(mkdtempSync(join(tmpdir(), 'adf-settings-client-keys-')), 'adf-settings.json')
  writeFileSync(path, JSON.stringify(data))
  return path
}
const onDisk = (path: string) => JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
const clientKeysIn = (data: Record<string, unknown>) => CLIENT_SETTINGS_KEYS.filter((k) => k in data)

describe('FileSettingsStore and client keys', () => {
  it('a write leaves out client keys the file does not hold (defaults stay in memory)', () => {
    const path = file({ providers: [] })
    const store = new FileSettingsStore(path)
    expect(store.get('menuBarEnabled')).not.toBeUndefined()
    store.set('meshEnabled', false)
    expect(clientKeysIn(onDisk(path))).toEqual([])
    expect(onDisk(path).meshEnabled).toBe(false)
  })

  it('keeps client keys the file holds (embedded Studio shares the file), and writes one set through the store', () => {
    const path = file({ theme: 'dark' })
    const store = new FileSettingsStore(path)
    store.set('meshEnabled', true)
    expect(onDisk(path).theme).toBe('dark')
    store.set('uiScale', 1.25)
    expect(onDisk(path).uiScale).toBe(1.25)
  })

  it('a client key Studio moved out of the file while the daemon ran is not written back', async () => {
    const path = file({ theme: 'dark', recentFiles: ['C:/a/agent-1.adf'] })
    const store = new FileSettingsStore(path)
    // The handover (another process) removes the client keys.
    await new Promise((r) => setTimeout(r, 20))
    const moved = onDisk(path)
    delete moved.theme
    delete moved.recentFiles
    writeFileSync(path, JSON.stringify({ ...moved, extra: 1 }))
    store.set('meshEnabled', false)
    expect(clientKeysIn(onDisk(path))).toEqual([])
    expect(onDisk(path).extra).toBe(1)
  })
})
