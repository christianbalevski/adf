// The daemon's boot envelope sweep (spec §8), as Studio runs it from
// registerAllIpcHandlers: 2 s after boot, every reviewed agent in the tracked
// folders that has no keys is provisioned (keys, DID, owner and operator
// attestations) and plain secret rows are sealed. Same sweep
// (OwnerIdentityService.sweepEnvelopeMigration), same skip rule and log line.
//
// The daemon's owner identity can be missing or locked at boot (`adf
// identity new`, `unlock`): the sweep then says it was skipped and runs once
// the owner identity becomes ready, in the same daemon run.

import type { AgentLeaseRegistry } from '../runtime/agent-lease'
import { openHereOrLeasedElsewhere } from '../runtime/agent-lease'
import { describeEnvelopeSweep, type EnvelopeSweepResult } from '../services/owner-identity.service'

export interface BootEnvelopeSweepDeps {
  identity: {
    sweepEnvelopes(skip: (filePath: string) => Promise<boolean>): Promise<EnvelopeSweepResult>
    onReady(listener: (ownerDid: string) => void): void
  }
  leases: AgentLeaseRegistry
  /** Files this daemon has loaded or holds open as documents (provisioned when opened). */
  openHere: () => string[]
  log?: (line: string) => void
  warn?: (line: string, err: unknown) => void
}

export interface BootEnvelopeSweep {
  /** Run it now; resolves when done. Skipped (and said) while the owner identity is not ready. */
  run(): Promise<void>
}

export function createBootEnvelopeSweep(deps: BootEnvelopeSweepDeps): BootEnvelopeSweep {
  const log = deps.log ?? ((line) => console.log(line))
  const warn = deps.warn ?? ((line, err) => console.warn(line, err))
  let waitingForOwner = false
  const run = async (): Promise<void> => {
    try {
      const t0 = performance.now()
      const sweep = await deps.identity.sweepEnvelopes((filePath) => openHereOrLeasedElsewhere(deps.leases, filePath, deps.openHere()))
      const line = describeEnvelopeSweep(sweep, performance.now() - t0)
      if (sweep.ownerNotReady) {
        waitingForOwner = true
        log(`${line}; it runs when the owner identity becomes ready in this daemon run`)
        return
      }
      if (line) log(line)
    } catch (err) {
      warn('[OwnerIdentity] Envelope sweep failed:', err)
    }
  }
  deps.identity.onReady(() => {
    if (!waitingForOwner) return
    waitingForOwner = false
    log('[OwnerIdentity] The owner identity is ready: running the envelope sweep skipped at boot')
    void run()
  })
  return { run }
}
