import { useState, useEffect, useCallback, useRef, createContext, useContext } from 'react'
import { useAgentStore } from '../../stores/agent.store'
import { useAppStore } from '../../stores/app.store'
import { useDocumentStore } from '../../stores/document.store'
import { useEditorTabsStore, registerPreSwitchFlush } from '../../stores/editor-tabs.store'
import { useTrackedDirsStore } from '../../stores/tracked-dirs.store'
import { useRowKeys, useRowKeysGroup } from '../../hooks/useRowKeys'
import { START_IN_STATES, TRIGGER_TYPES_V3, MESSAGING_MODES, VISIBILITY_VALUES, LOG_LEVELS, CODE_EXECUTION_DEFAULTS, META_PROTECTION_LEVELS, TABLE_PROTECTION_LEVELS, RECOVERY_DEFAULTS, LOOP_PROHIBITED_TOOLS, DEFAULT_NEW_LOOP_TOOLS } from '../../../shared/types/adf-v02.types'
import type { AgentConfig as AgentConfigType, AdfProviderConfig, StartInState, ToolDeclaration, McpToolInfo, McpServerStatus, McpServerLogEntry, TriggerTypeV3, TriggerConfig, TriggerTarget, TriggerFilter, TriggersConfigV3, TriggerScopeV3, ServingApiRoute, MiddlewareRef, WsConnectionConfig, UmbilicalTapConfig, LoggingConfig, LoggingRule, CodeExecutionConfig, CodeExecutionPackage, MetaProtectionLevel, TableProtectionLevel, StreamBindingDeclaration, StreamBindTcpAllowRule, LoopConfig, ModelConfig } from '../../../shared/types/adf-v02.types'
import type { ReasoningEffort } from '../../../shared/types/provider.types'
import { buildMcpServerConfigFromRegistration } from '../../../shared/utils/mcp-config'
import { agentServerPlacement, allowHostPatch, allowHostTip, serverSourceIdentity, type McpLocation, type RuntimeHostApproval } from '../../../shared/utils/mcp-host-placement'
import { HOST_ACCESS_CONFIRM, useConfirm } from '../common/ConfirmDialog'
import { writeSettings } from '../settings/settings-save'
import { Dialog } from '../common/Dialog'
import { IconPicker } from '../common/IconPicker'
import { pickAgentIcon } from '../../../shared/constants/agent-icons'
import { loopColor } from '../../utils/loop-color'
import { DocsLink, InfoHint } from '../common/DocsLink'
import { ConfigNavProvider, useConfigNavEntry, CONFIG_NAV_OFFSET_CLASS } from './ConfigNav'
import { DOCS } from '../../../shared/constants/docs-links'
import type { ExecutionTarget } from '../../../shared/types/compute.types'
import { resolveExecutionTargetAliases } from '../../../shared/utils/compute-targets'
import { preLlmHookDraftFromConfig, validatePreLlmHookDraft, PRE_LLM_HOOK_MAIN_TARGET, type PreLlmHookDraft } from './pre-llm-hook-config'
import { classifyConfigSave } from '../../utils/edit-conflict'
import { ChangedElsewhereNotice } from '../editor/ChangedElsewhereNotice'
import { McpServerLogs } from '../mcp/McpServerLogs'
import {
  PERMISSION_TIPS, RESTRICTED_MIDDLEWARE_TIP, RESTRICTED_TABLE_TIP, tableProtectionLabel, toolRowGate, toolMatchesFilter, ASK_AUTONOMOUS_TIP,
  approvalRemoved, restoreApproval, approvalRemovedMessage, saveFailureReason, type ConfigSaveStatus,
} from './config-panel-model'
import {
  ApprovalIcon, ShieldIcon, LockIcon, EyeIcon, PERMISSION_ON_CLASS, PermissionLegend, LockBadge, RowWarning, McpStatusChip, SaveStatusLine, UndoToast,
} from './config-panel-parts'

/**
 * All tools this runtime supports. Any tool listed here will appear
 * in every agent's config panel. Tools not already in the agent's
 * config are added as disabled so the user can opt in.
 */
const RUNTIME_TOOLS: ToolDeclaration[] = [
  // --- ADF Shell ---
  { name: 'adf_shell', enabled: false, visible: false },
  // --- Filesystem tools ---
  { name: 'fs_read', enabled: true, visible: true },
  { name: 'fs_write', enabled: true, visible: true },
  { name: 'fs_list', enabled: true, visible: true },
  { name: 'fs_delete', enabled: false, visible: false },
  // --- System tools ---
  { name: 'sys_get_config', enabled: true, visible: true },
  { name: 'sys_update_config', enabled: false, visible: false },
  { name: 'sys_code', enabled: false, visible: false },
  { name: 'sys_lambda', enabled: false, visible: false },
  { name: 'sys_create_adf', enabled: false, visible: false },
  { name: 'sys_get_meta', enabled: true, visible: true },
  { name: 'sys_set_meta', enabled: true, visible: true },
  { name: 'sys_delete_meta', enabled: true, visible: true },
  { name: 'sys_set_timer', enabled: false, visible: false },
  { name: 'sys_list_timers', enabled: false, visible: false },
  { name: 'sys_delete_timer', enabled: false, visible: false },
  // --- Package management tools ---
  { name: 'npm_install', enabled: false, visible: false },
  { name: 'npm_uninstall', enabled: false, visible: false },
  // --- MCP management tools ---
  { name: 'mcp_install', enabled: false, visible: false },
  { name: 'mcp_restart', enabled: false, visible: false },
  { name: 'mcp_uninstall', enabled: false, visible: false },
  // --- Compute environment tools ---
  { name: 'fs_transfer', enabled: false, visible: false },
  { name: 'compute_exec', enabled: false, visible: false, restricted: true },
  // --- Network tools ---
  { name: 'sys_fetch', enabled: false, visible: false },
  // --- Database tools ---
  { name: 'db_query', enabled: false, visible: false },
  { name: 'db_execute', enabled: false, visible: false },
  // --- Loop tools ---
  { name: 'loop_compact', enabled: false, visible: false },
  { name: 'loop_clear', enabled: false, visible: false },
  // --- Messaging tools (require messaging toggle) ---
  { name: 'msg_send', enabled: false, visible: false },
  { name: 'agent_discover', enabled: false, visible: false },
  // --- Inbox tools (require inbox mode) ---
  { name: 'msg_list', enabled: false, visible: false },
  { name: 'msg_read', enabled: false, visible: false },
  { name: 'msg_update', enabled: false, visible: false },
  { name: 'msg_delete', enabled: false, visible: false },
  { name: 'chat_info', enabled: false, visible: false },
  // --- WebSocket tools ---
  { name: 'ws_connect', enabled: false, visible: false },
  { name: 'ws_disconnect', enabled: false, visible: false },
  { name: 'ws_connections', enabled: false, visible: false },
  { name: 'ws_send', enabled: false, visible: false },
  // --- Stream binding tools ---
  { name: 'stream_bind', enabled: false, visible: false },
  { name: 'stream_unbind', enabled: false, visible: false },
  { name: 'stream_bindings', enabled: false, visible: false },
  // --- Turn tools ---
  { name: 'say', enabled: true, visible: true },
  { name: 'ask', enabled: true, visible: true },
  { name: 'sys_set_state', enabled: true, visible: true }
]

/** Logical tool groups for the UI. Order matters — rendered top to bottom. */
const TOOL_GROUPS: { label: string; tools: Set<string>; note?: string }[] = [
  { label: 'ADF Shell', tools: new Set(['adf_shell']), note: 'Bash-like interface alongside your tools; can run any of them by name. Hide tools (visibility) to save context.' },
  { label: 'Filesystem', tools: new Set(['fs_read', 'fs_write', 'fs_list', 'fs_delete']) },
  { label: 'System', tools: new Set(['sys_get_config', 'sys_update_config', 'sys_code', 'sys_lambda', 'sys_create_adf', 'sys_get_meta', 'sys_set_meta', 'sys_delete_meta']) },
  { label: 'Timers', tools: new Set(['sys_set_timer', 'sys_list_timers', 'sys_delete_timer']) },
  { label: 'Packages', tools: new Set(['npm_install', 'npm_uninstall']) },
  { label: 'MCP', tools: new Set(['mcp_install', 'mcp_restart', 'mcp_uninstall']) },
  { label: 'Compute', tools: new Set(['fs_transfer', 'compute_exec']) },
  { label: 'Network', tools: new Set(['sys_fetch']) },
  { label: 'Database', tools: new Set(['db_query', 'db_execute']) },
  { label: 'Loop', tools: new Set(['loop_compact', 'loop_clear', 'loop_send', 'loop_list', 'loop_manage']) },
  { label: 'WebSocket', tools: new Set(['ws_connect', 'ws_disconnect', 'ws_connections', 'ws_send']) },
  { label: 'Stream Bind', tools: new Set(['stream_bind', 'stream_unbind', 'stream_bindings']) },
  // Messaging and Inbox rows may be set from the Messaging section: see toolRowGate.
  { label: 'Messaging', tools: new Set(['msg_send', 'agent_discover']) },
  { label: 'Inbox', tools: new Set(['msg_list', 'msg_read', 'msg_update', 'msg_delete']) },
  // Note: chat_info is intentionally not grouped here — it's a sandbox-only
  // capability (hidden from the LLM schema) rendered in the Code Execution section.
  { label: 'Turn', tools: new Set(['say', 'ask', 'sys_set_state']) },
]

/** Tools that require the messaging toggle to be enabled. */
const MESSAGING_TOOLS = new Set(['msg_send', 'agent_discover'])

/** Tools that require inbox mode to be enabled. */
const INBOX_TOOLS = new Set(['msg_list', 'msg_read', 'msg_update'])

/** All categorized tool names (anything not in here is uncategorized). */
const ALL_GROUPED_TOOLS = new Set(TOOL_GROUPS.flatMap(g => [...g.tools]))

/** Trailing window that coalesces a burst of edits into one setAgentConfig. */
const SAVE_DEBOUNCE_MS = 300

type TriState = 'all' | 'none' | 'mixed'

function computeTriState<T>(items: T[], predicate: (item: T) => boolean): TriState {
  if (items.length === 0) return 'none'
  const enabledCount = items.filter(predicate).length
  if (enabledCount === 0) return 'none'
  if (enabledCount === items.length) return 'all'
  return 'mixed'
}

/**
 * Ensure the config's tools array contains all runtime-supported tools.
 * Missing tools are appended as disabled. Existing entries are preserved.
 */
export function ensureRuntimeTools(tools: ToolDeclaration[]): ToolDeclaration[] {
  // Deduplicate by name (keep first occurrence)
  const seen = new Set<string>()
  const deduped = tools.filter((t) => {
    if (seen.has(t.name)) return false
    seen.add(t.name)
    return true
  })
  const missing = RUNTIME_TOOLS.filter((rt) => !seen.has(rt.name))
  if (missing.length === 0 && deduped.length === tools.length) return tools
  return [...deduped, ...missing.map((t) => ({ ...t, enabled: false, visible: false }))]
}

function ToolVisibilityToggle({
  visible,
  disabled,
  onToggle
}: {
  visible: boolean
  disabled: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      aria-label={visible ? 'Hide from active LLM tool list' : 'Show in active LLM tool list'}
      title={visible ? 'Visible: shown in the active LLM tool list. Click to hide.' : 'Hidden: not shown in the active LLM tool list. Click to show.'}
      disabled={disabled}
      onClick={onToggle}
      className={`flex h-4 w-4 items-center justify-center rounded transition-colors ${
        disabled
          ? 'cursor-not-allowed text-neutral-300 dark:text-neutral-700'
          : visible
            ? 'text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300'
            : 'text-[var(--adf-ui-icon-muted)] hover:text-[var(--adf-ui-text-subtle)]'
      }`}
    >
      <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
        <circle cx="12" cy="12" r="3" />
        {!visible && <path d="M3 3l18 18" />}
      </svg>
    </button>
  )
}

function formatTcpAllowlist(rules?: StreamBindTcpAllowRule[]): string {
  return (rules ?? []).map(rule => {
    if (typeof rule.port === 'number') return `${rule.host}:${rule.port}`
    if (Array.isArray(rule.ports) && rule.ports.length > 0) return `${rule.host}:${rule.ports.join(',')}`
    if (typeof rule.min_port === 'number' || typeof rule.max_port === 'number') {
      return `${rule.host}:${rule.min_port ?? 1}-${rule.max_port ?? 65535}`
    }
    return rule.host
  }).join('\n')
}

function parseTcpAllowlist(value: string): StreamBindTcpAllowRule[] {
  return value.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const colon = line.lastIndexOf(':')
    if (colon <= 0) return { host: line }
    const host = line.slice(0, colon).trim()
    const portSpec = line.slice(colon + 1).trim()
    if (portSpec.includes('-')) {
      const [minRaw, maxRaw] = portSpec.split('-', 2)
      const min = parseInt(minRaw, 10)
      const max = parseInt(maxRaw, 10)
      return {
        host,
        min_port: Number.isFinite(min) ? min : undefined,
        max_port: Number.isFinite(max) ? max : undefined,
      }
    }
    if (portSpec.includes(',')) {
      return {
        host,
        ports: portSpec.split(',').map(p => parseInt(p.trim(), 10)).filter(Number.isFinite),
      }
    }
    const port = parseInt(portSpec, 10)
    return Number.isFinite(port) ? { host, port } : { host }
  })
}

import type { ProviderConfig, McpServerRegistration, AdapterRegistration, SystemPromptParts } from '../../../shared/types/ipc.types'
import type { AdapterInstanceConfig } from '../../../shared/types/channel-adapter.types'
import { findRegistryEntry } from '../../../shared/constants/mcp-registry'
import { findAdapterRegistryEntry } from '../../../shared/constants/adapter-registry'
import { AgentProvidersList, ModelIdField, ProviderOptions, runtimeDefaultLabel } from './AgentProviders'
import { openApi, openSliceRuntime, useOpenRuntime } from '../../utils/runtime-api'

// The config caches, one set per runtime (utils/config-caches.ts). Re-exported: SettingsPage busts them.
import { cachesOf, invalidateConfigCaches } from '../../utils/config-caches'
export { invalidateConfigCaches }

// ---------------------------------------------------------------------------
// Sandbox Package Install Modal — install missing packages on agent open
// ---------------------------------------------------------------------------

interface SandboxInstallModalProps {
  open: boolean
  onClose: () => void
  packages: CodeExecutionPackage[]
}

function SandboxInstallModal({ open, onClose, packages }: SandboxInstallModalProps) {
  const [installing, setInstalling] = useState(false)
  const [results, setResults] = useState<Record<string, { status: string; error?: string }>>({})

  useEffect(() => {
    if (open) {
      setInstalling(false)
      setResults({})
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const unsub = openApi()?.onSandboxInstallProgress((event: { package: string; status: string; progress?: string; error?: string }) => {
      setResults((prev) => ({
        ...prev,
        [event.package]: { status: event.status, error: event.error }
      }))
    })
    return () => { unsub?.() }
  }, [open])

  const handleInstall = async () => {
    setInstalling(true)
    try {
      await openApi()?.installSandboxPackages(packages)
    } catch { /* errors reported via progress events */ }
    setInstalling(false)
  }

  const allDone = packages.every((p) => results[p.name]?.status === 'installed' || results[p.name]?.status === 'error')

  return (
    <Dialog lightDismiss={false} open={open} onClose={onClose} title="Install Sandbox Packages">
      <div className="space-y-3">
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          This agent requires the following packages:
        </p>
        <div className="space-y-1">
          {packages.map((pkg) => {
            const r = results[pkg.name]
            return (
              <div key={pkg.name} className="flex items-center justify-between text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800">
                <span className="font-mono text-neutral-700 dark:text-neutral-300">
                  {pkg.name}@{pkg.version}
                </span>
                <span className={`text-[10px] ${
                  r?.status === 'installed' ? 'text-green-600 dark:text-green-400' :
                  r?.status === 'error' ? 'text-red-500' :
                  r?.status === 'installing' ? 'text-blue-500' :
                  'text-[var(--adf-ui-text-subtle)]'
                }`}>
                  {r?.status === 'installed' ? 'Installed' :
                   r?.status === 'error' ? (r.error?.slice(0, 40) ?? 'Failed') :
                   r?.status === 'installing' ? 'Installing...' :
                   'Pending'}
                </span>
              </div>
            )
          })}
        </div>
        <div className="flex justify-end gap-2 pt-2 border-t border-neutral-200 dark:border-neutral-700">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700 rounded-lg"
          >
            {allDone ? 'Close' : 'Skip'}
          </button>
          {!allDone && (
            <button
              onClick={handleInstall}
              disabled={installing}
              className="px-3 py-1.5 text-sm bg-[var(--adf-ui-accent)] text-[var(--adf-ui-on-accent)] hover:bg-[var(--adf-ui-accent-hover)] rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {installing ? 'Installing...' : 'Install All'}
            </button>
          )}
        </div>
      </div>
    </Dialog>
  )
}

/**
 * One inner-loop card in the Loops config section. Collapsed by default: the
 * header (expand chevron, enabled toggle, name, delete) is always shown, and the
 * body (goal / model / compaction threshold / tools) reveals on expand. A newly
 * added loop mounts expanded (`defaultExpanded`) so it can be filled in at once.
 * A left rail carries the loop's identity colour so cards are scannable when
 * collapsed.
 */
function LoopCard({
  entry,
  duplicate,
  grantableTools,
  agentProviders,
  appProviders,
  modelFilePath,
  defaultModelFor,
  patchLoop,
  onRemove,
  defaultExpanded
}: {
  entry: LoopConfig
  duplicate: boolean
  grantableTools: string[]
  agentProviders: AdfProviderConfig[] | undefined
  appProviders: ProviderConfig[]
  /** The agent file when the provider is stored on it, for model listing. */
  modelFilePath: (providerId: string) => string | undefined
  defaultModelFor: (providerId: string) => string
  patchLoop: (patch: Partial<LoopConfig>) => void
  onRemove: () => void
  defaultExpanded: boolean
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const selected = new Set(entry.tools ?? [])
  const inherits = !entry.model
  const nameInvalid = duplicate || entry.name === 'main' || !entry.name.trim()
  const colors = loopColor(entry.name || 'loop')

  return (
    <div className={`mb-2 p-2 rounded border border-l-2 ${colors.rail} border-neutral-200 dark:border-neutral-700 space-y-1.5`}>
      {/* Header row — always visible. */}
      <div className="flex gap-1.5 items-center">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          title={expanded ? 'Collapse' : 'Expand'}
          className="shrink-0 text-[var(--adf-ui-text-subtle)] hover:text-neutral-600 dark:hover:text-neutral-300"
        >
          <svg
            width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            className={`transition-transform ${expanded ? 'rotate-90' : ''}`}
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
        <label className="flex items-center gap-1 cursor-pointer shrink-0" title="Enabled loops get a tab and can be woken by triggers">
          <input
            type="checkbox"
            checked={entry.enabled}
            onChange={(e) => patchLoop({ enabled: e.target.checked })}
            className="rounded text-blue-500"
          />
        </label>
        <input
          type="text"
          value={entry.name}
          onChange={(e) => patchLoop({ name: e.target.value })}
          placeholder="loop-name"
          className={`flex-1 px-2 py-1 text-xs font-mono border rounded-md focus:outline-none dark:bg-neutral-700 dark:text-neutral-100 ${
            nameInvalid
              ? 'border-red-400 dark:border-red-500'
              : 'border-neutral-300 dark:border-neutral-600 focus:border-blue-400'
          }`}
        />
        <button
          onClick={onRemove}
          className="text-xs text-red-400 hover:text-red-600 px-1"
          title="Remove loop"
        >
          &times;
        </button>
      </div>
      {nameInvalid && (
        <p className="text-[10px] text-red-500">
          {entry.name === 'main' ? '"main" is reserved for the host loop.' : duplicate ? 'Loop names must be unique.' : 'A loop needs a name.'}
        </p>
      )}

      {expanded && (
        <>
          {/* goal */}
          <textarea
            value={entry.goal}
            onChange={(e) => patchLoop({ goal: e.target.value })}
            rows={2}
            placeholder="Goal — becomes this loop's instructions"
            className="w-full px-2 py-1 text-xs border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400 resize-y"
          />

          {/* behaviour — how the loop starts and when its turns end */}
          <div>
            <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">Behaviour</span>
            <div className="mt-0.5 flex flex-wrap gap-x-4 gap-y-1">
              <label className="flex items-center gap-1.5 cursor-pointer text-[11px] text-neutral-600 dark:text-neutral-300">
                <input
                  type="checkbox"
                  checked={entry.autostart ?? false}
                  disabled={!entry.enabled}
                  onChange={(e) => patchLoop({ autostart: e.target.checked || undefined })}
                  className="rounded text-blue-500"
                />
                Autostart
                <InfoHint tip="Run a first turn on its goal whenever the agent starts, instead of waiting for a trigger, timer or loop_send." />
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer text-[11px] text-neutral-600 dark:text-neutral-300">
                <input
                  type="checkbox"
                  checked={entry.autonomous ?? false}
                  disabled={!entry.enabled}
                  onChange={(e) => patchLoop({ autonomous: e.target.checked || undefined })}
                  className="rounded text-blue-500"
                />
                Autonomous
                <InfoHint tip="Keep turning after text-only responses until the loop calls sys_set_state. Not inherited from the agent; off by default." />
              </label>
            </div>
            {entry.autonomous && !selected.has('sys_set_state') && (
              <p className="text-[10px] text-amber-600 dark:text-amber-400 mt-0.5">
                Autonomous without sys_set_state: this loop cannot yield on its own and only stops when the narration breaker trips.
              </p>
            )}
          </div>

          {/* model — absent inherits the agent's */}
          <div className="flex gap-1.5 items-center">
            <select
              value={inherits ? '__inherit__' : entry.model!.provider}
              onChange={(e) => {
                if (e.target.value === '__inherit__') {
                  // Keep the threshold (B18): compact_threshold applies
                  // regardless of the model — dropping it on a switch back to
                  // inherit silently discarded a value the user set on purpose.
                  patchLoop({ model: undefined })
                  return
                }
                const picked = e.target.value
                patchLoop({ model: { ...(entry.model ?? { model_id: '' }), provider: picked, model_id: entry.model?.model_id || defaultModelFor(picked) } })
              }}
              className="field-input flex-1"
            >
              <option value="__inherit__">Model: inherit from agent</option>
              <ProviderOptions agentProviders={agentProviders} appProviders={appProviders} />
            </select>
            {!inherits && (
              <ModelIdField
                providerId={entry.model!.provider}
                filePath={modelFilePath(entry.model!.provider)}
                value={entry.model!.model_id}
                onChange={(modelId) => patchLoop({ model: { ...entry.model!, model_id: modelId } })}
              />
            )}
          </div>

          {/* compaction threshold — applies to this loop whether or not it
              overrides the model (B18), so it is always shown. Defaults to the
              agent's threshold when unset. */}
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-[var(--adf-ui-text-subtle)] shrink-0">
                Compaction threshold
              </span>
              <NumberInput
                min={0}
                step={10000}
                value={entry.compact_threshold ?? 0}
                placeholder="inherit"
                onChange={(v) => patchLoop({ compact_threshold: v > 0 ? v : undefined })}
                className="field-input w-28"
              />
              <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">
                {entry.compact_threshold ? `${entry.compact_threshold.toLocaleString()} tokens` : 'Inherited'}
              </span>
            </div>
            <p className="text-[10px] text-[var(--adf-ui-text-subtle)] mt-0.5">
              When this loop&apos;s context reaches this size it compacts. Defaults to the agent&apos;s threshold.
            </p>
          </div>

          {/* tools — allow-list, intersected with host-enabled at derive time */}
          <div>
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">
                Tools ({selected.size === 0 ? 'none — a mute loop' : `${selected.size} selected`})
              </span>
              {selected.size > 0 && (
                <button
                  onClick={() => patchLoop({ tools: undefined })}
                  className="text-[10px] text-[var(--adf-ui-text-subtle)] hover:text-neutral-600 dark:hover:text-neutral-300"
                >
                  Clear
                </button>
              )}
            </div>
            {grantableTools.length === 0 ? (
              <p className="text-[10px] text-[var(--adf-ui-text-subtle)]">
                No grantable host tools — enable some in the Tools section first.
              </p>
            ) : (
              <div className="mt-0.5 max-h-40 overflow-y-auto grid grid-cols-2 gap-x-2">
                {grantableTools.map((toolName) => (
                  <label key={toolName} className="flex items-center gap-1 cursor-pointer text-[11px] text-neutral-600 dark:text-neutral-300">
                    <input
                      type="checkbox"
                      checked={selected.has(toolName)}
                      onChange={(e) => {
                        const next = new Set(selected)
                        if (e.target.checked) next.add(toolName)
                        else next.delete(toolName)
                        patchLoop({ tools: next.size > 0 ? [...next].sort((a, b) => a.localeCompare(b)) : undefined })
                      }}
                      className="rounded text-blue-500"
                    />
                    <span className="font-mono truncate">{toolName}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Controlled ("template") mode: the panel edits a config object the caller
 * owns instead of the open agent. Store, file and live-status work is skipped
 * and instance-only UI (name, identity keys, meta, clear state) is hidden.
 * Used by Settings > Agent template.
 */
export interface AgentConfigTemplateProps {
  value: AgentConfigType
  onChange: (next: AgentConfigType) => void
}

/** True while rendering in template mode — lock affordances hide themselves. */
const TemplateModeContext = createContext(false)

export function AgentConfig({ template }: { template?: AgentConfigTemplateProps } = {}) {
  const agentAvatars = useAppStore((s) => s.agentAvatars)
  const storeConfig = useAgentStore((s) => s.config)
  const config = template ? template.value : storeConfig
  const setConfig = useAgentStore((s) => s.setConfig)
  const docFilePath = useDocumentStore((s) => s.filePath)
  // Template mode has no open workspace: everything keyed on the file path is off.
  const filePath = template ? null : docFilePath
  // The open agent's runtime: its pushes come from there (multi-runtime.md §4.1).
  const openRuntime = useOpenRuntime()
  const setFilePath = useDocumentStore((s) => s.setFilePath)
  const templateRef = useRef(template)
  templateRef.current = template
  const [local, setLocal] = useState<AgentConfigType | null>(() =>
    template ? { ...structuredClone(template.value), tools: ensureRuntimeTools(template.value.tools) } : null
  )
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  /** Model "Advanced" fold, toggled by hand for this file; otherwise it follows whether anything is non-default. */
  const [advancedOpen, setAdvancedOpen] = useState<{ file: string | null; open: boolean } | null>(null)
  /** The agent file, when `providerId` is stored on it (lists models with the agent's key). */
  const carriedFilePath = (providerId: string | undefined): string | undefined =>
    filePath && providerId && local?.providers?.some((p) => p.id === providerId) ? filePath : undefined
  const [editingName, setEditingName] = useState<string | null>(null)
  const [nameError, setNameError] = useState<string | null>(null)
  const [knownAgents, setKnownAgents] = useState<{ did: string; label: string }[]>([])
  const [allowListInput, setAllowListInput] = useState('')
  const [blockListInput, setBlockListInput] = useState('')
  const [allowListDropdown, setAllowListDropdown] = useState(false)
  const [blockListDropdown, setBlockListDropdown] = useState(false)
  const [toolDefs, setToolDefs] = useState<Record<string, unknown>>({})
  const [viewingTool, setViewingTool] = useState<string | null>(null)
  // Index of a just-added inner loop, so its card mounts EXPANDED (ready to
  // fill in) while every existing card stays collapsed.
  const [newLoopIndex, setNewLoopIndex] = useState<number | null>(null)
  // The hook is an optional object, so keep its editor draft separate from
  // the debounced AgentConfig write. This prevents an incomplete source,
  // loop name, or timeout from being serialized while the user is typing.
  const [preLlmHookDraft, setPreLlmHookDraft] = useState<PreLlmHookDraft>(() =>
    preLlmHookDraftFromConfig((template ? template.value : storeConfig)?.pre_llm_hook)
  )
  const [preLlmHookErrors, setPreLlmHookErrors] = useState<string[]>([])
  const preLlmHookDraftOwnerRef = useRef<string | null>(null)
  const [mcpRegistrations, setMcpRegistrations] = useState<McpServerRegistration[]>([])
  const [mcpProbing, setMcpProbing] = useState<Record<string, boolean>>({})
  const [mcpProbeErrors, setMcpProbeErrors] = useState<Record<string, string>>({})
  /** Set of MCP server names that have identity keys stored in this ADF */
  const [mcpServersWithKeys, setMcpServersWithKeys] = useState<Set<string>>(new Set())
  const [unregMcpCollapsed, setUnregMcpCollapsed] = useState(true)
  // Per-server tool lists are collapsed to an enabled/total count by default —
  // some servers expose dozens of tools.
  const [expandedMcpTools, setExpandedMcpTools] = useState<Record<string, boolean>>({})
  const [adapterRegistrations, setAdapterRegistrations] = useState<AdapterRegistration[]>([])
  /** Set of adapter types that have identity keys stored in this ADF */
  const [adapterWithKeys, setAdapterWithKeys] = useState<Set<string>>(new Set())
  /** Map of adapter type → set of key names stored in this ADF's identity keystore */
  const [adapterIdentityKeys, setAdapterIdentityKeys] = useState<Record<string, Set<string>>>({})
  /** Email account identifier pulled from adf_identity when present */
  const [emailAccount, setEmailAccount] = useState<string | null>(null)
  const [meshServerStatus, setMeshServerStatus] = useState<{ running: boolean; port: number; host: string }>({ running: false, port: 7295, host: '127.0.0.1' })
  const [hasSigningKeys, setHasSigningKeys] = useState(false)
  const [metaEntries, setMetaEntries] = useState<Array<{ key: string; value: string; protection: MetaProtectionLevel }>>([])
  const [viewingMeta, setViewingMeta] = useState<{ key: string; value: string; protection: MetaProtectionLevel } | null>(null)
  const [editingMetaValue, setEditingMetaValue] = useState('')
  const [addingMeta, setAddingMeta] = useState(false)
  const [newMetaKey, setNewMetaKey] = useState('')
  const [newMetaValue, setNewMetaValue] = useState('')
  const [newMetaProtection, setNewMetaProtection] = useState<MetaProtectionLevel>('none')
  const [localTables, setLocalTables] = useState<Array<{ name: string; row_count: number }>>([])
  const [newProtectedTable, setNewProtectedTable] = useState('')
  const [newTableProtection, setNewTableProtection] = useState<TableProtectionLevel>('append_only')
  const [missingPackages, setMissingPackages] = useState<CodeExecutionPackage[]>([])
  const [showPkgInstallModal, setShowPkgInstallModal] = useState(false)
  const [runtimeHostEnabled, setRuntimeHostEnabled] = useState(false)
  // The runtime's host approvals: shown in each MCP server's Runs on, changed only by a confirmed Allow.
  const [runtimeHostApproved, setRuntimeHostApproved] = useState<string[]>([])
  const [runtimeHostApprovedSources, setRuntimeHostApprovedSources] = useState<Record<string, string>>({})
  const [hostAllowError, setHostAllowError] = useState<string | null>(null)
  const [hostConfirmDialog, confirmHost] = useConfirm()
  /** settings.defaultProviderId: what a template's empty Provider falls back to. */
  const [runtimeDefaultProviderId, setRuntimeDefaultProviderId] = useState<string | undefined>(undefined)
  const [executionTargets, setExecutionTargets] = useState<ExecutionTarget[]>([])
  const nameInputRef = useRef<HTMLInputElement>(null)
  const savingRef = useRef(false)
  // Debounced config write — see `save` below. `baseRevision` / `baseConfig`
  // (W3-F): the config revision and config the burst of edits started from,
  // so the write is refused if someone else changed the config meanwhile.
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingSaveRef = useRef<{ config: AgentConfigType; owner: string | null; baseRevision?: number; baseConfig: AgentConfigType | null } | null>(null)
  /**
   * W3-F: a save refused because the config changed elsewhere; the notice
   * offers Reload or Keep mine. In the agent store, so an agent switch or a
   * quit can ask about it / keep a copy (edit-conflict.ts, edit-recovery.ts).
   */
  const configConflict = useAgentStore((s) => s.configConflict)
  const setConfigConflict = useAgentStore((s) => s.setConfigConflict)
  /** Header save line. A refused save keeps the draft and offers Retry. */
  const [saveStatus, setSaveStatus] = useState<ConfigSaveStatus>({ kind: 'idle' })
  /** The refused save Retry sends again; a later edit takes over its base. */
  const failedSaveRef = useRef<{ config: AgentConfigType; owner: string | null; baseRevision?: number; baseConfig: AgentConfigType | null } | null>(null)
  /** Write order: a later write carries the whole config, so an older refusal it outran is moot. */
  const saveSeqRef = useRef(0)
  const lastSavedSeqRef = useRef(0)
  /** Undo for a bulk change that removed approval gates. */
  const [approvalUndo, setApprovalUndo] = useState<{ names: string[]; owner: string | null } | null>(null)
  const [toolFilter, setToolFilter] = useState('')
  /** Live MCP server states for the open agent (status, last error). */
  const [mcpStates, setMcpStates] = useState<Record<string, { status: McpServerStatus; error?: string }>>({})
  const [mcpLogsFor, setMcpLogsFor] = useState<string | null>(null)
  const [mcpLogs, setMcpLogs] = useState<McpServerLogEntry[]>([])

  useEffect(() => {
    if (savingRef.current) {
      savingRef.current = false
      return
    }
    if (config) {
      const clone = structuredClone(config)
      clone.tools = ensureRuntimeTools(clone.tools)
      setLocal(clone)
    }
  }, [config])

  // A new agent/file gets a fresh draft. Deliberately do not key this effect
  // on `config.pre_llm_hook`: store synchronization can arrive while a user is
  // editing, and must not erase an incomplete draft before Save is pressed.
  useEffect(() => {
    const owner = `${filePath ?? 'template'}:${config?.id ?? ''}`
    if (preLlmHookDraftOwnerRef.current === owner) return
    preLlmHookDraftOwnerRef.current = owner
    setPreLlmHookDraft(preLlmHookDraftFromConfig(config?.pre_llm_hook))
    setPreLlmHookErrors([])
  }, [filePath, config?.id])

  // Fetch custom providers from settings (cached per runtime — invalidated on settings save)
  useEffect(() => {
    const t0 = performance.now()
    const caches = cachesOf(openRuntime)
    let live = true
    // Always fetch runtime host setting (it can change between Settings visits)
    openApi()?.getSettings().then((s) => {
      if (!live) return
      setRuntimeHostEnabled(s?.compute?.hostAccessEnabled ?? false)
      setRuntimeHostApproved((s?.compute?.hostApproved as string[] | undefined) ?? [])
      setRuntimeHostApprovedSources((s?.compute?.hostApprovedSources as Record<string, string> | undefined) ?? {})
      setExecutionTargets(s.compute?.executionTargets ?? [])
      setRuntimeDefaultProviderId((s?.defaultProviderId as string | undefined) || undefined)
    })
    if (caches.providers && caches.mcpRegistrations && caches.adapterRegistrations) {
      setProviders(caches.providers)
      setMcpRegistrations(caches.mcpRegistrations)
      setAdapterRegistrations(caches.adapterRegistrations)
      // console.log(`[PERF:renderer] AgentConfig.getSettings: ${(performance.now() - t0).toFixed(1)}ms (cached)`)
    } else {
      openApi()?.getSettings().then((settings) => {
        caches.providers = (settings.providers as ProviderConfig[]) ?? []
        caches.mcpRegistrations = (settings.mcpServers as McpServerRegistration[]) ?? []
        caches.adapterRegistrations = (settings.adapters as AdapterRegistration[]) ?? []
        if (!live) return
        setProviders(caches.providers)
        setMcpRegistrations(caches.mcpRegistrations)
        setAdapterRegistrations(caches.adapterRegistrations)
        setRuntimeHostEnabled(settings.compute?.hostAccessEnabled ?? false)
        setExecutionTargets(settings.compute?.executionTargets ?? [])
        // console.log(`[PERF:renderer] AgentConfig.getSettings: ${(performance.now() - t0).toFixed(1)}ms (fetched)`)
      })
    }
    return () => { live = false }
  }, [openRuntime])

  // Check for missing sandbox packages on config load
  useEffect(() => {
    const packages = config?.code_execution?.packages
    if (template || !packages?.length) return
    openApi()?.checkMissingSandboxPackages(packages).then((result) => {
      if (result?.missing?.length) {
        setMissingPackages(result.missing)
        setShowPkgInstallModal(true)
      }
    })
  }, [config?.code_execution?.packages])

  // Fetch mesh server status for Serving section URL preview
  useEffect(() => {
    if (template) return
    openApi()?.getMeshServerStatus().then(setMeshServerStatus)
  }, [])

  // Fetch adf_meta entries
  const refreshMeta = useCallback(() => {
    if (templateRef.current) return
    openApi()?.getAllMeta().then((res) => {
      if (res?.entries) setMetaEntries(res.entries)
    })
  }, [])
  useEffect(() => { refreshMeta() }, [refreshMeta])

  useEffect(() => {
    if (template) return
    const fetchLocalTables = () => {
      openApi()?.listLocalTables().then((res) => {
        setLocalTables((res?.tables ?? []).filter((table) => table.name.startsWith('local_')))
      })
    }
    fetchLocalTables()
    // Live refresh when the agent creates/drops tables while this panel is open
    const unsubscribe = openApi()?.onWorkspaceDataChanged?.(({ scope }) => {
      if (scope === 'tables') fetchLocalTables()
    })
    return () => unsubscribe?.()
  }, [filePath, openRuntime])

  // Fetch known agents from the mesh for the allow/block list DID picker
  useEffect(() => {
    if (template) return
    const fetchKnown = async () => {
      const agents: { did: string; label: string }[] = []
      const seen = new Set<string>()

      // Mesh agents (local)
      try {
        const meshResult = await openApi()?.getMeshStatus()
        if (meshResult?.agents) {
          for (const a of meshResult.agents) {
            if (a.did && !seen.has(a.did)) {
              seen.add(a.did)
              agents.push({ did: a.did, label: a.handle })
            }
          }
        }
      } catch { /* ignore */ }

      // Exclude self
      const selfDid = local?.id
      const filtered = selfDid ? agents.filter(a => a.did !== selfDid) : agents
      filtered.sort((a, b) => a.label.localeCompare(b.label))
      setKnownAgents(filtered)
    }
    fetchKnown()
  }, [local?.id])

  // Check which MCP servers have identity keys stored in this ADF
  useEffect(() => {
    if (template || !local?.mcp?.servers?.length) {
      setMcpServersWithKeys(new Set())
      return
    }
    openApi()?.listIdentityPurposes('mcp:').then((purposes) => {
      const namesWithKeys = new Set<string>()
      for (const srv of local.mcp!.servers) {
        const regType = mcpRegistrations.find((r) => r.name === srv.name)?.type ?? (srv.npm_package ? 'npm' : srv.pypi_package ? 'uvx' : 'custom')
        const pkg = srv.npm_package ?? srv.pypi_package
        const prefix = (regType === 'npm' || regType === 'uvx') && pkg
          ? `mcp:${pkg}:`
          : `mcp:${srv.name}:`
        if (purposes.some((p) => p.startsWith(prefix))) {
          namesWithKeys.add(srv.name)
        }
      }
      setMcpServersWithKeys(namesWithKeys)
    })
  }, [local?.mcp?.servers, mcpRegistrations])

  // Check which adapters have identity keys stored in this ADF
  useEffect(() => {
    if (template || adapterRegistrations.length === 0) {
      setAdapterWithKeys(new Set())
      return
    }
    openApi()?.listIdentityPurposes('adapter:').then((purposes) => {
      const typesWithKeys = new Set<string>()
      const keysByType: Record<string, Set<string>> = {}
      for (const reg of adapterRegistrations) {
        const prefix = `adapter:${reg.type}:`
        const keys = new Set<string>()
        for (const p of purposes) {
          if (p.startsWith(prefix)) keys.add(p.slice(prefix.length))
        }
        if (keys.size > 0) {
          typesWithKeys.add(reg.type)
          keysByType[reg.type] = keys
        }
      }
      setAdapterWithKeys(typesWithKeys)
      setAdapterIdentityKeys(keysByType)

      // Pull the email account identifier for display (non-sensitive)
      if (keysByType.email?.has('EMAIL_USERNAME')) {
        openApi()?.getIdentity('adapter:email:EMAIL_USERNAME').then((val) => {
          setEmailAccount(val ?? null)
        })
      } else {
        setEmailAccount(null)
      }
    })
  }, [local?.adapters, adapterRegistrations])

  // Check if this ADF has signing keys (DID exists iff keys were generated)
  useEffect(() => {
    if (template) return
    const check = () => {
      openApi()?.getDid().then((r) => setHasSigningKeys(!!r?.did))
    }
    check()
    // Re-check when window gains focus (user may switch to Identity tab and generate keys)
    window.addEventListener('focus', check)
    return () => window.removeEventListener('focus', check)
  }, [filePath])

  // Fetch tool definitions (cached per runtime — a runtime's tool registry doesn't change while it runs)
  useEffect(() => {
    const t0 = performance.now()
    const caches = cachesOf(openRuntime)
    let live = true
    if (caches.toolDefs) {
      setToolDefs(caches.toolDefs)
      // console.log(`[PERF:renderer] AgentConfig.getToolDefs: ${(performance.now() - t0).toFixed(1)}ms (cached)`)
    } else {
      openApi()?.getToolDescriptions().then((defs) => {
        caches.toolDefs = defs
        if (live) setToolDefs(defs)
        // console.log(`[PERF:renderer] AgentConfig.getToolDefs: ${(performance.now() - t0).toFixed(1)}ms (fetched)`)
      })
    }
    return () => { live = false }
  }, [openRuntime])

  const updateFileEntry = useTrackedDirsStore((s) => s.updateFileEntry)

  /** The actual write: SQLite + side-loop/MCP reconcile on the main side. */
  const persistConfig = useCallback(
    (updated: AgentConfigType, owner: string | null, baseRevision?: number, baseConfig: AgentConfigType | null = null) => {
      // The agent moved on between scheduling and delivery — writing now would
      // put one agent's config into another agent's workspace.
      if (owner !== useDocumentStore.getState().filePath) return
      // Never fire-and-forget: a refused save (no workspace open, or the
      // backend switched to a different agent file) would otherwise leave the
      // panel showing state that was never persisted — e.g. a tool displayed
      // as enabled while the runtime's shell gate still sees it disabled.
      // On failure the draft stays and the header says "Not saved" (Retry,
      // Discard), so the edit is neither lost nor passed off as saved.
      const seq = ++saveSeqRef.current
      void Promise.resolve(openApi()?.setAgentConfig(updated, baseRevision !== undefined ? { baseRevision } : undefined))
        .then((res) => {
          // W3-F: someone else saved the config since this edit started.
          // Only the revision moved (the config is what the edit started
          // from): save again over it. Otherwise keep this version and ask.
          const outcome = classifyConfigSave(res, baseConfig, updated)
          if (outcome.kind === 'retry') {
            console.info(`[Config] Revision moved without a change to the config; saving over ${outcome.baseRevision}`)
            persistConfig(updated, owner, outcome.baseRevision)
            return
          }
          if (outcome.kind === 'conflict') {
            if (owner !== useDocumentStore.getState().filePath) return
            setConfigConflict({ mine: updated, theirs: outcome.conflict.theirs as AgentConfigType | null, revision: outcome.conflict.revision, writer: outcome.conflict.writer, owner })
            return
          }
          if (res?.success !== false && owner === useDocumentStore.getState().filePath) {
            if (outcome.revision !== undefined) useAgentStore.getState().setConfigRevision(outcome.revision)
            // A later edit saved over the current config: an older notice no longer applies.
            setConfigConflict(null)
            lastSavedSeqRef.current = Math.max(lastSavedSeqRef.current, seq)
            failedSaveRef.current = null
            // Still "Saving…" while a later edit waits for its own write.
            if (!pendingSaveRef.current) setSaveStatus({ kind: 'saved' })
          }
          if (res && (res as { success?: boolean }).success === false) failSave(res)
        })
        .catch((err) => failSave(err))

      // Refused or failed: the panel keeps the draft and says so, with Retry.
      // A re-sync from the backend here would silently drop the edit.
      function failSave(answer: unknown): void {
        if (owner !== useDocumentStore.getState().filePath || seq < lastSavedSeqRef.current) return
        failedSaveRef.current = { config: updated, owner, baseRevision, baseConfig }
        setSaveStatus({ kind: 'error', error: saveFailureReason(answer) })
      }

      // Sync sidebar-visible fields to tracked dirs store so they
      // persist when this file is no longer the foreground agent
      // (the open agent's runtime's slice: an agent of another runtime with the same path is not it).
      if (owner) {
        updateFileEntry(owner, {
          autonomous: updated.autonomous ?? false,
          canReceive: updated.triggers?.on_inbox?.enabled ?? false,
          sendMode: updated.messaging?.mode
        }, openSliceRuntime())
      }
    },
    [setConfig, updateFileEntry]
  )

  /** Write any debounced edit through right now (blur, unmount, file switch). */
  const flushSave = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    const pending = pendingSaveRef.current
    pendingSaveRef.current = null
    if (pending) persistConfig(pending.config, pending.owner, pending.baseRevision, pending.baseConfig)
  }, [persistConfig])
  const flushSaveRef = useRef(flushSave)
  flushSaveRef.current = flushSave

  /** Send the refused save again, over the same base. */
  const retrySave = useCallback(() => {
    const failed = failedSaveRef.current
    if (!failed) return
    failedSaveRef.current = null
    setSaveStatus({ kind: 'saving' })
    persistConfig(failed.config, failed.owner, failed.baseRevision, failed.baseConfig)
  }, [persistConfig])

  /** Drop the refused draft: the panel shows the backend's config again. */
  const discardFailedSave = useCallback(() => {
    failedSaveRef.current = null
    setSaveStatus({ kind: 'idle' })
    void openApi()?.getAgentConfig().then((authoritative) => {
      if (authoritative) setConfig(authoritative as AgentConfigType)
    })
  }, [setConfig])

  // Status, undo and MCP views belong to one agent.
  useEffect(() => {
    failedSaveRef.current = null
    setSaveStatus({ kind: 'idle' })
    setApprovalUndo(null)
    setMcpLogsFor(null)
    setMcpLogs([])
  }, [filePath])

  // The undo offer stays a short while; it changes nothing on its own.
  useEffect(() => {
    if (!approvalUndo) return
    const t = setTimeout(() => setApprovalUndo(null), 10_000)
    return () => clearTimeout(t)
  }, [approvalUndo])

  // Live MCP status for the open agent: the snapshot, then pushes.
  useEffect(() => {
    if (template) return
    let cancelled = false
    setMcpStates({})
    void Promise.resolve(openApi()?.getMcpServerStatus?.()).then((res) => {
      if (cancelled || !res?.servers) return
      const next: Record<string, { status: McpServerStatus; error?: string }> = {}
      for (const st of res.servers) next[st.name] = { status: st.status, error: st.error }
      setMcpStates(next)
    }).catch(() => { /* no runtime for this agent: no status to show */ })
    const unsub = openApi()?.onMcpServerStatusChanged?.((event) => {
      setMcpStates((prev) => ({ ...prev, [event.name]: { status: event.status, error: event.error } }))
    })
    return () => { cancelled = true; unsub?.() }
  }, [filePath, openRuntime])

  // The open Logs view follows the server's status changes.
  const mcpLogsStatus = mcpLogsFor ? mcpStates[mcpLogsFor]?.status : undefined
  useEffect(() => {
    if (!mcpLogsFor) return
    let cancelled = false
    void Promise.resolve(openApi()?.getMcpServerLogs?.({ name: mcpLogsFor })).then((res) => {
      if (!cancelled) setMcpLogs(res?.logs ?? [])
    }).catch(() => { if (!cancelled) setMcpLogs([]) })
    return () => { cancelled = true }
  }, [mcpLogsFor, mcpLogsStatus])

  // setAgentConfig is the heaviest IPC handler in the app (SQLite write plus a
  // side-loop and MCP reconcile). Every keystroke used to fire one. Local state
  // and the renderer store still update synchronously, so the panel and the
  // rest of the UI stay instantly responsive; only the write is coalesced.
  const save = useCallback(
    (updated: AgentConfigType) => {
      savingRef.current = true
      setLocal(updated)
      if (templateRef.current) {
        templateRef.current.onChange(updated)
        return
      }
      // The base of a burst of edits is the config before its first edit. A
      // refused save's draft is still unsaved: an edit over it keeps its base.
      const previous = pendingSaveRef.current && pendingSaveRef.current.owner === filePath
        ? pendingSaveRef.current
        : failedSaveRef.current && failedSaveRef.current.owner === filePath ? failedSaveRef.current : null
      failedSaveRef.current = null
      const agentStore = useAgentStore.getState()
      const base = previous
        ? { baseRevision: previous.baseRevision, baseConfig: previous.baseConfig }
        : { baseRevision: agentStore.configRevision, baseConfig: agentStore.config }
      setSaveStatus((st) => (st.kind === 'saving' ? st : { kind: 'saving' }))
      setConfig(updated)
      pendingSaveRef.current = { config: updated, owner: filePath, ...base }
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null
        const pending = pendingSaveRef.current
        pendingSaveRef.current = null
        if (pending) persistConfig(pending.config, pending.owner, pending.baseRevision, pending.baseConfig)
      }, SAVE_DEBOUNCE_MS)
    },
    [setConfig, filePath, persistConfig]
  )

  /** Validate and commit the hook as one optional top-level config object. */
  const savePreLlmHook = useCallback(() => {
    if (!local) return
    const result = validatePreLlmHookDraft(preLlmHookDraft)
    setPreLlmHookErrors(result.errors)
    if (!result.config) return
    save({ ...local, pre_llm_hook: result.config })
    setPreLlmHookDraft(preLlmHookDraftFromConfig(result.config))
  }, [local, preLlmHookDraft, save])

  /** Remove the optional field entirely rather than leaving an enabled flag. */
  const removePreLlmHook = useCallback(() => {
    if (!local) return
    const next = structuredClone(local)
    delete next.pre_llm_hook
    save(next)
    setPreLlmHookDraft(preLlmHookDraftFromConfig())
    setPreLlmHookErrors([])
  }, [local, save])

  // Nothing may outlive the panel or the open file with an unwritten edit.
  // The cleanup runs before `filePath` takes its new value here, and the
  // pending entry carries its own owner, so a late flush can never land in the
  // wrong workspace.
  useEffect(() => () => flushSaveRef.current(), [filePath])
  useEffect(() => {
    const flush = () => flushSaveRef.current()
    window.addEventListener('beforeunload', flush)
    const unregister = registerPreSwitchFlush(flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      unregister()
    }
  }, [])

  /**
   * A section lock is one or more top-level config keys in `locked_fields` —
   * the same list `sys_update_config` checks per path prefix. Most sections are
   * one key; a section whose controls write sibling top-level fields (the
   * Instructions section owns `instructions`, `include_base_prompt` and
   * `bare_prompt`) passes all of them, so locking it locks the whole section
   * rather than the textarea alone.
   */
  const isSectionLocked = useCallback(
    (key: string | string[]) => {
      if (templateRef.current) return false
      const keys = Array.isArray(key) ? key : [key]
      const locked = local?.locked_fields ?? []
      return keys.every((k) => locked.includes(k))
    },
    [local?.locked_fields]
  )

  const toggleSectionLock = useCallback(
    (key: string | string[]) => {
      if (!local) return
      const keys = Array.isArray(key) ? key : [key]
      const current = local.locked_fields ?? []
      const fields = keys.every((k) => current.includes(k))
        ? current.filter((k) => !keys.includes(k))
        : [...current, ...keys.filter((k) => !current.includes(k))]
      save({ ...local, locked_fields: fields.length > 0 ? fields : undefined })
    },
    [local, save]
  )

  /** Every top-level field the Instructions section writes. */
  const INSTRUCTIONS_LOCK_KEYS = ['instructions', 'include_base_prompt', 'bare_prompt']

  const toggleFieldLock = useCallback(
    (key: string, alsoKeys?: string[]) => {
      if (!local) return
      const fields = [...(local.locked_fields ?? [])]
      const allKeys = [key, ...(alsoKeys ?? [])]
      if (fields.includes(key)) {
        const toRemove = new Set(allKeys)
        const next = fields.filter(f => !toRemove.has(f))
        save({ ...local, locked_fields: next.length > 0 ? next : undefined })
      } else {
        for (const k of allKeys) {
          if (!fields.includes(k)) fields.push(k)
        }
        save({ ...local, locked_fields: fields })
      }
    },
    [local, save]
  )

  /** A bulk tools change. One that takes approval off tools offers Undo. */
  const saveBulkTools = useCallback(
    (tools: ToolDeclaration[]) => {
      if (!local) return
      const removed = approvalRemoved(local.tools, tools)
      save({ ...local, tools })
      if (removed.length > 0) setApprovalUndo({ names: removed, owner: filePath })
    },
    [local, save, filePath]
  )

  const undoApprovalRemoval = useCallback(() => {
    if (!local || !approvalUndo || approvalUndo.owner !== filePath) return
    save({ ...local, tools: restoreApproval(local.tools, approvalUndo.names) })
    setApprovalUndo(null)
  }, [local, approvalUndo, filePath, save])

  const setTableProtection = useCallback(
    (table: string, protection: TableProtectionLevel) => {
      if (!local) return
      const tableName = table.trim()
      if (!tableName.startsWith('local_')) return
      const protections = { ...(local.security?.table_protections ?? {}) }
      if (protection === 'none') delete protections[tableName]
      else protections[tableName] = protection
      save({
        ...local,
        security: {
          ...local.security,
          table_protections: Object.keys(protections).length > 0 ? protections : undefined
        }
      })
    },
    [local, save]
  )

  const handleRename = useCallback(async () => {
    if (editingName === null || !filePath || !local) return
    const trimmed = editingName.trim()
    if (!trimmed || trimmed === local.name) {
      setEditingName(null)
      setNameError(null)
      return
    }
    const result = await openApi().renameFile(filePath, trimmed)
    if (result.success && result.filePath) {
      setFilePath(result.filePath)
      setLocal({ ...local, name: trimmed })
      setConfig({ ...local, name: trimmed })
      // Deferred rename (agent running): the file keeps its old name until
      // the agent stops, so the sidebar row keeps it too and shows the new
      // name as pending.
      if (result.renameDeferred) updateFileEntry(result.filePath, { pendingName: trimmed }, openSliceRuntime())
      setEditingName(null)
      setNameError(null)
    } else {
      setNameError(result.error ?? 'Rename failed')
    }
  }, [editingName, filePath, local, setFilePath, setConfig, updateFileEntry])

  // Stable row keys for the editable lists below. Every field in those rows is
  // rewritten per keystroke, so nothing in the item can be the key; an index
  // key hands a removed row's DOM node, focus and local state to its
  // successor. Keyed on the open file, so switching agent starts clean.
  const paramKeys = useRowKeys(local?.model.params, filePath)
  const loopKeys = useRowKeys(local?.loops, filePath)
  const inboxMwKeys = useRowKeys(local?.security?.middleware?.inbox, filePath)
  const outboxMwKeys = useRowKeys(local?.security?.middleware?.outbox, filePath)
  const fetchMwKeys = useRowKeys(local?.security?.fetch_middleware, filePath)
  const apiRouteKeys = useRowKeys(local?.serving?.api, filePath)
  const routeMwKeys = useRowKeysGroup(filePath)
  const triggerTargetKeys = useRowKeysGroup(filePath)
  const wsConnKeys = useRowKeys(local?.ws_connections, filePath)
  const bindingKeys = useRowKeys(local?.stream_bindings, filePath)
  const tapKeys = useRowKeys(local?.umbilical_taps, filePath)
  const logRuleKeys = useRowKeys(local?.logging?.rules, filePath)
  const scrollRef = useRef<HTMLDivElement>(null)

  if (!local) {
    return (
      <div className="p-4 text-sm text-[var(--adf-ui-text-subtle)] text-center mt-8">
        Open a file to view agent configuration.
      </div>
    )
  }

  const tableProtectionEntries = Object.entries(local.security?.table_protections ?? {})
    .filter(([, protection]) => protection && protection !== 'none')
    .sort(([a], [b]) => a.localeCompare(b)) as Array<[string, Exclude<TableProtectionLevel, 'none'>]>
  const protectedTableNames = new Set(tableProtectionEntries.map(([table]) => table))
  const availableTablesForProtection = localTables.filter((table) => !protectedTableNames.has(table.name))

  return (
    <TemplateModeContext.Provider value={!!template}>
    {/* Leaving any field writes the pending edit through immediately, so a
        click that switches agent or starts one never races the debounce. */}
    <div ref={scrollRef} className={template ? '' : 'h-full overflow-y-auto'} onBlurCapture={flushSave}>
      {!template && configConflict && configConflict.owner === filePath && (
        <ChangedElsewhereNotice
          what="The config"
          writer={configConflict.writer}
          onReload={() => {
            const theirs = configConflict.theirs
            setConfigConflict(null)
            if (theirs) {
              useAgentStore.getState().setConfigRevision(configConflict.revision)
              setConfig(theirs)
            } else {
              void openApi()?.getAgentConfig().then((c) => { if (c) setConfig(c as AgentConfigType) })
            }
          }}
          onKeep={() => {
            const { mine, revision, owner } = configConflict
            setConfigConflict(null)
            savingRef.current = true
            setLocal(mine)
            setConfig(mine)
            persistConfig(mine, owner, revision)
          }}
        />
      )}
      <MaybeConfigNav
        enabled={!template}
        scrollRef={scrollRef}
        status={<SaveStatusLine status={saveStatus} onRetry={retrySave} onDiscard={discardFailedSave} />}
      >
      <div className={template ? 'space-y-4' : 'p-3 space-y-4'}>
        {/* Identity */}
        <Section docs={DOCS.identity} title={template ? 'Startup' : 'Identity'}>
          {!template && (<>
          <Field label="Name">
            <input
              ref={nameInputRef}
              type="text"
              value={editingName !== null ? editingName : local.name}
              onChange={(e) => {
                setEditingName(e.target.value)
                setNameError(null)
              }}
              onFocus={() => setEditingName(local.name)}
              onBlur={() => handleRename()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  nameInputRef.current?.blur()
                } else if (e.key === 'Escape') {
                  setEditingName(null)
                  setNameError(null)
                  nameInputRef.current?.blur()
                }
              }}
              className="field-input"
            />
            {nameError ? (
              <p className="text-[10px] text-red-400 mt-0.5">{nameError}</p>
            ) : (
              <p className="text-[10px] text-[var(--adf-ui-text-subtle)] mt-0.5">Press Enter to rename.</p>
            )}
          </Field>
          <Field label="Description">
            <input
              type="text"
              value={local.description}
              onChange={(e) => save({ ...local, description: e.target.value })}
              className="field-input"
            />
          </Field>
          </>)}
          <Field
            label="Icon"
            hint={agentAvatars === 'emoji'
              ? "Shown in the sidebar, the header and in the Mesh view. Also published on the agent's card."
              : "Published on the agent's card. Studio shows the agent's orbital unless Settings > Agent avatars is set to Emoji."}
          >
            <IconPicker
              value={local.icon || pickAgentIcon(local.id)}
              onChange={(icon) => save({ ...local, icon })}
            />
          </Field>
          <Field label="Start in state" hint="State the agent boots into on startup. Runtime state is not persisted.">
            <select
              value={local.start_in_state ?? 'active'}
              onChange={(e) => {
                const val = e.target.value as StartInState
                save({ ...local, start_in_state: val === 'active' ? undefined : val })
              }}
              className="field-input w-32"
            >
              {START_IN_STATES.map((s) => (
                <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>
              ))}
            </select>
          </Field>
          <Field label="Autostart">
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={local.autostart ?? false}
                onChange={(e) => {
                  save({ ...local, autostart: e.target.checked || undefined })
                }}
              />
              <span className="text-neutral-700 dark:text-neutral-300">
                Start as background agent on boot
                <InfoHint tip="Automatically start this agent when the app launches. Password-protected agents are skipped." />
              </span>
            </label>
          </Field>
          <Field label="Autonomous">
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={local.autonomous ?? false}
                onChange={(e) => {
                  save({ ...local, autonomous: e.target.checked })
                }}
              />
              <span className="text-neutral-700 dark:text-neutral-300">Operate continuously without stopping after each response</span>
            </label>
          </Field>
          {local.autonomous && (
            <>
              <details className="group rounded-md border border-amber-200 bg-amber-50 dark:border-amber-700 dark:bg-amber-900/20">
                <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-2.5 py-2 text-[11px] font-medium text-amber-700 outline-none focus-visible:ring-2 focus-visible:ring-amber-400/50 dark:text-amber-400 [&::-webkit-details-marker]:hidden">
                  <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M8 1.75 14.25 13H1.75L8 1.75Z" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
                    <path d="M8 5.5v3.75M8 11.5h.01" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
                  </svg>
                  <span className="flex-1">Warning: Autonomous mode can incur ongoing API costs</span>
                  <svg className="h-3 w-3 shrink-0 transition-transform group-open:rotate-90" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                    <path d="m4.5 2.5 3.5 3.5-3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </summary>
                <p className="border-t border-amber-200 px-2.5 py-2 text-[10px] leading-relaxed text-amber-700 dark:border-amber-700 dark:text-amber-400">
                  An autonomous agent will keep making LLM calls without pausing between turns.
                  This will consume tokens and incur API costs. If the agent loops (e.g. repeated
                  read/write cycles), costs can escalate quickly. Ensure your instructions have clear
                  stopping conditions and that <strong>sys_set_state</strong> is enabled so the agent
                  can idle or stop itself.
                </p>
              </details>
              <Field label="Max active turns" hint="Pauses the agent after this many LLM loop iterations and asks you to resume or stop.">
                <div className="flex items-center gap-2">
                  <NumberInput
                    min={0}
                    step={1}
                    value={local.limits?.max_active_turns ?? 0}
                    placeholder="0"
                    onChange={(v) =>
                      save({
                        ...local,
                        limits: { ...local.limits, max_active_turns: v > 0 ? v : null }
                      })
                    }
                  />
                  <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">
                    {local.limits?.max_active_turns ? `Suspends after ${local.limits.max_active_turns} turns` : '0 = unlimited'}
                  </span>
                </div>
              </Field>
              <Field label="Suspend timeout (minutes)" hint="If no response within this time, the agent shuts down automatically.">
                <div className="flex items-center gap-2">
                  <NumberInput
                    min={1}
                    step={1}
                    value={Math.round((local.limits?.suspend_timeout_ms ?? 1_200_000) / 60_000)}
                    onChange={(v) =>
                      save({
                        ...local,
                        limits: { ...local.limits, suspend_timeout_ms: v * 60_000 }
                      })
                    }
                  />
                  <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">
                    {Math.round((local.limits?.suspend_timeout_ms ?? 1_200_000) / 60_000)} min
                  </span>
                </div>
              </Field>
            </>
          )}
        </Section>

        {/* Model */}
        <Section docs={DOCS.model} title="Model" locked={isSectionLocked('model')} onToggleLock={() => toggleSectionLock('model')} summary={`${local.model.provider ?? 'none'} / ${local.model.model_id || 'default'}`}>
          <Field label="Provider">
            <select
              value={local.model.provider}
              onChange={async (e) => {
                const newProvider = e.target.value
                // A template's empty Provider: new agents get the runtime default.
                if (template && !newProvider) {
                  save({ ...local, model: { ...local.model, provider: '', model_id: '', params: undefined } })
                  return
                }
                // A provider stored on the agent uses the agent's own copy
                const adfMatch = (local.providers ?? []).find(p => p.id === newProvider)
                if (adfMatch) {
                  save({
                    ...local,
                    model: {
                      ...local.model,
                      provider: newProvider,
                      model_id: adfMatch.defaultModel || '',
                      params: adfMatch.params?.length ? adfMatch.params.map((p) => ({ ...p })) : undefined
                    }
                  })
                  return
                }

                // Re-fetch settings to get the latest defaults (invalidate cache)
                const caches = cachesOf(useDocumentStore.getState().runtimeId)
                caches.providers = null
                const settings = await openApi()?.getSettings()
                const freshProviders = (settings?.providers as ProviderConfig[]) ?? []
                caches.providers = freshProviders
                setProviders(freshProviders)

                const selected = freshProviders.find((p) => p.id === newProvider)
                save({
                  ...local,
                  model: {
                    ...local.model,
                    provider: newProvider,
                    model_id: selected?.defaultModel || '',
                    params: selected?.params?.length ? selected.params.map((p) => ({ ...p })) : undefined
                  }
                })
              }}
              className="field-input w-full"
            >
              {/* Precedence: the agent's own provider, then its template's, then the runtime default. */}
              {template && (
                <option value="">{runtimeDefaultLabel(providers, runtimeDefaultProviderId)}</option>
              )}
              {!(template && !local.model.provider) && !(local.providers ?? []).some((p) => p.id === local.model.provider) && !providers.some((p) => p.id === local.model.provider) && (
                <option value={local.model.provider}>
                  {local.model.provider || '— Select a provider —'}
                </option>
              )}
              <ProviderOptions agentProviders={local.providers} appProviders={providers} />
            </select>
          </Field>
          <Field label="Model ID">
            {/* Runtime default: new agents get that provider's default model, so there is nothing to pick here. */}
            {template && !local.model.provider ? (
              <span className="text-xs text-[var(--adf-ui-text-subtle)]">The runtime default's model</span>
            ) : (
              <ModelIdField
                providerId={local.model.provider}
                filePath={carriedFilePath(local.model.provider)}
                value={local.model.model_id}
                onChange={(modelId) => save({ ...local, model: { ...local.model, model_id: modelId } })}
              />
            )}
          </Field>
          <Field label="Providers on this agent" hint="Stored on the agent, so they go with the file. A key is only stored when you set one.">
            <AgentProvidersList filePath={filePath} config={local} appProviders={providers} save={save} />
          </Field>
          <Field
            label="Reasoning"
            hint={'Thinking effort, mapped per provider (Anthropic token budget; OpenRouter/OpenAI effort). Displayed traces are provider-side summaries, not full reasoning.\n\nSome models always produce reasoning tokens and can’t have it disabled — when set to Off, their reasoning is still captured and shown (never hidden).'}
          >
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <select
                  value={local.model.reasoning?.effort ?? (local.model.reasoning ? 'medium' : '')}
                  onChange={(e) => {
                    const v = e.target.value
                    const next = v
                      ? { ...local.model.reasoning, enabled: true, effort: v as ReasoningEffort }
                      : undefined
                    save({ ...local, model: { ...local.model, thinking_budget: undefined, reasoning: next } })
                  }}
                  className="field-input"
                >
                  <option value="">Off</option>
                  <option value="minimal">Minimal</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="xhigh">X-High</option>
                </select>
                <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">effort</span>
              </div>
              {local.model.reasoning && (
                <>
                  <div className="flex items-center gap-2">
                    <NumberInput
                      min={0}
                      step={1024}
                      value={local.model.reasoning.max_tokens ?? 0}
                      onChange={(v) =>
                        save({
                          ...local,
                          model: { ...local.model, reasoning: { ...local.model.reasoning, enabled: true, max_tokens: v > 0 ? v : undefined } }
                        })
                      }
                      className="field-input w-24"
                    />
                    <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">max tokens (0 = derive from effort)</span>
                  </div>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={local.model.reasoning.exclude ?? false}
                      onChange={(e) =>
                        save({ ...local, model: { ...local.model, reasoning: { ...local.model.reasoning, exclude: e.target.checked } } })
                      }
                      className="accent-blue-500"
                    />
                    <span className="text-[10px] text-neutral-500 dark:text-neutral-400">Exclude reasoning from response</span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={local.model.reasoning.preserve ?? false}
                      onChange={(e) =>
                        save({ ...local, model: { ...local.model, reasoning: { ...local.model.reasoning, preserve: e.target.checked } } })
                      }
                      className="accent-blue-500"
                    />
                    <span className="text-[10px] text-neutral-500 dark:text-neutral-400">Preserve reasoning across tool calls (OpenRouter)</span>
                  </label>
                </>
              )}
            </div>
          </Field>
          <Field
            label="Multimodal"
            hint="When enabled, media files read via fs_read or returned by MCP tools are sent as native content blocks to the LLM."
          >
            <div className="flex flex-col gap-1">
              {(['image', 'audio', 'video'] as const).map((modality) => (
                <label key={modality} className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={modality === 'image'
                      ? (local.model.multimodal?.image ?? local.model.vision ?? false)
                      : (local.model.multimodal?.[modality] ?? false)}
                    onChange={(e) => {
                      save({
                        ...local,
                        model: {
                          ...local.model,
                          vision: undefined,
                          multimodal: { ...local.model.multimodal, [modality]: e.target.checked }
                        }
                      })
                    }}
                    className="accent-blue-500"
                  />
                  <span className="text-[10px] text-neutral-500 dark:text-neutral-400 capitalize">
                    {modality}
                  </span>
                </label>
              ))}
            </div>
          </Field>
          {(() => {
            const temperature = local.model.temperature ?? 0.7
            const maxTokens = local.model.max_tokens ?? 0
            const paramCount = (local.model.params ?? []).length
            // Opens by itself when anything differs from the defaults, so a
            // changed value is never hidden behind the fold.
            const nonDefault = temperature !== 0.7 || maxTokens !== 0 || paramCount > 0
            const open = advancedOpen?.file === filePath ? advancedOpen.open : nonDefault
            const summary = [`temp ${temperature}`, `max ${maxTokens === 0 ? 'model default' : maxTokens.toLocaleString()}`, `${paramCount} param${paramCount === 1 ? '' : 's'}`].join(' · ')
            return (
          <div>
            <button
              type="button"
              onClick={() => setAdvancedOpen({ file: filePath, open: !open })}
              className="flex w-full items-center gap-1.5 text-left text-xs text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
              aria-expanded={open}
            >
              <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}><path d="M6 3l5 5-5 5z" /></svg>
              <span>Advanced</span>
              {!open && <span className="truncate text-[10px] text-[var(--adf-ui-text-subtle)]">{summary}</span>}
            </button>
            {open && (
            <div className="mt-1.5 space-y-2 pl-4">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-neutral-500 dark:text-neutral-400">
                <label className="flex items-center gap-1.5 whitespace-nowrap">
                  Temperature
                  <NumberInput
                    float
                    min={0}
                    max={2}
                    step={0.1}
                    value={temperature}
                    onChange={(v) => save({ ...local, model: { ...local.model, temperature: v } })}
                    className="field-input !h-6 !px-1.5 !text-[11px] !w-14"
                  />
                </label>
                <label className="flex items-center gap-1.5 whitespace-nowrap">
                  Max tokens
                  <NumberInput
                    min={0}
                    step={256}
                    value={maxTokens}
                    onChange={(v) => save({ ...local, model: { ...local.model, max_tokens: v } })}
                    className="field-input !h-6 !px-1.5 !text-[11px] !w-20"
                  />
                  {maxTokens === 0 && <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">model default</span>}
                </label>
              </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-[11px] text-neutral-500 dark:text-neutral-400">Parameters</label>
                <button
                  className="text-[10px] text-blue-500 hover:text-blue-700 font-medium"
                  onClick={() => {
                    const params = [...(local.model.params ?? [])]
                    params.push({ key: '', value: '' })
                    paramKeys.append()
                    save({ ...local, model: { ...local.model, params } })
                  }}
                >
                  + Add
                </button>
              </div>
              {(local.model.params ?? []).length > 0 ? (
                <div className="space-y-1.5">
                  {(local.model.params ?? []).map((param, j) => (
                    <div key={paramKeys.keys[j]} className="flex gap-1 items-center">
                      <input
                        type="text"
                        value={param.key}
                        onChange={(e) => {
                          const params = [...(local.model.params ?? [])]
                          params[j] = { ...params[j], key: e.target.value }
                          save({ ...local, model: { ...local.model, params } })
                        }}
                        placeholder="key"
                        className="field-input flex-1 !text-xs font-mono"
                      />
                      <input
                        type="text"
                        value={param.value}
                        onChange={(e) => {
                          const params = [...(local.model.params ?? [])]
                          params[j] = { ...params[j], value: e.target.value }
                          save({ ...local, model: { ...local.model, params } })
                        }}
                        placeholder="blank = null"
                        className="field-input flex-1 !text-xs font-mono"
                      />
                      <button
                        onClick={() => {
                          const params = (local.model.params ?? []).filter((_, k) => k !== j)
                          paramKeys.removeAt(j)
                          save({ ...local, model: { ...local.model, params } })
                        }}
                        className="text-xs text-red-400 hover:text-red-600 px-0.5"
                      >
                        &times;
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-[10px] text-[var(--adf-ui-text-subtle)]">
                  Override provider params for this file. Blank value = remove key.
                </p>
              )}
            </div>
            </div>
            )}
          </div>
            )
          })()}

          {/* Recovery — auto-retry of transient provider errors */}
          <div className="mt-3 pt-3 border-t border-neutral-200 dark:border-neutral-700">
          <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-1">Recovery</label>
          <label className="flex items-center justify-between text-xs">
            <span className="text-neutral-700 dark:text-neutral-300">
              Auto-retry transient provider errors
              <InfoHint tip="Rate limits, overloads, and network failures automatically retry the failed turn with exponential backoff instead of leaving the agent stalled. Authentication and billing errors never retry." />
            </span>
            <input
              type="checkbox"
              checked={local.recovery?.auto_retry ?? true}
              onChange={(e) =>
                save({
                  ...local,
                  recovery: { ...RECOVERY_DEFAULTS, ...local.recovery, auto_retry: e.target.checked }
                })
              }
            />
          </label>
          {(local.recovery?.auto_retry ?? true) && (
            <>
              <Field label="Max Attempts">
                <div className="flex items-center gap-2">
                  <NumberInput
                    min={1}
                    max={100}
                    step={1}
                    value={local.recovery?.max_attempts ?? RECOVERY_DEFAULTS.max_attempts}
                    onChange={(v) =>
                      save({
                        ...local,
                        recovery: { ...RECOVERY_DEFAULTS, ...local.recovery, max_attempts: v }
                      })
                    }
                    className="field-input w-32"
                  />
                  <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">
                    consecutive failures before giving up
                  </span>
                </div>
              </Field>
              <Field label="First Retry Delay">
                <div className="flex items-center gap-2">
                  <NumberInput
                    min={1}
                    max={3600}
                    step={5}
                    value={Math.round((local.recovery?.base_delay_ms ?? RECOVERY_DEFAULTS.base_delay_ms) / 1000)}
                    onChange={(v) =>
                      save({
                        ...local,
                        recovery: { ...RECOVERY_DEFAULTS, ...local.recovery, base_delay_ms: v * 1000 }
                      })
                    }
                    className="field-input w-32"
                  />
                  <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">
                    seconds — doubles each attempt, ±20% jitter
                  </span>
                </div>
              </Field>
              <Field label="Backoff Ceiling">
                <div className="flex items-center gap-2">
                  <NumberInput
                    min={5}
                    max={86400}
                    step={30}
                    value={Math.round((local.recovery?.max_delay_ms ?? RECOVERY_DEFAULTS.max_delay_ms) / 1000)}
                    onChange={(v) =>
                      save({
                        ...local,
                        recovery: { ...RECOVERY_DEFAULTS, ...local.recovery, max_delay_ms: v * 1000 }
                      })
                    }
                    className="field-input w-32"
                  />
                  <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">
                    seconds max between retries (honors provider Retry-After)
                  </span>
                </div>
              </Field>
            </>
          )}
          </div>
        </Section>

        {/* Instructions */}
        <Section docs={DOCS.instructions} title="Instructions" locked={isSectionLocked(INSTRUCTIONS_LOCK_KEYS)} onToggleLock={() => toggleSectionLock(INSTRUCTIONS_LOCK_KEYS)}>
          {/* One select, not two checkboxes: `include_base_prompt: false`
              already drops the base prompt AND every conditional section
              (assemblePrompt is skipped wholesale), so a separate "runtime
              sections" toggle would have had to change what the existing flag
              means for every agent already configured with it off. The three
              options map 1:1 onto the two fields instead. The select governs
              the STATIC system prompt only — per-turn dynamic instructions are
              the checkboxes further down, and nothing else touches them. */}
          <PromptCompositionField
            filePath={filePath}
            config={local}
            onModeChange={(mode) =>
              save({
                ...local,
                include_base_prompt: mode === 'full' ? undefined : false,
                bare_prompt: mode === 'bare' ? true : undefined
              })
            }
          />
          <Field label="Agent Instructions" hint="The agent's own text. {{path}} placeholders resolve to workspace files. Always in the system prompt, whatever the composition setting.">
            <textarea
              value={local.instructions}
              onChange={(e) => save({ ...local, instructions: e.target.value })}
              rows={6}
              className="field-input resize-none font-mono text-xs"
            />
          </Field>
          <Field label="Dynamic Instructions" hint="Per-turn hints appended after the system prompt. These four checkboxes are the only gate — the composition setting above does not affect them.">
            <div className="space-y-1">
              {([
                { key: 'inbox_hints' as const, label: 'Inbox hints', desc: 'Notify agent of unread messages and reply guidance' },
                { key: 'context_warning' as const, label: 'Context warning', desc: 'Warn agent when approaching token limit' },
                { key: 'idle_reminder' as const, label: 'Idle reminder', desc: 'Remind agent to call sys_set_state idle when done working' },
                { key: 'mesh_updates' as const, label: 'Mesh updates', desc: 'Notify agent when other agents join or leave the mesh' }
              ]).map(({ key, label }) => (
                <label key={key} className="flex items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    checked={local.context?.dynamic_instructions?.[key] !== false}
                    onChange={(e) => {
                      const current = local.context?.dynamic_instructions ?? {}
                      save({
                        ...local,
                        context: {
                          ...local.context,
                          dynamic_instructions: { ...current, [key]: e.target.checked }
                        }
                      })
                    }}
                    className="rounded"
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </Field>
        </Section>

        {/* Context */}
        <Section docs={DOCS.context} title="Context" locked={isSectionLocked('context')} onToggleLock={() => toggleSectionLock('context')}>
          <Field label="Compact Threshold">
            <div className="flex items-center gap-2">
              <NumberInput
                min={0}
                step={10000}
                value={local.context?.compact_threshold ?? 0}
                placeholder="100000"
                onChange={(v) =>
                  save({
                    ...local,
                    context: {
                      ...local.context,
                      compact_threshold: v > 0 ? v : undefined
                    }
                  })
                }
                className="field-input w-32"
              />
              <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">
                {local.context?.compact_threshold ? `${local.context.compact_threshold.toLocaleString()} tokens` : 'Default: 100k'}
              </span>
            </div>
          </Field>
          <Field label="Media" hint="Most files and MB one request carries (default 20 files, 20 MB). Past either, the oldest files are left out until half of both remain, and the chat says how many. History keeps them all.">
            <div className="flex items-center gap-2">
              <NumberInput
                min={0}
                step={1}
                value={local.context?.max_request_media_files ?? 0}
                placeholder="20"
                onChange={(v) =>
                  save({ ...local, context: { ...local.context, max_request_media_files: v > 0 ? v : undefined } })
                }
                className="field-input w-20"
              />
              <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">files</span>
              <NumberInput
                min={0}
                step={1}
                value={local.context?.max_request_media_mb ?? 0}
                placeholder="20"
                onChange={(v) =>
                  save({ ...local, context: { ...local.context, max_request_media_mb: v > 0 ? v : undefined } })
                }
                className="field-input w-20"
              />
              <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">MB</span>
            </div>
          </Field>
          {(() => {
            const adfProviders: AdfProviderConfig[] = local.providers ?? []
            const compactionModel = local.context?.compaction_model ?? null
            const saveCompactionModel = (model: ModelConfig | undefined) =>
              save({ ...local, context: { ...local.context, compaction_model: model } })
            return (
              <Field label="Compaction Model" hint="The model that writes the summary when the loop is compacted. If it can't be reached, compaction fails and the history is kept.">
                <div className="flex gap-1.5 items-center">
                  <select
                    value={compactionModel?.provider ?? '__agent__'}
                    onChange={(e) => {
                      if (e.target.value === '__agent__') return saveCompactionModel(undefined)
                      const picked = e.target.value
                      const defaultModel = adfProviders.find((p) => p.id === picked)?.defaultModel ??
                        providers.find((p) => p.id === picked)?.defaultModel ?? ''
                      saveCompactionModel({ provider: picked, model_id: compactionModel?.model_id || defaultModel })
                    }}
                    className="field-input flex-1"
                  >
                    <option value="__agent__">Agent&apos;s model</option>
                    <ProviderOptions agentProviders={local.providers} appProviders={providers} />
                  </select>
                  {compactionModel && (
                    <ModelIdField
                      providerId={compactionModel.provider}
                      filePath={carriedFilePath(compactionModel.provider)}
                      value={compactionModel.model_id}
                      onChange={(modelId) => saveCompactionModel({ ...compactionModel, model_id: modelId })}
                      className="field-input w-full"
                    />
                  )}
                </div>
              </Field>
            )
          })()}
          <Field label="Max Tool Result" hint="Truncates tool results exceeding this token limit to protect the context window.">
            <div className="flex items-center gap-2">
              <NumberInput
                min={1000}
                step={1000}
                value={local.limits?.max_tool_result_tokens ?? 16000}
                onChange={(v) =>
                  save({
                    ...local,
                    limits: { ...local.limits, max_tool_result_tokens: v }
                  })
                }
                className="field-input w-32"
              />
              <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">
                {(local.limits?.max_tool_result_tokens ?? 16000).toLocaleString()} tokens
              </span>
            </div>
          </Field>
          <Field label="Tool Result Preview" hint="Characters shown when a tool result is truncated. Split evenly between the start and end.">
            <div className="flex items-center gap-2">
              <NumberInput
                min={500}
                step={500}
                value={local.limits?.max_tool_result_preview_chars ?? 5000}
                onChange={(v) =>
                  save({
                    ...local,
                    limits: { ...local.limits, max_tool_result_preview_chars: v }
                  })
                }
                className="field-input w-32"
              />
              <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">
                {(local.limits?.max_tool_result_preview_chars ?? 5000).toLocaleString()} chars
              </span>
            </div>
          </Field>
          <Field label="Max File Read" hint="Token limit for text file reads. Binary files always return metadata only.">
            <div className="flex items-center gap-2">
              <NumberInput
                min={1000}
                step={5000}
                value={local.limits?.max_file_read_tokens ?? 30000}
                onChange={(v) =>
                  save({
                    ...local,
                    limits: { ...local.limits, max_file_read_tokens: v }
                  })
                }
                className="field-input w-32"
              />
              <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">
                {(local.limits?.max_file_read_tokens ?? 30000).toLocaleString()} tokens
              </span>
            </div>
          </Field>
          <Field label="Max File Write" hint="Max file write size in bytes. Does not apply to README.md or mind.md.">
            <div className="flex items-center gap-2">
              <NumberInput
                min={1024}
                step={524288}
                value={local.limits?.max_file_write_bytes ?? 5000000}
                onChange={(v) =>
                  save({
                    ...local,
                    limits: { ...local.limits, max_file_write_bytes: v }
                  })
                }
                className="field-input w-32"
              />
              <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">
                {((local.limits?.max_file_write_bytes ?? 5000000) / 1024).toFixed(0)} KB
              </span>
            </div>
          </Field>
          <Field label="Max Image Size" hint="Max image size (bytes) for multimodal inlining. Larger images are skipped.">
            <div className="flex items-center gap-2">
              <NumberInput
                min={1024}
                step={1048576}
                value={local.limits?.max_image_size_bytes ?? 5242880}
                onChange={(v) =>
                  save({
                    ...local,
                    limits: { ...local.limits, max_image_size_bytes: v }
                  })
                }
                className="field-input w-32"
              />
              <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">
                {((local.limits?.max_image_size_bytes ?? 5242880) / 1048576).toFixed(1)} MB
              </span>
            </div>
          </Field>
          <Field label="Max Audio Size" hint="Max audio size (bytes) for multimodal inlining. Larger audio files are skipped.">
            <div className="flex items-center gap-2">
              <NumberInput
                min={1024}
                step={1048576}
                value={local.limits?.max_audio_size_bytes ?? 10485760}
                onChange={(v) =>
                  save({
                    ...local,
                    limits: { ...local.limits, max_audio_size_bytes: v }
                  })
                }
                className="field-input w-32"
              />
              <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">
                {((local.limits?.max_audio_size_bytes ?? 10485760) / 1048576).toFixed(1)} MB
              </span>
            </div>
          </Field>
          <Field label="Max Video Size" hint="Max video size (bytes) for multimodal inlining. Larger video files are skipped.">
            <div className="flex items-center gap-2">
              <NumberInput
                min={1024}
                step={1048576}
                value={local.limits?.max_video_size_bytes ?? 20971520}
                onChange={(v) =>
                  save({
                    ...local,
                    limits: { ...local.limits, max_video_size_bytes: v }
                  })
                }
                className="field-input w-32"
              />
              <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">
                {((local.limits?.max_video_size_bytes ?? 20971520) / 1048576).toFixed(1)} MB
              </span>
            </div>
          </Field>
          <Field label="Audit Control" hint="When enabled, data is compressed and saved to the audit log before clearing or deleting. 'Loops' covers compacted history from every loop, archived per loop as loop:<name> (main included).">
            <div className="space-y-1">
              {(['loop', 'inbox', 'outbox', 'files'] as const).map((key) => (
                <label key={key} className="flex items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    checked={local.context?.audit?.[key] ?? false}
                    onChange={(e) => {
                      const current = local.context?.audit ?? { loop: false, inbox: false, outbox: false, files: false }
                      save({
                        ...local,
                        context: {
                          ...local.context,
                          audit: { ...current, [key]: e.target.checked }
                        }
                      })
                    }}
                    className="rounded"
                  />
                  <span className="capitalize">{key === 'loop' ? 'Loops' : key}</span>
                </label>
              ))}
            </div>
          </Field>
        </Section>

        {/* Tools */}
        <Section docs={DOCS.tools} title="Tools" locked={isSectionLocked('tools')} onToggleLock={() => toggleSectionLock('tools')} summary={`${local.tools.filter(t => t.enabled).length}/${local.tools.length} enabled`}>
          <PermissionLegend kinds={['approval', 'locked', 'visible']} />
          <input
            type="search"
            value={toolFilter}
            onChange={(e) => setToolFilter(e.target.value)}
            placeholder="Filter"
            aria-label="Filter tools"
            className="field-input mb-1 text-xs"
          />
          <div className="space-y-1.5">
            {(() => {
              const shownGroups = TOOL_GROUPS
                .map((group) => ({ group, tools: local.tools.filter((t) => group.tools.has(t.name) && toolMatchesFilter(t.name, group.label, toolFilter)) }))
                .filter(({ tools }) => tools.length > 0)
              if (shownGroups.length === 0) {
                return <p className="text-[10px] text-[var(--adf-ui-text-subtle)]">No matches</p>
              }
              return shownGroups.map(({ group, tools: groupTools }, gi) => {
              // Bulk toggles act on the rows shown (the filter narrows them).
              const shown = new Set(groupTools.map((t) => t.name))

              // Rows set from another section show their stored values, are
              // not editable here, and say why on a warning icon.
              const isTurn = group.label === 'Turn'
              const gateOf = (name: string) => toolRowGate(name, group.label, local)
              const jumpTo = (section: string) => (template ? undefined : () => useAppStore.getState().setPendingConfigSection(section))

              // Section-level tristate computation (excluding locked and gated tools)
              const eligibleTools = groupTools.filter(t => !(t.locked ?? false) && !gateOf(t.name))
              const eligibleEnabled = eligibleTools.filter(t => t.enabled)
              const enabledState = computeTriState(eligibleTools, t => t.enabled)
              const visibleState = computeTriState(eligibleEnabled, t => !!t.visible)
              const restrictedState = computeTriState(eligibleTools, t => !!t.restricted)
              const sectionDisabled = eligibleTools.length === 0
              const visibleSectionDisabled = sectionDisabled || eligibleEnabled.length === 0
              const showSectionRestricted = !isTurn

              const onToggleSectionEnabled = () => {
                if (sectionDisabled) return
                const target = enabledState !== 'all'
                const tools = local.tools.map(t => {
                  if (!shown.has(t.name)) return t
                  if (t.locked || gateOf(t.name)) return t
                  return { ...t, enabled: target, visible: target ? true : t.visible }
                })
                saveBulkTools(tools)
              }
              const onToggleSectionVisible = () => {
                if (visibleSectionDisabled) return
                const target = visibleState !== 'all'
                const tools = local.tools.map(t => {
                  if (!shown.has(t.name)) return t
                  if (t.locked || gateOf(t.name)) return t
                  if (!t.enabled) return t
                  return { ...t, visible: target }
                })
                saveBulkTools(tools)
              }
              const onToggleSectionRestricted = () => {
                if (sectionDisabled) return
                const target = restrictedState !== 'all'
                const tools = local.tools.map(t => {
                  if (!shown.has(t.name)) return t
                  if (t.locked || gateOf(t.name)) return t
                  return { ...t, restricted: target || undefined }
                })
                saveBulkTools(tools)
              }

              return (
                <div key={group.label}>
                  {gi > 0 && <div className="border-t border-neutral-200 dark:border-neutral-700 my-1" />}
                  <div className="flex items-center justify-between mb-0.5">
                    <p className="text-[10px] text-[var(--adf-ui-text-subtle)]">
                      {group.label}
                      {group.note && <span className="ml-1 italic">({group.note})</span>}
                    </p>
                    <span className={`flex items-center gap-3 shrink-0 ${sectionDisabled ? 'cursor-not-allowed' : ''}`}>
                      {showSectionRestricted ? (
                        <button
                          type="button"
                          disabled={sectionDisabled}
                          title={`${PERMISSION_TIPS.approval} Toggles every tool in this group.`}
                          aria-label="Needs approval for all tools in this group"
                          onClick={onToggleSectionRestricted}
                          className={`flex items-center justify-center rounded transition-colors ${
                            sectionDisabled
                              ? 'cursor-not-allowed text-neutral-300 dark:text-neutral-700'
                              : restrictedState === 'all'
                                ? PERMISSION_ON_CLASS.approval
                                : restrictedState === 'mixed'
                                  ? `${PERMISSION_ON_CLASS.approval} opacity-50`
                                  : 'text-[var(--adf-ui-icon-muted)] hover:text-[var(--adf-ui-text-subtle)]'
                          }`}
                        >
                          <ApprovalIcon filled={restrictedState !== 'none'} />
                        </button>
                      ) : (
                        <span className="w-[14px]" />
                      )}
                      <button
                        type="button"
                        disabled={visibleSectionDisabled}
                        title="Toggle visibility for all enabled tools in this group"
                        onClick={onToggleSectionVisible}
                        className={`flex h-4 w-4 items-center justify-center rounded transition-colors ${
                          visibleSectionDisabled
                            ? 'cursor-not-allowed text-neutral-300 dark:text-neutral-700'
                            : visibleState === 'all'
                              ? 'text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300'
                              : visibleState === 'mixed'
                                ? 'text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300 opacity-50'
                                : 'text-[var(--adf-ui-icon-muted)] hover:text-[var(--adf-ui-text-subtle)]'
                        }`}
                      >
                        <EyeIcon size={15} off={visibleState === 'none'} />
                      </button>
                      <input
                        type="checkbox"
                        title="Toggle enabled for all tools in this group"
                        ref={el => { if (el) el.indeterminate = eligibleTools.length > 0 && enabledState === 'mixed' }}
                        checked={eligibleTools.length > 0 && enabledState === 'all'}
                        disabled={sectionDisabled}
                        onChange={onToggleSectionEnabled}
                      />
                    </span>
                  </div>
                  {groupTools.map((tool) => {
                    const i = local.tools.findIndex((t) => t.name === tool.name)
                    const showRestricted = !isTurn
                    const isRestricted = tool.restricted ?? false
                    const isLocked = tool.locked ?? false
                    const gate = gateOf(tool.name)
                    const groupDisabled = gate !== null
                    const warning = gate
                      ? <RowWarning tip={gate.tip} onJump={jumpTo(gate.section)} />
                      : tool.name === 'ask' && tool.enabled && local.autonomous
                        ? <RowWarning tip={ASK_AUTONOMOUS_TIP} />
                        : null

                    return (
                      <div key={tool.name}>
                        <div
                          className={`group flex items-center justify-between text-xs px-1.5 py-0.5 -mx-1.5 rounded ${isLocked ? 'bg-amber-50/60 dark:bg-amber-900/10 border-l-2 border-amber-400 dark:border-amber-600' : isRestricted ? 'bg-violet-50/60 dark:bg-violet-900/10 border-l-2 border-violet-400 dark:border-violet-600' : 'hover:bg-neutral-200/60 dark:hover:bg-neutral-700/50'} ${groupDisabled ? 'cursor-not-allowed' : ''}`}
                        >
                          <span className="flex min-w-0 items-center gap-1">
                            <span
                              className={`font-mono cursor-pointer hover:underline truncate ${groupDisabled ? 'text-[var(--adf-ui-text-subtle)] hover:text-blue-400' : 'text-neutral-700 dark:text-neutral-300 hover:text-blue-500 dark:hover:text-blue-400'}`}
                              onClick={() => setViewingTool(tool.name)}
                            >
                              {tool.name}
                            </span>
                            {warning}
                          </span>
                          <span className="flex items-center gap-3 shrink-0">
                            {/* Per-tool lock: visible when locked or on row hover */}
                            <button
                              type="button"
                              disabled={groupDisabled}
                              aria-pressed={isLocked}
                              aria-label={isLocked ? 'Locked' : 'Lock'}
                              className={`transition-colors ${isLocked ? PERMISSION_ON_CLASS.locked : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-[var(--adf-ui-icon-muted)] hover:!text-[var(--adf-ui-text-subtle)]'}`}
                              title={`${PERMISSION_TIPS.locked} Click to ${isLocked ? 'unlock' : 'lock'}.`}
                              onClick={() => {
                                const tools = [...local.tools]
                                tools[i] = { ...tools[i], locked: !isLocked || undefined }
                                save({ ...local, tools })
                              }}
                            >
                              <LockIcon size={12} open={!isLocked} />
                            </button>
                            {showRestricted ? (
                              <button
                                type="button"
                                disabled={groupDisabled}
                                aria-pressed={isRestricted}
                                aria-label="Needs approval"
                                className={`flex items-center justify-center rounded transition-colors disabled:cursor-not-allowed ${isRestricted ? PERMISSION_ON_CLASS.approval : 'text-[var(--adf-ui-icon-muted)] hover:text-[var(--adf-ui-text-subtle)]'}`}
                                title={PERMISSION_TIPS.approval}
                                onClick={() => {
                                  const tools = [...local.tools]
                                  tools[i] = { ...tools[i], restricted: !isRestricted || undefined }
                                  save({ ...local, tools })
                                }}
                              >
                                <ApprovalIcon filled={isRestricted} />
                              </button>
                            ) : (
                              <span className="w-[14px]" />
                            )}
                            <ToolVisibilityToggle
                              visible={tool.enabled && tool.visible}
                              disabled={!tool.enabled || groupDisabled}
                              onToggle={() => {
                                const tools = [...local.tools]
                                tools[i] = { ...tools[i], visible: !tool.visible }
                                save({ ...local, tools })
                              }}
                            />
                            <input
                              type="checkbox"
                              title="Enabled: allowed to be used by the runtime and lambdas."
                              checked={tool.enabled}
                              disabled={groupDisabled}
                              onChange={(e) => {
                                const enabled = e.target.checked
                                const tools = [...local.tools]
                                tools[i] = { ...tools[i], enabled, visible: enabled ? true : tools[i].visible }
                                save({ ...local, tools })
                              }}
                            />
                          </span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )
              })
            })()}
          </div>
        </Section>

        {/* Loops — `main` is implicit and uneditable; side loops are attenuated
            children that run concurrently against the same .adf body. */}
        <Section
          title="Loops"
          locked={isSectionLocked('loops')}
          onToggleLock={() => toggleSectionLock('loops')}
          summary={`main + ${(local.loops ?? []).length} inner`}
        >
          {(() => {
            const loops = local.loops ?? []
            const saveLoops = (next: LoopConfig[]) =>
              save({ ...local, loops: next.length > 0 ? next : undefined })
            const patchLoop = (i: number, patch: Partial<LoopConfig>) => {
              const next = [...loops]
              next[i] = { ...next[i], ...patch }
              saveLoops(next)
            }
            // A loop's allow-list is intersected with the host's enabled tools at
            // derive time, so only offer what the host actually has. Restricted
            // tools are excluded — HIL approval can't be routed to a side-loop
            // executor (MVP) — as are the never-grantable names.
            const grantableTools = local.tools
              .filter((t) => t.enabled && !t.restricted && !(LOOP_PROHIBITED_TOOLS as readonly string[]).includes(t.name))
              .map((t) => t.name)
              .sort((a, b) => a.localeCompare(b))
            const adfProviders: AdfProviderConfig[] = local.providers ?? []
            const takenNames = new Set(['main', ...loops.map((l) => l.name)])

            return (
              <>
                <p className="text-[10px] text-[var(--adf-ui-text-subtle)] mb-2">
                  Inner loops share this agent&apos;s body and identity but run their own stream,
                  model and tool allow-list. Each enabled loop gets its own tab in the loop panel.
                </p>

                {/* Row 0 — the implicit host loop. Never editable, never deletable. */}
                <div className="mb-2 p-2 rounded border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/50">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono text-neutral-600 dark:text-neutral-300">main</span>
                    <span className="px-1.5 py-0.5 text-[10px] rounded bg-neutral-200 dark:bg-neutral-700 text-neutral-500 dark:text-neutral-400">
                      host loop
                    </span>
                    <span className="ml-auto text-[10px] text-[var(--adf-ui-text-subtle)]">
                      uses the sections above
                    </span>
                  </div>
                </div>

                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs text-neutral-500 dark:text-neutral-400">Inner loops</label>
                  <button
                    onClick={() => {
                      let name = 'loop-1'
                      for (let n = 1; takenNames.has(name); n++) name = `loop-${n + 1}`
                      // Pre-ticked, not implicit: a new loop starts able to
                      // talk back to main, and un-ticking these is how you make
                      // a mute loop. Filtered by what the host can grant, so
                      // the seed never names a tool the derive would drop.
                      const seeded = DEFAULT_NEW_LOOP_TOOLS.filter((t) => grantableTools.includes(t))
                      // The appended loop takes the next index — mark it so its
                      // card opens expanded for immediate editing.
                      setNewLoopIndex(loops.length)
                      loopKeys.append()
                      saveLoops([...loops, { name, goal: '', enabled: true, autostart: true, ...(seeded.length > 0 && { tools: seeded }) }])
                    }}
                    className="text-[11px] text-blue-500 hover:text-blue-700 font-medium"
                  >
                    + Add loop
                  </button>
                </div>

                {loops.length === 0 && (
                  <p className="text-[10px] text-[var(--adf-ui-text-subtle)]">
                    No inner loops. The agent runs a single <span className="font-mono">main</span> stream.
                  </p>
                )}

                {loops.map((entry, i) => (
                  <LoopCard
                    key={loopKeys.keys[i]}
                    entry={entry}
                    duplicate={loops.some((other, j) => j !== i && other.name === entry.name)}
                    grantableTools={grantableTools}
                    agentProviders={local.providers}
                    appProviders={providers}
                    modelFilePath={carriedFilePath}
                    defaultModelFor={(picked) =>
                      adfProviders.find((p) => p.id === picked)?.defaultModel ??
                      providers.find((p) => p.id === picked)?.defaultModel ?? ''
                    }
                    patchLoop={(patch) => patchLoop(i, patch)}
                    onRemove={() => {
                      if (!window.confirm(`Remove loop "${loops[i].name || 'unnamed'}"?`)) return
                      loopKeys.removeAt(i); saveLoops(loops.filter((_, j) => j !== i))
                    }}
                    defaultExpanded={i === newLoopIndex}
                  />
                ))}
              </>
            )
          })()}
        </Section>

        {/* Code Execution */}
        <Section docs={DOCS.codeExecution} hint="Methods available to lambdas and sys_code via the adf proxy object." title="Code Execution" locked={isSectionLocked('code_execution')} onToggleLock={() => toggleSectionLock('code_execution')}>
          <PermissionLegend kinds={['restricted']} />
          <div className="space-y-0.5">
            {(Object.keys(CODE_EXECUTION_DEFAULTS) as (keyof CodeExecutionConfig)[])
              .filter((k) => k !== 'network' && k !== 'packages' && k !== 'restricted_methods')
              .map((method) => {
              const ce = { ...CODE_EXECUTION_DEFAULTS, ...local.code_execution }
              const enabled = ce[method]
              // Mirror the runtime fallback: no explicit list means the defaults apply.
              const restrictedMethods = local.code_execution?.restricted_methods ?? CODE_EXECUTION_DEFAULTS.restricted_methods ?? []
              const isRestricted = restrictedMethods.includes(method)
              return (
                <div
                  key={method}
                  className={`flex items-center justify-between text-xs px-1.5 py-0.5 -mx-1.5 rounded ${isRestricted ? 'bg-teal-50/60 dark:bg-teal-900/10 border-l-2 border-teal-400 dark:border-teal-600' : 'hover:bg-neutral-200/60 dark:hover:bg-neutral-700/50'}`}
                >
                  <span
                    className="font-mono cursor-pointer hover:underline text-neutral-700 dark:text-neutral-300 hover:text-blue-500 dark:hover:text-blue-400"
                    onClick={() => setViewingTool(method)}
                  >
                    {method}
                  </span>
                  <span className="flex items-center gap-3 shrink-0">
                    <button
                      type="button"
                      aria-pressed={isRestricted}
                      aria-label="Restricted"
                      className={`flex items-center justify-center rounded transition-colors ${isRestricted ? PERMISSION_ON_CLASS.restricted : 'text-[var(--adf-ui-icon-muted)] hover:text-[var(--adf-ui-text-subtle)]'}`}
                      title={PERMISSION_TIPS.restricted}
                      onClick={() => {
                        const updated = isRestricted
                          ? restrictedMethods.filter(m => m !== method)
                          : [...restrictedMethods, method]
                        // Always persist the array — undefined would fall back to the
                        // defaults at runtime, silently re-restricting attestation_issue.
                        save({
                          ...local,
                          code_execution: { ...ce, restricted_methods: updated }
                        })
                      }}
                    >
                      <ShieldIcon filled={isRestricted} />
                    </button>
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={(e) => {
                        save({
                          ...local,
                          code_execution: { ...ce, [method]: e.target.checked }
                        })
                      }}
                    />
                  </span>
                </div>
              )
            })}
            {/* chat_info is gated as a hidden tool entry in config.tools (not a
                code_execution key), but it's a sandbox capability callable as
                adf.chat_info — so it's surfaced here alongside the other methods. */}
            {(() => {
              const idx = local.tools.findIndex((t) => t.name === 'chat_info')
              const entry = idx >= 0 ? local.tools[idx] : undefined
              const enabled = entry?.enabled ?? false
              const isRestricted = entry?.restricted === true
              const updateChatInfo = (patch: Partial<ToolDeclaration>) => {
                const tools = [...local.tools]
                if (idx >= 0) {
                  tools[idx] = { ...tools[idx], ...patch }
                } else {
                  tools.push({ name: 'chat_info', enabled: false, visible: false, ...patch })
                }
                save({ ...local, tools })
              }
              return (
                <div>
                  <div
                    className={`flex items-center justify-between text-xs px-1.5 py-0.5 -mx-1.5 rounded ${isRestricted ? 'bg-teal-50/60 dark:bg-teal-900/10 border-l-2 border-teal-400 dark:border-teal-600' : 'hover:bg-neutral-200/60 dark:hover:bg-neutral-700/50'}`}
                  >
                    <span
                      className="font-mono cursor-pointer hover:underline text-neutral-700 dark:text-neutral-300 hover:text-blue-500 dark:hover:text-blue-400"
                      onClick={() => setViewingTool('chat_info')}
                    >
                      chat_info
                    </span>
                    <InfoHint tip="Chat lookup via channel adapters — auto-enabled at mesh registration, hidden from the LLM schema, callable as adf.chat_info" />
                    <span className="flex items-center gap-3 shrink-0">
                      <button
                        type="button"
                      aria-pressed={isRestricted}
                      aria-label="Restricted"
                      className={`flex items-center justify-center rounded transition-colors ${isRestricted ? PERMISSION_ON_CLASS.restricted : 'text-[var(--adf-ui-icon-muted)] hover:text-[var(--adf-ui-text-subtle)]'}`}
                        title={PERMISSION_TIPS.restricted}
                        onClick={() => updateChatInfo({ restricted: !isRestricted || undefined })}
                      >
                        <ShieldIcon filled={isRestricted} />
                      </button>
                      <input
                        type="checkbox"
                        checked={enabled}
                        onChange={(e) => updateChatInfo({ enabled: e.target.checked })}
                      />
                    </span>
                  </div>
                </div>
              )
            })()}
          </div>
          <div className="border-t border-neutral-200 dark:border-neutral-700" />
          <p className="text-[10px] text-[var(--adf-ui-text-subtle)] mb-1">
            Sandbox permissions
          </p>
          <div className="space-y-0.5">
            <div className="flex items-center justify-between text-xs px-1.5 py-0.5 -mx-1.5 rounded hover:bg-neutral-200/60 dark:hover:bg-neutral-700/50">
              <div>
                <span className="font-mono text-neutral-700 dark:text-neutral-300">network</span>
                <p className="text-[10px] text-[var(--adf-ui-text-subtle)]">
                  Allow fetch/http/https in code execution
                </p>
              </div>
              <input
                type="checkbox"
                checked={local.code_execution?.network ?? CODE_EXECUTION_DEFAULTS.network ?? false}
                onChange={(e) => {
                  const ce = { ...CODE_EXECUTION_DEFAULTS, ...local.code_execution }
                  save({
                    ...local,
                    code_execution: { ...ce, network: e.target.checked }
                  })
                }}
              />
            </div>
          </div>
          <div className="border-t border-neutral-200 dark:border-neutral-700" />
          <Field label="Execution timeout (seconds)" hint="Max time for sys_code and sys_lambda. Minimum 1 second.">
            <div className="flex items-center gap-2">
              <NumberInput
                min={1}
                step={1}
                value={Math.round((local.limits?.execution_timeout_ms ?? 60000) / 1000)}
                onChange={(v) =>
                  save({
                    ...local,
                    limits: { ...local.limits, execution_timeout_ms: v * 1000 }
                  })
                }
              />
              <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">
                {Math.round((local.limits?.execution_timeout_ms ?? 60000) / 1000)}s
              </span>
            </div>
          </Field>
          {/* Installed packages */}
          {(local.code_execution?.packages?.length ?? 0) > 0 && (
            <>
              <div className="border-t border-neutral-200 dark:border-neutral-700" />
              <div>
                <p className="text-[10px] text-[var(--adf-ui-text-subtle)] mb-1">
                  Installed packages ({local.code_execution!.packages!.length})
                </p>
                <div className="space-y-0.5">
                  {local.code_execution!.packages!.map((pkg) => (
                    <div
                      key={pkg.name}
                      className="flex items-center justify-between text-xs px-1.5 py-0.5 -mx-1.5 rounded hover:bg-neutral-200/60 dark:hover:bg-neutral-700/50"
                    >
                      <span className="font-mono text-neutral-700 dark:text-neutral-300">
                        {pkg.name}<span className="text-[var(--adf-ui-text-subtle)]">@{pkg.version}</span>
                      </span>
                      <button
                        onClick={() => {
                          if (!window.confirm(`Remove ${pkg.name} from this agent's packages?`)) return
                          const updated = local.code_execution!.packages!.filter((p) => p.name !== pkg.name)
                          save({
                            ...local,
                            code_execution: { ...local.code_execution!, packages: updated }
                          })
                        }}
                        className="text-[10px] text-red-400 hover:text-red-600 px-1"
                        title="Remove package"
                      >
                        &times;
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </Section>

        {/* Compute */}
        <Section docs={DOCS.compute} title="Compute" locked={isSectionLocked('compute')} onToggleLock={() => toggleSectionLock('compute')}>
          <div className="space-y-3">
            {(() => {
              const externalOptions = resolveExecutionTargetAliases(executionTargets)
              const legacyAllowed = local.compute?.target
                ? [local.compute.target]
                : [
                    ...(local.compute?.enabled ? ['isolated'] : []),
                    'shared',
                    ...(local.compute?.host_access ? ['host'] : []),
                  ]
              const allowed = local.compute?.allowed_targets ?? legacyAllowed
              const defaultTarget = local.compute?.default_target
                ?? local.compute?.target
                ?? (local.compute?.enabled ? 'isolated' : 'shared')
              const managedOptions = [
                { id: 'shared', label: 'Shared Podman container', detail: 'ADF-managed MCP runtime' },
                { id: 'isolated', label: 'Dedicated Podman container', detail: 'ADF-managed private environment' },
              ]
              const advancedOptions = [
                ...externalOptions.map(({ target, alias }) => ({
                  id: target.id,
                  label: target.name,
                  detail: `${alias} · user-managed ${target.engine} · ${target.containerRef}`,
                })),
                { id: 'host', label: 'Local host', detail: 'Direct access to this machine' },
              ]
              const options = [...managedOptions, ...advancedOptions]
              const optionById = new Map(options.map((option) => [option.id, option]))
              const missing = allowed.filter((id) => !optionById.has(id))

              const updateAllowed = (nextAllowed: string[]) => {
                if (nextAllowed.length === 0) return
                const nextDefault = nextAllowed.includes(defaultTarget) ? defaultTarget : nextAllowed[0]
                const { target: _legacyTarget, ...current } = local.compute ?? { enabled: false }
                save({
                  ...local,
                  compute: {
                    ...current,
                    enabled: nextAllowed.includes('isolated'),
                    host_access: nextAllowed.includes('host'),
                    allowed_targets: nextAllowed,
                    default_target: nextDefault,
                  },
                })
              }

              const renderOption = (option: typeof options[number]) => {
                const checked = allowed.includes(option.id)
                return (
                  <label key={option.id} className="flex items-start gap-2 rounded px-1 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={checked && allowed.length === 1}
                      onChange={(event) => updateAllowed(event.target.checked
                        ? [...allowed, option.id]
                        : allowed.filter((id) => id !== option.id))}
                      className="mt-0.5 rounded text-blue-500"
                    />
                    <span className="min-w-0">
                      <span className="block text-xs text-neutral-700 dark:text-neutral-300">{option.label}</span>
                      <span className="block truncate font-mono text-[9px] text-[var(--adf-ui-text-subtle)]">{option.detail}</span>
                    </span>
                  </label>
                )
              }

              return <>
                <div>
                  <div className="mb-1.5 flex items-center gap-2">
                    <span className="text-[10px] font-medium text-neutral-600 dark:text-neutral-400">Managed Podman environments</span>
                    <span className="rounded bg-green-50 px-1 py-0.5 text-[8px] font-medium uppercase tracking-wide text-green-700 dark:bg-green-950/40 dark:text-green-400">Recommended</span>
                  </div>
                  <div className="space-y-1 rounded-md border border-neutral-200 p-2 dark:border-neutral-700">
                    {managedOptions.map(renderOption)}
                  </div>
                  <p className="mt-1 text-[9px] text-[var(--adf-ui-text-subtle)]">ADF manages lifecycle, assignment, workspaces, packages, and rebuilds.</p>
                </div>

                <details className="rounded-md border border-neutral-200 dark:border-neutral-700">
                  <summary className="flex cursor-pointer list-none items-center justify-between px-2 py-2 text-[10px] font-medium text-neutral-600 dark:text-neutral-400 [&::-webkit-details-marker]:hidden">
                    <span>Advanced · External containers and host</span>
                    <span className="font-normal text-[var(--adf-ui-text-subtle)]">{advancedOptions.filter((option) => allowed.includes(option.id)).length} enabled</span>
                  </summary>
                  <div className="space-y-1 border-t border-neutral-200 p-2 dark:border-neutral-700">
                    {advancedOptions.map(renderOption)}
                    {externalOptions.length === 0 && <p className="px-1 py-1 text-[9px] text-[var(--adf-ui-text-subtle)]">External containers can be registered in Settings &gt; Compute.</p>}
                    <p className="px-1 pt-1 text-[9px] text-[var(--adf-ui-text-subtle)]">External containers remain user-managed. Host access bypasses container isolation.</p>
                  </div>
                </details>

                <label className="block">
                  <span className="mb-1 block text-[10px] font-medium text-neutral-600 dark:text-neutral-400">Default environment<InfoHint tip="compute_exec uses the default when no target is specified. With multiple environments, the agent may select only from this allowlist." /></span>
                  <select
                    value={defaultTarget}
                    onChange={(event) => {
                      const { target: _legacyTarget, ...current } = local.compute ?? { enabled: false }
                      save({ ...local, compute: { ...current, allowed_targets: allowed, default_target: event.target.value } })
                    }}
                    className="field-input text-xs"
                  >
                    {allowed.map((id) => <option key={id} value={id}>{optionById.get(id)?.label ?? 'Unavailable target'}</option>)}
                  </select>
                </label>

                <p className="text-[10px] text-amber-600 dark:text-amber-400">
                  Restart a running agent after changing this configuration so its tool schema is rebuilt.
                </p>
                {allowed.includes('host') && !runtimeHostEnabled && (
                  <p className="text-[10px] text-amber-600 dark:text-amber-400">
                    Host access must also be enabled in Settings &gt; Compute before it becomes available.
                  </p>
                )}
                {missing.length > 0 && (
                  <p className="text-[10px] text-red-500">One or more allowed targets were removed from Settings. Choose an available default.</p>
                )}
              </>
            })()}

            {/* Per-server Runs on: the agent's choice AND the runtime's approval (mcp-host-placement.ts).
                Clicking a location changes only this agent's config; Allow is the one way to the runtime's. */}
            {(local.mcp?.servers ?? []).length > 0 && (() => {
              const runtimeApproval: RuntimeHostApproval = { hostAccessEnabled: runtimeHostEnabled, hostApproved: runtimeHostApproved, hostApprovedSources: runtimeHostApprovedSources }
              const choices: McpLocation[] = [...(local.compute?.enabled ? ['Isolated' as const] : []), 'Shared', 'Host']
              const allowHost = async (server: NonNullable<typeof local.mcp>['servers'][number]) => {
                const needsServer = !local.compute?.host_access
                const confirmed = await confirmHost({
                  ...HOST_ACCESS_CONFIRM,
                  body: needsServer ? `${HOST_ACCESS_CONFIRM.body} ${server.name} is approved to run on the host for agents without host access.` : HOST_ACCESS_CONFIRM.body,
                })
                if (!confirmed) return
                const patch = allowHostPatch(server.name, serverSourceIdentity(server), needsServer, runtimeApproval)
                const outcome = await writeSettings({ compute: patch })
                if (!outcome.ok) { setHostAllowError(`Not saved: ${outcome.error}`); return }
                setHostAllowError(null)
                setRuntimeHostEnabled(true)
                if (patch.hostApproved) setRuntimeHostApproved(patch.hostApproved)
                if (patch.hostApprovedSources) setRuntimeHostApprovedSources(patch.hostApprovedSources)
              }

              return (
                <div className="mt-2">
                  <h4 className="text-[11px] font-medium text-neutral-600 dark:text-neutral-400 mb-1">MCP servers run on</h4>
                  <p className="text-[11px] text-[var(--adf-ui-text-subtle)] mb-1">
                    Click a location to change this agent&apos;s choice. Restart the agent to apply.
                  </p>
                  <div className="space-y-1">
                    {(local.mcp?.servers ?? []).map((s) => {
                      const placement = agentServerPlacement(s, local, runtimeApproval)
                      const location = placement.runsOn
                      const colorClass = location === 'Host'
                        ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400'
                        : location === 'Isolated'
                          ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400'
                          : 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400'
                      return (
                        <div key={s.name} className="flex items-center justify-between gap-2 py-1 px-2 rounded bg-neutral-100 dark:bg-neutral-900/50">
                          <span className="text-xs text-neutral-700 dark:text-neutral-300 font-mono">{s.name}</span>
                          <span className="flex items-center gap-1.5">
                            {placement.gap && (
                              <button
                                type="button"
                                className="rounded px-2 py-0.5 text-[11px] font-medium text-amber-700 hover:bg-amber-100 dark:text-amber-400 dark:hover:bg-amber-900/30"
                                onClick={() => void allowHost(s)}
                                title={allowHostTip(placement.gap)}
                              >Allow</button>
                            )}
                            <button
                              type="button"
                              className={`text-[11px] px-2 py-0.5 rounded cursor-pointer hover:opacity-80 ${colorClass}`}
                              onClick={() => {
                                // The agent's own choice, nothing else: the runtime's approval is never edited from here.
                                const next = choices[(choices.indexOf(placement.choice) + 1) % choices.length]
                                const runLocation: 'host' | 'shared' | undefined = next === 'Host' ? 'host' : next === 'Shared' ? 'shared' : undefined
                                const servers = [...(local.mcp?.servers ?? [])]
                                const idx = servers.findIndex((srv) => srv.name === s.name)
                                if (idx < 0) return
                                const { host_requested: _, ...rest } = servers[idx]
                                servers[idx] = { ...rest, run_location: runLocation }
                                save({ ...local, mcp: { ...local.mcp!, servers } })
                              }}
                              title={placement.choice === location
                                ? `Runs on ${location.toLowerCase()}. Click to change.`
                                : `Chosen: ${placement.choice.toLowerCase()}. Runs on ${location.toLowerCase()} until the host is allowed. Click to change.`}
                            >{location}</button>
                          </span>
                        </div>
                      )
                    })}
                  </div>
                  {hostAllowError && <p role="alert" className="mt-1 text-[11px] text-red-500">{hostAllowError}</p>}
                </div>
              )
            })()}

            {local.compute?.enabled && (
              <>

                {/* Packages */}
                <div className="mt-2">
                  <h4 className="text-[10px] font-medium text-neutral-600 dark:text-neutral-400 mb-1">Container Python packages</h4>
                  <div className="text-xs text-neutral-600 dark:text-neutral-400 font-mono">
                    {(local.compute?.packages?.pip ?? []).length > 0
                      ? (local.compute!.packages!.pip!).join(', ')
                      : <span className="italic text-[var(--adf-ui-text-subtle)]">none</span>}
                  </div>
                  <p className="mt-1 text-[10px] text-[var(--adf-ui-text-subtle)]">JavaScript packages are configured separately under Code execution.</p>
                </div>

                {/* Container desktop (Computer tab) */}
                <div className="mt-2">
                  <label className="flex items-center justify-between text-xs px-1.5 py-0.5 -mx-1.5 rounded hover:bg-neutral-200/60 dark:hover:bg-neutral-700/50 cursor-pointer">
                    <span>
                      <span className="text-neutral-700 dark:text-neutral-300">Visible desktop<InfoHint tip="Linux desktop (panel, file manager, terminal, managed browser) in the container plus an auto-opening Computer tab. Disable to run automation headless-only. Restart the agent to apply." /></span>
                    </span>
                    <input
                      type="checkbox"
                      checked={local.compute?.browser !== false}
                      onChange={(e) => save({ ...local, compute: { ...local.compute!, browser: e.target.checked } })}
                    />
                  </label>
                  {!template && local.compute?.browser !== false && (
                    <button
                      className="mt-1 text-xs px-2 py-1 rounded bg-neutral-200 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-300 dark:hover:bg-neutral-600"
                      onClick={async () => {
                        const info = await openApi()?.getBrowserSessionInfo({ agentName: local.name, agentId: local.id })
                        const docPath = useDocumentStore.getState().filePath
                        if (info && docPath) {
                          useEditorTabsStore.getState().openBrowserTab({
                            agentFilePath: docPath,
                            containerName: info.containerName,
                            agentId: local.id,
                            agentName: local.name,
                            hostPort: info.hostPort,
                            phase: info.phase,
                            detail: info.detail,
                          })
                        }
                      }}
                      title="Open a live view of this agent's container desktop (opens automatically when the agent launches a browser)"
                    >
                      Open computer view
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </Section>

        {/* MCP Servers */}
        {(() => {
          const validRegistrations = mcpRegistrations.filter((r) => r.name)
          const registeredNames = new Set(validRegistrations.map((r) => r.name))
          const attachedNames = new Set((local.mcp?.servers ?? []).map((s) => s.name))
          const myServers = local.mcp?.servers ?? []
          // Unattached registry servers available to add
          const availableToAdd = validRegistrations.filter((r) => !attachedNames.has(r.name))
          // Servers attached to this agent but missing from the app-level runtime
          const orphanedServers = myServers.filter((s) => !registeredNames.has(s.name))
          const hasAnything = myServers.length > 0 || availableToAdd.length > 0

          if (!hasAnything) return null

          // Seed a new app-level registration from the agent's server config so
          // the user can fill in shared credentials in Settings.
          const handleAddToRuntime = async (srv: typeof myServers[0]) => {
            const appKeys: string[] = []
            const schema = srv.env_schema ?? []
            for (const entry of schema) {
              if (entry.scope === 'app' && entry.key) appKeys.push(entry.key)
            }
            // Legacy fallback: if no schema, we don't know scope — seed env_keys
            // as empty app entries so the user can decide in Settings.
            if (!schema.length && srv.env_keys?.length) {
              for (const k of srv.env_keys) appKeys.push(k)
            }

            const regType: 'npm' | 'uvx' | 'custom' | 'http' = srv.transport === 'http'
              ? 'http'
              : srv.npm_package
              ? 'npm'
              : srv.pypi_package ? 'uvx' : 'custom'

            const reg: McpServerRegistration = {
              id: 'mcp:' + Math.random().toString(36).slice(2, 8),
              name: srv.name,
              type: regType,
              ...(srv.npm_package ? { npmPackage: srv.npm_package } : {}),
              ...(srv.pypi_package ? { pypiPackage: srv.pypi_package } : {}),
              ...(srv.command ? { command: srv.command } : {}),
              ...(srv.args?.length ? { args: [...srv.args] } : {}),
              ...(srv.url ? { url: srv.url } : {}),
              ...(srv.headers ? { headers: Object.entries(srv.headers).map(([key, value]) => ({ key, value })) } : {}),
              ...(srv.header_env?.length ? { headerEnv: srv.header_env.map((entry) => ({ key: entry.header, value: entry.env })) } : {}),
              ...(srv.bearer_token_env_var ? { bearerTokenEnvVar: srv.bearer_token_env_var } : {}),
              env: appKeys.map((k) => ({ key: k, value: '' })),
            }

            const currentSettings = await openApi()?.getSettings()
            const existingServers = (currentSettings?.mcpServers as McpServerRegistration[]) ?? []
            if (existingServers.some((r) => r.name === srv.name)) return
            await openApi()?.setSettings({
              mcpServers: [...existingServers, reg],
            })
            invalidateConfigCaches()
            const registrations = [...existingServers, reg]
            cachesOf(useDocumentStore.getState().runtimeId).mcpRegistrations = registrations
            setMcpRegistrations(registrations)
          }

          // Remove a server and its tools
          const handleRemoveServer = (serverName: string) => {
            if (!window.confirm(`Remove "${serverName}"? Its tools will be removed from this agent.`)) return
            const servers = myServers.filter((s) => s.name !== serverName)
            const toolPrefix = `mcp_${serverName}_`
            const tools = local.tools.filter((t) => !t.name.startsWith(toolPrefix))
            // Clean up identity entries
            if (!template) openApi()?.deleteIdentityByPrefix(`mcp:${serverName}:`)
            save({ ...local, mcp: servers.length > 0 ? { servers } : undefined, tools })
          }

          // Add a server from the registry
          const handleAddFromRegistry = (reg: typeof validRegistrations[0]) => {
            const serverCfg = buildMcpServerConfigFromRegistration(reg)
            const servers = [...myServers, serverCfg]
            save({ ...local, mcp: { servers } })
          }

          return (
            <Section docs={DOCS.mcp} title="MCP Servers" locked={isSectionLocked('mcp')} onToggleLock={() => toggleSectionLock('mcp')}>
              <PermissionLegend kinds={['approval', 'locked', 'visible']} />
              <label className="mb-2 flex items-center gap-1.5 cursor-pointer text-[11px] text-neutral-600 dark:text-neutral-300">
                <input
                  type="checkbox"
                  checked={local.mcp?.new_tools_restricted !== false}
                  onChange={(e) => save({
                    ...local,
                    mcp: { ...(local.mcp ?? { servers: [] }), new_tools_restricted: e.target.checked ? undefined : false }
                  })}
                  className="rounded text-blue-500"
                />
                New tools need approval
                <InfoHint tip="Tools found on a newly attached server start as Needs approval; a tool whose schema changes is disabled until reviewed." />
              </label>
              <div className="space-y-3">
                {/* My Servers — from config.mcp.servers */}
                {myServers.map((srv) => {
                  const cachedTools = srv.available_tools ?? []
                  const sourceBadge = srv.transport === 'http' || srv.source?.startsWith('http:')
                    ? 'http'
                    : srv.source?.startsWith('npm:') ? 'npm' : srv.source?.startsWith('uvx:') ? 'uvx' : srv.source === 'custom' ? 'custom' : srv.npm_package ? 'npm' : srv.pypi_package ? 'uvx' : 'custom'
                  const serverToolNames = new Set(cachedTools.map((tool) => `mcp_${srv.name}_${tool.name}`))
                  const serverTools = local.tools.filter((tool) => serverToolNames.has(tool.name))
                  const eligibleTools = serverTools.filter((tool) => !tool.locked)
                  const enabledTools = eligibleTools.filter((tool) => tool.enabled)
                  const enabledState = computeTriState(eligibleTools, tool => tool.enabled)
                  const visibleState = computeTriState(enabledTools, tool => !!tool.visible)
                  const restrictedState = computeTriState(eligibleTools, tool => !!tool.restricted)
                  const bulkDisabled = eligibleTools.length === 0
                  const visibilityBulkDisabled = enabledTools.length === 0
                  /** Live status from the agent's MCP manager (absent while the agent is off). */
                  const live = template ? undefined : mcpStates[srv.name]
                  const liveFailed = live?.status === 'error'

                  const toggleServerEnabled = () => {
                    if (bulkDisabled) return
                    const target = enabledState !== 'all'
                    const tools = local.tools.map((tool) => {
                      if (!serverToolNames.has(tool.name) || tool.locked) return tool
                      return { ...tool, enabled: target, visible: target ? true : tool.visible }
                    })
                    saveBulkTools(tools)
                  }
                  const toggleServerVisible = () => {
                    if (visibilityBulkDisabled) return
                    const target = visibleState !== 'all'
                    const tools = local.tools.map((tool) => {
                      if (!serverToolNames.has(tool.name) || tool.locked || !tool.enabled) return tool
                      return { ...tool, visible: target }
                    })
                    saveBulkTools(tools)
                  }
                  const toggleServerRestricted = () => {
                    if (bulkDisabled) return
                    const target = restrictedState !== 'all'
                    const tools = local.tools.map((tool) => {
                      if (!serverToolNames.has(tool.name) || tool.locked) return tool
                      return { ...tool, restricted: target || undefined }
                    })
                    saveBulkTools(tools)
                  }

                  return (
                    <div key={srv.name} className="border border-neutral-200 dark:border-neutral-700 rounded-lg p-2 space-y-1.5">
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="font-medium text-neutral-700 dark:text-neutral-200 flex min-w-0 items-center gap-1.5">
                          <span className="truncate">{srv.name}</span>
                          <span className="text-[9px] px-1 py-0.5 bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400 rounded">{sourceBadge}</span>
                          {!template && <McpStatusChip status={live?.status} />}
                        </span>
                        <span className="flex items-center gap-2 shrink-0">
                          <button
                            type="button"
                            disabled={bulkDisabled}
                            title={`${PERMISSION_TIPS.approval} Toggles every tool from this server.`}
                            aria-label="Needs approval for all tools from this server"
                            onClick={toggleServerRestricted}
                            className={`flex items-center justify-center rounded transition-colors ${
                              bulkDisabled
                                ? 'cursor-not-allowed text-neutral-300 dark:text-neutral-700'
                                : restrictedState === 'all'
                                  ? PERMISSION_ON_CLASS.approval
                                  : restrictedState === 'mixed'
                                    ? `${PERMISSION_ON_CLASS.approval} opacity-50`
                                    : 'text-[var(--adf-ui-icon-muted)] hover:text-[var(--adf-ui-text-subtle)]'
                            }`}
                          >
                            <ApprovalIcon filled={restrictedState !== 'none'} />
                          </button>
                          <button
                            type="button"
                            disabled={visibilityBulkDisabled}
                            title="Toggle visibility for all enabled tools from this server"
                            onClick={toggleServerVisible}
                            className={`flex h-4 w-4 items-center justify-center rounded transition-colors ${
                              visibilityBulkDisabled
                                ? 'cursor-not-allowed text-neutral-300 dark:text-neutral-700'
                                : visibleState === 'all'
                                  ? 'text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300'
                                  : visibleState === 'mixed'
                                    ? 'text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300 opacity-50'
                                    : 'text-[var(--adf-ui-icon-muted)] hover:text-[var(--adf-ui-text-subtle)]'
                            }`}
                          >
                            <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
                              <circle cx="12" cy="12" r="3" />
                              {visibleState === 'none' && <path d="M3 3l18 18" />}
                            </svg>
                          </button>
                          <input
                            type="checkbox"
                            title="Toggle enabled for all tools from this server"
                            ref={element => { if (element) element.indeterminate = !bulkDisabled && enabledState === 'mixed' }}
                            checked={!bulkDisabled && enabledState === 'all'}
                            disabled={bulkDisabled}
                            onChange={toggleServerEnabled}
                          />
                          {!template && (
                            <button
                              type="button"
                              onClick={() => setMcpLogsFor(mcpLogsFor === srv.name ? null : srv.name)}
                              aria-expanded={mcpLogsFor === srv.name}
                              className="text-[10px] text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200 font-medium"
                            >Logs</button>
                          )}
                          <button
                            onClick={() => handleRemoveServer(srv.name)}
                            className="text-[10px] text-red-400 hover:text-red-600 font-medium"
                          >Remove</button>
                        </span>
                      </div>
                      {!template && liveFailed && live?.error && (
                        <p className="text-[10px] text-red-500 dark:text-red-400 break-words" role="alert">Error: {live.error}</p>
                      )}
                      {!template && live?.status === 'needs_sign_in' && live.error && (
                        <p className="text-[10px] text-amber-700 dark:text-amber-400 break-words">{live.error}</p>
                      )}
                      {mcpLogsFor === srv.name && (
                        <McpServerLogs serverName={srv.name} logs={mcpLogs} onClose={() => setMcpLogsFor(null)} />
                      )}
                      {srv.npm_package && (
                        <p className="text-[10px] text-[var(--adf-ui-text-subtle)] font-mono truncate">{srv.npm_package}</p>
                      )}
                      {srv.pypi_package && (
                        <p className="text-[10px] text-[var(--adf-ui-text-subtle)] font-mono truncate">{srv.pypi_package}</p>
                      )}
                      {srv.url && (
                        <p className="text-[10px] text-[var(--adf-ui-text-subtle)] font-mono truncate">{srv.url}</p>
                      )}
                      {cachedTools.length > 0 ? (
                        <>
                          <button
                            type="button"
                            onClick={() => setExpandedMcpTools((prev) => ({ ...prev, [srv.name]: !prev[srv.name] }))}
                            className="flex items-center gap-1 text-[10px] text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors"
                          >
                            <svg
                              width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor"
                              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                              className={`transition-transform ${expandedMcpTools[srv.name] ? 'rotate-90' : ''}`}
                            ><path d="M9 18l6-6-6-6" /></svg>
                            {serverTools.filter((tool) => tool.enabled).length}/{serverTools.length || cachedTools.length} tools enabled
                          </button>
                          {expandedMcpTools[srv.name] && (
                        <div className="pl-2 space-y-1">
                          {cachedTools.map((ct) => {
                            const toolName = `mcp_${srv.name}_${ct.name}`
                            const toolDecl = local.tools.find((t) => t.name === toolName)
                            if (!toolDecl) return null
                            const ti = local.tools.findIndex((t) => t.name === toolName)

                            const mcpRestricted = toolDecl.restricted ?? false
                            const mcpLocked = toolDecl.locked ?? false

                            return (
                              <div key={toolName} className={`flex items-center justify-between text-xs px-1.5 py-0.5 -mx-1.5 rounded ${mcpLocked ? 'bg-amber-50/60 dark:bg-amber-900/10 border-l-2 border-amber-400 dark:border-amber-600' : mcpRestricted ? 'bg-violet-50/60 dark:bg-violet-900/10 border-l-2 border-violet-400 dark:border-violet-600' : 'hover:bg-neutral-200/60 dark:hover:bg-neutral-700/50'}`}>
                                <span
                                  className="font-mono text-neutral-600 dark:text-neutral-400 text-[10px] truncate cursor-pointer hover:text-blue-500 dark:hover:text-blue-400 hover:underline"
                                  onClick={() => {
                                    setToolDefs((prev) => ({ ...prev, [ct.name]: { name: ct.name, description: ct.description, input_schema: ct.input_schema } }))
                                    setViewingTool(ct.name)
                                  }}
                                >
                                  {ct.name}
                                </span>
                                <span className="flex items-center gap-3 shrink-0">
                                  {mcpLocked && (
                                    <span className={PERMISSION_ON_CLASS.locked} title={PERMISSION_TIPS.locked} aria-label="Locked">
                                      <LockIcon size={12} />
                                    </span>
                                  )}
                                  <button
                                    type="button"
                                    aria-pressed={mcpRestricted}
                                    aria-label="Needs approval"
                                    className={`flex items-center justify-center rounded transition-colors ${mcpRestricted ? PERMISSION_ON_CLASS.approval : 'text-[var(--adf-ui-icon-muted)] hover:text-[var(--adf-ui-text-subtle)]'}`}
                                    title={PERMISSION_TIPS.approval}
                                    onClick={() => {
                                      const tools = [...local.tools]
                                      tools[ti] = { ...tools[ti], restricted: !mcpRestricted || undefined }
                                      save({ ...local, tools })
                                    }}
                                  >
                                    <ApprovalIcon filled={mcpRestricted} />
                                  </button>
                                  <ToolVisibilityToggle
                                    visible={toolDecl.enabled && toolDecl.visible}
                                    disabled={!toolDecl.enabled}
                                    onToggle={() => {
                                      const tools = [...local.tools]
                                      tools[ti] = { ...tools[ti], visible: !toolDecl.visible }
                                      save({ ...local, tools })
                                    }}
                                  />
                                  <input
                                    type="checkbox"
                                    title="Enabled: allowed to be used by the runtime and lambdas."
                                    checked={toolDecl.enabled}
                                    onChange={(e) => {
                                      const enabled = e.target.checked
                                      const tools = [...local.tools]
                                      tools[ti] = { ...tools[ti], enabled, visible: enabled ? true : tools[ti].visible }
                                      save({ ...local, tools })
                                    }}
                                  />
                                </span>
                              </div>
                            )
                          })}
                        </div>
                          )}
                        </>
                      ) : liveFailed ? null : (
                        <p className="text-[10px] text-[var(--adf-ui-text-subtle)] pl-2">
                          Tools will be discovered when the agent connects.
                        </p>
                      )}
                    </div>
                  )
                })}

                {myServers.length === 0 && (
                  <p className="text-[10px] text-[var(--adf-ui-text-subtle)] italic">
                    No MCP servers configured. Add from the registry below or use the mcp_install tool.
                  </p>
                )}

                {/* Servers attached to the agent but not registered in this runtime */}
                {orphanedServers.length > 0 && (
                  <div className="pt-2 border-t border-amber-200 dark:border-amber-800">
                    <label className="text-[10px] text-amber-700 dark:text-amber-400 block mb-1 font-medium">
                      Not registered in this runtime
                    </label>
                    <p className="text-[10px] text-neutral-500 dark:text-neutral-400 mb-1.5">
                      These servers exist on the agent but have no app-level registration,
                      so they can't start. Add them to the runtime to configure credentials.
                    </p>
                    <div className="space-y-1.5">
                      {orphanedServers.map((srv) => {
                        const schema = srv.env_schema ?? []
                        const appKeys = schema.filter((e) => e.scope === 'app').map((e) => e.key)
                        const agentKeys = schema.filter((e) => e.scope === 'agent').map((e) => e.key)
                        const legacyKeys = !schema.length ? (srv.env_keys ?? []) : []
                        return (
                          <div key={srv.name} className="border border-amber-200 dark:border-amber-900 bg-amber-50/40 dark:bg-amber-900/10 rounded p-1.5 flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              <div className="text-xs font-medium text-neutral-700 dark:text-neutral-200 truncate">{srv.name}</div>
                              {(srv.npm_package || srv.pypi_package || srv.command) && (
                                <div className="text-[10px] text-[var(--adf-ui-text-subtle)] font-mono truncate">
                                  {srv.npm_package ?? srv.pypi_package ?? srv.command}
                                </div>
                              )}
                              {(appKeys.length > 0 || agentKeys.length > 0 || legacyKeys.length > 0) && (
                                <div className="text-[10px] text-neutral-500 dark:text-neutral-400 mt-0.5">
                                  {appKeys.length > 0 && <>App: <span className="font-mono">{appKeys.join(', ')}</span></>}
                                  {appKeys.length > 0 && agentKeys.length > 0 && ' · '}
                                  {agentKeys.length > 0 && <>Agent: <span className="font-mono">{agentKeys.join(', ')}</span></>}
                                  {legacyKeys.length > 0 && <>Keys: <span className="font-mono">{legacyKeys.join(', ')}</span></>}
                                </div>
                              )}
                            </div>
                            <button
                              onClick={() => handleAddToRuntime(srv)}
                              className="text-[11px] px-2 py-1 bg-amber-500 hover:bg-amber-600 text-white rounded font-medium shrink-0"
                            >Add to runtime</button>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/* Add from registry */}
                {availableToAdd.length > 0 && (
                  <div className="pt-2 border-t border-neutral-200 dark:border-neutral-700">
                    <label className="text-[10px] text-neutral-600 dark:text-neutral-400 block mb-1">Add from runtime<InfoHint tip="Servers from your runtime registry. App-wide credentials are inherited automatically." /></label>
                    <select
                      className="w-full px-2 py-1 text-xs rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-700 text-neutral-800 dark:text-neutral-200"
                      value=""
                      onChange={(e) => {
                        const reg = availableToAdd.find((r) => r.name === e.target.value)
                        if (reg) handleAddFromRegistry(reg)
                      }}
                    >
                      <option value="">Select a server to add...</option>
                      {availableToAdd.map((reg) => (
                        <option key={reg.id} value={reg.name}>
                          {reg.name} ({reg.type ?? 'npm'}{reg.npmPackage ? `: ${reg.npmPackage}` : reg.pypiPackage ? `: ${reg.pypiPackage}` : ''})
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            </Section>
          )
        })()}

        {/* Channels */}
        {adapterRegistrations.length > 0 && (
          <Section docs={DOCS.channels} hint="Connect channels under Settings → Channels. Switch them on here to bring outside messages into this agent." title="Channels">
            <div className="space-y-3">
              {template && (
                <p className="text-[10px] text-[var(--adf-ui-text-subtle)]">Channels are connected per agent from Settings → Channels, or from the agent's own Config tab.</p>
              )}
              {adapterRegistrations.map((reg) => {
                const adapterConfig = local.adapters?.[reg.type]
                const enabled = adapterConfig?.enabled ?? false
                const registryEntry = findAdapterRegistryEntry(reg.type)
                const hasKeys = adapterWithKeys.has(reg.type)
                const agentKeys = adapterIdentityKeys[reg.type]
                // Credentials live only in this agent's adf_identity.
                const hasEmptyRequiredKeys = (registryEntry?.requiredEnvKeys ?? []).some((rk) => !agentKeys?.has(rk))

                const handleEnable = async () => {
                  const newConfig: AdapterInstanceConfig = {
                    enabled: true,
                    policy: { dm: 'all', groups: 'mention' }
                  }
                  const adapters = { ...(local.adapters ?? {}), [reg.type]: newConfig }
                  save({ ...local, adapters })
                }

                const handleDisable = () => {
                  const msg = hasKeys
                    ? `Disable "${registryEntry?.displayName ?? reg.type}"? Its stored credentials in this ADF will also be deleted.`
                    : `Disable "${registryEntry?.displayName ?? reg.type}"?`
                  if (!window.confirm(msg)) return

                  // Clean up identity keys
                  if (!template) openApi()?.deleteIdentityByPrefix(`adapter:${reg.type}:`)

                  const adapters = { ...(local.adapters ?? {}) }
                  delete adapters[reg.type]
                  save({ ...local, adapters: Object.keys(adapters).length > 0 ? adapters : undefined })
                }

                return (
                  <div key={reg.id} className="border border-neutral-200 dark:border-neutral-700 rounded-lg p-2 space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-neutral-700 dark:text-neutral-200 flex items-center gap-1.5">
                        {registryEntry?.displayName ?? reg.type}
                        {hasKeys && (
                          <span
                            className="text-[9px] text-amber-600 dark:text-amber-400"
                            title="Credentials stored in this ADF"
                          >
                            <svg className="inline w-3 h-3" viewBox="0 0 16 16" fill="currentColor"><path d="M11.5 0a4.5 4.5 0 0 0-4.2 6.1L0 13.4V16h2.6l.7-.7v-1.7h1.7l.7-.7v-1.7h1.7l1-1 .7.3a4.5 4.5 0 1 0 2.4-9.5zm1 5.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/></svg>
                          </span>
                        )}
                        {hasEmptyRequiredKeys && (
                          <span className="text-[9px] px-1 py-0.5 bg-amber-100 dark:bg-amber-900/40 text-amber-600 dark:text-amber-400 rounded font-medium">
                            Needs keys
                          </span>
                        )}
                      </span>
                      <span className="flex items-center gap-2">
                        {enabled ? (
                          <button
                            onClick={handleDisable}
                            className="text-[10px] text-red-400 hover:text-red-600 font-medium"
                          >
                            Disable
                          </button>
                        ) : (
                          <button
                            onClick={handleEnable}
                            className="text-[10px] text-green-600 hover:text-green-700 dark:text-green-400 dark:hover:text-green-300 font-medium"
                          >
                            Enable
                          </button>
                        )}
                      </span>
                    </div>
                    <p className="text-[10px] text-[var(--adf-ui-text-subtle)] font-mono truncate">
                      {reg.type}
                    </p>
                    {enabled && adapterConfig && reg.type === 'email' && (
                      <div className="pl-2 space-y-1.5 pt-1 border-t border-neutral-100 dark:border-neutral-700">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-neutral-500 dark:text-neutral-400">Account</span>
                          <span className="text-neutral-700 dark:text-neutral-200 font-mono text-[10px] truncate ml-2">
                            {emailAccount || '—'}
                          </span>
                        </div>
                      </div>
                    )}
                    {enabled && adapterConfig && reg.type !== 'email' && (
                      <div className="pl-2 space-y-1.5 pt-1 border-t border-neutral-100 dark:border-neutral-700">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-neutral-500 dark:text-neutral-400">DM mode</span>
                          <select
                            value={adapterConfig.policy?.dm ?? 'all'}
                            onChange={(e) => {
                              const adapters = { ...(local.adapters ?? {}) }
                              adapters[reg.type] = {
                                ...adapters[reg.type],
                                policy: { ...(adapters[reg.type]?.policy ?? {}), dm: e.target.value as 'all' | 'allowlist' | 'none' }
                              }
                              save({ ...local, adapters })
                            }}
                            className="text-[10px] px-1.5 py-0.5 border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded focus:outline-none focus:border-blue-400"
                          >
                            <option value="all">All</option>
                            <option value="allowlist">Allowlist</option>
                            <option value="none">None</option>
                          </select>
                        </div>
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-neutral-500 dark:text-neutral-400">Group mode</span>
                          <select
                            value={adapterConfig.policy?.groups ?? 'mention'}
                            onChange={(e) => {
                              const adapters = { ...(local.adapters ?? {}) }
                              adapters[reg.type] = {
                                ...adapters[reg.type],
                                policy: { ...(adapters[reg.type]?.policy ?? {}), groups: e.target.value as 'all' | 'mention' | 'none' }
                              }
                              save({ ...local, adapters })
                            }}
                            className="text-[10px] px-1.5 py-0.5 border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded focus:outline-none focus:border-blue-400"
                          >
                            <option value="all">All</option>
                            <option value="mention">Mention only</option>
                            <option value="none">None</option>
                          </select>
                        </div>
                      </div>
                    )}
                    {!enabled && (
                      <p className="text-[10px] text-[var(--adf-ui-text-subtle)] pl-2">
                        Not enabled
                      </p>
                    )}
                    {hasEmptyRequiredKeys && (
                      <p className="text-[10px] text-amber-600 dark:text-amber-400 pl-2">
                        Missing credentials — connect this agent under Settings → Channels
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
          </Section>
        )}

        {/* Messaging */}
        <Section docs={DOCS.messaging} title="Messaging" locked={isSectionLocked('messaging')} onToggleLock={() => toggleSectionLock('messaging')} summary={local.messaging?.receive ? `${local.messaging?.visibility ?? 'localhost'} · ${local.messaging?.mode ?? 'proactive'}${local.messaging?.inbox_mode ? ' · inbox' : ''}` : 'off'}>
          <label className="flex items-center justify-between text-xs">
            <span className="text-neutral-700 dark:text-neutral-300">Receive messages<InfoHint tip="Whether this agent participates in the mesh and can receive messages from other agents." /></span>
            <input
              type="checkbox"
              checked={local.messaging?.receive ?? false}
              onChange={(e) => {
                const receive = e.target.checked
                const ALL_MSG_TOOLS = new Set([...MESSAGING_TOOLS, ...INBOX_TOOLS])
                save({
                  ...local,
                  messaging: {
                    ...(local.messaging ?? { receive: false, mode: 'respond_only' as const }),
                    receive
                  },
                  tools: local.tools.map((t) =>
                    ALL_MSG_TOOLS.has(t.name) ? { ...t, enabled: receive ? t.enabled : false, visible: receive ? t.visible : false } : t
                  )
                })
              }}
            />
          </label>
          {local.messaging?.receive && (
            <>
              <label className="flex items-center justify-between text-xs mt-2">
                <span className="text-neutral-700 dark:text-neutral-300">Inbox mode</span>
                <input
                  type="checkbox"
                  checked={local.messaging?.inbox_mode ?? false}
                  onChange={(e) => {
                    const inboxMode = e.target.checked
                    save({
                      ...local,
                      messaging: {
                        ...(local.messaging ?? { receive: false, mode: 'respond_only' as const }),
                        inbox_mode: inboxMode
                      },
                      tools: local.tools.map((t) =>
                        INBOX_TOOLS.has(t.name) ? { ...t, enabled: inboxMode, visible: inboxMode } : t
                      )
                    })
                  }}
                />
              </label>
              <p className="text-[10px] text-[var(--adf-ui-text-subtle)]">
                {local.messaging?.inbox_mode
                  ? (local.autonomous
                      ? 'Messages are stored in an inbox. The agent is notified immediately when new messages arrive.'
                      : 'Messages are stored in an inbox. The agent is notified on a periodic schedule when idle.')
                  : 'Messages trigger the agent immediately (default behavior).'}
              </p>
              <Field label="Allow list" hint="Allow list takes priority. If set, only listed DIDs can send/receive. Leave both empty for no restriction.">
                <DidListPicker
                  dids={local.messaging?.allow_list ?? []}
                  knownAgents={knownAgents}
                  inputValue={allowListInput}
                  onInputChange={setAllowListInput}
                  dropdownOpen={allowListDropdown}
                  onDropdownChange={setAllowListDropdown}
                  onChange={(dids) => save({
                    ...local,
                    messaging: {
                      ...local.messaging!,
                      allow_list: dids.length > 0 ? dids : undefined
                    }
                  })}
                  placeholder={knownAgents.length > 0
                    ? 'Search known agents...'
                    : 'Paste a DID (did:key:...) or discover agents first'}
                />
              </Field>
              <Field label="Block list">
                <DidListPicker
                  dids={local.messaging?.block_list ?? []}
                  knownAgents={knownAgents}
                  inputValue={blockListInput}
                  onInputChange={setBlockListInput}
                  dropdownOpen={blockListDropdown}
                  onDropdownChange={setBlockListDropdown}
                  onChange={(dids) => save({
                    ...local,
                    messaging: {
                      ...local.messaging!,
                      block_list: dids.length > 0 ? dids : undefined
                    }
                  })}
                  placeholder={knownAgents.length > 0
                    ? 'Search known agents...'
                    : 'Paste a DID (did:key:...) or discover agents first'}
                />
              </Field>
              <Field label="Visibility" hint="Directory: only ancestor-directory agents on this runtime. Localhost: any agent on this computer. LAN: any agent on an allowed network (Settings → Networking). Public: any agent that reaches this computer, also only on an allowed network. Off: nobody; no inbound, sends still allowed.">
                <div className="flex rounded-md border border-neutral-200 dark:border-neutral-700 overflow-hidden">
                  {VISIBILITY_VALUES.map((tier, i) => (
                    <button
                      key={tier}
                      className={`flex-1 px-2 py-0.5 text-[10px] font-medium transition-colors ${
                        (local.messaging?.visibility ?? 'localhost') === tier
                          ? 'bg-[var(--adf-ui-accent-subtle)] text-[var(--adf-ui-text)]'
                          : 'bg-white dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-700'
                      } ${i > 0 ? 'border-l border-neutral-200 dark:border-neutral-700' : ''}`}
                      onClick={() => {
                        save({
                          ...local,
                          messaging: {
                            ...local.messaging!,
                            visibility: tier
                          }
                        })
                      }}
                    >
                      {tier === 'directory' ? 'Directory' : tier === 'localhost' ? 'Localhost' : tier === 'lan' ? 'LAN' : tier === 'public' ? 'Public' : 'Off'}
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="Send mode" hint="Proactive: can send anytime. Respond Only: only when message-triggered. None: listen only.">
                <div className="flex rounded-md border border-neutral-200 dark:border-neutral-700 overflow-hidden">
                  {MESSAGING_MODES.map((mode, i) => (
                    <button
                      key={mode}
                      className={`flex-1 px-2 py-0.5 text-[10px] font-medium transition-colors ${
                        (local.messaging?.mode ?? 'respond_only') === mode
                          ? 'bg-[var(--adf-ui-accent-subtle)] text-[var(--adf-ui-text)]'
                          : 'bg-white dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-700'
                      } ${i > 0 ? 'border-l border-neutral-200 dark:border-neutral-700' : ''}`}
                      onClick={() => {
                        const sendEnabled = mode !== 'listen_only'
                        const listEnabled = mode === 'proactive'
                        save({
                          ...local,
                          messaging: {
                            ...local.messaging!,
                            mode: mode
                          },
                          tools: local.tools.map((t) => {
                            if (t.name === 'msg_send') return { ...t, enabled: sendEnabled, visible: sendEnabled }
                            if (t.name === 'agent_discover') return { ...t, enabled: listEnabled, visible: listEnabled }
                            return t
                          })
                        })
                      }}
                    >
                      {mode === 'respond_only' ? 'Respond Only' : mode === 'proactive' ? 'Proactive' : 'None'}
                    </button>
                  ))}
                </div>
              </Field>
            </>
          )}
        </Section>

        {/* Security */}
        <Section docs={DOCS.security} title="Security" locked={isSectionLocked('security')} onToggleLock={() => toggleSectionLock('security')} summary={(['Open', 'Signed', 'Encrypted', 'Advanced'] as const)[local.security?.level ?? 0]}>
          <div className="flex items-center justify-between mb-0.5">
            <label className="block text-xs text-neutral-500 dark:text-neutral-400">Security level<InfoHint tip="Open: no signing. Signed: messages are cryptographically signed. Encrypted: signed, and payloads to DID recipients are encrypted end-to-end (encryption key derived from the recipient’s DID). Local same-runtime and channel-adapter messages are not encrypted." /></label>
            {!isSectionLocked('security') && (
              <LockButton
                locked={isSectionLocked('security.level')}
                size="xs"
                onClick={() => toggleFieldLock('security.level', ['security.allow_unsigned', 'security.require_signature', 'security.require_payload_signature'])}
              />
            )}
          </div>
          <div>
            <div className="flex rounded-md border border-neutral-200 dark:border-neutral-700 overflow-hidden">
              {([0, 1, 2] as const).map((lvl, i) => {
                const labels = ['Open', 'Signed', 'Encrypted'] as const
                const currentLevel = local.security?.level ?? 0
                return (
                  <button
                    key={lvl}
                    className={`px-2 py-0.5 text-[10px] font-medium transition-colors ${
                      currentLevel === lvl
                        ? 'bg-[var(--adf-ui-accent-subtle)] text-[var(--adf-ui-text)]'
                        : 'bg-white dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-700'
                    } ${i > 0 ? 'border-l border-neutral-200 dark:border-neutral-700' : ''}`}
                    onClick={() => {
                      const requireSig = lvl === 0 ? false : (local.security?.require_signature ?? false)
                      const requirePayloadSig = lvl === 0 ? false : (local.security?.require_payload_signature ?? false)
                      save({
                        ...local,
                        security: {
                          ...local.security,
                          level: lvl,
                          allow_unsigned: lvl === 0 ? true : !requireSig,
                          require_signature: requireSig,
                          require_payload_signature: requirePayloadSig
                        }
                      })
                    }}
                  >
                    {labels[lvl]}
                  </button>
                )
              })}
            </div>

          {!template && (local.security?.level ?? 0) >= 1 && !hasSigningKeys && (
            <div className="p-2 rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 mt-2">
              <p className="text-[10px] text-amber-700 dark:text-amber-400">
                <strong>Warning:</strong> Signing requires identity keys. Go to the{' '}
                <button
                  className="underline font-medium hover:text-amber-900 dark:hover:text-amber-300"
                  onClick={() => useAppStore.getState().setAgentSubTab('identity')}
                >
                  Identity tab
                </button>{' '}
                to generate a DID and signing keys.
              </p>
            </div>
          )}

          {(local.security?.level ?? 0) >= 1 && (
            <>
              <label className="flex items-center justify-between text-xs mt-2">
                <span className="text-neutral-700 dark:text-neutral-300">Require message signature<InfoHint tip="Reject incoming messages without a valid message signature." /></span>
                <input
                  type="checkbox"
                  checked={local.security?.require_signature ?? false}
                  onChange={(e) => {
                    const requireSig = e.target.checked
                    save({
                      ...local,
                      security: {
                        ...local.security,
                        level: local.security?.level ?? 1,
                        allow_unsigned: !requireSig,
                        require_signature: requireSig,
                        require_payload_signature: local.security?.require_payload_signature ?? false
                      }
                    })
                  }}
                />
              </label>

              <label className="flex items-center justify-between text-xs mt-2">
                <span className="text-neutral-700 dark:text-neutral-300">Require payload signature<InfoHint tip="Reject incoming messages without a valid payload signature." /></span>
                <input
                  type="checkbox"
                  checked={local.security?.require_payload_signature ?? false}
                  onChange={(e) => {
                    save({
                      ...local,
                      security: {
                        ...local.security,
                        level: local.security?.level ?? 1,
                        allow_unsigned: !(local.security?.require_signature ?? false),
                        require_signature: local.security?.require_signature ?? false,
                        require_payload_signature: e.target.checked
                      }
                    })
                  }}
                />
              </label>
            </>
          )}
          </div>

          {/* Attestations — send-side disclosure; receive-side enforcement will join here */}
          <div className="mt-3 pt-3 border-t border-neutral-200 dark:border-neutral-700">
            <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-1">Attestations</label>
            <label className="flex items-center justify-between text-xs">
              <span className="text-neutral-700 dark:text-neutral-300">Publish owner attestation on agent card<InfoHint tip="Lets mesh peers verify who owns this agent. Off by default — an unpublished agent cannot be linked to you by card inspection." /></span>
              <input
                type="checkbox"
                checked={local.card?.publish_attestations ?? false}
                onChange={(e) => {
                  const enabled = e.target.checked
                  save({
                    ...local,
                    card: { ...(local.card ?? {}), publish_attestations: enabled || undefined }
                  })
                }}
              />
            </label>
          </div>

          {/* Private-network egress (SSRF guard escape hatch) */}
          <div className="mt-3 pt-3 border-t border-neutral-200 dark:border-neutral-700">
            <label className="flex items-center justify-between text-xs">
              <span className="text-neutral-700 dark:text-neutral-300">Allow private network fetch<InfoHint tip="Lets sys_fetch and ws_connect reach private/LAN addresses — 10.x, 172.16-31.x, 192.168.x, and CGNAT 100.64-127.x (e.g. Tailscale). Default off. Loopback (localhost) is always allowed; the local daemon control API and cloud-metadata (169.254.x) addresses stay blocked regardless." /></span>
              <input
                type="checkbox"
                checked={local.security?.allow_local_fetch ?? false}
                onChange={(e) => {
                  const enabled = e.target.checked
                  save({
                    ...local,
                    security: { ...local.security, allow_local_fetch: enabled || undefined }
                  })
                }}
              />
            </label>
          </div>

          {/* Table permissions */}
          <div className="mt-3 pt-3 border-t border-neutral-200 dark:border-neutral-700">
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs text-neutral-500 dark:text-neutral-400">Table Permissions<InfoHint tip="Append-only blocks updates and deletes; Restricted lets only authorized code write." /></label>
              {!isSectionLocked('security') && (
                <LockButton
                  locked={isSectionLocked('security.table_protections')}
                  size="xs"
                  onClick={() => toggleFieldLock('security.table_protections')}
                />
              )}
            </div>
            <div>
              {template && (
                <p className="text-[10px] text-[var(--adf-ui-text-subtle)] mb-1">Tables exist per agent; the picker lists them once an agent is open.</p>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto_auto] gap-1.5 mb-2">
                <select
                  value={newProtectedTable}
                  onChange={(e) => setNewProtectedTable(e.target.value)}
                  className="min-w-0 w-full px-2 py-1 text-xs border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                >
                  <option value="">Select local table</option>
                  {availableTablesForProtection.map((table) => (
                    <option key={table.name} value={table.name}>
                      {table.name} ({table.row_count})
                    </option>
                  ))}
                </select>
                <select
                  value={newTableProtection}
                  onChange={(e) => setNewTableProtection(e.target.value as TableProtectionLevel)}
                  className="w-full sm:w-28 px-2 py-1 text-xs border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                >
                  <option value="append_only">{tableProtectionLabel('append_only')}</option>
                  <option value="authorized" title={RESTRICTED_TABLE_TIP}>{tableProtectionLabel('authorized')}</option>
                </select>
                <button
                  disabled={!newProtectedTable}
                  onClick={() => {
                    if (!newProtectedTable) return
                    setTableProtection(newProtectedTable, newTableProtection)
                    setNewProtectedTable('')
                  }}
                  className="w-full sm:w-auto px-2 py-1 text-xs border border-[var(--adf-ui-border)] bg-[var(--adf-ui-canvas)] text-[var(--adf-ui-text)] hover:bg-[var(--adf-ui-surface-hover)] rounded-md disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Add
                </button>
              </div>
              {tableProtectionEntries.length > 0 ? (
                <div className="space-y-1">
                  {tableProtectionEntries.map(([table, protection]) => (
                    <div key={table} className="flex flex-wrap sm:flex-nowrap items-center gap-1.5">
                      <span className="flex-1 min-w-0 truncate text-xs font-mono text-neutral-700 dark:text-neutral-300" title={table}>
                        {table}
                      </span>
                      <select
                        value={protection}
                        onChange={(e) => setTableProtection(table, e.target.value as TableProtectionLevel)}
                        className="w-full sm:w-32 min-w-0 px-2 py-1 text-xs border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                      >
                        {TABLE_PROTECTION_LEVELS.map((level) => (
                          <option key={level} value={level} title={level === 'authorized' ? RESTRICTED_TABLE_TIP : undefined}>
                            {tableProtectionLabel(level)}
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() => setTableProtection(table, 'none')}
                        className="text-xs text-red-400 hover:text-red-600 px-1"
                      >
                        &times;
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-[10px] text-[var(--adf-ui-text-subtle)]">
                  No protected local tables.
                </p>
              )}
            </div>
          </div>

          {/* Custom Middleware */}
          <div className="mt-3 pt-3 border-t border-neutral-200 dark:border-neutral-700">
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs text-neutral-500 dark:text-neutral-400">Custom Middleware<InfoHint tip="Lambda functions executed in order on each message. Format: path/file.ts:functionName" /></label>
              {!isSectionLocked('security') && (
                <LockButton
                  locked={isSectionLocked('security.middleware')}
                  size="xs"
                  onClick={() => toggleFieldLock('security.middleware')}
                />
              )}
            </div>
            <div>

            {/* Inbox Middleware */}
            <div className="mb-2">
              <div className="flex items-center justify-between mb-0.5">
                <span className="text-[10px] text-neutral-500 dark:text-neutral-400 font-medium">Inbox</span>
                <button
                  onClick={() => {
                    const mw = [...(local.security?.middleware?.inbox ?? []), { lambda: '' }]
                    inboxMwKeys.append()
                    save({
                      ...local,
                      security: { ...local.security, middleware: { ...local.security?.middleware, inbox: mw } }
                    })
                  }}
                  className="text-[10px] text-blue-500 hover:text-blue-700 font-medium"
                >
                  + Add
                </button>
              </div>
              {(local.security?.middleware?.inbox ?? []).map((ref, i) => (
                <div key={inboxMwKeys.keys[i]} className="flex gap-1 items-center mb-1">
                  <input
                    type="text"
                    value={ref.lambda}
                    onChange={(e) => {
                      const mw = [...(local.security?.middleware?.inbox ?? [])]
                      mw[i] = { lambda: e.target.value }
                      save({
                        ...local,
                        security: { ...local.security, middleware: { ...local.security?.middleware, inbox: mw } }
                      })
                    }}
                    placeholder="lib/middleware.ts:onInbox"
                    className="flex-1 px-2 py-1 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                  />
                  <button
                    onClick={() => {
                      const mw = (local.security?.middleware?.inbox ?? []).filter((_, j) => j !== i)
                      inboxMwKeys.removeAt(i)
                      save({
                        ...local,
                        security: { ...local.security, middleware: { ...local.security?.middleware, inbox: mw.length > 0 ? mw : undefined } }
                      })
                    }}
                    className="text-xs text-red-400 hover:text-red-600 px-1"
                  >
                    &times;
                  </button>
                </div>
              ))}
            </div>

            {/* Outbox Middleware */}
            <div className="mb-2">
              <div className="flex items-center justify-between mb-0.5">
                <span className="text-[10px] text-neutral-500 dark:text-neutral-400 font-medium">Outbox</span>
                <button
                  onClick={() => {
                    const mw = [...(local.security?.middleware?.outbox ?? []), { lambda: '' }]
                    outboxMwKeys.append()
                    save({
                      ...local,
                      security: { ...local.security, middleware: { ...local.security?.middleware, outbox: mw } }
                    })
                  }}
                  className="text-[10px] text-blue-500 hover:text-blue-700 font-medium"
                >
                  + Add
                </button>
              </div>
              {(local.security?.middleware?.outbox ?? []).map((ref, i) => (
                <div key={outboxMwKeys.keys[i]} className="flex gap-1 items-center mb-1">
                  <input
                    type="text"
                    value={ref.lambda}
                    onChange={(e) => {
                      const mw = [...(local.security?.middleware?.outbox ?? [])]
                      mw[i] = { lambda: e.target.value }
                      save({
                        ...local,
                        security: { ...local.security, middleware: { ...local.security?.middleware, outbox: mw } }
                      })
                    }}
                    placeholder="lib/middleware.ts:onOutbox"
                    className="flex-1 px-2 py-1 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                  />
                  <button
                    onClick={() => {
                      const mw = (local.security?.middleware?.outbox ?? []).filter((_, j) => j !== i)
                      outboxMwKeys.removeAt(i)
                      save({
                        ...local,
                        security: { ...local.security, middleware: { ...local.security?.middleware, outbox: mw.length > 0 ? mw : undefined } }
                      })
                    }}
                    className="text-xs text-red-400 hover:text-red-600 px-1"
                  >
                    &times;
                  </button>
                </div>
              ))}
            </div>

            </div>
            {/* Fetch Middleware */}
            <div>
              <div className="flex items-center justify-between mb-0.5">
                <div className="flex items-center gap-1">
                  <span className="text-[10px] text-neutral-500 dark:text-neutral-400 font-medium">Fetch</span>
                  {!isSectionLocked('security') && (
                    <LockButton
                      locked={isSectionLocked('security.fetch_middleware')}
                      size="xs"
                      onClick={() => toggleFieldLock('security.fetch_middleware')}
                    />
                  )}
                </div>
                <button
                  onClick={() => {
                    const mw = [...(local.security?.fetch_middleware ?? []), { lambda: '' }]
                    fetchMwKeys.append()
                    save({
                      ...local,
                      security: { ...local.security, fetch_middleware: mw }
                    })
                  }}
                  className="text-[10px] text-blue-500 hover:text-blue-700 font-medium"
                >
                  + Add
                </button>
              </div>
              <div>
              {(local.security?.fetch_middleware ?? []).map((ref, i) => (
                <div key={fetchMwKeys.keys[i]} className="flex gap-1 items-center mb-1">
                  <input
                    type="text"
                    value={ref.lambda}
                    onChange={(e) => {
                      const mw = [...(local.security?.fetch_middleware ?? [])]
                      mw[i] = { lambda: e.target.value }
                      save({
                        ...local,
                        security: { ...local.security, fetch_middleware: mw }
                      })
                    }}
                    placeholder="lib/middleware.ts:onFetch"
                    className="flex-1 px-2 py-1 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                  />
                  <button
                    onClick={() => {
                      const mw = (local.security?.fetch_middleware ?? []).filter((_, j) => j !== i)
                      fetchMwKeys.removeAt(i)
                      save({
                        ...local,
                        security: { ...local.security, fetch_middleware: mw.length > 0 ? mw : undefined }
                      })
                    }}
                    className="text-xs text-red-400 hover:text-red-600 px-1"
                  >
                    &times;
                  </button>
                </div>
              ))}
              </div>
            </div>
          </div>

          {/* Middleware authorization */}
          <div className="mt-3 pt-3 border-t border-neutral-200 dark:border-neutral-700">
            <div className="flex items-center justify-between gap-2">
              <div>
                <span className="inline-flex items-center gap-1 text-xs text-neutral-700 dark:text-neutral-300" title={RESTRICTED_MIDDLEWARE_TIP}>
                  <ShieldIcon size={12} filled className={PERMISSION_ON_CLASS.restricted} />
                  Restricted
                  <InfoHint tip="Middleware lambdas from files that are not authorized are skipped." />
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                {!isSectionLocked('security') && (
                  <LockButton
                    locked={isSectionLocked('security.require_middleware_authorization')}
                    size="xs"
                    onClick={() => toggleFieldLock('security.require_middleware_authorization')}
                  />
                )}
                <input
                  type="checkbox"
                  checked={local.security?.require_middleware_authorization ?? true}
                  onChange={(e) => {
                    save({
                      ...local,
                      security: { ...local.security, require_middleware_authorization: e.target.checked }
                    })
                  }}
                  className="w-4 h-4 accent-blue-500"
                />
              </div>
            </div>
          </div>
        </Section>

        {/* Triggers */}
        <Section docs={DOCS.triggers} title="Triggers" hint="Timing modes: Immediate fires instantly. Debounce resets a timer on each event and fires once after events stop. Interval fires the first event and drops others until the interval elapses. Batch collects events in a window and fires once when it expires. Values are in milliseconds." locked={isSectionLocked('triggers')} onToggleLock={() => toggleSectionLock('triggers')} summary={(() => { const t = local.triggers as TriggersConfigV3 | undefined; if (!t) return 'none'; const active = Object.values(t).filter((v: any) => v?.enabled).length; return `${active} active`; })()}>
          <Field label="Hibernate nudge" hint="Ping the agent after this many hours without a trigger while hibernating.">
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={local.limits?.hibernate_nudge?.enabled ?? true}
                  onChange={(e) => {
                    save({
                      ...local,
                      limits: {
                        ...local.limits,
                        hibernate_nudge: {
                          enabled: e.target.checked,
                          interval_ms: local.limits?.hibernate_nudge?.interval_ms ?? 86_400_000
                        }
                      }
                    })
                  }}
                  className="accent-blue-500"
                />
                <span className="text-[10px] text-neutral-500 dark:text-neutral-400">Enabled</span>
              </label>
              <input
                type="number"
                min={1}
                step={1}
                value={Math.round((local.limits?.hibernate_nudge?.interval_ms ?? 86_400_000) / 3_600_000)}
                onChange={(e) => {
                  const hours = parseInt(e.target.value)
                  if (isNaN(hours) || hours < 1) return
                  save({
                    ...local,
                    limits: {
                      ...local.limits,
                      hibernate_nudge: {
                        enabled: local.limits?.hibernate_nudge?.enabled ?? true,
                        interval_ms: hours * 3_600_000
                      }
                    }
                  })
                }}
                className="field-input w-16"
                disabled={!(local.limits?.hibernate_nudge?.enabled ?? true)}
              />
              <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">hours</span>
            </div>
          </Field>

          <div className="border-t border-neutral-200 dark:border-neutral-700" />

          {/* Trigger rows — v3 target-based */}
          {([
            { key: 'on_startup' as TriggerTypeV3, label: 'On startup', desc: 'Fires once when the agent starts.' },
            { key: 'on_inbox' as TriggerTypeV3, label: 'On inbox message', desc: 'Fires when a message arrives in the inbox.' },
            { key: 'on_outbox' as TriggerTypeV3, label: 'On outbox message', desc: 'Fires when a message is sent.' },
            { key: 'on_file_change' as TriggerTypeV3, label: 'On file change', desc: 'Fires when a watched file is modified.' },
            { key: 'on_chat' as TriggerTypeV3, label: 'On user chat', desc: 'Fires when the user sends a chat message.' },
            { key: 'on_timer' as TriggerTypeV3, label: 'On timer', desc: 'Kill switch for timer-based triggers.' },
            { key: 'on_tool_call' as TriggerTypeV3, label: 'On tool call', desc: 'Fires after a matching tool executes (observational).' },
            { key: 'on_task_create' as TriggerTypeV3, label: 'On task create', desc: 'Fires when a task is created (approval request, async dispatch).' },
            { key: 'on_task_complete' as TriggerTypeV3, label: 'On task complete', desc: 'Fires when a matching async task completes.' },
            { key: 'on_logs' as TriggerTypeV3, label: 'On log entry', desc: 'Fires when a matching log entry is written.' },
            { key: 'on_llm_call' as TriggerTypeV3, label: 'On LLM call', desc: 'Fires after model calls with tokens, latency, model, and cost metadata.' }
          ]).map(({ key, label, desc }) => {
            const triggerCfg: TriggerConfig = (local.triggers as TriggersConfigV3)?.[key] ?? { enabled: false, targets: [] }
            const noTimingTypes: TriggerTypeV3[] = ['on_timer', 'on_startup']
            const showTiming = !noTimingTypes.includes(key)
            /** Side loops available as target streams. Empty ⇒ no Loop field at all. */
            const sideLoops: LoopConfig[] = local.loops ?? []
            // One key list per trigger type — the target rows hold local input state.
            const targetKeys = triggerTargetKeys.for(key, triggerCfg.targets ?? [])

            const updateTriggerCfg = (patch: Partial<TriggerConfig>) => {
              save({
                ...local,
                triggers: {
                  ...local.triggers,
                  [key]: { ...triggerCfg, ...patch }
                }
              })
            }

            const updateTarget = (idx: number, patch: Partial<TriggerTarget>) => {
              const newTargets = [...(triggerCfg.targets ?? [])]
              newTargets[idx] = { ...newTargets[idx], ...patch }
              updateTriggerCfg({ targets: newTargets })
            }

            const updateTargetFilter = (idx: number, filterPatch: Partial<TriggerFilter>) => {
              const newTargets = [...(triggerCfg.targets ?? [])]
              const existing = newTargets[idx].filter ?? {}
              const merged = { ...existing, ...filterPatch }
              // Remove undefined/empty values
              const cleaned: TriggerFilter = {}
              if (Array.isArray(merged.source) ? merged.source.length : merged.source) cleaned.source = merged.source
              if (merged.sender) cleaned.sender = merged.sender
              if (merged.to) cleaned.to = merged.to
              if (merged.watch) cleaned.watch = merged.watch
              if (merged.tools?.length) cleaned.tools = merged.tools
              if (merged.status) cleaned.status = merged.status
              if (merged.level?.length) cleaned.level = merged.level
              if (merged.origin?.length) cleaned.origin = merged.origin
              if (merged.event?.length) cleaned.event = merged.event
              if (merged.provider?.length) cleaned.provider = merged.provider
              newTargets[idx] = { ...newTargets[idx], filter: Object.keys(cleaned).length > 0 ? cleaned : undefined }
              updateTriggerCfg({ targets: newTargets })
            }

            const addTarget = () => {
              const defaultFilter: TriggerFilter | undefined =
                key === 'on_file_change' ? { watch: 'README.*' } :
                key === 'on_tool_call' ? { tools: ['*'] } :
                key === 'on_task_create' ? { tools: ['*'] } :
                key === 'on_task_complete' ? { tools: ['*'] } :
                key === 'on_logs' ? { level: ['error'] } :
                undefined
              const newTarget: TriggerTarget = { scope: 'agent' as TriggerScopeV3, ...(defaultFilter ? { filter: defaultFilter } : {}) }
              const newTargets = [...(triggerCfg.targets ?? []), newTarget]
              targetKeys.append()
              updateTriggerCfg({ targets: newTargets })
            }

            const removeTarget = (idx: number) => {
              const newTargets = (triggerCfg.targets ?? []).filter((_, i) => i !== idx)
              targetKeys.removeAt(idx)
              updateTriggerCfg({ targets: newTargets })
            }

            return (
              <div key={key} className="space-y-1.5 pb-3 border-b border-neutral-200 dark:border-neutral-700 last:border-b-0 last:pb-0">
                <div className="flex items-center justify-between">
                  <div>
                    <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                      <span className="text-neutral-700 dark:text-neutral-300 font-medium">{label}</span>
                    </label>
                    <p className="text-[10px] text-[var(--adf-ui-text-subtle)] mt-0.5">{desc}</p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {!isSectionLocked('triggers') && (
                      <LockButton
                        locked={!!triggerCfg.locked}
                        size="xs"
                        onClick={() => updateTriggerCfg({ locked: !triggerCfg.locked || undefined })}
                      />
                    )}
                    <input
                      type="checkbox"
                      checked={triggerCfg.enabled}
                      onChange={(e) => updateTriggerCfg({ enabled: e.target.checked })}
                    />
                  </div>
                </div>
                {triggerCfg.enabled && (
                  <div className="pl-3 space-y-2 mt-1">
                    {(triggerCfg.targets ?? []).map((target, ti) => {
                      const activeTimingModifier = target.debounce_ms !== undefined ? 'debounce'
                        : target.interval_ms !== undefined ? 'interval'
                        : target.batch_ms !== undefined ? 'batch'
                        : 'none'
                      const timingValue = target.debounce_ms ?? target.interval_ms ?? target.batch_ms ?? 0

                      return (
                        <div key={targetKeys.keys[ti]} className={`rounded-md border p-2 space-y-1.5 ${target.locked ? 'border-amber-300 dark:border-amber-600 bg-amber-50/30 dark:bg-amber-900/10' : 'border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/50'}`}>
                          {/* Target header: scope + lock + remove */}
                          <div className="flex items-center gap-1.5">
                            <span className="text-[10px] text-[var(--adf-ui-text-subtle)] w-10 shrink-0">Scope</span>
                            <select
                              className="field-input text-[10px] w-20"
                              value={target.scope}
                              onChange={(e) => updateTarget(ti, { scope: e.target.value as TriggerScopeV3, lambda: e.target.value === 'agent' ? undefined : target.lambda, warm: e.target.value === 'agent' ? undefined : target.warm })}
                            >
                              <option value="agent">Agent</option>
                              <option value="system">System</option>
                            </select>
                            <div className="ml-auto flex items-center gap-1">
                              {!triggerCfg.locked && (
                                <LockButton
                                  locked={!!target.locked}
                                  size="xs"
                                  onClick={() => updateTarget(ti, { locked: !target.locked || undefined })}
                                />
                              )}
                            </div>
                            <button
                              className="text-[10px] shrink-0 text-red-400 hover:text-red-600 dark:hover:text-red-300"
                              onClick={() => {
                                if (target.locked && !window.confirm('This target is locked. Remove it?')) return
                                removeTarget(ti)
                              }}
                              title="Remove target"
                            >
                              ×
                            </button>
                          </div>
                          {/* Target loop — only meaningful once side loops exist */}
                          {sideLoops.length > 0 && (
                            <div className="flex items-center gap-1.5">
                              <span className="text-[10px] text-[var(--adf-ui-text-subtle)] w-10 shrink-0">Loop</span>
                              <select
                                className="field-input text-[10px] w-32"
                                value={target.loop ?? 'main'}
                                onChange={(e) => updateTarget(ti, { loop: e.target.value === 'main' ? undefined : e.target.value })}
                                title="Cognition stream this target wakes. Main is the membrane-facing loop."
                              >
                                <option value="main">main</option>
                                {sideLoops.map((l) => (
                                  <option key={l.name} value={l.name}>
                                    {l.name}{l.enabled === false ? ' (disabled)' : ''}
                                  </option>
                                ))}
                                {target.loop && !sideLoops.some((l) => l.name === target.loop) && (
                                  <option value={target.loop}>{target.loop} (not declared)</option>
                                )}
                              </select>
                              {target.loop && target.scope === 'system' && (
                                <span className="text-[10px] text-amber-600 dark:text-amber-400">
                                  System-scope targets never reach an inner loop
                                </span>
                              )}
                            </div>
                          )}

                          {/* Lambda — system scope only, not for on_timer (kill switch only) */}
                          {target.scope === 'system' && key !== 'on_timer' && (
                            <>
                              <div className="flex items-center gap-1.5">
                                <span className="text-[10px] text-[var(--adf-ui-text-subtle)] w-10 shrink-0">Lambda</span>
                                <input
                                  type="text"
                                  className="field-input text-[10px] flex-1"
                                  placeholder="path/file.ts:functionName"
                                  value={target.lambda ?? ''}
                                  onChange={(e) => updateTarget(ti, { lambda: e.target.value || undefined })}
                                />
                              </div>
                              <div className="flex items-center gap-1.5">
                                <span className="text-[10px] text-[var(--adf-ui-text-subtle)] w-10 shrink-0">Warm</span>
                                <label className="flex items-center gap-1 text-[10px] text-neutral-500 dark:text-neutral-400 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={target.warm ?? false}
                                    onChange={(e) => updateTarget(ti, { warm: e.target.checked || undefined })}
                                    className="rounded border-neutral-300 dark:border-neutral-600"
                                  />
                                  Keep sandbox worker alive between invocations
                                </label>
                              </div>
                            </>
                          )}

                          {/* Filter fields — vary by trigger type */}
                          {key === 'on_inbox' && (
                            <div className="flex items-center gap-1.5">
                              <span className="text-[10px] text-[var(--adf-ui-text-subtle)] w-10 shrink-0">Filter</span>
                              <input
                                type="text"
                                className="field-input text-[10px] w-24"
                                placeholder="sender"
                                value={target.filter?.sender ?? ''}
                                onChange={(e) => updateTargetFilter(ti, { sender: e.target.value || undefined })}
                              />
                              <input
                                type="text"
                                className="field-input text-[10px] w-24"
                                placeholder="source"
                                value={typeof target.filter?.source === 'string' ? target.filter.source : ''}
                                onChange={(e) => updateTargetFilter(ti, { source: e.target.value || undefined })}
                              />
                            </div>
                          )}

                          {key === 'on_outbox' && (
                            <div className="flex items-center gap-1.5">
                              <span className="text-[10px] text-[var(--adf-ui-text-subtle)] w-10 shrink-0">Filter</span>
                              <input
                                type="text"
                                className="field-input text-[10px] flex-1"
                                placeholder="to (recipient)"
                                value={target.filter?.to ?? ''}
                                onChange={(e) => updateTargetFilter(ti, { to: e.target.value || undefined })}
                              />
                            </div>
                          )}

                          {key === 'on_file_change' && (
                            <div className="flex items-center gap-1.5">
                              <span className="text-[10px] text-[var(--adf-ui-text-subtle)] w-10 shrink-0">Watch</span>
                              <input
                                type="text"
                                className="field-input text-[10px] flex-1"
                                placeholder="glob pattern, e.g. README.*"
                                value={target.filter?.watch ?? ''}
                                onChange={(e) => updateTargetFilter(ti, { watch: e.target.value || undefined })}
                              />
                            </div>
                          )}

                          {key === 'on_tool_call' && (
                            <div className="flex items-center gap-1.5">
                              <span className="text-[10px] text-[var(--adf-ui-text-subtle)] w-10 shrink-0">Tools</span>
                              <CommaSepInput
                                className="field-input text-[10px] flex-1"
                                placeholder="tool globs, comma-separated (e.g. fs_*, msg_send)"
                                value={target.filter?.tools ?? []}
                                onChange={(tools) => updateTargetFilter(ti, { tools: tools.length > 0 ? tools : undefined })}
                              />
                            </div>
                          )}

                          {key === 'on_task_create' && (
                            <div className="flex items-center gap-1.5">
                              <span className="text-[10px] text-[var(--adf-ui-text-subtle)] w-10 shrink-0">Tools</span>
                              <CommaSepInput
                                className="field-input text-[10px] flex-1"
                                placeholder="tool globs, comma-separated (e.g. fs_*, msg_send)"
                                value={target.filter?.tools ?? []}
                                onChange={(tools) => updateTargetFilter(ti, { tools: tools.length > 0 ? tools : undefined })}
                              />
                            </div>
                          )}

                          {key === 'on_task_complete' && (
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="text-[10px] text-[var(--adf-ui-text-subtle)] w-10 shrink-0">Filter</span>
                              <CommaSepInput
                                className="field-input text-[10px] w-36"
                                placeholder="tools (comma-sep globs)"
                                value={target.filter?.tools ?? []}
                                onChange={(tools) => updateTargetFilter(ti, { tools: tools.length > 0 ? tools : undefined })}
                              />
                              <input
                                type="text"
                                className="field-input text-[10px] w-24"
                                placeholder="status"
                                value={target.filter?.status ?? ''}
                                onChange={(e) => updateTargetFilter(ti, { status: e.target.value || undefined })}
                              />
                            </div>
                          )}

                          {key === 'on_logs' && (
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="text-[10px] text-[var(--adf-ui-text-subtle)] w-10 shrink-0">Filter</span>
                              <CommaSepInput
                                className="field-input text-[10px] w-28"
                                placeholder="level (comma-sep)"
                                value={target.filter?.level ?? []}
                                onChange={(level) => updateTargetFilter(ti, { level: level.length > 0 ? level : undefined })}
                              />
                              <CommaSepInput
                                className="field-input text-[10px] w-28"
                                placeholder="origin (globs)"
                                value={target.filter?.origin ?? []}
                                onChange={(origin) => updateTargetFilter(ti, { origin: origin.length > 0 ? origin : undefined })}
                              />
                              <CommaSepInput
                                className="field-input text-[10px] w-28"
                                placeholder="event (globs)"
                                value={target.filter?.event ?? []}
                                onChange={(event) => updateTargetFilter(ti, { event: event.length > 0 ? event : undefined })}
                              />
                            </div>
                          )}

                          {key === 'on_llm_call' && (
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="text-[10px] text-[var(--adf-ui-text-subtle)] w-10 shrink-0">Filter</span>
                              <CommaSepInput
                                className="field-input text-[10px] w-36"
                                placeholder="sources (turn, compaction)"
                                value={Array.isArray(target.filter?.source) ? target.filter.source : []}
                                onChange={(source) => updateTargetFilter(ti, { source: source.length > 0 ? source : undefined })}
                              />
                              <CommaSepInput
                                className="field-input text-[10px] w-36"
                                placeholder="providers (comma-sep)"
                                value={target.filter?.provider ?? []}
                                onChange={(provider) => updateTargetFilter(ti, { provider: provider.length > 0 ? provider : undefined })}
                              />
                            </div>
                          )}

                          {/* Timing modifier */}
                          {showTiming && (
                            <div className="flex items-center gap-1.5">
                              <span className="text-[10px] text-[var(--adf-ui-text-subtle)] w-10 shrink-0">Timing</span>
                              <select
                                className="field-input text-[10px] w-20"
                                value={activeTimingModifier}
                                onChange={(e) => {
                                  const mod = e.target.value
                                  const patch: Partial<TriggerTarget> = {
                                    debounce_ms: undefined,
                                    interval_ms: undefined,
                                    batch_ms: undefined,
                                    batch_count: undefined
                                  }
                                  if (mod === 'debounce') patch.debounce_ms = 2000
                                  else if (mod === 'interval') patch.interval_ms = 30000
                                  else if (mod === 'batch') patch.batch_ms = 50
                                  updateTarget(ti, patch)
                                }}
                              >
                                <option value="none">Immediate</option>
                                <option value="debounce">Debounce</option>
                                <option value="interval">Interval</option>
                                <option value="batch">Batch</option>
                              </select>
                              {activeTimingModifier !== 'none' && (
                                <>
                                  <input
                                    type="number"
                                    min={0}
                                    step={500}
                                    value={timingValue}
                                    onChange={(e) => {
                                      const val = parseInt(e.target.value)
                                      const msKey = `${activeTimingModifier}_ms` as keyof TriggerTarget
                                      updateTarget(ti, { debounce_ms: undefined, interval_ms: undefined, batch_ms: undefined, batch_count: undefined, [msKey]: isNaN(val) ? undefined : val })
                                    }}
                                    className="field-input w-16 text-[10px]"
                                  />
                                  <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">ms</span>
                                  {activeTimingModifier === 'batch' && (
                                    <>
                                      <input
                                        type="number"
                                        min={1}
                                        step={1}
                                        value={target.batch_count ?? ''}
                                        placeholder="N"
                                        onChange={(e) => {
                                          const val = parseInt(e.target.value)
                                          updateTarget(ti, { batch_count: isNaN(val) || val < 1 ? undefined : val })
                                        }}
                                        className="field-input w-12 text-[10px]"
                                        title="Fire batch early when N events accumulate"
                                      />
                                      <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">count</span>
                                    </>
                                  )}
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                    <button
                      className="text-[10px] text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300"
                      onClick={addTarget}
                    >
                      + Add target
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </Section>

        {/* Hooks run inside work already underway; they are not event triggers. */}
        <Section
          docs={DOCS.preLlmHook}
          title="Hooks"
          hint="Triggers react to events and start work. Hooks run inside work already underway; the pre-LLM hook transforms the request before the model call continues."
          locked={isSectionLocked('pre_llm_hook')}
          onToggleLock={() => toggleSectionLock('pre_llm_hook')}
          summary={local.pre_llm_hook
            ? local.pre_llm_hook.scope === 'all'
              ? 'all streams'
              : local.pre_llm_hook.scope === 'main'
                ? 'Main'
                : `${(local.pre_llm_hook.include_main ? 1 : 0) + (local.pre_llm_hook.loops?.length ?? 0)} targets`
            : 'not configured'}
          defaultCollapsed
          testId="pre-llm-hook-section"
        >
          <div data-testid="pre-llm-hook-fields" className="space-y-2">
            <div className="flex items-center gap-2 border-b border-neutral-200 dark:border-neutral-700 pb-1">
              <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">Pre-LLM call</span>
              <InfoHint tip="Runs immediately before each normal conversational provider request, including tool rounds. It does not run for compaction or direct model_invoke calls." />
              <DocsLink href={DOCS.preLlmHook} label="Guide" className="ml-auto" />
            </div>
            <p className="text-[10px] text-neutral-500 dark:text-neutral-400">
              Modify LLM calls before they are sent.
            </p>
            <Field label="Lambda source" hint="Use a workspace .js or .ts path, optionally followed by :functionName. Without a function name, main is used.">
              <input
                data-testid="pre-llm-hook-source"
                type="text"
                value={preLlmHookDraft.source}
                onChange={(e) => setPreLlmHookDraft((draft) => ({ ...draft, source: e.target.value }))}
                placeholder="lib/request-policy.ts:transform"
                className="field-input w-full font-mono"
                aria-label="Pre-LLM hook lambda source"
              />
            </Field>

            <Field label="Targets" hint="New hooks start on Main. Add specific inner loops as rows, or choose All streams (including future loops); All streams cannot be combined with specific targets.">
              <div data-testid="pre-llm-hook-targets" className="rounded-md border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/50 p-2 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-neutral-500 dark:text-neutral-400">Runs before the selected model calls</span>
                  <button
                    type="button"
                    data-testid="pre-llm-hook-add-target"
                    onClick={() => setPreLlmHookDraft((draft) => ({
                      ...draft,
                      targetMode: 'targets',
                      targets: draft.targetMode === 'all' ? [PRE_LLM_HOOK_MAIN_TARGET, ''] : [...draft.targets, ''],
                    }))}
                    className="text-[10px] text-blue-500 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 font-medium"
                  >
                    + Add target
                  </button>
                </div>
                {preLlmHookDraft.targetMode === 'all' ? (
                  <div className="flex items-center gap-1.5 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 p-1.5">
                    <span className="text-[10px] text-[var(--adf-ui-text-subtle)] w-12 shrink-0">Target</span>
                    <select
                      data-testid="pre-llm-hook-target-0"
                      value="__all_streams__"
                      onChange={(e) => {
                        const value = e.target.value
                        if (value === '__all_streams__') return
                        setPreLlmHookDraft((draft) => ({
                          ...draft,
                          targetMode: 'targets',
                          targets: [value === '__future__' ? '' : value],
                        }))
                      }}
                      className="field-input text-[10px] flex-1"
                      aria-label="Hook target"
                    >
                      <option value="__all_streams__">All streams (including future loops)</option>
                      <option value={PRE_LLM_HOOK_MAIN_TARGET}>Main</option>
                      {(local.loops ?? []).map((loop) => <option key={loop.name} value={loop.name}>{loop.name}</option>)}
                      <option value="__future__">Future or other loop…</option>
                    </select>
                  </div>
                ) : (
                  preLlmHookDraft.targets.map((target, index) => {
                    const declaredLoops = local.loops ?? []
                    const isMain = target === PRE_LLM_HOOK_MAIN_TARGET
                    const isDeclared = declaredLoops.some((loop) => loop.name === target)
                    const isCustom = !isMain && !isDeclared
                    const selectValue = target === '' ? '__future__' : target
                    return (
                      <div key={`pre-llm-hook-target-${index}`} className="min-w-0 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 p-1.5 space-y-1">
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                          <span className="text-[10px] text-[var(--adf-ui-text-subtle)] w-12 shrink-0">Target</span>
                          <select
                            data-testid={`pre-llm-hook-target-${index}`}
                            value={selectValue}
                            onChange={(e) => {
                              const value = e.target.value
                              if (value === '__all_streams__') {
                                setPreLlmHookDraft((draft) => ({ ...draft, targetMode: 'all', targets: [] }))
                                return
                              }
                              setPreLlmHookDraft((draft) => ({
                                ...draft,
                                targets: draft.targets.map((entry, i) => i === index ? (value === '__future__' ? '' : value) : entry),
                              }))
                            }}
                            className="field-input text-[10px] min-w-0 flex-1"
                            aria-label={`Hook target ${index + 1}`}
                          >
                            <option value="">Choose a loop…</option>
                            <option value="__all_streams__">All streams (including future loops)</option>
                            <option value={PRE_LLM_HOOK_MAIN_TARGET}>Main</option>
                            {declaredLoops.map((loop) => <option key={loop.name} value={loop.name}>{loop.name}</option>)}
                            {isCustom && target && <option value={target}>{target} (not declared)</option>}
                            <option value="__future__">Future or other loop…</option>
                          </select>
                          <button
                            type="button"
                            onClick={() => setPreLlmHookDraft((draft) => ({ ...draft, targets: draft.targets.filter((_, i) => i !== index) }))}
                            className="text-xs text-red-400 hover:text-red-600 dark:hover:text-red-300 px-1"
                            aria-label={`Remove hook target ${index + 1}`}
                          >
                            &times;
                          </button>
                        </div>
                        {(target === '' || isCustom) && (
                          <div className="min-w-0 pl-[3.35rem]">
                          <input
                            data-testid={`pre-llm-hook-target-name-${index}`}
                            type="text"
                            value={target}
                            onChange={(e) => setPreLlmHookDraft((draft) => ({ ...draft, targets: draft.targets.map((entry, i) => i === index ? e.target.value : entry) }))}
                            placeholder="future-loop-name"
                            className="field-input text-[10px] w-full min-w-0 max-w-full box-border font-mono"
                            aria-label={`Future hook target name ${index + 1}`}
                          />
                          </div>
                        )}
                      </div>
                    )
                  })
                )}
                {preLlmHookDraft.targetMode === 'targets' && preLlmHookDraft.targets.length === 0 && (
                  <p className="text-[10px] text-[var(--adf-ui-text-subtle)]">Add Main or an inner-loop target.</p>
                )}
              </div>
            </Field>

            <Field label="Timeout (optional, milliseconds)" hint="Whole number from 1000 to 300000 ms. The runtime also caps this by limits.execution_timeout_ms.">
              <input
                data-testid="pre-llm-hook-timeout"
                type="text"
                inputMode="numeric"
                value={preLlmHookDraft.timeout_ms}
                onChange={(e) => setPreLlmHookDraft((draft) => ({ ...draft, timeout_ms: e.target.value }))}
                placeholder="Inherit execution timeout"
                className="field-input w-full"
                aria-label="Pre-LLM hook timeout in milliseconds"
              />
            </Field>

            {preLlmHookErrors.length > 0 && (
              <div data-testid="pre-llm-hook-errors" role="alert" className="rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-2 py-1.5 text-[10px] text-red-600 dark:text-red-300 space-y-0.5">
                {preLlmHookErrors.map((error) => <p key={error}>{error}</p>)}
              </div>
            )}

            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                data-testid="pre-llm-hook-save"
                onClick={savePreLlmHook}
                className="px-2.5 py-1 text-[10px] rounded-md border border-[var(--adf-ui-border)] bg-[var(--adf-ui-canvas)] text-[var(--adf-ui-text)] hover:bg-[var(--adf-ui-surface-hover)] font-medium"
              >
                {local.pre_llm_hook ? 'Save changes' : 'Save hook'}
              </button>
              {local.pre_llm_hook && (
                <button
                  type="button"
                  data-testid="pre-llm-hook-remove"
                  onClick={removePreLlmHook}
                  className="px-2.5 py-1 text-[10px] rounded-md border border-red-200 dark:border-red-800 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 font-medium"
                >
                  Remove hook
                </button>
              )}
              {!local.pre_llm_hook && <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">Not configured</span>}
            </div>
          </div>
        </Section>

        {/* Serving (HTTP) */}
        <Section docs={DOCS.serving} title="Serving" locked={isSectionLocked('serving')} onToggleLock={() => toggleSectionLock('serving')} summary={`${(local.serving?.api ?? []).length} routes${local.serving?.public?.enabled ? ', public' : ''}`} defaultCollapsed>
          {/* Handle */}
          {!template && (
          <Field label="Handle">
            <input
              type="text"
              value={local.handle ?? ''}
              onChange={(e) => {
                const val = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '')
                save({ ...local, handle: val || undefined })
              }}
              placeholder={filePath ? filePath.replace(/.*[\\/]/, '').replace(/\.adf$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') : 'agent'}
              className="field-input w-full"
            />
            <p className="text-[10px] text-[var(--adf-ui-text-subtle)] mt-0.5">
              URL slug — defaults to filename if blank
            </p>
          </Field>
          )}

          {/* Reply-To URL */}
          <Field label="Reply-To URL" hint="Override the default reply address for outbound messages.">
            <input
              type="text"
              value={local.reply_to ?? ''}
              onChange={(e) => {
                save({ ...local, reply_to: e.target.value || undefined })
              }}
              placeholder="http://host:port/agents/handle/inbox"
              className="field-input w-full font-mono"
            />
          </Field>

          {/* Public serving */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={local.serving?.public?.enabled ?? false}
              onChange={(e) => {
                const enabled = e.target.checked
                save({
                  ...local,
                  serving: {
                    ...(local.serving ?? {}),
                    public: { ...(local.serving?.public ?? { enabled: false }), enabled }
                  }
                })
              }}
              className="rounded text-blue-500"
            />
            <span className="text-xs text-neutral-600 dark:text-neutral-300">Serve public/ folder</span>
          </label>
          {local.serving?.public?.enabled && (
            <Field label="Index file">
              <input
                type="text"
                value={local.serving?.public?.index ?? ''}
                onChange={(e) => {
                  save({
                    ...local,
                    serving: {
                      ...(local.serving ?? {}),
                      public: { ...(local.serving?.public ?? { enabled: true }), index: e.target.value || undefined }
                    }
                  })
                }}
                placeholder="index.html"
                className="field-input w-full"
              />
            </Field>
          )}

          {/* Shared files */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={local.serving?.shared?.enabled ?? false}
              onChange={(e) => {
                const enabled = e.target.checked
                save({
                  ...local,
                  serving: {
                    ...(local.serving ?? {}),
                    shared: { ...(local.serving?.shared ?? { enabled: false }), enabled }
                  }
                })
              }}
              className="rounded text-blue-500"
            />
            <span className="text-xs text-neutral-600 dark:text-neutral-300">Enable shared file serving</span>
          </label>
          {local.serving?.shared?.enabled && (
            <Field label="Shared patterns" hint="Files accessible over HTTP. Glob patterns, one per line.">
              <textarea
                value={(local.serving?.shared?.patterns ?? []).join('\n')}
                onChange={(e) => {
                  const patterns = e.target.value.split('\n').map(s => s.trim()).filter(Boolean)
                  save({
                    ...local,
                    serving: {
                      ...(local.serving ?? {}),
                      shared: { ...(local.serving?.shared ?? { enabled: true }), patterns: patterns.length > 0 ? patterns : undefined }
                    }
                  })
                }}
                rows={3}
                placeholder="data/*.json&#10;reports/**/*.csv"
                className="w-full px-2 py-1.5 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400 resize-y"
              />
            </Field>
          )}

          {/* API Routes */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs text-neutral-500 dark:text-neutral-400">API Routes</label>
              <button
                onClick={() => {
                  const api = [...(local.serving?.api ?? []), { method: 'GET' as const, path: '/', lambda: '', warm: false }]
                  apiRouteKeys.append()
                  save({
                    ...local,
                    serving: { ...(local.serving ?? {}), api }
                  })
                }}
                className="text-[11px] text-blue-500 hover:text-blue-700 font-medium"
              >
                + Add route
              </button>
            </div>
            {(local.serving?.api ?? []).map((route, i) => (
              <div key={apiRouteKeys.keys[i]} className={`mb-2 p-2 rounded border space-y-1.5 ${route.locked ? 'border-amber-300 dark:border-amber-600 bg-amber-50/30 dark:bg-amber-900/10' : 'border-neutral-200 dark:border-neutral-700'}`}>
                <div className="flex gap-1.5 items-center min-w-0">
                  <select
                    value={route.method}
                    onChange={(e) => {
                      const api = [...(local.serving?.api ?? [])]
                      api[i] = { ...api[i], method: e.target.value as ServingApiRoute['method'] }
                      save({ ...local, serving: { ...(local.serving ?? {}), api } })
                    }}
                    className="shrink-0 px-1.5 py-1 text-xs border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                  >
                    {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'WS'].map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={route.path}
                    onChange={(e) => {
                      const api = [...(local.serving?.api ?? [])]
                      api[i] = { ...api[i], path: e.target.value }
                      save({ ...local, serving: { ...(local.serving ?? {}), api } })
                    }}
                    placeholder="/status"
                    className="flex-1 min-w-0 px-2 py-1 text-xs border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                  />
                  <LockButton
                    locked={!!route.locked}
                    size="xs"
                    onClick={() => {
                      const api = [...(local.serving?.api ?? [])]
                      api[i] = { ...api[i], locked: !route.locked || undefined }
                      save({ ...local, serving: { ...(local.serving ?? {}), api } })
                    }}
                  />
                  <button
                    onClick={() => {
                      if (route.locked && !window.confirm('This route is locked. Remove it?')) return
                      const api = (local.serving?.api ?? []).filter((_, j) => j !== i)
                      apiRouteKeys.removeAt(i)
                      save({ ...local, serving: { ...(local.serving ?? {}), api: api.length > 0 ? api : undefined } })
                    }}
                    className="text-xs shrink-0 px-1 text-red-400 hover:text-red-600"
                  >
                    &times;
                  </button>
                </div>
                <div className="flex gap-1.5 items-center">
                  <input
                    type="text"
                    value={route.lambda}
                    onChange={(e) => {
                      const api = [...(local.serving?.api ?? [])]
                      api[i] = { ...api[i], lambda: e.target.value }
                      save({ ...local, serving: { ...(local.serving ?? {}), api } })
                    }}
                    placeholder="lib/api.ts:handler"
                    className="flex-1 px-2 py-1 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                  />
                </div>
                {route.method === 'WS' && (
                  <>
                    <div className="text-[10px] text-amber-500 dark:text-amber-400">
                      WebSocket route — lambda is required. Receives WsLambdaEvent on open/message/close/error.
                    </div>
                    <label className="flex items-center gap-1 cursor-pointer shrink-0">
                      <input
                        type="checkbox"
                        checked={route.on_card ?? false}
                        onChange={(e) => {
                          const api = [...(local.serving?.api ?? [])]
                          api[i] = { ...api[i], on_card: e.target.checked || undefined }
                          save({ ...local, serving: { ...(local.serving ?? {}), api } })
                        }}
                        className="rounded text-blue-500"
                      />
                      <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">Include on Agent Card</span>
                    </label>
                  </>
                )}
                {route.method !== 'WS' && (
                  <>
                    <div className="flex gap-3 items-center">
                      <label className="flex items-center gap-1 cursor-pointer shrink-0">
                        <input
                          type="checkbox"
                          checked={route.warm ?? false}
                          onChange={(e) => {
                            const api = [...(local.serving?.api ?? [])]
                            api[i] = { ...api[i], warm: e.target.checked || undefined }
                            save({ ...local, serving: { ...(local.serving ?? {}), api } })
                          }}
                          className="rounded text-blue-500"
                        />
                        <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">warm</span>
                      </label>
                      {route.method === 'GET' && (
                        <label className="flex items-center gap-1 shrink-0">
                          <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">cache</span>
                          <input
                            type="number"
                            min={0}
                            value={route.cache_ttl_ms ?? ''}
                            onChange={(e) => {
                              const api = [...(local.serving?.api ?? [])]
                              const val = parseInt(e.target.value, 10)
                              api[i] = { ...api[i], cache_ttl_ms: val > 0 ? val : undefined }
                              save({ ...local, serving: { ...(local.serving ?? {}), api } })
                            }}
                            placeholder="TTL ms"
                            className="w-16 px-1 py-0.5 text-[10px] border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded focus:outline-none focus:border-blue-400"
                          />
                        </label>
                      )}
                      <label className="flex items-center gap-1 cursor-pointer shrink-0">
                        <input
                          type="checkbox"
                          checked={route.on_card ?? false}
                          onChange={(e) => {
                            const api = [...(local.serving?.api ?? [])]
                            api[i] = { ...api[i], on_card: e.target.checked || undefined }
                            save({ ...local, serving: { ...(local.serving ?? {}), api } })
                          }}
                          className="rounded text-blue-500"
                        />
                        <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">Include on Agent Card</span>
                      </label>
                    </div>
                    {/* Per-route list: its keys hang off the route's own row key. */}
                    {(() => {
                    const mwKeys = routeMwKeys.for(apiRouteKeys.keys[i], route.middleware ?? [])
                    return (
                    <div>
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">middleware</span>
                        <button
                          onClick={() => {
                            const api = [...(local.serving?.api ?? [])]
                            const mw = [...(route.middleware ?? []), { lambda: '' }]
                            api[i] = { ...api[i], middleware: mw }
                            mwKeys.append()
                            save({ ...local, serving: { ...(local.serving ?? {}), api } })
                          }}
                          className="text-[10px] text-blue-500 hover:text-blue-700 font-medium"
                        >
                          + Add
                        </button>
                      </div>
                      {(route.middleware ?? []).map((ref, j) => (
                        <div key={mwKeys.keys[j]} className="flex gap-1 items-center mb-1">
                          <input
                            type="text"
                            value={ref.lambda}
                            onChange={(e) => {
                              const api = [...(local.serving?.api ?? [])]
                              const mw = [...(route.middleware ?? [])]
                              mw[j] = { lambda: e.target.value }
                              api[i] = { ...api[i], middleware: mw }
                              save({ ...local, serving: { ...(local.serving ?? {}), api } })
                            }}
                            placeholder="lib/auth.ts:checkToken"
                            className="flex-1 px-2 py-1 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                          />
                          <button
                            onClick={() => {
                              const api = [...(local.serving?.api ?? [])]
                              const mw = (route.middleware ?? []).filter((_, k) => k !== j)
                              api[i] = { ...api[i], middleware: mw.length > 0 ? mw : undefined }
                              mwKeys.removeAt(j)
                              save({ ...local, serving: { ...(local.serving ?? {}), api } })
                            }}
                            className="text-xs text-red-400 hover:text-red-600 px-1"
                          >
                            &times;
                          </button>
                        </div>
                      ))}
                    </div>
                    )
                    })()}
                  </>
                )}
              </div>
            ))}
          </div>

          {/* URL preview */}
          {meshServerStatus.running && (() => {
            const derivedHandle = local.handle || (filePath ? filePath.replace(/.*[\\/]/, '').replace(/\.adf$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') : 'agent')
            const displayHost = meshServerStatus.host === '0.0.0.0' ? '127.0.0.1' : meshServerStatus.host
            const url = `http://${displayHost}:${meshServerStatus.port}/agents/${derivedHandle}`
            return (
              <div className="mt-1">
                <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-0.5">Endpoint URL</label>
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-blue-500 hover:text-blue-700 font-mono break-all"
                >
                  {url}
                </a>
              </div>
            )
          })()}
        </Section>

        {/* WebSocket Connections (outbound) */}
        <Section docs={DOCS.websocket} hint="Outbound WebSocket connections to remote agents. Useful for NAT traversal and persistent messaging." title="WebSocket Connections" summary={`${(local.ws_connections ?? []).length} connections`} defaultCollapsed>
          <div className="flex items-center justify-between mb-1">
            <label className="block text-xs text-neutral-500 dark:text-neutral-400">Connections</label>
            <button
              onClick={() => {
                const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
                const suffix = Array.from({ length: 3 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
                const wsConns = [...(local.ws_connections ?? []), {
                  id: `ws-${suffix}`,
                  url: '',
                  enabled: true
                } as WsConnectionConfig]
                wsConnKeys.append()
                save({ ...local, ws_connections: wsConns })
              }}
              className="text-[11px] text-blue-500 hover:text-blue-700 font-medium"
            >
              + Add connection
            </button>
          </div>
          {(local.ws_connections ?? []).map((conn, i) => (
            <div key={wsConnKeys.keys[i]} className="mb-2 p-2 rounded border border-neutral-200 dark:border-neutral-700 space-y-1.5">
              <div className="flex gap-1.5 items-center">
                <label className="flex items-center gap-1 cursor-pointer shrink-0">
                  <input
                    type="checkbox"
                    checked={conn.enabled}
                    onChange={(e) => {
                      const wsConns = [...(local.ws_connections ?? [])]
                      wsConns[i] = { ...wsConns[i], enabled: e.target.checked }
                      save({ ...local, ws_connections: wsConns })
                    }}
                    className="rounded text-blue-500"
                  />
                </label>
                <input
                  type="text"
                  value={conn.id}
                  onChange={(e) => {
                    const wsConns = [...(local.ws_connections ?? [])]
                    wsConns[i] = { ...wsConns[i], id: e.target.value }
                    save({ ...local, ws_connections: wsConns })
                  }}
                  placeholder="connection-id"
                  className="flex-1 px-2 py-1 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                />
                <button
                  onClick={() => {
                    const wsConns = (local.ws_connections ?? []).filter((_, j) => j !== i)
                    wsConnKeys.removeAt(i)
                    save({ ...local, ws_connections: wsConns.length > 0 ? wsConns : undefined })
                  }}
                  className="text-xs text-red-400 hover:text-red-600 px-1"
                >
                  &times;
                </button>
              </div>
              <div className="flex gap-1.5 items-center">
                <input
                  type="text"
                  value={conn.url}
                  onChange={(e) => {
                    const wsConns = [...(local.ws_connections ?? [])]
                    wsConns[i] = { ...wsConns[i], url: e.target.value }
                    save({ ...local, ws_connections: wsConns })
                  }}
                  placeholder="wss://host/agent/live"
                  className="flex-1 px-2 py-1 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                />
              </div>
              <div className="flex gap-1.5 items-center">
                <input
                  type="text"
                  value={conn.did ?? ''}
                  onChange={(e) => {
                    const wsConns = [...(local.ws_connections ?? [])]
                    wsConns[i] = { ...wsConns[i], did: e.target.value || undefined }
                    save({ ...local, ws_connections: wsConns })
                  }}
                  placeholder="did:key:z6Mk... (expected remote DID, optional)"
                  className="flex-1 px-2 py-1 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                />
              </div>
              <div className="flex gap-1.5 items-center">
                <input
                  type="text"
                  value={conn.lambda ?? ''}
                  onChange={(e) => {
                    const wsConns = [...(local.ws_connections ?? [])]
                    wsConns[i] = { ...wsConns[i], lambda: e.target.value || undefined }
                    save({ ...local, ws_connections: wsConns })
                  }}
                  placeholder="lib/ws-handler.ts:onEvent (hot-path lambda, optional)"
                  className="flex-1 px-2 py-1 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                />
              </div>
              <div className="flex gap-3 items-center flex-wrap">
                <label className="flex items-center gap-1 cursor-pointer shrink-0">
                  <input
                    type="checkbox"
                    checked={conn.auto_reconnect ?? true}
                    onChange={(e) => {
                      const wsConns = [...(local.ws_connections ?? [])]
                      wsConns[i] = { ...wsConns[i], auto_reconnect: e.target.checked }
                      save({ ...local, ws_connections: wsConns })
                    }}
                    className="rounded text-blue-500"
                  />
                  <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">auto-reconnect</span>
                </label>
                <label className="flex items-center gap-1 shrink-0">
                  <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">reconnect</span>
                  <input
                    type="number"
                    min={1000}
                    step={1000}
                    value={conn.reconnect_delay_ms ?? ''}
                    onChange={(e) => {
                      const wsConns = [...(local.ws_connections ?? [])]
                      const val = parseInt(e.target.value, 10)
                      wsConns[i] = { ...wsConns[i], reconnect_delay_ms: val > 0 ? val : undefined }
                      save({ ...local, ws_connections: wsConns })
                    }}
                    placeholder="5000"
                    className="w-16 px-1 py-0.5 text-[10px] border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded focus:outline-none focus:border-blue-400"
                  />
                  <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">ms</span>
                </label>
                <label className="flex items-center gap-1 shrink-0">
                  <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">keepalive</span>
                  <input
                    type="number"
                    min={5000}
                    step={5000}
                    value={conn.keepalive_interval_ms ?? ''}
                    onChange={(e) => {
                      const wsConns = [...(local.ws_connections ?? [])]
                      const val = parseInt(e.target.value, 10)
                      wsConns[i] = { ...wsConns[i], keepalive_interval_ms: val > 0 ? val : undefined }
                      save({ ...local, ws_connections: wsConns })
                    }}
                    placeholder="30000"
                    className="w-16 px-1 py-0.5 text-[10px] border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded focus:outline-none focus:border-blue-400"
                  />
                  <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">ms</span>
                </label>
              </div>
            </div>
          ))}
        </Section>

        {/* Stream Bindings */}
        <Section docs={DOCS.streamBindings} hint="Runtime-managed byte pipes between WebSocket, TCP, process, and umbilical endpoints. Imperative binds are ephemeral; declared binds materialize when their dependencies are available."
          title="Stream Bindings"
          locked={isSectionLocked('stream_bind') || isSectionLocked('stream_bindings')}
          onToggleLock={() => toggleFieldLock('stream_bind', ['stream_bindings'])}
          summary={`${(local.stream_bindings ?? []).length} declarations`}
          defaultCollapsed
        >

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2">
            {([
              ['host_process_bind', 'host processes'],
              ['container_shared_bind', 'shared container'],
              ['container_isolated_bind', 'isolated containers'],
              ['allow_tcp_bind', 'TCP targets'],
            ] as const).map(([key, label]) => (
              <label key={key} className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300">
                <input
                  type="checkbox"
                  checked={local.stream_bind?.[key] ?? false}
                  onChange={(e) => {
                    save({
                      ...local,
                      stream_bind: {
                        ...(local.stream_bind ?? {}),
                        [key]: e.target.checked,
                      }
                    })
                  }}
                  className="rounded text-blue-500"
                />
                <span>{label}</span>
              </label>
            ))}
          </div>

          {local.stream_bind?.allow_tcp_bind && (
            <div className="mb-2">
              <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-0.5">TCP allowlist</label>
              <textarea
                defaultValue={formatTcpAllowlist(local.stream_bind?.tcp_allowlist)}
                onBlur={(e) => {
                  const rules = parseTcpAllowlist(e.target.value)
                  save({
                    ...local,
                    stream_bind: {
                      ...(local.stream_bind ?? {}),
                      allow_tcp_bind: true,
                      tcp_allowlist: rules.length > 0 ? rules : undefined,
                    }
                  })
                }}
                placeholder={'127.0.0.1:9000\nexample.com:8000-9000'}
                className="w-full min-h-[56px] px-2 py-1 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
              />
            </div>
          )}

          <div className="flex items-center justify-between mb-1">
            <label className="block text-xs text-neutral-500 dark:text-neutral-400">Declarations</label>
            <button
              onClick={() => {
                const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
                const suffix = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
                const bindings = [...(local.stream_bindings ?? []), {
                  id: `binding-${suffix}`,
                  a: { kind: 'umbilical', filter: { event_types: ['tool.failed'] } },
                  b: { kind: 'ws', connection_id: 'observatory' },
                  bidirectional: false,
                  reconnect: true,
                  options: { flow_summary_interval_ms: 5000 },
                } as StreamBindingDeclaration]
                bindingKeys.append()
                save({ ...local, stream_bindings: bindings })
              }}
              className="text-[11px] text-blue-500 hover:text-blue-700 font-medium"
            >
              + Add binding
            </button>
          </div>

          {(local.stream_bindings ?? []).map((binding, i) => (
            <div key={bindingKeys.keys[i]} className="mb-2 p-2 rounded border border-neutral-200 dark:border-neutral-700 space-y-1.5">
              <div className="flex gap-1.5 items-center">
                <input
                  type="text"
                  value={binding.id}
                  onChange={(e) => {
                    const bindings = [...(local.stream_bindings ?? [])]
                    bindings[i] = { ...bindings[i], id: e.target.value }
                    save({ ...local, stream_bindings: bindings })
                  }}
                  placeholder="binding-id"
                  className="flex-1 px-2 py-1 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                />
                <button
                  onClick={() => {
                    const bindings = (local.stream_bindings ?? []).filter((_, j) => j !== i)
                    bindingKeys.removeAt(i)
                    save({ ...local, stream_bindings: bindings.length > 0 ? bindings : undefined })
                  }}
                  className="text-xs text-red-400 hover:text-red-600 px-1"
                >
                  &times;
                </button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5">
                <div>
                  <label className="block text-[10px] text-[var(--adf-ui-text-subtle)] mb-0.5">a</label>
                  <textarea
                    defaultValue={JSON.stringify(binding.a, null, 2)}
                    onBlur={(e) => {
                      try {
                        const parsed = JSON.parse(e.target.value) as StreamBindingDeclaration['a']
                        const bindings = [...(local.stream_bindings ?? [])]
                        bindings[i] = { ...bindings[i], a: parsed }
                        save({ ...local, stream_bindings: bindings })
                      } catch { /* keep previous valid value */ }
                    }}
                    className="w-full min-h-[96px] px-2 py-1 text-[11px] font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-[var(--adf-ui-text-subtle)] mb-0.5">b</label>
                  <textarea
                    defaultValue={JSON.stringify(binding.b, null, 2)}
                    onBlur={(e) => {
                      try {
                        const parsed = JSON.parse(e.target.value) as StreamBindingDeclaration['b']
                        const bindings = [...(local.stream_bindings ?? [])]
                        bindings[i] = { ...bindings[i], b: parsed }
                        save({ ...local, stream_bindings: bindings })
                      } catch { /* keep previous valid value */ }
                    }}
                    className="w-full min-h-[96px] px-2 py-1 text-[11px] font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                  />
                </div>
              </div>
              <div className="flex gap-3 items-center flex-wrap">
                <label className="flex items-center gap-1 cursor-pointer shrink-0">
                  <input
                    type="checkbox"
                    checked={binding.bidirectional ?? false}
                    disabled={binding.a.kind === 'umbilical'}
                    onChange={(e) => {
                      const bindings = [...(local.stream_bindings ?? [])]
                      bindings[i] = { ...bindings[i], bidirectional: e.target.checked }
                      save({ ...local, stream_bindings: bindings })
                    }}
                    className="rounded text-blue-500"
                  />
                  <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">bidirectional</span>
                </label>
                <label className="flex items-center gap-1 cursor-pointer shrink-0">
                  <input
                    type="checkbox"
                    checked={binding.reconnect ?? false}
                    onChange={(e) => {
                      const bindings = [...(local.stream_bindings ?? [])]
                      bindings[i] = { ...bindings[i], reconnect: e.target.checked }
                      save({ ...local, stream_bindings: bindings })
                    }}
                    className="rounded text-blue-500"
                  />
                  <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">reconnect</span>
                </label>
                <label className="flex items-center gap-1 shrink-0">
                  <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">summary</span>
                  <input
                    type="number"
                    min={100}
                    step={100}
                    value={binding.options?.flow_summary_interval_ms ?? ''}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10)
                      const bindings = [...(local.stream_bindings ?? [])]
                      bindings[i] = {
                        ...bindings[i],
                        options: {
                          ...(bindings[i].options ?? {}),
                          flow_summary_interval_ms: val > 0 ? val : undefined,
                        }
                      }
                      save({ ...local, stream_bindings: bindings })
                    }}
                    placeholder="1000"
                    className="w-20 px-1 py-0.5 text-[10px] border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded focus:outline-none focus:border-blue-400"
                  />
                  <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">ms</span>
                </label>
              </div>
            </div>
          ))}
        </Section>

        {/* Umbilical Taps */}
        <Section docs={DOCS.umbilical} hint="Warm lambdas that subscribe to this agent’s runtime events — tool calls, DB writes, turns, messages. The guide has the filter syntax and the durable-tap recipe."
          title="Umbilical Taps"
          locked={isSectionLocked('umbilical_taps')}
          onToggleLock={() => toggleSectionLock('umbilical_taps')}
          summary={`${(local.umbilical_taps ?? []).length} taps`}
          defaultCollapsed
        >
          <div className="flex items-center justify-between mb-1">
            <label className="block text-xs text-neutral-500 dark:text-neutral-400">Taps</label>
            <button
              onClick={() => {
                const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
                const suffix = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
                const taps = [...(local.umbilical_taps ?? []), {
                  name: `tap-${suffix}`,
                  lambda: 'lib/tap.ts:onEvent',
                  filter: { event_types: ['tool.completed'], allow_wildcard: false },
                  exclude_own_origin: true,
                  max_rate_per_sec: 100,
                } as UmbilicalTapConfig]
                tapKeys.append()
                save({ ...local, umbilical_taps: taps })
              }}
              className="text-[11px] text-blue-500 hover:text-blue-700 font-medium"
            >
              + Add tap
            </button>
          </div>
          {(local.umbilical_taps ?? []).map((tap, i) => (
            <div key={tapKeys.keys[i]} className="mb-2 p-2 rounded border border-neutral-200 dark:border-neutral-700 space-y-1.5">
              <div className="flex gap-1.5 items-center">
                <input
                  type="text"
                  value={tap.name}
                  onChange={(e) => {
                    const taps = [...(local.umbilical_taps ?? [])]
                    taps[i] = { ...taps[i], name: e.target.value }
                    save({ ...local, umbilical_taps: taps })
                  }}
                  placeholder="tap-name"
                  className="flex-1 px-2 py-1 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                />
                <button
                  onClick={() => {
                    const taps = (local.umbilical_taps ?? []).filter((_, j) => j !== i)
                    tapKeys.removeAt(i)
                    save({ ...local, umbilical_taps: taps.length > 0 ? taps : undefined })
                  }}
                  className="text-xs text-red-400 hover:text-red-600 px-1"
                >
                  &times;
                </button>
              </div>
              <div className="flex gap-1.5 items-center">
                <input
                  type="text"
                  value={tap.lambda}
                  onChange={(e) => {
                    const taps = [...(local.umbilical_taps ?? [])]
                    taps[i] = { ...taps[i], lambda: e.target.value }
                    save({ ...local, umbilical_taps: taps })
                  }}
                  placeholder="lib/tap.ts:onEvent"
                  className="flex-1 px-2 py-1 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                />
              </div>
              <div className="flex gap-1.5 items-center">
                <input
                  type="text"
                  value={(tap.filter?.event_types ?? []).join(', ')}
                  onChange={(e) => {
                    const taps = [...(local.umbilical_taps ?? [])]
                    const types = e.target.value.split(',').map(s => s.trim()).filter(Boolean)
                    taps[i] = { ...taps[i], filter: { ...taps[i].filter, event_types: types } }
                    save({ ...local, umbilical_taps: taps })
                  }}
                  placeholder="db.write, tool.completed, custom.*"
                  className="flex-1 px-2 py-1 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                  title="Event types to match. Exact (db.write) or prefix (tool.*). Comma-separated."
                />
              </div>
              <div className="flex gap-1.5 items-center">
                <input
                  type="text"
                  value={tap.filter?.when ?? ''}
                  onChange={(e) => {
                    const taps = [...(local.umbilical_taps ?? [])]
                    taps[i] = { ...taps[i], filter: { ...taps[i].filter, when: e.target.value || undefined } }
                    save({ ...local, umbilical_taps: taps })
                  }}
                  placeholder="event.payload.sql.includes('local_orders')  — optional"
                  className="flex-1 px-2 py-1 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                  title="JS expression over `event`. Evaluated per event; only matching events dispatch to the lambda."
                />
              </div>
              <div className="flex gap-3 items-center flex-wrap">
                <label className="flex items-center gap-1 cursor-pointer shrink-0" title="Suppress redelivery when this tap's own lambda caused the event. Prevents direct self-trigger loops.">
                  <input
                    type="checkbox"
                    checked={tap.exclude_own_origin ?? true}
                    onChange={(e) => {
                      const taps = [...(local.umbilical_taps ?? [])]
                      taps[i] = { ...taps[i], exclude_own_origin: e.target.checked }
                      save({ ...local, umbilical_taps: taps })
                    }}
                    className="rounded text-blue-500"
                  />
                  <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">exclude own origin</span>
                </label>
                <label className="flex items-center gap-1 cursor-pointer shrink-0" title="Required if event_types uses '*' or bare-prefix (tool.*). Code-review signal.">
                  <input
                    type="checkbox"
                    checked={tap.filter?.allow_wildcard ?? false}
                    onChange={(e) => {
                      const taps = [...(local.umbilical_taps ?? [])]
                      taps[i] = { ...taps[i], filter: { ...taps[i].filter, allow_wildcard: e.target.checked } }
                      save({ ...local, umbilical_taps: taps })
                    }}
                    className="rounded text-blue-500"
                  />
                  <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">allow wildcard</span>
                </label>
                <label className="flex items-center gap-1 shrink-0" title="Per-tap token bucket cap. Overruns are dropped and logged.">
                  <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">rate</span>
                  <input
                    type="number"
                    min={1}
                    step={10}
                    value={tap.max_rate_per_sec ?? 100}
                    onChange={(e) => {
                      const taps = [...(local.umbilical_taps ?? [])]
                      const val = parseInt(e.target.value, 10)
                      taps[i] = { ...taps[i], max_rate_per_sec: val > 0 ? val : 100 }
                      save({ ...local, umbilical_taps: taps })
                    }}
                    className="w-16 px-1 py-0.5 text-[10px] border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded focus:outline-none focus:border-blue-400"
                  />
                  <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">/sec</span>
                </label>
              </div>
            </div>
          ))}
        </Section>

        {/* Logging */}
        <Section docs={DOCS.logging} title="Logging" locked={isSectionLocked('logging')} onToggleLock={() => toggleSectionLock('logging')} summary={local.logging?.default_level ?? 'info'} defaultCollapsed>
          <Field label="Default level" hint="Global minimum log level. Messages below this level are discarded.">
            <select
              value={local.logging?.default_level ?? 'info'}
              onChange={(e) => {
                save({
                  ...local,
                  logging: {
                    ...(local.logging ?? { default_level: 'info' as const }),
                    default_level: e.target.value as typeof LOG_LEVELS[number]
                  }
                })
              }}
              className="field-input w-28"
            >
              {LOG_LEVELS.map((lvl) => (
                <option key={lvl} value={lvl}>{lvl}</option>
              ))}
            </select>
          </Field>
          <Field label="Max rows">
            <input
              type="number"
              min={0}
              step={1000}
              value={local.logging?.max_rows ?? 10000}
              onChange={(e) => {
                const val = parseInt(e.target.value)
                save({
                  ...local,
                  logging: {
                    ...(local.logging ?? { default_level: 'info' as const }),
                    max_rows: isNaN(val) || val <= 0 ? null : val
                  }
                })
              }}
              className="field-input w-24"
            />
            <p className="text-[10px] text-[var(--adf-ui-text-subtle)] mt-0.5">
              Ring buffer size. Set to 0 for unlimited.
            </p>
          </Field>

          {/* Per-origin rules */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs text-neutral-500 dark:text-neutral-400">Per-origin rules<InfoHint tip="First matching rule wins. Use glob patterns for origin (e.g. serving, lambda*)." /></label>
              <button
                onClick={() => {
                  const rules = [...(local.logging?.rules ?? []), { origin: '*', min_level: 'info' as const }]
                  logRuleKeys.append()
                  save({
                    ...local,
                    logging: {
                      ...(local.logging ?? { default_level: 'info' as const }),
                      rules
                    }
                  })
                }}
                className="text-[11px] text-blue-500 hover:text-blue-700 font-medium"
              >
                + Add rule
              </button>
            </div>
            {(local.logging?.rules ?? []).map((rule, i) => (
              <div key={logRuleKeys.keys[i]} className="flex gap-1.5 items-center mb-1">
                <input
                  type="text"
                  value={rule.origin}
                  onChange={(e) => {
                    const rules = [...(local.logging?.rules ?? [])]
                    rules[i] = { ...rules[i], origin: e.target.value }
                    save({
                      ...local,
                      logging: { ...(local.logging ?? { default_level: 'info' as const }), rules }
                    })
                  }}
                  placeholder="serving, lambda*"
                  className="flex-1 px-2 py-1 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                />
                <select
                  value={rule.min_level}
                  onChange={(e) => {
                    const rules = [...(local.logging?.rules ?? [])]
                    rules[i] = { ...rules[i], min_level: e.target.value as typeof LOG_LEVELS[number] }
                    save({
                      ...local,
                      logging: { ...(local.logging ?? { default_level: 'info' as const }), rules }
                    })
                  }}
                  className="px-1.5 py-1 text-xs border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                >
                  {LOG_LEVELS.map((lvl) => (
                    <option key={lvl} value={lvl}>{lvl}</option>
                  ))}
                </select>
                <button
                  onClick={() => {
                    const rules = (local.logging?.rules ?? []).filter((_, j) => j !== i)
                    logRuleKeys.removeAt(i)
                    save({
                      ...local,
                      logging: {
                        ...(local.logging ?? { default_level: 'info' as const }),
                        rules: rules.length > 0 ? rules : undefined
                      }
                    })
                  }}
                  className="text-xs text-red-400 hover:text-red-600 px-1"
                >
                  &times;
                </button>
              </div>
            ))}
          </div>
        </Section>

        {/* Metadata (read-only) */}
        {!template && (
        <Section docs={DOCS.metadata} title="Metadata" defaultCollapsed>
          <div className="text-xs text-[var(--adf-ui-text-subtle)] space-y-1">
            <div>Created: {new Date(local.metadata.created_at).toLocaleString()}</div>
            <div>Updated: {new Date(local.metadata.updated_at).toLocaleString()}</div>
            {local.metadata.author && <div>Author: {local.metadata.author}</div>}
            <div>ADF Version: {local.adf_version}</div>
          </div>
        </Section>
        )}

        {/* Meta Keys */}
        {!template && (
        <Section docs={DOCS.metadata} title="Meta Keys" summary={`${metaEntries.length} keys`} defaultCollapsed>
          <div className="space-y-1">
            {metaEntries.length === 0 ? (
              <p className="text-[11px] text-[var(--adf-ui-text-subtle)]">No metadata entries.</p>
            ) : (
              <div className="border border-neutral-200 dark:border-neutral-700 rounded-md overflow-hidden">
                {metaEntries.map((entry) => (
                  <button
                    key={entry.key}
                    onClick={() => { setViewingMeta(entry); setEditingMetaValue(entry.value) }}
                    className="w-full flex items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-neutral-50 dark:hover:bg-neutral-700/40 border-b border-neutral-100 dark:border-neutral-700 last:border-b-0 cursor-pointer"
                  >
                    <span className="font-mono text-neutral-700 dark:text-neutral-300 truncate min-w-0 shrink-0" style={{ maxWidth: '40%' }}>{entry.key}</span>
                    <span className="text-[var(--adf-ui-text-subtle)] truncate min-w-0 flex-1">{entry.value || '\u00A0'}</span>
                    <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded ${
                      entry.protection === 'readonly'
                        ? 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400'
                        : entry.protection === 'increment'
                        ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                        : 'bg-neutral-100 dark:bg-neutral-700 text-neutral-500 dark:text-neutral-400'
                    }`}>{entry.protection}</span>
                  </button>
                ))}
              </div>
            )}
            <button
              onClick={() => { setAddingMeta(true); setNewMetaKey(''); setNewMetaValue(''); setNewMetaProtection('none') }}
              className="text-[11px] text-blue-500 dark:text-blue-400 hover:underline cursor-pointer mt-1"
            >
              + Add key
            </button>
          </div>
        </Section>
        )}

        {/* Clear Agent State */}
        {!template && (
        <div className="border border-red-200 dark:border-red-900/50 rounded-lg p-3">
          <p className="text-[10px] text-[var(--adf-ui-text-subtle)] mb-2">
            Clears README.md (document), mind.md (memory), the loop (conversation history), and all inbox messages.
            Config, soul.md, identity, and other workspace files are kept. If audit is enabled, cleared loop and
            inbox data is archived to the audit log first.
          </p>
          <button
            className="w-full px-3 py-1.5 text-xs font-medium text-red-500 dark:text-red-400 border border-red-200 dark:border-red-800 rounded-md hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
            onClick={async () => {
              const confirmed = window.confirm(
                'Clear agent state?\n\n' +
                'This clears:\n' +
                '• README.md (document)\n' +
                '• mind.md (memory)\n' +
                '• Loop (conversation history)\n' +
                '• All inbox messages\n\n' +
                'Kept: config, soul.md, identity, and other workspace files.\n\n' +
                'This cannot be undone (if audit is enabled, cleared data is archived first).'
              )
              if (!confirmed) return
              // Clear frontend state immediately
              useDocumentStore.getState().setDocumentContent('')
              useEditorTabsStore.getState().updateTabFromExternal('mind.md', '')
              useAgentStore.getState().clearLog()
              // Wiping the loop also drops the persisted context baseline, so the
              // gauge must not keep the pre-clear percentage until the next call.
              useAgentStore.getState().setTokenUsage({ input: 0, output: 0 })
              useAgentStore.getState().setTokenEstimate(null)
              useDocumentStore.getState().setDirty(false)

              // Clear backend state
              await Promise.all([
                openApi()?.setDocument(''),
                openApi()?.writeInternalFile('mind.md', ''),
                openApi()?.clearChat(),
                openApi()?.clearInbox()
              ])

              // Force immediate save to disk (don't wait for autosave)
              await openApi()?.saveFile()
            }}
          >
            Clear Agent State
          </button>
        </div>
        )}
      </div>
      </MaybeConfigNav>
      {!template && approvalUndo && approvalUndo.owner === filePath && (
        <UndoToast
          message={approvalRemovedMessage(approvalUndo.names.length)}
          onUndo={undoApprovalRemoval}
          onDismiss={() => setApprovalUndo(null)}
        />
      )}

      {hostConfirmDialog}

      {/* Tool definition modal */}
      <Dialog
        open={viewingTool !== null}
        onClose={() => setViewingTool(null)}
        title={viewingTool ?? ''}
        wide
      >
        <pre className="text-xs font-mono bg-neutral-100 dark:bg-neutral-900 text-neutral-800 dark:text-neutral-200 p-3 rounded-lg overflow-auto max-h-[60vh] whitespace-pre-wrap">
          {viewingTool && toolDefs[viewingTool]
            ? JSON.stringify(toolDefs[viewingTool], null, 2)
            : 'Loading...'}
        </pre>
        <div className="mt-3 flex justify-end">
          <button
            className="px-3 py-1.5 text-xs bg-neutral-200 dark:bg-neutral-700 rounded hover:bg-neutral-300 dark:hover:bg-neutral-600"
            onClick={() => setViewingTool(null)}
          >
            Close
          </button>
        </div>
      </Dialog>

      {/* Sandbox Package Install Modal */}
      <SandboxInstallModal
        open={showPkgInstallModal}
        onClose={() => setShowPkgInstallModal(false)}
        packages={missingPackages}
      />

      {/* Meta key viewer/editor modal */}
      <Dialog
        open={viewingMeta !== null}
        onClose={() => setViewingMeta(null)}
        title={viewingMeta?.key ?? ''}
      >
        {viewingMeta && (
          <>
            {/* Protection badge */}
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-neutral-500 dark:text-neutral-400 mb-3 pb-3 border-b border-neutral-200 dark:border-neutral-700">
              <span>
                <span className="text-[var(--adf-ui-text-subtle)]">Protection</span>{' '}
                <span className={
                  viewingMeta.protection === 'readonly'
                    ? 'text-red-600 dark:text-red-400'
                    : viewingMeta.protection === 'increment'
                    ? 'text-blue-600 dark:text-blue-400'
                    : 'text-neutral-700 dark:text-neutral-300'
                }>{viewingMeta.protection}</span>
              </span>
            </div>

            {/* Value editor */}
            <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-1">Value</label>
            <textarea
              value={editingMetaValue}
              onChange={(e) => setEditingMetaValue(e.target.value)}
              rows={3}
              className="field-input w-full font-mono text-xs resize-y"
            />

            {/* Actions */}
            <div className="flex items-center gap-2 mt-4 pt-3 border-t border-neutral-200 dark:border-neutral-700">
              {/* Protection cycle button */}
              <button
                onClick={async () => {
                  const levels: MetaProtectionLevel[] = ['none', 'readonly', 'increment']
                  const idx = levels.indexOf(viewingMeta.protection)
                  const next = levels[(idx + 1) % levels.length]
                  await openApi()?.setMetaProtection(viewingMeta.key, next)
                  setViewingMeta({ ...viewingMeta, protection: next })
                  refreshMeta()
                }}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg cursor-pointer ${
                  viewingMeta.protection === 'readonly'
                    ? 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800'
                    : viewingMeta.protection === 'increment'
                    ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-800'
                    : 'text-neutral-700 dark:text-neutral-300 border border-neutral-300 dark:border-neutral-600 hover:bg-neutral-50 dark:hover:bg-neutral-800'
                }`}
                title={`Click to cycle protection (current: ${viewingMeta.protection})`}
              >
                Protection: {viewingMeta.protection}
              </button>

              <div className="flex-1" />

              {/* Save */}
              <button
                onClick={async () => {
                  await openApi()?.setMeta(viewingMeta.key, editingMetaValue, viewingMeta.protection)
                  setViewingMeta(null)
                  refreshMeta()
                }}
                disabled={editingMetaValue === viewingMeta.value}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg ${
                  editingMetaValue === viewingMeta.value
                    ? 'text-[var(--adf-ui-text-disabled)] border border-neutral-200 dark:border-neutral-700 cursor-not-allowed'
                    : 'text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-800 hover:bg-blue-50 dark:hover:bg-blue-900/30 cursor-pointer'
                }`}
              >
                Save
              </button>

              {/* Delete */}
              <button
                onClick={async () => {
                  if (!window.confirm(`Delete meta key "${viewingMeta.key}"?`)) return
                  await openApi()?.deleteMeta(viewingMeta.key)
                  setViewingMeta(null)
                  refreshMeta()
                }}
                className="px-3 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-lg cursor-pointer"
              >
                Delete
              </button>

              <button
                onClick={() => setViewingMeta(null)}
                className="px-4 py-1.5 text-xs font-medium text-neutral-700 dark:text-neutral-300 border border-neutral-300 dark:border-neutral-600 rounded-lg hover:bg-neutral-50 dark:hover:bg-neutral-800 cursor-pointer"
              >
                Close
              </button>
            </div>
          </>
        )}
      </Dialog>

      {/* Add new meta key modal */}
      <Dialog lightDismiss={false}
        open={addingMeta}
        onClose={() => setAddingMeta(false)}
        title="Add Meta Key"
      >
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-1">Key</label>
            <input
              value={newMetaKey}
              onChange={(e) => setNewMetaKey(e.target.value)}
              placeholder="my_key"
              className="field-input w-full font-mono text-xs"
            />
          </div>
          <div>
            <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-1">Value</label>
            <input
              value={newMetaValue}
              onChange={(e) => setNewMetaValue(e.target.value)}
              placeholder=""
              className="field-input w-full font-mono text-xs"
            />
          </div>
          <div>
            <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-1">Protection</label>
            <select
              value={newMetaProtection}
              onChange={(e) => setNewMetaProtection(e.target.value as MetaProtectionLevel)}
              className="field-input w-full text-xs"
            >
              {META_PROTECTION_LEVELS.map((level) => (
                <option key={level} value={level}>{level}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-4 pt-3 border-t border-neutral-200 dark:border-neutral-700">
          <button
            onClick={() => setAddingMeta(false)}
            className="px-3 py-1.5 text-xs font-medium text-neutral-700 dark:text-neutral-300 border border-neutral-300 dark:border-neutral-600 rounded-lg hover:bg-neutral-50 dark:hover:bg-neutral-800 cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={async () => {
              if (!newMetaKey.trim()) return
              await openApi()?.setMeta(newMetaKey.trim(), newMetaValue, newMetaProtection)
              setAddingMeta(false)
              refreshMeta()
            }}
            disabled={!newMetaKey.trim()}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg ${
              !newMetaKey.trim()
                ? 'text-[var(--adf-ui-text-disabled)] border border-neutral-200 dark:border-neutral-700 cursor-not-allowed'
                : 'text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-800 hover:bg-blue-50 dark:hover:bg-blue-900/30 cursor-pointer'
            }`}
          >
            Create
          </button>
        </div>
      </Dialog>
    </div>
    </TemplateModeContext.Provider>
  )
}

/** Comma-separated input that holds local string state so commas don't vanish mid-edit. */
function CommaSepInput({ value, onChange, className, placeholder }: {
  value: string[]
  onChange: (v: string[]) => void
  className?: string
  placeholder?: string
}) {
  const [local, setLocal] = useState(value.join(', '))
  const committed = useRef(value)

  // Sync from parent only when the underlying array actually changed
  useEffect(() => {
    const joined = value.join(', ')
    if (joined !== committed.current.join(', ')) {
      committed.current = value
      setLocal(joined)
    }
  }, [value])

  const commit = (raw: string) => {
    const parsed = raw.split(',').map(s => s.trim()).filter(Boolean)
    committed.current = parsed
    onChange(parsed)
  }

  return (
    <input
      type="text"
      className={className}
      placeholder={placeholder}
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter') commit((e.target as HTMLInputElement).value) }}
    />
  )
}

function truncateDid(did: string): string {
  if (did.length <= 24) return did
  return `${did.slice(0, 16)}...${did.slice(-6)}`
}

function DidListPicker({
  dids,
  knownAgents,
  inputValue,
  onInputChange,
  dropdownOpen,
  onDropdownChange,
  onChange,
  placeholder
}: {
  dids: string[]
  knownAgents: { did: string; label: string }[]
  inputValue: string
  onInputChange: (v: string) => void
  dropdownOpen: boolean
  onDropdownChange: (open: boolean) => void
  onChange: (dids: string[]) => void
  placeholder: string
}) {
  const didSet = new Set(dids)
  const resolveLabel = (did: string) => knownAgents.find(a => a.did === did)?.label

  const filtered = knownAgents.filter(a =>
    !didSet.has(a.did) &&
    (inputValue === '' || a.label.toLowerCase().includes(inputValue.toLowerCase()) || a.did.includes(inputValue))
  )

  return (
    <div className="space-y-1">
      {/* Selected chips */}
      {dids.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {dids.map((did) => {
            const label = resolveLabel(did)
            return (
              <span
                key={did}
                className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded-full border border-blue-200 dark:border-blue-800"
                title={did}
              >
                {label ? label : truncateDid(did)}
                <button
                  type="button"
                  onClick={() => onChange(dids.filter(d => d !== did))}
                  className="text-blue-400 hover:text-blue-600 dark:hover:text-blue-200 ml-0.5"
                >
                  &times;
                </button>
              </span>
            )
          })}
        </div>
      )}

      {/* Input + dropdown */}
      <div className="relative">
        <input
          type="text"
          value={inputValue}
          onChange={(e) => onInputChange(e.target.value)}
          onFocus={() => onDropdownChange(true)}
          onBlur={() => setTimeout(() => onDropdownChange(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && inputValue.startsWith('did:')) {
              e.preventDefault()
              const trimmed = inputValue.trim()
              if (trimmed && !didSet.has(trimmed)) {
                onChange([...dids, trimmed])
                onInputChange('')
              }
            }
          }}
          className="field-input"
          placeholder={placeholder}
        />
        {dropdownOpen && filtered.length > 0 && (
          <div className="absolute z-50 left-0 right-0 mt-1 max-h-40 overflow-y-auto rounded-[var(--adf-ui-container-radius)] border border-[var(--adf-ui-border)] bg-[var(--adf-ui-surface)] shadow-float">
            {filtered.map((agent) => (
              <button
                key={agent.did}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault()
                  onChange([...dids, agent.did])
                  onInputChange('')
                }}
                className="w-full text-left px-3 py-1.5 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-700 flex items-center gap-2"
              >
                <span className="font-medium text-neutral-700 dark:text-neutral-200">{agent.label}</span>
                <span className="text-[var(--adf-ui-text-subtle)] font-mono text-[10px] truncate">{truncateDid(agent.did)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** The quick nav belongs to the panel; the template editor embeds the same sections without it. */
function MaybeConfigNav({ enabled, scrollRef, status, children }: { enabled: boolean; scrollRef: React.RefObject<HTMLDivElement | null>; status?: React.ReactNode; children: React.ReactNode }) {
  return enabled ? <ConfigNavProvider scrollRef={scrollRef} status={status}>{children}</ConfigNavProvider> : <>{children}</>
}

function Section({
  title,
  locked,
  onToggleLock,
  summary,
  docs,
  hint,
  defaultCollapsed = false,
  testId,
  children
}: {
  title: React.ReactNode
  locked?: boolean
  onToggleLock?: () => void
  summary?: React.ReactNode
  /** Guide URL for this section — rendered as a "Docs ↗" link in the header. */
  docs?: string
  /** What this section is, in a sentence or two — shown as an ⓘ tooltip. */
  hint?: string
  defaultCollapsed?: boolean
  /** Stable hook for targeted renderer/electron verification. */
  testId?: string
  children: React.ReactNode
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  const rootRef = useRef<HTMLDivElement>(null)
  const inTemplate = useContext(TemplateModeContext)
  // The overview's stat popovers ask for a section by title: open it, bring
  // it into view and move focus to it, once.
  const pendingSection = useAppStore((s) => s.pendingConfigSection)
  const isTarget = !inTemplate && typeof title === 'string' && pendingSection === title
  useConfigNavEntry(title, rootRef, summary, locked)
  useEffect(() => {
    if (!isTarget) return
    setCollapsed(false)
    // Next frame, so the expanded body is laid out before scrolling. The
    // request is cleared there too: clearing it here would re-run this
    // effect and its cleanup would cancel the frame.
    const raf = requestAnimationFrame(() => {
      rootRef.current?.scrollIntoView({ block: 'start' })
      rootRef.current?.focus({ preventScroll: true })
      useAppStore.getState().setPendingConfigSection(null)
    })
    return () => cancelAnimationFrame(raf)
  }, [isTarget])
  return (
    <div ref={rootRef} tabIndex={-1} data-testid={testId} className={`${CONFIG_NAV_OFFSET_CLASS} bg-white dark:bg-neutral-800 rounded-lg border ${locked ? 'border-amber-300 dark:border-amber-600' : 'border-neutral-200 dark:border-neutral-700'} ${collapsed ? 'p-2.5' : 'p-3'}`}>
      <h4
        className="text-xs font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wider flex items-center gap-1.5 cursor-pointer select-none"
        onClick={() => setCollapsed(!collapsed)}
      >
        <svg
          width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          className={`shrink-0 transition-transform ${collapsed ? '' : 'rotate-90'}`}
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
        {title}
        {hint && <InfoHint tip={hint} />}
        {onToggleLock && (
          <LockButton locked={!!locked} onClick={onToggleLock} />
        )}
        {collapsed && summary && (
          <span className="ml-auto font-normal normal-case tracking-normal text-[10px] text-[var(--adf-ui-text-subtle)] truncate">{summary}</span>
        )}
        {docs && <DocsLink href={docs} className={collapsed && summary ? 'ml-2' : 'ml-auto'} />}
      </h4>
      {!collapsed && (
        // Locked means the agent's own config edits are refused here; the
        // owner still edits. The header badge says so — nothing is disabled.
        <div className="space-y-2 mt-2">{children}</div>
      )}
    </div>
  )
}

function LockButton({ locked, onClick, size = 'sm' }: { locked: boolean; onClick: () => void; size?: 'sm' | 'xs' }) {
  // Locks belong to a running agent; the template has none to show.
  if (useContext(TemplateModeContext)) return null
  return <LockBadge locked={locked} onClick={onClick} size={size} />
}

/** Number input that allows empty field while typing; commits on blur. */
function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
  placeholder,
  className,
  float
}: {
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
  placeholder?: string
  className?: string
  float?: boolean
}) {
  const [text, setText] = useState('')
  const [focused, setFocused] = useState(false)

  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      value={focused ? text : value}
      placeholder={placeholder}
      onFocus={() => { setFocused(true); setText(String(value)) }}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        setFocused(false)
        const parsed = float ? parseFloat(text) : parseInt(text)
        if (!isNaN(parsed)) {
          onChange(Math.max(min ?? -Infinity, Math.min(max ?? Infinity, parsed)))
        }
      }}
      className={className ?? 'field-input w-24'}
    />
  )
}

function Field({
  label,
  hint,
  children
}: {
  label: React.ReactNode
  /** Explanation for this field — an ⓘ tooltip beside the label, not a paragraph under it. */
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-0.5">
        {label}
        {hint && <InfoHint tip={hint} />}
      </label>
      {children}
    </div>
  )
}

type PromptMode = 'full' | 'no-base' | 'bare'

function formatApproxTokens(n: number | null | undefined): string {
  if (n == null) return '…'
  if (n >= 1000) return `~${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `~${n}`
}

/**
 * The composition select plus a receipt of what each layer of the static
 * system prompt costs. Prices come from the executor's own measurement
 * (the same figures the status-bar breakdown shows), so every mode can be
 * priced without switching to it. Nothing here touches per-turn dynamic
 * instructions — those are the checkboxes in the same section.
 */
function PromptCompositionField({
  filePath,
  config,
  onModeChange
}: {
  filePath: string | null
  config: AgentConfigType
  onModeChange: (mode: PromptMode) => void
}) {
  const mode: PromptMode = config.bare_prompt ? 'bare' : config.include_base_prompt === false ? 'no-base' : 'full'
  const [parts, setParts] = useState<SystemPromptParts | null>(null)
  const [sentTotal, setSentTotal] = useState<number | null>(null)

  // Re-measure when anything the executor keys its prompt cache on changes.
  // The debounce absorbs keystrokes in the instructions textarea; the save
  // that precedes each keystroke has long reached the executor by then.
  const enabledTools = config.tools.filter((t) => t.enabled).map((t) => t.name).sort().join(',')
  const measureKey = JSON.stringify([
    mode, config.instructions, enabledTools, config.autonomous, config.name,
    config.model?.provider, config.model?.model_id, config.loops?.length ?? 0,
    config.compute?.enabled, config.messaging?.receive
  ])
  useEffect(() => {
    if (!filePath) return
    let cancelled = false
    const timer = setTimeout(() => {
      Promise.resolve(openApi()?.getContextBreakdown(filePath))
        .then((b) => {
          if (cancelled) return
          setParts(b?.system_prompt_parts ?? null)
          setSentTotal(b?.system_prompt_tokens ?? null)
        })
        .catch(() => {
          if (cancelled) return
          setParts(null)
          setSentTotal(null)
        })
    }, 400)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [filePath, measureKey])

  const base = parts?.base_and_sections ?? null
  const runtime = parts?.runtime_blocks ?? null
  const instr = parts?.instructions ?? null
  const sum = (...xs: Array<number | null>): number | null =>
    xs.some((x) => x == null) ? null : xs.reduce((a, b) => (a ?? 0) + (b ?? 0), 0)
  const modeTotals: Record<PromptMode, number | null> = {
    full: sum(base, runtime, instr),
    'no-base': sum(runtime, instr),
    bare: instr
  }

  return (
    <Field
      label={(
        <span className="flex items-center">
          <span>System Prompt<InfoHint tip="Chooses what goes into the system prompt. Full: the base prompt, the capability sections for the enabled tools, the runtime blocks (identity, inner loops, multimodal, autonomous), and the agent instructions. No base prompt: runtime blocks and agent instructions. Agent Instructions only: nothing else. The token count is the system prompt as currently sent. Tool schemas are sent separately and are not affected. Dynamic instructions are controlled by the checkboxes below." /></span>
          <span className="ml-auto font-mono tabular-nums text-neutral-500 dark:text-neutral-400">
            {sentTotal == null ? (filePath ? 'measuring…' : '') : `${formatApproxTokens(sentTotal)} tokens`}
          </span>
        </span>
      )}
    >
      <select
        value={mode}
        onChange={(e) => onModeChange(e.target.value as PromptMode)}
        className="field-input"
      >
        <option value="full">Full — base prompt, capability sections, runtime blocks, agent instructions ({formatApproxTokens(modeTotals.full)})</option>
        <option value="no-base">No base prompt — runtime blocks and agent instructions ({formatApproxTokens(modeTotals['no-base'])})</option>
        <option value="bare">Agent Instructions only ({formatApproxTokens(modeTotals.bare)})</option>
      </select>
    </Field>
  )
}
