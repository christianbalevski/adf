import React from 'react'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { App } from '../../src/main/tui/app/App'
import { createTheme } from '../../src/main/tui/app/theme'
import { DaemonClient } from '../../src/main/tui/api/client'
import { createTuiStore, type TuiStore } from '../../src/main/tui/state/store'
import { startMockDaemon, AGENT_1_ID, type MockDaemon } from './fixtures/mock-daemon'
import { createFilesFetch, type FilesFixture } from './fixtures/files-daemon'
import { renderTui, type RenderedTui } from './fixtures/render'

const KEY = { tab: '\t', enter: '\r', esc: '\u001b', down: '\u001b[B', up: '\u001b[A', right: '\u001b[C', left: '\u001b[D' }

let mock: MockDaemon
let fixture: FilesFixture
let store: TuiStore
let ui: RenderedTui | null = null
let scratch: string
let editorLog: string
let editorGo: string
const savedVisual = process.env.VISUAL

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'adf-files-test-'))
  // A scripted "editor": records the file it got, waits for the go-file, appends a line.
  const script = join(scratch, 'editor.cjs')
  writeFileSync(script, [
    "const fs = require('fs')",
    'const target = process.argv[2]',
    "fs.writeFileSync(process.env.ADF_TEST_EDITOR_LOG, target)",
    'const deadline = Date.now() + 5000',
    'while (!fs.existsSync(process.env.ADF_TEST_EDITOR_GO) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)',
    "const mode = fs.readFileSync(process.env.ADF_TEST_EDITOR_GO, 'utf-8')",
    "if (mode === 'fail') process.exit(3)",
    "if (mode !== 'keep') fs.appendFileSync(target, '\\n- added by the owner')",
  ].join('\n'))
  process.env.VISUAL = `"${process.execPath}" "${script}"`
})

afterAll(() => {
  if (savedVisual === undefined) delete process.env.VISUAL
  else process.env.VISUAL = savedVisual
  rmSync(scratch, { recursive: true, force: true })
})

beforeEach(async () => {
  mock = await startMockDaemon({ stepMs: 5 })
  fixture = createFilesFetch(mock)
  store = createTuiStore({ client: new DaemonClient({ baseUrl: mock.url, fetch: fixture.fetch }) })
  editorLog = join(scratch, `log-${Math.random().toString(36).slice(2)}`)
  editorGo = join(scratch, `go-${Math.random().toString(36).slice(2)}`)
  process.env.ADF_TEST_EDITOR_LOG = editorLog
  process.env.ADF_TEST_EDITOR_GO = editorGo
})

afterEach(async () => {
  ui?.unmount()
  ui = null
  store.stop()
  await mock.close()
})

async function mountFiles(size?: { columns?: number; rows?: number }) {
  ui = renderTui(<App store={store} theme={createTheme({ mono: true })} />, { columns: 130, rows: 34, ...size })
  await store.start()
  await waitFor(ui, 'consolidator')
  await ui.press('3')
  await waitFor(ui, f => f.includes('7 files') && (!!size || f.includes('Document body.')))
  return ui
}

const frameOf = (tui: RenderedTui): string => tui.lastFrame()

function waitFor(tui: RenderedTui, test: string | ((frame: string) => boolean), timeoutMs = 3000): Promise<string> {
  return tui.waitFor(test, timeoutMs)
}

/** Move the tree cursor down until the highlighted row's key ends with `name`. */
async function cursorTo(tui: RenderedTui, name: string) {
  const cursor = () => (store.getState().viewState.files as { agents?: Record<string, { cursor?: string }> } | undefined)?.agents?.[AGENT_1_ID]?.cursor ?? 'doc:'
  for (let i = 0; i < 20; i++) {
    if (cursor().endsWith(name.replace(/\/$/, ''))) return
    await tui.press(KEY.down)
  }
  throw new Error(`cursor never reached ${name}`)
}

async function runSlash(tui: RenderedTui, text: string) {
  if (store.getState().focus !== 'input') await tui.press(KEY.tab)
  await tui.type(text)
  await tui.press(KEY.enter)
}

describe('files view', () => {
  it('shows document + mind pinned over the tree, with markers, sizes and a live preview', async () => {
    const tui = await mountFiles()
    const frame = frameOf(tui)
    expect(frame).toMatch(/Files .*Inbox 0?.*Outbox .*Meta/)
    expect(frame).toContain('document agent document')
    expect(frame).toContain('mind memory')
    expect(frame).toMatch(/notes\/ +2 /)
    expect(frame).toMatch(/q3\.md +A /)
    expect(frame).toMatch(/api\.md +ro /)
    expect(frame).toMatch(/1 # agent-1/)

    await tui.press(KEY.down)
    await waitFor(tui, 'cursor is opaque')
    await cursorTo(tui, 'logo.png')
    const png = await waitFor(tui, 'Binary (image/png)')
    expect(png).toMatch(/00000000 {2}89 50 4e 47/)
    await cursorTo(tui, 'config.json')
    const json = await waitFor(tui, 'pretty-printed')
    expect(json).toContain('"pageSize": 50,')
  })

  it('collapses folders, filters with /, and searches inside the viewer', async () => {
    const tui = await mountFiles()
    await cursorTo(tui, 'notes/')
    await tui.press(KEY.left)
    await waitFor(tui, f => !f.includes('q3.md'))
    await tui.press(KEY.right)
    await waitFor(tui, 'q3.md')

    await tui.press('/')
    await tui.type('q3')
    const filtered = await waitFor(tui, '1 match')
    expect(filtered).toContain('notes/2026/q3.md')
    expect(filtered).not.toContain('api.md')
    await tui.press(KEY.enter)
    await tui.press(KEY.enter)
    await waitFor(tui, 'ship the standings API')
    await tui.press('/')
    await tui.type('opaque')
    await tui.press(KEY.enter)
    const found = await waitFor(tui, '/opaque  1/1')
    expect(found).toContain('keep the cursor opaque')
    await tui.press(KEY.esc)
    await tui.press(KEY.esc)
    await waitFor(tui, f => f.includes('› ') && f.includes('notes/2026/q3.md'))
  })

  it('edits the mind in $VISUAL and writes it back after a diff-summary confirm', async () => {
    const tui = await mountFiles()
    writeFileSync(editorGo, 'append')
    await tui.press(KEY.down)
    await tui.press('e')
    const confirm = await waitFor(tui, 'Save mind', 8000)
    expect(confirm).toContain('+1 -0 lines')
    expect(confirm).toContain('- added by the owner')
    expect(readFileSync(editorLog, 'utf-8')).toMatch(/mind\.md$/)
    await tui.press('y')
    await waitFor(tui, 'Saved mind')
    expect(fixture.text('agent-1', 'mind.md')).toBe('- prefers v2\n- cursor is opaque\n- added by the owner')
    await waitFor(tui, 'added by the owner')
    expect(existsSync(readFileSync(editorLog, 'utf-8'))).toBe(false)
  }, 15000)

  it('warns about a concurrent change and keeps the edit when discarded', async () => {
    const tui = await mountFiles()
    await cursorTo(tui, 'api.md')
    await tui.press('e')
    const deadline = Date.now() + 5000
    while (!existsSync(editorLog) && Date.now() < deadline) await new Promise(r => setTimeout(r, 20))
    fixture.put('agent-1', 'notes/api.md', '# API notes\nv2 is frozen.\nv3 planned.')
    writeFileSync(editorGo, 'append')
    const warning = await waitFor(tui, 'Concurrent change', 8000)
    expect(warning).toContain('changed while you were editing')
    await tui.press('n')
    const kept = await waitFor(tui, 'Not written')
    expect(kept).toContain('kept at')
    expect(fixture.text('agent-1', 'notes/api.md')).toBe('# API notes\nv2 is frozen.\nv3 planned.')
    expect(existsSync(readFileSync(editorLog, 'utf-8'))).toBe(true)
  }, 15000)

  it('reports an unchanged edit and a failed editor without writing', async () => {
    const tui = await mountFiles()
    writeFileSync(editorGo, 'keep')
    await tui.press('e')
    await waitFor(tui, 'No changes to document', 8000)
    writeFileSync(editorGo, 'fail')
    await tui.press('e')
    await waitFor(tui, 'Editor exited with code 3', 8000)
    expect(fixture.requests.filter(r => r.startsWith('PUT'))).toEqual([])
  }, 15000)

  it('creates, renames, protects and deletes files with visible confirmations', async () => {
    const tui = await mountFiles()
    writeFileSync(editorGo, 'append')
    await tui.press('n')
    await waitFor(tui, 'New file')
    await tui.type('ideas.md')
    await tui.press(KEY.enter)
    await waitFor(tui, 'Create ideas.md', 8000)
    await tui.press('y')
    await waitFor(tui, 'Created ideas.md')
    expect(fixture.text('agent-1', 'ideas.md')).toBe('\n- added by the owner')

    await cursorTo(tui, 'ideas.md')
    await tui.press('m')
    await waitFor(tui, 'Rename / move file')
    for (let i = 0; i < 'ideas.md'.length; i++) await tui.press('\u007f')
    await tui.type('notes/ideas.md')
    await tui.press(KEY.enter)
    await waitFor(tui, 'Renamed ideas.md to notes/ideas.md')

    await cursorTo(tui, 'ideas.md')
    await tui.press('p')
    await waitFor(tui, 'protection none -> read_only')
    expect(fixture.data('agent-1').files.find(f => f.path === 'notes/ideas.md')?.protection).toBe('read_only')
    await tui.press('p')
    await tui.press('p')
    await waitFor(tui, 'protection no_delete -> none')

    await tui.press('d')
    await waitFor(tui, 'Delete file')
    await tui.press('y')
    await waitFor(tui, 'Deleted notes/ideas.md')
    expect(fixture.text('agent-1', 'notes/ideas.md')).toBeUndefined()
  }, 20000)

  it('opens files, the document and the mind from slash commands (fuzzy)', async () => {
    const tui = await mountFiles()
    await runSlash(tui, '/open nq3')
    await waitFor(tui, 'ship the standings API')
    expect(store.getState().viewState.files).toMatchObject({ pane: 'viewer', agents: { [AGENT_1_ID]: { open: 'file:notes/2026/q3.md' } } })
    await runSlash(tui, '/mind')
    await waitFor(tui, 'cursor is opaque')
    await runSlash(tui, '/open zzzz')
    await waitFor(tui, 'No file in the agent matches "zzzz"')
  })

  it('reloads the open file when an inner loop writes it', async () => {
    const tui = await mountFiles()
    await tui.press(KEY.down)
    await waitFor(tui, 'cursor is opaque')
    fixture.put('agent-1', 'mind.md', '- prefers v2\n- consolidated fact')
    mock.emit({ event_type: 'file.written', agent_id: AGENT_1_ID, loop: 'consolidator', payload: { path: 'mind.md', bytes: 30 } })
    const frame = await waitFor(tui, 'consolidated fact')
    expect(frame).toMatch(/Updated by agent-1 \(↻ consolidator\)/)
  })

  it('shows inbox, outbox and meta as read-only tabs', async () => {
    const tui = await mountFiles()
    await tui.press(']')
    const inbox = await waitFor(tui, 'Standings sync')
    expect(inbox).toContain('unread')
    expect(inbox).toContain('read-only')
    await tui.press(KEY.down)
    await tui.press(KEY.enter)
    await waitFor(tui, 'Can you share the **v2** cursor format?')
    await tui.press(KEY.esc)
    await tui.press('f')
    await waitFor(tui, f => f.includes('1 unread') && !f.includes('Thanks, got it.'))
    await tui.press(']')
    await waitFor(tui, 'Re: Standings sync')
    await tui.press(']')
    const meta = await waitFor(tui, 'standings.cursor')
    expect(meta).toContain('readonly')
    await tui.press(KEY.down)
    await waitFor(tui, '"page": 3,')
    await tui.press(']')
    await waitFor(tui, '7 files')
  })

  it('works as a single pane in a narrow terminal', async () => {
    const tui = await mountFiles({ columns: 64, rows: 24 })
    await cursorTo(tui, 'api.md')
    await tui.press(KEY.enter)
    const viewer = await waitFor(tui, 'v2 is frozen.')
    expect(viewer).not.toContain('agent document')
    await tui.press(KEY.esc)
    await waitFor(tui, 'agent document')
  })
})

void React
