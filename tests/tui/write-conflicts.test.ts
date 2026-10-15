import { describe, expect, it } from 'vitest'
import { DaemonError } from '../../src/main/tui/api/types'
import { editConfigFlow } from '../../src/main/tui/views/inspect/ConfigTab'
import { writeOverConflicts } from '../../src/main/tui/views/files/editor'
import { loadTarget, writeTarget } from '../../src/main/tui/views/files/io'
import { writeOver } from '../../src/main/tui/util/revisions'
import type { TuiActions } from '../../src/main/tui/state/store'
import { validConfig } from './fixtures/inspect-daemon'

/**
 * W3-F in the terminal app: config and file edits save over the revision the
 * re-check before the write saw; a `409 stale_revision` asks Overwrite (save
 * again over their revision) or Reload theirs (nothing written).
 */

const AGENT = '5f1d7a3e-2c4b-4e8a-9b6d-0a1b2c3d4e01'
const config = (description: string) => ({ ...validConfig(AGENT, 'agent-1'), description })
const stale = (revision: number, writer: unknown) => new DaemonError('changed', 409, { code: 'stale_revision', revision, writer, resource: 'config' })

/** A daemon client double: config reads, and every request recorded and answered in turn. */
function fakeClient(answers: Array<unknown | Error>, current = config('daemon'), revision = 10) {
  const requests: Array<{ method: string; path: string; body?: unknown; query?: unknown }> = []
  return {
    requests,
    config: async () => ({ agentId: AGENT, config: current, revision }),
    document: async () => ({ agentId: AGENT, content: '# doc', revision: 20 }),
    file: async (_id: string, path: string) => ({ agentId: AGENT, path, revision: 30, mime_type: 'text/markdown', size: 4, protection: 'none', authorized: false, updated_at: 'x', encoding: 'utf-8', content: 'text' }),
    request: async (method: string, path: string, opts: { body?: unknown; query?: unknown } = {}) => {
      requests.push({ method, path, ...opts })
      const next = answers.shift()
      if (next instanceof Error) throw next
      return next
    },
  }
}

function fakeActions(client: ReturnType<typeof fakeClient>, confirms: boolean[]) {
  const prompts: Array<{ title: string; message: string; confirmLabel?: string; cancelLabel?: string }> = []
  const toasts: string[] = []
  const actions = {
    run: async (_label: string, fn: (c: never) => Promise<unknown>) => {
      try { return await fn(client as never) } catch (err) { toasts.push(`error: ${(err as Error).message}`); return undefined }
    },
    confirm: async (opts: { title: string; message: string; confirmLabel?: string; cancelLabel?: string }) => { prompts.push(opts); return confirms.shift() ?? false },
    toast: (text: string) => { toasts.push(text) },
    loadConfig: async () => client.config().then(r => r.config),
  } as unknown as TuiActions
  return { actions, prompts, toasts }
}

const editTo = (next: object) => async (text: string) => {
  const out = `${JSON.stringify(next, null, 2)}\n`
  return { text: out, changed: out !== text, editor: 'test-editor' }
}

describe('terminal app: config edits over a revision', () => {
  it('saves over the revision of the re-check', async () => {
    const client = fakeClient([{ success: true, revision: 11 }])
    const { actions } = fakeActions(client, [true])
    expect(await editConfigFlow(AGENT, 'agent-1', actions, async cb => { await cb() }, editTo(config('mine')))).toBe('saved')
    expect(client.requests).toEqual([{ method: 'PUT', path: `/agents/${AGENT}/config`, body: config('mine'), query: { baseRevision: 10 } }])
  })

  it('a change after the re-check: the save is refused, the user is asked, Overwrite saves over their revision', async () => {
    const client = fakeClient([stale(12, { kind: 'client', client: 'studio' }), { success: true, revision: 13 }])
    const { actions, prompts } = fakeActions(client, [true, true])
    expect(await editConfigFlow(AGENT, 'agent-1', actions, async cb => { await cb() }, editTo(config('mine')))).toBe('saved')
    expect(prompts.at(-1)).toMatchObject({
      title: 'Config of agent-1 changed while you were editing',
      message: 'Config of agent-1 was changed by another Studio window after you opened it.\nOverwrite replaces their version with yours. Reload keeps theirs.',
      confirmLabel: 'Overwrite',
      cancelLabel: 'Reload theirs',
    })
    expect(client.requests.map(r => r.query)).toEqual([{ baseRevision: 10 }, { baseRevision: 12 }])
  })

  it('Reload theirs writes nothing more and reloads the config', async () => {
    const client = fakeClient([stale(12, { kind: 'agent' })])
    const { actions, toasts } = fakeActions(client, [true, false])
    expect(await editConfigFlow(AGENT, 'agent-1', actions, async cb => { await cb() }, editTo(config('mine')))).toBe('discarded')
    expect(client.requests).toHaveLength(1)
    expect(toasts.at(-1)).toBe('Config of agent-1 not written: kept their version')
  })
})

describe('terminal app: file edits over a revision', () => {
  it('reads carry the revision; a write sends it as baseRevision', async () => {
    const client = fakeClient([{ success: true, revision: 31 }, { success: true, revision: 21 }])
    expect((await loadTarget(client as never, AGENT, { kind: 'file', path: 'notes.md' })).revision).toBe(30)
    expect((await loadTarget(client as never, AGENT, { kind: 'document' })).revision).toBe(20)
    expect(await writeTarget(client as never, AGENT, { kind: 'file', path: 'notes.md' }, 'v2', 30)).toBe(31)
    expect(await writeTarget(client as never, AGENT, { kind: 'document' }, '# v2')).toBe(21)
    expect(client.requests).toEqual([
      { method: 'PUT', path: `/agents/${AGENT}/files/content`, query: { path: 'notes.md' }, body: { content: 'v2', baseRevision: 30 } },
      { method: 'PUT', path: `/agents/${AGENT}/document`, body: { content: '# v2' } },
    ])
  })

  it('a refused write asks; Reload theirs keeps the edited copy and writes nothing', async () => {
    const client = fakeClient([new DaemonError('changed', 409, { code: 'stale_revision', revision: 40, writer: { kind: 'agent' } })])
    const { actions, prompts, toasts } = fakeActions(client, [false])
    const target = { kind: 'file' as const, path: 'notes.md' }
    const result = await writeOverConflicts(actions, 'notes.md', '/tmp/copy/notes.md', base => actions.run('Write', c => writeOver(() => writeTarget(c, AGENT, target, 'mine', base))), 30)
    expect(result).toBe('reloaded')
    expect(prompts[0].message).toBe('notes.md was changed by the agent after you opened it.\nOverwrite replaces their version with yours. Reload keeps theirs (your edited copy stays at /tmp/copy/notes.md).')
    expect(toasts.at(-1)).toBe('notes.md not written: kept their version. Your edited copy is at /tmp/copy/notes.md')
    expect(client.requests).toHaveLength(1)
  })

  it('another error is not a conflict: it fails as before', async () => {
    const client = fakeClient([new DaemonError('locked', 409, { code: 'agent_leased' })])
    const { actions, prompts } = fakeActions(client, [])
    const target = { kind: 'file' as const, path: 'notes.md' }
    expect(await writeOverConflicts(actions, 'notes.md', null, base => actions.run('Write', c => writeOver(() => writeTarget(c, AGENT, target, 'mine', base))), 30)).toBeUndefined()
    expect(prompts).toEqual([])
  })
})
