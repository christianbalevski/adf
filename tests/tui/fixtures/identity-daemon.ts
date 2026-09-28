// Owner identity + agent creation on top of the shared mock daemon, as a
// chainable fetch wrapper (docs/daemon/http-api.md "Owner Identity" and
// "Creating Agents"): GET /identity, POST /identity/{create,restore,unlock,
// lock,confirm-backup}, GET /templates, POST /agents/create (adds a real mock
// agent that chats like the others). Everything else passes through.
//
// `calls` records method + path only — never bodies (they carry secrets).

import type { MockDaemon } from './mock-daemon'

type MockAgent = MockDaemon['agents'] extends Map<string, infer A> ? A : never

export type MockIdentityState = 'none' | 'locked' | 'restore-needed' | 'ready'

/** The phrase `create` hands out, and the one `restore` accepts for OWNER_DID. */
export const MOCK_WORDS = ['legal', 'winner', 'thank', 'year', 'wave', 'sausage', 'worth', 'useful', 'legal', 'winner', 'thank', 'yellow']
export const MOCK_PHRASE = MOCK_WORDS.join(' ')
/** A valid phrase of another owner (restore → 409 owner_mismatch when this machine has an owner). */
export const OTHER_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
export const OWNER_DID = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK'
export const OTHER_DID = 'did:key:z6MkjchhfUsD6mmvni8mCdXHw216Xrm9bQe2mBH1P5RDjVJG'
export const MOCK_PASSPHRASE = 'correct horse'

export interface IdentityMockOptions {
  status?: MockIdentityState
  storage?: 'keychain' | 'file'
  backupConfirmed?: boolean
  /** Answer create/restore/unlock with 403 loopback_only (a remote daemon). */
  remote?: boolean
  /** Start with no agents (first run). */
  emptyFleet?: boolean
}

export interface IdentityMock {
  fetch: typeof fetch
  /** `POST /identity/confirm-backup`, `GET /templates`, … (no bodies). */
  calls: string[]
  state: { status: MockIdentityState; storage: 'keychain' | 'file'; backupConfirmed: boolean; unlocked: boolean; ownerDid: string | null; hasFile: boolean }
  created: Array<{ agentId: string; name: string; template: string; start: boolean }>
}

const TEMPLATES = [
  { id: 'standard', name: 'Standard', templateDescription: 'A general assistant with files, memory and messaging.', reviewed: true, shipped: 'standard', modelProvider: 'anthropic', modelId: 'claude-sonnet', filePath: '/templates/standard.adf', modifiedAt: 0, hasHistory: false },
  { id: 'coder', name: 'Coder', templateDescription: 'Writes and runs code in its sandbox.', warning: 'Runs code and reaches your host without asking.', reviewed: true, shipped: 'coder', modelProvider: 'anthropic', modelId: 'claude-sonnet', filePath: '/templates/coder.adf', modifiedAt: 0, hasHistory: false },
  { id: 'shared-find', name: 'Shared find', templateDescription: 'Someone else’s template.', reviewed: false, filePath: '/templates/shared-find.adf', modifiedAt: 0, hasHistory: false },
]

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function uuid(): string {
  const hex = () => Math.floor(Math.random() * 16).toString(16)
  const part = (n: number) => Array.from({ length: n }, hex).join('')
  return `${part(8)}-${part(4)}-4${part(3)}-8${part(3)}-${part(12)}`
}

export function createIdentityFetch(mock: MockDaemon, options: IdentityMockOptions = {}, next: typeof fetch = globalThis.fetch.bind(globalThis)): IdentityMock {
  const status = options.status ?? 'ready'
  const storage = options.storage ?? 'keychain'
  const state: IdentityMock['state'] = {
    status,
    storage,
    backupConfirmed: options.backupConfirmed ?? status === 'ready',
    unlocked: storage === 'keychain' || status === 'ready',
    ownerDid: status === 'none' ? null : OWNER_DID,
    hasFile: storage === 'file' && status !== 'none' && status !== 'restore-needed',
  }
  const calls: string[] = []
  const created: IdentityMock['created'] = []
  if (options.emptyFleet) mock.agents.clear()

  const view = () => ({
    status: state.status,
    ownerDid: state.ownerDid,
    runtimeDid: state.status === 'ready' ? 'did:key:z6MkrRuntimeMockDaemon0000000000000000000000000' : null,
    storage: state.storage,
    backupConfirmed: state.backupConfirmed,
    passphraseRequired: state.storage === 'file' && !state.unlocked,
    message: state.status === 'ready' ? 'Owner identity ready.'
      : state.status === 'locked' ? 'The owner identity is locked. Unlock it with its passphrase (adf identity unlock).'
        : state.status === 'restore-needed' ? `This machine's owner is ${state.ownerDid}, but the daemon does not have its seed phrase. Restore it with the same 12 words (adf identity restore).`
          : 'No owner identity yet. Create one (adf identity new) or restore yours from its seed phrase (adf identity restore).',
  })
  const fail = (code: number, error: string, errCode: string, extra: Record<string, unknown> = {}) => json(code, { error, code: errCode, ...extra })

  /** File storage: open (or create) the passphrase file. null = ok, else the error response. */
  const openFile = (passphrase: unknown): Response | null => {
    if (state.storage !== 'file' || state.unlocked) return null
    if (typeof passphrase !== 'string' || !passphrase) return fail(400, 'Provide a passphrase.', 'passphrase_required')
    if (!state.hasFile) {
      if (passphrase.length < 8) return fail(400, 'Choose a passphrase of at least 8 characters.', 'weak_passphrase')
      state.hasFile = true
      state.unlocked = true
      return null
    }
    if (passphrase !== MOCK_PASSPHRASE) return fail(403, 'Wrong passphrase.', 'wrong_passphrase')
    state.unlocked = true
    return null
  }

  const addAgent = (name: string): MockAgent => {
    const agent = {
      id: uuid(),
      handle: name,
      name,
      model: 'mock-model',
      state: 'idle',
      loops: [],
      history: { main: [] },
      files: [{ path: 'document.md', content: `# ${name}`, protection: 'none' }],
      timers: [],
      tasks: [],
      asks: [],
    } as unknown as MockAgent
    mock.agents.set((agent as unknown as { id: string }).id, agent)
    return agent
  }

  const wrapped = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = (init?.method ?? 'GET').toUpperCase()
    const route = `${method} ${url.pathname}`
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
    const secretRoute = route === 'POST /identity/create' || route === 'POST /identity/restore' || route === 'POST /identity/unlock'

    if (url.pathname.startsWith('/identity') || url.pathname === '/templates' || route === 'POST /agents/create') calls.push(route)
    if (secretRoute && options.remote) return fail(403, 'Owner identity secrets can only be handled from this machine (loopback). Run the command on the daemon host.', 'loopback_only')

    switch (route) {
      case 'GET /identity':
        return json(200, view())
      case 'POST /identity/create': {
        if (state.status !== 'none') return fail(409, `An owner identity already exists here (status: ${state.status}).`, 'identity_exists')
        const problem = openFile(body.passphrase)
        if (problem) return problem
        state.status = 'ready'
        state.ownerDid = OWNER_DID
        state.backupConfirmed = false
        return json(201, { mnemonic: MOCK_PHRASE, words: MOCK_WORDS, identity: view() })
      }
      case 'POST /identity/restore': {
        const phrase = typeof body.mnemonic === 'string' ? body.mnemonic.trim().toLowerCase().replace(/\s+/g, ' ') : ''
        const derived = phrase === MOCK_PHRASE ? OWNER_DID : phrase === OTHER_PHRASE ? OTHER_DID : null
        if (!derived) return fail(400, 'That is not a valid 12-word seed phrase. Check the words and their order.', 'invalid_mnemonic')
        if (state.ownerDid && state.ownerDid !== derived) return fail(409, `That phrase belongs to ${derived}, but this machine's owner is ${state.ownerDid}.`, 'owner_mismatch')
        const problem = openFile(body.passphrase)
        if (problem) return problem
        state.status = 'ready'
        state.ownerDid = derived
        state.backupConfirmed = true
        return json(200, { identity: view() })
      }
      case 'POST /identity/unlock': {
        if (state.storage !== 'file') return fail(400, 'The owner identity is in the OS keychain; there is nothing to unlock.', 'not_file_storage')
        if (!state.hasFile) return fail(409, 'There is no owner identity file yet.', 'nothing_to_unlock')
        const problem = openFile(body.passphrase)
        if (problem) return problem
        if (state.status === 'locked') state.status = 'ready'
        return json(200, { identity: view() })
      }
      case 'POST /identity/lock':
        if (state.storage !== 'file') return fail(400, 'The owner identity is in the OS keychain and cannot be locked by the daemon.', 'not_file_storage')
        state.unlocked = false
        if (state.status === 'ready') state.status = 'locked'
        return json(200, { identity: view() })
      case 'POST /identity/confirm-backup':
        if (state.status !== 'ready') return fail(409, 'No usable owner identity to confirm.', 'not_ready')
        state.backupConfirmed = true
        return json(200, { identity: view() })
      case 'GET /templates':
        if (state.status !== 'ready') return fail(409, 'Set up the owner identity first.', 'identity_not_ready', { identity: view() })
        return json(200, { templates: TEMPLATES, defaultId: 'standard', folder: '/templates', defaultDirectory: '/home/owner/Documents/adf-agents' })
      case 'POST /agents/create': {
        if (state.status !== 'ready') return fail(409, 'Set up the owner identity first.', 'identity_not_ready', { identity: view() })
        const template = typeof body.template === 'string' ? body.template : 'standard'
        const found = TEMPLATES.find(t => t.id === template)
        if (!found) return fail(422, `Template "${template}" not found.`, 'template_missing')
        if (!found.reviewed) return fail(422, `Template "${template}" is not reviewed.`, 'template_unreviewed')
        const name = typeof body.name === 'string' && body.name ? body.name : `agent-${mock.agents.size + 1}`
        if ([...mock.agents.values()].some(a => (a as unknown as { name: string }).name === name)) return fail(409, `${name}.adf already exists.`, 'name_taken')
        const agent = addAgent(name) as unknown as { id: string }
        const start = body.start === true
        created.push({ agentId: agent.id, name, template, start })
        mock.emit({ event_type: 'agent.loaded', agent_id: agent.id, payload: {} })
        return json(201, { agentId: agent.id, name, filePath: `/home/owner/Documents/adf-agents/${name}.adf`, did: 'did:key:z6MkAgentMock', started: start })
      }
    }
    return next(url, init)
  }

  return { fetch: wrapped as typeof fetch, calls, state, created }
}
