// Subscription sign-in routes on top of the shared mock daemon, as a
// chainable fetch wrapper (docs/daemon/http-api.md "Auth"): GET /runtime/auth,
// GET /auth/<p>/status, POST /auth/chatgpt/{start,complete}, POST
// /auth/grok/start, POST /auth/claude/{start,code,cancel}, POST
// /auth/<p>/logout. `approve(p)` is the user finishing
// in the browser; `autoApproveAfterPolls` does it for `npm run tui:mock`.
// Agents listed in `agentProviders` get that provider in their config, so the
// "not signed in" hints can be seen.

export type MockSubscription = 'chatgpt' | 'grok' | 'claude'

export interface AuthMockOptions {
  signedIn?: Partial<Record<MockSubscription, boolean>>
  /** Agent id or handle → provider id (e.g. 'chatgpt-sub'). */
  agentProviders?: Record<string, string>
  /** Approve a pending sign-in after this many status polls (tui:mock). */
  autoApproveAfterPolls?: number
  /** Fail the pending sign-in with this flowError instead of approving. */
  failWith?: string
  /** Claude Code installed on the (mock) daemon host. Default true. */
  claudeInstalled?: boolean
}

export interface AuthMock {
  fetch: typeof fetch
  calls: string[]
  state: Record<MockSubscription, { authenticated: boolean; pending: boolean; email?: string; flowError?: string; polls: number }>
  approve(provider: MockSubscription): void
  /** The pending sign-in fails (an earlier account, if any, stays signed in). */
  fail(provider: MockSubscription, error: string): void
  /** Codes sent to POST /auth/claude/code, in order. */
  claudeCodes: string[]
}

export const CHATGPT_AUTH_URL = 'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_mock&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid+profile+email+offline_access&state=mock-state'
export const GROK_CODE = 'WXYZ-1234'
export const GROK_URL = 'https://accounts.x.ai/device?user_code=WXYZ-1234'
export const CLAUDE_URL = 'https://claude.ai/oauth/authorize?code=true&client_id=mock&state=mock-state'
export const CLAUDE_INSTALL_URL = 'https://code.claude.com/docs/en/setup'

const PROVIDERS = [
  { id: 'chatgpt-sub', type: 'chatgpt-subscription', name: 'ChatGPT', credentialStorage: 'app', hasApiKey: false },
  { id: 'grok-sub', type: 'grok-subscription', name: 'Grok', credentialStorage: 'app', hasApiKey: false },
  { id: 'claude-sub', type: 'claude-subscription', name: 'Claude', credentialStorage: 'app', hasApiKey: false },
  { id: 'mock', type: 'openai-compatible', name: 'Mock', credentialStorage: 'app', hasApiKey: true },
]

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

export function createAuthFetch(options: AuthMockOptions = {}, next: typeof fetch = globalThis.fetch.bind(globalThis)): AuthMock {
  const calls: string[] = []
  const make = (p: MockSubscription) => ({ authenticated: !!options.signedIn?.[p], pending: false, polls: 0, ...(options.signedIn?.[p] ? { email: 'owner@example.test' } : {}) }) as AuthMock['state'][MockSubscription]
  const state: AuthMock['state'] = { chatgpt: make('chatgpt'), grok: make('grok'), claude: make('claude') }
  const claudeCodes: string[] = []
  const claudeInstalled = options.claudeInstalled !== false
  const approve = (p: MockSubscription) => { state[p] = { authenticated: true, pending: false, email: 'owner@example.test', polls: 0 } }
  const fail = (p: MockSubscription, error: string) => { state[p] = { ...state[p], pending: false, flowError: error } }
  const status = (p: MockSubscription) => {
    const s = state[p]
    if (p === 'claude') {
      if (!claudeInstalled) return { authenticated: false, installed: false, installUrl: CLAUDE_INSTALL_URL }
      const pending = s.pending ? { flowPending: true, flowUrl: CLAUDE_URL } : {}
      return s.authenticated
        ? { authenticated: true, installed: true, version: '2.1.250', ...pending, email: s.email, plan: 'max', ...(s.flowError ? { flowError: s.flowError } : {}) }
        : { authenticated: false, installed: true, version: '2.1.250', ...pending, ...(s.flowError ? { flowError: s.flowError } : {}) }
    }
    return s.authenticated
      ? { authenticated: true, email: s.email, expiresAt: Date.now() + 3 * 86_400_000 }
      : { authenticated: false, ...(p === 'grok' ? { flowPending: s.pending } : {}), ...(s.flowError ? { flowError: s.flowError } : {}) }
  }

  const wrapped = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = (init?.method ?? 'GET').toUpperCase()
    const route = `${method} ${url.pathname}`
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
    if (url.pathname.startsWith('/auth/') || url.pathname === '/runtime/auth') calls.push(route)

    if (route === 'GET /runtime/auth') return json(200, { chatgpt: status('chatgpt'), grok: status('grok'), claude: status('claude'), providers: PROVIDERS })
    if (route === 'POST /auth/claude/code') {
      if (!state.claude.pending) return json(400, { error: 'No Claude sign-in is in progress.', code: 'bad_request' })
      claudeCodes.push(String(body.code ?? ''))
      return json(200, { success: true })
    }
    if (route === 'POST /auth/claude/cancel') {
      state.claude = { ...state.claude, pending: false }
      return json(200, { success: true })
    }
    const m = url.pathname.match(/^\/auth\/(chatgpt|grok|claude)\/(status|start|complete|logout)$/)
    if (m) {
      const p = m[1] as MockSubscription
      switch (`${method} ${m[2]}`) {
        case 'GET status': {
          const s = state[p]
          if (s.pending) {
            s.polls++
            if (options.autoApproveAfterPolls !== undefined && s.polls >= options.autoApproveAfterPolls) {
              if (options.failWith) { s.pending = false; s.flowError = options.failWith } else approve(p)
            }
          }
          return json(200, status(p))
        }
        case 'POST start':
          state[p] = { ...state[p], pending: true, polls: 0, flowError: undefined }
          if (p === 'claude') {
            if (!claudeInstalled) { state[p] = { ...state[p], pending: false }; return json(409, { error: 'Claude Code is not installed on the daemon host.', code: 'claude_code_not_installed', installUrl: CLAUDE_INSTALL_URL }) }
            return json(200, { started: true, url: CLAUDE_URL })
          }
          if (p === 'grok') return json(200, { started: true, userCode: GROK_CODE, verificationUri: 'https://accounts.x.ai/device', verificationUriComplete: GROK_URL, expiresIn: 900 })
          if (body.mode === 'relay') return json(200, { started: true, mode: 'relay', flowId: 'flow-1', authUrl: CHATGPT_AUTH_URL, state: 'mock-state', expiresAt: Date.now() + 300_000 })
          return json(200, { started: true, mode: 'loopback', authUrl: CHATGPT_AUTH_URL, callbackPort: 1455 })
        case 'POST complete':
          approve(p)
          return json(200, { success: true, status: status(p) })
        case 'POST logout':
          state[p] = { authenticated: false, pending: false, polls: 0 }
          return json(200, { success: true })
      }
    }

    const agentConfig = url.pathname.match(/^\/agents\/([^/]+)\/config$/)
    if (agentConfig && method === 'GET' && options.agentProviders) {
      const response = await next(input instanceof Request ? input : url, init)
      if (!response.ok) return response
      const data = await response.json() as { agentId: string; config: Record<string, unknown> & { handle?: string; model?: Record<string, unknown> } }
      const provider = options.agentProviders[data.agentId] ?? options.agentProviders[data.config?.handle ?? ''] ?? options.agentProviders[decodeURIComponent(agentConfig[1])]
      if (provider && data.config) data.config = { ...data.config, model: { ...(data.config.model ?? {}), provider } }
      return json(200, data)
    }
    return next(input instanceof Request ? input : url, init)
  }

  return { fetch: wrapped as typeof fetch, calls, state, approve, fail, claudeCodes }
}
