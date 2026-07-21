import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useAppStore, type SettingsSection } from '../../stores/app.store'
import { DEFAULT_BASE_PROMPT, DEFAULT_TOOL_PROMPTS, DEFAULT_COMPACTION_PROMPT, TOOL_PROMPT_LABELS, TOOL_PROMPT_CONDITIONS, PROVIDER_TYPES } from '../../../shared/constants/adf-defaults'
import type { ProviderType } from '../../../shared/constants/adf-defaults'
import { invalidateConfigCaches } from '../agent/AgentConfig'
import type { ProviderConfig, McpServerRegistration, AdapterRegistration, MeshAgentStatus } from '../../../shared/types/ipc.types'
import { McpStatusDashboard } from '../mcp/McpStatusDashboard'
import { AdapterStatusDashboard } from '../adapters/AdapterStatusDashboard'
import { ProviderCredentialPanel } from '../providers/ProviderCredentialPanel'
import { AboutTab } from './AboutTab'
import { Dialog } from '../common/Dialog'
import { useMeshStore } from '../../stores/mesh.store'
import { Button, IconButton, SegmentedControl, Select, SettingsGroup, SettingsRow, TextInput, Textarea } from '../ui'

type SettingsNavItem = {
  id: SettingsSection
  label: string
  description: string
  keywords: string
}

type SettingsNavGroup = {
  label: string
  items: SettingsNavItem[]
}

const SETTINGS_NAV_GROUPS: SettingsNavGroup[] = [
  {
    label: 'Personal',
    items: [
      { id: 'general', label: 'General', description: 'Appearance, usage, and agent defaults', keywords: 'theme tokens prompts instructions' },
      { id: 'identity', label: 'Identity', description: 'Owner and runtime identity', keywords: 'did mnemonic alias delegation' },
    ],
  },
  {
    label: 'Agent runtime',
    items: [
      { id: 'providers', label: 'Providers', description: 'Models and credentials', keywords: 'anthropic openai chatgpt models api keys' },
      { id: 'packages', label: 'Packages', description: 'Shared JavaScript packages', keywords: 'npm sandbox dependencies' },
      { id: 'mcps', label: 'MCP servers', description: 'External tools and services', keywords: 'model context protocol integrations tools' },
      { id: 'channels', label: 'Channels', description: 'Email, Telegram, and Discord', keywords: 'adapters messages integrations' },
    ],
  },
  {
    label: 'System',
    items: [
      { id: 'networking', label: 'Networking', description: 'Mesh, discovery, and endpoints', keywords: 'lan tailscale mdns peers server' },
      { id: 'compute', label: 'Compute', description: 'Containers and host access', keywords: 'podman machine resources isolation' },
    ],
  },
  {
    label: 'ADF Studio',
    items: [
      { id: 'about', label: 'About', description: 'Version, concepts, and links', keywords: 'help docs github format' },
    ],
  },
]

const SETTINGS_NAV_ITEMS = SETTINGS_NAV_GROUPS.flatMap((group) => group.items)

function SettingsNavIcon({ section }: { section: SettingsSection }) {
  const paths: Record<SettingsSection, React.ReactNode> = {
    general: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.86 2.86-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21H9.55v-.09A1.7 1.7 0 0 0 8.5 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.86-2.86.06-.06A1.7 1.7 0 0 0 4.1 15a1.7 1.7 0 0 0-1.5-1H2.5V10h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.34-1.88l-.06-.06L6.56 4.2l.06.06A1.7 1.7 0 0 0 8.5 4.6a1.7 1.7 0 0 0 1-1.5V3h4.05v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.86 2.86-.06.06A1.7 1.7 0 0 0 19.6 9a1.7 1.7 0 0 0 1.5 1h.1v4h-.1a1.7 1.7 0 0 0-1.7 1Z" /></>,
    identity: <><circle cx="12" cy="8" r="4" /><path d="M4.5 21a7.5 7.5 0 0 1 15 0" /></>,
    providers: <><path d="M8 12h8" /><path d="M12 8v8" /><rect x="4" y="4" width="16" height="16" rx="4" /></>,
    packages: <><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" /><path d="m4.5 7.7 7.5 4.2 7.5-4.2M12 12v9" /></>,
    mcps: <><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M8 17v2a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-2" /><rect x="4" y="7" width="16" height="10" rx="2" /></>,
    channels: <><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" /><path d="M8 9h8M8 13h5" /></>,
    networking: <><circle cx="12" cy="12" r="2" /><path d="M5.6 8.5a7.5 7.5 0 0 1 12.8 0M2.6 5.5a11.5 11.5 0 0 1 18.8 0M8.6 15.5a4 4 0 0 1 6.8 0" /></>,
    compute: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></>,
    about: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>,
  }

  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[section]}
    </svg>
  )
}

function getProviderMeta(type: ProviderType) {
  return PROVIDER_TYPES.find((pt) => pt.type === type) ?? PROVIDER_TYPES[0]
}

type ProviderTestStatus = 'ok' | 'failed' | 'unconfigured' | 'testing' | 'unknown'

function providerDotClass(status?: ProviderTestStatus): string {
  switch (status) {
    case 'ok': return 'bg-green-500'
    case 'failed': return 'bg-red-500'
    case 'unconfigured': return 'bg-amber-400'
    case 'testing': return 'bg-neutral-400 animate-pulse'
    default: return 'bg-neutral-500/40'
  }
}

function providerStatusLabel(status?: ProviderTestStatus): string {
  switch (status) {
    case 'ok': return 'Connected'
    case 'failed': return 'Connection failed'
    case 'unconfigured': return 'Not configured'
    case 'testing': return 'Testing…'
    default: return 'Unknown'
  }
}

function generateProviderId(): string {
  return 'custom:' + Math.random().toString(36).slice(2, 8)
}

function TokenUsageSection() {
  const [tokenUsage, setTokenUsage] = useState<Record<string, Record<string, Record<string, { input: number; output: number }>>>>({})
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    window.adfApi?.getTokenUsage().then((data) => {
      setTokenUsage(data)
    })
  }, [])

  const handleClear = async () => {
    if (!window.confirm('Are you sure you want to clear all token usage data? This cannot be undone.')) {
      return
    }
    await window.adfApi?.clearTokenUsage()
    setTokenUsage({})
  }

  const dates = Object.keys(tokenUsage).sort().reverse()
  const totalInput = dates.reduce((sum, date) => {
    return sum + Object.values(tokenUsage[date]).reduce((providerSum, models) => {
      return providerSum + Object.values(models).reduce((modelSum, usage) => modelSum + usage.input, 0)
    }, 0)
  }, 0)
  const totalOutput = dates.reduce((sum, date) => {
    return sum + Object.values(tokenUsage[date]).reduce((providerSum, models) => {
      return providerSum + Object.values(models).reduce((modelSum, usage) => modelSum + usage.output, 0)
    }, 0)
  }, 0)

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">
          Token Usage
        </label>
        <div className="flex gap-2">
          {dates.length > 0 && (
            <Button
              onClick={handleClear}
              variant="danger"
              size="compact"
            >
              Clear
            </Button>
          )}
          {dates.length > 0 && (
            <Button
              onClick={() => setExpanded(!expanded)}
              variant="ghost"
              size="compact"
            >
              {expanded ? 'Collapse' : 'Expand'}
            </Button>
          )}
        </div>
      </div>

      {dates.length === 0 ? (
        <p className="text-xs text-neutral-400 dark:text-neutral-500">
          No token usage recorded yet.
        </p>
      ) : (
        <div className="rounded-[var(--adf-ui-control-radius)] bg-[var(--adf-ui-canvas)] p-3 ring-1 ring-inset ring-[var(--adf-ui-separator)]">
          <div className="mb-2 text-xs text-[var(--adf-ui-text-muted)]">
            <strong>Total:</strong> {totalInput.toLocaleString()} input + {totalOutput.toLocaleString()} output = {(totalInput + totalOutput).toLocaleString()} tokens
          </div>

          {expanded && (
            <div className="space-y-3 mt-3">
              {dates.map((date) => (
                <div key={date} className="border-t border-[var(--adf-ui-separator)] pt-2">
                  <div className="mb-1 text-xs font-semibold text-[var(--adf-ui-text)]">
                    {date}
                  </div>
                  {Object.entries(tokenUsage[date]).map(([provider, models]) => (
                    <div key={provider} className="ml-3 space-y-1">
                      <div className="text-xs font-medium text-[var(--adf-ui-text-muted)]">
                        {provider}
                      </div>
                      {Object.entries(models).map(([model, usage]) => (
                        <div key={model} className="ml-3 font-mono text-xs text-[var(--adf-ui-text-subtle)]">
                          {model}: {usage.input.toLocaleString()} in + {usage.output.toLocaleString()} out
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

type OwnerIdentityStatusView = {
  ownerDid: string
  runtimeDid: string
  hasMnemonic: boolean
  backupConfirmed: boolean
  legacyOwnerDids: string[]
  legacyRuntimeDids: string[]
  safeStorageAvailable: boolean
  runtimeDelegation: { issuer: string; subject: string; role: string; issued_at: string; expires_at?: string; scope?: string; signature: string } | null
  runtimeDelegationValid: boolean
}

/** Copyable monospace DID/URL row used across the Identity tab. */
function DidRow({ label, value, hint, copied, onCopy }: {
  label: string
  value?: string
  hint?: string
  copied: string | null
  onCopy: (label: string, value?: string) => void
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-0.5">
        <span className="text-xs text-neutral-500 dark:text-neutral-400">{label}</span>
        {value && (
          <Button
            onClick={() => onCopy(label, value)}
            variant="ghost"
            size="compact"
          >
            {copied === label ? 'Copied' : 'Copy'}
          </Button>
        )}
      </div>
      <div className="px-2 py-1.5 text-xs font-mono break-all rounded bg-neutral-100 dark:bg-neutral-700/50 text-neutral-700 dark:text-neutral-300">
        {value ?? 'Not generated yet'}
      </div>
      {hint && <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-0.5">{hint}</p>}
    </div>
  )
}

/**
 * Identity tab: app-level owner + runtime identity. The owner DID is derived
 * from a BIP-39 seed phrase (your user identity, shared across Studios once
 * imported); the runtime DID identifies this install and is certified by an
 * owner-signed delegation. Includes seed backup + import flows.
 */
function IdentityTab() {
  const [status, setStatus] = useState<OwnerIdentityStatusView | null>(null)
  const [meshServer, setMeshServer] = useState<{ running: boolean; port: number; host: string } | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [backupOpen, setBackupOpen] = useState(false)
  const [mnemonic, setMnemonic] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importPhrase, setImportPhrase] = useState('')
  const [importBusy, setImportBusy] = useState(false)
  const [importResult, setImportResult] = useState<{ ok: boolean; message: string } | null>(null)
  // Friendly display names + owner-sharing opt-in (persisted in settings).
  const [ownerAlias, setOwnerAlias] = useState('')
  const [runtimeAlias, setRuntimeAlias] = useState('')
  const [shareOwner, setShareOwner] = useState(false)

  const refresh = useCallback(() => {
    window.adfApi?.getOwnerIdentityStatus().then(setStatus)
    window.adfApi?.getMeshServerStatus().then(setMeshServer)
    window.adfApi?.getSettings?.().then((s: unknown) => {
      const cfg = s as { ownerAlias?: string; runtimeAlias?: string; shareOwnerIdentity?: boolean } | undefined
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
    const r = await window.adfApi?.revealOwnerMnemonic()
    setMnemonic(r?.mnemonic ?? null)
    setBackupOpen(true)
  }

  const confirmBackup = async () => {
    await window.adfApi?.confirmOwnerBackup()
    setBackupOpen(false)
    setMnemonic(null)
    refresh()
  }

  const runImport = async () => {
    setImportBusy(true)
    setImportResult(null)
    try {
      const r = await window.adfApi?.importOwnerMnemonic(importPhrase)
      if (r?.success) {
        setImportResult({ ok: true, message: `Identity imported. ${r.restamped ?? 0} agent file(s) restamped${r.failures?.length ? `, ${r.failures.length} failed` : ''}.` })
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
      {/* Owner identity */}
      <SettingsGroup className="p-4">
        <div className="flex items-center justify-between mb-1">
          <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">
            Owner Identity
          </label>
          {status && status.hasMnemonic && (
            status.backupConfirmed ? (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">
                Seed backed up
              </span>
            ) : (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400">
                Seed not backed up
              </span>
            )
          )}
        </div>
        <p className="text-xs text-neutral-400 dark:text-neutral-500 mb-3">
          Who you are. Rooted in a 12-word seed phrase generated on first launch — import the same phrase on
          another Studio to be the same owner there. Stamped into agent files you claim or clone, and used to
          sign ownership attestations for your agents.
        </p>
        {status && !status.safeStorageAvailable && (
          <p className="text-xs text-amber-600 dark:text-amber-400 mb-3">
            OS keychain encryption is unavailable on this system — the seed phrase is stored unencrypted in app settings.
          </p>
        )}
        <DidRow label="Owner DID" value={status?.ownerDid} copied={copied} onCopy={handleCopy} />

        {/* Owner alias — a friendly name for you, keyed to the DID. Display
            only: allow/block and trust always use the DID, never the alias. */}
        <div className="mt-3">
          <label htmlFor="owner-alias" className="block text-xs text-neutral-500 dark:text-neutral-400 mb-0.5">Owner alias</label>
          <TextInput
            id="owner-alias"
            type="text"
            value={ownerAlias}
            maxLength={40}
            onChange={(e) => setOwnerAlias(e.target.value)}
            onBlur={() => void window.adfApi?.setSettings?.({ ownerAlias: ownerAlias.trim() })}
            placeholder="a name peers will see"
            className="text-xs"
          />
          <label className="flex items-center gap-2 mt-2 cursor-pointer">
            <input
              type="checkbox"
              checked={shareOwner}
              onChange={(e) => { setShareOwner(e.target.checked); void window.adfApi?.setSettings?.({ shareOwnerIdentity: e.target.checked }) }}
              className="rounded"
            />
            <span className="text-xs text-neutral-600 dark:text-neutral-300">Share owner identity on the mesh</span>
          </label>
          <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-1">
            Off by default. When on, discoverable peers can see your owner alias and cryptographically verify that your
            runtimes share one owner — so several machines you own read as yours, and a shared tailnet shows each
            person’s runtimes under their own name. Publicly links your runtimes together.
          </p>
        </div>
        {status && status.legacyOwnerDids.length > 0 && (
          <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-2">
            Previous owner DID{status.legacyOwnerDids.length > 1 ? 's' : ''} (migrated — files stamped with these are
            restamped to the current DID when found):{' '}
            <span className="font-mono break-all">{status.legacyOwnerDids.join(', ')}</span>
          </p>
        )}
        <div className="flex gap-2 mt-3">
          <Button
            onClick={openBackup}
            disabled={!status?.hasMnemonic}
            variant="primary"
          >
            Back up seed phrase
          </Button>
          <Button
            onClick={() => { setImportOpen(true); setImportResult(null) }}
          >
            Import identity
          </Button>
        </div>
      </SettingsGroup>

      {/* Runtime identity */}
      <SettingsGroup className="p-4">
        <div className="flex items-center justify-between mb-1">
          <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">
            Runtime Identity
          </label>
          {status && (
            status.runtimeDelegationValid ? (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">
                Delegation valid
              </span>
            ) : (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400">
                No valid delegation
              </span>
            )
          )}
        </div>
        <p className="text-xs text-neutral-400 dark:text-neutral-500 mb-3">
          This install. Each Studio has its own runtime keypair — two machines never share a runtime DID, even
          with the same owner. The owner key signs a delegation certificate proving this runtime acts on your behalf.
        </p>
        <div className="space-y-3">
          <DidRow label="Runtime DID" value={status?.runtimeDid} copied={copied} onCopy={handleCopy} />

          {/* Runtime alias — the name this install shows as on the mesh map,
              in place of the hostname mDNS/Tailscale would otherwise share. */}
          <div>
            <label htmlFor="runtime-alias" className="block text-xs text-neutral-500 dark:text-neutral-400 mb-0.5">Runtime alias</label>
            <TextInput
              id="runtime-alias"
              type="text"
              value={runtimeAlias}
              maxLength={40}
              onChange={(e) => setRuntimeAlias(e.target.value)}
              onBlur={() => void window.adfApi?.setSettings?.({ runtimeAlias: runtimeAlias.trim() })}
              placeholder="a name for this runtime"
              className="text-xs"
            />
            <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-1">
              Shown to peers when this runtime is discoverable (Networking → LAN / Tailscale). Falls back to the
              hostname if blank.
            </p>
          </div>
          {status?.runtimeDelegation && (
            <p className="text-[10px] text-neutral-400 dark:text-neutral-500">
              Delegation signed by <span className="font-mono break-all">{status.runtimeDelegation.issuer}</span>{' '}
              on {new Date(status.runtimeDelegation.issued_at).toLocaleDateString()}
            </p>
          )}
          {status && status.legacyRuntimeDids.length > 0 && (
            <p className="text-[10px] text-neutral-400 dark:text-neutral-500">
              Previous runtime DID{status.legacyRuntimeDids.length > 1 ? 's' : ''} (migrated):{' '}
              <span className="font-mono break-all">{status.legacyRuntimeDids.join(', ')}</span>
            </p>
          )}
          <DidRow
            label="Agent directory URL"
            value={directoryUrl}
            hint={meshServer?.running
              ? 'Lists the agent cards served by this runtime, filtered by each requester’s visibility scope. Other runtimes fetch this to discover your agents.'
              : 'Mesh server is not running — start it in Networking to serve agent cards.'}
            copied={copied}
            onCopy={handleCopy}
          />
        </div>
      </SettingsGroup>

      {/* Agent identity pointers */}
      <SettingsGroup className="p-4">
        <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
          Agent Identities
        </label>
        <p className="text-xs text-neutral-400 dark:text-neutral-500">
          Each .adf agent has its own DID and keystore, separate from the identities above. Manage an agent's
          keys and view its ownership attestations in the <span className="font-medium">Agent panel → Identity</span> tab.
          To let mesh peers verify you own an agent, enable <span className="font-medium">Publish owner attestation</span> in
          its <span className="font-medium">Config → Security</span> section — off by default, so agents can't be linked to
          you by card inspection.
        </p>
      </SettingsGroup>

      {/* Seed phrase reveal dialog */}
      <Dialog open={backupOpen} onClose={() => { setBackupOpen(false); setMnemonic(null) }} title="Back Up Seed Phrase">
        <p className="text-sm text-neutral-600 dark:text-neutral-300 mb-3">
          Write these 12 words down and store them somewhere safe. Anyone with this phrase can act as you;
          without it, your owner identity cannot be recovered if this machine is lost.
        </p>
        {mnemonic ? (
          <div className="grid grid-cols-3 gap-1.5 mb-4">
            {mnemonic.split(' ').map((word, i) => (
              <div key={i} className="px-2 py-1.5 text-sm font-mono rounded bg-neutral-100 dark:bg-neutral-700/50 text-neutral-800 dark:text-neutral-200">
                <span className="text-[10px] text-neutral-400 mr-1.5 select-none">{i + 1}</span>{word}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-red-500 mb-4">No seed phrase available.</p>
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
            <Button
              onClick={() => { setBackupOpen(false); setMnemonic(null) }}
            >
              Cancel
            </Button>
            <Button
              onClick={confirmBackup}
              disabled={!mnemonic}
              variant="primary"
            >
              I have written it down
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Import identity dialog */}
      <Dialog open={importOpen} onClose={() => setImportOpen(false)} title="Import Identity">
        <p className="text-sm text-neutral-600 dark:text-neutral-300 mb-3">
          Enter the 12-word seed phrase from another Studio. Your owner DID will change to the imported
          identity, and local agent files you own will be restamped to it.
        </p>
        <Textarea
          aria-label="Seed phrase"
          value={importPhrase}
          onChange={(e) => { setImportPhrase(e.target.value); setImportResult(null) }}
          rows={3}
          placeholder="word1 word2 word3 ..."
          className="mb-2 font-mono text-sm resize-none"
        />
        {importResult && (
          <p className={`text-xs mb-2 ${importResult.ok ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>
            {importResult.message}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button
            onClick={() => setImportOpen(false)}
          >
            Close
          </Button>
          <Button
            onClick={runImport}
            disabled={!importPhrase.trim() || importBusy}
            loading={importBusy}
            variant="primary"
          >
            {importBusy ? 'Importing...' : 'Import'}
          </Button>
        </div>
      </Dialog>
    </>
  )
}

// ---------------------------------------------------------------------------
// Packages Tab — runtime packages + all installed on disk
// ---------------------------------------------------------------------------

function PackagesTab({
  sandboxPackages,
  setSandboxPackages
}: {
  sandboxPackages: Array<{ name: string; version: string }>
  setSandboxPackages: (pkgs: Array<{ name: string; version: string }>) => void
}) {
  const [newPkgName, setNewPkgName] = useState('')
  const [newPkgVersion, setNewPkgVersion] = useState('')
  const [pkgInstalling, setPkgInstalling] = useState<string | null>(null)
  const [pkgError, setPkgError] = useState<string | null>(null)
  const [installedOnDisk, setInstalledOnDisk] = useState<Array<{ name: string; version: string; installedAt: number; size_mb: number; installedBy?: string }>>([])

  // Fetch manifest on mount and after installs
  const refreshManifest = useCallback(() => {
    window.adfApi?.listInstalledSandboxPackages().then((r) => {
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
      const result = await window.adfApi?.installSandboxPackages([
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

  return (
    <>
      {/* Runtime packages — available to all agents */}
      <SettingsGroup className="p-4">
        <div className="flex items-center justify-between mb-1">
          <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">
            Runtime Packages
          </label>
          <span className="text-xs text-neutral-400 dark:text-neutral-500">
            available to all agents
          </span>
        </div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-4">
          Packages installed here are available to every agent on this Studio instance. Pure JS only — no native addons.
        </p>
        {sandboxPackages.length > 0 && (
          <div className="space-y-1 mb-4">
            {sandboxPackages.map((pkg) => (
              <div
                key={pkg.name}
                className="flex items-center justify-between text-xs px-2 py-1.5 rounded bg-neutral-100 dark:bg-neutral-700/50"
              >
                <span className="font-mono text-neutral-700 dark:text-neutral-300">
                  {pkg.name}<span className="text-neutral-400 dark:text-neutral-500">@{pkg.version}</span>
                </span>
                <IconButton
                  onClick={() => setSandboxPackages(sandboxPackages.filter((p) => p.name !== pkg.name))}
                  aria-label={`Remove ${pkg.name}`}
                  variant="danger"
                  title="Remove package"
                >
                  &times;
                </IconButton>
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-2 items-end">
          <div className="flex-1">
            <label className="block text-[10px] text-neutral-400 dark:text-neutral-500 mb-0.5">Package name</label>
            <TextInput
              aria-label="Package name"
              aria-invalid={!!pkgError}
              aria-describedby={pkgError ? 'package-install-error' : undefined}
              type="text"
              value={newPkgName}
              onChange={(e) => { setNewPkgName(e.target.value); setPkgError(null) }}
              placeholder="e.g. vega-lite"
              className="font-mono text-sm"
            />
          </div>
          <div className="w-28">
            <label className="block text-[10px] text-neutral-400 dark:text-neutral-500 mb-0.5">Version</label>
            <TextInput
              aria-label="Package version"
              aria-invalid={!!pkgError}
              aria-describedby={pkgError ? 'package-install-error' : undefined}
              type="text"
              value={newPkgVersion}
              onChange={(e) => { setNewPkgVersion(e.target.value); setPkgError(null) }}
              placeholder="latest"
              className="font-mono text-sm"
            />
          </div>
          <Button
            onClick={handleInstall}
            disabled={!newPkgName.trim() || !!pkgInstalling}
            loading={!!pkgInstalling}
            variant="primary"
            className="whitespace-nowrap"
          >
            {pkgInstalling ? 'Installing...' : 'Install'}
          </Button>
        </div>
        {pkgError && (
          <p id="package-install-error" className="mt-1 text-xs text-[var(--adf-ui-danger)]">{pkgError}</p>
        )}
      </SettingsGroup>

      {/* Agent-installed packages — installed on disk by agents via npm_install */}
      {agentOnlyPackages.length > 0 && (
        <SettingsGroup className="p-4">
          <div className="flex items-center justify-between mb-1">
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">
              Agent-Installed Packages
            </label>
            <span className="text-xs text-neutral-400 dark:text-neutral-500">
              installed by agents via npm_install
            </span>
          </div>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-3">
            These packages were installed by individual agents. They are on disk and visible to any agent that has them in its config.
          </p>
          <div className="space-y-1">
            {agentOnlyPackages.map((pkg) => (
              <div
                key={pkg.name}
                className="flex items-center justify-between text-xs px-2 py-1.5 rounded bg-neutral-100 dark:bg-neutral-700/50"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-mono text-neutral-700 dark:text-neutral-300 truncate">
                    {pkg.name}<span className="text-neutral-400 dark:text-neutral-500">@{pkg.version}</span>
                  </span>
                  {pkg.installedBy && (
                    <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-neutral-200 dark:bg-neutral-600 text-neutral-500 dark:text-neutral-400">
                      {pkg.installedBy}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[10px] text-neutral-400 dark:text-neutral-500">
                    {pkg.size_mb} MB
                  </span>
                  <Button
                    onClick={() => {
                      setSandboxPackages([...sandboxPackages, { name: pkg.name, version: pkg.version }])
                    }}
                    variant="ghost"
                    size="compact"
                    className="whitespace-nowrap text-[10px]"
                    title="Make available to all agents"
                  >
                    Make Runtime
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </SettingsGroup>
      )}
    </>
  )
}

/**
 * Live list of agents declaring LAN-scope visibility. Reused by both the meshLan
 * toggle description and (future) the mDNS advertisement toggle — same predicate
 * drives both: any lan-tier agent flips binding/announcement on.
 */
function LanAgentsList({ agents }: { agents: MeshAgentStatus[] }) {
  const lanAgents = agents.filter((a) => a.visibility === 'lan')
  return (
    <div className="mt-2 ml-5 text-[10px]">
      {lanAgents.length === 0 ? (
        <p className="text-neutral-400 dark:text-neutral-500">
          No agents are set to <code>lan</code> visibility. The runtime will bind to loopback unless this toggle forces LAN binding.
        </p>
      ) : (
        <>
          <p className="text-neutral-500 dark:text-neutral-400 mb-1">
            {lanAgents.length === 1 ? '1 agent is' : `${lanAgents.length} agents are`} exposed on the LAN:
          </p>
          <ul className="space-y-0.5">
            {lanAgents.map((a) => (
              <li key={a.filePath} className="flex items-center gap-2 font-mono text-neutral-600 dark:text-neutral-300">
                {a.icon && <span>{a.icon}</span>}
                <span>{a.handle}</span>
                <span className="text-neutral-400 dark:text-neutral-500 truncate">{a.filePath}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

interface LanFirewallState {
  platform: string
  supported: boolean
  ruleConfigured: boolean | null
  reachable: boolean | null
  lanIp: string | null
  detail: string
  port: number
  serverLanBound: boolean
  verified: boolean
}

/**
 * Gates the "Visible on LAN" claim on an actual precondition check rather than
 * on the toggle alone. LAN discovery has two independent network paths — mDNS
 * multicast (discovery) and a TCP directory fetch (the agent list) — and a
 * firewall commonly lets the first through while blocking the second, so a
 * runtime advertises itself yet peers see "0 agents". This surfaces that gap
 * and offers a one-click, elevation-prompted fix.
 *
 * Rechecks when LAN access turns on and after a mesh restart settles.
 */
function LanReachabilityStatus({ enabled, restarting }: { enabled: boolean; restarting: boolean }) {
  const [fw, setFw] = useState<LanFirewallState | null>(null)
  const [applying, setApplying] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const check = useCallback(async () => {
    if (!window.adfApi?.checkLanFirewall) return
    try {
      const res = await window.adfApi.checkLanFirewall()
      setFw(res as LanFirewallState)
    } catch {
      setFw(null)
    }
  }, [])

  // Recheck when LAN access is on and the server has settled (not mid-restart).
  useEffect(() => {
    if (enabled && !restarting) void check()
  }, [enabled, restarting, check])

  const apply = useCallback(async () => {
    if (!window.adfApi?.applyLanFirewall) return
    setApplying(true)
    setNote(null)
    try {
      const res = await window.adfApi.applyLanFirewall()
      if (res.success) {
        setNote('Firewall rule added.')
        await check()
      } else if (res.declined) {
        setNote('Elevation was declined — the rule was not added.')
      } else {
        setNote(res.error ?? 'Could not add the firewall rule.')
      }
    } finally {
      setApplying(false)
    }
  }, [check])

  if (!enabled) return null

  // First check hasn't resolved yet — a bare "checking" beats flashing a scare.
  if (!fw) {
    return (
      <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-2 ml-5">Checking LAN reachability…</p>
    )
  }

  if (fw.verified) {
    return (
      <div className="mt-2 ml-5 flex items-center gap-2 text-[11px] text-green-600 dark:text-green-400">
        <span>✓ Visible on LAN</span>
        {fw.lanIp && <span className="font-mono text-neutral-400 dark:text-neutral-500">{fw.lanIp}:{fw.port}</span>}
      </div>
    )
  }

  // Not verified — explain the specific gap.
  let message: string
  let showFix = false
  if (!fw.serverLanBound) {
    message = 'Mesh server isn\'t LAN-bound yet — it may still be starting.'
  } else if (fw.supported && fw.ruleConfigured === false) {
    message = 'A firewall rule is needed so peers can fetch this runtime\'s agents. Without it, other machines see the runtime but list 0 agents.'
    showFix = true
  } else if (fw.supported && fw.ruleConfigured === null) {
    message = fw.detail
    showFix = true
  } else if (!fw.supported) {
    message = fw.detail
  } else {
    message = `Firewall rule is present but the server didn't answer on ${fw.lanIp ?? 'the LAN address'} — confirm this network is set to Private, not Public.`
  }

  return (
    <div className="mt-2 ml-5">
      <p className="text-[11px] text-amber-600 dark:text-amber-400">⚠ {message}</p>
      {showFix && (
        <Button
          onClick={() => void apply()}
          disabled={applying}
          loading={applying}
          size="compact"
          className="mt-1 text-[11px] text-[var(--adf-ui-warning)]"
        >
          {applying ? 'Requesting permission…' : 'Enable in firewall'}
        </Button>
      )}
      {note && <p className="mt-1 text-[10px] text-neutral-500 dark:text-neutral-400">{note}</p>}
    </div>
  )
}

interface DiscoveredRuntime {
  runtime_id: string
  runtime_did?: string
  proto: string
  directory_path: string
  host: string
  port: number
  url: string
  first_seen: number
  last_seen: number
  /** undefined = peer announced itself but its directory endpoint is unreachable */
  agent_count?: number
  /** How the peer was found: mDNS broadcast, tailnet sweep, or manual entry */
  source?: 'mdns' | 'tailnet' | 'manual'
}

/**
 * Read-only list of ADF runtimes discovered via mDNS. Updates live via
 * MESH_EVENT. Sits directly below LanAgentsList in the Networking tab — the
 * matched pair is "what you expose" above / "what you can see" below.
 */
function DiscoveredRuntimesList() {
  const [peers, setPeers] = useState<DiscoveredRuntime[]>([])
  const [rechecking, setRechecking] = useState(false)
  const refresh = useCallback(async () => {
    const list = await window.adfApi?.getDiscoveredRuntimes?.()
    if (list) setPeers(list)
  }, [])
  // Manual recheck: force an immediate tailnet/manual re-probe (no staleness
  // gate) and refetch every peer's directory before repainting.
  const recheck = useCallback(async () => {
    setRechecking(true)
    try {
      const list = await window.adfApi?.getDiscoveredRuntimes?.(true)
      if (list) setPeers(list)
    } finally {
      setRechecking(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const unsub = window.adfApi?.onMeshEvent?.((event: { type?: string }) => {
      if (event?.type === 'lan_peer_discovered' || event?.type === 'lan_peer_expired') {
        void refresh()
      }
    })
    return unsub
  }, [refresh])

  return (
    <div className="mt-3">
      <div className="flex items-center gap-2 mb-1">
        <p className="text-xs text-neutral-600 dark:text-neutral-300 font-medium">Discovered runtimes</p>
        <Button
          onClick={() => void recheck()}
          disabled={rechecking}
          loading={rechecking}
          size="compact"
          className="text-[10px]"
          title="Re-probe tailnet and manual peers now, then refetch each runtime's directory"
        >
          {rechecking ? 'rechecking…' : '↻ recheck'}
        </Button>
      </div>
      <div className="ml-5 text-[10px]">
        {peers.length === 0 ? (
          <p className="text-neutral-400 dark:text-neutral-500">
            No other ADF runtimes visible on your network.
          </p>
        ) : (
          <ul className="space-y-0.5">
            {peers.map((p) => (
              <li key={p.runtime_id} className="flex items-center gap-2 font-mono text-neutral-600 dark:text-neutral-300">
                <span>{p.host}</span>
                {/* Every row states its route: LAN = heard via mDNS on the
                    broadcast domain; TAILNET = swept via the tailscale CLI;
                    MANUAL = from the peer list below. */}
                <span
                  className={`px-1 rounded text-[9px] uppercase tracking-wide ${
                    (p.source ?? 'mdns') === 'mdns'
                      ? 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400'
                      : p.source === 'tailnet'
                        ? 'bg-sky-100 dark:bg-sky-900/30 text-sky-600 dark:text-sky-400'
                        : 'bg-violet-100 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400'
                  }`}
                >
                  {(p.source ?? 'mdns') === 'mdns' ? 'lan' : p.source}
                </span>
                {p.url && (
                  <span className="text-neutral-400 dark:text-neutral-500 normal-case">
                    {p.url.replace(/^https?:\/\//, '')}
                  </span>
                )}
                {p.agent_count === undefined ? (
                  <span className="text-amber-500 dark:text-amber-400" title="The runtime announced itself but its directory endpoint didn't answer — firewall, wrong interface, or the mesh server is down">
                    directory unreachable
                  </span>
                ) : (
                  <span className="text-neutral-400 dark:text-neutral-500">
                    {p.agent_count} {p.agent_count === 1 ? 'agent' : 'agents'}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1 text-neutral-400 dark:text-neutral-500">
          Tier changes take effect immediately for inbox enforcement. Agent counts are fetched live from each peer's directory.
        </p>
        <ManualPeersEditor />
      </div>
    </div>
  )
}

/**
 * Discovery beyond the broadcast domain: the Tailscale sweep toggle and the
 * manual peer list. Manual entries accept "host:port" (or a bare host —
 * defaults to the mesh port) and are probed on the same cycle as the tailnet
 * sweep; matches appear in the Discovered list above within seconds.
 */
function ManualPeersEditor() {
  const [peers, setPeers] = useState<string[]>([])
  const [tailnetOn, setTailnetOn] = useState(true)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    void (async () => {
      const s = (await window.adfApi?.getSettings?.()) as unknown as {
        meshManualPeers?: string[]
        tailnetDiscovery?: boolean
      }
      setPeers(s?.meshManualPeers ?? [])
      setTailnetOn(s?.tailnetDiscovery !== false)
    })()
  }, [])

  const save = useCallback(async (next: string[]) => {
    setPeers(next)
    await window.adfApi?.setSettings?.({ meshManualPeers: next })
  }, [])

  const add = useCallback(async () => {
    const v = draft.trim()
    if (!v) return
    setDraft('')
    await save([...peers.filter((p) => p !== v), v])
  }, [draft, peers, save])

  return (
    <div className="mt-3 space-y-2">
      <label className="flex items-center gap-2 text-neutral-600 dark:text-neutral-300">
        <input
          type="checkbox"
          checked={tailnetOn}
          onChange={async (e) => {
            setTailnetOn(e.target.checked)
            await window.adfApi?.setSettings?.({ tailnetDiscovery: e.target.checked })
          }}
        />
        Discover peers over Tailscale
        <span className="text-neutral-400 dark:text-neutral-500">— probes machines on your tailnet for ADF runtimes</span>
      </label>
      <div>
        <p className="text-neutral-500 dark:text-neutral-400 font-medium">Manual peers</p>
        <p className="text-neutral-400 dark:text-neutral-500 mb-1">
          Any runtime reachable by address — LAN, tailnet, or a publicly exposed server. Probed on the same
          cycle as discovery; matches appear in the list above.
        </p>
        {peers.length > 0 && (
          <ul className="space-y-0.5 mb-1">
            {peers.map((p) => (
              <li key={p} className="flex items-center gap-2 font-mono text-neutral-600 dark:text-neutral-300">
                <span>{p}</span>
                <IconButton
                  onClick={() => void save(peers.filter((x) => x !== p))}
                  aria-label={`Remove peer ${p}`}
                  variant="danger"
                  title="Remove peer"
                >
                  ✕
                </IconButton>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center gap-1.5">
          <TextInput
            aria-label="Manual peer address"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void add() }}
            placeholder="host:port (e.g. 100.101.102.103:7295)"
            className="!w-64 !text-[11px]"
          />
          <Button
            onClick={() => void add()}
            size="compact"
          >
            Add peer
          </Button>
        </div>
      </div>
    </div>
  )
}

export function SettingsPage() {
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [defaultProviderId, setDefaultProviderId] = useState<string | undefined>(undefined)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [providerStatus, setProviderStatus] = useState<Record<string, ProviderTestStatus>>({})
  const [systemPrompt, setSystemPrompt] = useState('')
  const [compactionPrompt, setCompactionPrompt] = useState('')
  const [toolPrompts, setToolPrompts] = useState<Record<string, string>>({})
  const [expandedPromptKey, setExpandedPromptKey] = useState<string | null>(null)
  const [mcpServers, setMcpServers] = useState<McpServerRegistration[]>([])
  const [adapterRegistrations, setAdapterRegistrations] = useState<AdapterRegistration[]>([])
  const [modelOptionsCache, setModelOptionsCache] = useState<Record<string, { models: string[]; error?: string; loading?: boolean }>>({})
  const [customModelEntry, setCustomModelEntry] = useState<Record<string, boolean>>({})
  const [activeTab, setActiveTab] = useState<SettingsSection>('general')
  const [settingsSearch, setSettingsSearch] = useState('')
  const [computeHostAccessEnabled, setComputeHostAccessEnabled] = useState(false)
  const [computeHostApproved, setComputeHostApproved] = useState<string[]>([])
  const [computeEnvStatus, setComputeEnvStatus] = useState<{ status: string; activeAgents: string[] }>({ status: 'stopped', activeAgents: [] })
  const [computeContainerPackages, setComputeContainerPackages] = useState('python3, py3-pip, git, curl')
  const [computeMachineCpus, setComputeMachineCpus] = useState(2)
  const [computeMachineMemoryMb, setComputeMachineMemoryMb] = useState(2048)
  const [computeContainerImage, setComputeContainerImage] = useState('docker.io/library/node:20-alpine')
  const [meshServerStatus, setMeshServerStatus] = useState<{ running: boolean; port: number; host: string }>({ running: false, port: 7295, host: '127.0.0.1' })
  const [meshAutoStart, setMeshAutoStart] = useState(true)
  const [meshLan, setMeshLan] = useState(false)
  const [meshPort, setMeshPort] = useState(7295)
  const [meshAgents, setMeshAgents] = useState<MeshAgentStatus[]>([])
  const [lanInfo, setLanInfo] = useState<{ hostname: string; addresses: Array<{ iface: string; address: string; family: 'IPv4' | 'IPv6'; mac: string }> }>({ hostname: '', addresses: [] })
  const [meshRestarting, setMeshRestarting] = useState(false)
  const restartMeshServer = async () => {
    setMeshRestarting(true)
    try {
      const res = await window.adfApi?.restartMeshServer()
      if (res) {
        setMeshServerStatus({ running: res.running ?? false, port: res.port ?? meshPort, host: res.host ?? (meshLan ? '0.0.0.0' : '127.0.0.1') })
      }
    } finally {
      setMeshRestarting(false)
    }
  }
  const meshEnabled = useMeshStore((s) => s.enabled)
  const [newProviderIds, setNewProviderIds] = useState<Set<string>>(new Set())
  const [sandboxPackages, setSandboxPackages] = useState<Array<{ name: string; version: string }>>([])
  const [chatgptAuth, setChatgptAuth] = useState<{ authenticated: boolean; email?: string; expiresAt?: number }>({ authenticated: false })
  const [chatgptAuthLoading, setChatgptAuthLoading] = useState(false)
  const theme = useAppStore((s) => s.theme)
  const setTheme = useAppStore((s) => s.setTheme)
  const setShowSettings = useAppStore((s) => s.setShowSettings)
  const consumePendingSettingsSection = useAppStore((s) => s.consumePendingSettingsSection)
  const hasLoaded = useRef(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout>>()
  const pendingSave = useRef<(() => void) | null>(null)
  const contentScrollRef = useRef<HTMLElement>(null)
  const activeNavItem = SETTINGS_NAV_ITEMS.find((item) => item.id === activeTab) ?? SETTINGS_NAV_ITEMS[0]
  const normalizedSearch = settingsSearch.trim().toLowerCase()
  const visibleNavGroups = normalizedSearch
    ? SETTINGS_NAV_GROUPS.map((group) => ({
        ...group,
        items: group.items.filter((item) =>
          `${item.label} ${item.description} ${item.keywords}`.toLowerCase().includes(normalizedSearch)
        ),
      })).filter((group) => group.items.length > 0)
    : SETTINGS_NAV_GROUPS

  // Honor a pending settings section requested by a home dashboard tile.
  // Runs once on mount; the store action also clears the pending value.
  useEffect(() => {
    const pending = consumePendingSettingsSection()
    if (pending) setActiveTab(pending)
  }, [consumePendingSettingsSection])

  useEffect(() => {
    contentScrollRef.current?.scrollTo({ top: 0 })
  }, [activeTab])

  useEffect(() => {
    window.adfApi?.getSettings().then((settings) => {
      const loadedProviders = (settings.providers as ProviderConfig[]) ?? []
      setProviders(loadedProviders)
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
      setAdapterRegistrations((settings.adapters as AdapterRegistration[]) ?? [])
      setSystemPrompt(
        (settings.globalSystemPrompt as string) ?? DEFAULT_BASE_PROMPT
      )
      setCompactionPrompt(
        (settings.compactionPrompt as string) ?? DEFAULT_COMPACTION_PROMPT
      )
      setToolPrompts(
        (settings.toolPrompts as Record<string, string>) ?? { ...DEFAULT_TOOL_PROMPTS }
      )
      setMeshAutoStart(settings.meshEnabled !== false)
      setMeshLan(!!settings.meshLan)
      setMeshPort((settings.meshPort as number) ?? 7295)
      setSandboxPackages((settings.sandboxPackages as Array<{ name: string; version: string }>) ?? [])
      const compute = settings.compute as {
        hostAccessEnabled?: boolean; hostApproved?: string[];
        containerPackages?: string[]; machineCpus?: number; machineMemoryMb?: number; containerImage?: string;
      } | undefined
      if (compute) {
        setComputeHostAccessEnabled(!!compute.hostAccessEnabled)
        setComputeHostApproved(compute.hostApproved ?? [])
        if (compute.containerPackages) setComputeContainerPackages(compute.containerPackages.join(', '))
        if (compute.machineCpus) setComputeMachineCpus(compute.machineCpus)
        if (compute.machineMemoryMb) setComputeMachineMemoryMb(compute.machineMemoryMb)
        if (compute.containerImage) setComputeContainerImage(compute.containerImage)
      }
      hasLoaded.current = true
    })
  }, [])

  // Fetch mesh server status + agent list for "Networking" tab
  useEffect(() => {
    if (activeTab !== 'networking') return
    window.adfApi?.getMeshServerStatus().then(setMeshServerStatus)
    window.adfApi?.getMeshStatus().then((s) => setMeshAgents(s.agents))
    window.adfApi?.getMeshServerLanIps().then(setLanInfo)
    // Subscribe to mesh events for live updates
    const unsub = window.adfApi?.onMeshEvent(() => {
      window.adfApi?.getMeshServerStatus().then(setMeshServerStatus)
      window.adfApi?.getMeshStatus().then((s) => setMeshAgents(s.agents))
    })
    return unsub
  }, [activeTab, meshEnabled])

  // Auto-save on change (debounced) — flushes immediately on unmount
  useEffect(() => {
    if (!hasLoaded.current) return
    clearTimeout(saveTimer.current)
    const doSave = () => {
      pendingSave.current = null
      window.adfApi?.setSettings({
        providers,
        defaultProviderId,
        mcpServers,
        adapters: adapterRegistrations,
        globalSystemPrompt: systemPrompt,
        compactionPrompt,
        toolPrompts,
        sandboxPackages,
        compute: {
          hostAccessEnabled: computeHostAccessEnabled,
          hostApproved: computeHostApproved,
          containerPackages: computeContainerPackages.split(',').map((s: string) => s.trim()).filter(Boolean),
          machineCpus: computeMachineCpus,
          machineMemoryMb: computeMachineMemoryMb,
          containerImage: computeContainerImage,
        }
      })
      invalidateConfigCaches()
    }
    pendingSave.current = doSave
    saveTimer.current = setTimeout(doSave, 500)
    return () => clearTimeout(saveTimer.current)
  }, [providers, defaultProviderId, mcpServers, adapterRegistrations, systemPrompt, compactionPrompt, toolPrompts, sandboxPackages, computeHostAccessEnabled, computeHostApproved, computeContainerPackages, computeMachineCpus, computeMachineMemoryMb, computeContainerImage])

  // Flush pending save on unmount so changes aren't lost
  useEffect(() => {
    return () => {
      if (pendingSave.current) pendingSave.current()
    }
  }, [])

  const handleThemeChange = async (newTheme: 'light' | 'dark' | 'system') => {
    setTheme(newTheme)
    await window.adfApi?.setSettings({ theme: newTheme })
  }

  const handleResetPrompt = () => {
    setSystemPrompt(DEFAULT_BASE_PROMPT)
  }

  const handleResetCompactionPrompt = () => {
    setCompactionPrompt(DEFAULT_COMPACTION_PROMPT)
  }

  const fetchModelsForProvider = (providerId: string) => {
    if (modelOptionsCache[providerId]?.loading) return
    setModelOptionsCache((prev) => ({ ...prev, [providerId]: { models: [], loading: true } }))
    window.adfApi?.listModels(providerId).then((result) => {
      setModelOptionsCache((prev) => ({
        ...prev,
        [providerId]: { models: [...result.models].sort((a, b) => a.localeCompare(b)), error: result.error }
      }))
    }).catch((err) => {
      setModelOptionsCache((prev) => ({ ...prev, [providerId]: { models: [], error: String(err) } }))
    })
  }

  const refreshChatgptAuth = () => {
    window.adfApi?.chatgptAuthStatus().then(setChatgptAuth).catch(() => {})
  }

  const handleChatgptSignIn = async () => {
    setChatgptAuthLoading(true)
    try {
      const result = await window.adfApi?.chatgptAuthStart()
      if (result && !result.success) {
        console.warn('[ChatGPT Auth]', result.error)
      }
      refreshChatgptAuth()
    } catch (err) {
      console.warn('[ChatGPT Auth]', err)
    } finally {
      setChatgptAuthLoading(false)
    }
  }

  const handleChatgptSignOut = async () => {
    await window.adfApi?.chatgptAuthLogout()
    refreshChatgptAuth()
  }

  // Refresh ChatGPT auth status and auto-fetch models when a chatgpt-subscription provider is expanded
  useEffect(() => {
    if (expandedId && providers.find(p => p.id === expandedId)?.type === 'chatgpt-subscription') {
      refreshChatgptAuth()
      if (!modelOptionsCache[expandedId]?.models?.length) {
        fetchModelsForProvider(expandedId)
      }
    }
  }, [expandedId])

  const addProvider = () => {
    const defaultType = PROVIDER_TYPES[0]
    const newProvider: ProviderConfig = {
      id: generateProviderId(),
      type: defaultType.type,
      name: defaultType.label,
      baseUrl: '',
      apiKey: '',
      defaultModel: '',
      params: []
    }
    const wasEmpty = providers.length === 0
    setProviders([...providers, newProvider])
    setExpandedId(newProvider.id)
    setNewProviderIds((prev) => new Set(prev).add(newProvider.id))
    // Auto-promote: if this is the first provider, make it the default.
    if (wasEmpty) {
      setDefaultProviderId(newProvider.id)
    }
  }

  const changeProviderType = (id: string, type: ProviderType) => {
    const meta = getProviderMeta(type)
    setProviders(providers.map((p) => {
      if (p.id !== id) return p
      return { ...p, type, name: meta.label, baseUrl: '', apiKey: '', defaultModel: '', params: [] }
    }))
  }

  const updateProvider = (id: string, patch: Partial<ProviderConfig>) => {
    setProviders(providers.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  }

  const runProviderTest = async (id: string, force = false) => {
    setProviderStatus((s) => ({ ...s, [id]: 'testing' }))
    try {
      const r = await window.adfApi?.testProvider(id, force)
      setProviderStatus((s) => ({ ...s, [id]: r?.status ?? 'unknown' }))
    } catch {
      setProviderStatus((s) => ({ ...s, [id]: 'failed' }))
    }
  }

  // Lazily fetch a connection status for each provider when the tab is open.
  // Uses the cached (non-force) test so it piggybacks on the home dashboard's
  // session cache; the per-provider "Test" button forces a live re-check.
  useEffect(() => {
    if (activeTab !== 'providers') return
    for (const p of providers) {
      if (providerStatus[p.id] === undefined) void runProviderTest(p.id, false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, providers])

  const removeProvider = (id: string) => {
    const next = providers.filter((p) => p.id !== id)
    setProviders(next)
    if (expandedId === id) setExpandedId(null)
    // Auto-repromote: if the removed provider was the default, fall back to the
    // top of the remaining list (or clear if no providers remain).
    if (defaultProviderId === id) {
      setDefaultProviderId(next.length > 0 ? next[0].id : undefined)
    }
  }

  const addParam = (providerId: string) => {
    setProviders(providers.map((p) => {
      if (p.id !== providerId) return p
      return { ...p, params: [...(p.params ?? []), { key: '', value: '' }] }
    }))
  }

  const updateParam = (providerId: string, paramIndex: number, patch: Partial<{ key: string; value: string }>) => {
    setProviders(providers.map((p) => {
      if (p.id !== providerId) return p
      const params = [...(p.params ?? [])]
      params[paramIndex] = { ...params[paramIndex], ...patch }
      return { ...p, params }
    }))
  }

  const removeParam = (providerId: string, paramIndex: number) => {
    setProviders(providers.map((p) => {
      if (p.id !== providerId) return p
      return { ...p, params: (p.params ?? []).filter((_, j) => j !== paramIndex) }
    }))
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden bg-[var(--adf-ui-canvas)] text-[var(--adf-ui-text)]">
      <aside className="flex w-60 shrink-0 flex-col border-r border-[var(--adf-ui-border)] bg-[var(--adf-ui-sidebar)]">
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
            <div key={group.label} className={groupIndex > 0 ? 'mt-4 pt-3 border-t border-[var(--adf-ui-separator)]' : 'mt-1'}>
              <div className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--adf-ui-text-subtle)]">
                {group.label}
              </div>
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
            <h1 className="text-2xl font-semibold tracking-tight text-[var(--adf-ui-text)]">
              {activeNavItem.label}
            </h1>
            <p className="mt-1 text-sm text-[var(--adf-ui-text-muted)]">
              {activeNavItem.description}
            </p>
          </header>

          <div className="max-w-4xl space-y-5">
          {/* General tab */}
          {activeTab === 'general' && <>
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
          </SettingsGroup>

          {/* Token Usage */}
          <SettingsGroup title="Usage" description="Review token totals recorded by this Studio.">
            <div className="px-4 pb-4"><TokenUsageSection /></div>
          </SettingsGroup>

          <SettingsGroup title="Agent defaults" description="Defaults applied to every agent unless its file provides more specific instructions.">
          <SettingsRow label="Global System Prompt" stacked>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-[var(--adf-ui-text-subtle)]">Applied before per-file instructions.</span>
              <Button
                onClick={handleResetPrompt}
                variant="ghost"
                size="compact"
              >
                Reset to Default
              </Button>
            </div>
            <Textarea
              id="global-system-prompt"
              aria-label="Global System Prompt"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={12}
              className="font-mono text-xs resize-y"
            />
            <p className="mt-1 text-xs text-[var(--adf-ui-text-subtle)]">
              Applied to every .adf agent before its per-file instructions. Explains the
              ADF paradigm to the model.
            </p>
          </SettingsRow>

          {/* Compaction Prompt */}
          <SettingsRow label="Compaction Prompt" stacked separator>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-[var(--adf-ui-text-subtle)]">Used when conversation history is compacted.</span>
              {compactionPrompt !== DEFAULT_COMPACTION_PROMPT && (
                <Button
                  onClick={handleResetCompactionPrompt}
                  variant="ghost"
                  size="compact"
                >
                  Reset to Default
                </Button>
              )}
            </div>
            <Textarea
              id="compaction-prompt"
              aria-label="Compaction Prompt"
              value={compactionPrompt}
              onChange={(e) => setCompactionPrompt(e.target.value)}
              rows={8}
              className="font-mono text-xs resize-y"
            />
            <p className="mt-1 text-xs text-[var(--adf-ui-text-subtle)]">
              System prompt used when compacting conversation history. Controls how the
              loop_compact tool summarizes context.
            </p>
          </SettingsRow>
          </SettingsGroup>

          {/* Tool Instructions */}
          <SettingsGroup title="Tool instructions" description="Conditional prompt sections injected based on enabled tools and features. Shell mode replaces the Tool Best Practices section.">
            <div className="px-4 pb-4">
            <div className="space-y-1">
              {Object.keys(DEFAULT_TOOL_PROMPTS).map((key) => {
                const label = TOOL_PROMPT_LABELS[key] ?? key
                const condition = TOOL_PROMPT_CONDITIONS[key]
                const isExpanded = expandedPromptKey === key
                const currentValue = toolPrompts[key] ?? DEFAULT_TOOL_PROMPTS[key] ?? ''
                const isDefault = currentValue === (DEFAULT_TOOL_PROMPTS[key] ?? '')

                return (
                  <div key={key} className="border border-neutral-200 dark:border-neutral-700 rounded-lg overflow-hidden">
                    <button
                      onClick={() => setExpandedPromptKey(isExpanded ? null : key)}
                      className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-neutral-50 dark:hover:bg-neutral-700/50 transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-neutral-400 dark:text-neutral-500">
                          {isExpanded ? '\u25BC' : '\u25B6'}
                        </span>
                        <span className="text-xs font-medium text-neutral-700 dark:text-neutral-200">
                          {label}
                        </span>
                        {!isDefault && (
                          <span className="text-[9px] px-1 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                            modified
                          </span>
                        )}
                      </div>
                    </button>
                    {isExpanded && (
                      <div className="px-3 pb-3 border-t border-neutral-100 dark:border-neutral-700">
                        {condition && (
                          <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-2 italic">
                            {condition}
                          </p>
                        )}
                        <Textarea
                          aria-label={`${label} tool instruction`}
                          value={currentValue}
                          onChange={(e) => setToolPrompts({ ...toolPrompts, [key]: e.target.value })}
                          rows={10}
                          className="mt-2 font-mono text-xs resize-y"
                        />
                        {!isDefault && (
                          <Button
                            onClick={() => setToolPrompts({ ...toolPrompts, [key]: DEFAULT_TOOL_PROMPTS[key] ?? '' })}
                            variant="ghost"
                            size="compact"
                            className="mt-1"
                          >
                            Reset to Default
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            </div>
          </SettingsGroup>

          <div className="flex justify-center pb-4">
            <Button
              onClick={() => setActiveTab('about')}
              variant="ghost"
            >
              How it works
            </Button>
          </div>
          </>}

          {/* Identity tab */}
          {activeTab === 'identity' && <IdentityTab />}

          {/* About tab */}
          {activeTab === 'about' && <AboutTab />}

          {/* Packages tab */}
          {activeTab === 'packages' && <PackagesTab
            sandboxPackages={sandboxPackages}
            setSandboxPackages={setSandboxPackages}
          />}

          {/* Providers tab */}
          {activeTab === 'providers' && <>
          <SettingsGroup className="p-4">
            <div className="flex items-center justify-between mb-3">
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">
                Providers
              </label>
              <Button
                onClick={addProvider}
                variant="ghost"
                size="compact"
              >
                + Add Provider
              </Button>
            </div>
            <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mb-3">
              ADF files with stored provider configurations will continue to work independently, even if the provider is not listed here.
            </p>
            {providers.length === 0 ? (
              <p className="text-xs text-neutral-400 dark:text-neutral-500">
                No providers configured. Add one to get started.
              </p>
            ) : (
              <div className="space-y-2">
                {providers.map((p) => {
                  const isExpanded = expandedId === p.id
                  const meta = getProviderMeta(p.type)
                  const isDefault = defaultProviderId === p.id

                  return (
                    <div key={p.id} className="border border-neutral-200 dark:border-neutral-700 rounded-lg overflow-hidden">
                      {/* Collapsed header */}
                      <div className="flex items-center hover:bg-[var(--adf-ui-surface-hover)]">
                      <button
                        onClick={() => {
                          if (isExpanded) {
                            setNewProviderIds((prev) => {
                              const next = new Set(prev)
                              next.delete(p.id)
                              return next
                            })
                            setExpandedId(null)
                          } else {
                            setExpandedId(p.id)
                          }
                        }}
                        className="flex min-h-9 min-w-0 flex-1 items-center justify-between px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--adf-ui-focus)]"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-[10px] text-neutral-400 dark:text-neutral-500">
                            {isExpanded ? '\u25BC' : '\u25B6'}
                          </span>
                          <span
                            title={providerStatusLabel(providerStatus[p.id])}
                            className={`w-2 h-2 rounded-full shrink-0 ${providerDotClass(providerStatus[p.id])}`}
                          />
                          <span className="text-sm font-medium text-neutral-700 dark:text-neutral-200 truncate">
                            {p.name || meta.label}
                          </span>
                          {isDefault && (
                            <span
                              title="Applied to new agents"
                              className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 shrink-0"
                            >
                              Default
                            </span>
                          )}
                          {!isExpanded && (
                            <span className="text-[10px] text-neutral-400 dark:text-neutral-500 truncate">
                              {p.baseUrl || meta.label}
                            </span>
                          )}
                        </div>
                      </button>
                      <Button
                        onClick={() => removeProvider(p.id)}
                        variant="danger"
                        size="compact"
                        className="mr-2"
                      >
                        Remove
                      </Button>
                      </div>

                      {/* Expanded content */}
                      {isExpanded && (
                        <div className="px-3 pb-3 space-y-2 border-t border-neutral-100 dark:border-neutral-700">
                          {/* Default-for-new-agents control */}
                          <div className="mt-2 flex items-center justify-between">
                            <span className="text-xs text-neutral-500 dark:text-neutral-400">
                              Default for new agents
                            </span>
                            {isDefault ? (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300">
                                Default
                              </span>
                            ) : (
                              <Button
                                onClick={() => setDefaultProviderId(p.id)}
                                variant="ghost"
                                size="compact"
                              >
                                Make default
                              </Button>
                            )}
                          </div>
                          {/* Connection status + manual re-test */}
                          <div className="flex items-center justify-between">
                            <span className="flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
                              <span className={`w-2 h-2 rounded-full shrink-0 ${providerDotClass(providerStatus[p.id])}`} />
                              {providerStatusLabel(providerStatus[p.id])}
                            </span>
                            <Button
                              onClick={() => runProviderTest(p.id, true)}
                              disabled={providerStatus[p.id] === 'testing'}
                              loading={providerStatus[p.id] === 'testing'}
                              variant="ghost"
                              size="compact"
                            >
                              {providerStatus[p.id] === 'testing' ? 'Testing…' : 'Test'}
                            </Button>
                          </div>
                          <div>
                            <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-0.5">Provider</label>
                            <Select
                              aria-label={`${p.name || meta.label} provider type`}
                              value={p.type}
                              onChange={(e) => changeProviderType(p.id, e.target.value as ProviderType)}
                              disabled={!newProviderIds.has(p.id)}
                              className={`text-sm ${
                                !newProviderIds.has(p.id) ? 'opacity-60 cursor-not-allowed' : ''
                              }`}
                            >
                              {PROVIDER_TYPES.map((pt) => (
                                <option key={pt.type} value={pt.type}>{pt.label}</option>
                              ))}
                            </Select>
                          </div>
                          <div>
                            <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-0.5">Name</label>
                            <TextInput
                              aria-label={`${p.name || meta.label} name`}
                              type="text"
                              value={p.name}
                              onChange={(e) => updateProvider(p.id, { name: e.target.value })}
                              placeholder={meta.label}
                              className="text-sm"
                            />
                          </div>
                          {p.type === 'openai-compatible' && (
                            <div>
                              <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-0.5">Base URL</label>
                              <TextInput
                                aria-label={`${p.name || meta.label} base URL`}
                                type="text"
                                value={p.baseUrl}
                                onChange={(e) => updateProvider(p.id, { baseUrl: e.target.value })}
                                placeholder="http://localhost:1234/v1"
                                className="text-sm"
                              />
                            </div>
                          )}
                          {p.type === 'chatgpt-subscription' ? (
                            <div className="space-y-2 mt-2">
                              <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-0.5">Authentication</label>
                              {chatgptAuth.authenticated ? (
                                <div className="flex items-center justify-between px-2 py-1.5 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-md">
                                  <span className="text-xs text-green-700 dark:text-green-400">
                                    Signed in{chatgptAuth.email ? ` as ${chatgptAuth.email}` : ''}
                                  </span>
                                  <Button
                                    onClick={handleChatgptSignOut}
                                    variant="danger"
                                    size="compact"
                                    className="text-[10px]"
                                  >
                                    Sign Out
                                  </Button>
                                </div>
                              ) : (
                                <Button
                                  onClick={handleChatgptSignIn}
                                  disabled={chatgptAuthLoading}
                                  loading={chatgptAuthLoading}
                                  variant="primary"
                                  className="w-full"
                                >
                                  {chatgptAuthLoading ? 'Signing in...' : 'Sign In with ChatGPT'}
                                </Button>
                              )}
                            </div>
                          ) : (
                            <ProviderCredentialPanel
                              provider={p}
                              onProviderUpdate={(patch) => updateProvider(p.id, patch)}
                              apiKeyPlaceholder={meta.placeholder.apiKey}
                            />
                          )}
                          {(p.credentialStorage ?? 'app') !== 'agent' && <>
                          <div>
                            <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-0.5">Default Model</label>
                            {(() => {
                              const cache = modelOptionsCache[p.id]
                              const isCustom = customModelEntry[p.id] ?? !cache?.models?.length
                              if (cache?.loading) {
                                return <div className="px-2 py-1.5 text-sm text-neutral-400 dark:text-neutral-500">Loading models...</div>
                              }
                              if (isCustom) {
                                return (
                                  <div className="flex gap-1">
                                    <TextInput
                                      aria-label={`${p.name || meta.label} default model`}
                                      type="text"
                                      value={p.defaultModel ?? ''}
                                      onChange={(e) => updateProvider(p.id, { defaultModel: e.target.value })}
                                      placeholder={meta.placeholder.model}
                                      className="flex-1 text-sm"
                                    />
                                    {cache?.models?.length ? (
                                      <Button
                                        variant="ghost"
                                        size="compact"
                                        className="text-[10px] whitespace-nowrap"
                                        onClick={() => setCustomModelEntry((prev) => ({ ...prev, [p.id]: false }))}
                                      >
                                        Pick from list
                                      </Button>
                                    ) : (
                                      <Button
                                        variant="ghost"
                                        size="compact"
                                        className="text-[10px] whitespace-nowrap"
                                        onClick={() => fetchModelsForProvider(p.id)}
                                      >
                                        Fetch models
                                      </Button>
                                    )}
                                  </div>
                                )
                              }
                              return (
                                <Select
                                  aria-label={`${p.name || meta.label} default model`}
                                  value={cache.models.includes(p.defaultModel ?? '') ? p.defaultModel : '__custom__'}
                                  onChange={(e) => {
                                    if (e.target.value === '__custom__') {
                                      setCustomModelEntry((prev) => ({ ...prev, [p.id]: true }))
                                    } else {
                                      updateProvider(p.id, { defaultModel: e.target.value })
                                    }
                                  }}
                                  className="text-sm"
                                >
                                  {cache.models.map((m) => (
                                    <option key={m} value={m}>{m}</option>
                                  ))}
                                  {p.defaultModel && !cache.models.includes(p.defaultModel) && (
                                    <option value={p.defaultModel}>{p.defaultModel} (current)</option>
                                  )}
                                  <option value="__custom__">Custom...</option>
                                </Select>
                              )
                            })()}
                            {modelOptionsCache[p.id]?.error && (
                              <p className="text-[10px] text-red-400 mt-0.5">{modelOptionsCache[p.id].error}</p>
                            )}
                          </div>
                          <div>
                            <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-0.5">Request Delay (ms)</label>
                            <TextInput
                              aria-label={`${p.name || meta.label} request delay in milliseconds`}
                              type="number"
                              min={0}
                              step={100}
                              value={p.requestDelayMs ?? 0}
                              onChange={(e) => updateProvider(p.id, { requestDelayMs: Math.max(0, parseInt(e.target.value) || 0) })}
                              placeholder="0"
                              className="text-sm"
                            />
                            <p className="text-[10px] text-neutral-400 mt-0.5">Delay before each LLM request to avoid rate limits (0 = no delay)</p>
                          </div>
                          {(p.type === 'openai-compatible' || p.type === 'openrouter') && (
                            <div>
                              <div className="flex items-center justify-between mb-1">
                                <label className="block text-xs text-neutral-500 dark:text-neutral-400">Parameters</label>
                                <Button
                                  onClick={() => addParam(p.id)}
                                  variant="ghost"
                                  size="compact"
                                  className="text-[11px]"
                                >
                                  + Add
                                </Button>
                              </div>
                              {(p.params ?? []).length > 0 && (
                                <div className="space-y-1.5">
                                  {(p.params ?? []).map((param, j) => (
                                    <div key={j} className="flex gap-1.5 items-center">
                                      <TextInput
                                        aria-label={`Parameter ${j + 1} key`}
                                        type="text"
                                        value={param.key}
                                        onChange={(e) => updateParam(p.id, j, { key: e.target.value })}
                                        placeholder="key"
                                        className="flex-1 font-mono text-xs"
                                      />
                                      <TextInput
                                        aria-label={`Parameter ${j + 1} value`}
                                        type="text"
                                        value={param.value}
                                        onChange={(e) => updateParam(p.id, j, { value: e.target.value })}
                                        placeholder="blank = null"
                                        className="flex-1 font-mono text-xs"
                                      />
                                      <IconButton
                                        onClick={() => removeParam(p.id, j)}
                                        aria-label={`Remove parameter ${j + 1}`}
                                        variant="danger"
                                      >
                                        &times;
                                      </IconButton>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                          </>}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </SettingsGroup>

          </>}

          {/* MCPs tab */}
          {activeTab === 'mcps' && <>
          <SettingsGroup className="p-4">
            <McpStatusDashboard
              mcpServers={mcpServers}
              onServersChanged={setMcpServers}
            />
          </SettingsGroup>
          </>}

          {/* Channels tab */}
          {activeTab === 'channels' && <>
          <SettingsGroup className="p-4">
            <AdapterStatusDashboard
              adapters={adapterRegistrations}
              onAdaptersChanged={setAdapterRegistrations}
            />
          </SettingsGroup>
          </>}

          {/* Networking tab */}
          {activeTab === 'networking' && <>
          {/* Mesh auto-start */}
          <SettingsGroup title="Mesh startup">
            <SettingsRow
              label="Mesh"
              description={<>
                  The agent network: agents on this runtime discover and message each other, serve their cards and
                  APIs over HTTP, and reach peer runtimes on your LAN, tailnet, or by address. The fleet map,
                  agent-to-agent messaging, and cross-runtime delivery all run on it.
                <span className="mt-1 block text-[var(--adf-ui-text-subtle)]">
                  {meshAutoStart ? 'Enabled automatically on startup.' : 'Currently disabled on startup.'}
                </span>
              </>}
            >
              <Button
                onClick={async () => {
                  const next = !meshAutoStart
                  setMeshAutoStart(next)
                  await window.adfApi?.setSettings({ meshEnabled: next })
                }}
                variant={meshAutoStart ? 'danger' : 'primary'}
              >
                {meshAutoStart ? 'Disable' : 'Enable'}
              </Button>
            </SettingsRow>
          </SettingsGroup>

          {/* Server Status */}
          <SettingsGroup className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <div className={`w-2 h-2 rounded-full ${meshServerStatus.running ? 'bg-green-500' : 'bg-red-400'}`} />
              <label className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                {meshServerStatus.running
                  ? `Server running on ${meshServerStatus.host === '0.0.0.0' ? 'all interfaces' : meshServerStatus.host}, port ${meshServerStatus.port}`
                  : 'Server stopped'}
              </label>
              <Button
                onClick={async () => {
                  const res = meshServerStatus.running
                    ? await window.adfApi?.stopMeshServer()
                    : await window.adfApi?.startMeshServer()
                  if (res) {
                    setMeshServerStatus({ running: res.running ?? false, port: res.port ?? meshServerStatus.port, host: res.host ?? meshServerStatus.host })
                  }
                }}
                variant={meshServerStatus.running ? 'danger' : 'primary'}
                size="compact"
                className="ml-auto"
              >
                {meshServerStatus.running ? 'Stop' : 'Start'}
              </Button>
            </div>
            {meshServerStatus.running && (
              <p className="text-xs text-neutral-400 dark:text-neutral-500 font-mono">
                http://{meshServerStatus.host === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1'}:{meshServerStatus.port}
              </p>
            )}

            {/* The server's default endpoint: which port, and whether it binds
                beyond loopback. The discovery lists below hang off this. */}
            {/* Port */}
            <label className="flex items-center gap-2 mt-3">
              <span className="text-xs text-neutral-600 dark:text-neutral-300">Port</span>
              <TextInput
                aria-label="Mesh server port"
                type="number"
                min={1}
                max={65535}
                value={meshPort}
                disabled={meshRestarting}
                onChange={async (e) => {
                  const port = parseInt(e.target.value, 10)
                  if (!isNaN(port) && port >= 1 && port <= 65535) {
                    setMeshPort(port)
                    await window.adfApi?.setSettings({ meshPort: port })
                  }
                }}
                onBlur={async () => {
                  if (meshServerStatus.running && meshPort !== meshServerStatus.port) {
                    await restartMeshServer()
                  }
                }}
                className="w-20 text-xs"
              />
            </label>
            <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-1 ml-0">
              Server restarts when you leave the field.
            </p>
            {/* LAN Access toggle */}
            <label className="flex items-center gap-2 cursor-pointer mt-3">
              <input
                type="checkbox"
                checked={meshLan}
                disabled={meshRestarting}
                onChange={async (e) => {
                  const lan = e.target.checked
                  setMeshLan(lan)
                  await window.adfApi?.setSettings({ meshLan: lan })
                  if (meshServerStatus.running) await restartMeshServer()
                }}
                className="rounded text-blue-500"
              />
              <span className="text-xs text-neutral-600 dark:text-neutral-300">Allow LAN access</span>
              {meshRestarting && (
                <span className="text-[10px] text-neutral-400 dark:text-neutral-500">restarting…</span>
              )}
            </label>
            <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-1 ml-5">
              Binds to 0.0.0.0 instead of 127.0.0.1. Binding also flips to LAN automatically if any agent has <code>messaging.visibility = "lan"</code>.
            </p>

            {/* LAN addresses — reachable URLs when bound to 0.0.0.0 */}
            {lanInfo.addresses.length > 0 && (
              <div className="mt-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-medium text-neutral-600 dark:text-neutral-300">
                    LAN addresses
                  </span>
                  {lanInfo.hostname && (
                    <span className="text-[10px] text-neutral-400 dark:text-neutral-500 font-mono">
                      {lanInfo.hostname}
                    </span>
                  )}
                </div>
                {!meshLan && (
                  <p className="text-[10px] text-amber-600 dark:text-amber-400 mb-1">
                    Server is bound to 127.0.0.1 — enable "Allow LAN access" below to reach these from other devices.
                  </p>
                )}
                <div className="space-y-1">
                  {lanInfo.addresses.map((addr) => {
                    const display = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address
                    const url = `http://${display}:${meshServerStatus.port}`
                    return (
                      <div key={`${addr.iface}-${addr.address}`} className="flex items-center gap-2">
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-neutral-700 text-neutral-600 dark:text-neutral-300 font-mono truncate max-w-[140px]" title={addr.iface}>
                          {addr.iface}
                        </span>
                        <span className="text-[10px] text-neutral-400 dark:text-neutral-500 uppercase">
                          {addr.family}
                        </span>
                        {meshServerStatus.running && meshLan ? (
                          <a
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-blue-500 hover:text-blue-700 font-mono truncate"
                          >
                            {url}
                          </a>
                        ) : (
                          <span className="text-xs text-neutral-500 dark:text-neutral-400 font-mono truncate">
                            {addr.address}
                          </span>
                        )}
                        <button
                          onClick={() => navigator.clipboard?.writeText(meshServerStatus.running && meshLan ? url : addr.address)}
                          className="text-[10px] text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 ml-auto"
                          title="Copy"
                        >
                          copy
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}


            {/* Verify the runtime is actually reachable (server bound + firewall open). */}
            <LanReachabilityStatus enabled={meshLan} restarting={meshRestarting} />

            {/* Agents currently declaring LAN visibility — live view, reused by mDNS toggle later. */}
            <LanAgentsList agents={meshAgents} />

            {/* Remote runtimes discovered via mDNS. Updates live via MESH_EVENT. */}
            <DiscoveredRuntimesList />

          </SettingsGroup>

          {/* Agent Endpoints */}
          {meshEnabled && (
          <SettingsGroup className="p-4">
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-3">
              Agent Endpoints ({meshAgents.length})
            </label>
            {meshAgents.length === 0 ? (
              <p className="text-xs text-neutral-400 dark:text-neutral-500">
                No agents serving. Start agents in a tracked directory to see them here.
              </p>
            ) : (
              <div className="space-y-2">
                {meshAgents.map((agent) => {
                  const url = meshServerStatus.running
                    ? `http://127.0.0.1:${meshServerStatus.port}/${agent.handle ?? ''}`
                    : null
                  return (
                    <div
                      key={agent.filePath}
                      className="flex items-center justify-between gap-2 p-2 rounded-lg border border-neutral-100 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900/50"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          {agent.icon && <span className="text-sm">{agent.icon}</span>}
                          <span className="text-sm font-medium text-neutral-700 dark:text-neutral-200 truncate">
                            {agent.handle}
                          </span>
                        </div>
                        {url && (
                          <a
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[10px] text-blue-500 hover:text-blue-700 font-mono truncate block"
                          >
                            {url}
                          </a>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {agent.publicEnabled && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                            public
                          </span>
                        )}
                        {(agent.apiRouteCount ?? 0) > 0 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                            {agent.apiRouteCount} route{agent.apiRouteCount !== 1 ? 's' : ''}
                          </span>
                        )}
                        {(agent.sharedCount ?? 0) > 0 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400">
                            {agent.sharedCount} shared
                          </span>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </SettingsGroup>
          )}
          </>}

          {/* Compute tab */}
          {activeTab === 'compute' && <>
          <ComputeTab
            computeEnvStatus={computeEnvStatus}
            setComputeEnvStatus={setComputeEnvStatus}
            computeHostAccessEnabled={computeHostAccessEnabled}
            setComputeHostAccessEnabled={setComputeHostAccessEnabled}
            computeHostApproved={computeHostApproved}
            setComputeHostApproved={setComputeHostApproved}
            containerPackages={computeContainerPackages}
            setContainerPackages={setComputeContainerPackages}
            machineCpus={computeMachineCpus}
            setMachineCpus={setComputeMachineCpus}
            machineMemoryMb={computeMachineMemoryMb}
            setMachineMemoryMb={setComputeMachineMemoryMb}
            containerImage={computeContainerImage}
            setContainerImage={setComputeContainerImage}
          />
          </>}
          </div>
        </div>
      </main>
    </div>
  )
}

interface InstallMethod {
  command: string
  label: string
  autoRunnable: boolean
}

interface Prerequisite {
  id: 'wsl'
  name: string
  installed: boolean
  installCommand?: string
  requiresReboot?: boolean
  description?: string
  docsUrl?: string
}

interface PodmanAvailability {
  available: boolean
  binPath?: string
  version?: string
  machineRequired: boolean
  machineRunning?: boolean
  machineExists?: boolean
  error?: string
  platform: string
  installMethods: InstallMethod[]
  prerequisites: Prerequisite[]
}

/** Compute settings tab — extracted for useEffect on mount. */
function ComputeTab({
  computeEnvStatus, setComputeEnvStatus,
  computeHostAccessEnabled, setComputeHostAccessEnabled,
  computeHostApproved, setComputeHostApproved,
  containerPackages, setContainerPackages,
  machineCpus, setMachineCpus,
  machineMemoryMb, setMachineMemoryMb,
  containerImage, setContainerImage,
}: {
  computeEnvStatus: { status: string; activeAgents: string[] }
  setComputeEnvStatus: (s: { status: string; activeAgents: string[] }) => void
  computeHostAccessEnabled: boolean
  setComputeHostAccessEnabled: (v: boolean) => void
  computeHostApproved: string[]
  setComputeHostApproved: React.Dispatch<React.SetStateAction<string[]>>
  containerPackages: string
  setContainerPackages: (v: string) => void
  machineCpus: number
  setMachineCpus: (v: number) => void
  machineMemoryMb: number
  setMachineMemoryMb: (v: number) => void
  containerImage: string
  setContainerImage: (v: string) => void
}) {
  const [availability, setAvailability] = useState<PodmanAvailability | null>(null)
  const [setupBusy, setSetupBusy] = useState(false)
  const [setupError, setSetupError] = useState<string | null>(null)
  const [setupLog, setSetupLog] = useState<string | null>(null)

  const [containers, setContainers] = useState<Array<{ name: string; status: string; running: boolean }>>([])
  const [selectedContainer, setSelectedContainer] = useState<string | null>(null)

  const refreshAll = useCallback(() => {
    window.adfApi?.computeStatus?.().then((s: { status: string; activeAgents: string[] }) => {
      if (s) setComputeEnvStatus(s)
    })
    window.adfApi?.computeSetup?.({ step: 'check' }).then((r: { success: boolean; availability?: PodmanAvailability }) => {
      if (r?.availability) setAvailability(r.availability)
    })
    window.adfApi?.computeListContainers?.().then((r: { containers: Array<{ name: string; status: string; running: boolean }> }) => {
      if (r?.containers) setContainers(r.containers)
    })
  }, [])

  // Fetch on mount
  useEffect(() => { refreshAll() }, [])

  const runStep = async (step: 'install' | 'machine_init' | 'machine_start', label: string, installCommand?: string) => {
    setSetupBusy(true)
    setSetupError(null)
    setSetupLog(`Running: ${label}...`)
    try {
      const r = await window.adfApi?.computeSetup?.({ step, installCommand })
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
    <div className="space-y-5">
    <SettingsGroup className="p-4">
      <h3 className="text-sm font-semibold text-neutral-800 dark:text-neutral-200 mb-1">Compute Environment</h3>
      <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-4">
        All MCP servers run inside containers for filesystem and process isolation.
        The shared container starts on app launch. Agents can optionally use an isolated container for separation from other agents.
        Installed packages persist across restarts. Use Rebuild to apply configuration changes or start fresh.
        Isolated containers are recreated when their agent restarts.
      </p>

      {/* Container list */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-xs font-semibold text-neutral-700 dark:text-neutral-300">Containers</h4>
          <Button onClick={refreshAll} variant="ghost" size="compact" className="text-[10px]">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M13.25 5.75A5.75 5.75 0 1 0 13 10.9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <path d="M13.25 2.75v3h-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Refresh
          </Button>
        </div>
        <div className="space-y-1.5">
          {containers.length === 0 && (
            <p className="text-[10px] text-neutral-400 dark:text-neutral-500 italic p-2">No containers running.</p>
          )}
          {containers.map((c) => {
            const isShared = c.name === 'adf-mcp'
            return (<React.Fragment key={c.name}>
              <div className="flex flex-wrap items-center gap-2 rounded bg-neutral-100 p-2 dark:bg-neutral-900/50">
                <span className={`w-2 h-2 shrink-0 rounded-full ${c.running ? 'bg-green-500' : 'bg-neutral-400 dark:bg-neutral-500'}`} />
                <Button
                  onClick={() => setSelectedContainer(selectedContainer === c.name ? null : c.name)}
                  variant="ghost"
                  size="compact"
                  className="font-mono text-xs"
                >{c.name}</Button>
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${isShared ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400' : 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400'}`}>
                  {isShared ? 'shared' : 'isolated'}
                </span>
                <span className="text-[10px] text-neutral-500 dark:text-neutral-400">{c.status}</span>
                <div className="ml-auto grid grid-flow-col auto-cols-[3.5rem] gap-1">
                  {c.running ? (
                    <Button
                      onClick={async () => {
                        setSetupBusy(true)
                        try { await window.adfApi?.computeStopContainer?.({ name: c.name }) }
                        finally { setSetupBusy(false); refreshAll() }
                      }}
                      disabled={setupBusy}
                      variant="danger"
                      size="compact"
                      className="h-auto min-h-12 flex-col gap-0.5 px-1 py-1 text-[10px]"
                    >
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <rect x="4" y="4" width="8" height="8" rx="1.25" fill="currentColor" />
                      </svg>
                      Stop
                    </Button>
                  ) : (
                    <Button
                      onClick={async () => {
                        setSetupBusy(true)
                        try { await window.adfApi?.computeStartContainer?.({ name: c.name }) }
                        finally { setSetupBusy(false); refreshAll() }
                      }}
                      disabled={setupBusy}
                      variant="primary"
                      size="compact"
                      className="h-auto min-h-12 flex-col gap-0.5 px-1 py-1 text-[10px]"
                    >
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <path d="m5.25 3.75 7 4.25-7 4.25v-8.5Z" fill="currentColor" />
                      </svg>
                      Start
                    </Button>
                  )}
                  <Button
                    onClick={async () => {
                      setSetupBusy(true)
                      setSetupLog(`Rebuilding ${c.name}...`)
                      try {
                        if (isShared) {
                          await window.adfApi?.computeDestroy?.()
                          await window.adfApi?.computeInit?.()
                        } else {
                          await window.adfApi?.computeDestroyContainer?.({ name: c.name })
                        }
                        setSetupLog(isShared ? 'Container rebuilt' : 'Container removed. Restart the agent to recreate it.')
                      } catch { setSetupError('Rebuild failed') }
                      finally { setSetupBusy(false); refreshAll() }
                    }}
                    disabled={setupBusy}
                    size="compact"
                    className="h-auto min-h-12 flex-col gap-0.5 px-1 py-1 text-[10px] text-[var(--adf-ui-warning)]"
                    title={isShared ? 'Destroy and recreate with current settings' : 'Destroy container. The agent will recreate it on next start.'}
                  >
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M13 6.25A5.25 5.25 0 1 0 12.55 10.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                      <path d="M13 3.5v2.75h-2.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    Rebuild
                  </Button>
                  <Button
                    onClick={async () => {
                      setSetupBusy(true)
                      try { await window.adfApi?.computeDestroyContainer?.({ name: c.name }) }
                      finally { setSetupBusy(false); refreshAll() }
                    }}
                    disabled={setupBusy || isShared || c.running}
                    variant="danger"
                    size="compact"
                    className="h-auto min-h-12 flex-col gap-0.5 px-1 py-1 text-[10px]"
                    title={isShared
                      ? 'The shared container is retained; use Rebuild to recreate it.'
                      : c.running
                        ? 'Stop this container before removing it.'
                        : 'Remove this isolated container permanently'}
                  >
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M3.5 4.5h9M6 4.5V3.25h4V4.5M5 6.25v6.5h6v-6.5" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    Remove
                  </Button>
                </div>
              </div>
            </React.Fragment>)
          })}
        </div>
      </div>

      {/* Status messages — for post-setup container operations (Rebuild etc).
          During setup, the wizard shows its own status block, so avoid duplication. */}
      {ready && setupLog && (
        <p className="mb-3 text-[10px] text-amber-600 dark:text-amber-400 font-mono">{setupLog}</p>
      )}
      {ready && setupError && (
        <p className="mb-3 text-[10px] text-red-600 dark:text-red-400 font-mono">{setupError}</p>
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
        <p className="mb-3 text-[10px] text-green-700 dark:text-green-400">
          Podman v{availability?.version} ready
        </p>
      )}

    </SettingsGroup>

      {/* Container configuration */}
    <SettingsGroup className="p-4">
      <div>
        <h4 className="text-xs font-semibold text-neutral-700 dark:text-neutral-300 mb-2">Container Configuration</h4>
        <p className="text-[10px] text-neutral-500 dark:text-neutral-400 mb-3">
          Applies to new containers and rebuilds. Uses apt-get for Debian-based images, apk for Alpine.
        </p>

        <div className="space-y-3">
          {/* Base image */}
          <div>
            <label className="text-[10px] text-neutral-600 dark:text-neutral-400 block mb-1">Base image</label>
            <TextInput
              aria-label="Container base image"
              type="text"
              value={containerImage}
              onChange={(e) => setContainerImage(e.target.value)}
              className="font-mono text-xs"
              placeholder="docker.io/library/node:20-alpine"
            />
          </div>

          {/* Packages */}
          <div>
            <label className="text-[10px] text-neutral-600 dark:text-neutral-400 block mb-1">System packages (comma-separated)</label>
            <TextInput
              aria-label="Container system packages"
              type="text"
              value={containerPackages}
              onChange={(e) => setContainerPackages(e.target.value)}
              className="font-mono text-xs"
              placeholder="python3, py3-pip, git, curl"
            />
          </div>

          {/* Machine resources (macOS/Windows only) */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] text-neutral-600 dark:text-neutral-400 block mb-1">VM CPUs</label>
              <TextInput
                aria-label="Virtual machine CPUs"
                type="number"
                min={1}
                max={16}
                value={machineCpus}
                onChange={(e) => setMachineCpus(Math.max(1, parseInt(e.target.value) || 2))}
                className="text-xs"
              />
            </div>
            <div>
              <label className="text-[10px] text-neutral-600 dark:text-neutral-400 block mb-1">VM Memory (MB)</label>
              <TextInput
                aria-label="Virtual machine memory in megabytes"
                type="number"
                min={512}
                max={32768}
                step={256}
                value={machineMemoryMb}
                onChange={(e) => setMachineMemoryMb(Math.max(512, parseInt(e.target.value) || 2048))}
                className="text-xs"
              />
            </div>
          </div>
          <p className="text-[10px] text-neutral-400 dark:text-neutral-500">
            VM resources apply to macOS/Windows (Podman machine). On Linux, containers use host resources directly.
          </p>

        </div>
      </div>

    </SettingsGroup>

      {/* Host access toggle */}
    <SettingsGroup className="p-4">
      <div>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={computeHostAccessEnabled}
            onChange={(e) => setComputeHostAccessEnabled(e.target.checked)}
            className="rounded text-blue-500"
          />
          <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">Enable host access</span>
        </label>
        <p className="text-[10px] text-neutral-500 dark:text-neutral-400 mt-1 ml-5">
          When enabled, MCP servers that request host access can be individually approved below.
        </p>
      </div>

      {/* Approved servers list */}
      {computeHostAccessEnabled && (
        <div className="mt-3 border-t border-neutral-200 dark:border-neutral-700 pt-3">
          <h4 className="text-xs font-medium text-neutral-600 dark:text-neutral-400 mb-2">Approved Host Servers</h4>
          {computeHostApproved.length === 0 ? (
            <p className="text-[10px] text-neutral-500 dark:text-neutral-400 italic">
              No servers approved for host access. Servers requesting host access will appear here when agents use them.
            </p>
          ) : (
            <div className="space-y-1">
              {computeHostApproved.map((name) => (
                <div key={name} className="flex items-center justify-between py-1 px-2 rounded bg-neutral-100 dark:bg-neutral-900/50">
                  <span className="text-xs text-neutral-700 dark:text-neutral-300 font-mono">{name}</span>
                  <Button
                    onClick={() => setComputeHostApproved((prev) => prev.filter((n) => n !== name))}
                    variant="danger"
                    size="compact"
                    className="text-[10px]"
                  >
                    Revoke
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

    </SettingsGroup>

      {/* Container detail modal */}
      {selectedContainer && (() => {
        const c = containers.find((x) => x.name === selectedContainer)
        if (!c) return null
        return <ContainerDetailPanel name={c.name} running={c.running} onClose={() => setSelectedContainer(null)} />
      })()}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Setup wizard — detect-and-guide for the compute environment.
// ────────────────────────────────────────────────────────────────────────────

type StepStatus = 'done' | 'pending' | 'blocked' | 'in_progress' | 'failed'

function StatusBadge({ status, index }: { status: StepStatus; index: number }) {
  const base = 'w-4 h-4 shrink-0 rounded-full text-[10px] flex items-center justify-center font-bold'
  if (status === 'done') return <span className={`${base} bg-green-500 text-white`}>{'\u2713'}</span>
  if (status === 'failed') return <span className={`${base} bg-red-500 text-white`}>{'\u00d7'}</span>
  if (status === 'in_progress')
    return <span className={`${base} bg-blue-500 text-white animate-pulse`}>{index}</span>
  if (status === 'blocked')
    return <span className={`${base} bg-neutral-200 dark:bg-neutral-700 text-neutral-400 dark:text-neutral-500`}>{index}</span>
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
        <h4 className="text-xs font-semibold text-amber-800 dark:text-amber-300">Setup Required</h4>
        <Button
          onClick={onRefresh}
          variant="ghost"
          size="compact"
          className="text-[10px] text-[var(--adf-ui-warning)]"
          disabled={setupBusy}
          title="Re-check the environment (use after installing WSL + reboot, etc.)"
        >
          Re-check
        </Button>
      </div>
      <p className="text-[10px] text-amber-700 dark:text-amber-400 mb-3">
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
        <p className="mt-2 text-[10px] text-amber-600 dark:text-amber-400 font-mono">{setupLog}</p>
      )}
      {setupError && (
        <div className="mt-2 p-2 rounded bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
          <p className="text-[10px] text-red-700 dark:text-red-400 font-mono break-words">{setupError}</p>
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
            <code className="text-[10px] text-amber-700 dark:text-amber-300 bg-amber-100 dark:bg-amber-900/40 px-1.5 py-0.5 rounded font-mono">
              {prereq.installCommand}
            </code>
            <Button
              onClick={() => onCopy(prereq.installCommand!)}
              size="compact"
              className="text-[10px]"
            >
              Copy
            </Button>
          </div>
        )}
      </div>
      {status !== 'done' && (
        <div className="ml-6 text-[10px] text-amber-700 dark:text-amber-400 space-y-0.5">
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
            <span className="text-neutral-400 dark:text-neutral-500 ml-1">v{availability.version}</span>
          )}
        </span>
        {needsInstall && status === 'pending' && autoMethod && (
          <Button
            onClick={() => onInstall(autoMethod.command)}
            disabled={setupBusy}
            loading={setupBusy}
            variant="primary"
            size="compact"
            className="text-[10px]"
          >
            {setupBusy ? 'Installing...' : autoMethod.label}
          </Button>
        )}
      </div>
      {status === 'pending' && !autoMethod && manualMethods.length > 0 && (
        <div className="ml-6 space-y-1">
          {manualMethods.map((m) => (
            <div key={m.command} className="flex items-center gap-1">
              <code className="text-[10px] text-amber-700 dark:text-amber-300 bg-amber-100 dark:bg-amber-900/40 px-1.5 py-0.5 rounded font-mono">
                {m.command}
              </code>
              <Button
                onClick={() => onCopy(m.command)}
                size="compact"
                className="text-[10px]"
              >
                Copy
              </Button>
            </div>
          ))}
        </div>
      )}
      {status === 'blocked' && (
        <p className="ml-6 text-[10px] text-neutral-500 dark:text-neutral-400">
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
          className="text-[10px]"
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
          className="text-[10px]"
        >
          {setupBusy ? 'Starting...' : 'Start'}
        </Button>
      )}
    </div>
  )
}

/** Full-screen modal for container inspection — terminal-style. */
function ContainerDetailPanel({ name, running, onClose }: { name: string; running: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<'processes' | 'exec' | 'packages' | 'workspace' | 'info'>('processes')
  const [detail, setDetail] = useState<{ processes: string; packages: string; workspace: string; info: string } | null>(null)
  const [execLog, setExecLog] = useState<Array<{ timestamp: number; command: string; exitCode: number; stdout: string; stderr: string; durationMs: number }>>([])
  const [autoRefresh, setAutoRefresh] = useState(true)

  const refresh = useCallback(() => {
    Promise.all([
      window.adfApi?.computeContainerDetail?.({ name }),
      window.adfApi?.computeExecLog?.({ name }),
    ]).then(([d, l]: [any, any]) => {
      if (d?.success) setDetail(d)
      if (l?.entries) setExecLog(l.entries)
    })
  }, [name])

  // Initial load
  useEffect(() => { refresh() }, [name])

  // Auto-refresh
  useEffect(() => {
    if (!autoRefresh) return
    const interval = setInterval(refresh, tab === 'processes' ? 3000 : 5000)
    return () => clearInterval(interval)
  }, [autoRefresh, tab, refresh])

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const tabs = [
    { id: 'processes' as const, label: 'Processes' },
    { id: 'exec' as const, label: `Exec Log (${execLog.length})` },
    { id: 'packages' as const, label: 'Packages' },
    { id: 'workspace' as const, label: 'Workspace' },
    { id: 'info' as const, label: 'Info' },
  ]

  const termClass = 'text-[11px] text-green-400 font-mono whitespace-pre-wrap p-3 min-h-[200px]'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-[90vw] max-w-4xl h-[80vh] flex flex-col rounded-lg overflow-hidden shadow-2xl border border-neutral-700"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Title bar */}
        <div className="flex items-center gap-3 px-4 py-2 bg-neutral-900 border-b border-neutral-700 shrink-0">
          <div className="flex items-center gap-1.5">
            <button onClick={onClose} className="w-3 h-3 rounded-full bg-red-500 hover:bg-red-400" title="Close" />
            <span className="w-3 h-3 rounded-full bg-yellow-500" />
            <span className={`w-3 h-3 rounded-full ${running ? 'bg-green-500' : 'bg-neutral-600'}`} />
          </div>
          <span className="text-xs text-neutral-300 font-mono flex-1">{name}</span>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="rounded text-green-500 w-3 h-3"
            />
            <span className="text-[10px] text-neutral-400">Auto-refresh</span>
          </label>
          <button
            onClick={refresh}
            className="text-[10px] text-green-400 hover:text-green-300 font-mono"
          >refresh</button>
        </div>

        {/* Tab bar */}
        <div className="flex items-center gap-1 px-3 py-1.5 bg-neutral-900 border-b border-neutral-800 shrink-0">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-2.5 py-1 text-[10px] rounded font-mono ${
                tab === t.id
                  ? 'bg-neutral-700 text-green-400'
                  : 'text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800'
              }`}
            >{t.label}</button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto bg-black">
          {!running && !detail && (
            <p className="text-[11px] text-neutral-500 italic p-3 font-mono">Container is not running.</p>
          )}

          {tab === 'processes' && (
            <pre className={termClass}>{detail?.processes || 'Loading...'}</pre>
          )}

          {tab === 'exec' && (
            execLog.length === 0 ? (
              <p className="text-[11px] text-neutral-500 italic p-3 font-mono">No exec commands recorded this session.</p>
            ) : (
              <div className="p-2 space-y-1">
                {[...execLog].reverse().map((e, i) => (
                  <div key={i} className="p-2 rounded bg-neutral-900/80 border border-neutral-800">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`w-1.5 h-1.5 rounded-full ${e.exitCode === 0 ? 'bg-green-500' : 'bg-red-500'}`} />
                      <span className="text-[10px] text-neutral-500 font-mono">
                        {new Date(e.timestamp).toLocaleTimeString()}
                      </span>
                      <span className="text-[10px] text-neutral-600 font-mono">{e.durationMs}ms</span>
                      {e.exitCode !== 0 && <span className="text-[10px] text-red-400 font-mono">exit {e.exitCode}</span>}
                    </div>
                    <pre className="text-[11px] text-cyan-400 font-mono whitespace-pre-wrap break-all">$ {e.command}</pre>
                    {e.stdout && (
                      <pre className="text-[11px] text-green-400/80 font-mono whitespace-pre-wrap mt-1 pl-2 border-l border-neutral-700">{e.stdout}</pre>
                    )}
                    {e.stderr && (
                      <pre className="text-[11px] text-red-400/80 font-mono whitespace-pre-wrap mt-1 pl-2 border-l border-red-900">{e.stderr}</pre>
                    )}
                  </div>
                ))}
              </div>
            )
          )}

          {tab === 'packages' && (
            <pre className={termClass}>{detail?.packages || 'Loading...'}</pre>
          )}

          {tab === 'workspace' && (
            <pre className={termClass}>{detail?.workspace || 'Loading...'}</pre>
          )}

          {tab === 'info' && (
            <pre className={termClass}>{detail?.info || 'Loading...'}</pre>
          )}
        </div>
      </div>
    </div>
  )
}
