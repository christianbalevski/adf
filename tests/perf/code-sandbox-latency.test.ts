import { describe, it, expect } from 'vitest'
import { performance } from 'perf_hooks'
import { appendFileSync } from 'fs'
import { CodeSandboxService } from '../../src/main/runtime/code-sandbox'

/**
 * Code sandbox latency benchmark. Opt-in (ADF_BENCH=1) — it spawns dozens of
 * sandboxes and prints numbers rather than asserting tight bounds.
 *
 *   cold service   first execute() on a fresh service (includes any host boot)
 *   cold sandbox   first execute() on a new sandbox id once the service is warm
 *   warm execute   trivial execute() on a resident sandbox
 *   adf rpc        one adf.* round trip from sandbox code (handler answers at once)
 *   cold lambda    ephemeral execute() + destroy, as a cold trigger lambda does
 */
const RUN = !!process.env.ADF_BENCH

function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}

function fmt(label: string, xs: number[]): string {
  return `${label.padEnd(14)} p50=${pct(xs, 50).toFixed(2)}ms p95=${pct(xs, 95).toFixed(2)}ms n=${xs.length}`
}

describe.skipIf(!RUN)('code sandbox latency', () => {
  it('measures cold/warm start and rpc latency', async () => {
    const agent = '0b8f2a4e-6c1d-4f3a-9b7e-2d5c8a1f4e90'
    const onAdfCall = async (): Promise<{ result: string }> => ({ result: '"ok"' })
    const lines: string[] = []

    const coldService: number[] = []
    for (let i = 0; i < 5; i++) {
      const svc = new CodeSandboxService()
      const t = performance.now()
      const r = await svc.execute(`${agent}:cs${i}`, 'return 1', 10_000)
      coldService.push(performance.now() - t)
      expect(r.error).toBeUndefined()
      svc.destroyAll()
      await new Promise((res) => setTimeout(res, 50))
    }
    lines.push(fmt('cold service', coldService))

    const svc = new CodeSandboxService()
    await svc.execute(`${agent}:boot`, 'return 1', 10_000)

    const coldSandbox: number[] = []
    for (let i = 0; i < 20; i++) {
      const t = performance.now()
      const r = await svc.execute(`${agent}:c${i}`, 'return 1', 10_000)
      coldSandbox.push(performance.now() - t)
      expect(r.error).toBeUndefined()
      svc.destroy(`${agent}:c${i}`)
    }
    lines.push(fmt('cold sandbox', coldSandbox))

    const warm: number[] = []
    for (let i = 0; i < 200; i++) {
      const t = performance.now()
      await svc.execute(agent, 'return 1', 10_000)
      warm.push(performance.now() - t)
    }
    lines.push(fmt('warm execute', warm))

    // adf rpc: 2000 sequential round trips inside one execution, per-call average
    const rpc: number[] = []
    for (let i = 0; i < 5; i++) {
      const r = await svc.execute(
        agent,
        `const t = Date.now(); for (let i = 0; i < 2000; i++) await adf.fs_read({ path: 'x' }); return (Date.now() - t) / 2000`,
        30_000,
        onAdfCall
      )
      expect(r.error).toBeUndefined()
      rpc.push(Number(r.result))
    }
    lines.push(fmt('adf rpc', rpc))

    // wall-clock per rpc measured from the host side (performance may not exist in-sandbox)
    const rpcHost: number[] = []
    for (let i = 0; i < 5; i++) {
      const t = performance.now()
      const r = await svc.execute(agent, `for (let i = 0; i < 500; i++) await adf.fs_read({ path: 'x' }); return 1`, 30_000, onAdfCall)
      expect(r.error).toBeUndefined()
      rpcHost.push((performance.now() - t) / 500)
    }
    lines.push(fmt('adf rpc(host)', rpcHost))

    const coldLambda: number[] = []
    for (let i = 0; i < 20; i++) {
      const id = `${agent}:lambda:x:${i}`
      const t = performance.now()
      const r = await svc.execute(id, `return await adf.fs_read({ path: 'x' })`, 10_000, onAdfCall, undefined, { ephemeral: true })
      coldLambda.push(performance.now() - t)
      expect(r.error).toBeUndefined()
      svc.destroy(id)
    }
    lines.push(fmt('cold lambda', coldLambda))

    svc.destroyAll()
    const report = '\n[code-sandbox bench]\n' + lines.join('\n') + '\n'
    if (process.env.ADF_BENCH_OUT) appendFileSync(process.env.ADF_BENCH_OUT, report)
    console.log(report)
  }, 120_000)
})
