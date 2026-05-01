import { useState, useCallback, useRef } from 'react'
import { Dialog } from './Dialog'
import { useAppStore } from '../../stores/app.store'
import { useAdfFile } from '../../hooks/useAdfFile'
import type { AgentConfigSummary } from '../../../shared/types/ipc.types'

const TIER_STYLES = {
  shared: {
    badge: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
    label: 'Shared',
    description: 'Runs in shared container with other agents',
  },
  isolated: {
    badge: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
    label: 'Isolated',
    description: 'Runs in its own isolated container',
  },
  host: {
    badge: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
    label: 'Host Access',
    description: 'Can run processes on your host machine',
  },
} as const

function CapabilityRow({ label, value, amber }: { label: string; value: string; amber?: boolean }) {
  if (!value) return null
  return (
    <div className="flex items-start gap-3 py-1.5">
      <span className="text-[11px] text-neutral-500 dark:text-neutral-400 w-20 shrink-0 text-right">
        {amber && <span className="text-amber-500 mr-1">!</span>}
        {label}
      </span>
      <span className={`text-[11px] flex-1 ${amber ? 'text-amber-700 dark:text-amber-400' : 'text-neutral-700 dark:text-neutral-300'}`}>
        {value}
      </span>
    </div>
  )
}

function ReviewContent({ summary }: { summary: AgentConfigSummary }) {
  const tier = TIER_STYLES[summary.computeTier]

  // Tools summary
  const enabledTools = summary.tools.filter((t) => t.enabled)
  const notableTools = enabledTools.filter((t) => t.notable)
  const toolsSummary = notableTools.length > 0
    ? `${enabledTools.length} enabled — ${notableTools.map((t) => t.name).join(', ')}`
    : `${enabledTools.length} enabled`

  // MCP summary
  const mcpSummary = summary.mcpServers.length > 0
    ? summary.mcpServers.map((s) => s.name).join(', ')
    : ''

  // Triggers summary
  const activeTriggers = summary.triggers.filter((t) => t.enabled)
  const triggersSummary = activeTriggers.length > 0
    ? activeTriggers.map((t) => t.type).join(', ')
    : ''

  // Messaging summary
  const msgParts: string[] = [summary.messaging.mode]
  if (summary.messaging.channels.length > 0) {
    msgParts.push(`${summary.messaging.channels.length} channel${summary.messaging.channels.length > 1 ? 's' : ''}`)
  }
  const messagingSummary = msgParts.join(', ')

  // Network: WS connections
  const wsCount = summary.network.wsConnections.length
  const wsSummary = wsCount > 0
    ? `${wsCount} outbound: ${summary.network.wsConnections.map((ws) => ws.did ?? ws.url).join(', ')}`
    : ''

  // Network: Adapters
  const adaptersSummary = summary.network.adapters.length > 0
    ? summary.network.adapters.join(', ')
    : ''

  // Network: Serving
  const servingSummary = summary.network.serving
    ? `${summary.network.serving.routeCount} API route${summary.network.serving.routeCount > 1 ? 's' : ''}`
    : ''

  // Autostart
  const autostartSummary = summary.autostart
    ? (wsCount > 0 || summary.network.adapters.length > 0)
      ? 'Yes — connects on boot'
      : 'Yes'
    : ''

  const hasNetwork = wsSummary || adaptersSummary || servingSummary || autostartSummary
  const tableProtectionsSummary = summary.security.tableProtections.length > 0
    ? summary.security.tableProtections
        .map((p) => `${p.table}: ${p.protection === 'append_only' ? 'append-only' : 'authorized only'}`)
        .join(', ')
    : ''

  return (
    <div className="space-y-4">
      {/* Agent identity */}
      <div>
        <h3 className="text-sm font-medium text-neutral-800 dark:text-neutral-200 mb-1">
          {summary.name}
        </h3>
        {summary.description && (
          <p className="text-[11px] text-neutral-500 dark:text-neutral-400 mb-2">
            {summary.description}
          </p>
        )}
        {summary.ownerDid && (
          <p className="text-[10px] text-neutral-400 dark:text-neutral-500 font-mono truncate">
            Owner: {summary.ownerDid}
          </p>
        )}
      </div>

      {/* Compute tier */}
      <div className="p-3 rounded-lg bg-neutral-50 dark:bg-neutral-900/50 border border-neutral-200 dark:border-neutral-700">
        <div className="flex items-center gap-2 mb-1">
          <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-medium rounded-full ${tier.badge}`}>
            {tier.label}
          </span>
          <span className="text-[11px] text-neutral-500 dark:text-neutral-400">
            Compute Environment
          </span>
        </div>
        <p className="text-[11px] text-neutral-600 dark:text-neutral-400">
          {tier.description}
        </p>
      </div>

      {/* Capabilities */}
      <div>
        <h4 className="text-[11px] font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wide mb-1">
          Capabilities
        </h4>
        <div className="rounded-lg bg-neutral-50 dark:bg-neutral-900/50 border border-neutral-200 dark:border-neutral-700 px-3 py-1">
          <CapabilityRow label="Tools" value={toolsSummary} amber={notableTools.length > 0} />
          <CapabilityRow label="MCP" value={mcpSummary} />
          <CapabilityRow label="Triggers" value={triggersSummary} />
          {summary.codeExecution && <CapabilityRow label="Code" value="Code execution enabled" amber />}
          <CapabilityRow label="Messaging" value={messagingSummary} />
        </div>
      </div>

      {/* Network */}
      {hasNetwork && (
        <div>
          <h4 className="text-[11px] font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wide mb-1">
            Network
          </h4>
          <div className="rounded-lg bg-neutral-50 dark:bg-neutral-900/50 border border-neutral-200 dark:border-neutral-700 px-3 py-1">
            <CapabilityRow label="WebSocket" value={wsSummary} amber={wsCount > 0} />
            <CapabilityRow label="Adapters" value={adaptersSummary} amber={summary.network.adapters.length > 0} />
            <CapabilityRow label="Serving" value={servingSummary} />
            <CapabilityRow label="Autostart" value={autostartSummary} amber={summary.autostart && (wsCount > 0 || summary.network.adapters.length > 0)} />
          </div>
        </div>
      )}

      {/* Security */}
      {tableProtectionsSummary && (
        <div>
          <h4 className="text-[11px] font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wide mb-1">
            Security
          </h4>
          <div className="rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 px-3 py-1">
            <CapabilityRow label="Tables" value={tableProtectionsSummary} amber />
          </div>
        </div>
      )}
    </div>
  )
}

export function AgentReviewDialog() {
  const open = useAppStore((s) => s.agentReviewDialogOpen)
  const summary = useAppStore((s) => s.agentReviewSummary)
  const setDialog = useAppStore((s) => s.setAgentReviewDialog)
  const expandRightPanelToTab = useAppStore((s) => s.expandRightPanelToTab)
  const { closeFile, loadFileContents } = useAdfFile()
  const [loading, setLoading] = useState(false)
  const successRef = useRef(false)

  const handleAccept = useCallback(async () => {
    setLoading(true)
    try {
      await window.adfApi.acceptAgentReview()
      // Reload config since locked_fields changed
      await loadFileContents()
      successRef.current = true
      setDialog(false)
    } catch (err) {
      console.error('[AgentReviewDialog] Accept error:', err)
    } finally {
      setLoading(false)
    }
  }, [setDialog, loadFileContents])

  const handleReviewConfig = useCallback(async () => {
    // Close dialog without accepting — user wants to inspect config first.
    // Review will re-trigger next time the file is opened.
    successRef.current = true
    setDialog(false)
    expandRightPanelToTab('agent', 'config')
  }, [setDialog, expandRightPanelToTab])

  // Dismiss: close dialog without closing the file. Review re-triggers on next open.
  const handleDismiss = useCallback(() => {
    successRef.current = true
    setDialog(false)
  }, [setDialog])

  const handleCancel = useCallback(async () => {
    setDialog(false)
    await closeFile()
  }, [setDialog, closeFile])

  const handleDialogClose = useCallback(() => {
    if (successRef.current) {
      successRef.current = false
      return
    }
    // Escape/backdrop click = dismiss (not cancel)
    handleDismiss()
  }, [handleDismiss])

  return (
    <Dialog open={open} onClose={handleDialogClose} title="Review Agent" wide>
      {/* Close button */}
      <button
        onClick={handleDismiss}
        className="absolute top-4 right-4 w-6 h-6 flex items-center justify-center rounded-md text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700"
        title="Dismiss"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>

      {summary && <ReviewContent summary={summary} />}

      <div className="flex justify-between items-center mt-5">
        <button
          onClick={handleCancel}
          className="px-3 py-1.5 text-xs text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg"
        >
          Reject & Close
        </button>
        <div className="flex gap-2">
          <button
            onClick={handleReviewConfig}
            disabled={loading}
            className="px-3 py-1.5 text-xs border border-neutral-300 dark:border-neutral-600 text-neutral-700 dark:text-neutral-300 rounded-lg hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Review Config
          </button>
          <button
            onClick={handleAccept}
            disabled={loading}
            className="px-4 py-1.5 text-xs bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Accepting...' : 'Accept & Open'}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
