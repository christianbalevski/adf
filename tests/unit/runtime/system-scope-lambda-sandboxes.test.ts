import { describe, it, expect } from 'vitest'
import { CodeSandboxService } from '../../../src/main/runtime/code-sandbox'
import { SystemScopeHandler } from '../../../src/main/runtime/system-scope-handler'
import type { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import type { AdfCallHandler } from '../../../src/main/runtime/adf-call-handler'
import type { AdfEventDispatch } from '../../../src/shared/types/adf-event.types'

/**
 * Every system lambda used to run under one `${agentId}:lambda` sandbox id.
 * That made a cold lambda's destroy() in `finally` tear down a worker other
 * lambdas were mid-execution on (their invocation failed with
 * SANDBOX_TERMINATED — for an accumulator, a silently lost increment), and it
 * put files with different authorization levels in one vm context.
 *
 * Sandbox ids are now partitioned by source file — the unit of authorization,
 * and the same granularity sys_lambda uses — stable when warm, per invocation
 * when cold.
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Live sandbox ids — the worker map is the only place the id scheme is visible. */
function sandboxIds(sandbox: CodeSandboxService): string[] {
  const workers = (sandbox as unknown as { workers: Map<string, unknown> }).workers
  return Array.from(workers.keys())
}

function makeHandler(
  sandbox: CodeSandboxService,
  agentId: string,
  files: Record<string, string>
): SystemScopeHandler {
  const workspace = {
    readFile: (p: string) => files[p] ?? null,
    isFileAuthorized: () => false,
    getAgentConfig: () => ({ limits: {} }),
    insertLog: () => {},
  } as unknown as AdfWorkspace

  const adfCallHandler = {
    setAuthorizationContext: () => {},
    getEnabledToolNames: () => [],
    getHilToolNames: () => [],
    getAuthorizationContext: () => false,
    handleCall: async () => ({ result: '{}' }),
  } as unknown as AdfCallHandler

  return new SystemScopeHandler(workspace, sandbox, adfCallHandler, agentId)
}

function dispatchFor(lambda: string, warm: boolean): AdfEventDispatch {
  return {
    event: { id: 'evt_1', type: 'timer', time: new Date().toISOString(), data: {} },
    scope: 'system',
    lambda,
    warm,
    timeout_ms: 8000,
  } as unknown as AdfEventDispatch
}

describe('SystemScopeHandler sandbox partitioning', () => {
  it('reuses one worker across invocations of a warm lambda', async () => {
    const sandbox = new CodeSandboxService()
    const agentId = 'test-warm-reuse.adf'
    const handler = makeHandler(sandbox, agentId, {
      'lib/counter.ts': 'export function tick() { globalThis.n = (globalThis.n || 0) + 1; return String(globalThis.n) }',
    })

    try {
      const first = await handler.execute(dispatchFor('lib/counter.ts:tick', true))
      const second = await handler.execute(dispatchFor('lib/counter.ts:tick', true))

      // Same context across invocations — that is the point of warm.
      expect(first).toBe('1')
      expect(second).toBe('2')
      expect(sandboxIds(sandbox)).toEqual([`${agentId}:lambda:lib/counter.ts`])
    } finally {
      sandbox.destroyForAgent(agentId)
    }
  }, 30000)

  it('gives two warm lambdas separate contexts', async () => {
    const sandbox = new CodeSandboxService()
    const agentId = 'test-warm-split.adf'
    const handler = makeHandler(sandbox, agentId, {
      'lib/a.ts': 'export function a() { globalThis.n = (globalThis.n || 0) + 1; return String(globalThis.n) }',
      'lib/b.ts': 'export function b() { globalThis.n = (globalThis.n || 0) + 1; return String(globalThis.n) }',
    })

    try {
      await handler.execute(dispatchFor('lib/a.ts:a', true))
      const b = await handler.execute(dispatchFor('lib/b.ts:b', true))

      // Shared context would have made b see a's counter.
      expect(b).toBe('1')
      expect(sandboxIds(sandbox).sort()).toEqual([
        `${agentId}:lambda:lib/a.ts`,
        `${agentId}:lambda:lib/b.ts`,
      ])
    } finally {
      sandbox.destroyForAgent(agentId)
    }
  }, 30000)

  it('does not let a cold lambda wipe a warm lambda\'s context', async () => {
    const sandbox = new CodeSandboxService()
    const agentId = 'test-cold-vs-warm.adf'
    const handler = makeHandler(sandbox, agentId, {
      'lib/acc.ts': 'export function acc() { globalThis.n = (globalThis.n || 0) + 1; return String(globalThis.n) }',
      'lib/cold.ts': 'export function cold() { return "cold" }',
    })

    try {
      expect(await handler.execute(dispatchFor('lib/acc.ts:acc', true))).toBe('1')
      // The regression: this destroy() used to terminate the one shared
      // `${agentId}:lambda` worker, silently resetting the accumulator.
      expect(await handler.execute(dispatchFor('lib/cold.ts:cold', false))).toBe('cold')
      expect(await handler.execute(dispatchFor('lib/acc.ts:acc', true))).toBe('2')
    } finally {
      sandbox.destroyForAgent(agentId)
    }
  }, 30000)

  it('does not let one cold lambda finishing disturb another in flight', async () => {
    const sandbox = new CodeSandboxService()
    const agentId = 'test-cold-isolation.adf'
    const handler = makeHandler(sandbox, agentId, {
      'lib/slow.ts': 'export async function slow() { await new Promise(r => setTimeout(r, 800)); return "slow-done" }',
      'lib/quick.ts': 'export function quick() { return "quick-done" }',
    })

    try {
      // The regression: quick's destroy() in `finally` used to terminate the
      // shared `${agentId}:lambda` worker slow was still running on.
      const slow = handler.execute(dispatchFor('lib/slow.ts:slow', false))
      await sleep(200)
      const quick = await handler.execute(dispatchFor('lib/quick.ts:quick', false))
      expect(quick).toBe('quick-done')

      expect(await slow).toBe('slow-done')
    } finally {
      sandbox.destroyForAgent(agentId)
    }
  }, 30000)

  it('does not let two invocations of the same cold lambda disturb each other', async () => {
    const sandbox = new CodeSandboxService()
    const agentId = 'test-cold-same-lambda.adf'
    const handler = makeHandler(sandbox, agentId, {
      'lib/acc.ts': 'export async function acc(e) { await new Promise(r => setTimeout(r, e.data.wait)); return "acc-" + e.data.wait }',
    })

    const withWait = (wait: number): AdfEventDispatch => {
      const d = dispatchFor('lib/acc.ts:acc', false) as unknown as { event: { data: unknown } }
      d.event.data = { wait }
      return d as unknown as AdfEventDispatch
    }

    try {
      const long = handler.execute(withWait(800))
      await sleep(200)
      const short = await handler.execute(withWait(1))

      expect(short).toBe('acc-1')
      expect(await long).toBe('acc-800')
    } finally {
      sandbox.destroyForAgent(agentId)
    }
  }, 30000)

  it('leaves no worker behind when a cold lambda completes', async () => {
    const sandbox = new CodeSandboxService()
    const agentId = 'test-cold-cleanup.adf'
    const handler = makeHandler(sandbox, agentId, {
      'lib/one.ts': 'export function one() { return "one" }',
    })

    try {
      expect(await handler.execute(dispatchFor('lib/one.ts:one', false))).toBe('one')
      // Per-invocation ids are only safe if each destroys itself.
      expect(sandboxIds(sandbox)).toEqual([])
    } finally {
      sandbox.destroyForAgent(agentId)
    }
  }, 30000)
})

describe('CodeSandboxService.destroyForAgent', () => {
  it('reaps every sandbox derived from the agent id, and nobody else\'s', async () => {
    const sandbox = new CodeSandboxService()
    const agentId = 'test-reap.adf'
    const otherId = 'test-reap-other.adf'
    const handler = makeHandler(sandbox, agentId, {
      'lib/warm.ts': 'export function warm() { return "warm" }',
    })

    try {
      // Agent-owned sandboxes across the id schemes in use today. Every real
      // call site declares its owning agent, which is what the reap uses —
      // string-prefix matching would let an agent named `C` reap `C:\...` ids.
      const owned = { agent: agentId }
      await sandbox.execute(agentId, 'return 1', 5000, undefined, undefined, owned)
      await sandbox.execute(`${agentId}:mw:inbox`, 'return 1', 5000, undefined, undefined, owned)
      await sandbox.execute(`${agentId}:fn:lib/util.ts`, 'return 1', 5000, undefined, undefined, owned)
      await sandbox.execute(`${agentId}:tap:audit`, 'return 1', 5000, undefined, undefined, owned)
      await handler.execute(dispatchFor('lib/warm.ts:warm', true))
      await sandbox.execute(otherId, 'return 1', 5000, undefined, undefined, { agent: otherId })

      expect(sandboxIds(sandbox)).toHaveLength(6)

      sandbox.destroyForAgent(agentId)

      // Only the unrelated agent survives — no leaked workers.
      expect(sandboxIds(sandbox)).toEqual([otherId])
    } finally {
      sandbox.destroyAll()
    }
  }, 30000)

  it('defers reaping a derived sandbox that is still executing', async () => {
    const sandbox = new CodeSandboxService()
    const agentId = 'test-reap-inflight.adf'

    try {
      const running = sandbox.execute(
        `${agentId}:lambda:lib/slow.ts`,
        'await new Promise(r => setTimeout(r, 500)); return "done"',
        8000,
        undefined,
        undefined,
        { agent: agentId }
      )
      await sleep(150)
      sandbox.destroyForAgent(agentId)

      // destroy() defers while in-flight, so the execution still completes...
      expect((await running).result).toBe('done')
      // ...and the worker is reaped once it does.
      expect(sandboxIds(sandbox)).toEqual([])
    } finally {
      sandbox.destroyAll()
    }
  }, 30000)
})
