/**
 * E3 (found by W3-A's template-create scenario): the templates service
 * notifies TEMPLATES_CHANGED once for its own write. Its folder watcher used
 * to report the same file again ~0.6 s later, or not, depending on when the
 * watcher became ready: one or two refreshes for one create, in either mode.
 * A file changed outside the service is still reported.
 */
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() }, shell: { trashItem: async () => {} } }))

import { AgentTemplatesService } from '../../../src/main/adf/agent-templates'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let dir: string
let service: AgentTemplatesService
let notified = 0

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'adf-templates-own-'))
  process.env.ADF_USER_DATA_DIR = dir
  notified = 0
  const data: Record<string, unknown> = {}
  service = new AgentTemplatesService({
    settings: { get: (k: string) => data[k], set: (k: string, v: unknown) => { data[k] = v }, delete: (k: string) => { delete data[k] } } as never,
    getOwnerDid: () => '',
    notifyChanged: () => { notified++ },
  })
})

afterEach(() => {
  service.stopWatcher()
  delete process.env.ADF_USER_DATA_DIR
  rmSync(dir, { recursive: true, force: true })
})

describe('templates folder watcher and the service\'s own writes (E3)', () => {
  it('one create notifies once; a file copied in from outside still notifies', async () => {
    service.list()
    service.startWatcher()
    await sleep(800)
    notified = 0
    const made = await service.create({ name: 'Team agent' })
    expect(made.success).toBe(true)
    await sleep(2_000)
    expect(notified).toBe(1)

    notified = 0
    const folder = join(dir, 'templates')
    const first = readdirSync(folder).find((f) => f.endsWith('.adf'))!
    copyFileSync(join(folder, first), join(folder, 'copied-in.adf'))
    for (let i = 0; i < 40 && notified === 0; i++) await sleep(100)
    expect(notified).toBe(1)
  }, 15_000)
})
