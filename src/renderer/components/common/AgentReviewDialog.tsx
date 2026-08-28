import { useState, useCallback, useEffect, useRef } from 'react'
import { Dialog } from './Dialog'
import { useAppStore } from '../../stores/app.store'
import { useDocumentStore } from '../../stores/document.store'
import { useAgentStore } from '../../stores/agent.store'
import { useAdfFile } from '../../hooks/useAdfFile'
import { toDisplayState } from '../../hooks/useAgent'
import { migrateOpenTabs } from '../../utils/editor-tab-persistence'
import type { AgentConfigSummary, ReviewIdentitySummary } from '../../../shared/types/ipc.types'
import { Button, Select, TextInput } from '../ui'

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

type ModelChoice = { provider: string; model_id: string }

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
  // Surface each server's boundary at adoption time: host = runs on this
  // machine with the user's access, driven by the agent.
  const mcpSummary = summary.mcpServers.length > 0
    ? summary.mcpServers.map((s) => `${s.name} (${s.transport === 'http' ? 'remote' : s.runLocation === 'host' ? 'host' : 'container'})`).join(', ')
    : ''

  // Triggers summary
  const activeTriggers = summary.triggers.filter((t) => t.enabled)
  const triggersSummary = activeTriggers.length > 0
    ? activeTriggers.map((t) => t.type).join(', ')
    : ''

  // Messaging summary
  const messagingSummary = summary.messaging.mode

  // Provider: which runtime credentials the agent's model resolves to here
  const provider = summary.provider
  const providerSummary = provider
    ? `${provider.configuredId} · ${provider.modelId}${provider.status !== 'ok' ? ' — no API key on this runtime' : ''}`
    : ''

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
            <div className="mb-0.5">
              <p className="text-[10px] text-neutral-500 dark:text-neutral-400">From: another owner</p>
              <p className="text-[9px] text-neutral-400 dark:text-neutral-500 font-mono truncate">{identity.fileOwnerDid}</p>
            </div>
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
          <CapabilityRow label="Provider" value={providerSummary} amber={!!provider && provider.status !== 'ok'} />
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

/**
 * Compact provider + model override for claims arriving on a runtime where the
 * agent's configured provider has no usable credentials. Optional — leaving
 * the provider select on its first option keeps the agent's configured model.
 */
function ModelPicker({ configuredLabel, selected, onSelect }: {
  configuredLabel: string
  selected: ModelChoice | null
  onSelect: (m: ModelChoice | null) => void
}) {
  const [providers, setProviders] = useState<{ id: string; name: string; defaultModel?: string }[]>([])
  const [models, setModels] = useState<string[]>([])
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [loadingModels, setLoadingModels] = useState(false)
  const [custom, setCustom] = useState(false)

  useEffect(() => {
    window.adfApi.getSettings()
      .then((s) => {
        setProviders((s?.providers ?? []).map((p) => ({ id: p.id, name: p.name || p.id, defaultModel: p.defaultModel })))
      })
      .catch(() => { /* picker stays provider-less — selection is optional */ })
  }, [])

  const pickProvider = useCallback(async (id: string) => {
    if (!id) {
      onSelect(null)
      setModels([])
      setModelsError(null)
      setCustom(false)
      return
    }
    const prov = providers.find((p) => p.id === id)
    onSelect({ provider: id, model_id: prov?.defaultModel ?? '' })
    setLoadingModels(true)
    setModelsError(null)
    setCustom(false)
    try {
      const { models: list, error } = await window.adfApi.listModels(id)
      setModels(list ?? [])
      if (error) setModelsError(error)
      if (!list?.length) setCustom(true)
    } catch {
      setModels([])
      setCustom(true)
    } finally {
      setLoadingModels(false)
    }
  }, [providers, onSelect])

  return (
    <div className="rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] bg-[var(--adf-ui-canvas)] p-3 space-y-2">
      <div>
        <label className="block text-[11px] text-neutral-500 dark:text-neutral-400 mb-0.5">Provider</label>
        <Select
          aria-label="Provider for this runtime"
          value={selected?.provider ?? ''}
          onChange={(e) => pickProvider(e.target.value)}
          className="text-xs"
        >
          <option value="">Keep configured — {configuredLabel}</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </Select>
      </div>
      {selected && (
        <div>
          <label className="block text-[11px] text-neutral-500 dark:text-neutral-400 mb-0.5">Model</label>
          {loadingModels ? (
            <div className="px-2 py-1.5 text-xs text-neutral-400 dark:text-neutral-500">Loading models...</div>
          ) : custom ? (
            <div className="flex gap-1">
              <TextInput
                aria-label="Model id"
                type="text"
                value={selected.model_id}
                onChange={(e) => onSelect({ provider: selected.provider, model_id: e.target.value })}
                placeholder="Model id"
                className="flex-1 text-xs"
              />
              {models.length > 0 && (
                <Button
                  variant="ghost"
                  size="compact"
                  className="text-[10px] whitespace-nowrap"
                  onClick={() => setCustom(false)}
                >
                  Pick from list
                </Button>
              )}
            </div>
          ) : (
            <Select
              aria-label="Model"
              value={models.includes(selected.model_id) ? selected.model_id : '__custom__'}
              onChange={(e) => {
                if (e.target.value === '__custom__') {
                  setCustom(true)
                } else {
                  onSelect({ provider: selected.provider, model_id: e.target.value })
                }
              }}
              className="text-xs"
            >
              {models.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
              <option value="__custom__">Custom...</option>
            </Select>
          )}
          {modelsError && (
            <p className="text-[10px] text-[var(--adf-ui-danger)] mt-0.5">{modelsError}</p>
          )}
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
  skipPassword,
  onToggleSkipPassword,
  onSubmit,
  model,
  setModel,
}: {
  summary: AgentConfigSummary
  password: string
  setPassword: (v: string) => void
  passwordError: string | null
  setPasswordError: (v: string | null) => void
  skipPassword: boolean
  onToggleSkipPassword: (skip: boolean) => void
  onSubmit: () => void
  model: ModelChoice | null
  setModel: (m: ModelChoice | null) => void
}) {
  const identity = summary.identity
  const showPassword = identity.sharePasswordSet && identity.credentialsLocked
  const provider = summary.provider

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
        <p className="text-[11px] text-neutral-400 dark:text-neutral-500 mt-1">
          It will be saved to Documents/adf-agents.
        </p>
      </div>

      {showPassword && (
        <div className="rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] bg-[var(--adf-ui-canvas)] p-3">
          {skipPassword ? (
            <>
              <p className="text-[11px] font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                Claim without the password
              </p>
              <p className="text-[11px] text-neutral-500 dark:text-neutral-400 mb-2">
                Its stored credentials stay locked until you enter the sender's password
                in the Identity panel. Everything else becomes yours now.
              </p>
              <button
                type="button"
                onClick={() => onToggleSkipPassword(false)}
                className="text-[11px] text-[var(--adf-ui-text-muted)] underline hover:text-[var(--adf-ui-text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--adf-ui-accent)]"
              >
                I have the password
              </button>
            </>
          ) : (
            <>
              <p className="text-[11px] font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                Enter the password to claim this agent
              </p>
              <p className="text-[11px] text-neutral-500 dark:text-neutral-400 mb-2">
                The password will be removed. Set a new one in the Identity panel.
              </p>
              <TextInput
                type="password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value)
                  setPasswordError(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    onSubmit()
                  }
                }}
                placeholder="Password"
                autoFocus
                aria-invalid={!!passwordError}
                aria-describedby={passwordError ? 'agent-review-password-error' : undefined}
                className="text-xs"
              />
              {passwordError && (
                <p id="agent-review-password-error" className="mt-1.5 text-[11px] text-[var(--adf-ui-danger)]">{passwordError}</p>
              )}
              <button
                type="button"
                onClick={() => onToggleSkipPassword(true)}
                className="mt-1.5 text-[11px] text-[var(--adf-ui-text-muted)] underline hover:text-[var(--adf-ui-text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--adf-ui-accent)]"
              >
                Lost the password?
              </button>
            </>
          )}
        </div>
      )}

      {!showPassword && identity.filePasswordProtected && (
        <p className="rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] bg-[var(--adf-ui-canvas)] px-3 py-2 text-[11px] text-[var(--adf-ui-text-muted)]">
          The password will be removed when you claim. Set a new one in the Identity panel.
        </p>
      )}

      {!identity.sharePasswordSet && identity.credentialsLocked && (
        <p className="rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] bg-[var(--adf-ui-canvas)] px-3 py-2 text-[11px] text-[var(--adf-ui-text-muted)]">
          Any stored credentials are sealed to the previous owner without a share
          password, so they can't be recovered — claiming clears them. Re-enter API
          keys afterward if the agent needs them.
        </p>
      )}

      {provider && provider.status !== 'ok' && (
        <ModelPicker
          configuredLabel={`${provider.configuredId} · ${provider.modelId}`}
          selected={model}
          onSelect={setModel}
        />
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
  const [skipPassword, setSkipPassword] = useState(false)
  const [model, setModel] = useState<ModelChoice | null>(null)
  const [acceptError, setAcceptError] = useState<string | null>(null)
  const successRef = useRef(false)
  // The file this dialog is reviewing — captured at open so accept correlates
  // with the reviewed file even if the user navigates mid-flight (H1), and so
  // tab/draft migration keys off the pre-move path even after main's
  // FILE_RENAMED push already repointed the store (H2).
  const reviewedPathRef = useRef<string | null>(null)

  useEffect(() => {
    if (open) reviewedPathRef.current = useDocumentStore.getState().filePath
  }, [open])

  const needsClaim = summary?.identity.needsClaim ?? false
  // Share password is required when shown — unless the user takes the explicit
  // "Lost the password?" path, which claims with credentials left locked
  // (main keeps the recoverable password slot for later unlock).
  const requiresPassword = (summary?.identity.sharePasswordSet ?? false) && (summary?.identity.credentialsLocked ?? false)

  const resetSteps = useCallback(() => {
    setStep('review')
    setPassword('')
    setPasswordError(null)
    setSkipPassword(false)
    setModel(null)
    setAcceptError(null)
  }, [])

  /** Re-pull the summary after a failed accept/claim so the retry reflects main's current view. */
  const refreshSummary = useCallback(async () => {
    try {
      const review = await window.adfApi.checkAgentReview()
      if (review.needsReview && review.configSummary) {
        useAppStore.getState().setAgentReviewDialog(true, review.configSummary)
      }
    } catch { /* keep the summary we have */ }
  }, [])

  /** Same wiring as TitleBar's handleStart, minus the pre-start review check (we just accepted). */
  const startAgentNow = useCallback(async () => {
    const filePath = useDocumentStore.getState().filePath
    const appStore = useAppStore.getState()
    const agentStore = useAgentStore.getState()
    if (filePath) appStore.addStartingFilePath(filePath)
    try {
      const result = await window.adfApi.startAgent()
      if (result?.success) {
        agentStore.setState(toDisplayState(result.agentState ?? 'idle'))
        agentStore.setSessionId(result.sessionId ?? null)
        agentStore.addLogEntry({
          id: `system-${Date.now()}`,
          type: 'system',
          content: 'Agent started',
          timestamp: Date.now()
        })
      } else {
        const errorMessage = result?.error ?? 'Unknown error'
        agentStore.addLogEntry({
          id: `error-${Date.now()}`,
          type: 'error',
          content: errorMessage,
          timestamp: Date.now()
        })
        if (errorMessage.includes('API key')) appStore.setShowSettings(true)
      }
    } catch (err) {
      console.error('[AgentReviewDialog] Start error:', err)
    } finally {
      if (filePath) appStore.removeStartingFilePath(filePath)
    }
  }, [])

  const finishAccept = useCallback(async (claim: boolean, startAfter = false) => {
    setLoading(true)
    setAcceptError(null)
    const reviewedPath = reviewedPathRef.current
    try {
      const result = await window.adfApi.acceptAgentReview({
        claim: claim || undefined,
        expectedPath: reviewedPath ?? '',
        model: model ?? undefined
      })
      if (!result.success) {
        // Don't touch dialog state if the user already escaped it (L2).
        if (!useAppStore.getState().agentReviewDialogOpen) return
        setAcceptError(result.error || (claim ? 'Claim failed.' : 'Accept failed.'))
        await refreshSummary()
        return
      }
      // Accept may have moved the .adf into the managed default folder. Key
      // migration off the captured pre-move path — main's FILE_RENAMED push
      // usually repoints the store before this promise resolves (H2) — and
      // skip entirely if the user opened a different file meanwhile (H1).
      if (result.movedTo) {
        const docStore = useDocumentStore.getState()
        const current = docStore.filePath
        if (current === reviewedPath || current === result.movedTo) {
          if (reviewedPath && reviewedPath !== result.movedTo) {
            migrateOpenTabs(reviewedPath, result.movedTo)
            const draft = docStore.draftInputs[reviewedPath]
            if (draft) docStore.setDraftInput(result.movedTo, draft)
            docStore.removeDraftInput(reviewedPath)
          }
          if (docStore.filePath !== result.movedTo) docStore.setFilePath(result.movedTo)
        }
      }
      if (result.moveError) {
        console.warn('[AgentReviewDialog] File move after accept failed:', result.moveError)
        useAppStore.getState().setFileMoveWarning(
          "Couldn't move the file out of the temp folder — it may be deleted by the OS. Save it somewhere safe."
        )
      }
      // Reload config since locked_fields (and possibly identity) changed
      await loadFileContents()
      successRef.current = true
      useAppStore.getState().setAgentNeedsReview(false)
      setDialog(false)
      resetSteps()
      if (startAfter) await startAgentNow()
    } catch (err) {
      console.error('[AgentReviewDialog] Accept error:', err)
      if (useAppStore.getState().agentReviewDialogOpen) {
        setAcceptError(err instanceof Error ? err.message : (claim ? 'Claim failed.' : 'Accept failed.'))
        await refreshSummary()
      }
    } finally {
      setLoading(false)
    }
  }, [setDialog, loadFileContents, resetSteps, model, refreshSummary, startAgentNow])

  const handleAccept = useCallback(() => finishAccept(false), [finishAccept])

  const handleClaim = useCallback(async (startAfter: boolean) => {
    const pw = password.trim()
    if (requiresPassword && !skipPassword && !pw) {
      setPasswordError('Enter the password to claim.')
      return
    }
    // Verify the share password first — adoption itself happens inside the
    // claim on main's side (adopt: false), so a wrong password just retries
    // against an untouched file.
    if (pw) {
      setLoading(true)
      try {
        const result = await window.adfApi.unlockEnvelopeWithPassword(pw, false)
        if (!result.success) {
          setPasswordError("That password didn't unlock it — check with the sender.")
          setLoading(false)
          return
        }
      } catch (err) {
        console.error('[AgentReviewDialog] Unlock error:', err)
        setPasswordError(err instanceof Error ? err.message : 'Unlock failed.')
        setLoading(false)
        return
      }
    }
    await finishAccept(true, startAfter)
  }, [password, requiresPassword, skipPassword, finishAccept])

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
    successRef.current = true
    setDialog(false)
    resetSteps()
    await closeFile()
  }, [setDialog, closeFile, resetSteps])

  const handleDialogClose = useCallback(() => {
    // Programmatic closes (accept, dismiss, cancel, review-config) mark
    // successRef before setDialog(false); consume the mark here.
    if (successRef.current) {
      successRef.current = false
      return
    }
    // Native close (Escape) or Dialog's own close button: the element is
    // closing on its own — just sync the store. Don't mark successRef; there
    // is no second close event coming to consume it (M3).
    setDialog(false)
    resetSteps()
  }, [setDialog, resetSteps])

  const title = needsClaim ? `${summary?.name ?? 'An agent'} has arrived` : 'Review Agent'

  return (
    <Dialog open={open} onClose={handleDialogClose} title={title} preventClose={loading} wide>
      {summary && (
        step === 'review'
          ? <ReviewContent summary={summary} />
          : <ClaimContent
              summary={summary}
              password={password}
              setPassword={setPassword}
              passwordError={passwordError}
              setPasswordError={setPasswordError}
              skipPassword={skipPassword}
              onToggleSkipPassword={(skip) => {
                setSkipPassword(skip)
                // Entering skip mode hides the input — drop any typed password
                // so the claim doesn't attempt an unlock with stale text.
                if (skip) setPassword('')
                setPasswordError(null)
              }}
              onSubmit={() => { if (!loading) handleClaim(true) }}
              model={model}
              setModel={setModel}
            />
      )}

      {acceptError && (
        <p className="mt-4 text-[11px] text-[var(--adf-ui-danger)]" role="alert">
          {acceptError}
        </p>
      )}

      <div className={`flex justify-between items-center ${acceptError ? 'mt-2' : 'mt-5'}`}>
        {step === 'review' ? (
          <Button
            onClick={handleCancel}
            variant="danger"
          >
            Reject & Close
          </Button>
        ) : (
          <Button
            onClick={() => { setAcceptError(null); setStep('review') }}
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
              onClick={() => { setAcceptError(null); setStep('claim') }}
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
            <>
              <Button
                onClick={() => handleClaim(false)}
                disabled={loading}
                variant="ghost"
              >
                Claim only
              </Button>
              <Button
                onClick={() => handleClaim(true)}
                disabled={loading}
                loading={loading}
                variant="primary"
              >
                {loading ? 'Claiming...' : 'Claim & Run'}
              </Button>
            </>
          )}
        </div>
      </div>
    </Dialog>
  )
}
