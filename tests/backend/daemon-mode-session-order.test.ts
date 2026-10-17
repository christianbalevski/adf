/**
 * DaemonModeSession ordering (W2-C2 review): FILE_OPEN / FILE_CLOSE /
 * reattach run one at a time, so the last click wins whatever the daemon's
 * answer times; focus PUTs are sent in order, so the daemon ends on the
 * focus Studio has. A re-hold that fails or finds the file locked again
 * after a reconnect is shown.
 */
import { describe, expect, it } from 'vitest'
import type { ClientSession, HeldDocument } from '../../src/main/backend/daemon-mode/client-stream'
import { DaemonModeSession } from '../../src/main/backend/daemon-mode/session'

const FILE_A = 'C:/agents/agent-1.adf'
const FILE_B = 'C:/agents/agent-2.adf'
const ID: Record<string, string> = { [FILE_A]: 'id-1', [FILE_B]: 'id-2' }
const quiet = { log: () => {}, warn: () => {} }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A client session whose answers take as long as `delay` says; it records what the daemon ends up with. */
function scriptedClient(delay: { hold?: (filePath: string) => number; focus?: (agentId: string | null) => number } = {}) {
  const daemon = { focus: undefined as string | null | undefined, held: new Set<string>(), focusOrder: [] as Array<string | null> }
  let holdAnswer: (filePath: string) => Promise<HeldDocument> = async (filePath) => ({ agentId: ID[filePath] })
  const client: ClientSession & { setHold(fn: (filePath: string) => Promise<HeldDocument>): void } = {
    kind: 'client-session',
    sessionId: 's1',
    start() {},
    async setFocus(agentId) {
      await sleep(delay.focus?.(agentId) ?? 0)
      daemon.focus = agentId
      daemon.focusOrder.push(agentId)
    },
    async holdDocument(filePath) {
      await sleep(delay.hold?.(filePath) ?? 0)
      const answer = await holdAnswer(filePath)
      daemon.held.add(answer.agentId)
      return answer
    },
    async releaseDocument(agentId) { daemon.held.delete(agentId) },
    reconnect() {},
    async end() {},
    setHold(fn) { holdAnswer = fn },
  }
  return { client, daemon }
}

describe('DaemonModeSession ordering', () => {
  it('A → B → A with a slow B hold ends on A, held and focused, and B released', async () => {
    const { client, daemon } = scriptedClient({ hold: (f) => (f === FILE_B ? 60 : 1) })
    const session = new DaemonModeSession(client, quiet)
    const none = async () => null
    const opens = [session.openFile(FILE_A, none), session.openFile(FILE_B, none), session.openFile(FILE_A, none)]
    const results = await Promise.all(opens)
    expect(results.map((r) => r.filePath)).toEqual([FILE_A, FILE_B, FILE_A])
    expect(session.filePath).toBe(FILE_A)
    expect(session.agentId).toBe('id-1')
    expect(daemon.focus).toBe('id-1')
    expect([...daemon.held]).toEqual(['id-1'])
  })

  it('a FILE_OPEN that fails keeps the previous file current, held and focused (review 4300792020)', async () => {
    const { client, daemon } = scriptedClient()
    const session = new DaemonModeSession(client, quiet)
    await session.openFile(FILE_A, async () => null)
    client.setHold(async (filePath) => {
      if (filePath === FILE_B) throw new Error('agent-2.adf is not a valid agent file')
      return { agentId: ID[filePath] }
    })
    await expect(session.openFile(FILE_B, async () => null)).rejects.toThrow(/not a valid agent file/)
    expect(session.filePath).toBe(FILE_A)
    expect(session.current?.held).toBe(true)
    expect(session.agentId).toBe('id-1')
    expect([...daemon.held]).toEqual(['id-1'])
    expect(daemon.focus).toBe('id-1')
  })

  it('opening the file already open keeps its hold', async () => {
    const { client, daemon } = scriptedClient()
    const session = new DaemonModeSession(client, quiet)
    await session.openFile(FILE_A, async () => null)
    await session.openFile(FILE_A, async () => null)
    expect(session.current?.held).toBe(true)
    expect([...daemon.held]).toEqual(['id-1'])
  })

  it('focus PUTs whose answers come back out of order still leave the daemon on the latest focus', async () => {
    // A PUT for 'id-x' is slow and the next one fast: unchained, the slow one would land last.
    const { client, daemon } = scriptedClient({ focus: (id) => (id === 'id-x' ? 60 : 1) })
    const session = new DaemonModeSession(client, quiet)
    await session.openFile(FILE_A, async () => null)
    session.noteAgent(FILE_A, 'id-x')
    await sleep(5) // the slow PUT is on its way
    session.noteAgent(FILE_A, 'id-1')
    await sleep(120)
    expect(session.focusAgentId).toBe('id-1')
    expect(daemon.focus).toBe('id-1')
    expect(daemon.focusOrder).toEqual(['id-1', 'id-x', 'id-1'])
  })

  it('a reattach after a reconnect waits for an open in progress', async () => {
    const { client, daemon } = scriptedClient({ hold: (f) => (f === FILE_B ? 40 : 1) })
    const session = new DaemonModeSession(client, quiet)
    const open = session.openFile(FILE_B, async () => null)
    const reattach = session.reattach()
    await Promise.all([open, reattach])
    expect(session.agentId).toBe('id-2')
    expect(daemon.focus).toBe('id-2')
  })

  it('a re-hold that fails after a reconnect is shown, and the file no longer claims a daemon agent', async () => {
    const { client, daemon } = scriptedClient()
    const problems: string[] = []
    const session = new DaemonModeSession(client, quiet, (t) => { problems.push(t) })
    await session.openFile(FILE_A, async () => null)
    client.setHold(async () => { throw new Error('file_moving') })
    await session.reattach()
    expect(problems).toEqual([expect.stringMatching(/could not reopen C:\/agents\/agent-1\.adf .*file_moving.*Open it again/)])
    expect(session.filePath).toBe(FILE_A)
    expect(session.agentId).toBeNull()
    expect(daemon.focus).toBeNull()
  })

  it('a re-hold that answers needsPassword forgets the key and tells the user to open the file again', async () => {
    const { client } = scriptedClient()
    const problems: string[] = []
    const session = new DaemonModeSession(client, quiet, (t) => { problems.push(t) })
    await session.openFile(FILE_A, async () => null)
    session.noteUnlocked(FILE_A, 'id-1')
    session.noteUnlocked(FILE_B, 'id-2')
    client.setHold(async (filePath) => ({ agentId: ID[filePath], needsPassword: true }))
    await session.reattach()
    expect(problems).toEqual([expect.stringMatching(/agent-1\.adf is locked again .* Open it again to enter its password/)])
    expect(session.isUnlocked(FILE_A)).toBe(false)
    expect(session.isUnlocked(FILE_B)).toBe(false)
    expect(session.agentId).toBe('id-1')
  })
})

describe('reattach preserves daemon identity and replayed paths', () => {
  it.each([false, true])('keeps a replayed foreground rename after a delayed re-hold (failure=%s)', async (fails) => {
    const { client } = scriptedClient()
    const session = new DaemonModeSession(client, quiet)
    await session.openFile(FILE_A, async () => null)
    let resolve!: (answer: HeldDocument) => void
    let reject!: (error: Error) => void
    client.setHold(() => new Promise((yes, no) => { resolve = yes; reject = no }))
    const reattach = session.reattach()
    while (!resolve) await sleep(0)
    session.rekey(FILE_A, FILE_B)
    if (fails) reject(new Error('old path is gone'))
    else resolve({ agentId: 'id-1', filePath: FILE_A })
    await reattach
    expect(session.filePath).toBe(FILE_B)
    expect(session.current?.opened?.filePath).toBe(FILE_B)
    expect(session.agentId).toBe(fails ? null : 'id-1')
  })

  it('does not undo a rename of an unlocked background document while its re-hold awaits', async () => {
    const { client } = scriptedClient()
    const session = new DaemonModeSession(client, quiet)
    session.noteUnlocked(FILE_A, 'id-1')
    let finish!: (answer: HeldDocument) => void
    client.setHold(() => new Promise((r) => { finish = r }))
    const reattach = session.reattach()
    while (!finish) await sleep(0)
    session.rekey(FILE_A, FILE_B)
    finish({ agentId: 'id-1', filePath: FILE_A })
    await reattach
    expect(session.isUnlocked(FILE_A)).toBe(false)
    expect(session.isUnlocked(FILE_B)).toBe(true)
  })

  it.each([false, true])('re-holds unlocked paths with their original spelling (remote=%s)', async (remote) => {
    const { client } = scriptedClient()
    const requested: string[] = []
    client.setHold(async (filePath) => { requested.push(filePath); return { agentId: 'id-1', filePath } })
    const session = new DaemonModeSession(client, quiet, undefined, remote)
    session.noteUnlocked('/agents/Foo.adf', 'id-1')
    await session.reattach()
    expect(requested).toEqual(['/agents/Foo.adf'])
    expect(session.isUnlocked('/agents/Foo.adf')).toBe(true)
    if (remote) expect(session.isUnlocked('/agents/foo.adf')).toBe(false)
  })

  it('preserves remote path case and Windows spelling when identifying the focused file', async () => {
    const { client } = scriptedClient()
    client.setHold(async () => ({ agentId: 'id-1' }))
    const session = new DaemonModeSession(client, quiet, undefined, true)
    await session.openFile('/agents/Foo.adf', async () => null)
    expect(session.isFocused(null, '/agents/foo.adf')).toBe(false)
    expect(session.isFocused(null, '/agents/Foo.adf')).toBe(true)
    expect(session.pathKey('C:\\agents\\Foo.adf')).toBe('C:\\agents\\Foo.adf')
    session.noteAgent('/agents/foo.adf', 'id-2')
    expect(session.agentId).toBe('id-1')
  })
})


describe('reattach canonical daemon path', () => {
  it.each([false, true])('moves the foreground unlocked cache to a renamed canonical path, even without replay (locked=%s)', async (needsPassword) => {
    const { client } = scriptedClient()
    const session = new DaemonModeSession(client, quiet, undefined, true)
    await session.openFile(FILE_A, async () => null)
    session.noteUnlocked(FILE_A, 'id-1')
    client.setHold(async () => ({ agentId: 'id-1', filePath: FILE_B, needsPassword }))
    await session.reattach()
    expect(session.filePath).toBe(FILE_B)
    expect(session.isUnlocked(FILE_A)).toBe(false)
    expect(session.isUnlocked(FILE_B)).toBe(!needsPassword)
  })

  it('does not overwrite a newer agent assignment that arrived during the re-hold', async () => {
    const { client } = scriptedClient()
    const session = new DaemonModeSession(client, quiet)
    await session.openFile(FILE_A, async () => null)
    let finish!: (answer: HeldDocument) => void
    client.setHold(() => new Promise((r) => { finish = r }))
    const reattach = session.reattach()
    while (!finish) await sleep(0)
    session.noteAgent(FILE_A, 'id-new')
    finish({ agentId: 'id-1', filePath: FILE_A })
    await reattach
    expect(session.agentId).toBe('id-new')
    expect(session.focusAgentId).toBe('id-new')
  })
})
