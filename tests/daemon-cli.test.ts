import { describe, expect, it } from 'vitest'
import { runCli, type CliIo } from '../src/main/cli'

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
})

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
