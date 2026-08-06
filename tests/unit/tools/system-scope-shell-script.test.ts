import { describe, it, expect, vi } from 'vitest'
import { SystemScopeHandler } from '../../../src/main/runtime/system-scope-handler'
import { createEvent, createDispatch } from '../../../src/shared/types/adf-event.types'

/**
 * Timers/triggers firing shell scripts: a system-scope dispatch whose lambda
 * ends in .sh routes through the shell script runner instead of the JS
 * sandbox — no shim lambda required.
 */

function makeHandler(vfs: Record<string, string>) {
  const logs: Array<{ level: string; message: string }> = []
  const toolCalls: string[] = []

  const fakeRegistry: any = {
    executeTool: vi.fn(async (name: string, input: any) => {
      toolCalls.push(name)
      if (name === 'fs_read') {
        const content = vfs[input.path]
        if (content === undefined) return { content: `not found: ${input.path}`, isError: true }
        return { content: JSON.stringify({ path: input.path, content }), isError: false }
      }
      return { content: '{}', isError: false }
    }),
    get: () => undefined,
  }
  const workspace: any = {
    getAgentConfig: () => ({ name: 'agent-1', tools: [{ name: 'fs_read', enabled: true }], limits: {} }),
    insertLog: (level: string, _origin: string, _event: string | null, _target: string | null, message: string) => {
      logs.push({ level, message })
    },
    readFile: (p: string) => vfs[p] ?? null,
    isFileAuthorized: () => false,
  }
  const codeSandbox: any = { execute: vi.fn(async () => ({ result: 'ok' })), destroy: vi.fn() }
  const adfCallHandler: any = {
    getToolRegistry: () => fakeRegistry,
    setAuthorizationContext: () => {},
    getAuthorizationContext: () => false,
    getEnabledToolNames: () => ['fs_read'],
    getHilToolNames: () => [],
  }
  const handler = new SystemScopeHandler(workspace, codeSandbox, adfCallHandler, 'agent-uuid-1')
  return { handler, logs, toolCalls, codeSandbox }
}

function makeDispatch(lambda: string) {
  const event = createEvent({ type: 'timer' as const, source: 'system', data: { timer: { id: 1, payload: null } } as any })
  return createDispatch(event, { scope: 'system' as any, lambda })
}

describe('system-scope .sh lambda routing', () => {
  it('runs a .sh lambda through the shell script runner', async () => {
    const { handler, logs, toolCalls, codeSandbox } = makeHandler({
      'jobs/task.sh': '# maintenance\necho hello\n',
    })
    await handler.execute(makeDispatch('jobs/task.sh'))
    expect(toolCalls).toContain('fs_read')
    expect(codeSandbox.execute).not.toHaveBeenCalled()
    expect(logs.some(l => l.level === 'info' && l.message.includes('completed'))).toBe(true)
  })

  it('normalizes a leading ./ on the script path', async () => {
    const { handler, logs } = makeHandler({ 'jobs/task.sh': 'echo hi\n' })
    await handler.execute(makeDispatch('./jobs/task.sh'))
    expect(logs.some(l => l.level === 'info' && l.message.includes('completed'))).toBe(true)
  })

  it('logs an error when the script is missing', async () => {
    const { handler, logs } = makeHandler({})
    await handler.execute(makeDispatch('jobs/nope.sh'))
    expect(logs.some(l => l.level === 'error')).toBe(true)
  })

  it('.ts lambda still routes to the code sandbox', async () => {
    const { handler, codeSandbox } = makeHandler({
      'jobs/task.ts': 'async function main(event) { return 1 }',
    })
    await handler.execute(makeDispatch('jobs/task.ts'))
    expect(codeSandbox.execute).toHaveBeenCalled()
  })
})
