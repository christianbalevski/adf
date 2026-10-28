import { memo, useCallback, useEffect, useState } from 'react'
import { useMeshStore } from '../../stores/mesh.store'
import { useMeshGraphStore } from '../../stores/mesh-graph.store'
import { ApprovalControls } from '../agent/ApprovalControls'
import { ToolCallModal } from '../agent/ToolCallModal'
import { OrbitalAvatar } from '../orbital/OrbitalAvatar'
import { orbitalSeedFor } from '../orbital/orbital-seed'
import { mapTarget, selectMapAgents } from './runtime-fleet'
import { useOpenAgentKey } from '../../utils/runtime-api'

/** Where the on-demand fetch of an approval's raw input stands. */
export type ApprovalInputFetch =
  | { status: 'loading' }
  | { status: 'loaded'; input: unknown }
  | { status: 'unavailable'; reason?: string }

/**
 * The line the modal shows about the arguments: none once they are there,
 * otherwise that they are loading or unavailable and why. Never an empty
 * body with no word on it.
 */
export function approvalInputNotice(fetch: ApprovalInputFetch, snapshotInput: unknown): string | undefined {
  if (fetch.status === 'loaded' || snapshotInput != null) return undefined
  if (fetch.status === 'loading') return 'Loading arguments…'
  return fetch.reason ? `Arguments unavailable: ${fetch.reason}` : 'Arguments unavailable'
}

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
  const agent = useMeshStore((s) => selectMapAgents(s).find((a) => a.filePath === filePath))
  const pending = useMeshGraphStore((s) => s.pendingInteractions[filePath])
  const setPendingInteraction = useMeshGraphStore((s) => s.setPendingInteraction)
  // The open agent's map id: the foreground calls apply only to it, on its runtime (multi-runtime.md §6.4).
  const foregroundFilePath = useOpenAgentKey()
  const isForeground = foregroundFilePath === filePath

  // Raw tool input for the inspector. The ApprovalHub broadcast snapshot no
  // longer carries it (B8) — it can be large and value-sensitive — so fetch it
  // on demand for the full-context modal, falling back to whatever the snapshot
  // still provides (older main builds, or a redacted preview).
  const [inputFetch, setInputFetch] = useState<ApprovalInputFetch>({ status: 'loading' })
  // The hub keys entries by its own id, not the executor's request id.
  const approvalId = pending?.type === 'approval' ? pending.approvalId : undefined
  const isApproval = pending?.type === 'approval'
  useEffect(() => {
    if (!isApproval) return
    if (!approvalId) {
      setInputFetch({ status: 'unavailable', reason: 'the runtime did not send the request id' })
      return
    }
    const target = mapTarget(filePath)
    const api = target.api as { getApprovalInput?: (filePath: string, approvalId: string) => Promise<unknown> } | undefined
    if (!api?.getApprovalInput) {
      setInputFetch({ status: 'unavailable', reason: 'this runtime cannot send arguments' })
      return
    }
    // A new request never shows the previous one's arguments.
    setInputFetch({ status: 'loading' })
    let cancelled = false
    void api.getApprovalInput(target.filePath, approvalId).then((input) => {
      if (cancelled) return
      setInputFetch(input != null ? { status: 'loaded', input } : { status: 'unavailable', reason: 'the runtime no longer has this request' })
    }).catch((err: unknown) => {
      if (!cancelled) setInputFetch({ status: 'unavailable', reason: err instanceof Error ? err.message : String(err) })
    })
    return () => { cancelled = true }
  }, [filePath, approvalId, isApproval])

  // The approval resolved elsewhere (loop, tile, lambda) — nothing to decide
  useEffect(() => {
    if (!pending || pending.type !== 'approval') onClose()
  }, [pending, onClose])

  const respond = useCallback((approved: boolean, feedback?: string) => {
    if (!pending || pending.type !== 'approval') return
    if (isForeground) {
      mapTarget(filePath).api.respondToolApproval(pending.requestId, approved, feedback)
    } else {
      const t = mapTarget(filePath)
      t.api.respondBackgroundAgentToolApproval(t.filePath, pending.requestId, approved, feedback)
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
    const t = mapTarget(filePath)
    const result = isForeground
      ? await t.api.alwaysApproveTool(pending.requestId, toolName)
      : await t.api.alwaysApproveBackgroundAgentTool(t.filePath, pending.requestId, toolName)
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
      input={inputFetch.status === 'loaded' ? inputFetch.input : pending.input}
      inputNotice={approvalInputNotice(inputFetch, pending.input)}
      awaitingApproval
      approvalTitle={pending.protection?.description}
      subtitle={filePath}
      headerLead={
        <span className="flex items-center gap-2 min-w-0 shrink-0">
          <span className="text-2xl leading-none shrink-0">
            <OrbitalAvatar seed={orbitalSeedFor({ did: agent?.did, filePath })} icon={agent?.icon} iconSeed={agent?.agentId || filePath} size={28} emojiSize={24} />
          </span>
          <span className="text-[14px] font-semibold text-neutral-800 dark:text-neutral-100 truncate max-w-40">
            {agent?.handle ?? filePath.split('/').pop()?.replace(/\.adf$/, '')}
          </span>
          <span className="text-[12px] text-[var(--adf-ui-text-subtle)] shrink-0">wants to call</span>
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
