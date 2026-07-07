import { describe, expect, it, vi, afterEach } from 'vitest'
import { createServer, type Server } from 'net'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', on: () => {}, getName: () => 't', getVersion: () => '0' },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
  shell: { openExternal: async () => {} },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
  BrowserWindow: class {},
  dialog: {}
}))

import { findAvailablePort } from '../../../src/main/services/mesh-server'

const HOST = '127.0.0.1'
const occupied: Server[] = []

function occupy(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(port, HOST, () => { occupied.push(s); resolve() })
  })
}

afterEach(async () => {
  await Promise.all(occupied.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))))
})

describe('findAvailablePort (mesh port fallback)', () => {
  it('returns the requested port when it is free', async () => {
    expect(await findAvailablePort(39051, HOST)).toBe(39051)
  })

  it('skips a taken port and returns the next free one', async () => {
    await occupy(39052)
    expect(await findAvailablePort(39052, HOST)).toBe(39053)
  })

  it('skips a run of taken ports', async () => {
    await occupy(39054)
    await occupy(39055)
    expect(await findAvailablePort(39054, HOST)).toBe(39056)
  })

  it('falls back to the requested port when the whole span is taken', async () => {
    await occupy(39057)
    // span of 1 probes only 39057 (taken) → returns it so listen() surfaces the real error
    expect(await findAvailablePort(39057, HOST, 1)).toBe(39057)
  })
})
