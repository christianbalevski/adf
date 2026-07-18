import { memo, useCallback, useEffect, useMemo } from 'react'
import { useMeshStore } from '../../stores/mesh.store'
import { useMeshGraphStore } from '../../stores/mesh-graph.store'
import { useDocumentStore } from '../../stores/document.store'
import { ApprovalControls } from '../agent/ApprovalControls'
import { pickAgentIcon } from '../../../shared/constants/agent-icons'

/**
 * Full-context HIL approval modal — the map's answer to the loop's tool
 * inspector: everything known about the pending call (who, which tool, the
 * agent's stated reason, the complete arguments) at readable size, so the
 * decision isn't made off a tile-sized summary. Same modal family as the
 * readouts: backdrop blur, Esc / click-away to close (closing does NOT
 * resolve the approval — it just returns you to the map).
 */
export const FleetApprovalModal = memo(function FleetApprovalModal({
  filePath,
  onClose
}: {
  filePath: string
  onClose: () => void
}) {
  const agent = useMeshStore((s) => s.agents.find((a) => a.filePath === filePath))
  const pending = useMeshGraphStore((s) => s.pendingInteractions[filePath])
  const setPendingInteraction = useMeshGraphStore((s) => s.setPendingInteraction)
  const foregroundFilePath = useDocumentStore((s) => s.filePath)
  const isForeground = foregroundFilePath === filePath

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  // The approval resolved elsewhere (loop, tile, lambda) — nothing to decide
  useEffect(() => {
    if (!pending || pending.type !== 'approval') onClose()
  }, [pending, onClose])

  const { reason, argsStr } = useMemo(() => {
    const inp = pending?.input && typeof pending.input === 'object' ? (pending.input as Record<string, unknown>) : undefined
    const reason = inp && typeof inp._reason === 'string' ? inp._reason : undefined
    const rest = inp ? Object.fromEntries(Object.entries(inp).filter(([k]) => k !== '_reason')) : undefined
    let argsStr: string | undefined
    if (rest && Object.keys(rest).length > 0) {
      try { argsStr = JSON.stringify(rest, null, 2) } catch { argsStr = String(rest) }
    }
    return { reason, argsStr }
  }, [pending])

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

  const alwaysApprove = useCallback(async () => {
    if (!pending || pending.type !== 'approval') return
    const toolName = pending.toolName ?? 'tool'
    if (isForeground) {
      const cfg = await window.adfApi.getAgentConfig()
      if (cfg) {
        const tools = cfg.tools ? [...cfg.tools] : []
        const idx = tools.findIndex((t) => t.name === toolName)
        if (idx >= 0) tools[idx] = { ...tools[idx], enabled: true, restricted: false }
        else tools.push({ name: toolName, enabled: true, visible: true, restricted: false })
        await window.adfApi.setAgentConfig({ ...cfg, tools })
      }
      window.adfApi.respondToolApproval(pending.requestId, true)
    } else {
      window.adfApi.alwaysApproveBackgroundAgentTool(filePath, pending.requestId, toolName)
    }
    setPendingInteraction(filePath, null)
    onClose()
  }, [pending, filePath, isForeground, setPendingInteraction, onClose])

  if (!pending || pending.type !== 'approval') return null

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      style={{ animation: 'meshFadeIn 150ms ease-out' }}
      onClick={onClose}
    >
      <div
        className="w-[620px] max-w-[92vw] max-h-[82vh] flex flex-col rounded-2xl bg-white/95 dark:bg-neutral-900/95 border border-neutral-200 dark:border-neutral-700 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header — who wants what */}
        <div className="flex items-center gap-3 px-5 pt-4 pb-3">
          <span className="text-3xl leading-none shrink-0">
            {agent?.icon || pickAgentIcon(agent?.agentId || filePath)}
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-[15px] font-semibold text-neutral-800 dark:text-neutral-100 truncate">
                {agent?.handle ?? filePath.split('/').pop()?.replace(/\.adf$/, '')}
              </span>
              <span className="text-[12px] text-neutral-400 dark:text-neutral-500 shrink-0">wants to call</span>
              <span className="text-[13px] font-mono font-semibold text-orange-500 shrink-0">{pending.toolName}</span>
              <span className="text-[10px] px-1.5 py-px rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-600 dark:text-amber-400 font-medium shrink-0">
                awaiting approval
              </span>
            </div>
            <div className="text-[10px] text-neutral-400 dark:text-neutral-500 truncate" title={filePath}>
              {filePath}
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-full text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 shrink-0"
            title="Close (Esc) — leaves the approval pending"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-4 space-y-3">
          {/* The agent's stated reason */}
          {reason && (
            <div className="px-4 py-3 rounded-xl bg-amber-50/70 dark:bg-amber-900/15 border border-amber-200 dark:border-amber-900/40">
              <div className="text-[10px] uppercase tracking-wide text-amber-600/80 dark:text-amber-400/80 mb-1">reason</div>
              <div className="text-[13px] leading-relaxed text-neutral-700 dark:text-neutral-200 whitespace-pre-wrap">
                {reason}
              </div>
            </div>
          )}

          {/* Full arguments */}
          <div>
            <div className="text-[10px] uppercase tracking-wide text-neutral-400 dark:text-neutral-500 mb-1">arguments</div>
            {argsStr ? (
              <pre className="text-[12px] font-mono leading-relaxed text-neutral-700 dark:text-neutral-200 bg-neutral-50 dark:bg-neutral-900/60 border border-neutral-200 dark:border-neutral-700 rounded-xl p-3 overflow-auto max-h-[46vh] whitespace-pre-wrap break-all">
                {argsStr}
              </pre>
            ) : (
              <div className="text-[12px] italic text-neutral-400 dark:text-neutral-500">no arguments</div>
            )}
          </div>
        </div>

        {/* Decision bar */}
        <div className="flex items-center justify-end gap-3 px-5 py-3 border-t border-neutral-100 dark:border-neutral-800">
          <ApprovalControls
            dropUp
            toolName={pending.toolName ?? 'tool'}
            onApprove={() => respond(true)}
            onAlwaysApprove={() => void alwaysApprove()}
            onReject={(feedback) => respond(false, feedback)}
          />
        </div>
      </div>
    </div>
  )
})
