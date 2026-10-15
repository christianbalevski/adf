/**
 * W3-F recovery copies in Studio main (backend/edit-recovery.ts, both
 * backends): kept and removed on the renderer's word, listed at the next
 * launch, archived on Dismiss (never deleted), and never written outside
 * the agent's folder.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: () => {} }, shell: { openPath: async () => '' } }))

import { archiveRecovered, listRecovered, recoveryFile, stashRecovery } from '../../src/main/backend/edit-recovery'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'adf-recovered-'))
  dirs.push(dir)
  return join(dir, 'recovered')
}

it('keeps, lists, archives and removes copies under <agent>/<path>', async () => {
  const r = root()
  expect(await listRecovered(r)).toEqual([])
  expect(await stashRecovery(r, { agentFilePath: 'C:/agents/agent-1.adf', path: 'notes/a.md', content: 'mine' })).toBe(true)
  expect(await stashRecovery(r, { agentFilePath: '/home/u/agents/agent-2.adf', path: 'config.json', content: '{}\n' })).toBe(true)
  expect(readFileSync(join(r, 'agent-1', 'notes', 'a.md'), 'utf-8')).toBe('mine')
  expect((await listRecovered(r)).map((f) => `${f.agent}/${f.path}`)).toEqual(['agent-1/notes/a.md', 'agent-2/config.json'])

  // Resolved: the copy (and its emptied folder) goes.
  await stashRecovery(r, { agentFilePath: '/home/u/agents/agent-2.adf', path: 'config.json', content: null })
  expect(existsSync(join(r, 'agent-2'))).toBe(false)

  // Dismiss: moved under archive/<time>/, not deleted, and not listed again.
  expect(await archiveRecovered(r, new Date('2026-10-15T08:00:00Z'))).toBe(1)
  expect(await listRecovered(r)).toEqual([])
  expect(readFileSync(join(r, 'archive', '2026-10-15T08-00-00-000Z', 'agent-1', 'notes', 'a.md'), 'utf-8')).toBe('mine')
})

it('never writes outside the agent\'s folder', async () => {
  const r = root()
  for (const path of ['../escape.md', '..\\escape.md', '/abs.md', 'C:/abs.md', '', 'a\0b']) {
    expect(recoveryFile(r, 'agent-1.adf', path)).toBeNull()
    expect(await stashRecovery(r, { agentFilePath: 'agent-1.adf', path, content: 'x' })).toBe(false)
  }
  // An agent named like the archive gets a folder of its own.
  expect(recoveryFile(r, 'archive.adf', 'a.md')).toBe(join(r, '_archive', 'a.md'))
})
