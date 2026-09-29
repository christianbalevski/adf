import { readFileSync, utimesSync, writeFileSync, existsSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DaemonClient } from '../../src/main/tui/api/client'
import type { TuiActions } from '../../src/main/tui/state/store'
import { cleanupExternalCopies, externalChanged, externalCopy, openExternal, saveBackExternal, type ExternalDeps } from '../../src/main/tui/views/files/external'

const XLSX = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x10])
const target = { kind: 'file' as const, path: 'reports/q3.xlsx' }

function setup(opts: { confirm?: boolean } = {}) {
  const store = { bytes: XLSX }
  const writes: Array<{ path: string; input: Record<string, unknown> }> = []
  const client = {
    file: vi.fn(async () => ({ encoding: 'base64', content_base64: store.bytes.toString('base64'), mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: store.bytes.length })),
    writeFile: vi.fn(async (_agent: string, path: string, input: Record<string, unknown>) => { writes.push({ path, input }); return { success: true } }),
  } as unknown as DaemonClient
  const toasts: string[] = []
  const actions = {
    run: async <T>(_label: string, fn: (c: DaemonClient) => Promise<T>) => fn(client),
    confirm: vi.fn(async () => opts.confirm ?? true),
    toast: (text: string) => { toasts.push(text) },
  } as unknown as TuiActions
  const opened: string[] = []
  const deps: ExternalDeps = { client, actions, agentId: 'agent-1', agentLabel: 'agent-1', open: f => opened.push(f) }
  return { store, writes, deps, opened, toasts, actions }
}

/** What the default app does: write the copy and bump its mtime. */
function appSaves(file: string, bytes: Buffer) {
  writeFileSync(file, bytes)
  const later = new Date(Date.now() + 5000)
  utimesSync(file, later, later)
}

afterEach(() => cleanupExternalCopies())

describe('open in the default app', () => {
  it('writes the bytes to a temp copy named like the file and launches it', async () => {
    const { deps, opened } = setup()
    expect(await openExternal(deps, target)).toBe(true)
    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatch(/q3\.xlsx$/)
    expect(readFileSync(opened[0]).equals(XLSX)).toBe(true)
    expect(externalChanged(externalCopy('agent-1', target)!)).toBe(false)
  })

  it('saves the app\'s changes back as base64 with the mime type', async () => {
    const { deps, opened, writes } = setup()
    await openExternal(deps, target)
    const edited = Buffer.concat([XLSX, Buffer.from([1, 2, 3])])
    appSaves(opened[0], edited)
    expect(externalChanged(externalCopy('agent-1', target)!)).toBe(true)
    expect(await saveBackExternal(deps, target)).toBe('written')
    expect(writes).toHaveLength(1)
    expect(Buffer.from(writes[0].input.contentBase64 as string, 'base64').equals(edited)).toBe(true)
    expect(writes[0].input.mimeType).toMatch(/spreadsheetml/)
    expect(externalChanged(externalCopy('agent-1', target)!)).toBe(false)
  })

  it('writes nothing when the copy is unchanged or the user cancels', async () => {
    const { deps, opened, writes } = setup({ confirm: false })
    await openExternal(deps, target)
    expect(await saveBackExternal(deps, target)).toBe('unchanged')
    appSaves(opened[0], Buffer.from('changed'))
    expect(await saveBackExternal(deps, target)).toBe('discarded')
    expect(writes).toHaveLength(0)
  })

  it('warns when the agent changed the file since it was opened', async () => {
    const { deps, opened, store, actions } = setup()
    await openExternal(deps, target)
    store.bytes = Buffer.from('agent rewrote it')
    appSaves(opened[0], Buffer.from('mine'))
    await saveBackExternal(deps, target)
    const call = (actions.confirm as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.title).toMatch(/Concurrent change/)
    expect(call.danger).toBe(true)
  })

  it('reopening keeps unsaved changes in the copy', async () => {
    const { deps, opened } = setup()
    await openExternal(deps, target)
    appSaves(opened[0], Buffer.from('work in progress'))
    await openExternal(deps, target)
    expect(opened[1]).toBe(opened[0])
    expect(readFileSync(opened[0], 'utf-8')).toBe('work in progress')
  })

  it('save back without an open copy says so', async () => {
    const { deps, toasts } = setup()
    expect(await saveBackExternal(deps, target)).toBe('failed')
    expect(toasts.at(-1)).toMatch(/press o/)
  })

  it('cleanup removes the temp copies', async () => {
    const { deps, opened } = setup()
    await openExternal(deps, target)
    cleanupExternalCopies()
    expect(existsSync(opened[0])).toBe(false)
    expect(externalCopy('agent-1', target)).toBeUndefined()
  })
})
