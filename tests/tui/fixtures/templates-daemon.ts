// Agent templates on top of the mock daemon, as a chainable fetch wrapper
// (docs/daemon/http-api.md "Managing Templates"): GET/POST /templates, GET/
// PATCH/DELETE /templates/:id, POST .../default, .../reset, GET .../review,
// POST .../review/accept, PUT .../config, PUT/DELETE .../files. In-memory,
// with the daemon's rules: shipped templates reset, user ones do not; delete
// moves to a trash list; a foreign template needs review; names follow
// Studio's rule; every route answers 409 identity_not_ready while `locked`.
//
// `calls` records method + path only.

export interface TemplatesMockOptions {
  /** Every route answers 409 identity_not_ready. */
  locked?: boolean
  /** Template ids whose file is password-protected (accept needs `password: 'pw'`). */
  passwordProtected?: string[]
}

interface MockTemplate {
  id: string
  name: string
  shipped?: string
  templateDescription?: string
  warning?: string
  reviewed: boolean
  hasHistory: boolean
  scenario: 'mine' | 'foreign' | 'unclaimed'
  config: Record<string, unknown>
  files: { readme: string; mind: string; soul: string }
  extra: Array<{ path: string; size: number; mime: string; content: string }>
}

export interface TemplatesMock {
  fetch: typeof fetch
  calls: string[]
  templates: Map<string, MockTemplate>
  trash: string[]
  state: { defaultId: string; locked: boolean }
}

const SHIPPED_README = '# Standard\nA general assistant.'

function config(name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `cfg-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    name,
    description: '',
    instructions: `You are ${name}.`,
    model: { provider: 'anthropic', model_id: 'claude-sonnet' },
    tools: [{ name: 'fs_read', enabled: true }, { name: 'fs_write', enabled: true }, { name: 'sys_code', enabled: false }],
    ...over,
  }
}

function seed(): MockTemplate[] {
  return [
    { id: 'standard', name: 'Standard', shipped: 'standard', templateDescription: 'A general assistant with files, memory and messaging.', reviewed: true, hasHistory: false, scenario: 'mine', config: config('Standard'), files: { readme: SHIPPED_README, mind: '', soul: '' }, extra: [] },
    { id: 'sandboxed', name: 'Sandboxed', shipped: 'sandboxed', templateDescription: 'Runs code in its own container.', reviewed: true, hasHistory: false, scenario: 'mine', config: config('Sandboxed'), files: { readme: '', mind: '', soul: '' }, extra: [] },
    { id: 'full-access', name: 'Full access', shipped: 'full-access', templateDescription: 'Everything on.', warning: 'Runs code and reaches your host without asking.', reviewed: true, hasHistory: false, scenario: 'mine', config: config('Full access', { compute: { enabled: true, host_access: true } }), files: { readme: '', mind: '', soul: '' }, extra: [] },
    { id: 'research', name: 'Research', templateDescription: 'Reads papers.', reviewed: true, hasHistory: true, scenario: 'mine', config: config('Research'), files: { readme: '', mind: '# notes', soul: '' }, extra: [{ path: 'data/sources.csv', size: 2048, mime: 'text/csv', content: 'a,b' }] },
    { id: 'shared-find', name: 'Shared find', templateDescription: 'Someone else’s template.', reviewed: false, hasHistory: false, scenario: 'unclaimed', config: config('Shared find', { tools: [{ name: 'sys_code', enabled: true }, { name: 'fs_read', enabled: true }] }), files: { readme: '', mind: '', soul: '' }, extra: [] },
  ]
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'template'

export function createTemplatesFetch(options: TemplatesMockOptions = {}, next: typeof fetch = globalThis.fetch.bind(globalThis)): TemplatesMock {
  const templates = new Map(seed().map(t => [t.id, t]))
  const state = { defaultId: 'standard', locked: !!options.locked }
  const calls: string[] = []
  const trash: string[] = []
  const fail = (status: number, error: string, code: string) => json(status, { error, code })
  const summary = (t: MockTemplate) => ({
    id: t.id,
    name: t.name,
    filePath: `/userData/templates/${t.id}.adf`,
    ...(t.shipped ? { shipped: t.shipped } : {}),
    ...(t.templateDescription ? { templateDescription: t.templateDescription } : {}),
    ...(t.warning ? { warning: t.warning } : {}),
    reviewed: t.reviewed,
    modelProvider: (t.config.model as { provider?: string }).provider || undefined,
    modelId: (t.config.model as { model_id?: string }).model_id || undefined,
    modifiedAt: 0,
    hasHistory: t.hasHistory,
  })
  const nameProblem = (name: unknown) => typeof name !== 'string' || !name.trim() ? 'Name is required.' : !/^[A-Za-z0-9 _-]+$/.test(name.trim()) ? 'A template name can hold letters, digits, spaces, dashes and underscores.' : null

  const wrapped = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.pathname !== '/templates' && !url.pathname.startsWith('/templates/')) return next(input, init)
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
    calls.push(`${method} ${url.pathname}`)
    if (state.locked) return fail(409, 'Set up the owner identity first. The owner identity is locked.', 'identity_not_ready')
    const parts = url.pathname.split('/').slice(2).map(decodeURIComponent)
    const [id, sub, sub2] = parts

    if (!id) {
      if (method === 'GET') return json(200, { templates: [...templates.values()].map(summary), defaultId: state.defaultId, folder: '/userData/templates', defaultDirectory: '/home/owner/Documents/adf-agents' })
      if (method === 'POST') {
        const problem = nameProblem(body.name)
        if (problem) return fail(400, problem, 'template_invalid')
        const name = String(body.name).trim()
        const from = typeof body.fromId === 'string' ? templates.get(body.fromId) : undefined
        if (body.fromId !== undefined && !from) return fail(404, `${String(body.fromId)}.adf is not in the templates folder.`, 'template_missing')
        let newId = slug(name)
        for (let n = 2; templates.has(newId); n++) newId = `${slug(name)}-${n}`
        const made: MockTemplate = from
          ? { ...structuredClone(from), id: newId, name, shipped: undefined, reviewed: true, hasHistory: false, scenario: 'mine', config: { ...structuredClone(from.config), name, id: `cfg-${newId}` } }
          : { id: newId, name, reviewed: true, hasHistory: false, scenario: 'mine', config: config(name, { model: { provider: '', model_id: '' } }), files: { readme: '', mind: '', soul: '' }, extra: [] }
        templates.set(newId, made)
        return json(201, { id: newId, template: summary(made) })
      }
    }
    const t = templates.get(id)
    if (!t) return fail(404, `${id}.adf is not in the templates folder.`, 'template_missing')

    if (!sub) {
      if (method === 'GET') return json(200, { template: summary(t), isDefault: state.defaultId === t.id, defaultId: state.defaultId, contents: { config: t.config, files: t.files, extra: t.extra.map(({ path, size, mime }) => ({ path, size, mime })) } })
      if (method === 'PATCH') {
        for (const key of ['description', 'warning'] as const) {
          const value = body[key]
          if (typeof value !== 'string') continue
          const field = key === 'description' ? 'templateDescription' : 'warning'
          if (value.trim()) t[field] = value.trim()
          else delete t[field]
        }
        let outId = t.id
        if (typeof body.name === 'string' && body.name.trim() !== t.name) {
          const problem = nameProblem(body.name)
          if (problem) return fail(400, problem, 'template_invalid')
          const newId = slug(body.name)
          if (newId !== t.id && templates.has(newId)) return fail(400, `${newId}.adf is already in the templates folder.`, 'template_invalid')
          t.name = body.name.trim()
          t.config = { ...t.config, name: t.name }
          if (newId !== t.id) {
            templates.delete(t.id)
            if (state.defaultId === t.id) state.defaultId = newId
            t.id = newId
            templates.set(newId, t)
          }
          outId = newId
        }
        return json(200, { id: outId, template: summary(t) })
      }
      if (method === 'DELETE') {
        templates.delete(t.id)
        trash.push(t.id)
        if (state.defaultId === t.id) state.defaultId = 'standard'
        return json(200, { deleted: true, id: t.id, trashFolder: '/userData/templates-trash', defaultId: state.defaultId })
      }
    }
    if (sub === 'default' && method === 'POST') { state.defaultId = t.id; return json(200, { defaultId: t.id }) }
    if (sub === 'reset' && method === 'POST') {
      if (!t.shipped) return fail(400, `"${t.id}" is not a shipped template.`, 'template_invalid')
      const fresh = seed().find(s => s.shipped === t.shipped)!
      Object.assign(t, { ...fresh, id: t.id })
      return json(200, { id: t.id, template: summary(t) })
    }
    if (sub === 'review' && !sub2 && method === 'GET') {
      const enabled = (t.config.tools as Array<{ name: string; enabled: boolean }>)
      return json(200, {
        id: t.id,
        needsReview: !t.reviewed,
        reviewed: t.reviewed,
        summary: {
          name: t.name,
          description: String(t.config.description ?? ''),
          identity: { agentDid: t.scenario === 'unclaimed' ? null : 'did:key:z6MkTemplate', fileOwnerDid: null, ownerIsYou: t.scenario === 'mine', scenario: t.scenario, needsClaim: t.scenario !== 'mine', sharePasswordSet: false, credentialsLocked: false, filePasswordProtected: (options.passwordProtected ?? []).includes(t.id), seedUnavailable: false },
          computeTier: 'shared',
          autostart: false,
          tools: enabled.map(x => ({ name: x.name, enabled: x.enabled, notable: x.name === 'sys_code' })),
          mcpServers: [],
          triggers: [],
          codeExecution: enabled.some(x => x.name === 'sys_code' && x.enabled),
          messaging: { mode: 'proactive' },
          network: { wsConnections: [], serving: null, adapters: [] },
          security: { tableProtections: [] },
          provider: { configuredId: 'anthropic', modelId: 'claude-sonnet', status: 'unchecked' },
        },
      })
    }
    if (sub === 'review' && sub2 === 'accept' && method === 'POST') {
      if ((options.passwordProtected ?? []).includes(t.id)) {
        if (!body.password) return fail(400, 'This template is password-protected. Enter its password to accept it.', 'password_required')
        if (body.password !== 'pw') return fail(403, 'Wrong password', 'wrong_password')
      }
      t.reviewed = true
      t.scenario = 'mine'
      return json(200, { id: t.id, reviewed: true, template: summary(t) })
    }
    if (sub === 'config' && method === 'PUT') {
      const cfg = body.config as Record<string, unknown> | undefined
      if (!cfg || typeof cfg !== 'object') return fail(400, 'config (an object) is required', 'bad_request')
      if (!(cfg.model as { provider?: string })?.provider) return fail(400, 'model.provider: String must contain at least 1 character(s)', 'template_invalid')
      t.config = cfg
      return json(200, { id: t.id, success: true })
    }
    if (sub === 'files' && method === 'PUT') {
      const path = String(body.path ?? '')
      const content = String(body.content ?? '')
      const seedKey = path === 'README.md' ? 'readme' : path === 'mind.md' ? 'mind' : path === 'soul.md' ? 'soul' : null
      if (seedKey) t.files[seedKey] = content
      else t.extra = [...t.extra.filter(f => f.path !== path), { path, size: content.length, mime: 'text/plain', content }]
      return json(200, { id: t.id, path, success: true })
    }
    if (sub === 'files' && method === 'DELETE') {
      const path = url.searchParams.get('path') ?? ''
      if (['README.md', 'mind.md', 'soul.md'].includes(path)) return fail(400, `${path} is a seed file; clear its text instead.`, 'template_invalid')
      t.extra = t.extra.filter(f => f.path !== path)
      return json(200, { id: t.id, path, success: true })
    }
    return fail(404, `No route ${method} ${url.pathname}`, 'not_found')
  }

  return { fetch: wrapped as typeof fetch, calls, templates, trash, state }
}
