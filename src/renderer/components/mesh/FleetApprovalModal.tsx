import { memo, useCallback, useEffect } from 'react'
import { useMeshStore } from '../../stores/mesh.store'
import { useMeshGraphStore } from '../../stores/mesh-graph.store'
import { useDocumentStore } from '../../stores/document.store'
import { ApprovalControls } from '../agent/ApprovalControls'
import { ToolCallModal } from '../agent/ToolCallModal'
import { pickAgentIcon } from '../../../shared/constants/agent-icons'

/**
 * Full-context HIL approval modal — thin wrapper around the unified
 * ToolCallModal (same inspector as the loop chat) that supplies the map's
 * approval wiring: which agent is asking, respond/always-approve plumbing
 * for foreground vs background agents, and the "Open agent" escape hatch.
 * Closing does NOT resolve the approval — it just returns you to the map.
 */
export const FleetApprovalModal = memo(function FleetApprovalModal({
  filePath,
  onClose,
  onOpenAgent
}: {
  filePath: string
  onClose: () => void
  /** Open the agent's document + loop panel (closes the modal). */
  onOpenAgent?: () => void
}) {
  const agent = useMeshStore((s) => s.agents.find((a) => a.filePath === filePath))
  const pending = useMeshGraphStore((s) => s.pendingInteractions[filePath])
  const setPendingInteraction = useMeshGraphStore((s) => s.setPendingInteraction)
  const foregroundFilePath = useDocumentStore((s) => s.filePath)
  const isForeground = foregroundFilePath === filePath

  // The approval resolved elsewhere (loop, tile, lambda) — nothing to decide
  useEffect(() => {
    if (!pending || pending.type !== 'approval') onClose()
  }, [pending, onClose])

  const respond = useCallback((approved: boolean, feedback?: string) => {
    if (!pending || pending.type !== 'approval') return
    if (isForeground) {
      window.adfApi.respondToolApproval(pending.requestId, approved, feedback)
    } else {
      window.adfApi.respondBackgroundAgentToolApproval(filePath, pending.requestId, approved, feedback)
    }
    setPendingInteraction(filePath, null)
    onClose()
  }, [pending, filePath, isForeground, setPendingInteraction, onClose])

  // Server-side always-approve: the main process flips the declaration and
  // approves, refusing when the declaration or target is locked. On refusal
  // the request stays pending so the user can still Approve once.
  const alwaysApprove = useCallback(async () => {
    if (!pending || pending.type !== 'approval') return
    const toolName = pending.toolName ?? 'tool'
    const result = isForeground
      ? await window.adfApi.alwaysApproveTool(pending.requestId, toolName)
      : await window.adfApi.alwaysApproveBackgroundAgentTool(filePath, pending.requestId, toolName)
    if (result && !result.success) {
      console.warn(`[FleetApprovalModal] Always approve refused for ${toolName}: ${result.error}`)
      return
    }
    setPendingInteraction(filePath, null)
    onClose()
  }, [pending, filePath, isForeground, setPendingInteraction, onClose])

  if (!pending || pending.type !== 'approval') return null

  return (
    <ToolCallModal
      variant="absolute"
      toolName={pending.toolName ?? 'tool'}
      input={pending.input}
      awaitingApproval
      approvalTitle={pending.protection?.description}
      subtitle={filePath}
      headerLead={
        <span className="flex items-center gap-2 min-w-0 shrink-0">
          <span className="text-2xl leading-none shrink-0">
            {agent?.icon || pickAgentIcon(agent?.agentId || filePath)}
          </span>
          <span className="text-[14px] font-semibold text-neutral-800 dark:text-neutral-100 truncate max-w-40">
            {agent?.handle ?? filePath.split('/').pop()?.replace(/\.adf$/, '')}
          </span>
          <span className="text-[12px] text-neutral-400 dark:text-neutral-500 shrink-0">wants to call</span>
        </span>
      }
      headerActions={onOpenAgent && (
        <button
          onClick={onOpenAgent}
          className="px-2.5 py-1 text-[11px] font-medium rounded-full border border-neutral-200 dark:border-neutral-700 text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 shrink-0 whitespace-nowrap"
          title="Open this agent's document and loop — the approval stays pending"
        >
          Open agent
        </button>
      )}
      approvalControls={
        <ApprovalControls
          dropUp
          toolName={pending.toolName ?? 'tool'}
          onApprove={() => respond(true)}
          onAlwaysApprove={() => void alwaysApprove()}
          onReject={(feedback) => respond(false, feedback)}
          alwaysApproveDisabled={pending.canAlwaysApprove === false}
          alwaysApproveDisabledReason={pending.alwaysApproveBlockedReason}
        />
      }
      onClose={onClose}
    />
  )
})
