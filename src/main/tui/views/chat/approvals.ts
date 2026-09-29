// Approval actions shared by the chat keys, the dock's buttons (mouse mode)
// and /approve, /reject. Parity with Studio: approve, always approve (the
// daemon un-restricts the tool; never offered for protection overrides),
// reject, reject with feedback (the agent sees the text), details.

import type { TaskListEntry } from '../../api/types'
import type { TuiActions } from '../../state/store'

export const FEEDBACK_OVERLAY = 'chat.deny'

/** Why "always approve" is not offered for this call, or null when it is. */
export function alwaysBlocked(task: Pick<TaskListEntry, 'canAlwaysApprove' | 'alwaysApproveBlockedReason'>): string | null {
  if (task.canAlwaysApprove === false) return task.alwaysApproveBlockedReason || 'one-time approval only'
  return null
}

/** Always approve after a confirm (it is persistent). False when refused or cancelled. */
export async function alwaysApprove(actions: TuiActions, agentId: string, agentLabel: string, task: TaskListEntry): Promise<boolean> {
  const blocked = alwaysBlocked(task)
  if (blocked) {
    actions.toast(`Always approve is not available for ${task.tool}: ${blocked}. Approve it once (y) instead.`, 'warn', 5000)
    return false
  }
  const ok = await actions.confirm({
    title: 'Always approve',
    message: `Always approve ${task.tool} for ${agentLabel}? It won't ask again (undo in Inspect › Config › tools). This call runs now.`,
    confirmLabel: 'Always approve',
  })
  if (!ok) return false
  return actions.alwaysApproveTask(agentId, task.id)
}

/** Reject with feedback: a text box; the agent sees the text. */
export function rejectWithFeedback(actions: TuiActions, agentId: string, task: Pick<TaskListEntry, 'id' | 'tool'>): void {
  actions.pushOverlay({ kind: FEEDBACK_OVERLAY, props: { agentId, taskId: task.id, tool: task.tool } })
}
