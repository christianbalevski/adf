import { describe, expect, it } from 'vitest'
import { browserLaunchCommand, daemonIsLocal, loginChatGpt, loginClaude, loginGrok, normalizeAuthProvider, openBrowser, submitClaudeCode, type AuthRequest } from '../../src/main/cli/auth-flow'

const OAUTH_URL = 'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_x&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid+profile&code_challenge=abc&code_challenge_method=S256&state=xyz'

describe('openBrowser', () => {
  it('on Windows passes the whole URL, every & parameter intact, as one argv entry to rundll32 (never cmd)', () => {
    const spawned: Array<{ command: string; args: string[] }> = []
    openBrowser(OAUTH_URL, {
      platform: 'win32',
      spawn: (command, args) => { spawned.push({ command, args }); return { on: () => undefined, unref: () => {} } },
    })
    expect(spawned).toEqual([{ command: 'rundll32', args: ['url.dll,FileProtocolHandler', OAUTH_URL] }])
    expect(spawned[0].args[1].split('&')).toHaveLength(OAUTH_URL.split('&').length)
    expect(spawned[0].command).not.toMatch(/cmd/i)
  })

  it('uses open on macOS and xdg-open elsewhere; a failing spawn is silent', () => {
    expect(browserLaunchCommand(OAUTH_URL, 'darwin')).toEqual({ command: 'open', args: [OAUTH_URL] })
    expect(browserLaunchCommand(OAUTH_URL, 'linux')).toEqual({ command: 'xdg-open', args: [OAUTH_URL] })
    expect(() => openBrowser(OAUTH_URL, { platform: 'linux', spawn: () => { throw new Error('no browser') } })).not.toThrow()
  })
})

describe('sign-in flows', () => {
  it('normalises provider names and spots local daemons', () => {
    expect(normalizeAuthProvider('OpenAI')).toBe('chatgpt')
    expect(normalizeAuthProvider('xai')).toBe('grok')
    expect(normalizeAuthProvider('gemini')).toBeNull()
    expect(normalizeAuthProvider('Claude')).toBe('claude')
    expect(normalizeAuthProvider('claude-code')).toBe('claude')
    // `anthropic` is the API-key provider, never the Claude subscription.
    expect(normalizeAuthProvider('anthropic')).toBeNull()
    expect(daemonIsLocal('http://127.0.0.1:7385')).toBe(true)
    expect(daemonIsLocal('http://10.0.0.5:7385')).toBe(false)
  })

  it('ChatGPT loopback: start, open, poll until signed in', async () => {
    const calls: string[] = []
    let polls = 0
    const request: AuthRequest = async (method, path, body) => {
      calls.push(`${method} ${path}${body ? ` ${JSON.stringify(body)}` : ''}`)
      if (path === '/auth/chatgpt/start') return { started: true, mode: 'loopback', authUrl: OAUTH_URL }
      return ++polls < 2 ? { authenticated: false } : { authenticated: true, email: 'user@example.test' }
    }
    const opened: string[] = []
    let shown = ''
    const outcome = await loginChatGpt({ request, sleep: async () => {}, openBrowser: url => opened.push(url) }, { daemonUrl: 'http://127.0.0.1:7385', onStart: info => { shown = info.authUrl } })
    expect(outcome).toMatchObject({ ok: true, email: 'user@example.test' })
    expect(shown).toBe(OAUTH_URL)
    expect(opened).toEqual([OAUTH_URL])
    expect(calls[0]).toBe('POST /auth/chatgpt/start {"mode":"loopback"}')
  })

  it('cancelling stops polling', async () => {
    const stop = new AbortController()
    let polls = 0
    const request: AuthRequest = async (_m, path) => {
      if (path === '/auth/grok/start') return { userCode: 'AB-CD', verificationUri: 'https://x.ai/device', expiresIn: 900 }
      polls++
      if (polls === 2) stop.abort()
      return { authenticated: false }
    }
    const outcome = await loginGrok({ request, sleep: async () => {}, openBrowser: () => {}, signal: stop.signal }, { onStart: () => {} })
    expect(outcome).toMatchObject({ ok: false, cancelled: true })
    expect(polls).toBe(2)
  })

  it('relay: a cancelled callback wait closes the local server', async () => {
    const stop = new AbortController()
    let closed = false
    const request: AuthRequest = async () => ({ started: true, mode: 'relay', flowId: 'f', authUrl: OAUTH_URL })
    const pending = loginChatGpt({
      request,
      openBrowser: () => {},
      signal: stop.signal,
      startCallbackServer: async () => ({ port: 1455, waitForCallback: () => new Promise(() => {}), close: () => { closed = true } }),
    }, { daemonUrl: 'http://10.0.0.5:7385', onStart: () => { setTimeout(() => stop.abort(), 5) } })
    expect(await pending).toMatchObject({ ok: false, cancelled: true })
    expect(closed).toBe(true)
  })

  describe('Claude', () => {
    const CLAUDE_URL = 'https://claude.ai/oauth/authorize?code=true&client_id=x&state=y'

    it('starts, shows the URL without opening it here, relays a code, polls until signed in', async () => {
      const calls: string[] = []
      let polls = 0
      const request: AuthRequest = async (method, path, body) => {
        calls.push(`${method} ${path}${body ? ` ${JSON.stringify(body)}` : ''}`)
        if (path === '/auth/claude/start') return { started: true, url: CLAUDE_URL }
        if (path === '/auth/claude/code') return { success: true }
        if (calls.filter(c => c === 'GET /auth/claude/status').length === 1) return { authenticated: false, installed: true, version: '2.1.250' }
        return ++polls < 2
          ? { authenticated: false, installed: true, version: '2.1.250', flowPending: true, flowUrl: CLAUDE_URL }
          : { authenticated: true, installed: true, version: '2.1.250', email: 'user@example.test', plan: 'max' }
      }
      const opened: string[] = []
      let shown = ''
      const outcome = await loginClaude({ request, sleep: async () => {}, openBrowser: url => opened.push(url) }, {
        onStart: info => { shown = info.url; void submitClaudeCode({ request }, '  abc#def  ') },
      })
      expect(outcome).toMatchObject({ ok: true, email: 'user@example.test' })
      expect(shown).toBe(CLAUDE_URL)
      // Claude Code on the daemon host opens the browser; never this process.
      expect(opened).toEqual([])
      expect(calls.slice(0, 3)).toEqual(['GET /auth/claude/status', 'POST /auth/claude/start', 'POST /auth/claude/code {"code":"abc#def"}'])
    })

    it('fails fast with the install URL when Claude Code is not installed', async () => {
      const calls: string[] = []
      const request: AuthRequest = async (method, path) => {
        calls.push(`${method} ${path}`)
        return { authenticated: false, installed: false, installUrl: 'https://code.claude.com/docs/en/setup' }
      }
      const outcome = await loginClaude({ request, sleep: async () => {} }, { onStart: () => { throw new Error('must not start') } })
      expect(outcome).toMatchObject({ ok: false, notInstalled: true, installUrl: 'https://code.claude.com/docs/en/setup' })
      expect(outcome.ok ? '' : outcome.error).toContain('https://code.claude.com/docs/en/setup')
      expect(calls).toEqual(['GET /auth/claude/status'])
    })

    it('waits out a standing flowError while the flow is pending, then reports the failure', async () => {
      let polls = 0
      const request: AuthRequest = async (_m, path) => {
        if (path === '/auth/claude/start') return { started: true, url: CLAUDE_URL }
        polls++
        if (polls === 1) return { authenticated: false, installed: true, version: '2.1.250' }
        if (polls === 2) return { authenticated: false, installed: true, version: '2.1.250', flowPending: true, flowError: 'signed in with a Console account' }
        return { authenticated: false, installed: true, version: '2.1.250', flowError: 'Claude sign-in was cancelled.' }
      }
      const outcome = await loginClaude({ request, sleep: async () => {} }, { onStart: () => {} })
      expect(outcome).toEqual({ ok: false, error: 'Claude sign-in was cancelled.' })
      expect(polls).toBe(3)
    })

    it('re-login while signed in waits for the flow to finish, not the old account', async () => {
      let polls = 0
      const old = { authenticated: true, installed: true, version: '2.1.250', email: 'old@example.test' }
      const request: AuthRequest = async (_m, path) => {
        if (path === '/auth/claude/start') return { started: true, url: CLAUDE_URL }
        polls++
        if (polls === 1) return old
        if (polls < 4) return { ...old, flowPending: true, flowUrl: CLAUDE_URL }
        return { authenticated: true, installed: true, version: '2.1.250', email: 'new@example.test' }
      }
      const outcome = await loginClaude({ request, sleep: async () => {} }, { onStart: () => {} })
      expect(outcome).toMatchObject({ ok: true, email: 'new@example.test' })
      expect(polls).toBe(4)
    })

    it('cancelling stops polling and cancels the daemon-side flow', async () => {
      const stop = new AbortController()
      const calls: string[] = []
      const request: AuthRequest = async (method, path) => {
        calls.push(`${method} ${path}`)
        if (path === '/auth/claude/start') return { started: true, url: CLAUDE_URL }
        if (calls.filter(c => c.startsWith('GET')).length === 2) stop.abort()
        return { authenticated: false, installed: true, version: '2.1.250', flowPending: true }
      }
      const outcome = await loginClaude({ request, sleep: async () => {}, signal: stop.signal }, { onStart: () => {} })
      expect(outcome).toMatchObject({ ok: false, cancelled: true })
      expect(calls.at(-1)).toBe('POST /auth/claude/cancel')
    })
  })
})
