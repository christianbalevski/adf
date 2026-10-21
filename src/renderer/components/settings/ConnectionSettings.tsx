/**
 * Settings → Studio → Connections (docs/design/settings-scopes.md §5,
 * docs/design/multi-runtime.md §6.5): the runtimes Studio connects to. With
 * no runtime on another computer saved it is one line, "Runtimes on other
 * computers", with Add (SimpleConnections). Otherwise one list: This
 * computer, Inside Studio (legacy) while it runs or is saved, the saved
 * connections (shared with `adf`: cli-remotes.json and the OS keychain), each
 * connected while it is saved and shown with its state, and the computers
 * found on the network that are not saved, each with Add. Remove is in a
 * saved row's More menu: it disconnects and forgets.
 *
 * Add is one dialog for a typed address and a found computer: the code, or a
 * token. On success the connection is saved and connects; there is no
 * Connect step. No token ever reaches the renderer.
 *
 * This computer and Inside Studio (legacy) are whole-Studio modes: choosing
 * one saves it for the next launch (multi-runtime.md §7.2). Nothing restarts
 * unless the owner presses Restart.
 */

import { useEffect, useRef, useState } from 'react'
import { Button, IconButton, SettingsGroup, SettingsRow, Switch, TextInput } from '../ui'
import { useSettingsSave } from './settings-save'
import { Dialog } from '../common/Dialog'
import { useConfirm, type ConfirmOptions } from '../common/ConfirmDialog'
import { Tooltip } from '../common/Tooltip'
import { RemoteMark } from '../common/RemoteMark'
import { LOCAL_LABEL } from '../../../shared/runtime-name'
import { DocsLink } from '../common/DocsLink'
import { DOCS } from '../../../shared/constants/docs-links'
import { checkRemoteDaemonUrl } from '../../../shared/utils/remote-backend-url'
import { CONNECTION_STATE_LABELS, type ConnectionResult, type ConnectionRow, type ConnectionsView } from '../../../shared/types/connection.types'
import type { BackendDaemonStatus, BackendSettingsView, StudioRunMode } from '../../../shared/types/backend.types'
import type { RemotePairErrorCode, RemotePairStartRequest, RemotePairState } from '../../../shared/types/remote-access-ipc.types'
import { pairMessage } from './RemoteAccessSettings'
import type { RemoteDiscoveryEntry } from '../../../shared/types/remote-access-ipc.types'
import { remoteConnectionsSaved, startConnectionFeed, useConnectionStore } from '../../stores/connection.store'

/** The modes as users see them. Inside Studio is the legacy backend, kept for this release only. */
const MODE_LABELS: Record<StudioRunMode, string> = {
  embedded: 'Inside Studio (legacy)',
  local: LOCAL_LABEL,
}

/** A "Learn more" link to the guide after a row's one-sentence description. */
function LearnMore({ href }: { href: string }) {
  return <DocsLink href={href} label="Learn more" className="ml-1.5 !text-[11px]" />
}

/** Technical detail kept off a status line: a native disclosure, closed by default. */
function Details({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null
  return (
    <details className="mt-1 text-[11px] text-[var(--adf-ui-text-subtle)]">
      <summary className="cursor-pointer select-none">Details</summary>
      <ul className="mt-1 space-y-0.5 break-all">
        {lines.map((line) => <li key={line}>{line}</li>)}
      </ul>
    </details>
  )
}

/** The launch that moved this install off Embedded to the new default (W5-I), in one line; what moved is under Details. */
export function defaultSwitchLine(record: NonNullable<BackendSettingsView['defaultSwitch']>): string {
  const when = Number.isNaN(Date.parse(record.at)) ? record.at : new Date(record.at).toLocaleString()
  return `On ${when}, Studio${record.version ? ` ${record.version}` : ''} moved agents from inside Studio to this computer.`
}

/** "Default changed": what moved (under Details) and what was not done then (inline: a problem is never hidden). */
export function defaultSwitchDetails(record: NonNullable<BackendSettingsView['defaultSwitch']>): { moved: string; notDone: string | null } {
  return {
    moved: `Moved: ${record.moved.length > 0 ? record.moved.join(', ') : 'nothing'}.`,
    notDone: record.notDone.length > 0 ? `Not done then, retried at each start: ${record.notDone.join(' ')}` : null,
  }
}

const DAEMON_LABELS: Record<BackendDaemonStatus['connection'], string> = {
  connecting: CONNECTION_STATE_LABELS.connecting,
  connected: CONNECTION_STATE_LABELS.connected,
  disconnected: CONNECTION_STATE_LABELS.retrying,
  failed: CONNECTION_STATE_LABELS['not-connected'],
}

/**
 * This computer's daemon, terse: connection, pid, who started it. A key the
 * owner does not trust stays on the line (it needs an action); the URL,
 * version and a trusted key are under Details (daemonDetails). Shown only
 * while This computer is in use.
 */
export function daemonLine(daemon: BackendDaemonStatus): string {
  const parts = [daemon.progress ?? DAEMON_LABELS[daemon.connection]]
  if (daemon.pid) parts.push(`pid ${daemon.pid}`)
  if (daemon.startedBy) parts.push(daemon.how === 'spawned' ? 'started by this Studio' : `started by ${daemon.startedBy === 'studio' ? 'Studio' : daemon.startedBy === 'cli' ? 'the ADF CLI' : 'a service'}`)
  // K12 (no OS keychain): the owner's trust in the daemon's key, set with adf identity trust-daemon.
  if (daemon.trust?.state === 'not-trusted') parts.push('daemon key not trusted')
  return parts.join(' · ')
}

/** The daemon row's Details: URL, version, the key's trust and how to set it, a missing local proof. */
export function daemonDetails(daemon: BackendDaemonStatus): string[] {
  const lines: string[] = []
  if (daemon.url) lines.push(`URL: ${daemon.url}`)
  if (daemon.version) lines.push(`Version: ${daemon.version}`)
  if (daemon.trust?.state === 'trusted') lines.push('Daemon key: trusted by the owner')
  if (daemon.trust?.state === 'not-trusted') lines.push('Daemon key: trust it with adf identity trust-daemon')
  if (daemon.localProof && !daemon.localProof.available) lines.push(`Local proof: unavailable (${daemon.localProof.problem ?? 'unknown reason'})`)
  return lines
}

/** A launch that runs another connection than the saved one says why (ADF_STUDIO_BACKEND, one session). */
export function overrideLine(view: BackendSettingsView): string | null {
  const running = MODE_LABELS[view.active.mode]
  if (view.active.source === 'env') return `${running} because ADF_STUDIO_BACKEND is set.`
  if (view.active.source === 'session') return view.active.sessionReason ? `${running} for this session only: ${view.active.sessionReason}` : `${running} for this session only.`
  return null
}

/** The mode saved for the next launch differs from the running one, outside a one-launch override (multi-runtime.md §7.2). */
export function nextLaunchLine(view: BackendSettingsView, next: ConnectionsView['next']): string | null {
  if (!next || view.active.source === 'env' || view.active.source === 'session') return null
  return `Next launch: ${next.name}.`
}

/** A row's detail line: the address and fingerprint, and "Pairing open". */
export function connectionDetail(row: ConnectionRow): string | null {
  const parts = [row.address, row.fingerprint].filter((p): p is string => !!p)
  if (row.pairingOpen && row.action === 'pair') parts.push('Pairing open')
  return parts.length > 0 ? parts.join(' · ') : null
}

export interface RowMenuItem { label: string; onSelect: () => void; danger?: boolean }

/** The row's More menu (⋯): Remove, and Inside Studio (legacy) on the Local row. */
function RowMenu({ items, disabled }: { items: RowMenuItem[]; disabled: boolean }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  if (items.length === 0) return null
  return (
    <div ref={ref} className="relative">
      <IconButton aria-label="More" aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen((o) => !o)}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
      </IconButton>
      {open && (
        <div role="menu" className="absolute right-0 z-10 mt-1 min-w-[180px] rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] bg-[var(--adf-ui-surface)] py-1 shadow-lg">
          {items.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              className={`block w-full px-3 py-1.5 text-left text-[12px] hover:bg-[var(--adf-ui-surface-hover)] ${item.danger ? 'text-[var(--adf-ui-danger)]' : 'text-[var(--adf-ui-text)]'}`}
              onClick={() => { setOpen(false); item.onSelect() }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Under the list while the network search runs and found nothing to pair or connect to. */
export function emptyDiscoveryLine(view: Pick<ConnectionsView, 'rows' | 'discovery'>): string | null {
  if (!view.discovery || view.discovery.problem) return null
  return view.rows.some((r) => r.kind === 'found' || r.kind === 'saved') ? null : 'None found yet; turn on Remote access on the other computer.'
}

/** The list (static markup in tests): name, state, detail, one action, the More menu. */
export function ConnectionRows({ rows, busy, onConnect, onAdd, onRemove }: {
  rows: ConnectionRow[]
  busy: boolean
  onConnect: (id: string) => void
  /** A computer found on the network: the Add dialog, on its address. */
  onAdd: (row: ConnectionRow) => void
  onRemove: (id: string) => void
}) {
  const legacyRow = rows.some((r) => r.kind === 'embedded')
  return (
    <ul className="divide-y divide-[var(--adf-ui-separator)]">
      {rows.map((row) => {
        const detail = connectionDetail(row)
        const menu: RowMenuItem[] = []
        if (row.removable) menu.push({ label: 'Remove', onSelect: () => onRemove(row.id), danger: true })
        if (row.kind === 'local' && !legacyRow) menu.push({ label: 'Inside Studio (legacy)', onSelect: () => onConnect('embedded') })
        return (
          <li key={row.id} className="flex items-center justify-between gap-3 px-4 py-2.5" data-connection={row.id}>
            <div className="min-w-0 text-[12px]">
              <div className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-[var(--adf-ui-text)]">
                {row.kind === 'saved' ? <span className="flex items-center gap-1.5"><RemoteMark />{row.name}</span> : row.name}
                {row.state && (
                  <span className={`text-[11px] font-normal ${row.state === 'connected' ? 'text-[var(--adf-ui-accent)]' : row.state === 'retrying' || row.state === 'not-connected' ? 'text-[var(--adf-ui-danger)]' : 'text-[var(--adf-ui-text-muted)]'}`}>
                    {CONNECTION_STATE_LABELS[row.state]}
                  </span>
                )}
                {(row.kind === 'saved' || row.kind === 'found') && !row.encrypted && (
                  <span className="rounded bg-[var(--adf-ui-warning-subtle)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--adf-ui-text)]">Not encrypted</span>
                )}
              </div>
              {detail && <div className="break-all text-[var(--adf-ui-text-muted)]">{detail}</div>}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {row.action === 'connect' && <Button size="compact" disabled={busy} onClick={() => onConnect(row.id)}>Connect</Button>}
              {row.action === 'pair' && <Button size="compact" variant="primary" disabled={busy} onClick={() => onAdd(row)}>Add</Button>}
              <RowMenu items={menu} disabled={busy} />
            </div>
          </li>
        )
      })}
    </ul>
  )
}

function MessageLine({ message }: { message: { kind: 'ok' | 'error'; text: string } | null }) {
  if (!message) return null
  return (
    <span role="status" className={`text-[12px] ${message.kind === 'error' ? 'text-[var(--adf-ui-danger)]' : 'text-[var(--adf-ui-text-muted)]'}`}>
      {message.text}
    </span>
  )
}

/** Codes after which the host answered as a daemon without a fingerprint: a token is the only way. */
const TOKEN_ONLY: ReadonlySet<RemotePairErrorCode> = new Set(['remote_access_off', 'old_daemon'])

/**
 * Start pairing; a computer already saved (`already_saved`) is paired again
 * only after Replace in the shared confirmation, which replaces its address
 * and token. Null when the user kept it (nothing was sent).
 */
export async function startPairing(start: (request: RemotePairStartRequest) => Promise<RemotePairState>, confirm: (options: ConfirmOptions) => Promise<boolean>, request: RemotePairStartRequest): Promise<RemotePairState | null> {
  const state = await start(request)
  if (state.code !== 'already_saved') return state
  if (!await confirm({ title: 'Replace', body: state.message, confirmLabel: 'Replace', danger: true })) return null
  return start({ ...request, replace: true })
}

/** A computer found on the network, as the Add dialog opens on it. */
export type AddTarget = Pick<RemoteDiscoveryEntry, 'name' | 'url' | 'address' | 'fingerprint' | 'encrypted'>

/** The found computer answered as another one: nothing is sent to it. */
export function foundMismatchMessage(found: AddTarget, shown: string): string {
  return `${found.address} now answers as another computer (${shown}). Add it from the list again.`
}

/**
 * Add (settings-scopes.md §5.3, multi-runtime.md §6.5): Address, Next
 * (hello), then the code, or a token. Without a hello the token is the only
 * way, and the connection has no fingerprint. Opened on a found computer,
 * the address is its own and the hello must show its fingerprint. On
 * success the connection is saved and connects: Done is the only button.
 */
export function AddConnectionDialog({ onClose, found = null }: { onClose: () => void; found?: AddTarget | null }) {
  const [url, setUrl] = useState(found?.url ?? '')
  const [trusted, setTrusted] = useState(false)
  const [step, setStep] = useState<'address' | 'code' | 'token' | 'done'>('address')
  const [pair, setPair] = useState<RemotePairState | null>(null)
  const [code, setCode] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [noFingerprint, setNoFingerprint] = useState(false)
  const [confirmDialog, confirm] = useConfirm()
  const check = url.trim() ? checkRemoteDaemonUrl(url) : null
  const insecure = check?.kind === 'insecure-http'

  useEffect(() => window.adfApi?.onRemotePairingState?.((next) => {
    if (step !== 'code' || (next.host && check?.url && next.host.url !== check.url)) return
    setPair(next)
    if (next.step === 'paired') setStep('done')
    setMessage(pairMessage(next, next.host?.name ?? ''))
  }), [step, check?.url])

  const next = async () => {
    if (!check?.url) return
    setBusy(true)
    setMessage(null)
    try {
      const state = await startPairing((request) => window.adfApi.startRemotePairing(request), confirm, { url: check.url, allowInsecureHttp: insecure && trusted })
      if (!state) return
      if (found && state.host && state.host.fingerprint !== found.fingerprint) {
        await window.adfApi.cancelRemotePairing()
        setMessage({ kind: 'error', text: foundMismatchMessage(found, state.host.fingerprint) })
        return
      }
      setPair(state)
      if (state.step === 'need_code' && !state.code) { setStep('code'); setMessage(state.message ? { kind: 'ok', text: state.message } : null); return }
      if (state.code && TOKEN_ONLY.has(state.code)) { setNoFingerprint(true); setStep('token'); return }
      setMessage(pairMessage(state, state.host?.name ?? ''))
    } finally {
      setBusy(false)
    }
  }
  const sendCode = async () => {
    setBusy(true)
    try {
      const state = await window.adfApi.submitRemotePairingCode(code.replace(/\s/g, ''))
      setPair(state)
      setMessage(pairMessage(state, state.host?.name ?? ''))
    } finally {
      setBusy(false)
    }
  }
  const saveToken = async () => {
    if (!check?.url) return
    setBusy(true)
    setMessage(null)
    try {
      const result: ConnectionResult = await window.adfApi.addConnection({ url: check.url, token, allowInsecureHttp: insecure && trusted })
      if (result.ok) { setStep('done'); setMessage({ kind: 'ok', text: result.notices.join(' ') }) }
      else if (result.code !== 'cancelled') setMessage({ kind: 'error', text: result.error })
    } finally {
      setBusy(false)
    }
  }
  const close = () => {
    if (step === 'code') void window.adfApi.cancelRemotePairing()
    onClose()
  }
  const waiting = pair?.step === 'claiming' || pair?.step === 'waiting'

  return (
    <Dialog open title="Add" onClose={close} lightDismiss={false}>
      {confirmDialog}
      <div className="space-y-3 text-[12px]">
        {step === 'address' && (
          <>
            {found && <p className="text-[var(--adf-ui-text-muted)]">{found.name} at {found.address}, fingerprint {found.fingerprint}.</p>}
            <label className="block space-y-1">
              <span className="text-[var(--adf-ui-text)]">Address</span>
              <TextInput value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://adf.example.com" spellCheck={false} autoComplete="off" aria-label="Address" autoFocus />
            </label>
            {check?.kind === 'invalid' && <p className="text-[var(--adf-ui-danger)]">{check.reason}</p>}
            {insecure && (
              <label className="flex items-center gap-2 cursor-pointer text-[var(--adf-ui-text-muted)]">
                <input type="checkbox" checked={trusted} onChange={(e) => setTrusted(e.target.checked)} className="rounded text-blue-500" />
                I trust this network; the token is sent unencrypted.
              </label>
            )}
          </>
        )}
        {step === 'code' && pair?.host && (
          <>
            <p className="text-[var(--adf-ui-text-muted)]">Check that {pair.host.name} shows fingerprint {pair.host.fingerprint}.</p>
            <label className="block space-y-1">
              <span className="text-[var(--adf-ui-text)]">Code</span>
              <TextInput value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" maxLength={7} placeholder="123 456" disabled={waiting} aria-label="Pairing code" className="font-mono text-[18px] tracking-[0.2em]" />
            </label>
            <button type="button" className="text-[var(--adf-ui-accent)] hover:underline" disabled={waiting} onClick={() => { void window.adfApi.cancelRemotePairing(); setMessage(null); setStep('token') }}>Use a token instead</button>
          </>
        )}
        {step === 'token' && (
          <>
            {noFingerprint && <p className="text-[var(--adf-ui-text-muted)]">No fingerprint; identity not checked.</p>}
            <label className="block space-y-1">
              <span className="text-[var(--adf-ui-text)]">Token</span>
              <TextInput type="password" value={token} onChange={(e) => setToken(e.target.value)} spellCheck={false} autoComplete="off" aria-label="Token" autoFocus />
            </label>
          </>
        )}
        <MessageLine message={message} />
        <div className="flex justify-end gap-2 pt-1">
          {step === 'done' ? (
            <Button variant="primary" onClick={onClose}>Done</Button>
          ) : (
            <>
              <Button onClick={close}>Cancel</Button>
              {step === 'address' && <Button variant="primary" disabled={!check?.url || (insecure && !trusted)} loading={busy} onClick={() => void next()}>Next</Button>}
              {step === 'address' && message && <Button disabled={!check?.url || (insecure && !trusted)} onClick={() => { setMessage(null); setStep('token') }}>Use a token instead</Button>}
              {step === 'code' && <Button variant="primary" disabled={code.replace(/\s/g, '').length !== 6} loading={busy || waiting} onClick={() => void sendCode()}>Pair</Button>}
              {step === 'token' && <Button variant="primary" disabled={!token.trim()} loading={busy} onClick={() => void saveToken()}>Save</Button>}
            </>
          )}
        </div>
      </div>
    </Dialog>
  )
}

/**
 * Connections with no runtime on another computer saved: one line and Add
 * (the existing pairing flow). This computer's daemon, Background and Inside
 * Studio (legacy) stay one click away under Details.
 */
export function SimpleConnections({ busy, message, onAdd, onLegacy, details, extra }: {
  busy: boolean
  message: { kind: 'ok' | 'error'; text: string } | null
  onAdd: () => void
  onLegacy: () => void
  details: React.ReactNode
  extra?: React.ReactNode
}) {
  return (
    <SettingsGroup>
      <SettingsRow label={<Tooltip tip="Runtimes on other computers."><span>Remotes</span></Tooltip>} error={message?.kind === 'error' ? message.text : undefined} help={message?.kind === 'ok' ? message.text : undefined}>
        <Button disabled={busy} onClick={onAdd}>Add</Button>
      </SettingsRow>
      {extra}
      <details className="border-t border-[var(--adf-ui-separator)]">
        <summary className="cursor-pointer select-none px-4 py-2.5 text-[12px] text-[var(--adf-ui-text-muted)]">Details</summary>
        {details}
        <SettingsRow separator label="Inside Studio (legacy)" description="Agents run inside Studio; removed in the next release.">
          <Button size="compact" disabled={busy} onClick={onLegacy}>Connect</Button>
        </SettingsRow>
      </details>
    </SettingsGroup>
  )
}

export function ConnectionSettings() {
  const view = useConnectionStore((s) => s.view)
  const [backend, setBackend] = useState<BackendSettingsView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  // The Add dialog: on a typed address (true) or on a found computer.
  const [adding, setAdding] = useState<AddTarget | true | null>(null)
  const { track } = useSettingsSave()

  useEffect(() => {
    startConnectionFeed()
    let cancelled = false
    window.adfApi?.getBackendSettings()
      .then((next) => { if (!cancelled) setBackend(next) })
      .catch(() => { if (!cancelled) setLoadError('Could not read the connection settings.') })
    return () => { cancelled = true }
  }, [])

  // No remote saved: the page is one line with Add, and nothing searches the network.
  const simple = !!view && view.current.kind === 'local' && !remoteConnectionsSaved(view)
  // The Not paired rows: this computer's network search, while the full list is open.
  const listing = !!view && !simple
  useEffect(() => {
    if (!listing) return
    void window.adfApi?.startRemoteDiscovery?.().catch(() => {})
    return () => { void window.adfApi?.stopRemoteDiscovery?.().catch(() => {}) }
  }, [listing])

  // While the daemon connects, follow it.
  const daemonState = backend?.daemon?.connection
  useEffect(() => {
    if (daemonState !== 'connecting' && daemonState !== 'disconnected') return
    const timer = setInterval(() => {
      window.adfApi?.getBackendSettings().then(setBackend).catch(() => {})
    }, 1500)
    return () => clearInterval(timer)
  }, [daemonState])

  const run = async (fn: () => Promise<ConnectionResult>) => {
    setBusy(true)
    setMessage(null)
    try {
      const result = await fn()
      if (result.ok) {
        useConnectionStore.getState().setView(result.view)
        if (result.notices.length > 0) setMessage({ kind: 'ok', text: result.notices.join(' ') })
      } else if (result.code !== 'cancelled') {
        setMessage({ kind: 'error', text: result.error })
      }
      window.adfApi?.getBackendSettings().then(setBackend).catch(() => {})
    } catch {
      setMessage({ kind: 'error', text: 'Studio could not change the connection.' })
    } finally {
      setBusy(false)
    }
  }
  const connect = (id: string) => void run(() => window.adfApi.useConnection(id))
  const remove = (id: string) => void run(() => window.adfApi.removeConnection(id))

  /** The one setting on this page: written at once, "Saved" in the header, put back on a refusal. */
  const saveKeepRunning = (next: boolean) => {
    if (!backend) return
    const prev = backend
    setBackend({ ...backend, configured: { ...backend.configured, keepDaemonRunning: next } })
    void track(window.adfApi.setBackendSettings({ keepDaemonRunning: next }).then((result) => {
      if (!result.ok) return { ok: false as const, error: result.error }
      setBackend(result.view)
      if (result.notices.length > 0) setMessage({ kind: 'ok', text: result.notices.join(' ') })
      return { ok: true as const }
    }), () => setBackend(prev))
  }

  if (!view || !backend) {
    return (
      <SettingsGroup title="Connections">
        <SettingsRow label={loadError ?? 'Loading…'} />
      </SettingsGroup>
    )
  }

  const local = view.current.kind === 'local'
  const override = overrideLine(backend)
  const nextLine = nextLaunchLine(backend, view.next)

  /** The launch that moved this install off Inside Studio. */
  const switchRows = <>
    {backend.defaultSwitch && (
      <SettingsRow
        separator
        label="Default changed"
        description={<>{defaultSwitchLine(backend.defaultSwitch)}<LearnMore href={DOCS.backendUpgrade} /></>}
        help={<>
          {defaultSwitchDetails(backend.defaultSwitch).notDone}
          <Details lines={[defaultSwitchDetails(backend.defaultSwitch).moved]} />
        </>}
      />
    )}
  </>

  /** This computer's daemon and Background: only while it is the runtime in use (settings-scopes.md §7). */
  const thisComputerRows = <>
    {backend.daemon && (
      <SettingsRow
        label="Daemon"
        description={<>{daemonLine(backend.daemon)}<LearnMore href={DOCS.backendStatus} /></>}
        help={backend.daemon.message || daemonDetails(backend.daemon).length > 0 ? <>
          {backend.daemon.message}
          <Details lines={daemonDetails(backend.daemon)} />
        </> : undefined}
        error={[
          backend.daemon.localProof && !backend.daemon.localProof.available
            ? 'Reveal and identity import are refused. Fix the permissions of the daemon\'s data folder, then restart the daemon.'
            : null,
          backend.daemon.keychainProblem,
        ].filter(Boolean).join(' ') || undefined}
      />
    )}
    <SettingsRow
      separator={!!backend.daemon}
      label="Background"
      description={<>Agents on this computer keep running after you quit Studio.<LearnMore href={DOCS.backendQuit} /></>}
    >
      <Switch label="Background" checked={backend.configured.keepDaemonRunning} disabled={busy} onChange={saveKeepRunning} />
    </SettingsRow>
  </>

  const notices = <>
    {(backend.active.notices.length > 0 || override) && (
      <div role="status" className="mb-3 rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-warning)]/30 bg-[var(--adf-ui-warning-subtle)] px-3 py-2 text-[12px] text-[var(--adf-ui-text)]">
        {override && <p>{override}</p>}
        {backend.active.notices.map((notice) => <p key={notice}>{notice}</p>)}
      </div>
    )}
    {nextLine && (
      <div role="status" className="mb-3 flex items-center justify-between gap-3 rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] px-3 py-2 text-[12px] text-[var(--adf-ui-text)]">
        <span>{nextLine}</span>
        <Button size="compact" onClick={() => void window.adfApi.restartStudio()}>Restart</Button>
      </div>
    )}
  </>

  if (simple) {
    return (
      <>
        {notices}
        <SimpleConnections
          busy={busy}
          message={message}
          onAdd={() => setAdding(true)}
          onLegacy={() => connect('embedded')}
          details={thisComputerRows}
          extra={switchRows}
        />
        {adding && <AddConnectionDialog onClose={() => setAdding(null)} found={adding === true ? null : adding} />}
      </>
    )
  }

  return (
    <>
      {notices}

      <SettingsGroup title="Runtimes" docs={DOCS.backendConnection}>
        <ConnectionRows rows={view.rows} busy={busy} onConnect={connect} onAdd={(row) => row.url && row.fingerprint && setAdding({ name: row.name, url: row.url, address: row.address ?? row.url, fingerprint: row.fingerprint, encrypted: row.encrypted })} onRemove={remove} />
        {view.discovery?.problem && <p className="border-t border-[var(--adf-ui-separator)] px-4 py-2 text-[11px] text-[var(--adf-ui-text-subtle)]">{view.discovery.problem}</p>}
        {emptyDiscoveryLine(view) && <p className="border-t border-[var(--adf-ui-separator)] px-4 py-2 text-[11px] text-[var(--adf-ui-text-subtle)]">{emptyDiscoveryLine(view)}</p>}
        <div className="flex items-center justify-between gap-4 border-t border-[var(--adf-ui-separator)] px-4 py-3">
          <MessageLine message={message} />
          <Button disabled={busy} onClick={() => setAdding(true)}>Add</Button>
        </div>
        {switchRows}
      </SettingsGroup>

      {local && <SettingsGroup title={view.rows.find((r) => r.kind === 'local')?.name ?? LOCAL_LABEL}>{thisComputerRows}</SettingsGroup>}

      {adding && <AddConnectionDialog onClose={() => setAdding(null)} found={adding === true ? null : adding} />}
    </>
  )
}
