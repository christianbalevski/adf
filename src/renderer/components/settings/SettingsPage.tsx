import { listsToWrite, rebaseSettingsLists, settingsListsOf, type SettingsLists } from '../../utils/settings-lists'
import { sameContent } from '../../utils/list-rebase'
import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useAppStore, UI_FONT_PRESETS, UI_SCALE_OPTIONS, type SettingsSection, type UiFont, type UiScale } from '../../stores/app.store'
import { isFontInstalled } from '../../utils/fonts'
import { PROMPT_AUTO_UPDATE_KEY, PROMPT_DEFAULTS_APPLIED_KEY, currentPromptDefaults, promptDefaultsFingerprint } from '../../../shared/utils/settings-migrations'
import { ADF_SKILLS_REGISTRY_URL, DEFAULT_BASE_PROMPT, DEFAULT_TOOL_PROMPTS, DEFAULT_DYNAMIC_PROMPTS, DEFAULT_COMPACTION_PROMPT, TOOL_PROMPT_LABELS, TOOL_PROMPT_CONDITIONS, DYNAMIC_PROMPT_LABELS, DYNAMIC_PROMPT_CONDITIONS } from '../../../shared/constants/adf-defaults'
import { addCatalogSource, normalizeCatalogSources, MAX_CATALOG_SOURCES } from '../../utils/skills-panel'
import { invalidateConfigCaches } from '../agent/AgentConfig'
import type { ProviderConfig, McpServerRegistration, AdapterRegistration } from '../../../shared/types/ipc.types'
import { McpStatusDashboard } from '../mcp/McpStatusDashboard'
import { ChannelsPanel } from '../adapters/ChannelsPanel'
import { ProvidersPanel } from '../providers/ProvidersPanel'
import { saveProviderList, type ProviderListSnapshot, type ProviderSaveFailure } from '../providers/provider-save'
import { AboutTab, UpdatesGroup } from './AboutTab'
import { AgentTemplatesTab } from './AgentTemplatesTab'
import { TokenUsageSection } from './UsageSection'
import { ConnectionSettings } from './ConnectionSettings'
import { SettingsRuntimeBanner, SettingsRuntimeProvider, useSettingsApi } from './settings-runtime'
import { RUNTIME_NAV_ITEMS, STUDIO_NAV_ITEMS, settingsNavGroups, settingsTabFor, type SettingsTab } from './settings-nav'
import { changeOn } from './RemoteAccessSettings'
import { NetworkingSettings } from './NetworkingSettings'
import { runtimeDown, useCurrentConnection } from '../../stores/connection.store'
import { runtimeHeader, useRuntimes } from '../../stores/runtimes.store'
import { RemoteMark } from '../common/RemoteMark'
import { initialSettingsRuntime, useSettingsRuntimeStore } from '../../stores/settings-runtime.store'
import { apiFor } from '../../utils/runtime-api'
import { LOCAL_RUNTIME, type RuntimeId } from '../../../shared/runtime-tag'
import { CONNECTION_STATE_LABELS } from '../../../shared/types/connection.types'
import { ContainerDestroyDialog, containerStopConfirmation, type ContainerDestroyRequest } from './ContainerDestroyDialog'
import { Dialog } from '../common/Dialog'
import { HOST_ACCESS_CONFIRM, useConfirm } from '../common/ConfirmDialog'
import { Tooltip } from '../common/Tooltip'
import type { AgentAvatarMode } from '../orbital/agent-avatar'
import { DocsLink, InfoHint } from '../common/DocsLink'
import { DOCS, NETWORK_DOCS, guideUrl } from '../../../shared/constants/docs-links'
import { Button, IconButton, SegmentedControl, Select, SettingsGroup, SettingsRow, Switch, TextInput, Textarea } from '../ui'
import { CommitInput, checkWholeNumber } from './settings-inputs'
import { PromptEditor, PromptSectionRows } from './PromptEditor'
import { SaveIndicator, SettingsSaveProvider, SettingsToasts, settingsWriteOutcome, useSettingsSave } from './settings-save'
import type { ComputePrerequisite as Prerequisite, ContainerOverview, ContainerSummary, ExecutionTarget, LocalContainerExecutionTarget, PodmanAvailability } from '../../../shared/types/compute.types'
import { nextExecutionTargetAlias, resolveExecutionTargetAliases } from '../../../shared/utils/compute-targets'
import { reconcileHostApprovedRegistrations, registrationSourceIdentity } from '../../../shared/utils/mcp-config'
import { allowHostPatch } from '../../../shared/utils/mcp-host-placement'

/**
 * Hover copy for the "Rebuild available" badge on managed containers that
 * predate the current feature set (they lack network isolation). Rebuilding is
 * optional and destructive (not an update): it must be the owner's choice,
 * never automatic.
 */
export const OUTDATED_CONTAINER_ADVISORY =
  'Rebuilding adds network isolation from other agents. It erases this container\'s workspace files, installed packages and saved browser session; Rebuild is in the More actions menu.'

/** Setup and container messages: progress ("…ing...") in the muted tone, a finished step in the success color. */
export function setupLogTone(log: string): string {
  return log.endsWith('...') ? 'text-[var(--adf-ui-text-muted)]' : 'text-[var(--adf-ui-success)]'
}

/**
 * Where the global prompts go (agent-executor.ts buildSystemPrompt): Full puts
 * the system prompt and the tool instructions before the agent's own
 * instructions; No base prompt and Bare leave both out.
 */
export const PROMPTS_COMPOSITION = 'Every agent gets the system prompt and tool instructions before its own instructions, unless its System prompt setting is No base prompt or Bare.'

const SETTINGS_NAV_ITEMS = [...STUDIO_NAV_ITEMS, ...RUNTIME_NAV_ITEMS]

function SettingsNavIcon({ section }: { section: SettingsTab }) {
  const paths: Record<SettingsTab, React.ReactNode> = {
    appearance: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.86 2.86-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21H9.55v-.09A1.7 1.7 0 0 0 8.5 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.86-2.86.06-.06A1.7 1.7 0 0 0 4.1 15a1.7 1.7 0 0 0-1.5-1H2.5V10h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.34-1.88l-.06-.06L6.56 4.2l.06.06A1.7 1.7 0 0 0 8.5 4.6a1.7 1.7 0 0 0 1-1.5V3h4.05v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.86 2.86-.06.06A1.7 1.7 0 0 0 19.6 9a1.7 1.7 0 0 0 1.5 1h.1v4h-.1a1.7 1.7 0 0 0-1.7 1Z" /></>,
    identity: <><circle cx="12" cy="8" r="4" /><path d="M4.5 21a7.5 7.5 0 0 1 15 0" /></>,
    agents: <><path d="M4 17V7l4 3 4-3v10" /><path d="M15 8h5M15 12h5M15 16h5" /></>,
    template: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z" /><path d="M14 3v6h6" /><path d="M12 12v6M9 15h6" /></>,
    providers: <><path d="M8 12h8" /><path d="M12 8v8" /><rect x="4" y="4" width="16" height="16" rx="4" /></>,
    packages: <><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" /><path d="m4.5 7.7 7.5 4.2 7.5-4.2M12 12v9" /></>,
    mcps: <><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M8 17v2a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-2" /><rect x="4" y="7" width="16" height="10" rx="2" /></>,
    skills: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5Z" /><path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H19v3H6.5" /><path d="M9 7.5h6" /></>,
    channels: <><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" /><path d="M8 9h8M8 13h5" /></>,
    networking: <><circle cx="12" cy="12" r="2" /><path d="M5.6 8.5a7.5 7.5 0 0 1 12.8 0M2.6 5.5a11.5 11.5 0 0 1 18.8 0M8.6 15.5a4 4 0 0 1 6.8 0" /></>,
    compute: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></>,
    connection: <><rect x="4" y="4" width="16" height="6" rx="1.5" /><rect x="4" y="14" width="16" height="6" rx="1.5" /><path d="M8 7h.01M8 17h.01" /></>,
    notifications: <><path d="M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8" /><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" /></>,
    updates: <><path d="M12 4v12" /><path d="m6 10 6 6 6-6" /><path d="M4 20h16" /></>,
    privacy: <><path d="M12 3 4 6v6c0 5 3.4 8.3 8 9 4.6-.7 8-4 8-9V6l-8-3Z" /></>,
    files: <><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></>,
    usage: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></>,
    about: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>,
  }

  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[section]}
    </svg>
  )
}

type OwnerIdentityStatusView = {
  ownerDid: string
  runtimeDid: string
  hasMnemonic: boolean
  mnemonicLocked: boolean
  restoreRequired?: boolean
  backupConfirmed: boolean
  legacyOwnerDids: string[]
  legacyRuntimeDids: string[]
  safeStorageAvailable: boolean
  runtimeDelegation: { issuer: string; subject: string; role: string; issued_at: string; expires_at?: string; scope?: string; signature: string } | null
  runtimeDelegationValid: boolean
}

/** A copyable monospace DID or URL, as the control of a SettingsRow on the Identity page. */
function DidValue({ copyKey, value, copied, onCopy }: {
  copyKey: string
  value?: string
  copied: string | null
  onCopy: (key: string, value?: string) => void
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="min-w-0 flex-1 break-all rounded-[var(--adf-ui-control-radius)] bg-[var(--adf-ui-canvas)] px-2 py-1.5 font-mono text-[12px] text-[var(--adf-ui-text)]">
        {value ?? 'Not generated yet'}
      </span>
      {value && (
        <Button onClick={() => onCopy(copyKey, value)} variant="ghost" size="compact">
          {copied === copyKey ? 'Copied' : 'Copy'}
        </Button>
      )}
    </div>
  )
}

/** A small state badge (Backed up, Delegation valid). */
function StateBadge({ tone, children }: { tone: 'ok' | 'warn' | 'bad'; children: React.ReactNode }) {
  const tones = {
    ok: 'bg-[var(--adf-ui-success-subtle)] text-[var(--adf-ui-success)]',
    warn: 'bg-[var(--adf-ui-warning-subtle)] text-[var(--adf-ui-warning)]',
    bad: 'bg-[var(--adf-ui-danger-subtle)] text-[var(--adf-ui-danger)]',
  } as const
  return <span className={`ml-2 rounded px-1.5 py-0.5 text-[11px] font-medium ${tones[tone]}`}>{children}</span>
}

/**
 * Identity tab: app-level owner + runtime identity. The owner DID is derived
 * from a BIP-39 seed phrase (your user identity, shared across Studios once
 * imported); the runtime DID identifies this install and is certified by an
 * owner-signed delegation. Includes seed backup + import flows.
 */
function IdentityTab({ remote, runtimeName }: { remote: boolean; runtimeName: string }) {
  const api = useSettingsApi()
  const [status, setStatus] = useState<OwnerIdentityStatusView | null>(null)
  const [meshServer, setMeshServer] = useState<{ running: boolean; port: number; host: string } | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [backupOpen, setBackupOpen] = useState(false)
  const [mnemonic, setMnemonic] = useState<string | null>(null)
  /** Why no phrase is shown (a remote daemon never sends it). */
  const [mnemonicReason, setMnemonicReason] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  // 'restore': only the owner on record is accepted (restoreRequired); 'import' switches owners.
  const [importMode, setImportMode] = useState<'import' | 'restore'>('import')
  const [importPhrase, setImportPhrase] = useState('')
  const [importBusy, setImportBusy] = useState(false)
  const [importResult, setImportResult] = useState<{ ok: boolean; message: string } | null>(null)
  // Friendly display names + owner-sharing opt-in (persisted in settings).
  const [ownerAlias, setOwnerAlias] = useState('')
  const [runtimeAlias, setRuntimeAlias] = useState('')
  const [shareOwner, setShareOwner] = useState(false)
  // The aliases as last loaded or saved: a refused write puts the field back to these.
  const savedAliases = useRef({ owner: '', runtime: '' })
  const { commit } = useSettingsSave()
  const commitAlias = (which: 'owner' | 'runtime', value: string) => {
    const next = value.trim()
    const prev = savedAliases.current[which]
    const set = which === 'owner' ? setOwnerAlias : setRuntimeAlias
    if (next === prev) { set(prev); return }
    set(next)
    savedAliases.current[which] = next
    void commit(which === 'owner' ? { ownerAlias: next } : { runtimeAlias: next }, () => { savedAliases.current[which] = prev; set(prev) })
  }

  const refresh = useCallback(() => {
    api?.getOwnerIdentityStatus().then(setStatus)
    api?.getMeshServerStatus().then(setMeshServer)
    api?.getSettings?.().then((s: unknown) => {
      const cfg = s as { ownerAlias?: string; runtimeAlias?: string; shareOwnerIdentity?: boolean } | undefined
      savedAliases.current = { owner: cfg?.ownerAlias ?? '', runtime: cfg?.runtimeAlias ?? '' }
      setOwnerAlias(cfg?.ownerAlias ?? '')
      setRuntimeAlias(cfg?.runtimeAlias ?? '')
      setShareOwner(cfg?.shareOwnerIdentity === true)
    })
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const handleCopy = (label: string, value?: string) => {
    if (!value) return
    void navigator.clipboard.writeText(value)
    setCopied(label)
    setTimeout(() => setCopied(null), 1500)
  }

  const openBackup = async () => {
    const r = await api?.revealOwnerMnemonic()
    setMnemonic(r?.mnemonic ?? null)
    setMnemonicReason(r?.reason ?? null)
    setBackupOpen(true)
  }

  const confirmBackup = async () => {
    await api?.confirmOwnerBackup()
    setBackupOpen(false)
    setMnemonic(null)
    refresh()
  }

  const [confirmDialog, confirm] = useConfirm()
  const runImport = async () => {
    // A new owner restamps every agent: say so and ask, by name. Restore keeps the owner.
    if (importMode === 'import' && !await confirm({
      title: 'Replace owner',
      body: 'Your owner DID changes to the identity of this seed phrase, and every agent file you own on this computer is restamped to it. Peers that trust your current DID no longer recognise you.',
      confirmLabel: 'Replace owner',
      danger: true,
    })) return
    setImportBusy(true)
    setImportResult(null)
    try {
      const expected = importMode === 'restore' ? status?.ownerDid : undefined
      const r = await api?.importOwnerMnemonic(importPhrase, expected)
      if (r?.success) {
        setImportResult({ ok: true, message: `Identity ${expected ? 'restored' : 'imported'}. ${r.restamped ?? 0} agent file(s) restamped${r.failures?.length ? `, ${r.failures.length} failed` : ''}.` })
        setImportPhrase('')
        refresh()
      } else {
        setImportResult({ ok: false, message: r?.error ?? 'Import failed' })
      }
    } finally {
      setImportBusy(false)
    }
  }

  // 0.0.0.0 binds all interfaces but is not itself reachable — show loopback.
  const directoryUrl = meshServer?.running
    ? `http://${meshServer.host === '0.0.0.0' ? '127.0.0.1' : meshServer.host}:${meshServer.port}/agents`
    : undefined

  return (
    <>
      {/* Seed-derived owner whose phrase this Studio cannot read (e.g. set up
          in the ADF terminal with a passphrase-protected file): restore it,
          never mint a replacement. */}
      {status?.restoreRequired && (
        <div data-settings-anchor="restore-identity">
          <SettingsGroup
            title="Restore identity"
            description="Enter this owner's 12 words to use it here; Studio never creates a new owner or restamps your agents for this."
            hint="This computer's owner was set up in the ADF terminal, and Studio cannot read its seed phrase."
          >
            <SettingsRow label="Owner" description={<span className="font-mono break-all">{status.ownerDid}</span>}>
              {remote
                ? <span className="text-[12px] text-[var(--adf-ui-text-muted)]">{changeOn(runtimeName)}</span>
                : (
                  <Button variant="primary" onClick={() => { setImportMode('restore'); setImportOpen(true); setImportResult(null) }}>
                    Restore identity
                  </Button>
                )}
            </SettingsRow>
          </SettingsGroup>
        </div>
      )}

      {/* Owner identity */}
      <SettingsGroup
        title="Owner identity"
        hint="Who you are. Rooted in a 12-word seed phrase generated on first launch; import the same phrase on another computer to be the same owner there. Stamped into agent files you claim or clone, and used to sign ownership attestations for your agents."
        docs={DOCS.settingsIdentity}
      >
        <SettingsRow
          label="DID"
          stacked
          error={status && !status.safeStorageAvailable ? 'The OS keychain is unavailable, so the seed phrase is stored unencrypted in app settings.' : undefined}
          help={status && status.legacyOwnerDids.length > 0 ? <>Previous: <span className="font-mono break-all">{status.legacyOwnerDids.join(', ')}</span></> : undefined}
        >
          <DidValue copyKey="owner" value={status?.ownerDid} copied={copied} onCopy={handleCopy} />
        </SettingsRow>

        {/* Owner alias — a friendly name for you, keyed to the DID. Display
            only: allow/block and trust always use the DID, never the alias. */}
        <SettingsRow separator label={<>Alias<InfoHint tip="A name peers see for you. Display only: trust and allow lists always use the DID." /></>}>
          <TextInput
            aria-label="Owner alias"
            type="text"
            value={ownerAlias}
            maxLength={40}
            onChange={(e) => setOwnerAlias(e.target.value)}
            onBlur={() => commitAlias('owner', ownerAlias)}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
            placeholder="A name peers will see"
            className="!w-64 !text-[12px]"
          />
        </SettingsRow>
        <SettingsRow
          separator
          label={<>Sharing<InfoHint tip="Off by default. On: discoverable peers see your owner alias and can verify that your runtimes share one owner, so several computers you own read as yours. This links your runtimes together publicly." /></>}
          description="Share the owner identity on the mesh."
        >
          <Switch
            label="Sharing"
            checked={shareOwner}
            onChange={(next) => { setShareOwner(next); void commit({ shareOwnerIdentity: next }, () => setShareOwner(!next)) }}
          />
        </SettingsRow>
        <SettingsRow
          separator
          label={<>Seed phrase{status?.hasMnemonic && (status.backupConfirmed ? <StateBadge tone="ok">Backed up</StateBadge> : <StateBadge tone="warn">Not backed up</StateBadge>)}</>}
        >
          {/* Host-only with a remote runtime (settings-scopes.md §7): changed on that computer. */}
          {remote ? (
            <span className="text-[12px] text-[var(--adf-ui-text-muted)]">{changeOn(runtimeName)}</span>
          ) : (
            <div className="flex gap-2">
              <Button onClick={openBackup} disabled={!status?.hasMnemonic} variant="primary">
                Back up seed phrase
              </Button>
              <Button onClick={() => { setImportMode('import'); setImportOpen(true); setImportResult(null) }}>
                Import identity
              </Button>
            </div>
          )}
        </SettingsRow>
      </SettingsGroup>

      {/* Runtime identity */}
      <SettingsGroup title="Runtime key" hint="Identifies this computer to other computers; two computers never share one.">
        <SettingsRow
          label={<>DID{status && (status.runtimeDelegationValid ? <StateBadge tone="ok">Delegation valid</StateBadge> : <StateBadge tone="bad">No valid delegation</StateBadge>)}</>}
          stacked
          help={status?.runtimeDelegation || (status && status.legacyRuntimeDids.length > 0) ? <>
            {status?.runtimeDelegation && <>Delegation signed by <span className="font-mono break-all">{status.runtimeDelegation.issuer}</span> on {new Date(status.runtimeDelegation.issued_at).toLocaleDateString()}. </>}
            {status && status.legacyRuntimeDids.length > 0 && <>Previous: <span className="font-mono break-all">{status.legacyRuntimeDids.join(', ')}</span></>}
          </> : undefined}
        >
          <DidValue copyKey="runtime" value={status?.runtimeDid} copied={copied} onCopy={handleCopy} />
        </SettingsRow>

        {/* Runtime alias — the name this install shows as on the mesh map,
            in place of the hostname mDNS/Tailscale would otherwise share. */}
        <SettingsRow
          separator
          label={<>Alias<InfoHint tip="Shown to peers when this runtime is discoverable (Networking → Network, or Tailscale). Blank: the hostname." /></>}
        >
          <TextInput
            aria-label="Runtime alias"
            type="text"
            value={runtimeAlias}
            maxLength={40}
            onChange={(e) => setRuntimeAlias(e.target.value)}
            onBlur={() => commitAlias('runtime', runtimeAlias)}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
            placeholder="A name for this runtime"
            className="!w-64 !text-[12px]"
          />
        </SettingsRow>
        {/* A remote runtime's loopback address is not this computer's: hidden (settings-scopes.md §7). */}
        {!remote && (
          <SettingsRow
            separator
            stacked
            label={<>Directory<InfoHint tip="Lists the agent cards this runtime serves, filtered by each requester's visibility scope. Other runtimes fetch it to discover your agents." /></>}
            help={meshServer?.running ? undefined : 'The mesh server is not running; start it in Networking to serve agent cards.'}
          >
            <DidValue copyKey="directory" value={directoryUrl} copied={copied} onCopy={handleCopy} />
          </SettingsRow>
        )}
      </SettingsGroup>

      {/* Agent identity pointers */}
      <SettingsGroup
        title="Agent identities"
        description="Each agent has its own DID and keys, in its Identity tab."
        hint="To let mesh peers verify you own an agent, turn on Publish owner attestation in its Config → Security. It is off by default, so agents cannot be linked to you by card inspection."
        docs={DOCS.identity}
      >
        <span />
      </SettingsGroup>

      {confirmDialog}

      {/* Seed phrase reveal dialog */}
      <Dialog open={backupOpen} onClose={() => { setBackupOpen(false); setMnemonic(null) }} title="Back up seed phrase">
        <p className="text-sm text-[var(--adf-ui-text-muted)] mb-3">
          Write these 12 words down and keep them somewhere safe. Anyone with them can act as you;
          without them, your owner identity cannot be recovered if this computer is lost.
        </p>
        {mnemonic ? (
          <div className="grid grid-cols-3 gap-1.5 mb-4">
            {mnemonic.split(' ').map((word, i) => (
              <div key={i} className="px-2 py-1.5 text-sm font-mono rounded bg-[var(--adf-ui-canvas)] text-[var(--adf-ui-text)]">
                <span className="text-[11px] text-[var(--adf-ui-text-subtle)] mr-1.5 select-none">{i + 1}</span>{word}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-[var(--adf-ui-danger)] mb-4">{mnemonicReason ?? 'No seed phrase available.'}</p>
        )}
        <div className="flex items-center justify-between gap-2">
          <Button
            onClick={() => handleCopy('mnemonic', mnemonic ?? undefined)}
            disabled={!mnemonic}
            variant="ghost"
          >
            {copied === 'mnemonic' ? 'Copied' : 'Copy phrase'}
          </Button>
          <div className="flex gap-2">
            <Button onClick={() => { setBackupOpen(false); setMnemonic(null) }}>
              Cancel
            </Button>
            <Button onClick={confirmBackup} disabled={!mnemonic} variant="primary">
              I have written it down
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Import identity dialog */}
      <Dialog lightDismiss={false} open={importOpen} onClose={() => setImportOpen(false)} title={importMode === 'restore' ? 'Restore identity' : 'Import identity'}>
        {importMode === 'restore' ? (
          <p className="text-sm text-[var(--adf-ui-text-muted)] mb-3">
            Enter the 12-word seed phrase of <span className="font-mono break-all">{status?.ownerDid}</span>, the
            words shown when it was created in the ADF terminal (<span className="font-mono">adf identity new</span>).
            A phrase for a different owner is refused.
          </p>
        ) : (
          <p className="text-sm text-[var(--adf-ui-text-muted)] mb-3">
            Enter the 12-word seed phrase from another computer. Your owner DID changes to the imported
            identity, and agent files you own on this computer are restamped to it.
          </p>
        )}
        <Textarea
          aria-label="Seed phrase"
          value={importPhrase}
          onChange={(e) => { setImportPhrase(e.target.value); setImportResult(null) }}
          rows={3}
          placeholder="word1 word2 word3 ..."
          className="mb-2 font-mono text-sm resize-none"
        />
        {importResult && (
          <p className={`text-xs mb-2 ${importResult.ok ? 'text-[var(--adf-ui-success)]' : 'text-[var(--adf-ui-danger)]'}`}>
            {importResult.message}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={() => setImportOpen(false)}>
            Close
          </Button>
          <Button
            onClick={runImport}
            disabled={!importPhrase.trim() || importBusy}
            loading={importBusy}
            variant="primary"
          >
            {importBusy ? (importMode === 'restore' ? 'Restoring...' : 'Importing...') : (importMode === 'restore' ? 'Restore' : 'Import')}
          </Button>
        </div>
      </Dialog>
    </>
  )
}

// ---------------------------------------------------------------------------
// Skills Tab — the catalogs the skill browser reads
// ---------------------------------------------------------------------------

/**
 * Catalog sources for the Skills panel's browser.
 *
 * These live here, in app settings, rather than in any agent's config: which
 * registries a human likes to browse is a property of the person, not of
 * whichever agent happens to be open, and the per-agent `skills.catalogs` field
 * was deliberately removed (design doc §8.2). Persistence is the ordinary
 * generic settings merge — `setSettings({ skillCatalogSources })` — the same one
 * the manual-peers list uses.
 *
 * The first-party registry is where an unconfigured install starts and nothing
 * more: it renders as an ordinary row, it can be removed like any other, and
 * when it is gone a one-click affordance puts it back. Nobody is made to carry a
 * registry they did not choose. An empty list is a legitimate state — the
 * browser then says so rather than pretending a source exists.
 */
function SkillsTab() {
  const api = useSettingsApi()
  /** `null` until the preference has been read — an empty list is a real value. */
  const [sources, setSources] = useState<string[] | null>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      const stored = (await api?.getSettings?.()) as unknown as
        { skillCatalogSources?: unknown } | undefined
      setSources(normalizeCatalogSources(stored?.skillCatalogSources))
    })()
  }, [])

  /**
   * Writing the list is what makes the preference PRESENT — from here on it is
   * the whole truth, including when it is empty, and the absent-means-default
   * read never applies again.
   */
  const { commit, offerUndo } = useSettingsSave()
  const save = useCallback(async (next: string[]) => {
    const prev = sources
    setSources(next)
    await commit({ skillCatalogSources: next }, () => setSources(prev))
  }, [commit, sources])

  const add = useCallback(async (raw: string) => {
    const result = addCatalogSource(sources ?? [], raw)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setError(null)
    setDraft('')
    await save(result.sources)
  }, [save, sources])

  const list = sources ?? []
  const full = list.length >= MAX_CATALOG_SOURCES
  const hasDefault = list.includes(ADF_SKILLS_REGISTRY_URL)

  return (
    <SettingsGroup
      title="Catalog sources"
      description={<>
        Where the Skills panel&apos;s browser looks for installable skills. A catalog is discovery
        metadata only — installing writes <span className="font-mono">skills/&lt;name&gt;/SKILL.md</span> into
        the open agent and nothing else. No tools, files, or approvals are ever granted by one.
      </>}
    >
      <SettingsRow
        label="Sources"
        description="All fetched together each time the browser opens, in this order. A name published by more than one catalog resolves to the first source that lists it."
        stacked
      >
        {sources !== null && list.length === 0 ? (
          <p className="text-[12px] text-[var(--adf-ui-text-muted)]">
            No catalog sources. The skill browser will have nothing to list until you add one.
          </p>
        ) : (
          <ul className="space-y-1">
            {list.map((source) => (
              <li key={source} className="flex items-center gap-2 rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] bg-[var(--adf-ui-surface-raised)] px-2.5 py-1.5">
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--adf-ui-text)]" title={source}>
                  {source}
                </span>
                {source === ADF_SKILLS_REGISTRY_URL && (
                  <span className="shrink-0 rounded bg-[var(--adf-ui-surface-hover)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--adf-ui-text-subtle)]">
                    Default
                  </span>
                )}
                <IconButton
                  onClick={() => {
                    const before = list
                    void save(list.filter((s) => s !== source)).then(() => offerUndo(`Removed ${source}.`, () => void save(before)))
                  }}
                  aria-label={`Remove catalog source ${source}`}
                  title="Remove source"
                  variant="danger"
                >
                  ✕
                </IconButton>
              </li>
            ))}
          </ul>
        )}
        {sources !== null && !hasDefault && !full && (
          <button
            type="button"
            onClick={() => void add(ADF_SKILLS_REGISTRY_URL)}
            className="mt-1.5 text-[11px] text-[var(--adf-ui-accent)] hover:underline cursor-pointer"
          >
            Add default registry
          </button>
        )}
      </SettingsRow>

      <SettingsRow
        label="Add a source"
        description="Any https URL serving a skill catalog document. Entries that fail validation are dropped individually, and a source that cannot be reached is reported in the browser without hiding the others."
        error={error}
        help={full ? `Remove one first — at most ${MAX_CATALOG_SOURCES} catalog sources.` : undefined}
        separator
        stacked
      >
        <div className="flex items-center gap-1.5">
          <TextInput
            value={draft}
            onChange={(e) => { setDraft(e.target.value); setError(null) }}
            onKeyDown={(e) => { if (e.key === 'Enter') void add(draft) }}
            aria-label="Catalog source URL"
            placeholder="https://example.com/skills/registry.json"
            spellCheck={false}
            disabled={full}
            className="!text-[12px] font-mono"
          />
          <Button onClick={() => void add(draft)} disabled={full}>
            Add source
          </Button>
        </div>
      </SettingsRow>
    </SettingsGroup>
  )
}

// ---------------------------------------------------------------------------
// Packages Tab — runtime packages + all installed on disk
// ---------------------------------------------------------------------------

function PackagesTab({
  sandboxPackages,
  setSandboxPackages,
  sandboxMaxWorkers,
  setSandboxMaxWorkers
}: {
  sandboxPackages: Array<{ name: string; version: string }>
  setSandboxPackages: (pkgs: Array<{ name: string; version: string }>) => void
  sandboxMaxWorkers: number
  setSandboxMaxWorkers: (n: number) => void
}) {
  const api = useSettingsApi()
  const [newPkgName, setNewPkgName] = useState('')
  const [newPkgVersion, setNewPkgVersion] = useState('')
  const [pkgInstalling, setPkgInstalling] = useState<string | null>(null)
  const [pkgError, setPkgError] = useState<string | null>(null)
  const [installedOnDisk, setInstalledOnDisk] = useState<Array<{ name: string; version: string; installedAt: number; size_mb: number; installedBy?: string }>>([])
  const { offerUndo } = useSettingsSave()
  // The list as it is now, for an Undo clicked after later edits.
  const packagesRef = useRef(sandboxPackages)
  packagesRef.current = sandboxPackages

  // Fetch manifest on mount and after installs
  const refreshManifest = useCallback(() => {
    api?.listInstalledSandboxPackages().then((r) => {
      setInstalledOnDisk(r?.packages ?? [])
    })
  }, [])

  useEffect(() => { refreshManifest() }, [refreshManifest])

  const runtimeNames = new Set(sandboxPackages.map((p) => p.name))
  const agentOnlyPackages = installedOnDisk.filter((p) => !runtimeNames.has(p.name))

  const handleInstall = async () => {
    if (!newPkgName.trim()) return
    if (sandboxPackages.some((p) => p.name === newPkgName.trim())) {
      setPkgError('Package already added')
      return
    }
    setPkgInstalling(newPkgName.trim())
    setPkgError(null)
    try {
      const result = await api?.installSandboxPackages([
        { name: newPkgName.trim(), version: newPkgVersion.trim() || 'latest' }
      ])
      const r = result?.results?.[newPkgName.trim()]
      if (r?.success) {
        setSandboxPackages([...sandboxPackages, {
          name: newPkgName.trim(),
          version: r.version ?? (newPkgVersion.trim() || 'latest')
        }])
        setNewPkgName('')
        setNewPkgVersion('')
        refreshManifest()
      } else {
        setPkgError(r?.error ?? 'Install failed')
      }
    } catch (err) {
      setPkgError(String(err))
    }
    setPkgInstalling(null)
  }

  const removePackage = (pkg: { name: string; version: string }) => {
    setSandboxPackages(sandboxPackages.filter((p) => p.name !== pkg.name))
    offerUndo(`Removed ${pkg.name}. Agents that import it fail until it is back.`, () => {
      if (!packagesRef.current.some((p) => p.name === pkg.name)) setSandboxPackages([...packagesRef.current, pkg])
    })
  }

  return (
    <>
      {/* Sandbox resource ceiling — the one knob that decides how much of the
          machine code execution is allowed to claim across every agent. */}
      <SettingsGroup title="Sandbox" docs={DOCS.codeExecution}>
        <SettingsRow
          label={<>Workers<InfoHint tip="Most sandbox workers running lambdas at once, across all agents. Each is a JavaScript isolate of about 5 MB; executions above the ceiling wait for a free slot. 0 is automatic: half this computer's CPU cores, from 4 to 32." /></>}
          description="0 is automatic."
        >
          <CommitInput
            aria-label="Workers"
            inputMode="numeric"
            value={String(sandboxMaxWorkers)}
            onCommit={(v) => { const r = checkWholeNumber(v, 0, 256); if (r.ok) setSandboxMaxWorkers(r.value) }}
            check={(v) => { const r = checkWholeNumber(v, 0, 256); return r.ok ? null : r.error }}
            className="!w-24 !text-[12px]"
          />
        </SettingsRow>
      </SettingsGroup>

      {/* Runtime packages — available to all agents */}
      <SettingsGroup title="Packages" description="Available to every agent; pure JavaScript only.">
        {sandboxPackages.length > 0 && (
          <ul className="border-t border-[var(--adf-ui-separator)]">
            {sandboxPackages.map((pkg) => (
              <li key={pkg.name} className="flex items-center justify-between gap-2 border-b border-[var(--adf-ui-separator)] px-4 py-2 last:border-b-0">
                <span className="min-w-0 truncate font-mono text-[12px] text-[var(--adf-ui-text)]">
                  {pkg.name}<span className="text-[var(--adf-ui-text-subtle)]">@{pkg.version}</span>
                </span>
                <IconButton
                  onClick={() => removePackage(pkg)}
                  aria-label={`Remove ${pkg.name}`}
                  variant="danger"
                  title="Remove"
                >
                  &times;
                </IconButton>
              </li>
            ))}
          </ul>
        )}
        <SettingsRow separator label="Add" error={pkgError}>
          <div className="flex items-center gap-2">
            <TextInput
              aria-label="Package name"
              aria-invalid={!!pkgError}
              type="text"
              value={newPkgName}
              onChange={(e) => { setNewPkgName(e.target.value); setPkgError(null) }}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleInstall() }}
              placeholder="vega-lite"
              spellCheck={false}
              className="!w-44 font-mono !text-[12px]"
            />
            <TextInput
              aria-label="Package version"
              aria-invalid={!!pkgError}
              type="text"
              value={newPkgVersion}
              onChange={(e) => { setNewPkgVersion(e.target.value); setPkgError(null) }}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleInstall() }}
              placeholder="latest"
              spellCheck={false}
              className="!w-24 font-mono !text-[12px]"
            />
            <Button
              onClick={handleInstall}
              disabled={!newPkgName.trim() || !!pkgInstalling}
              loading={!!pkgInstalling}
              variant="primary"
              size="compact"
              className="whitespace-nowrap"
            >
              {pkgInstalling ? 'Installing...' : 'Install'}
            </Button>
          </div>
        </SettingsRow>
      </SettingsGroup>

      {/* Agent-installed packages — installed on disk by agents via npm_install */}
      {agentOnlyPackages.length > 0 && (
        <SettingsGroup
          title="Installed by agents"
          description="On disk; an agent uses one when its config lists it."
          hint="Installed by individual agents with npm_install. Promote installs one for every agent."
        >
          <ul className="border-t border-[var(--adf-ui-separator)]">
            {agentOnlyPackages.map((pkg) => (
              <li key={pkg.name} className="flex items-center justify-between gap-2 border-b border-[var(--adf-ui-separator)] px-4 py-2 last:border-b-0">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-mono text-[12px] text-[var(--adf-ui-text)]">
                    {pkg.name}<span className="text-[var(--adf-ui-text-subtle)]">@{pkg.version}</span>
                  </span>
                  {pkg.installedBy && (
                    <span className="shrink-0 rounded bg-[var(--adf-ui-surface-hover)] px-1.5 py-0.5 text-[11px] text-[var(--adf-ui-text-muted)]">
                      {pkg.installedBy}
                    </span>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-[11px] text-[var(--adf-ui-text-subtle)]">
                    {pkg.size_mb} MB
                  </span>
                  <Tooltip tip="Install for every agent">
                    <Button
                      onClick={() => {
                        setSandboxPackages([...sandboxPackages, { name: pkg.name, version: pkg.version }])
                      }}
                      variant="ghost"
                      size="compact"
                      className="whitespace-nowrap"
                    >
                      Promote
                    </Button>
                  </Tooltip>
                </div>
              </li>
            ))}
          </ul>
        </SettingsGroup>
      )}
    </>
  )
}

/**
 * Settings, with its one save model (settings-save.tsx): "Saved" in the
 * header, refusals and Undo as toasts. Multi-runtime (multi-runtime.md
 * §6.3): the runtime pages show the runtime the picker names; the body is
 * drawn anew for each pick, so every runtime page reads that runtime. Studio
 * pages are This computer's whatever the pick.
 */
export function SettingsPage() {
  const runtimes = useRuntimes()
  const [picked, setPicked] = useState<RuntimeId>(initialSettingsRuntime)
  // Asked for while Settings is open: an agent window's Settings link, a status-bar group.
  const requested = useSettingsRuntimeStore((s) => s.requested)
  useEffect(() => {
    if (requested === null) return
    const id = useSettingsRuntimeStore.getState().take()
    if (id) setPicked(id)
  }, [requested])
  // A picked runtime that left the set: This computer.
  const runtimeId = runtimes.some((r) => r.id === picked) ? picked : LOCAL_RUNTIME
  const [activeTab, setActiveTab] = useState<SettingsTab>('appearance')
  const [settingsSearch, setSettingsSearch] = useState('')
  const runtimePage = RUNTIME_NAV_ITEMS.some((item) => item.id === activeTab)
  return (
    <SettingsRuntimeProvider runtimeId={runtimeId}>
      <SettingsSaveProvider api={runtimePage ? apiFor(runtimeId) : window.adfApi}>
        <SettingsPageBody
          key={runtimeId}
          runtimeId={runtimeId}
          onPick={setPicked}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          settingsSearch={settingsSearch}
          setSettingsSearch={setSettingsSearch}
        />
        <SettingsToasts />
      </SettingsSaveProvider>
    </SettingsRuntimeProvider>
  )
}

function SettingsPageBody({ runtimeId, onPick, activeTab, setActiveTab, settingsSearch, setSettingsSearch }: {
  runtimeId: RuntimeId
  onPick: (id: RuntimeId) => void
  activeTab: SettingsTab
  setActiveTab: (tab: SettingsTab) => void
  settingsSearch: string
  setSettingsSearch: (search: string) => void
}) {
  const api = useSettingsApi()
  const { commit, track, offerUndo } = useSettingsSave()
  const [confirmDialog, confirm] = useConfirm()
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  // Lists that render from settings show a placeholder until the first load
  // lands, so an empty state never flashes before the real rows.
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const [defaultProviderId, setDefaultProviderId] = useState<string | undefined>(undefined)
  const [systemPrompt, setSystemPrompt] = useState('')
  const [compactionPrompt, setCompactionPrompt] = useState('')
  const [toolPrompts, setToolPrompts] = useState<Record<string, string>>({})
  const [expandedPromptKey, setExpandedPromptKey] = useState<string | null>(null)
  /** Unsaved prompt text by editor ('global', 'compaction', or a toolPrompts key); kept while Settings is open. */
  const [promptDrafts, setPromptDrafts] = useState<Record<string, string>>({})
  const setPromptDraft = (key: string, next: string | undefined) => setPromptDrafts((drafts) => {
    const { [key]: _old, ...rest } = drafts
    return next === undefined ? rest : { ...rest, [key]: next }
  })
  const [autoApplyPromptUpdates, setAutoApplyPromptUpdates] = useState(false)
  const [mcpServers, setMcpServers] = useState<McpServerRegistration[]>([])
  const [adapterRegistrations, setAdapterRegistrations] = useState<AdapterRegistration[]>([])
  const connection = useCurrentConnection()
  const runtimes = useRuntimes()
  const multi = runtimes.length > 1
  // The runtime the pages show: the picked one; with one runtime, this window's connection, as before.
  const runtime = multi ? runtimes.find((r) => r.id === runtimeId) ?? null : connection
  const remote = runtime?.kind === 'remote'
  const runtimeName = runtime?.name ?? 'the runtime'
  // Runtime names show with more than one runtime (§6.3); the picker is the heading then.
  const navGroups = settingsNavGroups()
  const pickedMesh = runtimeId === LOCAL_RUNTIME ? undefined : runtimeId
  // '' = default (Documents/adf-agents); saved directly, not via the debounced bundle
  const [agentsFolder, setAgentsFolder] = useState('')
  const [computeHostAccessEnabled, setComputeHostAccessEnabled] = useState(false)
  const [computeHostApproved, setComputeHostApproved] = useState<string[]>([])
  const [computeHostApprovedSources, setComputeHostApprovedSources] = useState<Record<string, string>>({})
  // Live view of the registrations for transition-based reconciliation — the
  // async install-completion callback must diff against the CURRENT list, not
  // a render-scoped snapshot (stale prev could replay an old transition).
  const mcpServersRef = useRef<McpServerRegistration[]>([])
  useEffect(() => { mcpServersRef.current = mcpServers }, [mcpServers])
  // Live mirrors of the host-approval state so the reconcile compounds
  // correctly across two onServersChanged calls between renders (render-scope
  // reads would be one step stale).
  const computeHostApprovedRef = useRef<string[]>([])
  const computeHostApprovedSourcesRef = useRef<Record<string, string>>({})
  useEffect(() => { computeHostApprovedRef.current = computeHostApproved }, [computeHostApproved])
  useEffect(() => { computeHostApprovedSourcesRef.current = computeHostApprovedSources }, [computeHostApprovedSources])
  const [computeEnvStatus, setComputeEnvStatus] = useState<ComputeEnvView>({ status: 'stopped', activeAgents: [] })
  const [computeContainerPackages, setComputeContainerPackages] = useState('python3, python3-pip, git, curl')
  const [computeMachineCpus, setComputeMachineCpus] = useState(2)
  const [computeMachineMemoryMb, setComputeMachineMemoryMb] = useState(2048)
  const [computeContainerImage, setComputeContainerImage] = useState('docker.io/library/node:20-alpine')
  const [computeExecutionTargets, setComputeExecutionTargets] = useState<ExecutionTarget[]>([])
  const [nativeNotifications, setNativeNotifications] = useState(true)
  const [menuBar, setMenuBar] = useState(true)
  const [updateChecks, setUpdateChecks] = useState(true)
  const [remoteCatalogs, setRemoteCatalogs] = useState(true)
  const [providerChecks, setProviderChecks] = useState(true)
  const [spellcheckDownloads, setSpellcheckDownloads] = useState(false)
  const [spellcheckStatus, setSpellcheckStatus] = useState<string | null>(null)
  const [spellcheckBusy, setSpellcheckBusy] = useState(false)
  const [sandboxPackages, setSandboxPackages] = useState<Array<{ name: string; version: string }>>([])
  /** 0 = automatic (CPU-derived). The main process applies it to the sandbox
   *  service the moment the debounced save lands — no restart needed. */
  const [sandboxMaxWorkers, setSandboxMaxWorkers] = useState(0)
  const theme = useAppStore((s) => s.theme)
  const setTheme = useAppStore((s) => s.setTheme)
  const chatWidth = useAppStore((s) => s.chatWidth)
  const uiFont = useAppStore((s) => s.uiFont)
  const setUiFont = useAppStore((s) => s.setUiFont)
  const uiFontCustom = useAppStore((s) => s.uiFontCustom)
  const setUiFontCustom = useAppStore((s) => s.setUiFontCustom)
  const uiScale = useAppStore((s) => s.uiScale)
  const setUiScale = useAppStore((s) => s.setUiScale)
  const agentAvatars = useAppStore((s) => s.agentAvatars)
  const setAgentAvatars = useAppStore((s) => s.setAgentAvatars)
  // Free-text family is committed on blur / Enter, not per keystroke.
  const [uiFontCustomDraft, setUiFontCustomDraft] = useState(uiFontCustom)
  useEffect(() => setUiFontCustomDraft(uiFontCustom), [uiFontCustom])
  const setChatWidth = useAppStore((s) => s.setChatWidth)
  const setShowSettings = useAppStore((s) => s.setShowSettings)
  const consumePendingSettingsSection = useAppStore((s) => s.consumePendingSettingsSection)
  const hasLoaded = useRef(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pendingSave = useRef<(() => Promise<unknown> | void) | null>(null)
  /** The providers part the store last accepted; a refused save marks the rows that differ from it. */
  const savedProviders = useRef<ProviderListSnapshot>({ providers: [], defaultProviderId: undefined })
  /** The lists as this page last loaded or wrote them: a save applies this page's edit onto the stored lists (agent windows). */
  const savedLists = useRef<SettingsLists>({ providers: [], defaultProviderId: undefined, mcpServers: [], adapters: [] })
  const [providerSaveFailure, setProviderSaveFailure] = useState<ProviderSaveFailure | null>(null)
  const contentScrollRef = useRef<HTMLElement>(null)
  const activeNavItem = SETTINGS_NAV_ITEMS.find((item) => item.id === activeTab) ?? SETTINGS_NAV_ITEMS[0]
  const runtimePage = RUNTIME_NAV_ITEMS.some((item) => item.id === activeTab)
  const runtimeUnreachable = runtimePage && runtimeDown(runtime)
  const normalizedSearch = settingsSearch.trim().toLowerCase()
  const visibleNavGroups = normalizedSearch
    ? navGroups.map((group) => ({
        ...group,
        items: group.items.filter((item) =>
          `${item.label} ${item.description} ${item.keywords}`.toLowerCase().includes(normalizedSearch)
        ),
      })).filter((group) => group.items.length > 0)
    : navGroups

  // Honor a pending settings section requested by a home dashboard tile.
  // Runs once on mount; the store action also clears the pending value.
  useEffect(() => {
    const pending = consumePendingSettingsSection()
    if (pending) setActiveTab(settingsTabFor(pending, useAppStore.getState().pendingSettingsAnchor))
  }, [consumePendingSettingsSection])

  useEffect(() => {
    contentScrollRef.current?.scrollTo({ top: 0 })
  }, [activeTab])

  // A deep link may name a group inside the tab (home's token count opens
  // Usage). The group may not exist until the tab has painted, and sections
  // above it can grow as their data arrives, so try across frames and settle
  // once more shortly after.
  const pendingAnchor = useAppStore((s) => s.pendingSettingsAnchor)
  useEffect(() => {
    if (!pendingAnchor) return
    const scrollTo = (): boolean => {
      const main = contentScrollRef.current
      const target = main?.querySelector<HTMLElement>(`[data-settings-anchor="${pendingAnchor}"]`)
      if (!main || !target) return false
      const top = target.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop - 12
      main.scrollTo({ top: Math.max(0, top) })
      return true
    }
    let tries = 0
    let frame = 0
    let observer: ResizeObserver | undefined
    let stop: ReturnType<typeof setTimeout> | undefined
    const main = contentScrollRef.current
    // Consuming the anchor re-runs this effect (it is a dependency), so it
    // happens only in release(): consuming earlier would tear the observer
    // down the moment it was attached.
    const release = () => {
      observer?.disconnect()
      observer = undefined
      if (stop) clearTimeout(stop)
      main?.removeEventListener('wheel', release)
      main?.removeEventListener('touchstart', release)
      useAppStore.getState().consumePendingSettingsAnchor()
    }
    const attempt = () => {
      if (scrollTo()) {
        // Groups above the target grow as their data arrives, which drags the
        // target away or leaves the first scroll clamped short. Follow the
        // content for a moment, unless the user takes over the scroll.
        const content = main?.firstElementChild
        if (main && content && typeof ResizeObserver !== 'undefined') {
          observer = new ResizeObserver(() => { scrollTo() })
          observer.observe(content)
          main.addEventListener('wheel', release, { passive: true })
          main.addEventListener('touchstart', release, { passive: true })
          stop = setTimeout(release, 2500)
        } else {
          release()
        }
        return
      }
      if (++tries < 30) frame = requestAnimationFrame(attempt)
      else release()
    }
    frame = requestAnimationFrame(attempt)
    return () => {
      cancelAnimationFrame(frame)
      if (observer || stop) release()
    }
  }, [pendingAnchor, activeTab])

  useEffect(() => {
    // Studio pages' keys are This computer's whatever runtime is picked (§6.3).
    const studioKeys = (settings: Record<string, unknown>) => {
      setNativeNotifications(settings.nativeNotificationsEnabled !== false)
      setMenuBar(settings.menuBarEnabled !== false)
      setUpdateChecks(settings.updateChecksEnabled !== false)
      setRemoteCatalogs(settings.remoteCatalogsEnabled !== false)
      setProviderChecks(settings.providerChecksEnabled !== false)
      setSpellcheckDownloads(settings.spellcheckDownloadsEnabled === true)
    }
    if (runtimeId !== LOCAL_RUNTIME) {
      window.adfApi?.getSettings().then((settings) => studioKeys(settings as unknown as Record<string, unknown>))
        .catch((err: unknown) => console.warn('[Settings] The settings of the local runtime were not read:', err))
    }
    api?.getSettings().then((settings) => {
      const loadedProviders = (settings.providers as ProviderConfig[]) ?? []
      setProviders(loadedProviders)
      savedProviders.current = { providers: loadedProviders, defaultProviderId: (settings.defaultProviderId as string | undefined) || undefined }
      // Hydration fixup: if providers exist but no default is set (existing users
      // before this feature shipped), pick the first one. The auto-save effect
      // will persist this back to disk on the next debounce tick.
      const loadedDefault = (settings.defaultProviderId as string | undefined) ?? undefined
      if (loadedDefault && loadedProviders.some((p) => p.id === loadedDefault)) {
        setDefaultProviderId(loadedDefault)
      } else if (loadedProviders.length > 0) {
        setDefaultProviderId(loadedProviders[0].id)
      } else {
        setDefaultProviderId(undefined)
      }
      setMcpServers((settings.mcpServers as McpServerRegistration[]) ?? [])
      savedLists.current = settingsListsOf(settings as unknown as Record<string, unknown>)
      setAdapterRegistrations((settings.adapters as AdapterRegistration[]) ?? [])
      setSystemPrompt(
        (settings.globalSystemPrompt as string) ?? DEFAULT_BASE_PROMPT
      )
      setCompactionPrompt(
        (settings.compactionPrompt as string) ?? DEFAULT_COMPACTION_PROMPT
      )
      setToolPrompts(
        (settings.toolPrompts as Record<string, string>) ?? { ...DEFAULT_TOOL_PROMPTS, ...DEFAULT_DYNAMIC_PROMPTS }
      )
      setAutoApplyPromptUpdates(settings[PROMPT_AUTO_UPDATE_KEY] === true)
      if (runtimeId === LOCAL_RUNTIME) studioKeys(settings as unknown as Record<string, unknown>)
      setSandboxPackages((settings.sandboxPackages as Array<{ name: string; version: string }>) ?? [])
      setSandboxMaxWorkers((settings.sandboxMaxWorkers as number) ?? 0)
      setAgentsFolder((settings.agentsFolder as string) ?? '')
      const compute = settings.compute as {
        hostAccessEnabled?: boolean; hostApproved?: string[]; hostApprovedSources?: Record<string, string>;
        containerPackages?: string[]; machineCpus?: number; machineMemoryMb?: number; containerImage?: string;
        executionTargets?: ExecutionTarget[];
      } | undefined
      if (compute) {
        setComputeHostAccessEnabled(!!compute.hostAccessEnabled)
        setComputeHostApproved(compute.hostApproved ?? [])
        computeHostApprovedRef.current = compute.hostApproved ?? []
        setComputeHostApprovedSources(compute.hostApprovedSources ?? {})
        computeHostApprovedSourcesRef.current = compute.hostApprovedSources ?? {}
        if (compute.containerPackages) setComputeContainerPackages(compute.containerPackages.join(', '))
        if (compute.machineCpus) setComputeMachineCpus(compute.machineCpus)
        if (compute.machineMemoryMb) setComputeMachineMemoryMb(compute.machineMemoryMb)
        if (compute.containerImage) setComputeContainerImage(compute.containerImage)
        setComputeExecutionTargets(compute.executionTargets ?? [])
      }
      hasLoaded.current = true
      setSettingsLoaded(true)
    })
  }, [])

  // Auto-save on change (debounced) — flushes immediately on unmount.
  //
  // `pendingSave` is re-pointed on every render, not only from the effect
  // below: a child's effect runs before this component's effect, so a child
  // that adds a provider and flushes right away (ProvidersPanel opening a
  // freshly picked provider) would otherwise persist the *previous* render's
  // values and main would not yet know the new provider exists. Returning the
  // setSettings promise lets callers await the write before asking main to
  // read it back.
  const shownLists = useRef<SettingsLists>(savedLists.current)
  shownLists.current = { providers, defaultProviderId, mcpServers, adapters: adapterRegistrations }
  const doSave = async () => {
    if (!hasLoaded.current) return
    const shown: SettingsLists = { providers, defaultProviderId, mcpServers, adapters: adapterRegistrations }
    // Onto the lists stored now: another window's change to them is kept, not overwritten (agent windows).
    const lists = await listsToWrite(savedLists.current, shown, async () => (await api.getSettings()) as unknown as Record<string, unknown>)
    const attempted: ProviderListSnapshot = { providers: lists.providers, defaultProviderId: lists.defaultProviderId }
    const written = async () => {
      const result = await api?.setSettings({
      providers: lists.providers,
      defaultProviderId: lists.defaultProviderId,
      mcpServers: lists.mcpServers,
      adapters: lists.adapters,
      })
      const outcome = settingsWriteOutcome(result)
      if (!outcome.ok) throw new Error(outcome.error)
    }
    // A refused save (the daemon's secret store locked, say) never reads as
    // saved: the rows it concerns say why, and the edits stay for the next try.
    const saving = saveProviderList(written, savedProviders.current, attempted).then((result) => {
      if (result.saved) {
        savedProviders.current = attempted
        savedLists.current = lists
        // Shown: what was written, with any edit made while the save was in flight on top.
        const now = shownLists.current
        const next = rebaseSettingsLists(shown, now, lists)
        if (!sameContent(next.providers, now.providers)) setProviders(next.providers)
        if (next.defaultProviderId !== now.defaultProviderId) setDefaultProviderId(next.defaultProviderId)
        if (!sameContent(next.mcpServers, now.mcpServers)) setMcpServers(next.mcpServers)
        if (!sameContent(next.adapters, now.adapters)) setAdapterRegistrations(next.adapters)
      }
      setProviderSaveFailure(result.failure)
      return result.saved ? { ok: true as const } : { ok: false as const, error: result.error ?? 'The settings could not be saved.' }
    })
    invalidateConfigCaches()
    // The edits stay on a refusal (the rows say why), so the next change retries them.
    return track(saving)
  }
  pendingSave.current = doSave

  useEffect(() => {
    if (!hasLoaded.current) return
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => { void pendingSave.current?.() }, 500)
    return () => clearTimeout(saveTimer.current)
    // Re-arm the debounce whenever a persisted value changes; the payload itself
    // is read from pendingSave, which every render refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers, defaultProviderId, mcpServers, adapterRegistrations])

  // Flush pending save on unmount so changes aren't lost
  useEffect(() => {
    return () => {
      if (pendingSave.current) pendingSave.current()
    }
  }, [])

  /**
   * Persist now instead of on the debounce tick, and resolve once the write has
   * landed — provider Test / Fetch models ask main to read these values back.
   */
  const flushSave = useCallback(async (): Promise<void> => {
    clearTimeout(saveTimer.current)
    await pendingSave.current?.()
  }, [])

  /** Show `next` now and write it; a refusal puts `prev` back. */
  const persist = <T,>(patch: Record<string, unknown>, set: (value: T) => void, next: T, prev: T) => {
    set(next)
    return commit(patch, () => set(prev))
  }

  /** compute.* keys: the store merges a partial compute object. */
  const persistCompute = <T,>(key: string, set: (value: T) => void, next: T, prev: T) => {
    set(next)
    invalidateConfigCaches()
    return commit({ compute: { [key]: next } }, () => set(prev))
  }

  const saveSandboxPackages = (next: Array<{ name: string; version: string }>) =>
    persist({ sandboxPackages: next }, setSandboxPackages, next, sandboxPackages)
  const saveSandboxMaxWorkers = (next: number) =>
    persist({ sandboxMaxWorkers: next }, setSandboxMaxWorkers, next, sandboxMaxWorkers)

  /** Allow on a host registration in Settings → MCP: asks, then the switch on and the server approved for its package. */
  const allowRegistrationOnHost = async (reg: McpServerRegistration) => {
    if (!await confirm({ ...HOST_ACCESS_CONFIRM, body: `${HOST_ACCESS_CONFIRM.body} ${reg.name} is approved to run on the host.` })) return
    const runtime = { hostAccessEnabled: computeHostAccessEnabled, hostApproved: computeHostApprovedRef.current, hostApprovedSources: computeHostApprovedSourcesRef.current }
    const patch = allowHostPatch(reg.name, registrationSourceIdentity(reg), true, runtime)
    const prev = { enabled: computeHostAccessEnabled, approved: runtime.hostApproved, sources: runtime.hostApprovedSources }
    const set = (state: { enabled: boolean; approved: string[]; sources: Record<string, string> }) => {
      computeHostApprovedRef.current = state.approved
      computeHostApprovedSourcesRef.current = state.sources
      setComputeHostAccessEnabled(state.enabled)
      setComputeHostApproved(state.approved)
      setComputeHostApprovedSources(state.sources)
    }
    set({ enabled: true, approved: patch.hostApproved ?? prev.approved, sources: patch.hostApprovedSources ?? prev.sources })
    invalidateConfigCaches()
    await commit({ compute: patch }, () => set(prev))
  }

  /** Host approval changes: both lists in one write, the live refs kept in step. */
  const saveHostApproval = (approved: string[], sources: Record<string, string>) => {
    const prev = { approved: computeHostApprovedRef.current, sources: computeHostApprovedSourcesRef.current }
    const set = (state: { approved: string[]; sources: Record<string, string> }) => {
      computeHostApprovedRef.current = state.approved
      computeHostApprovedSourcesRef.current = state.sources
      setComputeHostApproved(state.approved)
      setComputeHostApprovedSources(state.sources)
    }
    set({ approved, sources })
    invalidateConfigCaches()
    return commit({ compute: { hostApproved: approved, hostApprovedSources: sources } }, () => set(prev))
  }

  const handleThemeChange = (newTheme: 'light' | 'dark' | 'system') => {
    void persist({ theme: newTheme }, setTheme, newTheme, theme)
  }

  const handleAgentAvatarsChange = (mode: AgentAvatarMode) => {
    void persist({ agentAvatars: mode }, setAgentAvatars, mode, agentAvatars)
  }

  const handleUiFontChange = (font: UiFont) => {
    void persist({ uiFont: font }, setUiFont, font, uiFont)
  }

  const commitUiFontCustom = () => {
    const family = uiFontCustomDraft.trim()
    if (family === uiFontCustom) return
    void persist({ uiFontCustom: family }, setUiFontCustom, family, uiFontCustom)
  }

  const handleUiScaleChange = (value: string) => {
    const scale = Number(value) as UiScale
    void persist({ uiScale: scale }, setUiScale, scale, uiScale)
  }

  const handleChooseAgentsFolder = async () => {
    const result = await api?.pickDirectory?.()
    const path = result?.path
    if (!path) return
    void persist({ agentsFolder: path }, setAgentsFolder, path, agentsFolder)
  }

  const handleResetAgentsFolder = () => {
    void persist({ agentsFolder: '' }, setAgentsFolder, '', agentsFolder)
  }

  /** Save a prompt (Save in its editor). Agents read prompts when they start. */
  const savePrompt = (key: 'globalSystemPrompt' | 'compactionPrompt', next: string) => {
    const set = key === 'globalSystemPrompt' ? setSystemPrompt : setCompactionPrompt
    const prev = key === 'globalSystemPrompt' ? systemPrompt : compactionPrompt
    invalidateConfigCaches()
    return persist(key === 'globalSystemPrompt' ? { globalSystemPrompt: next } : { compactionPrompt: next }, set, next, prev)
  }

  /** One tool or dynamic instruction, written as the whole toolPrompts record. */
  const toolPromptsRef = useRef(toolPrompts)
  toolPromptsRef.current = toolPrompts
  const saveToolPrompt = (key: string, next: string) => {
    const prev = toolPromptsRef.current
    const record = { ...prev, [key]: next }
    toolPromptsRef.current = record
    invalidateConfigCaches()
    return persist({ toolPrompts: record }, (value: Record<string, string>) => { toolPromptsRef.current = value; setToolPrompts(value) }, record, prev)
  }

  /** Reset saves the default now; Undo saves the text it replaced. */
  const resetPrompt = (key: 'globalSystemPrompt' | 'compactionPrompt', label: string) => {
    const prev = key === 'globalSystemPrompt' ? systemPrompt : compactionPrompt
    const fallback = key === 'globalSystemPrompt' ? DEFAULT_BASE_PROMPT : DEFAULT_COMPACTION_PROMPT
    void savePrompt(key, fallback).then((saved) => { if (saved) offerUndo(`${label} reset to the default.`, () => void savePrompt(key, prev)) })
  }
  const resetToolPrompt = (key: string, label: string) => {
    const prev = toolPromptsRef.current[key]
    const fallback = DEFAULT_TOOL_PROMPTS[key] ?? DEFAULT_DYNAMIC_PROMPTS[key] ?? ''
    void saveToolPrompt(key, fallback).then((saved) => { if (saved && prev !== undefined) offerUndo(`${label} reset to the default.`, () => void saveToolPrompt(key, prev)) })
  }

  /**
   * Reset every prompt to the current code defaults. This is also the escape
   * hatch for stale stored defaults: the settings store persists the full
   * prompt record on save, so shipped prompt improvements don't reach a store
   * saved under older defaults until reset.
   */
  const handleResetAllPrompts = () => {
    const prev = { globalSystemPrompt: systemPrompt, compactionPrompt, toolPrompts: toolPromptsRef.current }
    const defaults = { globalSystemPrompt: DEFAULT_BASE_PROMPT, compactionPrompt: DEFAULT_COMPACTION_PROMPT, toolPrompts: { ...DEFAULT_TOOL_PROMPTS, ...DEFAULT_DYNAMIC_PROMPTS } }
    const show = (p: typeof prev) => {
      setSystemPrompt(p.globalSystemPrompt)
      setCompactionPrompt(p.compactionPrompt)
      toolPromptsRef.current = p.toolPrompts
      setToolPrompts(p.toolPrompts)
    }
    show(defaults)
    setPromptDrafts({})
    invalidateConfigCaches()
    void commit(defaults, () => show(prev)).then((saved) => {
      if (saved) offerUndo('Every prompt reset to the default.', () => { show(prev); void commit(prev, () => show(defaults)); invalidateConfigCaches() })
    })
  }

  /**
   * Turning auto-update on applies the current defaults right away and records
   * their fingerprint, so the next launch only overwrites again once a release
   * actually changes a shipped prompt.
   */
  const handleAutoApplyPromptUpdates = async (enabled: boolean) => {
    if (!enabled) {
      void persist({ [PROMPT_AUTO_UPDATE_KEY]: false }, setAutoApplyPromptUpdates, false, autoApplyPromptUpdates)
      return
    }
    if (!await confirm({
      title: 'Auto-update prompts',
      body: 'Every prompt on this page is replaced with the current defaults now, and again whenever an update ships new ones. Your changes to them are lost.',
      confirmLabel: 'Replace prompts',
      danger: true,
    })) return
    const defaults = currentPromptDefaults()
    const prev = { auto: autoApplyPromptUpdates, systemPrompt, compactionPrompt, toolPrompts }
    setAutoApplyPromptUpdates(true)
    setPromptDrafts({})
    setSystemPrompt(defaults.globalSystemPrompt)
    setCompactionPrompt(defaults.compactionPrompt)
    toolPromptsRef.current = defaults.toolPrompts
    setToolPrompts(defaults.toolPrompts)
    await commit({
      ...defaults,
      [PROMPT_AUTO_UPDATE_KEY]: true,
      [PROMPT_DEFAULTS_APPLIED_KEY]: promptDefaultsFingerprint(),
    }, () => {
      setAutoApplyPromptUpdates(prev.auto)
      setSystemPrompt(prev.systemPrompt)
      setCompactionPrompt(prev.compactionPrompt)
      setToolPrompts(prev.toolPrompts)
    })
    invalidateConfigCaches()
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden bg-[var(--adf-ui-canvas)] text-[var(--adf-ui-text)]">
      <aside className="flex w-60 shrink-0 flex-col bg-[var(--adf-ui-sidebar)] border-r border-hairline">
        <div className="px-4 pt-4 pb-3">
          <Button
            onClick={() => setShowSettings(false)}
            variant="ghost"
            className="group -ml-2 justify-start"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="transition-transform group-hover:-translate-x-0.5">
              <path d="m15 18-6-6 6-6" />
            </svg>
            Back to app
          </Button>
          <div className="mt-3 relative">
            <svg className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--adf-ui-text-subtle)]" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
            </svg>
            <TextInput
              type="search"
              value={settingsSearch}
              onChange={(event) => setSettingsSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && visibleNavGroups[0]?.items[0]) {
                  setActiveTab(visibleNavGroups[0].items[0].id)
                }
              }}
              placeholder="Search settings"
              aria-label="Search settings"
              className="pl-9 text-xs"
            />
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 pb-4" aria-label="Settings sections">
          {visibleNavGroups.length > 0 ? visibleNavGroups.map((group, groupIndex) => (
            <div key={group.scope} className={groupIndex > 0 ? 'mt-4 pt-3 border-t border-[var(--adf-ui-separator)]' : 'mt-1'} data-settings-scope={group.scope}>
              {group.scope === 'runtime' && multi ? (
                // §6.3: the runtime pages follow the picked runtime; Studio pages do not.
                <div className="mb-1.5 px-2" data-runtime-picker>
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--adf-ui-text-subtle)]">Server</div>
                  <div className="flex items-center gap-1.5">
                    {remote && <RemoteMark />}
                    <Select
                      value={runtimeId}
                      onChange={(event) => onPick(event.target.value)}
                      aria-label="Server"
                      className="h-7 min-w-0 flex-1 text-xs"
                    >
                      {runtimes.map((r) => <option key={r.id} value={r.id}>{runtimeHeader(r)}</option>)}
                    </Select>
                  </div>
                </div>
              ) : group.label && (
                <div className="mb-1 truncate px-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--adf-ui-text-subtle)]" title={group.label}>
                  {group.label}
                </div>
              )}
              <div className="space-y-0.5">
                {group.items.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => setActiveTab(item.id)}
                    aria-current={activeTab === item.id ? 'page' : undefined}
                    className={`flex h-8 w-full items-center gap-2.5 rounded-[var(--adf-ui-control-radius)] px-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--adf-ui-focus)] ${
                      activeTab === item.id
                        ? 'bg-[var(--adf-ui-accent-subtle)] text-[var(--adf-ui-text)]'
                        : 'text-[var(--adf-ui-text-muted)] hover:bg-[var(--adf-ui-surface-hover)] hover:text-[var(--adf-ui-text)]'
                    }`}
                  >
                    <span className={activeTab === item.id ? 'text-[var(--adf-ui-accent)]' : 'text-[var(--adf-ui-text-subtle)]'}>
                      <SettingsNavIcon section={item.id} />
                    </span>
                    <span className="text-xs font-medium truncate">{item.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )) : (
            <div className="px-2 py-6 text-center text-xs text-[var(--adf-ui-text-subtle)]">
              No settings found
            </div>
          )}
        </nav>
      </aside>

      <main ref={contentScrollRef} className="flex-1 min-w-0 overflow-y-auto settings-content">
        <div className="mx-auto max-w-5xl px-8 py-9 lg:px-12">
          <header className="mb-7 border-b border-[var(--adf-ui-separator)] pb-5">
            {/* Multi-runtime: the picked runtime, above every runtime page (§6.3). Inside the header: the siblings after it keep their place. */}
            {runtimePage && <SettingsRuntimeBanner />}
            <div className="flex items-baseline gap-3">
              <h1 className="text-2xl font-semibold tracking-tight text-[var(--adf-ui-text)]">
                {activeNavItem.label}
              </h1>
              <DocsLink href={activeNavItem.docs} label="Docs" className="!text-[11px]" />
              <span className="ml-auto"><SaveIndicator /></span>
            </div>
            <p className="mt-1 text-sm text-[var(--adf-ui-text-muted)]">
              {activeNavItem.description}
            </p>
          </header>

          {runtimeUnreachable && runtime && (
            <p role="status" className="mb-4 rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-warning)]/30 bg-[var(--adf-ui-warning-subtle)] px-3 py-2 text-[12px] text-[var(--adf-ui-text)]">
              {multi ? `Not connected to ${runtime.name}.` : `${CONNECTION_STATE_LABELS[runtime.state]}.`}
            </p>
          )}
          <fieldset disabled={runtimeUnreachable} className="contents">
          <div className="max-w-4xl space-y-5">
          {/* Studio → Appearance, Notifications, Updates, Privacy (client keys, settings-scopes.md §3) */}
          {activeTab === 'appearance' && <>
          <SettingsGroup title="Appearance">
            <SettingsRow label="Theme" description="Choose a light, dark, or operating-system appearance.">
              <SegmentedControl
                value={theme}
                options={[
                  { value: 'light', label: 'Light' },
                  { value: 'dark', label: 'Dark' },
                  { value: 'system', label: 'System' },
                ]}
                onChange={handleThemeChange}
                ariaLabel="Theme"
              />
            </SettingsRow>
            <SettingsRow
              label="Agent avatars"
              description="Show each agent as its orbital or as its emoji in lists, the title bar and the Mesh view."
            >
              <SegmentedControl
                value={agentAvatars}
                options={[
                  { value: 'orbital', label: 'Orbital' },
                  { value: 'emoji', label: 'Emoji' },
                ]}
                onChange={handleAgentAvatarsChange}
                ariaLabel="Agent avatars"
              />
            </SettingsRow>
            <SettingsRow
              label="Chat width"
              description="How wide the loop thread runs when the chat is in the center stage. Comfortable caps it at a reading column; Full uses the whole stage."
              help="Only applies when the chat is in the center. In the side dock the panel is already narrow."
            >
              <SegmentedControl
                value={chatWidth}
                options={[
                  { value: 'comfortable', label: 'Comfortable' },
                  { value: 'full', label: 'Full' },
                ]}
                onChange={setChatWidth}
                ariaLabel="Chat width"
              />
            </SettingsRow>
            <SettingsRow
              label="Font family"
              description="Typeface for the whole interface. System and Inter Tight always work; other presets fall back to the system font if the face isn't installed."
            >
              <div className="flex items-center gap-2">
                <Select
                  className="!w-[150px]"
                  value={uiFont}
                  onChange={(event) => handleUiFontChange(event.target.value as UiFont)}
                  aria-label="Font family"
                >
                  {UI_FONT_PRESETS.map((preset) => {
                    const missing = preset.family !== null && !isFontInstalled(preset.family)
                    return (
                      <option key={preset.value} value={preset.value} disabled={missing}>
                        {preset.label}{missing ? ' (not installed)' : ''}
                      </option>
                    )
                  })}
                  <option value="custom">Custom…</option>
                </Select>
                {uiFont === 'custom' && (
                  <TextInput
                    className="!w-[180px]"
                    value={uiFontCustomDraft}
                    onChange={(event) => setUiFontCustomDraft(event.target.value)}
                    onBlur={commitUiFontCustom}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur()
                    }}
                    placeholder="Font family name"
                    aria-label="Custom font family"
                    spellCheck={false}
                  />
                )}
                {uiFont === 'custom' && uiFontCustom.trim() && !isFontInstalled(uiFontCustom) && (
                  <span className="text-[11px] text-[var(--adf-ui-warning)]">Not found on this system — using the default.</span>
                )}
              </div>
            </SettingsRow>
            <SettingsRow
              label="UI scale"
              description="Scale the entire interface. Ctrl+= / Ctrl+- still zoom on top of this."
            >
              <SegmentedControl
                value={String(uiScale)}
                options={UI_SCALE_OPTIONS.map((scale) => ({
                  value: String(scale),
                  label: `${Math.round(scale * 100)}%`,
                }))}
                onChange={handleUiScaleChange}
                ariaLabel="UI scale"
              />
            </SettingsRow>
          </SettingsGroup>

          </>}

          {activeTab === 'notifications' && <>
          <SettingsGroup title="Notifications">
            <SettingsRow
              label="System notifications"
              description="Show an operating-system notification when an agent needs an approval or asks a question while Studio is not the focused app. Clicking one opens that agent."
              help="Studio never notifies twice: while a window is focused, the in-app notice and the bell badge cover it."
            >
              <Switch label="System notifications" checked={nativeNotifications} onChange={(next) => void persist({ nativeNotificationsEnabled: next }, setNativeNotifications, next, nativeNotifications)} />
            </SettingsRow>
            {window.adfApi?.platform === 'darwin' && (
              <SettingsRow
                label="Menu bar icon"
                description="Show an ADF icon in the macOS menu bar. Its menu lists running agents and requests waiting on you, and the number beside it counts those requests. Clicking an item opens it in Studio."
              >
                <Switch label="Menu bar icon" checked={menuBar} onChange={(next) => void persist({ menuBarEnabled: next }, setMenuBar, next, menuBar)} />
              </SettingsRow>
            )}
          </SettingsGroup>

          </>}

          {activeTab === 'updates' && <>
          <UpdatesGroup />
          <SettingsGroup title="Update checks">
            <SettingsRow
              label="Automatic checks"
              description="Ask GitHub Releases for a newer version after launch and every hour."
              help="Off: Studio never contacts GitHub for updates; nothing downloads until you click the update badge."
            >
              <Switch label="Automatic checks" checked={updateChecks} onChange={(next) => void persist({ updateChecksEnabled: next }, setUpdateChecks, next, updateChecks)} />
            </SettingsRow>
          </SettingsGroup>
          </>}

          {activeTab === 'privacy' && <>
          <SettingsGroup title="Privacy" description="Studio sends no telemetry." docs={DOCS.settingsGeneral}>
            <SettingsRow label="Network traffic" description={<>Every connection Studio and the runtime make.<DocsLink href={NETWORK_DOCS} className="ml-1.5 !text-[11px]" /></>} />
            {window.adfApi?.platform === 'linux' && (
              <SettingsRow
                label="Spell-check dictionaries"
                description="Linux spell check needs Hunspell dictionaries, which Studio downloads from Google only when you click Download. Windows and macOS use the OS spell checker."
                help="Downloaded dictionaries stay in Studio's data folder. After you allow it, a newly added spell-check language is fetched the same way."
              >
                <div className="flex items-center gap-2">
                  <Button
                    disabled={spellcheckBusy}
                    onClick={async () => {
                      setSpellcheckBusy(true)
                      setSpellcheckStatus(null)
                      try {
                        const result = await window.adfApi.downloadSpellcheckDictionaries()
                        if (result.outcome === 'downloaded') {
                          setSpellcheckDownloads(true)
                          setSpellcheckStatus(`Installed: ${result.languages.join(', ')}`)
                        } else if (result.outcome === 'failed') {
                          setSpellcheckDownloads(true)
                          setSpellcheckStatus(result.message)
                        }
                      } finally {
                        setSpellcheckBusy(false)
                      }
                    }}
                  >
                    {spellcheckBusy ? 'Downloading…' : spellcheckDownloads ? 'Download again' : 'Download'}
                  </Button>
                  <span className="text-[12px] text-[var(--adf-ui-text-muted)]">
                    {spellcheckStatus ?? (spellcheckDownloads ? 'Allowed' : 'Not downloaded')}
                  </span>
                </div>
              </SettingsRow>
            )}
          </SettingsGroup>
          </>}

          {/* Runtime → Files and Usage (backend keys) */}
          {activeTab === 'files' && <>
          <SettingsGroup title="Files">
            <SettingsRow label="Agents folder" description="Where agents you claim are saved.">
              <div className="flex items-center gap-2">
                <span
                  className="max-w-[280px] truncate text-[12px] text-[var(--adf-ui-text-muted)]"
                  title={agentsFolder || undefined}
                >
                  {agentsFolder || 'Documents/adf-agents (default)'}
                </span>
                <Button onClick={handleChooseAgentsFolder} size="compact">
                  Choose…
                </Button>
                {agentsFolder && (
                  <Button onClick={handleResetAgentsFolder} variant="ghost" size="compact">
                    Reset
                  </Button>
                )}
              </div>
            </SettingsRow>
          </SettingsGroup>

          </>}

          {activeTab === 'usage' && (
            <div data-settings-anchor="usage" className="scroll-mt-4">
              <SettingsGroup title="Usage" docs={DOCS.settingsUsage}>
                <div className="px-4 pb-4"><TokenUsageSection /></div>
              </SettingsGroup>
            </div>
          )}

          {/* Agent defaults tab */}
          {activeTab === 'agents' && <>
          <SettingsGroup title="Prompts" description={PROMPTS_COMPOSITION} docs={DOCS.settingsSystemPrompt}>
          <SettingsRow
            label={<>Auto-update<InfoHint tip="When an update ships new default prompts, replace every prompt on this page with them. Off: your prompts stay as they are; Reset all picks up the new defaults." /></>}
          >
            <Switch label="Auto-update" checked={autoApplyPromptUpdates} onChange={(next) => { void handleAutoApplyPromptUpdates(next) }} />
          </SettingsRow>
          <SettingsRow separator label="Defaults">
            <Button onClick={handleResetAllPrompts} variant="ghost" size="compact">
              Reset all
            </Button>
          </SettingsRow>
          <SettingsRow label="System prompt" stacked separator>
            <PromptEditor
              label="System prompt"
              value={systemPrompt}
              defaultValue={DEFAULT_BASE_PROMPT}
              draft={promptDrafts.global}
              onDraft={(next) => setPromptDraft('global', next)}
              onSave={(next) => savePrompt('globalSystemPrompt', next)}
              onReset={() => resetPrompt('globalSystemPrompt', 'System prompt')}
              rows={12}
            />
          </SettingsRow>

          {/* Compaction Prompt */}
          <SettingsRow label="Compaction prompt" description="Used when conversation history is compacted." stacked separator>
            <PromptEditor
              label="Compaction prompt"
              value={compactionPrompt}
              defaultValue={DEFAULT_COMPACTION_PROMPT}
              draft={promptDrafts.compaction}
              onDraft={(next) => setPromptDraft('compaction', next)}
              onSave={(next) => savePrompt('compactionPrompt', next)}
              onReset={() => resetPrompt('compactionPrompt', 'Compaction prompt')}
              rows={8}
            />
          </SettingsRow>
          </SettingsGroup>

          {/* Tool Instructions */}
          <SettingsGroup
            title="Tool instructions"
            description="Conditional prompt sections injected based on enabled tools and features."
            hint={'The ADF Shell guide lives in that tool’s own description, so it travels with the schema rather than sitting here.'}
            docs={DOCS.tools}
          >
            <div className="px-4 pb-4">
              <PromptSectionRows
                defaults={DEFAULT_TOOL_PROMPTS}
                labels={TOOL_PROMPT_LABELS}
                conditions={TOOL_PROMPT_CONDITIONS}
                values={toolPrompts}
                drafts={promptDrafts}
                onDraft={setPromptDraft}
                onSave={saveToolPrompt}
                onReset={(key) => resetToolPrompt(key, TOOL_PROMPT_LABELS[key] ?? key)}
                expandedKey={expandedPromptKey}
                onToggle={setExpandedPromptKey}
              />
            </div>
          </SettingsGroup>

          {/* Dynamic Instructions */}
          <SettingsGroup
            title="Dynamic instructions"
            description="Per-turn injections: inbox status, context warnings, mesh updates, idle reminders."
            hint={'Never part of the cached system prompt; {{token}} placeholders are filled at injection time. Each agent can toggle these under context.dynamic_instructions.'}
            docs={DOCS.settingsSystemPrompt}
          >
            <div className="px-4 pb-4">
              <PromptSectionRows
                defaults={DEFAULT_DYNAMIC_PROMPTS}
                labels={DYNAMIC_PROMPT_LABELS}
                conditions={DYNAMIC_PROMPT_CONDITIONS}
                values={toolPrompts}
                drafts={promptDrafts}
                onDraft={setPromptDraft}
                onSave={saveToolPrompt}
                onReset={(key) => resetToolPrompt(key, DYNAMIC_PROMPT_LABELS[key] ?? key)}
                expandedKey={expandedPromptKey}
                onToggle={setExpandedPromptKey}
              />
            </div>
          </SettingsGroup>
          </>}

          {/* Agent templates tab */}
          {activeTab === 'template' && (
            <AgentTemplatesTab
              providers={providers}
              defaultProviderId={defaultProviderId}
              onOpenProviders={() => setActiveTab('providers')}
            />
          )}

          {/* Identity tab */}
          {activeTab === 'identity' && <IdentityTab remote={remote} runtimeName={runtimeName} />}

          {/* About tab */}
          {activeTab === 'about' && <AboutTab />}

          {/* Connection: the runtime this window uses (settings-scopes.md §5) */}
          {activeTab === 'connection' && <ConnectionSettings />}

          {/* Packages tab */}
          {activeTab === 'packages' && <PackagesTab
            sandboxPackages={sandboxPackages}
            setSandboxPackages={(next) => void saveSandboxPackages(next)}
            sandboxMaxWorkers={sandboxMaxWorkers}
            setSandboxMaxWorkers={(next) => void saveSandboxMaxWorkers(next)}
          />}

          {/* Providers tab */}
          {activeTab === 'providers' && <SettingsGroup title="Provider checks">
            <SettingsRow
              label={<>Models<InfoHint tip="Sends GET /models with each provider's key. Off = providers are contacted only when you click Test or an agent runs." /></>}
              description="Test each configured provider when Home, the provider list, or an agent review opens."
            >
              <Switch label="Models" checked={providerChecks} onChange={(next) => void persist({ providerChecksEnabled: next }, setProviderChecks, next, providerChecks)} />
            </SettingsRow>
          </SettingsGroup>}
          {activeTab === 'providers' && (
            // No card wrapper: each provider is its own flat block on the canvas.
            <ProvidersPanel
              loaded={settingsLoaded}
              providers={providers}
              setProviders={setProviders}
              defaultProviderId={defaultProviderId}
              setDefaultProviderId={setDefaultProviderId}
              flushSave={flushSave}
              saveFailure={providerSaveFailure}
              onOpenTemplate={() => setActiveTab('template')}
            />
          )}

          {/* MCPs tab */}
          {activeTab === 'mcps' && <SettingsGroup title="Catalog">
            <SettingsRow
              label="Live catalogs"
              description="Fetch the current MCP server registry from GitHub when you open Settings → MCP servers (and the agent registry, when used). Off = only the copies bundled with this build (and the last fetched copy)."
              help="Skill catalogs are listed separately under Skills and can be removed there."
            >
              <Switch label="Live catalogs" checked={remoteCatalogs} onChange={(next) => void persist({ remoteCatalogsEnabled: next }, setRemoteCatalogs, next, remoteCatalogs)} />
            </SettingsRow>
          </SettingsGroup>}
          {activeTab === 'mcps' && (
            // No card wrapper: each server is its own flat block on the canvas.
            <McpStatusDashboard
              mcpServers={mcpServers}
              onServersChanged={(next) => {
                // Keep compute.hostApproved (+ recorded sources) in step with
                // registration run locations: the user's explicit Settings
                // choice IS the host trust decision. Transition-based against
                // the LIVE list (ref, not render snapshot), so manual edits in
                // the Compute tab win and async install completions cannot
                // replay stale transitions.
                const prev = mcpServersRef.current
                const state = reconcileHostApprovedRegistrations(
                  prev, next, computeHostApprovedRef.current, computeHostApprovedSourcesRef.current,
                )
                // saveHostApproval updates the refs synchronously, so a second call this tick compounds.
                const changed = state.approved.length !== computeHostApprovedRef.current.length
                  || state.approved.some((n, i) => n !== computeHostApprovedRef.current[i])
                  || JSON.stringify(state.sources) !== JSON.stringify(computeHostApprovedSourcesRef.current)
                if (changed) void saveHostApproval(state.approved, state.sources)
                mcpServersRef.current = next
                setMcpServers(next)
              }}
              hostAccessEnabled={computeHostAccessEnabled}
              hostApproved={computeHostApproved}
              hostApprovedSources={computeHostApprovedSources}
              onAllowHost={(reg) => void allowRegistrationOnHost(reg)}
              onEnableHostAccess={() => { void confirm(HOST_ACCESS_CONFIRM).then((yes) => { if (yes) void persistCompute('hostAccessEnabled', setComputeHostAccessEnabled, true, computeHostAccessEnabled) }) }}
            />
          )}

          {/* Skills tab */}
          {activeTab === 'skills' && <SkillsTab />}

          {/* Channels tab */}
          {activeTab === 'channels' && (
            // No card wrapper: each channel is its own flat block on the canvas.
            <ChannelsPanel
              adapters={adapterRegistrations}
              onAdaptersChanged={setAdapterRegistrations}
            />
          )}

          {/* Networking tab: agent messaging (NetworkingSettings.tsx); remote access is in Connections. */}
          {activeTab === 'networking' && <NetworkingSettings remote={remote} runtimeName={runtimeName} pickedMesh={pickedMesh} />}

          {/* Compute tab */}
          {activeTab === 'compute' && <>
          <ComputeTab
            computeEnvStatus={computeEnvStatus}
            setComputeEnvStatus={setComputeEnvStatus}
            computeHostAccessEnabled={computeHostAccessEnabled}
            setComputeHostAccessEnabled={(v) => void persistCompute('hostAccessEnabled', setComputeHostAccessEnabled, v, computeHostAccessEnabled)}
            computeHostApproved={computeHostApproved}
            revokeHostServer={(name) => {
              const sources = { ...computeHostApprovedSourcesRef.current }
              delete sources[name]
              void saveHostApproval(computeHostApprovedRef.current.filter((n) => n !== name), sources)
            }}
            containerPackages={computeContainerPackages}
            setContainerPackages={(v) => void persistCompute('containerPackages', (list: string[]) => setComputeContainerPackages(list.join(', ')), v.split(',').map((x) => x.trim()).filter(Boolean), computeContainerPackages.split(',').map((x) => x.trim()).filter(Boolean))}
            machineCpus={computeMachineCpus}
            setMachineCpus={(v) => void persistCompute('machineCpus', setComputeMachineCpus, v, computeMachineCpus)}
            machineMemoryMb={computeMachineMemoryMb}
            setMachineMemoryMb={(v) => void persistCompute('machineMemoryMb', setComputeMachineMemoryMb, v, computeMachineMemoryMb)}
            containerImage={computeContainerImage}
            setContainerImage={(v) => void persistCompute('containerImage', setComputeContainerImage, v, computeContainerImage)}
            executionTargets={computeExecutionTargets}
            setExecutionTargets={setComputeExecutionTargets}
          />
          </>}
          </div>
          </fieldset>
          {confirmDialog}
        </div>
      </main>
    </div>
  )
}

/** COMPUTE_STATUS as Settings → Compute reads it. `leftRunning`: containers the
 *  last stop left running because another runtime uses them (W1-G). */
type ComputeEnvView = { status: string; activeAgents: string[]; leftRunning?: Array<{ name: string; holders: string[]; reason: string }> }

/** Compute settings tab — extracted for useEffect on mount. */
function ComputeTab({
  computeEnvStatus, setComputeEnvStatus,
  computeHostAccessEnabled, setComputeHostAccessEnabled,
  computeHostApproved, revokeHostServer,
  containerPackages, setContainerPackages,
  machineCpus, setMachineCpus,
  machineMemoryMb, setMachineMemoryMb,
  containerImage, setContainerImage,
  executionTargets, setExecutionTargets,
}: {
  computeEnvStatus: ComputeEnvView
  setComputeEnvStatus: (s: ComputeEnvView) => void
  computeHostAccessEnabled: boolean
  setComputeHostAccessEnabled: (v: boolean) => void
  computeHostApproved: string[]
  revokeHostServer: (name: string) => void
  containerPackages: string
  setContainerPackages: (v: string) => void
  machineCpus: number
  setMachineCpus: (v: number) => void
  machineMemoryMb: number
  setMachineMemoryMb: (v: number) => void
  containerImage: string
  setContainerImage: (v: string) => void
  executionTargets: ExecutionTarget[]
  setExecutionTargets: React.Dispatch<React.SetStateAction<ExecutionTarget[]>>
}) {
  const api = useSettingsApi()
  const [availability, setAvailability] = useState<PodmanAvailability | null>(null)
  const [setupBusy, setSetupBusy] = useState(false)
  const [setupError, setSetupError] = useState<string | null>(null)
  const [setupLog, setSetupLog] = useState<string | null>(null)

  const [containers, setContainers] = useState<ContainerSummary[]>([])
  const [selectedContainer, setSelectedContainer] = useState<string | null>(null)
  const [containerFilter, setContainerFilter] = useState<'all' | 'running' | 'stopped'>('all')
  const [busyContainer, setBusyContainer] = useState<string | null>(null)
  const [openContainerMenu, setOpenContainerMenu] = useState<string | null>(null)
  const [destroyRequest, setDestroyRequest] = useState<ContainerDestroyRequest | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [showTargetForm, setShowTargetForm] = useState(false)
  const [targetDraft, setTargetDraft] = useState({ name: '', engine: 'docker' as 'docker' | 'podman', containerRef: '', workdir: '/workspace', pinId: false })
  const [targetBusy, setTargetBusy] = useState(false)
  const [targetMessage, setTargetMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

  const { commit, offerUndo } = useSettingsSave()
  const [confirmDialog, confirm] = useConfirm()
  /** Host access is a grant: asked for by name when it turns on, never when it turns off. */
  const switchHostAccess = async (next: boolean) => {
    if (next && !await confirm(HOST_ACCESS_CONFIRM)) return
    setComputeHostAccessEnabled(next)
  }
  const confirmRevoke = async (name: string) => {
    if (await confirm({
      title: 'Revoke host server',
      body: `${name} runs in the container from its next start, unless its agent has host access.`,
      confirmLabel: 'Revoke',
      danger: true,
    })) revokeHostServer(name)
  }
  /** Resolves false on a refusal (the toast says why; the list is unchanged). */
  const saveExecutionTargets = useCallback(async (targets: ExecutionTarget[]) => {
    const saved = await commit({ compute: { executionTargets: targets } })
    if (saved) {
      setExecutionTargets(targets)
      invalidateConfigCaches()
    }
    return saved
  }, [commit, setExecutionTargets])

  const refreshAll = useCallback(() => {
    api?.computeStatus?.().then((s: ComputeEnvView) => {
      if (s) setComputeEnvStatus(s)
    })
    api?.computeSetup?.({ step: 'check' }).then((r: { success: boolean; availability?: PodmanAvailability }) => {
      if (r?.availability) setAvailability(r.availability)
    })
    api?.computeListContainers?.().then((r: { containers: ContainerSummary[] }) => {
      if (r?.containers) setContainers(r.containers)
    })
  }, [])

  // Fetch on mount
  useEffect(() => { refreshAll() }, [])

  /** Both actions run `podman rm -f`. Rebuild recreates right away when the
   *  container's owner is known from its labels (shared, or a dedicated one);
   *  a legacy container has no owner label, so its agent's next start does it. */
  const runDestroy = useCallback(async ({ container, action, isShared }: ContainerDestroyRequest) => {
    const rebuilding = action === 'rebuild'
    setBusyContainer(container.name)
    setSetupError(null)
    setSetupLog(rebuilding ? `Rebuilding ${container.name}...` : `Removing ${container.name}...`)
    try {
      const result = isShared
        ? await api.computeDestroy()
        : rebuilding
          ? await api.computeRebuildContainer({ name: container.name })
          : await api.computeDestroyContainer({ name: container.name })
      if (!result.success) throw new Error(result.error ?? (rebuilding ? 'Rebuild failed' : 'Remove failed'))
      if (isShared) {
        const init = await api.computeInit()
        if (!init.success) throw new Error(init.error ?? 'Recreate failed')
      }
      const recreated = isShared || ('recreated' in result && result.recreated === true)
      setSetupLog(
        rebuilding
          ? recreated ? 'Container rebuilt.' : 'Container removed. It will be recreated when the agent starts.'
          : 'Container deleted.'
      )
      setDestroyRequest(null)
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : String(err))
      setSetupLog(null)
      setDestroyRequest(null)
    } finally {
      setBusyContainer(null)
      refreshAll()
    }
  }, [refreshAll])

  const runStep = async (step: 'install' | 'machine_init' | 'machine_start', label: string, installCommand?: string) => {
    setSetupBusy(true)
    setSetupError(null)
    setSetupLog(`Running: ${label}...`)
    try {
      const r = await api?.computeSetup?.({ step, installCommand })
      if (r?.success) {
        setSetupLog(`${label} completed`)
        if (r.availability) setAvailability(r.availability)
        refreshAll()
      } else {
        setSetupError(r?.error ?? `${label} failed`)
        setSetupLog(null)
      }
    } catch (err) {
      setSetupError(String(err))
      setSetupLog(null)
    } finally {
      setSetupBusy(false)
    }
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
    setSetupLog(`Copied to clipboard: ${text}`)
  }

  // Determine setup state
  const prereqsSatisfied = (availability?.prerequisites ?? []).every((p) => p.installed)
  const needsInstall = availability && !availability.available
  const ready =
    availability?.available &&
    prereqsSatisfied &&
    (!availability.machineRequired || availability.machineRunning)

  return (
    <div className="flex flex-col gap-5">
    <SettingsGroup
      title="Containers"
      description="Podman containers that ADF sets up and manages; the recommended way to run agent code."
      hint={'ADF manages Podman setup, container lifecycle, agent assignment, workspaces, and rebuilds.\n\nMCP servers use the shared container by default; agents can also receive a dedicated container for stronger isolation. Installed packages and dedicated containers persist across agent restarts.'}
      docs={DOCS.settingsCompute}
    >
      <div className="px-4 pb-4">
      {/* Container inventory */}
      <div className="mb-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-[11px] text-[var(--adf-ui-text-muted)]">{containers.filter((container) => container.running).length} running · {containers.length} total</p>
            {(computeEnvStatus.leftRunning ?? []).map((kept) => (
              <p key={kept.name} className="text-[11px] text-[var(--adf-ui-text-muted)]">{kept.name} was left running: {kept.reason}.</p>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <SegmentedControl
              ariaLabel="Filter containers"
              value={containerFilter}
              onChange={setContainerFilter}
              options={[{ value: 'all', label: 'All' }, { value: 'running', label: 'Running' }, { value: 'stopped', label: 'Stopped' }]}
            />
            <Tooltip tip="Refresh containers">
              <IconButton aria-label="Refresh containers" onClick={refreshAll}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13.25 5.75A5.75 5.75 0 1 0 13 10.9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><path d="M13.25 2.75v3h-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </IconButton>
            </Tooltip>
          </div>
        </div>

        <div className="overflow-visible rounded-[var(--adf-ui-container-radius)] border border-[var(--adf-ui-border)] bg-[var(--adf-ui-surface)]">
          <div className="grid grid-cols-[minmax(180px,1.5fr)_105px_minmax(110px,1fr)_88px] gap-3 border-b border-[var(--adf-ui-separator)] px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-[var(--adf-ui-text-subtle)]">
            <span>Container</span><span>Status</span><span>Assigned to</span><span className="text-right">Actions</span>
          </div>
          {containers.filter((container) => containerFilter === 'all' || (containerFilter === 'running' ? container.running : !container.running)).map((c) => {
            const isShared = c.scope === 'shared' || c.name === 'adf-mcp'
            const rowBusy = busyContainer === c.name
            const failed = c.state === 'failed'
            return (
              <div key={c.id || c.name} className="grid grid-cols-[minmax(180px,1.5fr)_105px_minmax(110px,1fr)_88px] items-center gap-3 border-b border-[var(--adf-ui-separator)] px-3 py-2.5 last:border-b-0">
                <button className="flex min-w-0 items-center gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--adf-ui-focus)]" onClick={() => setSelectedContainer(c.name)}>
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-[var(--adf-ui-control-radius)] bg-[var(--adf-ui-canvas)] text-[var(--adf-ui-text-muted)]"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4.5 7.7 7.5 4.2 7.5-4.2M12 12v9"/></svg></span>
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium text-[var(--adf-ui-text)]">{c.name}</span>
                    <span className="block truncate font-mono text-[11px] text-[var(--adf-ui-text-muted)]">{c.image || 'Image unavailable'}</span>
                  </span>
                </button>
                <span>
                  {failed ? (
                    <Tooltip tip={c.error ?? 'Container setup failed'}>
                      <span className="flex items-center gap-1.5 text-[11px] text-[var(--adf-ui-danger)]"><span className="size-1.5 rounded-full bg-[var(--adf-ui-danger)]" />Setup failed</span>
                    </Tooltip>
                  ) : (
                    <span className="flex items-center gap-1.5 text-[11px] text-[var(--adf-ui-text)]"><span className={`size-1.5 rounded-full ${c.running ? 'bg-[var(--adf-ui-success)]' : 'bg-[var(--adf-ui-text-subtle)]'}`} />{c.running ? 'Running' : 'Stopped'}</span>
                  )}
                  <span className="mt-0.5 block text-[11px] text-[var(--adf-ui-text-muted)]">{isShared ? 'Shared' : c.scope === 'legacy' ? 'Legacy' : 'Dedicated'}</span>
                  {c.managed && c.outdated && (
                    <Tooltip tip={OUTDATED_CONTAINER_ADVISORY}>
                      <span className="mt-0.5 inline-flex items-center gap-1 rounded bg-[var(--adf-ui-surface-hover)] px-1.5 py-0.5 text-[11px] text-[var(--adf-ui-text-muted)]">
                        <span className="size-1 rounded-full bg-[var(--adf-ui-text-subtle)]" aria-hidden="true" />Rebuild available
                      </span>
                    </Tooltip>
                  )}
                </span>
                <span className="min-w-0 text-[11px] text-[var(--adf-ui-text-muted)]">
                  <span className="block truncate">{isShared ? `${computeEnvStatus.activeAgents.length} active agents` : c.agentName || c.agentId || 'Unassigned'}</span>
                  {c.users && c.users.length > 0 && <span className="block truncate text-[11px]">Also used by {c.users.join(', ')}</span>}
                </span>
                <div className="relative flex justify-end gap-1">
                  <Tooltip tip={failed ? 'Setup failed: rebuild to retry' : c.managed ? (c.running ? 'Stop' : 'Start') : 'Legacy container: rebuild to migrate before managing'}>
                    <IconButton
                      aria-label={`${c.running ? 'Stop' : 'Start'} ${c.name}`}
                      disabled={rowBusy || !c.managed || failed}
                      onClick={async () => {
                        setBusyContainer(c.name); setSetupError(null)
                        try {
                          const stopQuestion = containerStopConfirmation(c, isShared, computeEnvStatus.activeAgents)
                          if (stopQuestion && !await confirm({ title: `Stop ${c.name}`, body: stopQuestion, confirmLabel: 'Stop', danger: true })) return
                          const result = c.running ? await api.computeStopContainer({ name: c.name }) : await api.computeStartContainer({ name: c.name })
                          if (!result.success) setSetupError(result.error ?? `${c.running ? 'Stop' : 'Start'} failed`)
                        } finally { setBusyContainer(null); refreshAll() }
                      }}
                    >
                      {c.running ? <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="1.5"/></svg> : <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="m5 3 7.5 5L5 13V3Z"/></svg>}
                    </IconButton>
                  </Tooltip>
                  <Tooltip tip="More actions">
                    <IconButton aria-label={`More actions for ${c.name}`} disabled={rowBusy} onClick={() => setOpenContainerMenu(openContainerMenu === c.name ? null : c.name)}>
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="8" r="1.2"/><circle cx="8" cy="8" r="1.2"/><circle cx="13" cy="8" r="1.2"/></svg>
                    </IconButton>
                  </Tooltip>
                  {openContainerMenu === c.name && (
                    <div className="absolute right-0 top-8 z-20 w-40 rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] bg-[var(--adf-ui-surface-raised)] p-1 shadow-[var(--adf-ui-dialog-shadow)]">
                      <button className="w-full rounded px-2 py-1.5 text-left text-[11px] text-[var(--adf-ui-text)] hover:bg-[var(--adf-ui-surface-hover)]" onClick={() => { setSelectedContainer(c.name); setOpenContainerMenu(null) }}>View details</button>
                      <button
                        className="w-full rounded px-2 py-1.5 text-left text-[11px] text-[var(--adf-ui-warning)] hover:bg-[var(--adf-ui-surface-hover)] disabled:opacity-50"
                        title={c.managed || isShared ? 'Remove and recreate this container' : 'Remove this pre-label container so ADF recreates a managed one'}
                        onClick={() => { setOpenContainerMenu(null); setDestroyRequest({ container: c, action: 'rebuild', isShared, activeAgents: isShared ? computeEnvStatus.activeAgents : [] }) }}
                      >Rebuild</button>
                      {!isShared && <button
                        className="w-full rounded px-2 py-1.5 text-left text-[11px] text-[var(--adf-ui-danger)] hover:bg-[var(--adf-ui-danger-subtle)] disabled:opacity-50"
                        disabled={c.running}
                        title={c.running ? 'Stop the container before removing it' : 'Permanently delete this container'}
                        onClick={() => { setOpenContainerMenu(null); setDestroyRequest({ container: c, action: 'remove', isShared: false, activeAgents: [] }) }}
                      >Remove</button>}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
          {containers.filter((container) => containerFilter === 'all' || (containerFilter === 'running' ? container.running : !container.running)).length === 0 && (
            <div className="px-3 py-8 text-center text-[11px] text-[var(--adf-ui-text-muted)]">{containers.length === 0 ? 'No ADF containers yet.' : `No ${containerFilter} containers.`}</div>
          )}
        </div>
      </div>

      {/* Status messages — for post-setup container operations (Rebuild etc).
          During setup, the wizard shows its own status block, so avoid duplication. */}
      {ready && setupLog && (
        <p className={`mb-3 text-[11px] font-mono ${setupLogTone(setupLog)}`}>{setupLog}</p>
      )}
      {ready && setupError && (
        <p className="mb-3 text-[11px] text-red-600 dark:text-red-400 font-mono">{setupError}</p>
      )}

      {/* Setup wizard — shown when Podman needs installation or setup */}
      {availability && !ready && (
        <SetupWizard
          availability={availability}
          setupBusy={setupBusy}
          setupLog={setupLog}
          setupError={setupError}
          prereqsSatisfied={prereqsSatisfied}
          needsInstall={!!needsInstall}
          onRefresh={refreshAll}
          onInstall={(cmd) => runStep('install', cmd, cmd)}
          onMachineInit={() => runStep('machine_init', 'podman machine init')}
          onMachineStart={() => runStep('machine_start', 'podman machine start')}
          onCopy={copyToClipboard}
        />
      )}

      {/* Podman status */}
      {ready && (
        <p className="text-[11px] text-[var(--adf-ui-success)]">
          Podman v{availability?.version} ready
        </p>
      )}
      </div>
    </SettingsGroup>

      {/* Container configuration: each field commits on Enter or when it loses focus. */}
    <SettingsGroup
      title="Default container"
      description="Applies to new containers and rebuilds."
      hint="Packages install with apt-get on Debian-based images and apk on Alpine. CPUs and Memory size the Podman machine on macOS and Windows; on Linux, containers use this computer's resources."
    >
      <SettingsRow label="Image">
        <CommitInput
          aria-label="Image"
          value={containerImage}
          onCommit={(v) => setContainerImage(v.trim())}
          check={(v) => (v.trim() ? null : 'Enter an image.')}
          spellCheck={false}
          className="!w-72 font-mono !text-[12px]"
          placeholder="docker.io/library/node:20-alpine"
        />
      </SettingsRow>
      <SettingsRow separator label={<>Packages<InfoHint tip="System packages, comma-separated." /></>}>
        <CommitInput
          aria-label="Packages"
          value={containerPackages}
          onCommit={setContainerPackages}
          spellCheck={false}
          className="!w-72 font-mono !text-[12px]"
          placeholder="python3, python3-pip, git, curl"
        />
      </SettingsRow>
      <SettingsRow separator label="CPUs">
        <CommitInput
          aria-label="CPUs"
          inputMode="numeric"
          value={String(machineCpus)}
          onCommit={(v) => { const r = checkWholeNumber(v, 1, 16); if (r.ok) setMachineCpus(r.value) }}
          check={(v) => { const r = checkWholeNumber(v, 1, 16); return r.ok ? null : r.error }}
          className="!w-24 !text-[12px]"
        />
      </SettingsRow>
      <SettingsRow separator label={<>Memory<InfoHint tip="In megabytes." /></>}>
        <CommitInput
          aria-label="Memory"
          inputMode="numeric"
          value={String(machineMemoryMb)}
          onCommit={(v) => { const r = checkWholeNumber(v, 512, 32768); if (r.ok) setMachineMemoryMb(r.value) }}
          check={(v) => { const r = checkWholeNumber(v, 512, 32768); return r.ok ? null : r.error }}
          className="!w-24 !text-[12px]"
        />
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup className="overflow-hidden">
      <button
        type="button"
        aria-expanded={advancedOpen}
        onClick={() => setAdvancedOpen((open) => !open)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <span>
          <span className="block text-[13px] font-semibold text-[var(--adf-ui-text)]">Advanced</span>
          <span className="mt-0.5 block text-[12px] text-[var(--adf-ui-text-muted)]">Host access and custom Docker or Podman containers.</span>
        </span>
        <span className="flex items-center gap-2 text-[11px] text-[var(--adf-ui-text-muted)]">
          {executionTargets.length > 0 || computeHostAccessEnabled ? `${executionTargets.length + (computeHostAccessEnabled ? 1 : 0)} configured` : 'Configure'}
          <svg className={`transition-transform ${advancedOpen ? 'rotate-180' : ''}`} width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </span>
      </button>
    </SettingsGroup>

    {advancedOpen && <>
    {/* Host access: the runtime-wide switch and the servers approved to run on the host. */}
    <SettingsGroup title="Host">
      <SettingsRow
        label={<>Host access<InfoHint tip="An agent also needs its own compute.host_access, or an approved MCP server, before anything runs on the host." /></>}
        description="Host execution bypasses container isolation."
      >
        <Switch label="Host access" checked={computeHostAccessEnabled} onChange={(next) => void switchHostAccess(next)} />
      </SettingsRow>
      {computeHostAccessEnabled && (
        <SettingsRow
          separator
          stacked
          label={<>Approved servers<InfoHint tip="MCP servers allowed to run on the host for agents without host access. A server chosen to run on the host in Settings → MCP servers is added here." /></>}
        >
          {computeHostApproved.length === 0 ? (
            <p className="text-[12px] text-[var(--adf-ui-text-subtle)]">None.</p>
          ) : (
            <ul className="space-y-1">
              {computeHostApproved.map((name) => (
                <li key={name} className="flex items-center justify-between gap-2 rounded-[var(--adf-ui-control-radius)] bg-[var(--adf-ui-canvas)] px-2 py-1">
                  <span className="font-mono text-[12px] text-[var(--adf-ui-text)]">{name}</span>
                  <Button onClick={() => void confirmRevoke(name)} variant="danger" size="compact">
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </SettingsRow>
      )}
    </SettingsGroup>

    {/* Containers you manage: ADF only runs commands in them. */}
    <SettingsGroup
      title="Custom containers"
      description="Docker or Podman containers you keep under your own control."
      hint="ADF runs commands in these and never starts, stops, provisions, rebuilds or removes them."
    >
      <div className="px-4 pb-4">
      <div className="flex items-start justify-end gap-3">
        <Button size="compact" onClick={() => { setShowTargetForm((value) => !value); setTargetMessage(null) }}>
          {showTargetForm ? 'Cancel' : 'Add target'}
        </Button>
      </div>

      {executionTargets.length > 0 && (
        <div className="mt-3 divide-y divide-[var(--adf-ui-separator)]">
          {resolveExecutionTargetAliases(executionTargets).map(({ target, alias }) => (
            <div key={target.id} className="flex items-center gap-3 py-2.5">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-[var(--adf-ui-control-radius)] bg-[var(--adf-ui-accent-subtle)] text-[var(--adf-ui-accent)]">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4.5 7.7 7.5 4.2 7.5-4.2M12 12v9"/></svg>
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-xs font-medium text-[var(--adf-ui-text)]">{target.name}</span>
                  <span className="rounded bg-[var(--adf-ui-accent-subtle)] px-1.5 py-0.5 text-[11px] text-[var(--adf-ui-accent)]">{target.engine}</span>
                </div>
                <p className="truncate font-mono text-[11px] text-[var(--adf-ui-text-muted)]">{alias} · {target.containerRef} · {target.workdir}</p>
              </div>
              <Button
                size="compact"
                variant="danger"
                onClick={async () => {
                  setTargetMessage(null)
                  if (await saveExecutionTargets(executionTargets.filter((item) => item.id !== target.id))) {
                    offerUndo(`Removed ${alias}.`, () => {
                      void api?.getSettings().then((s) => {
                        const now = (s?.compute?.executionTargets ?? []) as ExecutionTarget[]
                        if (!now.some((item) => item.id === target.id)) void saveExecutionTargets([...now, target])
                      })
                    })
                  }
                }}
              >Remove</Button>
            </div>
          ))}
        </div>
      )}

      {executionTargets.length === 0 && !showTargetForm && (
        <p className="mt-3 text-[11px] italic text-[var(--adf-ui-text-subtle)]">No external targets configured.</p>
      )}

      {showTargetForm && (
        <div className="mt-3 border-t border-[var(--adf-ui-separator)] pt-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="text-[11px] text-[var(--adf-ui-text-muted)]">
              Display name
              <TextInput className="mt-1" value={targetDraft.name} onChange={(event) => setTargetDraft((draft) => ({ ...draft, name: event.target.value }))} placeholder="Local Python tools" />
            </label>
            <label className="text-[11px] text-[var(--adf-ui-text-muted)]">
              Engine
              <Select className="mt-1" value={targetDraft.engine} onChange={(event) => setTargetDraft((draft) => ({ ...draft, engine: event.target.value as 'docker' | 'podman' }))}>
                <option value="docker">Docker</option>
                <option value="podman">Podman</option>
              </Select>
            </label>
            <label className="text-[11px] text-[var(--adf-ui-text-muted)]">
              Container name or ID
              <TextInput className="mt-1 font-mono" value={targetDraft.containerRef} onChange={(event) => setTargetDraft((draft) => ({ ...draft, containerRef: event.target.value }))} placeholder="my-running-container" />
            </label>
            <label className="text-[11px] text-[var(--adf-ui-text-muted)]">
              Working directory
              <TextInput className="mt-1 font-mono" value={targetDraft.workdir} onChange={(event) => setTargetDraft((draft) => ({ ...draft, workdir: event.target.value }))} placeholder="/workspace" />
            </label>
          </div>
          <label className="mt-3 flex items-center gap-2 text-[11px] text-[var(--adf-ui-text-muted)]">
            <input type="checkbox" checked={targetDraft.pinId} onChange={(event) => setTargetDraft((draft) => ({ ...draft, pinId: event.target.checked }))} />
            Pin this container ID; do not follow the name when the container is recreated
          </label>
          {targetMessage && (
            <p className={`mt-2 text-[11px] ${targetMessage.kind === 'error' ? 'text-[var(--adf-ui-danger)]' : 'text-[var(--adf-ui-success)]'}`}>{targetMessage.text}</p>
          )}
          <div className="mt-3 flex justify-end">
            <Button
              variant="primary"
              loading={targetBusy}
              disabled={!targetDraft.name.trim() || !targetDraft.containerRef.trim() || !targetDraft.workdir.trim()}
              onClick={async () => {
                const candidate: LocalContainerExecutionTarget = {
                  id: `target-${crypto.randomUUID()}`,
                  name: targetDraft.name.trim(),
                  alias: nextExecutionTargetAlias(targetDraft.name.trim(), targetDraft.engine, executionTargets),
                  kind: 'local-container',
                  engine: targetDraft.engine,
                  containerRef: targetDraft.containerRef.trim(),
                  workdir: targetDraft.workdir.trim(),
                }
                setTargetBusy(true)
                setTargetMessage(null)
                try {
                  const result = await api.computeTestExecutionTarget(candidate)
                  if (!result.success) {
                    setTargetMessage({ kind: 'error', text: result.error ?? 'Target test failed.' })
                    return
                  }
                  if (targetDraft.pinId && result.containerId) candidate.expectedContainerId = result.containerId
                  if (!await saveExecutionTargets([...executionTargets, candidate])) return
                  setTargetMessage({ kind: 'success', text: `Connected to ${result.containerName ?? candidate.containerRef}.` })
                  setTargetDraft({ name: '', engine: 'docker', containerRef: '', workdir: '/workspace', pinId: false })
                  setShowTargetForm(false)
                } catch (err) {
                  setTargetMessage({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
                } finally {
                  setTargetBusy(false)
                }
              }}
            >Test and add</Button>
          </div>
        </div>
      )}
      </div>
    </SettingsGroup>
    </>}

      {/* Container detail modal */}
      {selectedContainer && (() => {
        const c = containers.find((x) => x.name === selectedContainer)
        if (!c) return null
        return <ContainerDetailPanel container={c} onClose={() => setSelectedContainer(null)} />
      })()}

      {confirmDialog}
      <ContainerDestroyDialog
        request={destroyRequest}
        busy={busyContainer === destroyRequest?.container.name}
        onCancel={() => setDestroyRequest(null)}
        onConfirm={runDestroy}
      />
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Setup wizard — detect-and-guide for the compute environment.
// ────────────────────────────────────────────────────────────────────────────

type StepStatus = 'done' | 'pending' | 'blocked' | 'in_progress' | 'failed'

function StatusBadge({ status, index }: { status: StepStatus; index: number }) {
  const base = 'w-4 h-4 shrink-0 rounded-full text-[11px] flex items-center justify-center font-semibold'
  if (status === 'done') return <span className={`${base} bg-green-500 text-white`}>{'\u2713'}</span>
  if (status === 'failed') return <span className={`${base} bg-red-500 text-white`}>{'\u00d7'}</span>
  if (status === 'in_progress')
    return <span className={`${base} bg-blue-500 text-white animate-pulse`}>{index}</span>
  if (status === 'blocked')
    return <span className={`${base} bg-neutral-200 dark:bg-neutral-700 text-[var(--adf-ui-text-subtle-on-fill)]`}>{index}</span>
  return <span className={`${base} bg-neutral-300 dark:bg-neutral-600 text-neutral-600 dark:text-neutral-300`}>{index}</span>
}

function SetupWizard({
  availability,
  setupBusy,
  setupLog,
  setupError,
  prereqsSatisfied,
  needsInstall,
  onRefresh,
  onInstall,
  onMachineInit,
  onMachineStart,
  onCopy,
}: {
  availability: PodmanAvailability
  setupBusy: boolean
  setupLog: string | null
  setupError: string | null
  prereqsSatisfied: boolean
  needsInstall: boolean
  onRefresh: () => void
  onInstall: (command: string) => void
  onMachineInit: () => Promise<void> | void
  onMachineStart: () => Promise<void> | void
  onCopy: (text: string) => void
}) {
  // Step status logic ----------------------------------------------------------
  const prereqs = availability.prerequisites ?? []

  // Map each step to its current status. Order: prerequisites → podman → machine init → machine start.
  const prereqStatuses: StepStatus[] = prereqs.map((p) => (p.installed ? 'done' : 'pending'))

  const podmanStatus: StepStatus = availability.available
    ? 'done'
    : !prereqsSatisfied
      ? 'blocked'
      : 'pending'

  const machineInitStatus: StepStatus = !availability.machineRequired
    ? 'done'
    : availability.machineExists
      ? 'done'
      : !availability.available || !prereqsSatisfied
        ? 'blocked'
        : 'pending'

  const machineStartStatus: StepStatus = !availability.machineRequired
    ? 'done'
    : availability.machineRunning
      ? 'done'
      : !availability.machineExists
        ? 'blocked'
        : 'pending'

  // Render ---------------------------------------------------------------------
  return (
    <div className="mb-4 rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-warning)]/30 bg-[var(--adf-ui-warning-subtle)] p-3">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-xs font-semibold text-amber-800 dark:text-amber-300">Setup required</h4>
        <Button
          onClick={onRefresh}
          variant="ghost"
          size="compact"
          className="text-[11px] text-[var(--adf-ui-warning)]"
          disabled={setupBusy}
          title="Re-check the environment (use after installing WSL + reboot, etc.)"
        >
          Re-check
        </Button>
      </div>
      <p className="text-[11px] text-amber-700 dark:text-amber-400 mb-3">
        The compute environment runs MCP servers and agent code inside containers.
        {availability.machineRequired && ' On macOS/Windows, a lightweight Linux VM is also required.'}
      </p>

      <div className="space-y-2">
        {/* Prerequisite steps (Windows: WSL) */}
        {prereqs.map((p, i) => (
          <PrerequisiteRow
            key={p.id}
            index={i + 1}
            status={prereqStatuses[i]}
            prereq={p}
            onCopy={onCopy}
          />
        ))}

        {/* Podman install */}
        <PodmanStep
          index={prereqs.length + 1}
          status={podmanStatus}
          availability={availability}
          needsInstall={needsInstall}
          setupBusy={setupBusy}
          onInstall={onInstall}
          onCopy={onCopy}
        />

        {/* Machine init + start (macOS/Windows only) */}
        {availability.machineRequired && (
          <>
            <MachineInitStep
              index={prereqs.length + 2}
              status={machineInitStatus}
              setupBusy={setupBusy}
              onInit={onMachineInit}
            />
            <MachineStartStep
              index={prereqs.length + 3}
              status={machineStartStatus}
              setupBusy={setupBusy}
              onStart={onMachineStart}
            />
          </>
        )}
      </div>

      {/* Status / error */}
      {setupLog && (
        <p className={`mt-2 text-[11px] font-mono ${setupLogTone(setupLog)}`}>{setupLog}</p>
      )}
      {setupError && (
        <div className="mt-2 p-2 rounded bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
          <p className="text-[11px] text-red-700 dark:text-red-400 font-mono break-words">{setupError}</p>
        </div>
      )}
    </div>
  )
}

function PrerequisiteRow({
  index,
  status,
  prereq,
  onCopy,
}: {
  index: number
  status: StepStatus
  prereq: Prerequisite
  onCopy: (text: string) => void
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 flex-wrap">
        <StatusBadge status={status} index={index} />
        <span className="text-xs text-neutral-700 dark:text-neutral-300 flex-1">
          Install {prereq.name}
        </span>
        {status !== 'done' && prereq.installCommand && (
          <div className="flex items-center gap-1">
            <code className="text-[11px] text-amber-700 dark:text-amber-300 bg-amber-100 dark:bg-amber-900/40 px-1.5 py-0.5 rounded font-mono">
              {prereq.installCommand}
            </code>
            <Button
              onClick={() => onCopy(prereq.installCommand!)}
              size="compact"
              className="text-[11px]"
            >
              Copy
            </Button>
          </div>
        )}
      </div>
      {status !== 'done' && (
        <div className="ml-6 text-[11px] text-amber-700 dark:text-amber-400 space-y-0.5">
          {prereq.description && <p>{prereq.description}</p>}
          {prereq.requiresReboot && (
            <p className="font-semibold">Reboot required after installation, then click Re-check above.</p>
          )}
          {prereq.docsUrl && (
            <a
              href={prereq.docsUrl}
              target="_blank"
              rel="noreferrer"
              className="text-blue-600 dark:text-blue-400 hover:underline"
            >
              Installation docs →
            </a>
          )}
        </div>
      )}
    </div>
  )
}

function PodmanStep({
  index,
  status,
  availability,
  needsInstall,
  setupBusy,
  onInstall,
  onCopy,
}: {
  index: number
  status: StepStatus
  availability: PodmanAvailability
  needsInstall: boolean
  setupBusy: boolean
  onInstall: (command: string) => void
  onCopy: (text: string) => void
}) {
  const autoMethod = availability.installMethods.find((m) => m.autoRunnable)
  const manualMethods = availability.installMethods.filter((m) => !m.autoRunnable)

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 flex-wrap">
        <StatusBadge status={status} index={index} />
        <span className="text-xs text-neutral-700 dark:text-neutral-300 flex-1">
          Install Podman
          {availability.available && availability.version && (
            <span className="text-[var(--adf-ui-text-subtle)] ml-1">v{availability.version}</span>
          )}
        </span>
        {needsInstall && status === 'pending' && autoMethod && (
          <Button
            onClick={() => onInstall(autoMethod.command)}
            disabled={setupBusy}
            loading={setupBusy}
            variant="primary"
            size="compact"
            className="text-[11px]"
          >
            {setupBusy ? 'Installing...' : autoMethod.label}
          </Button>
        )}
      </div>
      {status === 'pending' && !autoMethod && manualMethods.length > 0 && (
        <div className="ml-6 space-y-1">
          {manualMethods.map((m) => m.url ? (
            <div key={m.url} className="flex items-center gap-1">
              <span className="text-[11px] text-neutral-600 dark:text-neutral-400">{m.label}</span>
              <Button
                // main routes window.open to the OS browser (setWindowOpenHandler)
                onClick={() => window.open(m.url, '_blank', 'noopener,noreferrer')}
                size="compact"
                className="text-[11px]"
              >
                Open
              </Button>
            </div>
          ) : (
            <div key={m.command} className="flex items-center gap-1">
              <code className="text-[11px] text-amber-700 dark:text-amber-300 bg-amber-100 dark:bg-amber-900/40 px-1.5 py-0.5 rounded font-mono">
                {m.command}
              </code>
              <Button
                onClick={() => onCopy(m.command)}
                size="compact"
                className="text-[11px]"
              >
                Copy
              </Button>
            </div>
          ))}
        </div>
      )}
      {status === 'blocked' && (
        <p className="ml-6 text-[11px] text-neutral-500 dark:text-neutral-400">
          Complete the prerequisite above first.
        </p>
      )}
    </div>
  )
}

function MachineInitStep({
  index,
  status,
  setupBusy,
  onInit,
}: {
  index: number
  status: StepStatus
  setupBusy: boolean
  onInit: () => Promise<void> | void
}) {
  return (
    <div className="flex items-center gap-2">
      <StatusBadge status={status} index={index} />
      <span className="text-xs text-neutral-700 dark:text-neutral-300 flex-1">
        Initialize Podman machine
      </span>
      {status === 'pending' && (
        <Button
          onClick={onInit}
          disabled={setupBusy}
          loading={setupBusy}
          variant="primary"
          size="compact"
          className="text-[11px]"
        >
          {setupBusy ? 'Initializing...' : 'Initialize'}
        </Button>
      )}
    </div>
  )
}

function MachineStartStep({
  index,
  status,
  setupBusy,
  onStart,
}: {
  index: number
  status: StepStatus
  setupBusy: boolean
  onStart: () => Promise<void> | void
}) {
  return (
    <div className="flex items-center gap-2">
      <StatusBadge status={status} index={index} />
      <span className="text-xs text-neutral-700 dark:text-neutral-300 flex-1">
        Start Podman machine
      </span>
      {status === 'pending' && (
        <Button
          onClick={onStart}
          disabled={setupBusy}
          loading={setupBusy}
          variant="primary"
          size="compact"
          className="text-[11px]"
        >
          {setupBusy ? 'Starting...' : 'Start'}
        </Button>
      )}
    </div>
  )
}

/** Summary-first container inspection using normal application chrome. */
function ContainerDetailPanel({ container, onClose }: { container: ContainerSummary; onClose: () => void }) {
  const api = useSettingsApi()
  type DetailTab = 'summary' | 'activity' | 'logs' | 'processes' | 'workspace' | 'packages' | 'inspect'
  type Detail = { overview: ContainerOverview | null; processes: string; packages: string; workspace: string; logs: string; inspect: string }
  const [tab, setTab] = useState<DetailTab>('summary')
  const [detail, setDetail] = useState<Detail | null>(null)
  const [execLog, setExecLog] = useState<Array<{ timestamp: number; command: string; exitCode: number; stdout: string; stderr: string; durationMs: number }>>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    setLoading(true)
    setError(null)
    Promise.all([
      api.computeContainerDetail({ name: container.name }),
      api.computeExecLog({ name: container.name }),
    ]).then(([d, l]: [any, any]) => {
      if (d?.success) setDetail(d)
      else setError(d?.error ?? 'Container details are unavailable.')
      if (l?.entries) setExecLog(l.entries)
    }).catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [container.name])

  useEffect(() => { refresh() }, [refresh])

  useEffect(() => {
    if (!container.running || (tab !== 'summary' && tab !== 'processes')) return
    const interval = setInterval(refresh, tab === 'processes' ? 5000 : 10_000)
    return () => clearInterval(interval)
  }, [container.running, tab, refresh])

  const tabs: Array<{ id: DetailTab; label: string }> = [
    { id: 'summary', label: 'Summary' },
    { id: 'activity', label: `Activity (${execLog.length})` },
    { id: 'logs', label: 'Logs' },
    { id: 'processes' as const, label: 'Processes' },
    { id: 'workspace' as const, label: 'Workspace' },
    { id: 'packages' as const, label: 'Packages' },
    { id: 'inspect', label: 'Inspect' },
  ]

  const overview = detail?.overview
  const codePanelClass = 'min-h-[260px] whitespace-pre-wrap break-words rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] bg-[var(--adf-ui-canvas)] p-3 font-mono text-[11px] text-[var(--adf-ui-text)]'

  return (
    <Dialog open onClose={onClose} title="Container details" extraWide>
      <div className="flex min-h-[560px] flex-col">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--adf-ui-separator)] pb-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-[var(--adf-ui-control-radius)] bg-[var(--adf-ui-accent-subtle)] text-[var(--adf-ui-accent)]"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4.5 7.7 7.5 4.2 7.5-4.2M12 12v9"/></svg></span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="truncate text-base font-semibold text-[var(--adf-ui-text)]">{container.name}</h3>
                <span className={`rounded px-1.5 py-0.5 text-[11px] ${container.running ? 'bg-[var(--adf-ui-success-subtle)] text-[var(--adf-ui-success)]' : 'bg-[var(--adf-ui-canvas)] text-[var(--adf-ui-text-muted)]'}`}>{container.running ? 'Running' : 'Stopped'}</span>
                <span className="rounded bg-[var(--adf-ui-accent-subtle)] px-1.5 py-0.5 text-[11px] text-[var(--adf-ui-accent)]">{container.scope === 'dedicated' ? 'Dedicated' : container.scope === 'legacy' ? 'Legacy' : 'Shared'}</span>
              </div>
              <p className="truncate font-mono text-[11px] text-[var(--adf-ui-text-muted)]">{overview?.image || container.image}</p>
            </div>
          </div>
          <div className="flex gap-1">
            <Tooltip tip="Refresh details"><IconButton aria-label="Refresh container details" onClick={refresh} disabled={loading}><svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13.25 5.75A5.75 5.75 0 1 0 13 10.9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><path d="M13.25 2.75v3h-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg></IconButton></Tooltip>
            <Tooltip tip="Close"><IconButton aria-label="Close container details" onClick={onClose}><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg></IconButton></Tooltip>
          </div>
        </div>

        <div className="mt-3 flex gap-1 overflow-x-auto border-b border-[var(--adf-ui-separator)] pb-1">
          {tabs.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)} className={`whitespace-nowrap rounded-t px-3 py-1.5 text-[11px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-[var(--adf-ui-focus)] ${tab === t.id ? 'bg-[var(--adf-ui-accent-subtle)] text-[var(--adf-ui-accent)]' : 'text-[var(--adf-ui-text-muted)] hover:bg-[var(--adf-ui-surface-hover)] hover:text-[var(--adf-ui-text)]'}`}>{t.label}</button>
          ))}
        </div>

        <div className="flex-1 pt-4">
          {error && <div className="mb-3 rounded-[var(--adf-ui-control-radius)] bg-[var(--adf-ui-danger-subtle)] px-3 py-2 text-[11px] text-[var(--adf-ui-danger)]">{error} <button className="underline" onClick={refresh}>Retry</button></div>}
          {loading && !detail && <div className="py-12 text-center text-[11px] text-[var(--adf-ui-text-muted)]">Loading container details…</div>}

          {tab === 'summary' && detail && container.managed && container.outdated && (
            <div className="mb-3 flex items-start gap-2 rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] bg-[var(--adf-ui-surface-hover)] px-3 py-2 text-[11px] text-[var(--adf-ui-text-muted)]">
              <span className="mt-1 size-1.5 shrink-0 rounded-full bg-[var(--adf-ui-text-subtle)]" aria-hidden="true" />
              <span className="leading-snug">Rebuild available: it adds network isolation from other agents and erases this container&apos;s workspace files, installed packages and saved browser session.</span>
            </div>
          )}
          {tab === 'summary' && detail && (
            <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
              <section className="rounded-[var(--adf-ui-container-radius)] border border-[var(--adf-ui-border)] p-4">
                <h4 className="mb-3 text-xs font-semibold text-[var(--adf-ui-text)]">Overview</h4>
                <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-2 text-[11px]">
                  <dt className="text-[var(--adf-ui-text-muted)]">State</dt><dd>{overview?.state ?? container.state}</dd>
                  <dt className="text-[var(--adf-ui-text-muted)]">Created</dt><dd>{formatContainerDate(overview?.createdAt ?? container.createdAt)}</dd>
                  <dt className="text-[var(--adf-ui-text-muted)]">Started</dt><dd>{formatContainerDate(overview?.startedAt)}</dd>
                  <dt className="text-[var(--adf-ui-text-muted)]">Network</dt><dd className="font-mono">{overview?.ipAddress || '—'}</dd>
                  <dt className="text-[var(--adf-ui-text-muted)]">PID</dt><dd>{overview?.pid || '—'}</dd>
                  <dt className="text-[var(--adf-ui-text-muted)]">Container ID</dt><dd className="truncate font-mono">{overview?.id || container.id}</dd>
                </dl>
              </section>
              <section className="rounded-[var(--adf-ui-container-radius)] border border-[var(--adf-ui-border)] p-4">
                <h4 className="mb-3 text-xs font-semibold text-[var(--adf-ui-text)]">Assignment</h4>
                <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-2 text-[11px]">
                  <dt className="text-[var(--adf-ui-text-muted)]">Scope</dt><dd>{container.scope === 'dedicated' ? 'Dedicated agent container' : container.scope === 'legacy' ? 'Legacy, unlabeled container' : 'Shared ADF container'}</dd>
                  <dt className="text-[var(--adf-ui-text-muted)]">Agent</dt><dd>{container.agentName || container.agentId || (container.scope === 'shared' ? 'Multiple agents' : '—')}</dd>
                  <dt className="text-[var(--adf-ui-text-muted)]">Workspace</dt><dd className="font-mono">{container.scope === 'dedicated' ? '/workspace' : '/workspace/{agentId}'}</dd>
                  <dt className="text-[var(--adf-ui-text-muted)]">Lifecycle</dt><dd>{container.managed ? 'Managed by ADF' : 'Read-only until rebuilt with ADF labels'}</dd>
                  <dt className="text-[var(--adf-ui-text-muted)]">Command</dt><dd className="truncate font-mono">{overview?.command?.join(' ') || '—'}</dd>
                </dl>
              </section>
            </div>
          )}

          {tab === 'activity' && (
            execLog.length === 0 ? (
              <div className="py-12 text-center text-[11px] text-[var(--adf-ui-text-muted)]">No ADF compute commands recorded this session.</div>
            ) : (
              <div className="space-y-2">
                {[...execLog].reverse().map((e, i) => (
                  <div key={`${e.timestamp}-${i}`} className="rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] p-3">
                    <div className="mb-1 flex items-center gap-2">
                      <span className={`size-1.5 rounded-full ${e.exitCode === 0 ? 'bg-[var(--adf-ui-success)]' : 'bg-[var(--adf-ui-danger)]'}`} />
                      <span className="font-mono text-[11px] text-[var(--adf-ui-text-muted)]">{new Date(e.timestamp).toLocaleTimeString()} · {e.durationMs}ms{e.exitCode !== 0 ? ` · exit ${e.exitCode}` : ''}</span>
                    </div>
                    <pre className="whitespace-pre-wrap break-all font-mono text-[11px] text-[var(--adf-ui-text)]">$ {e.command}</pre>
                    {e.stdout && <pre className="mt-2 whitespace-pre-wrap border-l border-[var(--adf-ui-border)] pl-2 font-mono text-[11px] text-[var(--adf-ui-text-muted)]">{e.stdout}</pre>}
                    {e.stderr && <pre className="mt-2 whitespace-pre-wrap border-l border-[var(--adf-ui-danger)] pl-2 font-mono text-[11px] text-[var(--adf-ui-danger)]">{e.stderr}</pre>}
                  </div>
                ))}
              </div>
            )
          )}

          {tab === 'logs' && <pre className={codePanelClass}>{detail?.logs || (container.running ? 'No container output.' : 'Container is stopped; showing no live output.')}</pre>}
          {tab === 'processes' && <pre className={codePanelClass}>{detail?.processes || (container.running ? 'Processes unavailable.' : 'Container is stopped.')}</pre>}
          {tab === 'workspace' && <pre className={codePanelClass}>{detail?.workspace || (container.running ? 'Workspace unavailable.' : 'Start the container to inspect its workspace.')}</pre>}
          {tab === 'packages' && <pre className={codePanelClass}>{detail?.packages || (container.running ? 'Package information unavailable.' : 'Start the container to inspect packages.')}</pre>}
          {tab === 'inspect' && <pre className={codePanelClass}>{detail?.inspect || 'Inspect data unavailable.'}</pre>}
        </div>
      </div>
    </Dialog>
  )
}

function formatContainerDate(value?: string): string {
  if (!value || /^0001-/.test(value)) return '—'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString()
}
