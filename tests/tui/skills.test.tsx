import React from 'react'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { App } from '../../src/main/tui/app/App'
import { createTheme } from '../../src/main/tui/app/theme'
import { DaemonClient } from '../../src/main/tui/api/client'
import { createTuiStore, type TuiStore } from '../../src/main/tui/state/store'
import { setSkillsFetchSeams } from '../../src/main/tui/skills/catalog'
import { collectCommands } from '../../src/main/tui/commands/registry'
import { BUILTIN_COMMANDS } from '../../src/main/tui/commands/builtin/index'
import { VIEWS } from '../../src/main/tui/views/registry'
import { startMockDaemon, type MockDaemon } from './fixtures/mock-daemon'
import { createFilesFetch, type FilesFixture } from './fixtures/files-daemon'
import { renderTui, type RenderedTui } from './fixtures/render'

const KEY = { enter: '\r', esc: '\u001b', down: '\u001b[B', up: '\u001b[A', backspace: '\u007f' }

const skillMd = (name: string, description: string, body: string) => `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`

const CATALOG_URL = 'https://catalog.test/registry.json'
const CATALOG = [
  { name: 'pdf-tools', description: 'Read and fill PDF forms', raw_url: 'https://catalog.test/skills/pdf-tools/SKILL.md', files: [{ path: 'scripts/fill.py', raw_url: 'https://catalog.test/skills/pdf-tools/scripts/fill.py' }] },
  { name: 'standup', description: 'Write the daily standup from the inbox', raw_url: 'https://catalog.test/skills/standup/SKILL.md' },
]
const REMOTE: Record<string, string> = {
  'https://catalog.test/skills/pdf-tools/SKILL.md': skillMd('pdf-tools', 'Read and fill PDF forms', '# PDF tools\n\nRun `scripts/fill.py` with the form.'),
  'https://catalog.test/skills/pdf-tools/scripts/fill.py': 'print("fill")\n',
  'https://catalog.test/skills/standup/SKILL.md': skillMd('standup', 'Write the daily standup from the inbox', '# Standup'),
}

let mock: MockDaemon
let fixture: FilesFixture
let store: TuiStore
let ui: RenderedTui | null = null
let writes: string[]
let scratch: string
const savedVisual = process.env.VISUAL

/** What the daemon's skill indexer does after a workspace write: rewrite skills-registry.json. */
function reindex(agent: string) {
  const data = fixture.data(agent)
  const state = fixture.text(agent, 'skills-state.json')
  const disabled: string[] = state ? JSON.parse(state).disabled ?? [] : []
  const skills: Record<string, unknown> = {}
  for (const f of data.files) {
    const m = /^skills\/([^/]+)\/SKILL\.md$/.exec(f.path)
    if (!m) continue
    const text = f.content.toString('utf-8')
    const name = /\nname:\s*(.+)/.exec(text)?.[1]?.trim()
    const description = /\ndescription:\s*(.+)/.exec(text)?.[1]?.trim()
    if (name !== m[1] || !description) continue
    skills[name] = { name, description, path: f.path, enabled: !disabled.includes(name) }
  }
  const registry = JSON.stringify({ schema: 1, skills, rejected: [] }, null, 2)
  const existing = data.files.find(f => f.path === 'skills-registry.json')
  if (existing) existing.content = Buffer.from(registry)
  else fixture.put(agent, 'skills-registry.json', registry)
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'adf-skills-ui-'))
  const script = join(scratch, 'editor.cjs')
  writeFileSync(script, "require('fs').appendFileSync(process.argv[2], '\\nEdited by the owner.')\n")
  process.env.VISUAL = `"${process.execPath}" "${script}"`
  const pkg = join(scratch, 'notes-helper')
  mkdirSync(join(pkg, 'refs'), { recursive: true })
  writeFileSync(join(pkg, 'SKILL.md'), skillMd('notes-helper', 'Keep notes tidy', '# Notes helper\n\nSee refs/style.md.'))
  writeFileSync(join(pkg, 'refs', 'style.md'), '# Style')
})

afterAll(() => {
  if (savedVisual === undefined) delete process.env.VISUAL
  else process.env.VISUAL = savedVisual
  rmSync(scratch, { recursive: true, force: true })
})

beforeEach(async () => {
  setSkillsFetchSeams({
    catalog: async url => (url === CATALOG_URL ? { ok: true, entries: CATALOG, publisher: 'Catalog Test', dropped: 0 } : { ok: false, error: 'HTTP 404' }),
    text: async url => (REMOTE[url] !== undefined ? { ok: true, content: REMOTE[url] } : { ok: false, error: 'HTTP 404' }),
  })
  mock = await startMockDaemon({ stepMs: 5 })
  writes = []
  const settings: Record<string, unknown> = { skillCatalogSources: [CATALOG_URL] }
  let files: FilesFixture
  const next: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const m = url.pathname.match(/^\/settings\/(.+)$/)
    if (m) {
      const key = decodeURIComponent(m[1])
      if ((init?.method ?? 'GET') === 'PUT') settings[key] = JSON.parse(String(init?.body)).value
      return new Response(JSON.stringify({ key, value: settings[key] ?? null }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return globalThis.fetch(input, init)
  }
  files = createFilesFetch(mock, next)
  fixture = files
  const withIndexer: typeof fetch = async (input, init) => {
    const response = await files.fetch(input, init)
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = (init?.method ?? 'GET').toUpperCase()
    const m = url.pathname.match(/^\/agents\/([^/]+)\/files\/content$/)
    if (m && (method === 'PUT' || method === 'DELETE')) {
      writes.push(`${method} ${url.searchParams.get('path')}`)
      reindex(decodeURIComponent(m[1]))
    }
    return response
  }
  fixture.put('agent-1', 'skills/summarize/SKILL.md', skillMd('summarize', 'Summarize long threads', '# Summarize\n\n- read the thread\n- write **three** bullets'))
  fixture.put('agent-1', 'skills/translate/SKILL.md', skillMd('translate', 'Translate messages', '# Translate'))
  fixture.put('agent-1', 'skills-state.json', JSON.stringify({ schema: 1, disabled: ['translate'] }))
  reindex('agent-1')
  store = createTuiStore({ client: new DaemonClient({ baseUrl: mock.url, fetch: withIndexer }) })
})

afterEach(async () => {
  setSkillsFetchSeams(null)
  ui?.unmount()
  ui = null
  store.stop()
  await mock.close()
})

async function mount(columns = 120, rows = 34) {
  ui = renderTui(<App store={store} theme={createTheme({ mono: true })} />, { columns, rows })
  await store.start()
  await ui.waitFor(() => store.getState().agentOrder.length > 0 && !!store.getState().selectedAgentId)
  return ui
}

async function slash(tui: RenderedTui, text: string) {
  store.actions.prefillPrompt('')
  await tui.waitFor(() => store.getState().focus === 'input')
  await new Promise(resolve => setTimeout(resolve, 40))
  await tui.type(text)
  await tui.waitFor(text)
  await tui.press(KEY.enter)
}

describe('/skills', () => {
  it('registers /skills without a registry conflict', () => {
    const registry = collectCommands(VIEWS, [BUILTIN_COMMANDS])
    expect(registry.conflicts).toEqual([])
    expect(registry.find('skills')?.view).toBe('builtin')
    expect(registry.actions.filter(a => a.id.startsWith('skills.')).map(a => a.id)).toEqual(['skills.open', 'skills.add'])
  })

  it('lists installed skills with description, token estimate and muted state; previews; mutes', async () => {
    const tui = await mount()
    await slash(tui, '/skills')
    let frame = await tui.waitFor('Summarize long threads')
    expect(frame).toContain('Skills · agent-1')
    expect(frame).toContain('2 skills, 1 muted')
    expect(frame).toMatch(/summarize\s.*~\d+ tok/)
    expect(frame).toMatch(/translate\s+muted/)
    expect(frame).toContain('muted: description removed from context')
    expect(frame).toContain('never authority')

    await tui.press(KEY.enter)
    frame = await tui.waitFor('three')
    expect(frame).toContain('skills/summarize/SKILL.md')
    expect(frame).toContain('description')
    expect(frame).not.toContain('**three**')
    await tui.press(KEY.esc)
    await tui.waitFor('2 skills, 1 muted')

    await tui.press(' ')
    await tui.waitFor('2 skills, 2 muted')
    await tui.waitFor(() => JSON.parse(fixture.text('agent-1', 'skills-state.json')!).disabled.includes('summarize'))
    expect(JSON.parse(fixture.text('agent-1', 'skills-state.json')!)).toEqual({ schema: 1, disabled: ['summarize', 'translate'] })
    await tui.press(KEY.down)
    await tui.press(' ')
    await tui.waitFor(() => !JSON.parse(fixture.text('agent-1', 'skills-state.json')!).disabled.includes('translate'))
    await tui.waitFor('2 skills, 1 muted')
  })

  it('scrolls a long SKILL.md in place', async () => {
    const body = ['# Long', '', ...Array.from({ length: 60 }, (_, i) => `- step ${i + 1}`)].join('\n')
    fixture.put('agent-1', 'skills/summarize/SKILL.md', skillMd('summarize', 'Summarize long threads', body))
    const tui = await mount()
    await slash(tui, '/skills summarize')
    let frame = await tui.waitFor('step 3')
    expect(frame).not.toContain('step 40')
    expect(frame).toMatch(/1-\d+ of \d+ lines/)
    await tui.press('G')
    frame = await tui.waitFor('step 60')
    expect(frame).not.toContain('description Summarize')
    await tui.press('g')
    await tui.waitFor('description Summarize')
    await tui.press(KEY.esc)
    await tui.waitFor(() => store.getState().overlays.length === 0)
  })

  it('removes a skill after a confirm, SKILL.md first', async () => {
    const tui = await mount()
    fixture.put('agent-1', 'skills/summarize/refs/a.md', '# a')
    await slash(tui, '/skills')
    await tui.waitFor('Summarize long threads')
    await tui.press('d')
    await tui.waitFor('Remove summarize')
    await tui.press('y')
    await tui.waitFor(() => !fixture.text('agent-1', 'skills/summarize/SKILL.md'))
    expect(writes.filter(w => w.startsWith('DELETE'))).toEqual(['DELETE skills/summarize/SKILL.md', 'DELETE skills/summarize/refs/a.md'])
    const frame = await tui.waitFor('1 skill, 1 muted')
    expect(frame).toContain('Skills · agent-1')
  })

  it('edits SKILL.md in $EDITOR through the files write path', async () => {
    const tui = await mount()
    await slash(tui, '/skills')
    await tui.waitFor('Summarize long threads')
    await tui.press('e')
    await tui.waitFor('Save skills/summarize/SKILL.md')
    await tui.press('y')
    await tui.waitFor(() => (fixture.text('agent-1', 'skills/summarize/SKILL.md') ?? '').includes('Edited by the owner.'))
    await tui.waitFor('Skills · agent-1')
  })

  it('adds from the catalog: type to filter, preview, install (resources first, SKILL.md last)', async () => {
    const tui = await mount()
    await slash(tui, '/skills')
    await tui.waitFor('Summarize long threads')
    await tui.press('a')
    let frame = await tui.waitFor('Read and fill PDF forms')
    expect(frame).toContain('Catalog Test: 2 loaded')
    expect(frame).toContain('standup')
    await tui.type('stand')
    frame = await tui.waitFor('1 of 2 skills')
    expect(frame).not.toContain('pdf-tools')
    for (let i = 0; i < 5; i++) await tui.press(KEY.backspace)
    await tui.waitFor('2 skills')
    await tui.type('pdf')
    await tui.waitFor('1 of 2 skills')
    await tui.press(KEY.enter)
    frame = await tui.waitFor('Run scripts/fill.py')
    expect(frame).toContain('Also installs 1 file under skills/pdf-tools/: scripts/fill.py')
    expect(fixture.text('agent-1', 'skills/pdf-tools/SKILL.md')).toBeUndefined()
    await tui.press(KEY.enter)
    await tui.waitFor('Installed in agent-1')
    expect(writes.filter(w => w.includes('pdf-tools'))).toEqual(['PUT skills/pdf-tools/scripts/fill.py', 'PUT skills/pdf-tools/SKILL.md'])
    expect(fixture.text('agent-1', 'skills/pdf-tools/SKILL.md')).toBe(REMOTE['https://catalog.test/skills/pdf-tools/SKILL.md'])
    await tui.press(KEY.esc)
    frame = await tui.waitFor('installed')
    await tui.press(KEY.esc)
    await tui.press(KEY.esc)
    await tui.waitFor('3 skills, 1 muted')
  })

  it('/skills add <name> jumps straight to that catalog entry', async () => {
    const tui = await mount()
    await slash(tui, '/skills add standup')
    const frame = await tui.waitFor('Write the daily standup from the inbox')
    expect(frame).toContain('standup')
    await tui.press(KEY.enter)
    await tui.waitFor(() => !!fixture.text('agent-1', 'skills/standup/SKILL.md'))
  })

  it('/skills add <folder> previews and installs a package from disk', async () => {
    const tui = await mount()
    await slash(tui, `/skills add ${join(scratch, 'notes-helper')}`)
    const frame = await tui.waitFor('See refs/style.md')
    expect(frame).toContain('notes-helper')
    expect(frame).toContain('local')
    expect(frame).toContain('refs/style.md')
    await tui.press(KEY.enter)
    await tui.waitFor(() => !!fixture.text('agent-1', 'skills/notes-helper/SKILL.md'))
    expect(fixture.text('agent-1', 'skills/notes-helper/refs/style.md')).toBe('# Style')
    await tui.press(KEY.esc)
    await tui.waitFor(() => store.getState().overlays.length === 0)
  })

  it.each([[80, 24], [120, 34]])('fits %ix%i: list, preview, catalog, package', async (columns, rows) => {
    const tui = await mount(columns, rows)
    const frames: string[] = []
    const keep = (frame: string) => {
      frames.push(frame)
      const lines = frame.split('\n')
      expect(lines.length).toBeLessThanOrEqual(rows)
      for (const line of lines) expect(line.length).toBeLessThanOrEqual(columns)
      // The dialog's bottom border is on screen (it does not run off the body).
      expect(frame).toMatch(/╰─+╯/)
    }
    await slash(tui, '/skills')
    keep(await tui.waitFor('Summarize long threads'))
    expect(frames[0]).toContain('Enter preview')
    await tui.press(KEY.enter)
    keep(await tui.waitFor('three'))
    await tui.press(KEY.esc)
    await tui.press('a')
    keep(await tui.waitFor('Read and fill PDF forms'))
    await tui.press(KEY.enter)
    keep(await tui.waitFor('Run scripts/fill.py'))
    if (process.env.ADF_SKILLS_FRAMES) writeFileSync(join(process.env.ADF_SKILLS_FRAMES, `skills-${columns}x${rows}.txt`), frames.join('\n\n'))
  })
})
