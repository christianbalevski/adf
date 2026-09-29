import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { App } from '../../src/main/tui/app/App'
import { createTheme } from '../../src/main/tui/app/theme'
import { DaemonClient } from '../../src/main/tui/api/client'
import { createTuiStore, type TuiStore } from '../../src/main/tui/state/store'
import { BUILTIN_COMMANDS } from '../../src/main/tui/commands/builtin'
import { copyName, detailLines, nameProblem, reviewLines, sortTemplates, templateTags, type TemplateDetail } from '../../src/main/tui/templates/model'
import { editTemplateConfig, editTemplateInstructions, editTemplateSeedFile } from '../../src/main/tui/templates/ops'
import { startMockDaemon, type MockDaemon } from './fixtures/mock-daemon'
import { createIdentityFetch, type IdentityMockOptions } from './fixtures/identity-daemon'
import { validConfig } from './fixtures/inspect-daemon'
import { createTemplatesFetch, type TemplatesMock, type TemplatesMockOptions } from './fixtures/templates-daemon'
import { renderTui, type RenderedTui } from './fixtures/render'

const KEY = { enter: '\r', esc: '\u001b', down: '\u001b[B', ctrlS: '\u0013' }

let mock: MockDaemon | null = null
let store: TuiStore | null = null
let ui: RenderedTui | null = null

afterEach(async () => {
  ui?.unmount()
  ui = null
  store?.stop()
  store = null
  await mock?.close()
  mock = null
})

async function mount(options: { identity?: IdentityMockOptions; templates?: TemplatesMockOptions; columns?: number; rows?: number } = {}): Promise<{ tui: RenderedTui; tpl: TemplatesMock; store: TuiStore }> {
  mock = await startMockDaemon({ stepMs: 5 })
  const identity = createIdentityFetch(mock, options.identity ?? {})
  const tpl = createTemplatesFetch(options.templates ?? {}, identity.fetch)
  store = createTuiStore({ client: new DaemonClient({ baseUrl: mock.url, fetch: tpl.fetch }) })
  ui = renderTui(<App store={store} theme={createTheme({ mono: true })} />, { columns: options.columns ?? 120, rows: options.rows ?? 34 })
  await store.start()
  return { tui: ui, tpl, store }
}

async function slash(tui: RenderedTui, text: string) {
  store!.actions.prefillPrompt('')
  await tui.waitFor(() => store!.getState().focus === 'input')
  await new Promise(resolve => setTimeout(resolve, 40))
  await tui.type(text)
  await tui.waitFor(text)
  await tui.press(KEY.enter)
}

const settle = () => new Promise(resolve => setTimeout(resolve, 60))

describe('templates model', () => {
  const t = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, filePath: '', reviewed: true, modifiedAt: 0, hasHistory: false, ...extra })

  it('sorts shipped first in Studio order, then by name; tags; names', () => {
    const sorted = sortTemplates([t('zeta'), t('full-access', { shipped: 'full-access' }), t('alpha'), t('standard', { shipped: 'standard' }), t('sandboxed', { shipped: 'sandboxed' })] as never)
    expect(sorted.map(x => x.id)).toEqual(['standard', 'sandboxed', 'full-access', 'alpha', 'zeta'])
    expect(templateTags(t('standard', { shipped: 'standard', reviewed: false, hasHistory: true }) as never, 'standard').map(x => x.text)).toEqual(['default', 'shipped', 'not reviewed', 'has run'])
    expect(copyName('Research (v2)!')).toBe('Research v2 copy')
    expect(nameProblem('')).toBe('Give the template a name.')
    expect(nameProblem('a/b')).toContain('letters, digits')
    expect(nameProblem('ok name_1-2')).toBeNull()
  })

  it('review lines follow Studio’s review content', () => {
    const lines = reviewLines({
      name: 'Shared find', description: '', computeTier: 'host', autostart: true,
      identity: { agentDid: null, fileOwnerDid: null, ownerIsYou: false, scenario: 'unclaimed', needsClaim: true, sharePasswordSet: false, credentialsLocked: false, filePasswordProtected: false, seedUnavailable: false },
      tools: [{ name: 'sys_code', enabled: true, notable: true }, { name: 'fs_read', enabled: true, notable: false }],
      mcpServers: [{ name: 'gh', runLocation: 'host' }], triggers: [{ type: 'on_inbox', enabled: true, targetCount: 1 }], codeExecution: true,
      messaging: { mode: 'proactive' }, network: { wsConnections: [], serving: null, adapters: ['telegram'] }, security: { tableProtections: [] },
      provider: { configuredId: 'anthropic', modelId: 'm', status: 'missing' },
    }, 200).map(l => l.map(s => s.text).join(''))
    const text = lines.join('\n')
    expect(text).toContain('Shared find  No identity')
    expect(text).toContain('anyone could have made it')
    expect(text).toContain('Host Access')
    expect(text).toContain('! Tools     2 enabled: sys_code')
    expect(text).toContain('gh (host)')
    expect(text).toContain('! Code      Code execution enabled')
    expect(text).toContain('! Channels  telegram')
    expect(text).toContain('Yes, connects on boot')
    expect(text).toContain('Claiming gives this template a fresh identity')
  })

  it('detail lines: notes, model, tools, instructions, files', () => {
    const detail: TemplateDetail = {
      template: { id: 'research', name: 'Research', filePath: '/t/research.adf', templateDescription: 'Reads papers.', warning: 'Fetches the web.', reviewed: true, modifiedAt: 0, hasHistory: false },
      isDefault: false, defaultId: 'standard',
      contents: { config: { name: 'Research', instructions: 'Be brief.', model: { provider: 'anthropic', model_id: 'claude' }, tools: [{ name: 'fs_read', enabled: true }] } as never, files: { readme: '# R', mind: '', soul: '' }, extra: [{ path: 'a.csv', size: 2048, mime: 'text/csv' }] },
    }
    const text = detailLines(detail, 80).map(l => l.map(s => s.text).join('')).join('\n')
    for (const want of ['Reads papers.', '! Fetches the web.', 'anthropic / claude', '1 on / 1: fs_read', 'Be brief.', 'README.md', 'mind.md     empty', 'a.csv', '2.0 KB', 'except its identity and history']) expect(text).toContain(want)
  })

  it('/templates is a builtin with no name conflicts', () => {
    expect(BUILTIN_COMMANDS.commands.some(c => c.name === 'templates')).toBe(true)
  })
})

describe('/templates', () => {
  it('lists shipped first with tags, notes and warning; Enter shows details', async () => {
    const { tui } = await mount()
    await slash(tui, '/templates')
    let frame = await tui.waitFor(f => f.includes('Agent templates') && f.includes('Shared find'))
    expect(frame).toMatch(/Standard\s+\[default\] \[shipped\]/)
    expect(frame).toMatch(/Shared find\s+\[not reviewed\]/)
    expect(frame).toMatch(/Research\s+\[has run\]/)
    expect(frame.indexOf('Full access')).toBeLessThan(frame.indexOf('Research'))
    expect(frame).toContain('except its identity and history')
    await tui.press(KEY.down); await tui.press(KEY.down)
    frame = await tui.waitFor('Runs code and reaches your host without asking.')
    await tui.press(KEY.enter)
    frame = await tui.waitFor(f => f.includes('Full access template') && f.includes('Instructions'))
    expect(frame).toContain('You are Full access.')
    expect(frame).toContain('host access')
    expect(frame).toContain('README.md')
  }, 15000)

  it('make default, and delete a user template into the trash (shipped ones cannot be deleted)', async () => {
    const { tui, tpl, store } = await mount()
    await slash(tui, '/templates')
    await tui.waitFor('Shared find')
    await tui.press('d') // Standard: shipped
    await tui.waitFor('cannot be deleted here')
    expect(tpl.trash).toEqual([])
    for (let i = 0; i < 3; i++) await tui.press(KEY.down) // Research
    await tui.waitFor('Reads papers.')
    await tui.press('s')
    await tui.waitFor(f => /Research\s+\[default\]/.test(f))
    expect(tpl.state.defaultId).toBe('research')
    await tui.press('d')
    await tui.waitFor('Delete "Research"?')
    expect(store.getState().overlays.at(-1)?.kind).toBe('confirm')
    await tui.press('y')
    await tui.waitFor(f => f.includes('Agent templates') && !f.includes('Reads papers'))
    expect(tpl.trash).toEqual(['research'])
    expect(tpl.state.defaultId).toBe('standard')
    await tui.waitFor('moved to /userData/templates-trash')
  }, 15000)

  it('reviews a foreign template with the review summary and claims it', async () => {
    const { tui, tpl } = await mount()
    await slash(tui, '/templates')
    await tui.waitFor('Shared find')
    for (let i = 0; i < 4; i++) await tui.press(KEY.down)
    await tui.waitFor('Someone else’s template.')
    await tui.press('a')
    const frame = await tui.waitFor('Review · Shared find template')
    expect(frame).toContain('No identity')
    expect(frame).toContain('Code execution enabled')
    await tui.press(KEY.enter)
    await tui.waitFor(f => f.includes('Shared find template') && f.includes('is yours now'))
    expect(tpl.templates.get('shared-find')?.reviewed).toBe(true)
    expect(tpl.calls).toContain('POST /templates/shared-find/review/accept')
  }, 15000)

  it('a password-protected template asks for its password', async () => {
    const { tui, tpl } = await mount({ templates: { passwordProtected: ['shared-find'] } })
    await slash(tui, '/templates shared-find')
    await tui.waitFor('Shared find template')
    await tui.press('a')
    await tui.waitFor('Review · Shared find template')
    await tui.press(KEY.enter)
    await tui.waitFor('password-protected')
    await tui.type('pw')
    await tui.press(KEY.enter)
    await tui.waitFor('is yours now')
    expect(tpl.templates.get('shared-find')?.reviewed).toBe(true)
  }, 15000)

  it('new, duplicate, rename and notes', async () => {
    const { tui, tpl } = await mount()
    await slash(tui, '/templates')
    await tui.waitFor('Shared find')
    await tui.press('n')
    await tui.waitFor('New template')
    await tui.type('bad/name')
    await tui.press(KEY.enter)
    await tui.waitFor('Use letters, digits')
    for (let i = 0; i < 8; i++) await tui.press('\u007f')
    await tui.type('Writer')
    await tui.press(KEY.enter)
    await tui.waitFor(f => f.includes('Writer template') && f.includes('created from the defaults'))
    expect(tpl.templates.has('writer')).toBe(true)

    await tui.press('u')
    await tui.waitFor('Duplicate Writer')
    await tui.press(KEY.enter)
    await tui.waitFor('Writer copy template')
    expect(tpl.templates.has('writer-copy')).toBe(true)

    await tui.press('m')
    await tui.waitFor('Rename Writer copy')
    for (let i = 0; i < 12; i++) await tui.press('\u007f')
    await tui.type('Editor')
    await tui.press(KEY.enter)
    await tui.waitFor('Editor template')
    expect(tpl.templates.has('editor')).toBe(true)
    expect(tpl.templates.has('writer-copy')).toBe(false)

    await tui.press('t')
    await tui.waitFor('Notes · Editor')
    await tui.type('Edits drafts.')
    await tui.press(KEY.ctrlS)
    await tui.waitFor(f => f.includes('Editor template') && f.includes('Edits drafts.'))
    expect(tpl.templates.get('editor')?.templateDescription).toBe('Edits drafts.')
  }, 20000)

  it('resets a shipped template after a confirm', async () => {
    const { tui, tpl } = await mount()
    tpl.templates.get('standard')!.files.readme = 'changed'
    await slash(tui, '/templates standard')
    await tui.waitFor('Standard template')
    await tui.press('x')
    await tui.waitFor('Reset "Standard" to the version ADF ships?')
    await tui.press('y')
    await tui.waitFor('reset to the shipped version')
    expect(tpl.templates.get('standard')?.files.readme).toContain('# Standard')
  }, 15000)

  it('identity locked: says so and offers the identity dialog', async () => {
    const { tui, store } = await mount({ templates: { locked: true } })
    await slash(tui, '/templates')
    await tui.waitFor(f => f.includes('owner identity is locked') && f.includes('i owner identity'))
    await tui.press('i')
    await tui.waitFor(() => store.getState().overlays.some(o => o.kind === 'identity'))
    expect(store.getState().overlays.find(o => o.kind === 'identity')?.props).toMatchObject({ then: 'templates' })
  }, 15000)

  it('identity not ready: /templates opens the identity dialog first', async () => {
    const { tui, store } = await mount({ identity: { status: 'none' } })
    await slash(tui, '/templates')
    await tui.waitFor(() => store.getState().overlays.some(o => o.kind === 'identity'))
    expect(store.getState().overlays.find(o => o.kind === 'identity')?.props).toMatchObject({ then: 'templates' })
  }, 15000)

  it('renders at 80x24', async () => {
    const { tui } = await mount({ columns: 80, rows: 24 })
    await slash(tui, '/templates')
    const frame = await tui.waitFor('Agent templates')
    await tui.waitFor('Standard')
    expect(frame.split('\n').every(line => line.length <= 80)).toBe(true)
  }, 15000)
})

describe('template editing ($EDITOR flows)', () => {
  const noSuspend = async (run: () => void | Promise<void>) => { await run() }

  it('instructions, a seed file and the config go through the template routes', async () => {
    const { tpl, store } = await mount()
    const outcome = await editTemplateInstructions(store.actions, noSuspend, 'research', async () => ({ text: 'Cite sources.', changed: true, editor: 'fake' }))
    expect(outcome).toBe('saved')
    expect(tpl.templates.get('research')?.config.instructions).toBe('Cite sources.')
    expect(await editTemplateInstructions(store.actions, noSuspend, 'research', async text => ({ text, changed: false, editor: 'fake' }))).toBe('unchanged')

    expect(await editTemplateSeedFile(store.actions, noSuspend, 'research', 'soul', async () => ({ text: 'curious', changed: true, editor: 'fake' }))).toBe('saved')
    expect(tpl.templates.get('research')?.files.soul).toBe('curious')

    tpl.templates.get('research')!.config = validConfig('cfg-research', 'research') as never
    const edits = [(text: string) => JSON.stringify({ ...JSON.parse(text), description: 'edited' }, null, 2)]
    const outcome2 = await editTemplateConfig({ ...store.actions, confirm: async () => true }, noSuspend, 'research', async text => {
      const next = edits.shift()?.(text) ?? text
      return { text: next, changed: next !== text, editor: 'fake' }
    })
    expect(outcome2).toBe('saved')
    expect(tpl.templates.get('research')?.config.description).toBe('edited')
  }, 15000)
})
