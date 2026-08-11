import { describe, it, expect, vi } from 'vitest'
import { executeMiddlewareChain } from '../../../src/main/services/middleware-executor'
import type { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import type { CodeSandboxService } from '../../../src/main/runtime/code-sandbox'
import type { AdfCallHandler } from '../../../src/main/runtime/adf-call-handler'

function harness(files: Record<string, string> = {}) {
  const logs: { level: string; message: string }[] = []
  const workspace = {
    readFile: (p: string) => files[p] ?? null,
    insertLog: (level: string, _o: string, _a: string, _t: string, message: string) => { logs.push({ level, message }) },
    getAgentConfig: () => ({ id: 'a1', security: { require_middleware_authorization: false }, limits: {} }),
    isFileAuthorized: () => true
  } as unknown as AdfWorkspace

  const execute = vi.fn(async () => ({ stdout: '', result: JSON.stringify({}) }))
  const sandbox = { execute } as unknown as CodeSandboxService
  const callHandler = {
    setAuthorizationContext: () => {},
    handleCall: async () => ({}),
    getEnabledToolNames: () => [],
    getHilToolNames: () => []
  } as unknown as AdfCallHandler

  return { workspace, sandbox, callHandler, execute, logs }
}

describe('middleware-executor lambda-ref hardening', () => {
  it('refuses a lambda ref whose function name is not a bare identifier', async () => {
    const h = harness({ 'lib/mw.ts': 'export function ok() {}' })
    await executeMiddlewareChain(
      [{ lambda: "lib/mw.ts:ok'); process.exit(1); ('" }],
      { point: 'fetch', data: {}, meta: {} },
      h.workspace, h.sandbox, h.callHandler, 'a1'
    )
    expect(h.execute).not.toHaveBeenCalled()
    expect(h.logs.some(l => /Invalid lambda reference/.test(l.message))).toBe(true)
  })

  it('refuses a lambda ref whose path carries quotes or traversal', async () => {
    const h = harness()
    for (const lambda of ['lib/"+x+".ts:handler', '../../etc/passwd.ts:handler', 'lib/a\nb.ts:handler']) {
      await executeMiddlewareChain(
        [{ lambda }],
        { point: 'fetch', data: {}, meta: {} },
        h.workspace, h.sandbox, h.callHandler, 'a1'
      )
    }
    expect(h.execute).not.toHaveBeenCalled()
    expect(h.logs.filter(l => /Invalid lambda reference/.test(l.message))).toHaveLength(3)
  })

  it('embeds attacker-controlled data as a literal that cannot break the wrapper', async () => {
    const h = harness({ 'lib/mw.ts': 'export function handler(i) { return i }' })
    const hostile = "');globalThis.PWNED=1;('" + String.fromCharCode(0x2028, 0x2029)
    await executeMiddlewareChain(
      [{ lambda: 'lib/mw.ts:handler' }],
      { point: 'fetch', data: { url: hostile }, meta: {} },
      h.workspace, h.sandbox, h.callHandler, 'a1'
    )
    expect(h.execute).toHaveBeenCalledOnce()
    const code = h.execute.mock.calls[0][1] as unknown as string
    // Line/paragraph separators are escaped, never emitted raw into source.
    expect(code).not.toContain(String.fromCharCode(0x2028))
    expect(code).not.toContain(String.fromCharCode(0x2029))
    expect(code).toContain('\\u2028')
    // The payload survives as data, not as code.
    const call = code.match(/return await handler\((\{[\s\S]*\})\);/)
    expect(call).toBeTruthy()
    expect(JSON.parse(call![1]).data.url).toBe(hostile)
  })
})
