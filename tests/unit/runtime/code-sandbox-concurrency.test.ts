import { describe, it, expect } from 'vitest'
import type { Worker } from 'worker_threads'
import { CodeSandboxService } from '../../../src/main/runtime/code-sandbox'
import type { AdfCallResult, ToolConfig } from '../../../src/main/runtime/code-sandbox'

/**
 * Regression suite for the "lambda burns 300s of CPU and reports success" bug.
 *
 * Three defects fed each other: RPC ids were worker-local (so the main thread's
 * global dedup dropped a fresh worker's first call as a duplicate), the drain
 * loop counted every execution's pending calls and ran to the execution
 * deadline, and a terminated worker left its execute() promises hanging until
 * the guard timer fired. Each is pinned below.
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Reach into the private worker map — the callId/worker plumbing has no public surface. */
function workerFor(sandbox: CodeSandboxService, agentId: string): Worker {
  const workers = (sandbox as unknown as { workers: Map<string, { worker: Worker }> }).workers
  const entry = workers.get(agentId)
  if (!entry) throw new Error(`no worker for ${agentId}`)
  return entry.worker
}

describe('CodeSandboxService concurrent execution isolation', () => {
  it('does not extend one execution\'s drain with another execution\'s pending adf call', async () => {
    const sandbox = new CodeSandboxService()
    const agentId = 'test-drain-isolation'

    // Never answers — mimics a call whose reply was dropped on the main thread.
    const onAdfCall = async (method: string): Promise<AdfCallResult> => {
      if (method === 'fs_list') return new Promise<AdfCallResult>(() => {})
      return { result: JSON.stringify({ ok: true }) }
    }

    try {
      // Execution A leaves an unanswered call in flight on the shared worker.
      const a = sandbox.execute(agentId, 'adf.fs_list({}); return "a"', 8000, onAdfCall)
      await sleep(150)

      // B does nothing async. Before the fix its drain looped on A's pending
      // call until B's own 8s deadline — and still reported success.
      const t0 = Date.now()
      const b = await sandbox.execute(agentId, 'return "b"', 8000, onAdfCall)
      const elapsed = Date.now() - t0

      expect(b.error).toBeUndefined()
      expect(b.result).toBe('b')
      expect(elapsed).toBeLessThan(1500)

      await a
    } finally {
      sandbox.destroy(agentId)
    }
  }, 20000)

  it('caps the drain when the execution\'s own adf call is never answered, and says so', async () => {
    const sandbox = new CodeSandboxService()
    const agentId = 'test-drain-cap'

    const onAdfCall = async (): Promise<AdfCallResult> => new Promise<AdfCallResult>(() => {})

    try {
      const t0 = Date.now()
      const result = await sandbox.execute(agentId, 'adf.fs_list({}); return "x"', 8000, onAdfCall)
      const elapsed = Date.now() - t0

      expect(result.result).toBe('x')
      // Drain budget is half the execution timeout (4s of 8s), not the full
      // deadline — and the truncation is reported rather than swallowed.
      expect(elapsed).toBeLessThan(6000)
      expect(elapsed).toBeGreaterThan(3500)
      expect(result.stdout).toContain('output truncated')
    } finally {
      sandbox.destroy(agentId)
    }
  }, 20000)

  it('keeps output from an unawaited adf call that answers well past two seconds', async () => {
    // A flat 2s drain wall dropped everything a slow model_invoke / sys_fetch /
    // compute_exec logged from its .then() chain — silently, while still
    // reporting success. The drain now follows the call, bounded by the
    // execution's own budget.
    const sandbox = new CodeSandboxService()
    const agentId = 'test-drain-slow-call'

    const onAdfCall = async (): Promise<AdfCallResult> => {
      await sleep(2600)
      return { result: JSON.stringify({ ok: true }) }
    }

    try {
      const r = await sandbox.execute(
        agentId,
        'adf.sys_fetch({url:"x"}).then(v => console.log("late:" + v.ok)); return "done"',
        60000,
        onAdfCall
      )
      expect(r.result).toBe('done')
      expect(r.stdout).toContain('late:true')
      expect(r.stdout).not.toContain('output truncated')
    } finally {
      sandbox.destroy(agentId)
    }
  }, 60000)

  it('gives each concurrent execution its own tool config', async () => {
    // The worker held ONE global toolConfig, overwritten by every 'setup'. An
    // authorized execution was refused REQUIRES_AUTHORIZED_CODE because an
    // unauthorized one started 50ms after it.
    const sandbox = new CodeSandboxService()
    const agentId = 'test-setup-race'
    const cfg = (isAuthorized: boolean): ToolConfig => ({
      enabledTools: ['danger'],
      hilTools: ['danger'],
      isAuthorized
    })
    const onAdfCall = async (): Promise<AdfCallResult> => ({ result: JSON.stringify({ ok: true }) })

    try {
      // Warm the worker so both executions land on the same one.
      await sandbox.execute(agentId, 'return 1', 5000, onAdfCall, cfg(true), { handlerAuthorized: true })

      const authorized = sandbox.execute(
        agentId,
        'await new Promise(r => setTimeout(r, 400));' +
        ' try { await adf.danger({}); return "allowed" } catch (e) { return e.code || e.message }',
        8000,
        onAdfCall,
        cfg(true),
        { handlerAuthorized: true }
      )
      await sleep(50)
      const unauthorized = sandbox.execute(
        agentId, 'return "b"', 8000, onAdfCall, cfg(false), { handlerAuthorized: false }
      )

      const [a, b] = await Promise.all([authorized, unauthorized])
      expect(a.result).toBe('allowed')
      expect(b.result).toBe('b')
    } finally {
      sandbox.destroy(agentId)
    }
  }, 30000)

  it('answers a fresh sandbox\'s first adf call while another sandbox has one stuck', async () => {
    const sandbox = new CodeSandboxService()
    const stuckId = 'test-collide-stuck'
    const liveId = 'test-collide-live'

    const hang = async (): Promise<AdfCallResult> => new Promise<AdfCallResult>(() => {})
    const answer = async (method: string): Promise<AdfCallResult> => ({
      result: JSON.stringify({ ok: true, method })
    })

    try {
      // Both workers used to mint 'call_1' first, and the main thread's global
      // dedup set dropped the second one — the live sandbox hung until timeout.
      const stuck = sandbox.execute(stuckId, 'adf.fs_list({}); return "kicked"', 6000, hang)
      await sleep(150)

      const t0 = Date.now()
      const live = await sandbox.execute(
        liveId,
        'const r = await adf.fs_list({}); return r.ok ? "answered" : "unexpected"',
        6000,
        answer
      )
      const elapsed = Date.now() - t0

      expect(live.error).toBeUndefined()
      expect(live.result).toBe('answered')
      expect(elapsed).toBeLessThan(3500)

      await stuck
    } finally {
      sandbox.destroy(stuckId)
      sandbox.destroy(liveId)
    }
  }, 20000)

  it('mints distinct callIds in different workers', async () => {
    const sandbox = new CodeSandboxService()
    const idA = 'test-callid-a'
    const idB = 'test-callid-b'
    const seen: Record<string, string[]> = { a: [], b: [] }
    const answer = async (): Promise<AdfCallResult> => ({ result: JSON.stringify({ ok: true }) })

    try {
      await sandbox.execute(idA, 'return 1', 5000)
      await sandbox.execute(idB, 'return 1', 5000)

      const watch = (agentId: string, key: string): void => {
        workerFor(sandbox, agentId).on('message', (msg: { type?: string; callId?: string }) => {
          if (msg && msg.type === 'adf_call' && msg.callId) seen[key].push(msg.callId)
        })
      }
      watch(idA, 'a')
      watch(idB, 'b')

      await Promise.all([
        sandbox.execute(idA, 'return await adf.fs_list({})', 5000, answer),
        sandbox.execute(idB, 'return await adf.fs_list({})', 5000, answer)
      ])

      expect(seen.a).toHaveLength(1)
      expect(seen.b).toHaveLength(1)
      expect(seen.a[0]).not.toBe(seen.b[0])
    } finally {
      sandbox.destroy(idA)
      sandbox.destroy(idB)
    }
  }, 20000)
})

/**
 * Sandboxes are persistent by design, so a helper stored by one execution can
 * be called by a later one — its captured `adf` proxy still carries the first
 * execution's id. Those orphaned calls used to be answered by whichever
 * execution was newest, which meant an unauthorized file's stored closure could
 * be served by an authorized file's handler.
 */
describe('CodeSandboxService orphaned adf calls', () => {
  const cfg = (isAuthorized: boolean): { enabledTools: string[]; hilTools: string[]; isAuthorized: boolean } => ({
    enabledTools: [],
    hilTools: [],
    isAuthorized
  })
  /** Reports which handler answered, so the test can see the authorization used. */
  const handlerFor = (isAuthorized: boolean, seen: boolean[]) =>
    async (): Promise<AdfCallResult> => {
      seen.push(isAuthorized)
      return { result: JSON.stringify({ authorized: isAuthorized }) }
    }

  const STORE_HELPER = 'globalThis.helper = async () => await adf.fs_list({}); return "stored"'
  const CALL_HELPER =
    'try { const r = await globalThis.helper(); return r.authorized ? "authorized" : "unauthorized" }' +
    ' catch (e) { return e.code || e.message }'

  it('answers an orphaned call with its own owner\'s authorization', async () => {
    const sandbox = new CodeSandboxService()
    const agentId = 'test-orphan-own-auth'
    const seen: boolean[] = []

    try {
      // Unauthorized file parks a helper in the shared context...
      await sandbox.execute(agentId, STORE_HELPER, 5000, handlerFor(false, seen), cfg(false))
      // ...an authorized execution calls it. The call belongs to the first.
      const r = await sandbox.execute(agentId, CALL_HELPER, 5000, handlerFor(true, seen), cfg(true))

      expect(r.result).toBe('unauthorized')
      expect(seen).toEqual([false])
    } finally {
      sandbox.destroy(agentId)
    }
  }, 30000)

  it('still answers an orphan whose owner is gone when the sandbox has one auth level', async () => {
    const sandbox = new CodeSandboxService()
    const agentId = 'test-orphan-single-level'
    const seen: boolean[] = []

    try {
      await sandbox.execute(agentId, STORE_HELPER, 5000, handlerFor(false, seen), cfg(false))
      // Push the owner past the retention cap — warm helpers must keep working.
      for (let i = 0; i < 13; i++) {
        await sandbox.execute(agentId, 'return 1', 5000, handlerFor(false, seen), cfg(false))
      }

      const r = await sandbox.execute(agentId, CALL_HELPER, 5000, handlerFor(false, seen), cfg(false))
      expect(r.result).toBe('unauthorized')
      expect(seen).toEqual([false])
    } finally {
      sandbox.destroy(agentId)
    }
  }, 60000)

  it('answers an unattributable orphan when the handler it would borrow is unauthorized', async () => {
    // The gate used to key off authLevels alone, so a mixed-level worker
    // refused every unattributable orphan — including this one, where the only
    // live handler is UNAUTHORIZED and answering through it could only
    // downgrade. The decision now looks at the borrow target's own
    // authorization, which is what PendingExec.isAuthorized is for.
    const sandbox = new CodeSandboxService()
    const agentId = 'test-orphan-downgrade-ok'
    const seen: boolean[] = []

    try {
      await sandbox.execute(agentId, STORE_HELPER, 5000, handlerFor(false, seen), cfg(false),
        { handlerAuthorized: false })
      // Evict the owner's retained record with AUTHORIZED executions, so the
      // worker now holds two authorization levels.
      for (let i = 0; i < 13; i++) {
        await sandbox.execute(agentId, 'return 1', 5000, handlerFor(true, seen), cfg(true),
          { handlerAuthorized: true })
      }

      const r = await sandbox.execute(agentId, CALL_HELPER, 5000, handlerFor(false, seen), cfg(false),
        { handlerAuthorized: false })
      expect(r.result).toBe('unauthorized')
      expect(seen[seen.length - 1]).toBe(false)
    } finally {
      sandbox.destroy(agentId)
    }
  }, 60000)

  it('takes the handler\'s real authorization, not the ambient one toolConfig carries', async () => {
    // Every call site derives toolConfig.isAuthorized from
    // getAuthorizationContext(), which prefers the caller's ALS value — so
    // sys_code, whose handler is hard-bound to withAuthorization(false),
    // reported `true` whenever it ran inside an authorized lambda and poisoned
    // the worker's authLevels for good.
    const sandbox = new CodeSandboxService()
    const agentId = 'test-handler-auth-wins'
    const seen: boolean[] = []

    try {
      // toolConfig claims authorized; the handler is bound unauthorized.
      await sandbox.execute(agentId, 'return 1', 5000, handlerFor(false, seen), cfg(true),
        { handlerAuthorized: false })
      const entry = (sandbox as unknown as {
        workers: Map<string, { authLevels: Set<boolean> }>
      }).workers.get(agentId)!
      expect([...entry.authLevels]).toEqual([false])
    } finally {
      sandbox.destroy(agentId)
    }
  }, 30000)

  it('refuses an unattributable orphan rather than upgrading its authorization', async () => {
    const sandbox = new CodeSandboxService()
    const agentId = 'test-orphan-refused'
    const seen: boolean[] = []

    try {
      await sandbox.execute(agentId, STORE_HELPER, 5000, handlerFor(false, seen), cfg(false))
      // Evict the owner's retained record; the evicting executions are authorized,
      // so the worker now holds two authorization levels.
      for (let i = 0; i < 13; i++) {
        await sandbox.execute(agentId, 'return 1', 5000, handlerFor(true, seen), cfg(true))
      }

      const r = await sandbox.execute(agentId, CALL_HELPER, 5000, handlerFor(true, seen), cfg(true))
      expect(r.result).toBe('ORPHANED_CALL')
      // No handler ran at all — the call was refused, not silently upgraded.
      expect(seen).toEqual([])
    } finally {
      sandbox.destroy(agentId)
    }
  }, 60000)
})

describe('CodeSandboxService worker death', () => {
  it('settles in-flight executions immediately when the worker is terminated', async () => {
    const sandbox = new CodeSandboxService()
    const agentId = 'test-terminate-settles'

    try {
      await sandbox.execute(agentId, 'return 1', 5000)

      // 20s execution: before the fix this promise waited out the guard timer
      // (timeout + 2000) even though the worker was already gone.
      const pending = sandbox.execute(
        agentId,
        'await new Promise(r => setTimeout(r, 15000)); return "late"',
        20000
      )
      await sleep(200)

      const t0 = Date.now()
      await workerFor(sandbox, agentId).terminate()
      const result = await pending
      const elapsed = Date.now() - t0

      expect(result.errorCode).toBe('SANDBOX_TERMINATED')
      expect(result.error).toContain('terminated')
      expect(elapsed).toBeLessThan(1000)
    } finally {
      sandbox.destroy(agentId)
    }
  }, 20000)

  it('lets a terminated sandbox id start a fresh worker', async () => {
    const sandbox = new CodeSandboxService()
    const agentId = 'test-terminate-recreate'

    try {
      await sandbox.execute(agentId, 'globalThis.marker = 1; return "first"', 5000)
      await workerFor(sandbox, agentId).terminate()

      const result = await sandbox.execute(agentId, 'return typeof globalThis.marker', 5000)
      expect(result.error).toBeUndefined()
      expect(result.result).toBe('undefined')
    } finally {
      sandbox.destroy(agentId)
    }
  }, 20000)

  it('shares one worker between concurrent first executions via the creating map', async () => {
    const sandbox = new CodeSandboxService()
    const agentId = 'test-worker-creation-race'

    // The previous version of this test passed for the wrong reason: worker
    // creation registered its entry in `workers` synchronously, so the second
    // call always took the `existing` fast path and the join map was never
    // touched (it passed identically against the pre-fix implementation).
    // Admission control put a suspension point ahead of creation, so the join
    // map is now what actually prevents a duplicate worker — count the joins.
    const creating = (sandbox as unknown as { creating: Map<string, unknown> }).creating
    const realGet = Map.prototype.get.bind(creating)
    let joins = 0
    ;(creating as unknown as { get: (k: string) => unknown }).get = (k: string): unknown => {
      const v = realGet(k)
      if (v !== undefined) joins++
      return v
    }

    try {
      const [a, b] = await Promise.all([
        sandbox.execute(agentId, 'globalThis.hits = (globalThis.hits || 0) + 1; return "a"', 5000),
        sandbox.execute(agentId, 'globalThis.hits = (globalThis.hits || 0) + 1; return "b"', 5000)
      ])

      expect(a.result).toBe('a')
      expect(b.result).toBe('b')
      expect(joins).toBeGreaterThan(0)

      // A single shared worker means the shared context saw both executions.
      const hits = await sandbox.execute(agentId, 'return globalThis.hits', 5000)
      expect(hits.result).toBe('2')
    } finally {
      sandbox.destroy(agentId)
    }
  }, 20000)

  it('settles execute() when the sandbox is destroyed while the worker is booting', async () => {
    // createWorker() awaited 'ready' with no timer and no rejection path, and
    // registered exit/error only AFTER that await. A worker killed mid-boot
    // left a promise that never settled — and `creating` cached it, so every
    // later execute() on the id joined the dead promise permanently.
    const sandbox = new CodeSandboxService()
    const agentId = 'test-creation-death'

    const first = sandbox.execute(agentId, 'return 1', 2000)
    sandbox.destroyAll() // shutdown / mesh disable landing mid-boot

    const outcome = await Promise.race([
      first.then((r) => r.errorCode ?? 'ok'),
      sleep(8000).then(() => 'HUNG')
    ])
    expect(outcome).not.toBe('HUNG')

    // The id is not poisoned: a later execution builds a fresh worker.
    const creating = (sandbox as unknown as { creating: Map<string, unknown> }).creating
    expect(creating.size).toBe(0)

    try {
      const second = await Promise.race([
        sandbox.execute(agentId, 'return 2', 5000),
        sleep(8000).then(() => ({ result: 'HUNG' }))
      ])
      expect(second.result).toBe('2')
    } finally {
      sandbox.destroy(agentId)
    }
  }, 30000)
})
