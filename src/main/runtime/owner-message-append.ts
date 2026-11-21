/**
 * The owner's message to an agent that could not be started (unreviewed,
 * password-locked): written into its loop, so it is the next thing the agent
 * sees. Both modes (daemon POST /fleet/message, Studio's FLEET_MESSAGE).
 *
 * The write holds the agent's lease from the check to the end of the append:
 * another runtime that runs the file is its one writer (a row added beside it
 * gets no turn there, and could land between a tool_use and its result), and
 * it cannot start the agent while the row is written.
 */
import { AdfWorkspace } from '../adf/adf-workspace'
import type { LoopEntry } from '../../shared/types/adf-v02.types'
import type { AgentLeaseRegistry } from './agent-lease'

export async function appendOwnerMessageUnderLease(
  leases: AgentLeaseRegistry | null,
  filePath: string,
  text: string,
  opts: { workspace?: AdfWorkspace; onCommitted?: (row: LoopEntry) => void } = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  const releaseProbe = leases?.addHostedPathsProbe(() => [filePath])
  try {
    const lease = await leases?.acquire(filePath)
    if (lease && !lease.ok) return { ok: false, error: lease.message }
    const workspace = opts.workspace ?? AdfWorkspace.open(filePath)
    try {
      const content: LoopEntry['content_json'] = [{ type: 'text', text }]
      const createdAt = Date.now()
      const seq = workspace.appendToLoop('user', content, undefined, undefined, createdAt)
      // Notify in commit order, before the asynchronous lease cleanup.
      opts.onCommitted?.({ seq, role: 'user', content_json: content, created_at: createdAt })
    } finally {
      if (!opts.workspace) workspace.close()
    }
    return { ok: true }
  } finally {
    if (releaseProbe) {
      releaseProbe()
      await leases?.reconcile()
    }
  }
}
