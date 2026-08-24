import { useEffect, useMemo, useRef, useState } from 'react'
import type { McpServerRegistration } from '../../../shared/types/ipc.types'
import type { McpToolInfo } from '../../../shared/types/adf-v02.types'
import { MCP_REGISTRY, REGISTRY_ARG_PLACEHOLDER_RE, findRegistryEntry, findRegistryEntryByPypiPackage, findRegistryEntryByUrl, hasUnresolvedPlaceholderArgs, registrationFromRegistryEntry } from '../../../shared/constants/mcp-registry'
import type { McpRegistryEntry } from '../../../shared/constants/mcp-registry'
import { isSensitiveMcpHeader, isRegistrationAgentVisible, suggestedAgentVisible } from '../../../shared/utils/mcp-config'
import { Dialog } from '../common/Dialog'
import { Tooltip } from '../common/Tooltip'
import { McpCredentialPanel } from './McpCredentialPanel'
import { BrandIcon } from './BrandIcon'

/** One-line boundary statement shown on host-located servers. */
export const HOST_BOUNDARY_TEXT = 'Runs on the host with your user account’s access — your agents drive it.'
const CONTAINER_TEXT = 'Isolate in container — requires Podman (one-time setup).'

interface FilePayload {
  fileName: string
  size: number
  contentB64: string
}

interface TestState {
  phase: 'idle' | 'running' | 'done'
  success?: boolean
  tools?: McpToolInfo[]
  error?: string
  stderrTail?: string[]
  notes?: string[]
  authRan?: boolean
  location?: string
}

interface McpAddServerModalProps {
  open: boolean
  onClose: () => void
  /** Registration being edited; null = add flow (choose screen first). */
  editing: McpServerRegistration | null
  existingServers: McpServerRegistration[]
  hostAccessEnabled?: boolean
  onEnableHostAccess?: () => void
  onSave: (reg: McpServerRegistration) => void
}

function newId(): string {
  return 'mcp:' + Math.random().toString(36).slice(2, 8)
}

/** All registry categories in display order — mirrors the McpRegistryEntry union. */
const REGISTRY_CATEGORIES: McpRegistryEntry['category'][] = ['tools', 'data', 'dev', 'communication', 'web', 'search', 'productivity', 'infra', 'ai']

/**
 * Filter + order the quick-add cards: case-insensitive substring match on
 * name/displayName/description, optional category filter, verified entries
 * first — registry order preserved within each group (stable).
 */
export function filterRegistryEntries(
  entries: McpRegistryEntry[],
  query: string,
  category: McpRegistryEntry['category'] | 'all',
): McpRegistryEntry[] {
  const q = query.trim().toLowerCase()
  const matches = entries.filter((e) =>
    (category === 'all' || e.category === category) &&
    (!q || e.name.toLowerCase().includes(q) || e.displayName.toLowerCase().includes(q) || e.description.toLowerCase().includes(q))
  )
  return [...matches.filter((e) => e.verified), ...matches.filter((e) => !e.verified)]
}

/**
 * Env keys a quick-add card surfaces as "Requires: …" — requiredEnvKeys plus,
 * for HTTP entries, the bearer/header env names, deduped.
 */
function cardRequiredKeys(entry: McpRegistryEntry): string[] {
  return [...new Set([
    ...entry.requiredEnvKeys,
    ...(entry.bearerTokenEnvVar ? [entry.bearerTokenEnvVar] : []),
    ...(entry.headerEnv ?? []).map((h) => h.env),
  ])]
}

function blankDraft(type: 'custom' | 'http'): McpServerRegistration {
  return type === 'http'
    ? { id: newId(), name: '', type: 'http', url: '', headers: [], headerEnv: [], env: [] }
    : { id: newId(), name: '', type: 'custom', command: '', args: [], env: [], runLocation: 'host' }
}

const inputCls = 'w-full px-2 py-1.5 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400'
// Amber-bordered variant flagging arg inputs that still carry an unresolved {placeholder}.
const inputAmberCls = inputCls.replace('border-neutral-300 dark:border-neutral-600', 'border-amber-400 dark:border-amber-500')
const labelCls = 'block text-xs text-neutral-500 dark:text-neutral-400 mb-0.5'

export function McpAddServerModal({ open, onClose, editing, existingServers, hostAccessEnabled, onEnableHostAccess, onSave }: McpAddServerModalProps) {
  const [mode, setMode] = useState<'choose' | 'form'>('choose')
  const [draft, setDraft] = useState<McpServerRegistration | null>(null)
  const [filePayloads, setFilePayloads] = useState<Record<string, FilePayload>>({})
  const [test, setTest] = useState<TestState>({ phase: 'idle' })
  const [showTools, setShowTools] = useState(false)
  // Auth-args field keeps raw text so typing a space isn't stripped by a
  // split/join round-trip on every keystroke; parsed into an array on commit.
  const [authArgsText, setAuthArgsText] = useState('')
  const [chooseQuery, setChooseQuery] = useState('')
  const [chooseCategory, setChooseCategory] = useState<McpRegistryEntry['category'] | 'all'>('all')
  const fileInputsRef = useRef<Record<string, HTMLInputElement | null>>({})

  // Reset per open/editing TARGET (by name), not on every `editing` object
  // identity change — the dashboard replaces the row object on external
  // updates (a Reconnect stamping lastVerifiedAt, a managed-install version
  // patch), and resetting then would silently discard in-progress edits.
  const editingKey = editing ? editing.name : null
  useEffect(() => {
    if (!open) return
    setFilePayloads({})
    setTest({ phase: 'idle' })
    setShowTools(false)
    if (editing) {
      setDraft({ ...editing })
      setAuthArgsText((editing.authArgs ?? []).join(' '))
      setMode('form')
    } else {
      setDraft(null)
      setAuthArgsText('')
      setChooseQuery('')
      setChooseCategory('all')
      setMode('choose')
    }
    // Intentionally keyed on `editingKey` (the target's identity), not the
    // `editing` object — see comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editingKey])

  // Editing any executable-identity field invalidates a prior "verified"
  // result — a stamp must never vouch for a config the user changed after.
  const IDENTITY_FIELDS: (keyof McpServerRegistration)[] = ['type', 'url', 'command', 'args', 'npmPackage', 'pypiPackage']
  const patch = (p: Partial<McpServerRegistration>) => {
    const touchesIdentity = IDENTITY_FIELDS.some((k) => k in p)
    setDraft((d) => (d ? { ...d, ...p, ...(touchesIdentity ? { lastVerifiedAt: undefined } : {}) } : d))
    if (touchesIdentity) setTest((t) => (t.phase === 'done' ? { phase: 'idle' } : t))
  }

  /** Commit the raw auth-args text into the draft as a parsed array. */
  const commitAuthArgs = (): string[] => {
    const arr = authArgsText.split(/\s+/).filter(Boolean)
    setDraft((d) => (d ? { ...d, authArgs: arr } : d))
    return arr
  }

  const registryEntry = useMemo(() => {
    if (!draft) return undefined
    return draft.npmPackage ? findRegistryEntry(draft.npmPackage)
      : draft.pypiPackage ? findRegistryEntryByPypiPackage(draft.pypiPackage)
      : draft.url ? findRegistryEntryByUrl(draft.url) : undefined
  }, [draft])

  const availableEntries = MCP_REGISTRY.filter(
    (entry) => !existingServers.some((s) =>
      (entry.npmPackage && s.npmPackage === entry.npmPackage) ||
      (entry.pypiPackage && s.pypiPackage === entry.pypiPackage) ||
      (entry.url && s.url === entry.url)
    )
  )
  const availableCategories = REGISTRY_CATEGORIES.filter((c) => availableEntries.some((e) => e.category === c))
  const visibleEntries = filterRegistryEntries(availableEntries, chooseQuery, chooseCategory)

  const isHttp = draft ? (draft.type === 'http' || !!draft.url) : false
  const isCustom = draft?.type === 'custom'
  const isPython = draft?.type === 'uvx' || draft?.type === 'pip'
  const canLaunch = !!draft && !!draft.name && (
    isHttp ? !!draft.url : isCustom ? !!draft.command : isPython ? !!draft.pypiPackage : !!draft.npmPackage
  )

  // Unresolved {placeholder} tokens in args gate Connect/Save until the user
  // substitutes real values (registry args ship placeholders verbatim).
  const unresolvedPlaceholders = useMemo(() => {
    if (!draft || !hasUnresolvedPlaceholderArgs(draft.args)) return []
    // The exported regex has no `g` flag (safe for .test()); add it to enumerate.
    const re = new RegExp(REGISTRY_ARG_PLACEHOLDER_RE, 'g')
    return [...new Set((draft.args ?? []).flatMap((arg) => arg.match(re) ?? []))]
  }, [draft])
  const hasPlaceholders = unresolvedPlaceholders.length > 0

  const handleFilePick = (path: string, file: File | undefined) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      const contentB64 = result.slice(result.indexOf(',') + 1)
      setFilePayloads((prev) => ({ ...prev, [path]: { fileName: file.name, size: file.size, contentB64 } }))
    }
    reader.readAsDataURL(file)
  }

  const handleConnect = async () => {
    if (!draft || !canLaunch || hasPlaceholders) return
    setTest({ phase: 'running' })
    setShowTools(false)
    try {
      const credentialFiles = Object.entries(filePayloads).map(([path, p]) => ({ path, contentB64: p.contentB64 }))
      const result = await window.adfApi?.testMcpRegistration({
        registration: { ...draft, authArgs: commitAuthArgs() },
        credentialFiles: credentialFiles.length ? credentialFiles : undefined,
      })
      if (result?.success) {
        patch({ lastVerifiedAt: Date.now() })
        setTest({ phase: 'done', success: true, tools: result.tools, notes: result.notes, authRan: result.authRan, location: result.location })
      } else {
        setTest({ phase: 'done', success: false, error: result?.error ?? 'Failed to connect', stderrTail: result?.stderrTail, notes: result?.notes, location: result?.location })
      }
    } catch (err) {
      setTest({ phase: 'done', success: false, error: String(err) })
    }
  }

  const handleSave = () => {
    if (!draft || hasPlaceholders) return
    onSave({ ...draft, authArgs: commitAuthArgs() })
    onClose()
  }

  return (
    <Dialog open={open} onClose={onClose} title={editing ? `Configure — ${editing.name}` : mode === 'choose' ? 'Add MCP Server' : 'Add MCP Server'} wide>
      {mode === 'choose' && (
        <div className="space-y-3">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            Pick a known server, or configure your own.
          </p>
          <input
            type="text"
            autoFocus
            value={chooseQuery}
            onChange={(e) => setChooseQuery(e.target.value)}
            placeholder="Search servers…"
            className="w-full px-2 py-1.5 text-xs border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
          />
          <div className="flex flex-wrap gap-1">
            {(['all', ...availableCategories] as (McpRegistryEntry['category'] | 'all')[]).map((c) => (
              <button
                key={c}
                onClick={() => setChooseCategory(c)}
                className={`px-2 py-0.5 text-[10px] rounded-full border transition-colors ${chooseCategory === c
                  ? 'border-blue-400 dark:border-blue-500 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 font-medium'
                  : 'border-neutral-200 dark:border-neutral-700 text-neutral-500 dark:text-neutral-400 hover:border-neutral-400 dark:hover:border-neutral-500'}`}
              >
                {c === 'all' ? 'All' : c.charAt(0).toUpperCase() + c.slice(1)}
              </button>
            ))}
          </div>
          <div className="max-h-[55vh] overflow-y-auto pr-1">
            <div className="grid grid-cols-2 gap-2">
              {visibleEntries.map((entry) => {
                const requiredKeys = cardRequiredKeys(entry)
                return (
                  <button
                    key={entry.name}
                    onClick={() => { const d = registrationFromRegistryEntry(entry, newId()); setDraft(d); setAuthArgsText((d.authArgs ?? []).join(' ')); setMode('form') }}
                    className="text-left p-2.5 rounded-md border border-neutral-200 dark:border-neutral-700 hover:border-blue-400 dark:hover:border-blue-500 transition-colors"
                  >
                    <div className="flex items-center gap-1.5">
                      <BrandIcon iconKey={entry.iconKey} category={entry.category} size={26} />
                      <span className="text-xs font-medium text-neutral-700 dark:text-neutral-200">{entry.displayName}</span>
                      {entry.runtime === 'python' && (
                        <span className="text-[9px] px-1 py-0.5 bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-400 rounded font-medium">Python</span>
                      )}
                      {entry.url && (
                        <span className="text-[9px] px-1 py-0.5 bg-teal-100 dark:bg-teal-900/40 text-teal-600 dark:text-teal-400 rounded font-medium">Remote</span>
                      )}
                      {entry.verified && (
                        <span className="text-[9px] px-1 py-0.5 bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 rounded font-medium">Official</span>
                      )}
                      {entry.auth && (
                        <span className="text-[9px] px-1 py-0.5 bg-purple-100 dark:bg-purple-900/40 text-purple-600 dark:text-purple-400 rounded font-medium">OAuth</span>
                      )}
                    </div>
                    <p className="text-[10px] text-neutral-500 dark:text-neutral-400 mt-0.5 line-clamp-2">{entry.description}</p>
                    {entry.prerequisite && (
                      <p className="text-[9px] text-amber-600 dark:text-amber-400 mt-0.5 line-clamp-2">{entry.prerequisite}</p>
                    )}
                    {!entry.prerequisite && requiredKeys.length > 0 && (
                      <p className="text-[9px] text-amber-600 dark:text-amber-400 mt-0.5">Requires: {requiredKeys.join(', ')}</p>
                    )}
                  </button>
                )
              })}
            </div>
            {visibleEntries.length === 0 && (
              <p className="text-[10px] text-neutral-400 dark:text-neutral-500 py-4 text-center">No servers match — try a different search, or add a custom one below.</p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => { setDraft(blankDraft('custom')); setAuthArgsText(''); setMode('form') }}
              className="text-left p-2.5 rounded-md border border-dashed border-neutral-300 dark:border-neutral-600 hover:border-blue-400 dark:hover:border-blue-500 transition-colors"
            >
              <span className="text-xs font-medium text-neutral-700 dark:text-neutral-200">Custom server</span>
              <p className="text-[10px] text-neutral-500 dark:text-neutral-400 mt-0.5">npm / PyPI package or a local command (STDIO)</p>
            </button>
            <button
              onClick={() => { setDraft(blankDraft('http')); setAuthArgsText(''); setMode('form') }}
              className="text-left p-2.5 rounded-md border border-dashed border-neutral-300 dark:border-neutral-600 hover:border-blue-400 dark:hover:border-blue-500 transition-colors"
            >
              <span className="text-xs font-medium text-neutral-700 dark:text-neutral-200">Remote HTTP server</span>
              <p className="text-[10px] text-neutral-500 dark:text-neutral-400 mt-0.5">Streamable HTTP MCP endpoint</p>
            </button>
          </div>
        </div>
      )}

      {mode === 'form' && draft && (
        <div className="space-y-3">
          {/* Identity */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={labelCls}>Name</label>
              <input
                type="text"
                value={draft.name}
                onChange={(e) => patch({ name: e.target.value.replace(/[^a-z0-9_-]/g, '') })}
                placeholder="e.g. my_server"
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>
                {isHttp ? 'URL' : isCustom ? 'Command' : isPython ? 'PyPI package' : 'npm package'}
              </label>
              {isHttp ? (
                <input type="url" value={draft.url ?? ''} onChange={(e) => patch({ url: e.target.value })} placeholder="https://mcp.example.com/mcp" className={inputCls} />
              ) : isCustom ? (
                <input type="text" value={draft.command ?? ''} onChange={(e) => patch({ command: e.target.value })} placeholder="node, python, /path/to/binary" className={inputCls} />
              ) : isPython ? (
                <input type="text" value={draft.pypiPackage ?? ''} onChange={(e) => patch({ pypiPackage: e.target.value })} placeholder="my-mcp-package" className={inputCls} />
              ) : (
                <input type="text" value={draft.npmPackage ?? ''} onChange={(e) => patch({ npmPackage: e.target.value })} placeholder="@scope/mcp-package" className={inputCls} />
              )}
            </div>
          </div>
          {(draft.description || registryEntry?.description) && (
            <p className="text-[10px] text-neutral-500 dark:text-neutral-400">{draft.description ?? registryEntry?.description}</p>
          )}
          {registryEntry?.prerequisite && (
            <p className="text-[10px] text-amber-600 dark:text-amber-400">{registryEntry.prerequisite}</p>
          )}

          {/* Args */}
          {!isHttp && (
            <div>
              <label className={labelCls}>Args {!isCustom && <span className="text-neutral-400 dark:text-neutral-500">(appended after package)</span>}</label>
              <div className="space-y-1">
                {(draft.args ?? []).map((arg, i) => (
                  <div key={i} className="flex items-center gap-1">
                    <input
                      type="text" value={arg}
                      onChange={(e) => { const next = [...(draft.args ?? [])]; next[i] = e.target.value; patch({ args: next }) }}
                      className={REGISTRY_ARG_PLACEHOLDER_RE.test(arg) ? inputAmberCls : inputCls}
                    />
                    <button onClick={() => patch({ args: (draft.args ?? []).filter((_, j) => j !== i) })} className="text-neutral-400 hover:text-red-500 text-xs px-1">x</button>
                  </div>
                ))}
                <button onClick={() => patch({ args: [...(draft.args ?? []), ''] })} className="text-[11px] text-blue-500 hover:text-blue-700 font-medium">+ Add arg</button>
              </div>
              {hasPlaceholders && (
                <p className="text-[10px] text-amber-600 dark:text-amber-400 mt-1">
                  Replace {unresolvedPlaceholders.join(', ')} with {unresolvedPlaceholders.length === 1 ? 'a real value' : 'real values'} before connecting.
                </p>
              )}
            </div>
          )}

          {/* Run location */}
          {!isHttp && (
            <div>
              <label className={labelCls}>Runs on</label>
              <div className="grid grid-cols-2 gap-1 rounded-md border border-neutral-300 dark:border-neutral-600 p-0.5">
                <button
                  onClick={() => patch({ runLocation: 'host' })}
                  className={`py-1 text-[11px] rounded ${draft.runLocation === 'host' ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300 font-medium' : 'text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-700'}`}
                >
                  Host
                </button>
                <button
                  onClick={() => patch({ runLocation: 'shared' })}
                  className={`py-1 text-[11px] rounded ${draft.runLocation !== 'host' ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300 font-medium' : 'text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-700'}`}
                >
                  Container
                </button>
              </div>
              <p className="text-[9px] text-neutral-400 dark:text-neutral-500 mt-0.5">
                {draft.runLocation === 'host' ? HOST_BOUNDARY_TEXT : CONTAINER_TEXT}
              </p>
              {draft.runLocation === 'host' && hostAccessEnabled === false && (
                <p className="text-[9px] text-amber-600 dark:text-amber-400 mt-0.5">
                  Host access is disabled app-wide, so this server will be containerized until it is enabled.{' '}
                  {onEnableHostAccess && (
                    <button onClick={onEnableHostAccess} className="underline font-medium hover:text-amber-700 dark:hover:text-amber-300">Enable host access</button>
                  )}
                </p>
              )}
            </div>
          )}

          {/* Available to agents */}
          <div className="flex items-start justify-between gap-3 rounded-md border border-neutral-200 dark:border-neutral-700 p-2">
            <div>
              <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">Available to agents</span>
              <p className="text-[9px] text-neutral-400 dark:text-neutral-500 mt-0.5">
                Any agent may attach and use this server (via mcp_available / mcp_install).
                {draft.agentVisible === undefined && (
                  <> Default for {isHttp ? 'remote' : draft.runLocation === 'host' ? 'host' : 'container'} servers: {suggestedAgentVisible(draft) ? 'on' : 'off'}.</>
                )}
              </p>
            </div>
            <input
              type="checkbox"
              checked={isRegistrationAgentVisible(draft)}
              onChange={(e) => patch({ agentVisible: e.target.checked })}
              className="mt-0.5"
            />
          </div>

          {/* Env values */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs text-neutral-500 dark:text-neutral-400">Environment variables</label>
              <button onClick={() => patch({ env: [...(draft.env ?? []), { key: '', value: '' }] })} className="text-[11px] text-blue-500 hover:text-blue-700 font-medium">+ Add</button>
            </div>
            <div className="space-y-1.5">
              {(draft.env ?? []).map((entry, i) => (
                <div key={i} className="flex gap-1.5 items-center">
                  <input
                    type="text" value={entry.key} placeholder="KEY"
                    onChange={(e) => { const next = [...(draft.env ?? [])]; next[i] = { ...next[i], key: e.target.value }; patch({ env: next }) }}
                    className={inputCls}
                  />
                  <input
                    type="password" value={entry.value} placeholder="value"
                    onChange={(e) => { const next = [...(draft.env ?? [])]; next[i] = { ...next[i], value: e.target.value }; patch({ env: next }) }}
                    className={inputCls}
                  />
                  <button onClick={() => patch({ env: (draft.env ?? []).filter((_, j) => j !== i) })} className="text-xs text-red-400 hover:text-red-600 px-1">x</button>
                </div>
              ))}
            </div>
          </div>

          {/* HTTP header config */}
          {isHttp && (
            <div className="space-y-2">
              <div>
                <label className={labelCls}>Bearer token env var</label>
                <input type="text" value={draft.bearerTokenEnvVar ?? ''} onChange={(e) => patch({ bearerTokenEnvVar: e.target.value })} placeholder="MCP_BEARER_TOKEN" className={inputCls} />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs text-neutral-500 dark:text-neutral-400">Headers from environment variables</label>
                  <button onClick={() => patch({ headerEnv: [...(draft.headerEnv ?? []), { key: '', value: '' }] })} className="text-[11px] text-blue-500 hover:text-blue-700 font-medium">+ Add</button>
                </div>
                <div className="space-y-1.5">
                  {(draft.headerEnv ?? []).map((h, i) => (
                    <div key={i} className="flex gap-1.5 items-center">
                      <input type="text" value={h.key} placeholder="Header" onChange={(e) => { const next = [...(draft.headerEnv ?? [])]; next[i] = { ...next[i], key: e.target.value }; patch({ headerEnv: next }) }} className={inputCls} />
                      <input type="text" value={h.value} placeholder="ENV_VAR" onChange={(e) => { const next = [...(draft.headerEnv ?? [])]; next[i] = { ...next[i], value: e.target.value }; patch({ headerEnv: next }) }} className={inputCls} />
                      <button onClick={() => patch({ headerEnv: (draft.headerEnv ?? []).filter((_, j) => j !== i) })} className="text-xs text-red-400 hover:text-red-600 px-1">x</button>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs text-neutral-500 dark:text-neutral-400">Static headers</label>
                  <button onClick={() => patch({ headers: [...(draft.headers ?? []), { key: '', value: '' }] })} className="text-[11px] text-blue-500 hover:text-blue-700 font-medium">+ Add</button>
                </div>
                <div className="space-y-1.5">
                  {(draft.headers ?? []).map((h, i) => (
                    <div key={i} className="flex gap-1.5 items-center">
                      <input
                        type="text" value={h.key} placeholder="Header"
                        onChange={(e) => { const next = [...(draft.headers ?? [])]; next[i] = { ...next[i], key: e.target.value, value: isSensitiveMcpHeader(e.target.value) ? '' : next[i].value }; patch({ headers: next }) }}
                        className={inputCls}
                      />
                      <input
                        type="password" value={h.value}
                        placeholder={isSensitiveMcpHeader(h.key) ? 'Use env-backed headers' : 'Value'}
                        disabled={isSensitiveMcpHeader(h.key)}
                        onChange={(e) => { const next = [...(draft.headers ?? [])]; next[i] = { ...next[i], value: e.target.value }; patch({ headers: next }) }}
                        className={inputCls}
                      />
                      <button onClick={() => patch({ headers: (draft.headers ?? []).filter((_, j) => j !== i) })} className="text-xs text-red-400 hover:text-red-600 px-1">x</button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Auth preflight */}
          {!isHttp && (
            <div className="space-y-1.5 rounded-md border border-neutral-200 dark:border-neutral-700 p-2">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">Interactive authorization (OAuth)</span>
                  <p className="text-[9px] text-neutral-400 dark:text-neutral-500 mt-0.5">
                    Runs the server once in auth mode before connecting — opens a browser to authorize.
                  </p>
                </div>
                <input type="checkbox" checked={!!draft.auth} onChange={(e) => patch({ auth: e.target.checked || undefined })} className="mt-0.5" />
              </div>
              {draft.auth && (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className={labelCls}>Auth args</label>
                    <input
                      type="text"
                      value={authArgsText}
                      onChange={(e) => setAuthArgsText(e.target.value)}
                      onBlur={commitAuthArgs}
                      placeholder="auth"
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label className={labelCls}>Callback port <span className="text-neutral-400">(usually auto-detected)</span></label>
                    <input
                      type="number" min={1} max={65535}
                      value={draft.authPort ?? ''}
                      onChange={(e) => patch({ authPort: e.target.value ? parseInt(e.target.value, 10) : undefined })}
                      className={inputCls}
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Credential files */}
          {!isHttp && (draft.credentialFiles ?? []).length > 0 && (
            <div className="space-y-1.5">
              <label className="block text-xs text-neutral-500 dark:text-neutral-400">Credential files</label>
              {(draft.credentialFiles ?? []).map((f) => {
                const payload = filePayloads[f.path]
                const base = f.path.split('/').pop()
                return (
                  <div key={f.path} className="flex items-center justify-between gap-2 rounded-md border border-neutral-200 dark:border-neutral-700 p-2">
                    <div className="min-w-0">
                      <p className="text-[10px] font-mono text-neutral-600 dark:text-neutral-300 truncate">{f.path}</p>
                      <p className="text-[9px] text-neutral-400 dark:text-neutral-500">
                        {payload
                          ? `${payload.fileName} (${payload.size < 2048 ? `${payload.size} B` : `${Math.round(payload.size / 1024)} KiB`}) selected`
                          : f.required
                            ? `This server needs ${base} — choose the file to provide it.`
                            : `${base} — created by the server (e.g. tokens) or provide your own.`}
                      </p>
                    </div>
                    <div className="shrink-0">
                      <input
                        ref={(el) => { fileInputsRef.current[f.path] = el }}
                        type="file"
                        className="hidden"
                        onChange={(e) => handleFilePick(f.path, e.target.files?.[0])}
                      />
                      <button
                        onClick={() => fileInputsRef.current[f.path]?.click()}
                        className="text-[11px] text-blue-500 hover:text-blue-700 font-medium"
                      >
                        {payload ? 'Replace…' : 'Choose file…'}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Tool timeout */}
          <div>
            <label className={labelCls}>Tool timeout (seconds)</label>
            <input
              type="number" min={1}
              value={draft.toolCallTimeout ?? ''}
              onChange={(e) => { const val = e.target.value ? parseInt(e.target.value, 10) : undefined; patch({ toolCallTimeout: val && val > 0 ? val : undefined }) }}
              placeholder="60"
              className={inputCls}
            />
          </div>

          {/* Per-agent credential storage panel (edit mode: the registration exists) */}
          {editing && (
            <McpCredentialPanel server={draft} registryEntry={registryEntry} onServerUpdate={patch} />
          )}

          {/* Connect result */}
          {test.phase === 'done' && (
            <div className={`rounded-md border p-2 ${test.success ? 'border-green-300 dark:border-green-800' : 'border-red-300 dark:border-red-800'}`}>
              {test.success ? (
                <div>
                  <p className="text-xs text-green-600 dark:text-green-400 font-medium">
                    Connected ({test.location}) — {test.tools?.length ?? 0} tools discovered{test.authRan ? ', authorization completed' : ''}
                  </p>
                  {(test.tools?.length ?? 0) > 0 && (
                    <button onClick={() => setShowTools(!showTools)} className="text-[10px] text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 mt-0.5">
                      {showTools ? 'Hide tools' : 'Show tools'}
                    </button>
                  )}
                  {showTools && (
                    <p className="text-[10px] font-mono text-neutral-500 dark:text-neutral-400 mt-1 max-h-32 overflow-y-auto">
                      {test.tools?.map((t) => t.name).join(', ')}
                    </p>
                  )}
                </div>
              ) : (
                <div>
                  <p className="text-xs text-red-500 font-medium">Connect failed{test.location ? ` (${test.location})` : ''}</p>
                  {test.error && (
                    <pre className="text-[10px] font-mono text-red-500/90 whitespace-pre-wrap mt-1 max-h-40 overflow-y-auto">{test.error}</pre>
                  )}
                  {test.stderrTail && test.stderrTail.length > 0 && (
                    <pre className="text-[10px] font-mono text-neutral-500 dark:text-neutral-400 whitespace-pre-wrap mt-1 max-h-32 overflow-y-auto">{test.stderrTail.join('\n')}</pre>
                  )}
                </div>
              )}
              {(test.notes?.length ?? 0) > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {test.notes!.map((n, i) => (
                    <li key={i} className="text-[9px] text-neutral-400 dark:text-neutral-500">• {n}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Footer */}
          <div className="flex items-center justify-between pt-1">
            <div>
              {!editing && (
                <button onClick={() => { setMode('choose'); setDraft(null); setTest({ phase: 'idle' }) }} className="text-[11px] text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200">
                  ← Back
                </button>
              )}
            </div>
            <div className="flex items-center gap-2">
              {!draft.lastVerifiedAt && test.phase !== 'done' && (
                <Tooltip tip="You can save without connecting; the server row will show “Not verified” until a connect succeeds.">
                  <span className="text-[9px] text-neutral-400 dark:text-neutral-500">Not verified yet</span>
                </Tooltip>
              )}
              <button
                onClick={handleConnect}
                disabled={!canLaunch || hasPlaceholders || test.phase === 'running'}
                className="px-3 py-1.5 text-xs font-medium rounded-md border border-blue-500 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 disabled:opacity-40"
              >
                {test.phase === 'running' ? (draft.auth ? 'Authorizing…' : 'Connecting…') : 'Connect'}
              </button>
              <button
                onClick={handleSave}
                disabled={!canLaunch || hasPlaceholders}
                className="px-3 py-1.5 text-xs font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </Dialog>
  )
}
