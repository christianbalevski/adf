// The approvals hub over the daemon API: Studio's title-bar menu and the
// fleet map's pending badges (APPROVALS_*, MESH_PENDING_INTERACTIONS).
//
//   GET  /approvals                      pending + history (NotificationsSnapshot)
//   GET  /approvals/input?filePath=&approvalId=
//   POST /approvals/resolve              { filePath, approvalId, approved, feedback? }
//   GET  /approvals/interactions         pending asks + approvals per agent (main loop)
//
// Every executor registers its blocking requests in the process-wide
// approvalHub, whichever host built it, so the daemon's hub already holds
// every loaded agent's approvals and asks. These routes read it and resolve
// through it, exactly as Studio's handlers do. Entries are keyed by the
// agent's file path, as the snapshot reports it.

import type { FastifyInstance } from 'fastify'
import { approvalHub } from '../../runtime/approval-hub'
import { deriveHandle } from '../../utils/handle'
import { summarizeAsk } from '../../../shared/utils/ask-form'
import type { FleetPendingInteraction } from '../../../shared/types/ipc.types'
import type { DaemonRouteContext } from './index'
import { badRequest, stringParam } from './route-helpers'

export function registerApprovalsRoutes(server: FastifyInstance, ctx: DaemonRouteContext): void {
  server.get('/approvals', async () => approvalHub.fullSnapshot())

  // The snapshot omits each approval's raw tool input (it can be large); the
  // full-context modal fetches it here. `{}` when the entry is gone or
  // belongs to another file (Studio's handler returns undefined).
  server.get<{ Querystring: { filePath?: string; approvalId?: string } }>('/approvals/input', async (request, reply) => {
    const filePath = stringParam(request.query.filePath)
    const approvalId = stringParam(request.query.approvalId)
    if (!filePath || !approvalId) return badRequest(reply, 'filePath and approvalId are required')
    const input = approvalHub.getApprovalInput(filePath, approvalId)
    return input === undefined ? {} : { input }
  })

  // Routes into the emitting executor's own resolveApproval, the in-chat
  // card's path. A request that is gone answers { success: false, error }.
  server.post<{ Body: { filePath?: unknown; approvalId?: unknown; approved?: unknown; feedback?: unknown } }>('/approvals/resolve', async (request) => {
    const body = request.body ?? {}
    const filePath = stringParam(body.filePath)
    const approvalId = stringParam(body.approvalId)
    if (!filePath || !approvalId) return { success: false, error: 'filePath and approvalId are required' }
    const feedback = typeof body.feedback === 'string' ? body.feedback : undefined
    return approvalHub.resolve(filePath, approvalId, body.approved === true, feedback)
  })

  // The pull-shaped view of the same hub state: per agent, its main loop's
  // asks, then its approvals, with the raw tool input. Studio no longer
  // renders it; kept for out-of-band callers, as Studio keeps the channel.
  server.get('/approvals/interactions', async (): Promise<FleetPendingInteraction[]> => {
    const handles = new Map<string, string>()
    for (const agent of ctx.runtime.listAgents()) {
      if (agent.filePath) handles.set(agent.filePath, agent.handle || deriveHandle(agent.filePath))
    }
    const pending = approvalHub.snapshot().filter((entry) => entry.loop === 'main')
    const order = [...new Set(pending.map((entry) => entry.filePath))]
    const out: FleetPendingInteraction[] = []
    for (const filePath of order) {
      const handle = handles.get(filePath) ?? deriveHandle(filePath)
      const mine = pending.filter((entry) => entry.filePath === filePath)
      for (const ask of mine.filter((entry) => entry.kind === 'ask')) {
        // `question` is the one-line summary, as the executor's getPendingAsks (the hub row carries every question's text).
        const questions = ask.questions ?? []
        out.push({ filePath, handle, type: 'ask', requestId: ask.requestId, question: questions.length > 0 ? summarizeAsk(questions) : ask.question, questions })
      }
      for (const approval of mine.filter((entry) => entry.kind === 'approval')) {
        out.push({
          filePath,
          handle,
          type: 'approval',
          requestId: approval.requestId,
          toolName: approval.toolName,
          input: approvalHub.getApprovalInput(filePath, approval.id),
          reason: approval.reason,
          protection: approval.protection,
          canAlwaysApprove: approval.canAlwaysApprove,
          alwaysApproveBlockedReason: approval.alwaysApproveBlockedReason,
        })
      }
    }
    return out
  })
}
