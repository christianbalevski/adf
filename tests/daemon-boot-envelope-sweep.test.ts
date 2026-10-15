// The daemon's boot envelope sweep (W5-G review, items 7 and 8): files the
// daemon has loaded or holds open are skipped, as sweepRevokedSlots does;
// with no ready owner identity the sweep says it was skipped and runs once
// the owner identity becomes ready, in the same daemon run.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBootEnvelopeSweep } from '../src/main/daemon/boot-envelope-sweep'
import { AgentLeaseRegistry } from '../src/main/runtime/agent-lease'
import type { EnvelopeSweepResult } from '../src/main/services/owner-identity.service'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    try { await fn() } catch { /* best effort */ }
  }
})

function setup() {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'adf-boot-sweep-')))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const leases = new AgentLeaseRegistry({ dir: join(dir, 'leases'), kind: 'daemon', settingsPath: join(dir, 'adf-settings.json'), sweepDeadEntries: false })
  cleanups.push(() => leases.close())
  const files = ['agent-1', 'agent-2', 'agent-3'].map((name) => { const p = join(dir, `${name}.adf`); writeFileSync(p, ''); return p })
  return { dir, leases, files }
}

const DONE: EnvelopeSweepResult = { provisioned: 0, sealed: 0, failures: [], skipped: [] }

describe('daemon boot envelope sweep', () => {
  it('skips the files the daemon has loaded or holds open; sweeps the rest', async () => {
    const { leases, files } = setup()
    const [loaded, openDoc, free] = files
    const lines: string[] = []
    const opened: string[] = []
    const sweep = createBootEnvelopeSweep({
      identity: {
        async sweepEnvelopes(skip) {
          const skipped: string[] = []
          for (const f of files) (await skip(f) ? skipped : opened).push(f)
          return { ...DONE, skipped }
        },
        onReady() {},
      },
      leases,
      openHere: () => [loaded, openDoc],
      log: (line) => lines.push(line),
    })
    await sweep.run()
    expect(opened).toEqual([free])
    expect(lines.join('\n')).toContain('2 open here or run by another runtime')
  })

  it('with no ready owner: says it was skipped, and runs when the owner identity becomes ready', async () => {
    const { leases } = setup()
    let ready = false
    let readyListener: ((did: string) => void) | null = null
    let runs = 0
    const lines: string[] = []
    const sweep = createBootEnvelopeSweep({
      identity: {
        async sweepEnvelopes() {
          runs++
          return ready ? { ...DONE, provisioned: 2 } : { ...DONE, ownerNotReady: true }
        },
        onReady(listener) { readyListener = listener },
      },
      leases,
      openHere: () => [],
      log: (line) => lines.push(line),
    })
    await sweep.run()
    expect(runs).toBe(1)
    expect(lines[0]).toMatch(/Envelope sweep skipped: the owner identity is not ready.*runs when the owner identity becomes ready/)
    ready = true
    readyListener!('did:key:z6Mkowner')
    await expect.poll(() => runs).toBe(2)
    await expect.poll(() => lines.some((l) => l.includes('2 provisioned'))).toBe(true)
    // Once: a later ready event (an owner switch) does not run it again.
    readyListener!('did:key:z6Mkother')
    await new Promise((r) => setTimeout(r, 20))
    expect(runs).toBe(2)
  })
})
