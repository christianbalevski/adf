/**
 * Embedded boot when the lazily imported IPC layer throws while it loads: the
 * same outcome as the static import it replaced (Electron's main-process
 * error dialog, then exit), never a logged rejection with no window.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./main-boot-harness')).h.electron)
vi.mock('../../src/main/ipc/index', () => {
  throw new Error('ipc-evaluation-boom')
})
vi.mock('../../src/main/utils/main-log-file', () => ({ installMainLogFile: () => null }))
vi.mock('../../src/main/utils/stall-monitor', () => ({ startStallMonitor: () => null, stopStallMonitor: () => {} }))
vi.mock('../../src/main/utils/scratch-dir', () => ({ purgeStaleProcessDirs: () => {} }))
vi.mock('../../src/main/services/app-updater.service', async () => {
  const { h } = await import('./main-boot-harness')
  return { initAppUpdater: () => { h.calls.push('initAppUpdater') } }
})
vi.mock('../../src/main/runtime/sandbox-host', () => ({ shutdownSandboxHosts: () => {} }))

import { h } from './main-boot-harness'

h.state.userData = mkdtempSync(join(tmpdir(), 'adf-main-boot-'))
process.env.ADF_USER_DATA_DIR = h.state.userData
delete process.env.ADF_STUDIO_BACKEND
delete process.env.ADF_INSTANCE
// Embedded explicitly: no studio-backend.json means Local daemon since W5-I.
writeFileSync(join(h.state.userData, 'studio-backend.json'), JSON.stringify({ v: 1, mode: 'embedded' }))
const shown: Array<{ title: string; body: string }> = []
;(h.electron.dialog as Record<string, unknown>).showErrorBox = (title: string, body: string) => {
  shown.push({ title, body })
  h.calls.push('dialog.showErrorBox')
}
const rejections: unknown[] = []
const onRejection = (reason: unknown) => { rejections.push(reason) }
process.on('unhandledRejection', onRejection)
const EVENTS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK', 'unhandledRejection', 'uncaughtException', 'exit']
const before = new Map(EVENTS.map((e) => [e, new Set(process.listeners(e as NodeJS.Signals))]))
afterAll(() => {
  process.removeListener('unhandledRejection', onRejection)
  for (const e of EVENTS) {
    for (const l of process.listeners(e as NodeJS.Signals)) if (!before.get(e)!.has(l)) process.removeListener(e, l as never)
  }
})

it('embedded: an IPC layer that throws on load shows the main-process error dialog and exits, with no window', async () => {
  await import('../../src/main/index')
  const deadline = Date.now() + 5000
  while (!h.calls.includes('app.exit')) {
    if (Date.now() > deadline) throw new Error(`no exit: ${h.calls.join(' | ')}`)
    await new Promise((r) => setTimeout(r, 5))
  }
  await new Promise((r) => setTimeout(r, 20))
  // Vitest wraps the factory's throw in its own error; the body is that error's stack.
  expect(shown).toEqual([{ title: 'A JavaScript error occurred in the main process', body: expect.stringMatching(/^Uncaught Exception:\nError: /) }])
  expect(h.calls.indexOf('dialog.showErrorBox')).toBeLessThan(h.calls.indexOf('app.exit'))
  expect(h.calls).not.toContain('new BrowserWindow')
  expect(h.calls).not.toContain('initAppUpdater')
  expect(rejections).toEqual([])
})
