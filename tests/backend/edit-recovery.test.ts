/**
 * W3-F recovery copies in Studio main (backend/edit-recovery.ts, both
 * backends): kept and removed on the renderer's word, one folder per agent
 * file (name plus a hash of its path), owner-only, listed at the next
 * launch, archived on Dismiss, the archive pruned, and never written
 * outside the agent's folder.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: () => {} }, shell: { openPath: async () => '' } }))

import { agentFolder, ARCHIVE_MAX_ENTRIES, archiveRecovered, listRecovered, pruneArchive, recoveryFile, stashRecovery } from '../../src/main/backend/edit-recovery'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'adf-recovered-'))
  dirs.push(dir)
  return join(dir, 'recovered')
}

const ONE = join(tmpdir(), 'agents-a', 'agent-1.adf')
const OTHER_ONE = join(tmpdir(), 'agents-b', 'agent-1.adf')

it('keeps, lists, archives and removes copies under <agent>-<hash>/<path>', async () => {
  const r = root()
  expect(await listRecovered(r)).toEqual([])
  expect(await stashRecovery(r, { agentFilePath: ONE, path: 'notes/a.md', content: 'mine' })).toBe(true)
  expect(await stashRecovery(r, { agentFilePath: join(tmpdir(), 'agents-a', 'agent-2.adf'), path: 'config.json', content: '{}\n' })).toBe(true)
  expect(readFileSync(join(r, agentFolder(ONE), 'notes', 'a.md'), 'utf-8')).toBe('mine')
  expect((await listRecovered(r)).map((f) => `${f.agent}/${f.path}`)).toEqual(['agent-1/notes/a.md', 'agent-2/config.json'])

  // Resolved: the copy (and its emptied folder) goes.
  await stashRecovery(r, { agentFilePath: join(tmpdir(), 'agents-a', 'agent-2.adf'), path: 'config.json', content: null })
  expect((await listRecovered(r)).map((f) => f.agent)).toEqual(['agent-1'])

  // Dismiss: moved under archive/<time>/, not deleted, and not listed again.
  expect(await archiveRecovered(r, new Date())).toBe(1)
  expect(await listRecovered(r)).toEqual([])
})

it('two agent-1.adf files in different folders keep separate copies; resolving one keeps the other', async () => {
  const r = root()
  expect(agentFolder(ONE)).toMatch(/^agent-1-[0-9a-f]{8}$/)
  expect(agentFolder(ONE)).not.toBe(agentFolder(OTHER_ONE))
  // Windows paths differ only in case: the same file, the same folder.
  expect(agentFolder('C:\\Agents\\agent-1.adf', 'win32')).toBe(agentFolder('c:\\agents\\AGENT-1.adf', 'win32').replace('AGENT-1', 'agent-1'))
  await stashRecovery(r, { agentFilePath: ONE, path: 'notes.md', content: 'from a' })
  await stashRecovery(r, { agentFilePath: OTHER_ONE, path: 'notes.md', content: 'from b' })
  await stashRecovery(r, { agentFilePath: ONE, path: 'notes.md', content: null })
  const left = await listRecovered(r)
  expect(left.map((f) => [f.agent, f.path])).toEqual([['agent-1', 'notes.md']])
  expect(readFileSync(left[0].file, 'utf-8')).toBe('from b')
})

it.skipIf(process.platform === 'win32')('copies are owner-only: folders 0700, files 0600', async () => {
  const r = root()
  await stashRecovery(r, { agentFilePath: ONE, path: 'notes/a.md', content: 'mine' })
  expect(statSync(join(r, agentFolder(ONE))).mode & 0o777).toBe(0o700)
  expect(statSync(join(r, agentFolder(ONE), 'notes', 'a.md')).mode & 0o777).toBe(0o600)
})

it('the archive keeps 30 days and at most 50 dismissals', async () => {
  const r = root()
  const archive = join(r, 'archive')
  const now = Date.parse('2026-10-15T12:00:00Z')
  const make = (name: string, ageDays: number) => {
    mkdirSync(join(archive, name, 'agent-1-00000000'), { recursive: true })
    const t = new Date(now - ageDays * 86_400_000)
    utimesSync(join(archive, name), t, t)
  }
  make('2026-08-01T00-00-00-000Z', 75)
  for (let i = 0; i < ARCHIVE_MAX_ENTRIES + 2; i++) make(`2026-10-${String(10 + Math.floor(i / 24)).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}-00-00-000Z`, 2)
  const removed = await pruneArchive(r, new Date(now))
  expect(removed).toHaveLength(3)
  expect(removed[0]).toBe('2026-08-01T00-00-00-000Z')
  expect(existsSync(join(archive, '2026-08-01T00-00-00-000Z'))).toBe(false)
  expect((await import('node:fs')).readdirSync(archive)).toHaveLength(ARCHIVE_MAX_ENTRIES)
})

it('never writes outside the agent\'s folder', async () => {
  const r = root()
  for (const path of ['../escape.md', '..\\escape.md', '/abs.md', 'C:/abs.md', '', 'a\0b']) {
    expect(recoveryFile(r, 'agent-1.adf', path)).toBeNull()
    expect(await stashRecovery(r, { agentFilePath: 'agent-1.adf', path, content: 'x' })).toBe(false)
  }
  // An agent named like the archive never collides with it.
  expect(agentFolder('archive.adf')).toMatch(/^archive-[0-9a-f]{8}$/)
})

it('a copy of another runtime\'s agent gets its own folder and is listed with its runtime (multi-runtime.md §4.5)', async () => {
  const r = root()
  const remotePath = '/srv/agents/agent-1.adf'
  expect(await stashRecovery(r, { agentFilePath: remotePath, path: 'config.json', content: 'remote text', runtimeId: 'remote:host-1' })).toBe(true)
  expect(await stashRecovery(r, { agentFilePath: remotePath, path: 'notes/a.md', content: 'other remote', runtimeId: 'remote:host-2' })).toBe(true)
  expect(await stashRecovery(r, { agentFilePath: ONE, path: 'notes/a.md', content: 'local text' })).toBe(true)
  // The primary runtime's folder is the one it always was.
  expect(readFileSync(join(r, agentFolder(ONE), 'notes', 'a.md'), 'utf-8')).toBe('local text')
  expect(agentFolder(remotePath, process.platform, 'remote:host-1')).not.toBe(agentFolder(remotePath, process.platform, 'remote:host-2'))
  const listed = await listRecovered(r)
  expect(listed.map((f) => [f.agent, f.path, f.runtimeId ?? 'local']).sort()).toEqual([
    ['agent-1', 'config.json', 'remote:host-1'],
    ['agent-1', 'notes/a.md', 'local'],
    ['agent-1', 'notes/a.md', 'remote:host-2'],
  ])
  expect(listed.find((f) => !f.runtimeId)).not.toHaveProperty('runtimeId')
  // Removed: the folder and its runtime marker go.
  await stashRecovery(r, { agentFilePath: remotePath, path: 'config.json', content: null, runtimeId: 'remote:host-1' })
  const folder = join(r, agentFolder(remotePath, process.platform, 'remote:host-1'))
  expect(existsSync(folder)).toBe(false)
  expect(existsSync(`${folder}.runtime`)).toBe(false)
  // Dismissed: the archived copy keeps its runtime marker.
  expect(await archiveRecovered(r)).toBe(2)
  expect(await listRecovered(r)).toEqual([])
  expect(existsSync(`${join(r, agentFolder(remotePath, process.platform, 'remote:host-2'))}.runtime`)).toBe(false)
})

// R3B-3 (multi-runtime.md §20 item 3): a hand-off (a reconnect, a move, Remove) keeps its copies in a folder of
// its own, by time, which a notice's later copies and their removal never touch.
it('a hand-off\'s copies have their own folder: a later notice on the same file and its removal leave them', async () => {
  const r = root()
  const runtimeId = 'remote:host-1'
  const REMOTE = '/srv/agents/agent-1.adf'
  // T1: kept on Reconnect.
  expect(await stashRecovery(r, { agentFilePath: REMOTE, path: 'notes.md', content: 'T1', runtimeId, kept: '2026-10-20T12-00-00-000Z-1' })).toBe(true)
  // T2 under a new "changed elsewhere" notice on that file, then the notice resolved.
  expect(await stashRecovery(r, { agentFilePath: REMOTE, path: 'notes.md', content: 'T2', runtimeId })).toBe(true)
  expect(await stashRecovery(r, { agentFilePath: REMOTE, path: 'notes.md', content: null, runtimeId })).toBe(true)
  const files = await listRecovered(r)
  expect(files.map((f) => ({ agent: f.agent, path: f.path, runtimeId: f.runtimeId, kept: f.kept, text: readFileSync(f.file, 'utf-8') }))).toEqual([
    { agent: 'agent-1', path: 'notes.md', runtimeId, kept: true, text: 'T1' },
  ])
})

it('two hand-offs of one file keep two copies; Dismiss archives both', async () => {
  const r = root()
  await stashRecovery(r, { agentFilePath: ONE, path: 'notes.md', content: 'first', kept: '2026-10-20T12-00-00-000Z-1' })
  await stashRecovery(r, { agentFilePath: ONE, path: 'notes.md', content: 'second', kept: '2026-10-20T12-00-05-000Z-2' })
  const files = await listRecovered(r)
  expect(files.map((f) => [f.agent, f.path, f.kept, readFileSync(f.file, 'utf-8')])).toEqual([
    ['agent-1', 'notes.md', true, 'first'],
    ['agent-1', 'notes.md', true, 'second'],
  ])
  expect(await archiveRecovered(r)).toBe(2)
  expect(await listRecovered(r)).toEqual([])
})

it('a hand-off stamp that is not a plain name, or a removal of a hand-off copy, is refused', async () => {
  const r = root()
  expect(await stashRecovery(r, { agentFilePath: ONE, path: 'notes.md', content: 'x', kept: '../x' })).toBe(false)
  expect(await stashRecovery(r, { agentFilePath: ONE, path: 'notes.md', content: null, kept: '2026-10-20T12-00-00-000Z-1' })).toBe(false)
  expect(await listRecovered(r)).toEqual([])
})
