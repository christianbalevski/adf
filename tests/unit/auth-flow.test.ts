import { describe, expect, it } from 'vitest'
import { browserLaunchCommand, daemonIsLocal, loginChatGpt, loginGrok, normalizeAuthProvider, openBrowser, type AuthRequest } from '../../src/main/cli/auth-flow'

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
})
