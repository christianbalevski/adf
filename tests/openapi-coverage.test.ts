/**
 * The OpenAPI contract (docs/daemon/openapi.json) must describe exactly the
 * routes the daemon registers: nothing missing, nothing stale, and the same
 * path parameters. The real route table comes from Fastify's onRoute hook,
 * attached (via a wrapped factory) before createDaemonHttpApi registers
 * anything, so every route module is covered without hand-maintained lists.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const registered = vi.hoisted(() => {
  // Keep token usage, auth sessions and settings out of the real user data dir.
  process.env.ADF_USER_DATA_DIR = `${process.env.TMPDIR ?? process.env.TEMP ?? '/tmp'}/adf-openapi-coverage-${process.pid}`
  return [] as Array<{ method: string; url: string }>
})

vi.mock('fastify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fastify')>()
  const factory = ((opts?: unknown) => {
    const app = (actual.default as (o?: unknown) => import('fastify').FastifyInstance)(opts)
    app.addHook('onRoute', (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method]
      for (const method of methods) registered.push({ method: String(method), url: route.url })
    })
    return app
  }) as unknown as typeof actual.default
  return { ...actual, default: factory, fastify: factory }
})

vi.mock('electron', () => {
  const dir = join(tmpdir(), `adf-openapi-coverage-${process.pid}`)
  return {
    app: { getPath: () => dir, on: () => {}, getName: () => 'adf-openapi-coverage', getVersion: () => '0.0.0-test' },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (s: string) => Buffer.from(s, 'utf-8'),
      decryptString: (b: Buffer) => b.toString('utf-8'),
    },
    shell: { openExternal: async () => {} },
    ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
    BrowserWindow: class {},
    dialog: {},
  }
})

import Ajv2020 from 'ajv/dist/2020'
import spec from '../docs/daemon/openapi.json'
import { createDaemonHttpApi } from '../src/main/daemon/http-api'
import { MockLLMProvider } from '../src/main/runtime/headless'
import { RuntimeService } from '../src/main/runtime/runtime-service'

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head'] as const

/**
 * Registered routes intentionally absent from the contract. Keep empty unless
 * a route is truly internal (not for API clients); comment each entry.
 */
const INTERNAL_ROUTES = new Set<string>([])

type Json = Record<string, unknown>

function toSpecPath(url: string): string {
  return url.replace(/:([A-Za-z0-9_]+)/g, '{$1}')
}

function resolveRef<T>(value: T): T {
  const ref = (value as Json | undefined)?.$ref
  if (typeof ref !== 'string') return value
  const target = ref.replace(/^#\//, '').split('/').reduce<unknown>((node, key) => (node as Json)?.[key], spec)
  if (!target) throw new Error(`Unresolved $ref ${ref}`)
  return target as T
}

function routeTable(): Map<string, { method: string; path: string }> {
  registered.length = 0
  const server = createDaemonHttpApi(new RuntimeService({ enforceReviewGate: false }))
  const table = new Map<string, { method: string; path: string }>()
  for (const route of registered) {
    // Fastify adds a HEAD route for every GET (exposeHeadRoutes).
    if (route.method === 'HEAD' && registered.some(r => r.method === 'GET' && r.url === route.url)) continue
    const path = toSpecPath(route.url)
    table.set(`${route.method} ${path}`, { method: route.method.toLowerCase(), path })
  }
  void server.close()
  return table
}

function specTable(): Map<string, { method: string; path: string; op: Json; pathItem: Json }> {
  const table = new Map<string, { method: string; path: string; op: Json; pathItem: Json }>()
  for (const [path, pathItem] of Object.entries(spec.paths as Record<string, Json>)) {
    for (const method of HTTP_METHODS) {
      const op = pathItem[method] as Json | undefined
      if (op) table.set(`${method.toUpperCase()} ${path}`, { method, path, op, pathItem })
    }
  }
  return table
}

describe('OpenAPI contract coverage', () => {
  const routes = routeTable()
  const documented = specTable()

  it('registers a meaningful route table', () => {
    // Maintenance aid: OPENAPI_DUMP_ROUTES=<file> writes the live route table.
    if (process.env.OPENAPI_DUMP_ROUTES) {
      writeFileSync(process.env.OPENAPI_DUMP_ROUTES, JSON.stringify([...routes.keys()].sort(), null, 2))
    }
    expect(routes.size).toBeGreaterThan(150)
  })

  it('documents every registered route', () => {
    const missing = [...routes.keys()].filter(key => !documented.has(key) && !INTERNAL_ROUTES.has(key)).sort()
    expect(missing).toEqual([])
  })

  it('documents no route the daemon does not register', () => {
    const stale = [...documented.keys()].filter(key => !routes.has(key)).sort()
    expect(stale).toEqual([])
  })

  it('declares exactly the path parameters of each route', () => {
    const mismatches: string[] = []
    for (const [key, { path, op, pathItem }] of documented) {
      const expected = [...path.matchAll(/\{([^}]+)\}/g)].map(m => m[1]).sort()
      const params = [...((pathItem.parameters as Json[]) ?? []), ...((op.parameters as Json[]) ?? [])]
        .map(p => resolveRef(p))
        .filter(p => p.in === 'path')
      const declared = [...new Set(params.map(p => String(p.name)))].sort()
      if (JSON.stringify(expected) !== JSON.stringify(declared)) {
        mismatches.push(`${key}: path has [${expected}] but spec declares [${declared}]`)
      }
      for (const p of params) if (p.required !== true) mismatches.push(`${key}: path param ${String(p.name)} not required`)
    }
    expect(mismatches).toEqual([])
  })

  it('gives every operation a tag, an operationId and a success response', () => {
    const tags = new Set((spec.tags as Array<{ name: string }>).map(t => t.name))
    const problems: string[] = []
    const ids = new Set<string>()
    for (const [key, { op }] of documented) {
      for (const tag of (op.tags as string[] | undefined) ?? []) if (!tags.has(tag)) problems.push(`${key}: undeclared tag ${tag}`)
      if (!(op.tags as string[] | undefined)?.length) problems.push(`${key}: no tag`)
      const id = op.operationId as string | undefined
      if (!id) problems.push(`${key}: no operationId`)
      else if (ids.has(id)) problems.push(`${key}: duplicate operationId ${id}`)
      else ids.add(id)
      const codes = Object.keys((op.responses as Json | undefined) ?? {})
      if (!codes.some(code => /^2/.test(code))) problems.push(`${key}: no 2xx response`)
    }
    expect(problems).toEqual([])
  })
})

// --- Response conformance ------------------------------------------------------
// A sample of real calls against a daemon with one agent: each answer's status
// must be documented for its operation and its JSON body must validate against
// the documented schema. Catches schemas that drift from the handlers.

const ajv = new Ajv2020({ strict: false, allErrors: true })
ajv.addSchema(spec as object, 'spec')

const pointerToken = (token: string) => encodeURIComponent(token.replace(/~/g, '~0').replace(/\//g, '~1'))

function conformance(method: string, specPath: string, status: number, body: unknown): string[] {
  const op = (spec.paths as Record<string, Json>)[specPath]?.[method.toLowerCase()] as Json | undefined
  if (!op) return [`${method} ${specPath}: not in the spec`]
  const responses = op.responses as Record<string, Json>
  const response = responses[String(status)]
  if (!response) return [`${method} ${specPath}: status ${status} is not documented (body ${JSON.stringify(body).slice(0, 200)})`]
  const media = (resolveRef(response).content as Json | undefined)?.['application/json']
  if (!media) return []
  const pointer = typeof response.$ref === 'string'
    ? `spec${response.$ref}/content/application~1json/schema`
    : `spec#/paths/${pointerToken(specPath)}/${method.toLowerCase()}/responses/${status}/content/application~1json/schema`
  const validate = ajv.getSchema(pointer) ?? ajv.compile({ $ref: pointer })
  if (validate(body)) return []
  return (validate.errors ?? []).map(e => `${method} ${specPath} ${status}: ${e.instancePath || '(root)'} ${e.message} ${JSON.stringify(e.params)}`)
}

function memorySettings() {
  const data: Record<string, unknown> = { trackedDirectories: [], providers: [] }
  return {
    filePath: join(tmpdir(), 'adf-openapi-settings.json'),
    get: (key: string) => data[key],
    set: (key: string, value: unknown) => { data[key] = value },
    getAll: () => ({ ...data }),
    update: (patch: Record<string, unknown>) => { Object.assign(data, patch) },
  }
}

describe('OpenAPI response conformance', () => {
  it('sampled responses match their documented status and schema', async () => {
    const runtime = new RuntimeService({ enforceReviewGate: false })
    const ref = runtime.createAgent({ name: 'agent-1', provider: new MockLLMProvider({ tokensPerResponse: 20 }) })
    const server = createDaemonHttpApi(runtime, { settingsStore: memorySettings() })
    const a = `/agents/${ref.id}`
    const problems: string[] = []
    const call = async (method: string, specPath: string, url: string, payload?: unknown) => {
      const res = await server.inject({ method: method as 'GET', url, ...(payload !== undefined ? { payload: payload as object } : {}) })
      const body = res.headers['content-type']?.toString().includes('application/json') ? res.json() : res.body
      // A 5xx here is a broken sample (or a daemon bug), never a pass. 503 =
      // a subsystem this bare daemon does not configure (its body is checked).
      if (res.statusCode >= 500 && res.statusCode !== 503) problems.push(`${method} ${url}: ${res.statusCode} ${JSON.stringify(body).slice(0, 200)}`)
      problems.push(...conformance(method, specPath, res.statusCode, body))
      return { status: res.statusCode, body }
    }
    const A = '/agents/{id}'
    const folder = mkdtempSync(join(tmpdir(), 'adf-openapi-tracked-'))
    try {
      const added = await call('POST', '/runtime/providers', '/runtime/providers', { type: 'openai-compatible', name: 'Local', baseUrl: 'http://127.0.0.1:1/v1' })
      await call('POST', '/tracked-dirs', '/tracked-dirs', { path: folder })
      await call('GET', '/tracked-dirs/agents', `/tracked-dirs/agents?path=${encodeURIComponent(folder)}`)
      for (const p of ['/health', '/agents', '/diagnostics', '/runtime', '/runtime/providers', '/runtime/auth', '/runtime/settings', '/runtime/mcp',
        '/runtime/adapters', '/runtime/network', '/network', '/runtime/usage', '/settings', '/tracked-dirs', '/tracked-dirs/agents/all',
        '/auth/chatgpt/status', '/auth/grok/status', '/identity', '/templates', '/compute/status', '/network/mesh', '/admin/mcp/packages']) {
        await call('GET', p, p)
      }
      await call('GET', '/settings/{key}', '/settings/meshEnabled')
      await call('PUT', '/settings/{key}', '/settings/meshEnabled', { value: true })
      await call('PUT', '/settings/{key}', '/settings/ownerDid', { value: 'did:key:x' })
      await call('PATCH', '/settings', '/settings', { meshPort: 7295 })
      await call('POST', '/runtime/token-count', '/runtime/token-count', { text: 'hello' })
      await call('POST', '/runtime/token-count/batch', '/runtime/token-count/batch', { texts: ['a', 'b c'] })
      await call('GET', '/runtime/models', '/runtime/models?provider=missing')
      await call('GET', '/tracked-dirs/agents', '/tracked-dirs/agents?path=/nowhere')

      for (const sub of ['', '/status', '/loop', '/loops', '/logs', '/tables', '/config', '/tools', '/document', '/mind', '/chat', '/files',
        '/inbox', '/outbox', '/timers', '/meta', '/usage', '/tasks', '/asks', '/identities', '/identity', '/identity/entries', '/identity/password',
        '/identity/did', '/runtime', '/runtime/adapters', '/runtime/mcp', '/runtime/triggers', '/runtime/ws', '/adapters', '/mcp', '/triggers',
        '/ws', '/context', '/umbilical/events']) {
        await call('GET', `${A}${sub}`, `${a}${sub}`)
      }
      await call('GET', `${A}/status`, '/agents/agent-9/status')
      await call('GET', `${A}/logs/after`, `${a}/logs/after?afterId=0`)
      await call('GET', `${A}/loops/{name}`, `${a}/loops/main`)
      await call('GET', `${A}/identity/{purpose}`, `${a}/identity/provider:x:apiKey`)
      await call('GET', `${A}/providers/{providerId}/credentials`, `${a}/providers/anthropic/credentials`)
      await call('GET', `${A}/mcp/credentials`, `${a}/mcp/credentials?npmPackage=@acme/server`)
      await call('GET', `${A}/adapters/credentials`, `${a}/adapters/credentials?adapterType=telegram`)

      await call('POST', `${A}/loops`, `${a}/loops`, { name: 'critic', goal: 'Review drafts.', autostart: false })
      await call('PATCH', `${A}/loops/{name}`, `${a}/loops/critic`, { enabled: false })
      await call('DELETE', `${A}/loops/{name}`, `${a}/loops/critic`)
      await call('POST', `${A}/state`, `${a}/state`, { state: 'idle' })
      await call('POST', `${A}/interrupt`, `${a}/interrupt`)
      await call('POST', `${A}/compact`, `${a}/compact`)
      await call('PUT', `${A}/document`, `${a}/document`, { content: '# Doc' })
      await call('PUT', `${A}/mind`, `${a}/mind`, { content: '# Mind' })
      await call('PUT', `${A}/files/content`, `${a}/files/content?path=notes/a.txt`, { content: 'hi' })
      await call('GET', `${A}/files/content`, `${a}/files/content?path=notes/a.txt`)
      await call('POST', `${A}/files/rename`, `${a}/files/rename`, { oldPath: 'notes/a.txt', newPath: 'notes/b.txt' })
      await call('POST', `${A}/files/rename-folder`, `${a}/files/rename-folder`, { oldPrefix: 'notes', newPrefix: 'archive' })
      await call('PATCH', `${A}/files/protection`, `${a}/files/protection`, { path: 'archive/b.txt', protection: 'none' })
      await call('PATCH', `${A}/files/authorized`, `${a}/files/authorized`, { path: 'archive/b.txt', authorized: false })
      await call('DELETE', `${A}/files/content`, `${a}/files/content?path=archive/b.txt`)
      await call('PUT', `${A}/meta/{key}`, `${a}/meta/k`, { value: '1' })
      await call('PATCH', `${A}/meta/{key}/protection`, `${a}/meta/k/protection`, { protection: 'readonly' })
      await call('DELETE', `${A}/meta/{key}`, `${a}/meta/k`)
      const timer = await call('POST', `${A}/timers`, `${a}/timers`, { mode: 'once_delay', delay_ms: 3_600_000, scope: ['agent'] })
      const timerId = (timer.body as { id?: number }).id ?? 1
      await call('PUT', `${A}/timers/{timerId}`, `${a}/timers/${timerId}`, { mode: 'once_delay', delay_ms: 7_200_000 })
      await call('DELETE', `${A}/timers/{timerId}`, `${a}/timers/${timerId}`)
      await call('PUT', `${A}/identity/{purpose}`, `${a}/identity/custom:token`, { value: 'secret' })
      await call('PATCH', `${A}/identity/{purpose}/code-access`, `${a}/identity/custom:token/code-access`, { codeAccess: true })
      await call('DELETE', `${A}/identity/{purpose}`, `${a}/identity/custom:token`)
      await call('DELETE', `${A}/identity-prefix`, `${a}/identity-prefix?prefix=custom:`)
      await call('POST', `${A}/providers`, `${a}/providers`, { provider: { id: 'custom:ab12cd', type: 'openai-compatible', name: 'Local', baseUrl: 'http://127.0.0.1:1/v1' } })
      await call('DELETE', `${A}/providers/{providerId}`, `${a}/providers/custom:ab12cd`)
      await call('POST', `${A}/adapters`, `${a}/adapters`, { adapterType: 'telegram', config: { enabled: false } })
      await call('DELETE', `${A}/adapters/{adapterType}`, `${a}/adapters/telegram`)
      await call('POST', `${A}/mcp/servers`, `${a}/mcp/servers`, { server: { name: 'fs', transport: 'stdio', command: 'node' } })
      await call('DELETE', `${A}/mcp/servers/{serverName}`, `${a}/mcp/servers/fs`)
      await call('POST', `${A}/tasks/approve-all`, `${a}/tasks/approve-all`)
      await call('POST', `${A}/trigger`, `${a}/trigger`, { type: 'startup' })
      await call('POST', `${A}/chat`, `${a}/chat`, { text: 'hello' })
      await call('DELETE', `${A}/logs`, `${a}/logs`)
      await call('DELETE', `${A}/inbox`, `${a}/inbox`)
      await call('DELETE', '/tracked-dirs', `/tracked-dirs?path=${encodeURIComponent(folder)}`)
      const providerId = (added.body as { provider?: { id?: string } }).provider?.id ?? 'custom:missing'
      await call('DELETE', '/runtime/providers/{id}', `/runtime/providers/${encodeURIComponent(providerId)}`)
    } finally {
      await server.close()
      await runtime.shutdownAll({ mode: 'immediate' })
      rmSync(folder, { recursive: true, force: true })
    }
    expect(problems).toEqual([])
  })
})
