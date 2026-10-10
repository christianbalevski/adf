import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SandboxHost, permissionModelUnsupported } from '../../../src/main/runtime/sandbox-host'

/**
 * What code that escaped the vm realm would still face: the sandbox host is a
 * separate process under Node's permission model. A probe runs as the worker
 * script itself (no vm, no membrane) and reports what the process allows.
 */
describe('sandbox host process permissions', () => {
  const allowed = mkdtempSync(join(tmpdir(), 'adf-host-allowed-'))
  const outside = mkdtempSync(join(tmpdir(), 'adf-host-outside-'))
  writeFileSync(join(allowed, 'pkg.txt'), 'ok')
  writeFileSync(join(outside, 'secret.txt'), 'secret')
  const hosts: SandboxHost[] = []

  afterAll(() => {
    for (const h of hosts) h.kill()
    rmSync(allowed, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  const probe = `
    const { parentPort } = require('worker_threads');
    const fs = require('fs');
    const cp = require('child_process');
    const out = {};
    function attempt(name, fn) {
      try { const v = fn(); out[name] = v === undefined ? 'allowed' : v; }
      catch (e) { out[name] = 'denied:' + (e.code || e.message); }
    }
    attempt('readAllowed', () => fs.readFileSync(${JSON.stringify(join(allowed, 'pkg.txt'))}, 'utf-8'));
    attempt('readOutside', () => fs.readFileSync(${JSON.stringify(join(outside, 'secret.txt'))}, 'utf-8'));
    attempt('writeAllowed', () => fs.writeFileSync(${JSON.stringify(join(allowed, 'w.txt'))}, 'x'));
    attempt('spawn', () => { cp.execFileSync(process.execPath, ['-e', '1']); });
    attempt('addon', () => { process.dlopen({ exports: {} }, ${JSON.stringify(join(allowed, 'x.node'))}); });
    attempt('nestedWorker', () => { new (require('worker_threads').Worker)('1', { eval: true }).terminate(); });
    out.envKeys = Object.keys(process.env);
    parentPort.postMessage({ type: 'probe', out });
  `

  it('allows reading the allowlist and nothing else', async () => {
    const host = new SandboxHost([allowed], { script: probe, prelude: '' })
    hosts.push(host)
    const worker = host.spawnWorker()
    const out = await new Promise<Record<string, unknown>>((resolve, reject) => {
      worker.on('message', (m: { type: string; out: Record<string, unknown> }) => {
        if (m.type === 'probe') resolve(m.out)
      })
      worker.on('error', reject)
      setTimeout(() => reject(new Error('probe timed out')), 20_000)
    })
    expect(out.readAllowed).toBe("ok")
    expect(out.readOutside).toMatch(/^denied:ERR_ACCESS_DENIED/)
    expect(out.writeAllowed).toMatch(/^denied:ERR_ACCESS_DENIED/)
    expect(out.spawn).toMatch(/^denied:ERR_ACCESS_DENIED/)
    expect(out.addon).toMatch(/^denied:(ERR_DLOPEN_DISABLED|ERR_ACCESS_DENIED)/)
    expect(out.envKeys).toEqual([])
  }, 30_000)

  it('refuses to start on a Node without the permission model', () => {
    expect(permissionModelUnsupported({ node: '20.18.0' })).toMatch(/Node\.js 22\.13 or newer/)
    expect(permissionModelUnsupported({ node: '22.12.0' })).toMatch(/22\.13/)
    expect(permissionModelUnsupported({ node: '22.13.0' })).toBeNull()
    expect(permissionModelUnsupported({ node: '24.1.0', electron: '40.0.0' })).toBeNull()
  })
})
