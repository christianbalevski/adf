import { useState, useCallback, useRef } from 'react'
import { Dialog } from './Dialog'
import { useAppStore } from '../../stores/app.store'
import { useAdfFile } from '../../hooks/useAdfFile'
import type { AgentConfigSummary, ReviewIdentitySummary } from '../../../shared/types/ipc.types'
import { Button, IconButton, TextInput } from '../ui'

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

const SCENARIO_STYLES: Record<ReviewIdentitySummary['scenario'], { badge: string; label: string; monogram: string }> = {
  mine: {
    badge: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
    label: 'Yours',
    monogram: 'from-green-400 to-emerald-600',
  },
  recognized: {
    badge: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
    label: 'Yours · another install',
    monogram: 'from-blue-400 to-indigo-600',
  },
  foreign: {
    badge: 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400',
    label: 'From another owner',
    monogram: 'from-violet-400 to-blue-600',
  },
  unclaimed: {
    badge: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
    label: 'No identity',
    monogram: 'from-amber-400 to-orange-500',
  },
}

function Monogram({ name, scenario, size }: { name: string; scenario: ReviewIdentitySummary['scenario']; size: 'sm' | 'lg' }) {
  const initial = (name || '?').charAt(0).toUpperCase()
  const dims = size === 'lg' ? 'w-14 h-14 text-2xl' : 'w-8 h-8 text-sm'
  return (
    <div className={`${dims} shrink-0 rounded-full bg-gradient-to-br ${SCENARIO_STYLES[scenario].monogram} flex items-center justify-center text-white font-semibold select-none`}>
      {initial}
    </div>
  )
}

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
  const identity = summary.identity
  const scenario = SCENARIO_STYLES[identity.scenario]

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
  const messagingSummary = summary.messaging.mode

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
      <div className="flex items-start gap-3">
        <Monogram name={summary.name} scenario={identity.scenario} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-0.5">
            <h3 className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
              {summary.name}
            </h3>
            <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-medium rounded-full ${scenario.badge}`}>
              {scenario.label}
            </span>
          </div>
          {summary.description && (
            <p className="text-[11px] text-neutral-500 dark:text-neutral-400 mb-1">
              {summary.description}
            </p>
          )}
          {identity.fileOwnerDid && !identity.ownerIsYou && (
            <p className="text-[10px] text-neutral-400 dark:text-neutral-500 font-mono truncate">
              From: {identity.fileOwnerDid}
            </p>
          )}
          {identity.agentDid && (
            <p className="text-[10px] text-neutral-400 dark:text-neutral-500 font-mono truncate">
              Agent: {identity.agentDid}
            </p>
          )}
        </div>
      </div>

      {identity.scenario === 'unclaimed' && (
        <p className="rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-warning)]/30 bg-[var(--adf-ui-warning-subtle)] px-3 py-2 text-[11px] text-[var(--adf-ui-warning)]">
          This agent has no identity, so its origin can't be verified — anyone could have
          made it. Give its capabilities a careful look before accepting.
        </p>
      )}
      {identity.seedUnavailable && (
        <p className="rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-warning)]/30 bg-[var(--adf-ui-warning-subtle)] px-3 py-2 text-[11px] text-[var(--adf-ui-warning)]">
          This file is yours, but its keys can't be unlocked here — import your seed
          phrase in Settings → Identity to use it on this machine.
        </p>
      )}

      {/* Compute tier */}
      <div className="rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] bg-[var(--adf-ui-canvas)] p-3">
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
        <div className="rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] bg-[var(--adf-ui-canvas)] px-3 py-1">
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
          <div className="rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] bg-[var(--adf-ui-canvas)] px-3 py-1">
            <CapabilityRow label="WebSocket" value={wsSummary} amber={wsCount > 0} />
            <CapabilityRow label="Channels" value={adaptersSummary} amber={summary.network.adapters.length > 0} />
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
          <div className="rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-warning)]/30 bg-[var(--adf-ui-warning-subtle)] px-3 py-1">
            <CapabilityRow label="Tables" value={tableProtectionsSummary} amber />
          </div>
        </div>
      )}
    </div>
  )
}

function ClaimContent({
  summary,
  password,
  setPassword,
  passwordError,
  setPasswordError,
}: {
  summary: AgentConfigSummary
  password: string
  setPassword: (v: string) => void
  passwordError: string | null
  setPasswordError: (v: string | null) => void
}) {
  const identity = summary.identity
  const showPassword = identity.sharePasswordSet && identity.credentialsLocked

  return (
    <div className="space-y-4">
      <div className="flex flex-col items-center text-center pt-2 pb-1">
        <Monogram name={summary.name} scenario={identity.scenario} size="lg" />
        <h3 className="text-sm font-medium text-neutral-800 dark:text-neutral-200 mt-3">
          Make {summary.name} yours
        </h3>
        <p className="text-[11px] text-neutral-500 dark:text-neutral-400 mt-1 max-w-sm">
          {identity.scenario === 'unclaimed'
            ? 'Claiming mints a brand-new identity for this agent under your ownership. Its files and memory come along as they are.'
            : 'Claiming gives this agent a fresh identity under your ownership. Its files, memory, and history are kept, and its previous identity is recorded as provenance.'}
        </p>
      </div>

      {showPassword && (
        <div className="rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] bg-[var(--adf-ui-canvas)] p-3">
          <p className="text-[11px] font-medium text-neutral-700 dark:text-neutral-300 mb-1">
            It came with credentials
          </p>
          <p className="text-[11px] text-neutral-500 dark:text-neutral-400 mb-2">
            Enter the password you were given to unlock them. You can also skip this and
            enter it later in the Identity panel.
          </p>
          <TextInput
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value)
              setPasswordError(null)
            }}
            placeholder="Password from the sender (optional)"
            aria-invalid={!!passwordError}
            aria-describedby={passwordError ? 'agent-review-password-error' : undefined}
            className="text-xs"
          />
          {passwordError && (
            <p id="agent-review-password-error" className="mt-1.5 text-[11px] text-[var(--adf-ui-danger)]">{passwordError}</p>
          )}
        </div>
      )}

      {!identity.sharePasswordSet && identity.credentialsLocked && (
        <p className="rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] bg-[var(--adf-ui-canvas)] px-3 py-2 text-[11px] text-[var(--adf-ui-text-muted)]">
          Any stored credentials are sealed to the previous owner without a share
          password, so they can't be recovered — claiming clears them. Re-enter API
          keys afterward if the agent needs them.
        </p>
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
  const [step, setStep] = useState<'review' | 'claim'>('review')
  const [password, setPassword] = useState('')
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const successRef = useRef(false)

  const needsClaim = summary?.identity.needsClaim ?? false

  const resetSteps = useCallback(() => {
    setStep('review')
    setPassword('')
    setPasswordError(null)
  }, [])

  const finishAccept = useCallback(async (claim: boolean) => {
    setLoading(true)
    try {
      await window.adfApi.acceptAgentReview(claim ? { claim: true } : undefined)
      // Reload config since locked_fields (and possibly identity) changed
      await loadFileContents()
      successRef.current = true
      setDialog(false)
      resetSteps()
    } catch (err) {
      console.error('[AgentReviewDialog] Accept error:', err)
    } finally {
      setLoading(false)
    }
  }, [setDialog, loadFileContents, resetSteps])

  const handleAccept = useCallback(() => finishAccept(false), [finishAccept])

  const handleClaim = useCallback(async () => {
    // Unlock credentials first when a password was entered — the file is
    // untouched until the claim itself, so a wrong password just retries.
    if (password.trim()) {
      setLoading(true)
      try {
        const result = await window.adfApi.unlockEnvelopeWithPassword(password.trim())
        if (!result.success) {
          setPasswordError("That password didn't unlock it — check with the sender, or clear the field to skip for now.")
          setLoading(false)
          return
        }
      } catch (err) {
        console.error('[AgentReviewDialog] Unlock error:', err)
        setLoading(false)
        return
      }
    }
    await finishAccept(true)
  }, [password, finishAccept])

  const handleReviewConfig = useCallback(async () => {
    // Close dialog without accepting — user wants to inspect config first.
    // Review will re-trigger next time the file is opened.
    successRef.current = true
    setDialog(false)
    resetSteps()
    expandRightPanelToTab('agent', 'config')
  }, [setDialog, expandRightPanelToTab, resetSteps])

  // Dismiss: close dialog without closing the file. Review re-triggers on next open.
  const handleDismiss = useCallback(() => {
    successRef.current = true
    setDialog(false)
    resetSteps()
  }, [setDialog, resetSteps])

  const handleCancel = useCallback(async () => {
    setDialog(false)
    resetSteps()
    await closeFile()
  }, [setDialog, closeFile, resetSteps])

  const handleDialogClose = useCallback(() => {
    if (successRef.current) {
      successRef.current = false
      return
    }
    // Escape/backdrop click = dismiss (not cancel)
    handleDismiss()
  }, [handleDismiss])

  const title = needsClaim ? `${summary?.name ?? 'An agent'} has arrived` : 'Review Agent'

  return (
    <Dialog open={open} onClose={handleDialogClose} title={title} wide>
      {/* Close button */}
      <IconButton
        onClick={handleDismiss}
        aria-label="Dismiss"
        className="absolute top-4 right-4 border-transparent"
        title="Dismiss"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </IconButton>

      {summary && (
        step === 'review'
          ? <ReviewContent summary={summary} />
          : <ClaimContent
              summary={summary}
              password={password}
              setPassword={setPassword}
              passwordError={passwordError}
              setPasswordError={setPasswordError}
            />
      )}

      <div className="flex justify-between items-center mt-5">
        {step === 'review' ? (
          <Button
            onClick={handleCancel}
            variant="danger"
          >
            Reject & Close
          </Button>
        ) : (
          <Button
            onClick={() => setStep('review')}
            disabled={loading}
            variant="ghost"
          >
            ← Back
          </Button>
        )}
        <div className="flex gap-2">
          {step === 'review' && (
            <Button
              onClick={handleReviewConfig}
              disabled={loading}
            >
              Review Config
            </Button>
          )}
          {step === 'review' && needsClaim ? (
            <Button
              onClick={() => setStep('claim')}
              variant="primary"
            >
              Continue
            </Button>
          ) : step === 'review' ? (
            <Button
              onClick={handleAccept}
              disabled={loading}
              loading={loading}
              variant="primary"
            >
              {loading ? 'Accepting...' : 'Accept & Open'}
            </Button>
          ) : (
            <Button
              onClick={handleClaim}
              disabled={loading}
              loading={loading}
              variant="primary"
            >
              {loading ? 'Claiming...' : 'Claim & Open'}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  )
}
