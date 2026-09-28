// Files-view fixture: a fetch wrapper that serves the agent-data routes the
// shared mock daemon does not (document/mind writes, file CRUD, protection,
// authorized, inbox, outbox, meta) from in-memory state, and forwards every
// other request (agents, loops, SSE) to the mock daemon.

import type { MockDaemon } from './mock-daemon'

export interface FixtureFile {
  path: string
  content: Buffer
  mime: string
  protection: 'none' | 'read_only' | 'no_delete'
  authorized: boolean
  updated_at: string
}

export interface FixtureAgentData {
  files: FixtureFile[]
  inbox: Array<Record<string, unknown>>
  outbox: Array<Record<string, unknown>>
  meta: Array<{ key: string; value: string; protection: string }>
}

export interface FilesFixture {
  fetch: typeof fetch
  /** Data of an agent (by id or handle). */
  data(agent: string): FixtureAgentData
  text(agent: string, path: string): string | undefined
  /** Write a file as if the agent did it (no event; call mock.emit for that). */
  put(agent: string, path: string, content: string): void
  requests: string[]
}

// 1x1 transparent PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

const mimeOf = (path: string) =>
  path.endsWith('.md') ? 'text/markdown' : path.endsWith('.json') ? 'application/json' : path.endsWith('.png') ? 'image/png' : 'text/plain'

function file(path: string, content: string | Buffer, protection: FixtureFile['protection'] = 'none', authorized = false): FixtureFile {
  return { path, content: Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8'), mime: mimeOf(path), protection, authorized, updated_at: new Date().toISOString() }
}

export function createFilesFetch(mock: MockDaemon, next: typeof fetch = globalThis.fetch.bind(globalThis)): FilesFixture {
  const byId = new Map<string, FixtureAgentData>()
  const requests: string[] = []
  const t = Date.now() - 30 * 60_000

  for (const agent of mock.agents.values()) {
    const files = agent.files.map(f => file(f.path, f.content, f.path === 'document.md' || f.path === 'mind.md' ? 'no_delete' : f.protection as FixtureFile['protection']))
    const data: FixtureAgentData = { files, inbox: [], outbox: [], meta: [{ key: 'adf_handle', value: agent.handle, protection: 'readonly' }] }
    if (agent.handle === 'agent-1') {
      data.files.push(
        file('notes/2026/q3.md', '# Q3\n\n- ship the standings API\n- keep the cursor opaque\n', 'none', true),
        file('data/config.json', '{"pageSize":50,"cursor":"opaque","tags":["v2","frozen"]}'),
        file('assets/logo.png', PNG),
        file('scripts/run.ts', "// entry\nconst greeting = 'hello'\nconsole.log(greeting)\n"),
      )
      data.inbox.push(
        { id: 'msg_1', from: 'did:key:z6MkAgent2', sender_alias: 'agent-2', subject: 'Standings sync', content: 'Can you share the **v2** cursor format?', received_at: t, status: 'unread' },
        { id: 'msg_2', from: 'did:key:z6MkAgent2', sender_alias: 'agent-2', content: 'Thanks, got it.', received_at: t + 60_000, status: 'read' },
      )
      data.outbox.push(
        { id: 'out_1', from: 'did:key:z6MkAgent1', to: 'did:key:z6MkAgent2', recipient_alias: 'agent-2', subject: 'Re: Standings sync', content: 'The cursor is opaque base64.', created_at: t + 30_000, delivered_at: t + 31_000, status: 'delivered' },
      )
      data.meta.push({ key: 'standings.cursor', value: '{"page":3,"since":"2026-09-01"}', protection: 'none' })
    }
    byId.set(agent.id, data)
  }

  const resolve = (agent: string) => {
    const found = mock.agents.get(agent) ?? [...mock.agents.values()].find(a => a.handle === agent || a.name === agent)
    return found ? byId.get(found.id) : undefined
  }
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  const findFile = (data: FixtureAgentData, path: string | null) => data.files.find(f => f.path === path)
  const listEntry = (f: FixtureFile) => ({ path: f.path, size: f.content.length, mime_type: f.mime, protection: f.protection, authorized: f.authorized, created_at: f.updated_at, updated_at: f.updated_at })
  const write = (data: FixtureAgentData, path: string, content: Buffer, protection?: FixtureFile['protection']) => {
    const existing = findFile(data, path)
    if (existing) {
      existing.content = content
      existing.updated_at = new Date().toISOString()
    } else {
      data.files.push({ ...file(path, content), protection: protection ?? 'none' })
    }
  }

  const handle = async (url: URL, method: string, body: Record<string, unknown> | undefined): Promise<Response | null> => {
    const m = url.pathname.match(/^\/agents\/([^/]+)\/(document|mind|files(?:\/content|\/rename|\/rename-folder|\/protection|\/authorized)?|inbox|outbox|meta)$/)
    if (!m) return null
    const agentId = decodeURIComponent(m[1])
    const data = resolve(agentId)
    if (!data) return json(404, { error: `Unknown agent "${agentId}"` })
    const route = `${method} ${m[2]}`
    const path = url.searchParams.get('path')
    switch (route) {
      case 'GET document': return json(200, { agentId, content: findFile(data, 'document.md')?.content.toString('utf-8') ?? '' })
      case 'PUT document': write(data, 'document.md', Buffer.from(String(body?.content ?? ''), 'utf-8'), 'no_delete'); return json(200, { agentId, success: true })
      case 'GET mind': return json(200, { agentId, content: findFile(data, 'mind.md')?.content.toString('utf-8') ?? '' })
      case 'PUT mind': write(data, 'mind.md', Buffer.from(String(body?.content ?? ''), 'utf-8'), 'no_delete'); return json(200, { agentId, success: true })
      case 'GET files': return json(200, { agentId, files: data.files.map(listEntry) })
      case 'GET files/content': {
        const f = findFile(data, path)
        if (!f) return json(404, { error: 'File not found' })
        const binary = f.mime === 'image/png'
        return json(200, { agentId, ...listEntry(f), mime_type: f.mime, encoding: binary ? 'base64' : 'utf-8', ...(binary ? { content_base64: f.content.toString('base64') } : { content: f.content.toString('utf-8') }) })
      }
      case 'PUT files/content': {
        if (!path) return json(400, { error: 'path is required' })
        if (typeof body?.content !== 'string') return json(400, { error: 'content or content_base64 is required' })
        write(data, path, Buffer.from(body.content, 'utf-8'), body.protection as FixtureFile['protection'] | undefined)
        return json(200, { agentId, success: true })
      }
      case 'DELETE files/content': {
        const f = findFile(data, path)
        if (!f || f.protection === 'no_delete' || f.protection === 'read_only') return json(200, { agentId, success: false })
        data.files.splice(data.files.indexOf(f), 1)
        return json(200, { agentId, success: true })
      }
      case 'POST files/rename': {
        const f = findFile(data, String(body?.oldPath))
        if (!f || findFile(data, String(body?.newPath))) return json(200, { agentId, success: false })
        f.path = String(body?.newPath)
        return json(200, { agentId, success: true })
      }
      case 'POST files/rename-folder': {
        const from = `${String(body?.oldPrefix)}/`
        let count = 0
        for (const f of data.files) {
          if (f.path.startsWith(from)) { f.path = `${String(body?.newPrefix)}/${f.path.slice(from.length)}`; count++ }
        }
        return json(200, { agentId, success: true, count })
      }
      case 'PATCH files/protection': {
        const f = findFile(data, String(body?.path))
        if (!f) return json(200, { agentId, success: false })
        f.protection = body?.protection as FixtureFile['protection']
        return json(200, { agentId, success: true })
      }
      case 'PATCH files/authorized': {
        const f = findFile(data, String(body?.path))
        if (!f) return json(200, { agentId, success: false })
        f.authorized = body?.authorized === true
        return json(200, { agentId, success: true })
      }
      case 'GET inbox': {
        const status = url.searchParams.get('status')
        return json(200, { agentId, messages: data.inbox.filter(msg => !status || msg.status === status) })
      }
      case 'GET outbox': {
        const status = url.searchParams.get('status')
        return json(200, { agentId, messages: data.outbox.filter(msg => !status || msg.status === status) })
      }
      case 'GET meta': return json(200, { agentId, entries: data.meta })
      default: return json(404, { error: `Unknown route ${route}` })
    }
  }

  const wrapped: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = (init?.method ?? 'GET').toUpperCase()
    let body: Record<string, unknown> | undefined
    if (typeof init?.body === 'string' && init.body.trim()) {
      try { body = JSON.parse(init.body) as Record<string, unknown> } catch { body = undefined }
    }
    const response = await handle(url, method, body)
    if (response) {
      requests.push(`${method} ${url.pathname}${url.search}`)
      return response
    }
    return next(input, init)
  }

  return {
    fetch: wrapped,
    requests,
    data: agent => {
      const data = resolve(agent)
      if (!data) throw new Error(`No fixture data for ${agent}`)
      return data
    },
    text: (agent, path) => resolve(agent)?.files.find(f => f.path === path)?.content.toString('utf-8'),
    put: (agent, path, content) => {
      const data = resolve(agent)
      if (data) write(data, path, Buffer.from(content, 'utf-8'))
    },
  }
}
