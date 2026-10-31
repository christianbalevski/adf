import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { McpServerRegistration } from '../../../shared/types/ipc.types'
import type { McpServerLogEntry, McpToolInfo } from '../../../shared/types/adf-v02.types'
import { REGISTRY_ARG_PLACEHOLDER_RE, findEntryIn, hasUnresolvedPlaceholderArgs, registrationFromRegistryEntry } from '../../../shared/constants/mcp-registry'
import type { McpRegistryEntry } from '../../../shared/constants/mcp-registry'
import { useMcpRegistryStore } from '../../stores/mcp-registry.store'
import { MCP_EXECUTABLE_IDENTITY_FIELDS, isSensitiveMcpHeader, isRegistrationAgentVisible, sameExecutableIdentity, suggestedAgentVisible } from '../../../shared/utils/mcp-config'
import { Dialog } from '../common/Dialog'
import { Tooltip } from '../common/Tooltip'
import { DocsLink, InfoHint } from '../common/DocsLink'
import { DOCS, MCP_SETUP_DOCS } from '../../../shared/constants/docs-links'
import { McpCredentialPanel } from './McpCredentialPanel'
import { McpServerLogs } from './McpServerLogs'
import { McpHttpOAuthToggle } from './McpHttpOAuthToggle'
import { BrandIcon } from './BrandIcon'
import { useSettingsApi } from '../settings/settings-runtime'

/** One-line boundary statement shown on host-located servers. */
export const HOST_BOUNDARY_TEXT = 'Runs on the host as your user account, with its file and network access.'
const CONTAINER_TEXT = 'Default. Runs in the shared compute container, with no access to host files. Requires Podman.'
/** Container caveat for a custom command: the container has its own filesystem. */
const CONTAINER_CUSTOM_COMMAND_TEXT = 'The command must exist inside the container (npx, uvx, node and python do). Switch to Host to run a command installed on your machine.'

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
  /** An interactive browser OAuth sign-in completed as part of this Connect. */
  oauthRan?: boolean
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
  /** Edit mode only: remove this registration (footer "Remove server"). */
  onRemove?: (id: string) => void
  /**
   * A Connect completed an interactive browser OAuth sign-in (result.oauthRan),
   * storing a token main-side without mutating the server list. The dashboard
   * uses this to refresh its OAuth chip, which otherwise only re-runs when the
   * mcpServers array reference changes.
   */
  onOAuthChanged?: () => void
  /**
   * Connect failed because Podman isn't set up (result.computeUnavailable):
   * the dashboard shows the compute sheet. `runOnHost` sets this draft to run
   * on the host; `retry` runs Connect again.
   */
  onComputeNeeded?: (name: string, actions: { retry: () => void; runOnHost: () => Promise<boolean>; pinnedToContainer: boolean }) => void
  /** Turn on host access without asking again (the compute sheet already asked). */
  onEnableHostAccessNow?: () => Promise<boolean>
  /** settings.compute.mcpOnHost: a server with no chosen location runs on the host (while Host access is on). */
  mcpOnHost?: boolean
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
 * Entries the quick-add grid offers: deprecated entries are excluded (they
 * stay valid data for lookups on existing installs, but must not be installed
 * fresh), as is anything already registered.
 */
export function availableRegistryEntries(
  entries: McpRegistryEntry[],
  existingServers: McpServerRegistration[],
): McpRegistryEntry[] {
  return entries.filter(
    (entry) => !entry.deprecated && !existingServers.some((s) =>
      (entry.npmPackage && s.npmPackage === entry.npmPackage) ||
      (entry.pypiPackage && s.pypiPackage === entry.pypiPackage) ||
      (entry.url && s.url === entry.url)
    )
  )
}

/**
 * Env keys a quick-add card surfaces as "Requires: …" — requiredEnvKeys plus,
 * for HTTP entries, the bearer/header env names, deduped.
 */
/**
 * One-line identity subtitle for a registration: how it launches
 * (`npx <pkg>` / `uvx <pkg>` / the URL / the raw command) plus the last
 * verified server version when known. Empty string when the identity field
 * itself is still blank.
 */
export function registrationSourceLine(reg: McpServerRegistration): string {
  const source = reg.url
    ? reg.url
    : reg.type === 'custom'
      ? (reg.command ?? '')
      : reg.type === 'uvx' || reg.type === 'pip'
        ? (reg.pypiPackage ? `uvx ${reg.pypiPackage}` : '')
        : (reg.npmPackage ? `npx ${reg.npmPackage}` : '')
  if (!source) return ''
  const version = reg.version && reg.version !== 'unknown' ? ` · v${reg.version}` : ''
  return source + version
}

/**
 * Declared credential files the user picked in this session but that have NOT
 * been persisted yet. A successful Connect (which stamps `lastVerifiedAt`) is
 * the sole path that materializes credential files to the host, so a selected
 * payload while `lastVerifiedAt` is still unset means the file lives only in
 * renderer state — Save alone would silently drop it. Split by whether the
 * server *requires* the file: required-pending must gate Save (the server
 * cannot start without it); optional-pending only needs a heads-up note.
 */
export function pendingCredentialFiles(
  draft: Pick<McpServerRegistration, 'credentialFiles' | 'lastVerifiedAt'> | null,
  filePayloads: Record<string, unknown>,
): { required: string[]; optional: string[] } {
  // A prior successful Connect materialized whatever was selected then — treat
  // the whole set as persisted (mirrors handleConnect's stamp semantics).
  if (!draft || draft.lastVerifiedAt) return { required: [], optional: [] }
  const required: string[] = []
  const optional: string[] = []
  for (const f of draft.credentialFiles ?? []) {
    if (!filePayloads[f.path]) continue
    ;(f.required ? required : optional).push(f.path)
  }
  return { required, optional }
}

/**
 * What the "Configuration" step of a catalog server asks for, and whether the
 * setup steps read as done. Placeholder args are located by the ENTRY's args
 * (not the draft's), so an arg stays in the step after the user fills it in.
 * Required credential files count as provided once picked or once a Connect
 * has stored them (lastVerifiedAt). Env keys stored per agent live in the
 * .adf, so they never hold the step open.
 */
export function setupChecklist(
  draft: Pick<McpServerRegistration, 'args' | 'env' | 'credentialFiles' | 'lastVerifiedAt' | 'credentialStorage'>,
  entry: Pick<McpRegistryEntry, 'args' | 'requiredEnvKeys'> | undefined,
  filePayloads: Record<string, unknown>,
): { placeholderArgs: number[]; requiredEnv: string[]; requiredFiles: string[]; inputsDone: boolean; connected: boolean } {
  const placeholderArgs = (entry?.args ?? [])
    .map((arg, i) => (REGISTRY_ARG_PLACEHOLDER_RE.test(arg) && i < (draft.args ?? []).length ? i : -1))
    .filter((i) => i >= 0)
  const requiredEnv = entry?.requiredEnvKeys ?? []
  const requiredFiles = (draft.credentialFiles ?? []).filter((f) => f.required).map((f) => f.path)
  const envDone = draft.credentialStorage === 'agent' ||
    requiredEnv.every((k) => (draft.env ?? []).some((e) => e.key === k && !!e.value))
  const filesDone = !!draft.lastVerifiedAt || requiredFiles.every((p) => !!filePayloads[p])
  return {
    placeholderArgs,
    requiredEnv,
    requiredFiles,
    inputsDone: !hasUnresolvedPlaceholderArgs(draft.args) && envDone && filesDone,
    connected: !!draft.lastVerifiedAt,
  }
}

/** `{allowed-directory}` → "Allowed directory": the label for a placeholder arg. */
export function placeholderLabel(arg: string): string {
  const token = arg.match(REGISTRY_ARG_PLACEHOLDER_RE)?.[0].slice(1, -1) ?? arg
  const words = token.replace(/-/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * Whether a registration (or the registry entry it was seeded from)
 * authenticates via interactive browser OAuth rather than a pasted
 * bearer/header token. OAuth-ness can come from the draft itself (a saved
 * registration carries `oauth`) or the matched registry entry.
 */
export function isOAuthEntry(
  draft: Pick<McpServerRegistration, 'oauth'> | null | undefined,
  registryEntry?: Pick<McpRegistryEntry, 'oauth'>,
): boolean {
  return !!(draft?.oauth || registryEntry?.oauth)
}

/**
 * Dual-mode OAuth: browser sign-in is the default but a paste-token fallback
 * stays available (CI/daemon users). True only when the entry is OAuth AND
 * still declares a bearer-token env var to paste into.
 */
export function isDualModeOAuthEntry(
  draft: Pick<McpServerRegistration, 'oauth' | 'bearerTokenEnvVar'> | null | undefined,
  registryEntry?: Pick<McpRegistryEntry, 'oauth' | 'bearerTokenEnvVar'>,
): boolean {
  if (!isOAuthEntry(draft, registryEntry)) return false
  return !!(draft?.bearerTokenEnvVar || registryEntry?.bearerTokenEnvVar)
}

/**
 * Whether a dual-mode OAuth row actually has a pasted bearer/header token
 * populated — i.e. it is authenticating via a token, not (yet) via browser
 * OAuth. True when the declared bearer-token env var is present in `env` with a
 * non-empty value, or when any header-env row references a populated env var.
 * Token values never leave the renderer as anything but this boolean signal.
 */
export function mcpTokenConfigured(
  reg: Pick<McpServerRegistration, 'bearerTokenEnvVar' | 'headerEnv' | 'env'>,
): boolean {
  const env = reg.env ?? []
  const bearerOk = !!reg.bearerTokenEnvVar && env.some((e) => e.key === reg.bearerTokenEnvVar && !!e.value)
  if (bearerOk) return true
  // header-env rows are { key: headerName, value: envVarName } — the token
  // lives in the referenced env var, so count it only when that var is filled.
  return (reg.headerEnv ?? []).some((h) => !!h.value && env.some((e) => e.key === h.value && !!e.value))
}

/**
 * Whether the dashboard health slot should show "Sign in needed": the row
 * authenticates via OAuth, no token is stored main-side (signedIn === false),
 * AND no pasted bearer/header token is configured. A dual-mode entry running on
 * a pasted token never did OAuth, so it must fall through to the normal
 * verified/Not-verified logic rather than sit on a permanent amber warning.
 */
export function oauthNeedsSignIn(
  reg: McpServerRegistration,
  registryEntry: Pick<McpRegistryEntry, 'oauth'> | undefined,
  signedIn: boolean | undefined,
): boolean {
  if (!isOAuthEntry(reg, registryEntry)) return false
  if (signedIn !== false) return false
  return !mcpTokenConfigured(reg)
}

/**
 * Whether a server's "Needs keys" health chip should fire: at least one
 * required env key is empty AND the server is neither OAuth (those need a
 * sign-in, not env keys) nor per-agent credential storage (keys live in the
 * .adf). OAuth-only entries have no required env keys to paste, so they never
 * gate on "fill the token first".
 */
export function hasEmptyRequiredKeys(
  reg: McpServerRegistration,
  registryEntry: Pick<McpRegistryEntry, 'requiredEnvKeys' | 'oauth'> | undefined,
): boolean {
  if (isOAuthEntry(reg, registryEntry)) return false
  if (reg.credentialStorage === 'agent') return false
  return (registryEntry?.requiredEnvKeys ?? []).some((rk) => {
    const envEntry = (reg.env ?? []).find((e) => e.key === rk)
    return !envEntry || !envEntry.value
  })
}

function cardRequiredKeys(entry: McpRegistryEntry): string[] {
  return [...new Set([
    ...entry.requiredEnvKeys,
    ...(entry.bearerTokenEnvVar ? [entry.bearerTokenEnvVar] : []),
    ...(entry.headerEnv ?? []).map((h) => h.env),
  ])]
}

/**
 * A fresh draft. Stdio drafts carry NO `runLocation`: a new server runs in the
 * shared compute container (shouldContainerize's default) and Host is a
 * deliberate click on the "Runs on" control. Absent rather than an explicit
 * `'shared'` — see registrationFromRegistryEntry for why pinning matters.
 */
export function blankDraft(type: 'custom' | 'http'): McpServerRegistration {
  return type === 'http'
    ? { id: newId(), name: '', type: 'http', url: '', headers: [], headerEnv: [], env: [] }
    : { id: newId(), name: '', type: 'custom', command: '', args: [], env: [] }
}

const inputCls = 'w-full px-2 py-1.5 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400'
// Amber-bordered variant flagging arg inputs that still carry an unresolved {placeholder}.
const inputAmberCls = inputCls.replace('border-neutral-300 dark:border-neutral-600', 'border-amber-400 dark:border-amber-500')
const labelCls = 'block text-xs text-neutral-500 dark:text-neutral-400 mb-0.5'

/**
 * The body below is a ~1000-line form with a dozen effects and a registry
 * subscription. Mounting it only while the dialog is open keeps it out of
 * every Settings re-render; the <dialog> has no close animation, so the
 * unmount is visually identical to the old `el.close()`.
 */
export function McpAddServerModal(props: McpAddServerModalProps) {
  if (!props.open) return null
  return <McpAddServerModalBody {...props} />
}

function McpAddServerModalBody({ open, onClose, editing, existingServers, hostAccessEnabled, onEnableHostAccess, onSave, onRemove, onOAuthChanged, onComputeNeeded, onEnableHostAccessNow, mcpOnHost }: McpAddServerModalProps) {
  // The runtime the Settings picker shows (multi-runtime.md §6.3); api outside Settings.
  const api = useSettingsApi()
  const [mode, setMode] = useState<'choose' | 'form'>('choose')
  const [draft, setDraft] = useState<McpServerRegistration | null>(null)
  const [filePayloads, setFilePayloads] = useState<Record<string, FilePayload>>({})
  const [test, setTest] = useState<TestState>({ phase: 'idle' })
  const [showTools, setShowTools] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [showAgentKeys, setShowAgentKeys] = useState(false)
  const [showLogs, setShowLogs] = useState(false)
  const [logEntries, setLogEntries] = useState<McpServerLogEntry[] | null>(null)
  // Auth-args field keeps raw text so typing a space isn't stripped by a
  // split/join round-trip on every keystroke; parsed into an array on commit.
  const [authArgsText, setAuthArgsText] = useState('')
  const [chooseQuery, setChooseQuery] = useState('')
  const [chooseCategory, setChooseCategory] = useState<McpRegistryEntry['category'] | 'all'>('all')
  // The registration being edited vanished from the parent (an agent removed it
  // via mcp_uninstall, settings synced in) while the modal stayed open. We keep
  // the in-progress draft and surface this instead of morphing into the add
  // grid; Save re-creates it (onSave upserts by id).
  const [externallyRemoved, setExternallyRemoved] = useState(false)
  const fileInputsRef = useRef<Record<string, HTMLInputElement | null>>({})
  // Latest draft for async callbacks (a Connect can resolve long after edits).
  const draftRef = useRef(draft)
  draftRef.current = draft

  // Reset per open/editing TARGET (by name), not on every `editing` object
  // identity change — the dashboard replaces the row object on external
  // updates (a Reconnect stamping lastVerifiedAt, a managed-install version
  // patch), and resetting then would silently discard in-progress edits.
  const editingKey = editing ? editing.name : null
  // Tracks the editingKey the reset effect last acted on, so we can tell a
  // genuine fresh open (prevKey null) from a mid-edit disappearance of the
  // target (prevKey was a name, now null) — see the guard below.
  const prevEditingKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (!open) { prevEditingKeyRef.current = null; return }
    const prevKey = prevEditingKeyRef.current
    prevEditingKeyRef.current = editingKey
    // Mid-edit disappearance: we were editing a target (prevKey non-null) that
    // just became null while a form draft with an id is live. Removing the row
    // externally must NOT discard the user's edits or flip to the choose grid —
    // keep the draft in form mode and surface a dismissable notice. Save
    // re-creates the row (handleModalSave upserts by id).
    if (editingKey === null && prevKey !== null && draftRef.current?.id) {
      setExternallyRemoved(true)
      setMode('form')
      return
    }
    setExternallyRemoved(false)
    setFilePayloads({})
    setTest({ phase: 'idle' })
    setShowTools(false)
    setShowAdvanced(false)
    setShowAgentKeys(false)
    setShowLogs(false)
    setLogEntries(null)
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
  // Moving the server between host and container does too: Connect tested it
  // (and stored its credential files) where it ran.
  const patch = (p: Partial<McpServerRegistration>) => {
    const touchesIdentity = MCP_EXECUTABLE_IDENTITY_FIELDS.some((k) => k in p) ||
      ('runLocation' in p && p.runLocation !== draftRef.current?.runLocation)
    setDraft((d) => (d ? { ...d, ...p, ...(touchesIdentity ? { lastVerifiedAt: undefined } : {}) } : d))
    if (touchesIdentity) setTest((t) => (t.phase === 'done' ? { phase: 'idle' } : t))
  }

  /** Commit the raw auth-args text into the draft as a parsed array. */
  const commitAuthArgs = (): string[] => {
    const arr = authArgsText.split(/\s+/).filter(Boolean)
    setDraft((d) => (d ? { ...d, authArgs: arr } : d))
    return arr
  }

  // Dynamic registry: bundled snapshot immediately, live entries once fetched.
  const { entries: registryEntries, source: registrySource, updatedAt: registryUpdatedAt } = useMcpRegistryStore()

  const registryEntry = useMemo(() => {
    if (!draft) return undefined
    return draft.npmPackage ? findEntryIn(registryEntries, { npmPackage: draft.npmPackage })
      : draft.pypiPackage ? findEntryIn(registryEntries, { pypiPackage: draft.pypiPackage })
      : draft.url ? findEntryIn(registryEntries, { url: draft.url }) : undefined
  }, [draft, registryEntries])

  const availableEntries = useMemo(
    () => availableRegistryEntries(registryEntries, existingServers),
    [registryEntries, existingServers]
  )
  const availableCategories = useMemo(
    () => REGISTRY_CATEGORIES.filter((c) => availableEntries.some((e) => e.category === c)),
    [availableEntries]
  )
  const visibleEntries = useMemo(
    () => filterRegistryEntries(availableEntries, chooseQuery, chooseCategory),
    [availableEntries, chooseQuery, chooseCategory]
  )

  const isHttp = draft ? (draft.type === 'http' || !!draft.url) : false
  // OAuth-ness comes from the draft (a saved registration) or the registry
  // entry it was seeded from. Drives the sign-in copy + softened token inputs.
  const isOAuth = isHttp && isOAuthEntry(draft, registryEntry)
  const isDualMode = isHttp && isDualModeOAuthEntry(draft, registryEntry)
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

  // Credential files picked but not yet materialized (materialization happens
  // only on a successful Connect). Required-pending blocks Save so the file
  // isn't silently lost; optional-pending only warrants a note.
  const pendingCreds = useMemo(() => pendingCredentialFiles(draft, filePayloads), [draft, filePayloads])
  const hasPendingRequiredCreds = pendingCreds.required.length > 0
  const hasPendingOptionalCreds = pendingCreds.optional.length > 0

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

  // Connect again after the compute sheet resolved, against the draft as it is now.
  const [retestRequested, setRetestRequested] = useState(false)
  useEffect(() => {
    if (!retestRequested) return
    setRetestRequested(false)
    void handleConnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retestRequested])

  const handleConnect = async () => {
    if (!draft || !canLaunch || hasPlaceholders) return
    // Snapshot the identity under test — the form stays editable while the
    // test runs, and a success stamp must only ever land on this identity.
    const tested = draft
    setTest({ phase: 'running' })
    setShowTools(false)
    try {
      // Only send payloads the CURRENT draft declares — filePayloads can hold
      // leftovers from a previously picked card (cleared on Back/re-pick, but
      // this filter is the hard guarantee they never leave the renderer).
      const declared = new Set((draft.credentialFiles ?? []).map((f) => f.path))
      const credentialFiles = Object.entries(filePayloads)
        .filter(([path]) => declared.has(path))
        .map(([path, p]) => ({ path, contentB64: p.contentB64 }))
      const result = await api?.testMcpRegistration({
        registration: { ...draft, authArgs: commitAuthArgs() },
        credentialFiles: credentialFiles.length ? credentialFiles : undefined,
      })
      if (result?.success) {
        const current = draftRef.current
        if (current && sameExecutableIdentity(current, tested) && current.runLocation === tested.runLocation) {
          patch({ lastVerifiedAt: Date.now(), ...(result.serverVersion ? { version: result.serverVersion } : {}) })
          setTest({ phase: 'done', success: true, tools: result.tools, notes: result.notes, authRan: result.authRan, oauthRan: result.oauthRan, location: result.location })
        } else {
          // Identity edited mid-test: the result vouches for a config the
          // draft no longer is — drop it, no stamp.
          setTest({ phase: 'idle' })
        }
        // A browser OAuth sign-in stored a token main-side without touching the
        // server list — let the dashboard refresh its stale sign-in chip.
        if (result.oauthRan) onOAuthChanged?.()
      } else {
        setTest({ phase: 'done', success: false, error: result?.error ?? 'Failed to connect', stderrTail: result?.stderrTail, notes: result?.notes, location: result?.location })
        if (result?.computeUnavailable && onComputeNeeded) {
          onComputeNeeded(tested.name, {
            pinnedToContainer: tested.runLocation === 'shared',
            retry: () => setRetestRequested(true),
            runOnHost: async () => {
              patch({ runLocation: 'host' })
              return hostAccessEnabled || !onEnableHostAccessNow ? true : onEnableHostAccessNow()
            },
          })
        }
      }
    } catch (err) {
      setTest({ phase: 'done', success: false, error: String(err) })
    }
  }

  const handleSave = () => {
    if (!draft || hasPlaceholders || hasPendingRequiredCreds) return
    onSave({ ...draft, authArgs: commitAuthArgs() })
    onClose()
  }

  /** Logs disclosure: fetch once on first expand, then just toggle. */
  const handleToggleLogs = async () => {
    const next = !showLogs
    setShowLogs(next)
    if (next && logEntries === null && draft) {
      const result = await api?.getMcpServerLogs({ name: draft.name })
      setLogEntries(result?.logs ?? [])
    }
  }

  // A catalog server keeps its step layout for the whole draft, even if the
  // package is edited under Advanced (which would unmatch registryEntry).
  const catalogRef = useRef<{ id: string; entry: McpRegistryEntry | undefined } | null>(null)
  if (draft && catalogRef.current?.id !== draft.id) catalogRef.current = { id: draft.id, entry: isCustom ? undefined : registryEntry }
  const catalogEntry = draft ? catalogRef.current?.entry : undefined
  const checklist = draft ? setupChecklist(draft, catalogEntry, filePayloads) : null
  const signsIn = isOAuth || !!draft?.auth

  // Env keys the catalog entry declares sit in the "Configuration" step; anything
  // else (and an OAuth entry's paste-token fallback) lives under Advanced.
  // A custom server shows all of its env in its first step.
  const tokenEnvKeys = new Set([draft?.bearerTokenEnvVar, ...(draft?.headerEnv ?? []).map((h) => h.value)].filter(Boolean) as string[])
  const declaredEnvKeys = new Set([...(catalogEntry?.requiredEnvKeys ?? []), ...(catalogEntry?.optionalEnvKeys ?? []), ...tokenEnvKeys])
  const envInStep = (key: string) => !catalogEntry || (declaredEnvKeys.has(key) && !(isOAuth && tokenEnvKeys.has(key)))
  const stepEnvCount = (draft?.env ?? []).filter((e) => envInStep(e.key)).length
  const advancedEnvCount = (draft?.env ?? []).length - stepEnvCount
  const requiredFiles = (draft?.credentialFiles ?? []).filter((f) => f.required)
  const optionalFiles = (draft?.credentialFiles ?? []).filter((f) => !f.required)

  const placeholderArgCount = checklist?.placeholderArgs.length ?? 0
  const showDetailsStep = !catalogEntry || placeholderArgCount > 0 || stepEnvCount > 0 || (!isHttp && requiredFiles.length > 0)
  const detailsTitle = !catalogEntry ? 'Server'
    : placeholderArgCount === 0 && stepEnvCount === 0 ? (requiredFiles.length === 1 ? 'Credential file' : 'Credential files')
      : placeholderArgCount === 0 && requiredFiles.length === 0 ? (stepEnvCount === 1 ? 'Environment variable' : 'Environment variables')
        : 'Configuration'
  const nDetails = isHttp ? 1 : 2
  const nConnect = showDetailsStep ? nDetails + 1 : nDetails

  /** Substitute a placeholder arg's value into the entry's template arg. */
  const placeholderValue = (i: number): string => {
    const template = catalogEntry?.args?.[i] ?? ''
    const token = template.match(REGISTRY_ARG_PLACEHOLDER_RE)?.[0] ?? ''
    const [prefix, suffix] = template.split(token)
    const arg = draft?.args?.[i] ?? ''
    if (arg === template || !arg.startsWith(prefix) || !arg.endsWith(suffix)) return ''
    return arg.slice(prefix.length, arg.length - suffix.length)
  }
  const setPlaceholderValue = (i: number, value: string) => {
    const template = catalogEntry?.args?.[i] ?? ''
    const token = template.match(REGISTRY_ARG_PLACEHOLDER_RE)?.[0] ?? ''
    const next = [...(draft?.args ?? [])]
    next[i] = value ? template.replace(token, value) : template
    patch({ args: next })
  }

  const envRows = (inStep: boolean, fixedKeys: boolean) => (draft?.env ?? []).map((entry, i) => {
    if (envInStep(entry.key) !== inStep) return null
    const optional = !!catalogEntry && !catalogEntry.requiredEnvKeys.includes(entry.key) && !tokenEnvKeys.has(entry.key)
    return (
      <div key={i} className="flex gap-1.5 items-center">
        {fixedKeys ? (
          <span className="w-1/2 shrink-0 text-[10px] font-mono text-neutral-600 dark:text-neutral-300 truncate">
            {entry.key}{optional && <span className="font-sans text-[var(--adf-ui-text-subtle)]"> · optional</span>}
          </span>
        ) : (
          <input
            type="text" value={entry.key} placeholder="KEY"
            onChange={(e) => { const next = [...(draft?.env ?? [])]; next[i] = { ...next[i], key: e.target.value }; patch({ env: next }) }}
            className={inputCls}
          />
        )}
        <input
          type="password" value={entry.value} placeholder="value"
          onChange={(e) => { const next = [...(draft?.env ?? [])]; next[i] = { ...next[i], value: e.target.value }; patch({ env: next }) }}
          className={inputCls}
        />
        {!fixedKeys && (
          <button onClick={() => patch({ env: (draft?.env ?? []).filter((_, j) => j !== i) })} className="text-xs text-red-400 hover:text-red-600 px-1" aria-label="Remove variable">x</button>
        )}
      </div>
    )
  })
  const addEnvButton = (
    <button onClick={() => patch({ env: [...(draft?.env ?? []), { key: '', value: '' }] })} className="text-[11px] text-blue-500 hover:text-blue-700 font-medium">+ Add variable</button>
  )

  const fileRow = (f: { path: string; required?: boolean }) => {
    const payload = filePayloads[f.path]
    const base = f.path.split('/').pop()
    const status = payload
      ? `${payload.fileName} · ${payload.size < 2048 ? `${payload.size} B` : `${Math.round(payload.size / 1024)} KiB`}`
      : draft?.lastVerifiedAt ? 'Stored' : f.required ? 'Not chosen' : 'Created by the server'
    return (
      <div key={f.path} className="flex items-center justify-between gap-2">
        <Tooltip tip={f.path} className="min-w-0">
          <p className="text-[11px] font-mono text-neutral-700 dark:text-neutral-200 truncate">{base}</p>
          <p className={`text-[9px] ${payload ? 'text-green-600 dark:text-green-400' : 'text-[var(--adf-ui-text-subtle)]'}`}>{status}</p>
        </Tooltip>
        <input
          ref={(el) => { fileInputsRef.current[f.path] = el }}
          type="file"
          className="hidden"
          onChange={(e) => handleFilePick(f.path, e.target.files?.[0])}
        />
        <button
          onClick={() => fileInputsRef.current[f.path]?.click()}
          className="shrink-0 text-[11px] text-blue-500 hover:text-blue-700 font-medium"
        >
          {payload ? 'Replace…' : 'Choose file…'}
        </button>
      </div>
    )
  }

  const authSection = draft && !isHttp ? (
    <div className="space-y-1.5">
      <label className="flex items-center justify-between gap-3 text-xs text-neutral-700 dark:text-neutral-300">
        <span className="inline-flex items-center">
          Sign-in command
          <InfoHint tip="Only for servers that document a login command (e.g. npx <pkg> auth) that stores tokens for later runs. Connect runs it first." />
        </span>
        <input type="checkbox" checked={!!draft.auth} onChange={(e) => patch({ auth: e.target.checked || undefined })} />
      </label>
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
            <label className={labelCls}>Callback port <span className="text-[var(--adf-ui-text-subtle)]">(auto)</span></label>
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
  ) : null

  const identityFields = draft ? (
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
  ) : null

  const argsEditor = draft && !isHttp ? (
    <div>
      <label className={labelCls}>Args {!isCustom && <span className="text-[var(--adf-ui-text-subtle)]">(after the package)</span>}</label>
      <div className="space-y-1">
        {(draft.args ?? []).map((arg, i) => (
          <div key={i} className="flex items-center gap-1">
            <input
              type="text" value={arg}
              onChange={(e) => { const next = [...(draft.args ?? [])]; next[i] = e.target.value; patch({ args: next }) }}
              className={REGISTRY_ARG_PLACEHOLDER_RE.test(arg) ? inputAmberCls : inputCls}
            />
            <button onClick={() => patch({ args: (draft.args ?? []).filter((_, j) => j !== i) })} className="text-[var(--adf-ui-text-subtle)] hover:text-red-500 text-xs px-1" aria-label="Remove arg">x</button>
          </div>
        ))}
        <button onClick={() => patch({ args: [...(draft.args ?? []), ''] })} className="text-[11px] text-blue-500 hover:text-blue-700 font-medium">+ Add arg</button>
      </div>
    </div>
  ) : null

  const keyValueRows = (field: 'headers' | 'headerEnv', valuePlaceholder: string) => (draft?.[field] ?? []).map((h, i) => {
    const sensitive = field === 'headers' && isSensitiveMcpHeader(h.key)
    return (
      <div key={i} className="flex gap-1.5 items-center">
        <input
          type="text" value={h.key} placeholder="Header"
          onChange={(e) => { const next = [...(draft?.[field] ?? [])]; next[i] = { ...next[i], key: e.target.value, ...(field === 'headers' && isSensitiveMcpHeader(e.target.value) ? { value: '' } : {}) }; patch({ [field]: next }) }}
          className={inputCls}
        />
        <input
          type={field === 'headers' ? 'password' : 'text'} value={h.value}
          placeholder={sensitive ? 'Use env-backed headers' : valuePlaceholder}
          disabled={sensitive}
          onChange={(e) => { const next = [...(draft?.[field] ?? [])]; next[i] = { ...next[i], value: e.target.value }; patch({ [field]: next }) }}
          className={inputCls}
        />
        <button onClick={() => patch({ [field]: (draft?.[field] ?? []).filter((_, j) => j !== i) })} className="text-xs text-red-400 hover:text-red-600 px-1" aria-label="Remove header">x</button>
      </div>
    )
  })

  const hostByDefault = !!draft && mcpOnHost === true && hostAccessEnabled === true && draft.runLocation === undefined
  const onHost = draft?.runLocation === 'host' || hostByDefault
  const connectBusyLabel = isOAuth ? 'Signing in…' : draft?.auth ? 'Authorizing…' : 'Connecting…'
  const connectLabel = signsIn ? (catalogEntry ? `Sign in to ${catalogEntry.displayName}` : 'Sign in & connect') : 'Connect'
  const saveTip = hasPendingRequiredCreds
    ? 'Unavailable: chosen files are stored only on Connect.'
    : `Saves the server unverified; its row shows “Not verified” until a connect succeeds.${hasPendingOptionalCreds ? ' Chosen files are only stored when you connect.' : ''}`

  return (
    <Dialog lightDismiss={false} open={open} onClose={onClose} title={editing ? `Configure — ${editing.name}` : externallyRemoved && draft ? `Configure — ${draft.name}` : 'Add MCP Server'} wide>
      {mode === 'choose' && (
        <div className="space-y-3">
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
                    onClick={() => { const d = registrationFromRegistryEntry(entry, newId()); setDraft(d); setFilePayloads({}); setAuthArgsText((d.authArgs ?? []).join(' ')); setMode('form') }}
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
                      {entry.oauth && (
                        <span className="text-[9px] px-1 py-0.5 bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 rounded font-medium">Sign in</span>
                      )}
                    </div>
                    <p className="text-[10px] text-neutral-500 dark:text-neutral-400 mt-0.5 line-clamp-2">{entry.description}</p>
                    {/* One line at most: what setup needs, with the long story in tooltips. */}
                    <div className="flex items-center gap-2 mt-0.5 text-[9px]">
                      {entry.prerequisite && (
                        <InfoHint tip={entry.prerequisite}><span className="text-amber-600 dark:text-amber-400">Prerequisite</span></InfoHint>
                      )}
                      {!entry.prerequisite && entry.oauth && (
                        <span className="text-[var(--adf-ui-text-subtle)]">Sign in{entry.bearerTokenEnvVar ? ` or paste ${entry.bearerTokenEnvVar}` : ''}</span>
                      )}
                      {!entry.prerequisite && !entry.oauth && requiredKeys.length > 0 && (
                        <span className="text-amber-600 dark:text-amber-400 truncate">Needs {requiredKeys.join(', ')}</span>
                      )}
                      {entry.advisory && (
                        <InfoHint tip={entry.advisory}><span className="text-amber-600 dark:text-amber-400">Advisory</span></InfoHint>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>
            {visibleEntries.length === 0 && (
              <p className="text-[10px] text-[var(--adf-ui-text-subtle)] py-4 text-center">No matching servers. Add a custom server below.</p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => { setDraft(blankDraft('custom')); setFilePayloads({}); setAuthArgsText(''); setMode('form') }}
              className="text-left p-2.5 rounded-md border border-dashed border-neutral-300 dark:border-neutral-600 hover:border-blue-400 dark:hover:border-blue-500 transition-colors"
            >
              <span className="text-xs font-medium text-neutral-700 dark:text-neutral-200">Custom server</span>
              <p className="text-[10px] text-neutral-500 dark:text-neutral-400 mt-0.5">npm / PyPI package or a local command (STDIO)</p>
            </button>
            <button
              onClick={() => { setDraft(blankDraft('http')); setFilePayloads({}); setAuthArgsText(''); setMode('form') }}
              className="text-left p-2.5 rounded-md border border-dashed border-neutral-300 dark:border-neutral-600 hover:border-blue-400 dark:hover:border-blue-500 transition-colors"
            >
              <span className="text-xs font-medium text-neutral-700 dark:text-neutral-200">Remote HTTP server</span>
              <p className="text-[10px] text-neutral-500 dark:text-neutral-400 mt-0.5">Streamable HTTP MCP endpoint</p>
            </button>
          </div>
          <p className="text-[9px] text-[var(--adf-ui-text-subtle)]">
            {registryUpdatedAt ? `Registry updated ${registryUpdatedAt} · ` : 'Registry · '}{registryEntries.length} servers{registrySource === 'bundled' ? ' · offline copy' : ''}
          </p>
        </div>
      )}

      {mode === 'form' && draft && checklist && (
        <div className="space-y-4">
          {externallyRemoved && (
            <div className="flex items-start justify-between gap-2 rounded-md border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-2">
              <p className="text-[10px] text-amber-700 dark:text-amber-400">
                This server was removed elsewhere. Saving will re-create it.
              </p>
              <button
                onClick={() => setExternallyRemoved(false)}
                className="shrink-0 text-amber-500 hover:text-amber-700 dark:hover:text-amber-300 text-xs px-1"
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
          )}

          {/* Catalog header: what this is, flags as tooltips, the setup guide one click away */}
          {catalogEntry && (
            <div className="flex items-start gap-2.5">
              <BrandIcon iconKey={catalogEntry.iconKey} category={catalogEntry.category} size={30} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-medium text-neutral-800 dark:text-neutral-100">{catalogEntry.displayName}</span>
                  {!catalogEntry.verified && (
                    <InfoHint tip="Community server, not published by the service it connects to.">
                      <span className="text-[9px] px-1 py-0.5 rounded bg-neutral-100 dark:bg-neutral-700 text-neutral-500 dark:text-neutral-400 font-medium">Community</span>
                    </InfoHint>
                  )}
                  {catalogEntry.advisory && (
                    <InfoHint tip={catalogEntry.advisory}>
                      <span className="text-[9px] px-1 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 font-medium">Advisory</span>
                    </InfoHint>
                  )}
                </div>
                <p className="text-[11px] text-neutral-500 dark:text-neutral-400">{catalogEntry.description}</p>
              </div>
              <DocsLink href={MCP_SETUP_DOCS[catalogEntry.name] ?? DOCS.mcp} label={MCP_SETUP_DOCS[catalogEntry.name] ? 'Setup guide' : 'Docs'} className="!text-[11px] mt-0.5" />
            </div>
          )}

          {/* Location comes first: it decides where the server is installed,
              where credential files land, and what Connect tests. A catalog
              entry already picked the location its setup works in. */}
          {!isHttp && (
            <SetupStep
              n={1}
              title="Location"
              done={(draft.runLocation !== undefined || !!catalogEntry) && !(draft.runLocation === 'host' && hostAccessEnabled === false)}
              hint={onHost ? HOST_BOUNDARY_TEXT : isCustom ? `${CONTAINER_TEXT} ${CONTAINER_CUSTOM_COMMAND_TEXT}` : CONTAINER_TEXT}
              aside={
                <span className="inline-flex items-center gap-3">
                  <DocsLink href={DOCS.mcpRunLocation} />
                  <Segmented
                    tone={onHost ? 'amber' : 'blue'}
                    options={[
                      { label: 'Host', active: onHost, onClick: () => patch({ runLocation: 'host' }) },
                      { label: 'Container', active: !onHost, onClick: () => patch({ runLocation: 'shared' }) },
                    ]}
                  />
                </span>
              }
            >
              {hostByDefault && (
                <p className="text-[10px] text-amber-600 dark:text-amber-400">
                  Host is the default while “MCP servers on the host” is on (Settings → Compute).
                </p>
              )}
              {draft.runLocation === 'host' && hostAccessEnabled === false && (
                <p className="text-[10px] text-amber-600 dark:text-amber-400">
                  Host access is off, so this runs in a container for now.{' '}
                  {onEnableHostAccess && (
                    <button onClick={onEnableHostAccess} className="underline font-medium hover:text-amber-700 dark:hover:text-amber-300">Turn on host access</button>
                  )}
                </p>
              )}
            </SetupStep>
          )}

          {/* What the server needs from you */}
          {showDetailsStep && (
            <SetupStep n={nDetails} title={detailsTitle} done={!!catalogEntry && checklist.inputsDone} hint={catalogEntry?.prerequisite}>
              {!catalogEntry && (
                <>
                  {identityFields}
                  {argsEditor}
                  {isHttp && !registryEntry?.oauth && (
                    <McpHttpOAuthToggle enabled={!!draft.oauth} onChange={(enabled) => patch({ oauth: enabled || undefined })} />
                  )}
                  {isHttp && !isOAuth && (
                    <div>
                      <label className={labelCls}>Bearer token env var</label>
                      <input type="text" value={draft.bearerTokenEnvVar ?? ''} onChange={(e) => patch({ bearerTokenEnvVar: e.target.value })} placeholder="MCP_BEARER_TOKEN" className={inputCls} />
                    </div>
                  )}
                  <div>
                    <label className={labelCls}>Environment variables</label>
                    <div className="space-y-1.5">{envRows(true, false)}</div>
                    {addEnvButton}
                  </div>
                </>
              )}
              {catalogEntry && checklist.placeholderArgs.map((i) => (
                <div key={i}>
                  <label className={labelCls}>{placeholderLabel(catalogEntry.args![i])}</label>
                  <input
                    type="text"
                    value={placeholderValue(i)}
                    onChange={(e) => setPlaceholderValue(i, e.target.value)}
                    placeholder={catalogEntry.args![i]}
                    className={REGISTRY_ARG_PLACEHOLDER_RE.test(draft.args?.[i] ?? '') ? inputAmberCls : inputCls}
                  />
                </div>
              ))}
              {catalogEntry && stepEnvCount > 0 && <div className="space-y-1.5">{envRows(true, true)}</div>}
              {catalogEntry && !isHttp && requiredFiles.map(fileRow)}
              {!catalogEntry && hasPlaceholders && (
                <p className="text-[10px] text-amber-600 dark:text-amber-400">
                  Replace {unresolvedPlaceholders.join(', ')} before connecting.
                </p>
              )}
            </SetupStep>
          )}

          {/* ② Prove it runs (and sign in, when it needs that) */}
          <SetupStep
            n={nConnect}
            title={signsIn ? 'Sign in' : 'Connect'}
            done={checklist.connected}
            hint={`${isOAuth ? 'Opens the provider’s sign-in page in your browser.' : draft.auth ? 'Runs the server’s sign-in command, which opens your browser. The tokens it stores are reused on later runs.' : 'Starts the server once and lists its tools.'}${requiredFiles.length > 0 ? ' Chosen credential files are stored now.' : ''}`}
          >
            {test.phase === 'done' && test.success ? (
              <div className="flex items-center gap-3 text-[11px]">
                <span className="text-green-600 dark:text-green-400 font-medium">
                  {test.oauthRan ? 'Signed in' : 'Connected'} · {test.tools?.length ?? 0} tools{test.location ? ` · ${test.location}` : ''}
                </span>
                {(test.tools?.length ?? 0) > 0 && (
                  <button onClick={() => setShowTools(!showTools)} className="text-[var(--adf-ui-text-subtle)] hover:text-neutral-600 dark:hover:text-neutral-200">
                    {showTools ? 'Hide tools' : 'Show tools'}
                  </button>
                )}
                <button onClick={handleConnect} className="text-[var(--adf-ui-text-subtle)] hover:text-neutral-600 dark:hover:text-neutral-200">Reconnect</button>
              </div>
            ) : draft.lastVerifiedAt && test.phase === 'idle' ? (
              <div className="flex items-center gap-3 text-[11px]">
                <span className="text-green-600 dark:text-green-400 font-medium">Verified {new Date(draft.lastVerifiedAt).toLocaleDateString()}</span>
                <button onClick={handleConnect} disabled={!canLaunch || hasPlaceholders} className="text-[var(--adf-ui-text-subtle)] hover:text-neutral-600 dark:hover:text-neutral-200 disabled:opacity-40">Reconnect</button>
              </div>
            ) : (
              <button
                onClick={handleConnect}
                disabled={!canLaunch || hasPlaceholders || test.phase === 'running'}
                className="px-3 py-1.5 text-xs font-medium rounded-md bg-[var(--adf-ui-accent)] text-[var(--adf-ui-on-accent)] hover:bg-[var(--adf-ui-accent-hover)] disabled:opacity-40"
              >
                {test.phase === 'running' ? connectBusyLabel : connectLabel}
              </button>
            )}
            {showTools && test.success && (
              <p className="text-[10px] font-mono text-neutral-500 dark:text-neutral-400 max-h-32 overflow-y-auto">
                {test.tools?.map((t) => t.name).join(', ')}
              </p>
            )}
            {test.phase === 'done' && !test.success && (
              <div>
                <p className="text-[11px] text-red-500 font-medium">Couldn’t connect{test.location ? ` (${test.location})` : ''}</p>
                {test.error && (
                  <pre className="text-[10px] font-mono text-red-500/90 whitespace-pre-wrap mt-1 max-h-40 overflow-y-auto">{test.error}</pre>
                )}
                {test.stderrTail && test.stderrTail.length > 0 && (
                  <pre className="text-[10px] font-mono text-neutral-500 dark:text-neutral-400 whitespace-pre-wrap mt-1 max-h-32 overflow-y-auto">{test.stderrTail.join('\n')}</pre>
                )}
              </div>
            )}
            {test.phase === 'done' && (test.notes?.length ?? 0) > 0 && (
              <ul className="space-y-0.5">
                {test.notes!.map((n, i) => (
                  <li key={i} className="text-[9px] text-[var(--adf-ui-text-subtle)]">• {n}</li>
                ))}
              </ul>
            )}
          </SetupStep>

          {/* Agent access */}
          <SetupStep
            n={nConnect + 1}
            title="Agent access"
            done={draft.agentVisible !== undefined}
            hint={`On: any agent can find this server and attach it itself. Off: only you can attach it, from an agent’s MCP settings.${draft.agentVisible === undefined ? ` Default for ${isHttp ? 'remote' : onHost ? 'host' : 'container'} servers: ${suggestedAgentVisible(draft) ? 'on' : 'off'}.` : ''}`}
            aside={
              <Segmented
                options={[{ label: 'Off', active: !isRegistrationAgentVisible(draft), onClick: () => patch({ agentVisible: false }) }, { label: 'On', active: isRegistrationAgentVisible(draft), onClick: () => patch({ agentVisible: true }) }]}
              />
            }
          />

          {/* Everything a catalog server already has right */}
          <div className="space-y-2">
            <Disclosure label="Advanced" open={showAdvanced} onToggle={() => setShowAdvanced(!showAdvanced)}>
              {catalogEntry && (
                <>
                  {identityFields}
                  {registrationSourceLine(draft) && (
                    <p className="text-[10px] font-mono text-[var(--adf-ui-text-subtle)] truncate">{registrationSourceLine(draft)}</p>
                  )}
                  {argsEditor}
                  <div>
                    <label className={labelCls}>{isOAuth && tokenEnvKeys.size > 0 ? 'Environment variables (an API token here replaces sign-in)' : 'Environment variables'}</label>
                    {advancedEnvCount > 0 && <div className="space-y-1.5">{envRows(false, false)}</div>}
                    {addEnvButton}
                  </div>
                </>
              )}
              {isHttp && (catalogEntry || isOAuth) && (
                <div>
                  <label className={labelCls}>Bearer token env var</label>
                  <input type="text" value={draft.bearerTokenEnvVar ?? ''} onChange={(e) => patch({ bearerTokenEnvVar: e.target.value })} placeholder="MCP_BEARER_TOKEN" className={inputCls} />
                </div>
              )}
              {isHttp && (
                <>
                  <div>
                    <label className={labelCls}>Headers from environment variables</label>
                    <div className="space-y-1.5">{keyValueRows('headerEnv', 'ENV_VAR')}</div>
                    <button onClick={() => patch({ headerEnv: [...(draft.headerEnv ?? []), { key: '', value: '' }] })} className="text-[11px] text-blue-500 hover:text-blue-700 font-medium">+ Add header</button>
                  </div>
                  <div>
                    <label className={labelCls}>Static headers</label>
                    <div className="space-y-1.5">{keyValueRows('headers', 'Value')}</div>
                    <button onClick={() => patch({ headers: [...(draft.headers ?? []), { key: '', value: '' }] })} className="text-[11px] text-blue-500 hover:text-blue-700 font-medium">+ Add header</button>
                  </div>
                </>
              )}
              {!isHttp && optionalFiles.length > 0 && (
                <div className="space-y-1.5">
                  <label className={labelCls}>Other credential files</label>
                  {optionalFiles.map(fileRow)}
                </div>
              )}
              {authSection}
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
              {catalogEntry?.repo && <DocsLink href={catalogEntry.repo} label="Source" className="!text-[11px]" />}
            </Disclosure>

            {/* Per-agent credential storage (edit mode: the registration exists).
                OAuth-only servers have no per-agent keys to fill. */}
            {editing && !(isOAuth && !isDualMode) && (
              <Disclosure label="Per-agent keys" open={showAgentKeys} onToggle={() => setShowAgentKeys(!showAgentKeys)}>
                <McpCredentialPanel server={draft} registryEntry={registryEntry} onServerUpdate={patch} showOAuthNote={false} />
              </Disclosure>
            )}

            {/* Logs (edit mode: the server has a run history worth showing) */}
            {editing && (
              <Disclosure label="Logs" open={showLogs} onToggle={handleToggleLogs}>
                <McpServerLogs
                  logs={logEntries ?? []}
                  serverName={draft.name}
                  onClose={() => setShowLogs(false)}
                />
              </Disclosure>
            )}
          </div>

          {/* Footer: Done once verified; saving unverified stays possible but quiet */}
          <div className="flex items-center justify-between pt-1">
            <div>
              {!editing && !externallyRemoved && (
                <button onClick={() => { setMode('choose'); setDraft(null); setFilePayloads({}); setTest({ phase: 'idle' }) }} className="text-[11px] text-[var(--adf-ui-text-subtle)] hover:text-neutral-600 dark:hover:text-neutral-200">
                  ← Back
                </button>
              )}
              {editing && onRemove && (
                <button
                  onClick={() => { onRemove(draft.id); onClose() }}
                  className="text-[11px] text-red-400 hover:text-red-600"
                >
                  Remove server
                </button>
              )}
            </div>
            {draft.lastVerifiedAt ? (
              <button
                onClick={handleSave}
                disabled={!canLaunch || hasPlaceholders}
                className="px-4 py-1.5 text-xs font-medium rounded-md bg-[var(--adf-ui-accent)] text-[var(--adf-ui-on-accent)] hover:bg-[var(--adf-ui-accent-hover)] disabled:opacity-40"
              >
                Done
              </button>
            ) : (
              <Tooltip tip={saveTip}>
                <button
                  onClick={handleSave}
                  disabled={!canLaunch || hasPlaceholders || hasPendingRequiredCreds}
                  className="px-3 py-1.5 text-xs rounded-md border border-[var(--adf-ui-border)] text-[var(--adf-ui-text)] hover:bg-[var(--adf-ui-surface-hover)] disabled:opacity-40"
                >
                  Save without connecting
                </button>
              </Tooltip>
            )}
          </div>
        </div>
      )}
    </Dialog>
  )
}

/** One numbered setup step: a ✓ replaces the number once it's done. */
function SetupStep({ n, title, done, hint, aside, children }: {
  n: number
  title: string
  done: boolean
  hint?: string
  aside?: ReactNode
  children?: ReactNode
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <span
          className={`w-[18px] h-[18px] shrink-0 rounded-full text-[10px] font-semibold flex items-center justify-center ${done
            ? 'bg-green-500 text-white'
            : 'border border-[var(--adf-ui-border)] text-[var(--adf-ui-text-subtle)]'}`}
          aria-label={done ? `Step ${n} done` : `Step ${n}`}
        >
          {done ? '✓' : n}
        </span>
        <span className="text-xs font-medium text-neutral-800 dark:text-neutral-100 inline-flex items-center">
          {title}
          {hint && <InfoHint tip={hint} />}
        </span>
        {aside && <span className="ml-auto">{aside}</span>}
      </div>
      {children && <div className="pl-[26px] space-y-2">{children}</div>}
    </section>
  )
}

/** A small two-way switch. */
function Segmented({ options, tone = 'blue' }: {
  options: { label: string; active: boolean; onClick: () => void }[]
  tone?: 'blue' | 'amber'
}) {
  const activeCls = tone === 'amber'
    ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300 font-medium'
    : 'bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300 font-medium'
  return (
    <div className="inline-flex gap-0.5 rounded-md border border-neutral-300 dark:border-neutral-600 p-0.5">
      {options.map((o) => (
        <button
          key={o.label}
          onClick={o.onClick}
          className={`px-2 py-0.5 text-[11px] rounded ${o.active ? activeCls : 'text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-700'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Disclosure({ label, open, onToggle, children }: {
  label: string
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <div>
      <button
        onClick={onToggle}
        className="flex items-center gap-1 text-xs text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 font-medium"
      >
        <span className={`inline-block transition-transform text-[9px] ${open ? 'rotate-90' : ''}`}>▶</span>
        {label}
      </button>
      {open && <div className="mt-2 space-y-3">{children}</div>}
    </div>
  )
}
