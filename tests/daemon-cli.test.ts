import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runCli, type CliIo } from '../src/main/cli'
import { ensureDaemonToken } from '../src/main/daemon/daemon-token'

// The CLI reads the local daemon token file: point it at a temp settings dir
// (never the user's real one) and clear any token from the environment.
const saved = { settings: process.env.ADF_DAEMON_SETTINGS, token: process.env.ADF_DAEMON_TOKEN, url: process.env.ADF_DAEMON_URL }
const settingsDir = mkdtempSync(join(tmpdir(), 'adf-cli-token-'))
beforeAll(() => {
  process.env.ADF_DAEMON_SETTINGS = join(settingsDir, 'adf-settings.json')
  delete process.env.ADF_DAEMON_TOKEN
  delete process.env.ADF_DAEMON_URL
})
afterAll(() => {
  for (const [key, value] of [['ADF_DAEMON_SETTINGS', saved.settings], ['ADF_DAEMON_TOKEN', saved.token], ['ADF_DAEMON_URL', saved.url]] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(settingsDir, { recursive: true, force: true })
})

describe('daemon access token', () => {
  function authOf(init?: RequestInit): string | undefined {
    return (init?.headers as Record<string, string> | undefined)?.Authorization
  }

  it('sends the local token file to the local daemon, --token wins, never the local token to a remote one or a tunnel', async () => {
    const { token } = ensureDaemonToken(settingsDir)
    const seen: Array<[string, string | undefined]> = []
    const io = fakeIo(async (url, init) => { seen.push([url, authOf(init)]); return jsonResponse([]) })

    expect(await runCli(['agents'], io)).toBe(0)
    expect(await runCli(['--url', 'http://localhost:7385', 'agents'], io)).toBe(0)
    expect(await runCli(['--url', 'http://127.0.0.1:7386', 'agents'], io)).toBe(0)
    expect(await runCli(['--url', 'http://127.0.0.1:7386', '--token', 'tunnel-token', 'agents'], io)).toBe(0)
    expect(await runCli(['--url', 'http://daemon.example:7385', 'agents'], io)).toBe(0)
    expect(await runCli(['--url', 'http://daemon.example:7385', '--token', 'remote-token', 'agents'], io)).toBe(0)
    expect(await runCli(['--token=explicit', 'agents'], io)).toBe(0)
    expect(seen).toEqual([
      ['http://127.0.0.1:7385/agents', `Bearer ${token}`],
      ['http://localhost:7385/agents', `Bearer ${token}`],
      ['http://127.0.0.1:7386/agents', undefined],
      ['http://127.0.0.1:7386/agents', 'Bearer tunnel-token'],
      ['http://daemon.example:7385/agents', undefined],
      ['http://daemon.example:7385/agents', 'Bearer remote-token'],
      ['http://127.0.0.1:7385/agents', 'Bearer explicit'],
    ])
  })

  it('--token is a one-shot option, not a TUI flag', async () => {
    const launched: string[][] = []
    const io = { ...fakeIo(async () => jsonResponse([])), launchTui: async (argv: string[]) => { launched.push(argv); return 0 } }
    expect(await runCli(['--token', 'x', 'agents'], io)).toBe(0)
    expect(launched).toEqual([])
    expect(await runCli(['--token', 'x'], io)).toBe(0)
    expect(launched).toEqual([['--token', 'x']])
  })

  it('events sends the token too', async () => {
    const { token } = ensureDaemonToken(settingsDir)
    let auth: string | undefined
    const io = fakeIo(async (_url, init) => {
      auth = authOf(init)
      return new Response('', { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    })
    expect(await runCli(['events'], io)).toBe(0)
    expect(auth).toBe(`Bearer ${token}`)
  })

  it('surfaces the daemon 401 message (what an outdated client sees too)', async () => {
    const io = fakeIo(async () => jsonResponse({ error: 'This ADF daemon requires its access token (Authorization: Bearer). … Print the token on the daemon host with: adf daemon token', code: 'unauthorized' }, 401))
    expect(await runCli(['--url', 'http://daemon.example:7385', 'agents'], io)).toBe(1)
    expect(io.errorOutput()).toContain('adf daemon token')
  })

  it('a 401 through a tunnel (loopback, another port) explains why no token was sent', async () => {
    const unauthorized = async () => jsonResponse({ error: 'This ADF daemon requires its access token.', code: 'unauthorized' }, 401)
    const io = fakeIo(unauthorized)
    expect(await runCli(['--url', 'http://127.0.0.1:7386', 'agents'], io)).toBe(1)
    expect(io.errorOutput()).toMatch(/not this machine's daemon port \(7385; e\.g\. an SSH tunnel\)[\s\S]*--token or set ADF_DAEMON_TOKEN[\s\S]*adf daemon token/)
    // With a token (wrong or not) there is nothing to explain.
    const withToken = fakeIo(unauthorized)
    expect(await runCli(['--url', 'http://127.0.0.1:7386', '--token', 'x', 'agents'], withToken)).toBe(1)
    expect(withToken.errorOutput()).not.toMatch(/SSH tunnel/)
  })

  it('a down tunnel says so instead of suggesting adf daemon start', async () => {
    const io = fakeIo(async () => { throw new TypeError('fetch failed') })
    expect(await runCli(['--url', 'http://127.0.0.1:7386', 'agents'], io)).toBe(1)
    expect(io.errorOutput()).toMatch(/not this machine's daemon port[\s\S]*check the SSH tunnel/)
  })
})

describe('daemon CLI', () => {
  it('lists agents from the daemon API', async () => {
    const io = fakeIo(async (url) => {
      expect(url).toBe('http://127.0.0.1:7385/agents')
      return jsonResponse([
        { id: '00000000-0000-0000-0000-000000000001', handle: 'agent-1', name: 'agent-1', autostart: true },
      ])
    })

    const code = await runCli(['agents'], io)

    expect(code).toBe(0)
    expect(io.output()).toContain('agent-1')
    expect(io.output()).toContain('agent-1')
  })

  it('supports daemon URL override and JSON output', async () => {
    const io = fakeIo(async (url) => {
      expect(url).toBe('http://localhost:9999/agents/agent-1/status')
      return jsonResponse({ id: '00000000-0000-0000-0000-000000000001', handle: 'agent-1', runtimeState: 'idle', loopCount: 12 })
    })

    const code = await runCli(['--url', 'http://localhost:9999/', '--json', 'status', 'agent-1'], io)

    expect(code).toBe(0)
    expect(JSON.parse(io.output())).toEqual({
      id: '00000000-0000-0000-0000-000000000001',
      handle: 'agent-1',
      runtimeState: 'idle',
      loopCount: 12,
    })
  })

  it('prints global provider diagnostics', async () => {
    const io = fakeIo(async (url) => {
      expect(url).toBe('http://127.0.0.1:7385/runtime/providers')
      return jsonResponse({
        providers: [{ id: 'openai-main', type: 'openai', name: 'OpenAI', defaultModel: 'gpt-test', hasApiKey: true }],
        agentUsage: [{ handle: 'agent-1', providerId: 'openai-main', modelId: 'gpt-test', source: 'app' }],
      })
    })

    const code = await runCli(['providers'], io)

    expect(code).toBe(0)
    expect(io.output()).toContain('openai-main')
    expect(io.output()).toContain('agent-1')
  })

  it('prints global network diagnostics', async () => {
    const io = fakeIo(async (url) => {
      expect(url).toBe('http://127.0.0.1:7385/runtime/network')
      return jsonResponse({
        mesh: { enabledSetting: true, lan: false, port: 7295 },
        websocket: { activeConnections: 2, inboundConnections: 1, outboundConnections: 1 },
        agents: [{ handle: 'agent-1', receive: true, sendMode: 'proactive', wsConnectionsConfigured: 1, servingRoutes: 2 }],
      })
    })

    const code = await runCli(['network'], io)

    expect(code).toBe(0)
    expect(io.output()).toContain('wsActive')
    expect(io.output()).toContain('agent-1')
  })

  it('controls mesh admin endpoints through network subcommands', async () => {
    const calls: string[] = []
    const io = fakeIo(async (url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      return jsonResponse({ success: true, running: true, port: 7295, host: '127.0.0.1' })
    })

    const meshCode = await runCli(['network', 'mesh', 'enable'], io)
    const serverCode = await runCli(['network', 'server', 'restart'], io)
    const lanCode = await runCli(['network', 'lan'], io)

    expect(meshCode).toBe(0)
    expect(serverCode).toBe(0)
    expect(lanCode).toBe(0)
    expect(calls).toEqual([
      'POST http://127.0.0.1:7385/network/mesh/enable',
      'POST http://127.0.0.1:7385/network/server/restart',
      'GET http://127.0.0.1:7385/network/mesh/lan-addresses',
    ])
  })

  it('prints runtime usage diagnostics', async () => {
    const io = fakeIo(async (url) => {
      expect(url).toBe('http://127.0.0.1:7385/runtime/usage')
      return jsonResponse({
        source: 'token-usage-service',
        totals: { input: 10, output: 20, total: 30 },
        byModel: [{ provider: 'mock', model: 'mock-v1', input: 10, output: 20, total: 30, days: 1 }],
      })
    })

    const code = await runCli(['usage'], io)

    expect(code).toBe(0)
    expect(io.output()).toContain('token-usage-service')
    expect(io.output()).toContain('mock-v1')
  })

  it('prints agent usage diagnostics', async () => {
    const io = fakeIo(async (url) => {
      expect(url).toBe('http://127.0.0.1:7385/agents/agent-1/usage')
      return jsonResponse({
        agentId: '00000000-0000-0000-0000-000000000001',
        source: 'adf_loop',
        loopRows: 4,
        usageRows: 2,
        totals: { input: 10, output: 20, cacheRead: 3, cacheWrite: 4, total: 37 },
        byModel: [{ model: 'gpt-test', input: 10, output: 20, cacheRead: 3, cacheWrite: 4, total: 37, rows: 2 }],
      })
    })

    const code = await runCli(['usage', 'agent-1'], io)

    expect(code).toBe(0)
    expect(io.output()).toContain('adf_loop')
    expect(io.output()).toContain('gpt-test')
  })

  it('starts agents through the daemon API', async () => {
    const io = fakeIo(async (url, init) => {
      expect(url).toBe('http://127.0.0.1:7385/agents/agent-1/start')
      expect(init?.method).toBe('POST')
      return jsonResponse({ success: true, startupTriggered: true })
    })

    const code = await runCli(['start', 'agent-1'], io)

    expect(code).toBe(0)
    expect(io.output()).toBe('Started agent-1\n')
  })

  it('prints when start had to load an unloaded agent', async () => {
    const io = fakeIo(async (url, init) => {
      expect(url).toBe('http://127.0.0.1:7385/agents/agent-1/start')
      expect(init?.method).toBe('POST')
      return jsonResponse({ success: true, loaded: true, startupTriggered: true })
    })

    const code = await runCli(['start', 'agent-1'], io)

    expect(code).toBe(0)
    expect(io.output()).toBe('Started agent-1 (loaded)\n')
  })

  it('stops and unloads agents through the daemon API', async () => {
    const io = fakeIo(async (url, init) => {
      expect(url).toBe('http://127.0.0.1:7385/agents/agent-1/stop')
      expect(init?.method).toBe('POST')
      return jsonResponse({ success: true })
    })

    const code = await runCli(['stop', 'agent-1'], io)

    expect(code).toBe(0)
    expect(io.output()).toBe('Stopped agent-1\n')
  })

  it('aborts current turns without unloading agents', async () => {
    const io = fakeIo(async (url, init) => {
      expect(url).toBe('http://127.0.0.1:7385/agents/agent-1/abort')
      expect(init?.method).toBe('POST')
      return jsonResponse({ success: true })
    })

    const code = await runCli(['abort', 'agent-1'], io)

    expect(code).toBe(0)
    expect(io.output()).toBe('Aborted current turn for agent-1\n')
  })

  it('interrupts one loop without stopping it', async () => {
    const io = fakeIo(async (url, init) => {
      expect(url).toBe('http://127.0.0.1:7385/agents/agent-1/interrupt?loop=researcher')
      expect(init?.method).toBe('POST')
      return jsonResponse({ success: true, interrupted: true, loop: 'researcher' })
    })

    const code = await runCli(['interrupt', 'agent-1', '--loop', 'researcher'], io)

    expect(code).toBe(0)
    expect(io.output()).toBe('Interrupted agent-1 researcher: the loop is idle and keeps accepting work\n')
  })

  it('lists an agent’s loops and chats with an inner loop', async () => {
    const calls: string[] = []
    const io = fakeIo(async (url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url} ${init?.body ?? ''}`.trim())
      if (url.endsWith('/loops')) {
        return jsonResponse({
          agentId: 'agent-1',
          loops: [
            { name: 'main', isMain: true, enabled: true, status: 'idle', entryCount: 12, goal: '' },
            { name: 'consolidator', isMain: false, enabled: true, status: 'running', entryCount: 3, goal: 'Consolidate memories into mind.md every night' },
          ],
        })
      }
      return jsonResponse({ accepted: true, turnId: 'turn-1' }, 202)
    })

    expect(await runCli(['loops', 'agent-1'], io)).toBe(0)
    expect(io.output()).toContain('consolidator')
    expect(io.output()).toContain('inner')
    expect(io.output()).toContain('Consolidate memories')

    expect(await runCli(['chat', 'agent-1', '--loop', 'consolidator', 'tidy', 'up'], io)).toBe(0)
    expect(calls).toContain('POST http://127.0.0.1:7385/agents/agent-1/chat {"text":"tidy up","loop":"consolidator"}')
  })

  it('lists and resolves tasks through the daemon API', async () => {
    const calls: string[] = []
    const io = fakeIo(async (url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.endsWith('/tasks')) {
        return jsonResponse({
          agentId: '00000000-0000-0000-0000-000000000001',
          tasks: [{ id: 'task_1', status: 'pending_approval', tool: 'fs_write', origin: 'hil:test', requires_authorization: true }],
        })
      }
      expect(JSON.parse(String(init?.body))).toEqual({ action: 'approve' })
      return jsonResponse({
        agentId: '00000000-0000-0000-0000-000000000001',
        taskId: 'task_1',
        resolution: { task_id: 'task_1', status: 'approved' },
        task: { id: 'task_1', status: 'running' },
      })
    })

    const listCode = await runCli(['tasks', 'agent-1'], io)
    const approveCode = await runCli(['approve', 'agent-1', 'task_1'], io)

    expect(listCode).toBe(0)
    expect(approveCode).toBe(0)
    expect(calls).toEqual([
      'GET http://127.0.0.1:7385/agents/agent-1/tasks',
      'POST http://127.0.0.1:7385/agents/agent-1/tasks/task_1/resolve',
    ])
    expect(io.output()).toContain('task_1')
    expect(io.output()).toContain('Approved task_1')
  })

  it('answers ask requests through the daemon API', async () => {
    const io = fakeIo(async (url, init) => {
      expect(url).toBe('http://127.0.0.1:7385/agents/agent-1/asks/ask_1/respond')
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual({ answer: 'yes please' })
      return jsonResponse({ agentId: '00000000-0000-0000-0000-000000000001', requestId: 'ask_1', answered: true })
    })

    const code = await runCli(['answer', 'agent-1', 'ask_1', 'yes', 'please'], io)

    expect(code).toBe(0)
    expect(io.output()).toBe('Answered ask_1\n')
  })

  it('lists pending asks through the daemon API', async () => {
    const io = fakeIo(async (url) => {
      expect(url).toBe('http://127.0.0.1:7385/agents/agent-1/asks')
      return jsonResponse({ agentId: '00000000-0000-0000-0000-000000000001', asks: [{ requestId: 'ask_1', question: 'Proceed?' }] })
    })

    const code = await runCli(['asks', 'agent-1'], io)

    expect(code).toBe(0)
    expect(io.output()).toContain('ask_1')
    expect(io.output()).toContain('Proceed?')
  })

  it('prints text file content directly', async () => {
    const io = fakeIo(async (url) => {
      expect(url).toBe('http://127.0.0.1:7385/agents/agent-1/files/content?path=notes.md')
      return jsonResponse({ path: 'notes.md', encoding: 'utf-8', content: 'hello file' })
    })

    const code = await runCli(['file', 'agent-1', 'notes.md'], io)

    expect(code).toBe(0)
    expect(io.output()).toBe('hello file')
  })

  it('posts chat messages and prints the turn id', async () => {
    const io = fakeIo(async (url, init) => {
      expect(url).toBe('http://127.0.0.1:7385/agents/agent-1/chat')
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual({ text: 'hello daemon' })
      return jsonResponse({ accepted: true, turnId: 'turn_123' }, 202)
    })

    const code = await runCli(['chat', 'agent-1', 'hello', 'daemon'], io)

    expect(code).toBe(0)
    expect(io.output()).toBe('Accepted turn turn_123\n')
  })

  it('returns a non-zero exit code for daemon errors', async () => {
    const io = fakeIo(async () => jsonResponse({ error: 'Unknown agent "agent-1"' }, 404))

    const code = await runCli(['status', 'agent-1'], io)

    expect(code).toBe(1)
    expect(io.errorOutput()).toContain('Unknown agent "agent-1"')
  })

  it('signs in to Grok with the device code and polls until approved', async () => {
    const calls: string[] = []
    let polls = 0
    const io = {
      ...fakeIo(async (url, init) => {
        calls.push(`${init?.method ?? 'GET'} ${url}`)
        if (url.endsWith('/auth/grok/start')) {
          return jsonResponse({
            started: true,
            userCode: 'ABCD-EFGH',
            verificationUri: 'https://x.ai/device',
            verificationUriComplete: 'https://x.ai/device?code=ABCD-EFGH',
            expiresIn: 900,
          })
        }
        polls += 1
        return jsonResponse(polls < 2
          ? { authenticated: false }
          : { authenticated: true, email: 'user@example.com', expiresAt: Date.now() + 3600_000 })
      }),
      sleep: async () => {},
      openBrowser: () => {},
    }

    const code = await runCli(['auth', 'login', 'grok'], io)

    expect(code).toBe(0)
    expect(io.output()).toContain('ABCD-EFGH')
    expect(io.output()).toContain('https://x.ai/device?code=ABCD-EFGH')
    expect(io.output()).toContain('Signed in to Grok as user@example.com')
    expect(calls[0]).toBe('POST http://127.0.0.1:7385/auth/grok/start')
    expect(calls[1]).toBe('GET http://127.0.0.1:7385/auth/grok/status')
  })

  it('reports a failed Grok sign-in from the status flowError', async () => {
    const io = {
      ...fakeIo(async (url) => url.endsWith('/auth/grok/start')
        ? jsonResponse({ started: true, userCode: 'X', verificationUri: 'https://x.ai/device', expiresIn: 900 })
        : jsonResponse({ authenticated: false, flowError: 'Sign-in was denied' })),
      sleep: async () => {},
      openBrowser: () => {},
    }

    const code = await runCli(['auth', 'login', 'grok'], io)

    expect(code).toBe(1)
    expect(io.errorOutput()).toContain('Sign-in was denied')
  })

  it('uses relay mode for ChatGPT when the daemon is remote', async () => {
    const bodies: unknown[] = []
    const io = {
      ...fakeIo(async (url, init) => {
        bodies.push(init?.body ? JSON.parse(String(init.body)) : null)
        if (url.endsWith('/auth/chatgpt/start')) {
          return jsonResponse({ started: true, mode: 'relay', flowId: 'flow-1', authUrl: 'https://auth.openai.com/x', state: 's1' })
        }
        return jsonResponse({ success: true, status: { authenticated: true, email: 'user@example.com' } })
      }),
      openBrowser: () => {},
      startCallbackServer: async () => ({
        port: 1455,
        waitForCallback: async () => ({ code: 'the-code', state: 's1' }),
        close: () => {},
      }),
    }

    const code = await runCli(['--url', 'http://10.0.0.5:7385', 'auth', 'login', 'chatgpt'], io)

    expect(code).toBe(0)
    expect(bodies[0]).toEqual({ mode: 'relay', redirectUri: 'http://localhost:1455/auth/callback' })
    expect(bodies[1]).toEqual({ flowId: 'flow-1', code: 'the-code', state: 's1' })
    expect(io.output()).toContain('Signed in to ChatGPT as user@example.com')
  })

  it('uses loopback mode for ChatGPT when the daemon is local', async () => {
    const bodies: unknown[] = []
    const io = {
      ...fakeIo(async (url, init) => {
        if (url.endsWith('/auth/chatgpt/start')) {
          bodies.push(JSON.parse(String(init?.body)))
          return jsonResponse({ started: true, mode: 'loopback', authUrl: 'https://auth.openai.com/y', callbackPort: 1455 })
        }
        return jsonResponse({ authenticated: true, email: 'user@example.com' })
      }),
      sleep: async () => {},
      openBrowser: () => {},
      startCallbackServer: async () => { throw new Error('should not run a local callback server') },
    }

    const code = await runCli(['auth', 'login', 'chatgpt'], io)

    expect(code).toBe(0)
    expect(bodies[0]).toEqual({ mode: 'loopback' })
    expect(io.output()).toContain('https://auth.openai.com/y')
    expect(io.output()).toContain('Signed in to ChatGPT as user@example.com')
  })

  it('honours an explicit --relay override against a local daemon', async () => {
    const bodies: unknown[] = []
    const io = {
      ...fakeIo(async (url, init) => {
        bodies.push(init?.body ? JSON.parse(String(init.body)) : null)
        return url.endsWith('/auth/chatgpt/start')
          ? jsonResponse({ started: true, mode: 'relay', flowId: 'f', authUrl: 'https://auth.openai.com/z', state: 's' })
          : jsonResponse({ success: true, status: { authenticated: true } })
      }),
      openBrowser: () => {},
      startCallbackServer: async () => ({
        port: 9999,
        waitForCallback: async () => ({ code: 'c', state: 's' }),
        close: () => {},
      }),
    }

    const code = await runCli(['auth', 'login', 'chatgpt', '--relay'], io)

    expect(code).toBe(0)
    expect(bodies[0]).toMatchObject({ mode: 'relay', redirectUri: 'http://localhost:9999/auth/callback' })
  })

  it('signs out of a subscription provider', async () => {
    const calls: string[] = []
    const io = fakeIo(async (url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      return jsonResponse({ success: true })
    })

    const code = await runCli(['auth', 'logout', 'chatgpt'], io)

    expect(code).toBe(0)
    expect(calls).toEqual(['POST http://127.0.0.1:7385/auth/chatgpt/logout'])
    expect(io.output()).toBe('Signed out of ChatGPT.\n')
  })

  it('opens the TUI with no command, `tui`, or a TUI-only flag, and keeps one-shot commands', async () => {
    const launched: string[][] = []
    const io = { ...fakeIo(async () => jsonResponse([])), launchTui: async (argv: string[]) => { launched.push(argv); return 0 } }

    expect(await runCli([], io)).toBe(0)
    expect(await runCli(['--url', 'http://localhost:9999', 'tui', '--view', 'loops'], io)).toBe(0)
    expect(await runCli(['--agent', 'agent-1', '--loop', 'consolidator'], io)).toBe(0)
    expect(launched).toEqual([
      [],
      ['--url', 'http://localhost:9999', 'tui', '--view', 'loops'],
      ['--agent', 'agent-1', '--loop', 'consolidator'],
    ])

    expect(await runCli(['--help'], io)).toBe(0)
    expect(io.output()).toContain('adf [tui]')
    expect(await runCli(['agents'], io)).toBe(0)
    expect(launched).toHaveLength(3)
  })

  it('rejects an unknown auth provider', async () => {
    const io = fakeIo(async () => jsonResponse({}))

    const code = await runCli(['auth', 'login', 'gemini'], io)

    expect(code).toBe(1)
    expect(io.errorOutput()).toContain('chatgpt or grok')
  })

  describe('owner identity + new agent', () => {
    const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima']
    const ready = { status: 'ready', ownerDid: 'did:key:zOwner', runtimeDid: 'did:key:zRuntime', storage: 'keychain', backupConfirmed: false, passphraseRequired: false, message: 'Owner identity ready.' }

    it('shows identity status', async () => {
      const io = fakeIo(async (url) => {
        expect(url).toBe('http://127.0.0.1:7385/identity')
        return jsonResponse({ ...ready, status: 'none', ownerDid: null, message: 'No owner identity yet.' })
      })
      expect(await runCli(['identity'], io)).toBe(0)
      expect(io.output()).toContain('none')
      expect(io.output()).toContain('No owner identity yet.')
    })

    it('identity new prints the words once and confirms the backup the Studio way', async () => {
      const calls: string[] = []
      const io = withPrompts(fakeIo(async (url, init) => {
        calls.push(`${init?.method ?? 'GET'} ${url.replace('http://127.0.0.1:7385', '')}`)
        if (url.endsWith('/identity')) return jsonResponse({ ...ready, status: 'none', ownerDid: null })
        if (url.endsWith('/identity/create')) return jsonResponse({ mnemonic: WORDS.join(' '), words: WORDS, identity: ready }, 201)
        return jsonResponse({ identity: { ...ready, backupConfirmed: true } })
      }), ['yes'])

      expect(await runCli(['identity', 'new'], io)).toBe(0)
      expect(calls).toEqual(['GET /identity', 'POST /identity/create', 'POST /identity/confirm-backup'])
      expect(io.output()).toContain(' 1. alpha')
      expect(io.output()).toContain('12. lima')
      expect(io.output()).toContain('will NOT be shown again')
      expect(io.prompts[0]).toEqual({ question: expect.stringContaining('written the words down'), hidden: false })
    })

    it('identity new asks for a passphrase twice on file storage and does not confirm without "yes"', async () => {
      const bodies: unknown[] = []
      const io = withPrompts(fakeIo(async (url, init) => {
        if (init?.body) bodies.push(JSON.parse(String(init.body)))
        if (url.endsWith('/identity')) return jsonResponse({ ...ready, status: 'none', storage: 'file', passphraseRequired: true })
        return jsonResponse({ mnemonic: WORDS.join(' '), words: WORDS, identity: ready }, 201)
      }), ['a long passphrase', 'a long passphrase', 'no'])

      expect(await runCli(['identity', 'new'], io)).toBe(0)
      expect(bodies).toEqual([{ passphrase: 'a long passphrase' }])
      expect(io.prompts.slice(0, 2).every(p => p.hidden)).toBe(true)
      expect(io.output()).toContain('Backup not confirmed')
    })

    it('identity restore reads the phrase from a hidden prompt, never argv', async () => {
      const bodies: unknown[] = []
      const io = withPrompts(fakeIo(async (url, init) => {
        if (init?.body) bodies.push(JSON.parse(String(init.body)))
        if (url.endsWith('/identity')) return jsonResponse({ ...ready, status: 'restore-needed' })
        return jsonResponse({ identity: ready })
      }), [WORDS.join(' ')])

      expect(await runCli(['identity', 'restore'], io)).toBe(0)
      expect(bodies).toEqual([{ mnemonic: WORDS.join(' ') }])
      expect(io.prompts[0].hidden).toBe(true)
      expect(io.output()).toContain('Owner identity restored')
      expect(io.output()).not.toContain('alpha')
    })

    it('identity restore surfaces an owner mismatch', async () => {
      const io = withPrompts(fakeIo(async (url) => {
        if (url.endsWith('/identity')) return jsonResponse({ ...ready, status: 'restore-needed' })
        return jsonResponse({ error: 'That phrase belongs to did:key:zOther', code: 'owner_mismatch' }, 409)
      }), [WORDS.join(' ')])

      expect(await runCli(['identity', 'restore'], io)).toBe(1)
      expect(io.errorOutput()).toContain('belongs to did:key:zOther')
    })

    it('identity unlock posts the hidden passphrase', async () => {
      const bodies: unknown[] = []
      const io = withPrompts(fakeIo(async (_url, init) => {
        if (init?.body) bodies.push(JSON.parse(String(init.body)))
        return jsonResponse({ identity: ready })
      }), ['secret pass'])
      expect(await runCli(['identity', 'unlock'], io)).toBe(0)
      expect(bodies).toEqual([{ passphrase: 'secret pass' }])
      expect(io.prompts[0].hidden).toBe(true)
    })

    it('new creates an agent with template/provider/model flags', async () => {
      const io = fakeIo(async (url, init) => {
        expect(`${init?.method} ${url}`).toBe('POST http://127.0.0.1:7385/agents/create')
        expect(JSON.parse(String(init?.body))).toEqual({ name: 'agent-1', template: 'standard', provider: 'openai-main', model: 'gpt-test', start: true })
        return jsonResponse({ agentId: 'abc', name: 'agent-1', filePath: '/agents/agent-1.adf', did: 'did:key:zAgent', started: true }, 201)
      })
      expect(await runCli(['new', 'agent-1', '--template', 'standard', '--provider=openai-main', '--model', 'gpt-test', '--start'], io)).toBe(0)
      expect(io.output()).toContain('did:key:zAgent')
    })

    it('new explains a missing identity', async () => {
      const io = fakeIo(async () => jsonResponse({ error: 'Set up the owner identity first. No owner identity yet. Create one (adf identity new)', code: 'identity_not_ready' }, 409))
      expect(await runCli(['new', 'agent-1'], io)).toBe(1)
      expect(io.errorOutput()).toContain('adf identity new')
    })

    it('lists templates', async () => {
      const io = fakeIo(async (url) => {
        expect(url).toBe('http://127.0.0.1:7385/templates')
        return jsonResponse({ defaultId: 'standard', templates: [{ id: 'standard', name: 'Standard', templateDescription: 'A general agent' }] })
      })
      expect(await runCli(['templates'], io)).toBe(0)
      expect(io.output()).toContain('standard')
      expect(io.output()).toContain('yes')
    })
  })
})

function withPrompts<T extends CliIo>(io: T, answers: string[]): T & { prompts: Array<{ question: string; hidden: boolean }> } {
  const prompts: Array<{ question: string; hidden: boolean }> = []
  return Object.assign(io, {
    prompts,
    prompt: async (question: string, opts?: { hidden?: boolean }) => {
      prompts.push({ question, hidden: !!opts?.hidden })
      return answers.shift() ?? ''
    },
  })
}

function fakeIo(handler: (url: string, init?: RequestInit) => Promise<Response>): CliIo & {
  output(): string
  errorOutput(): string
} {
  let stdout = ''
  let stderr = ''
  return {
    fetch: handler as typeof fetch,
    stdout: text => { stdout += text },
    stderr: text => { stderr += text },
    output: () => stdout,
    errorOutput: () => stderr,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
