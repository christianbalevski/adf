/**
 * Settings → Studio → Connections (docs/design/settings-scopes.md §5,
 * docs/design/multi-runtime.md §6.5): one **Add** and two lists.
 *
 * - **Remotes**: the runtimes this Studio uses. With none on another
 *   computer saved it is "None." (SimpleConnections). Otherwise This
 *   computer, Inside Studio (legacy) while it runs or is saved, and the
 *   saved connections (shared with `adf`: cli-remotes.json and the OS
 *   keychain), each connected while it is saved and shown with its state.
 *   Remove is in a saved row's More menu: it disconnects and forgets.
 * - **Devices**: the computers using this runtime, each with Revoke, and
 *   the Remote access switch (RemoteAccessSettings.tsx DevicesGroup).
 *
 * Add opens one dialog with two choices. **Connect** (this Studio uses a
 * remote): the computers found on the network, or a typed address, then
 * the code; a token under Details. On success the connection is saved and
 * connects. **Share** (another computer uses this runtime): consent inline,
 * the addresses, the pairing code (RemoteAccessSettings.tsx SharePanel).
 * No token of a connection ever reaches the renderer.
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
import { DevicesGroup, SharePanel, pairMessage } from './RemoteAccessSettings'
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

/** Under Connect's list while the network search runs and found nothing to pair with. */
export function emptyDiscoveryLine(view: Pick<ConnectionsView, 'rows' | 'discovery'>): string | null {
  if (!view.discovery || view.discovery.problem) return null
  return view.rows.some((r) => r.kind === 'found') ? null : 'None found yet. On the other computer: Add, then Share.'
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

/** A computer found on the network, as Connect lists it. */
export type AddTarget = Pick<RemoteDiscoveryEntry, 'name' | 'url' | 'address' | 'fingerprint' | 'encrypted'> & { pairingOpen?: boolean }

/** The found computer answered as another one: nothing is sent to it. */
export function foundMismatchMessage(found: AddTarget, shown: string): string {
  return `${found.address} now answers as another computer (${shown}). Add it from the list again.`
}

/** Connect's list: the Not paired rows of this computer's network search. */
export function foundTargets(rows: ConnectionRow[]): AddTarget[] {
  return rows
    .filter((r) => r.kind === 'found' && !!r.url && !!r.fingerprint)
    .map((r) => ({ name: r.name, url: r.url!, address: r.address ?? r.url!, fingerprint: r.fingerprint!, encrypted: r.encrypted, pairingOpen: r.pairingOpen }))
}

/** The computers found (static in tests): pick one, or type an address below. */
export function FoundList({ targets, selected, disabled, onPick }: { targets: AddTarget[]; selected: string | null; disabled: boolean; onPick: (target: AddTarget) => void }) {
  if (targets.length === 0) return null
  return (
    <ul aria-label="Found" className="divide-y divide-[var(--adf-ui-separator)] rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)]">
      {targets.map((t) => (
        <li key={`${t.fingerprint}@${t.url}`}>
          <button
            type="button"
            disabled={disabled}
            aria-pressed={selected === t.url}
            onClick={() => onPick(t)}
            className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left ${selected === t.url ? 'bg-[var(--adf-ui-accent-subtle)]' : 'hover:bg-[var(--adf-ui-surface-hover)]'}`}
          >
            <span className="min-w-0">
              <span className="block text-[13px] font-medium text-[var(--adf-ui-text)]">{t.name}</span>
              <span className="block break-all text-[11px] text-[var(--adf-ui-text-muted)]">{[t.address, t.fingerprint, t.pairingOpen ? 'Pairing open' : null].filter(Boolean).join(' · ')}</span>
            </span>
            {!t.encrypted && <span className="shrink-0 rounded bg-[var(--adf-ui-warning-subtle)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--adf-ui-text)]">Not encrypted</span>}
          </button>
        </li>
      ))}
    </ul>
  )
}

/**
 * Add → Connect (settings-scopes.md §5.3, multi-runtime.md §6.5): a
 * computer found on the network, or an Address; Next (hello), then the
 * code. A token is under Details. Without a hello the token is the only
 * way, and the connection has no fingerprint. On a found computer the hello
 * must show its fingerprint. On success the connection is saved and
 * connects: Done is the only button.
 */
export function AddConnectionDialog({ onClose, onBack, found: initialFound = null }: { onClose: () => void; onBack?: () => void; found?: AddTarget | null }) {
  const rows = useConnectionStore((s) => s.view?.rows ?? null)
  const search = useConnectionStore((s) => s.view?.discovery ?? null)
  const targets = foundTargets(rows ?? [])
  const [found, setFound] = useState<AddTarget | null>(initialFound)
  const [url, setUrl] = useState(initialFound?.url ?? '')
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
  const empty = rows ? emptyDiscoveryLine({ rows, discovery: search }) : null

  // This computer's network search, while Connect is open.
  useEffect(() => {
    void window.adfApi?.startRemoteDiscovery?.().catch(() => {})
    return () => { void window.adfApi?.stopRemoteDiscovery?.().catch(() => {}) }
  }, [])

  useEffect(() => window.adfApi?.onRemotePairingState?.((next) => {
    if (step !== 'code' || (next.host && check?.url && next.host.url !== check.url)) return
    setPair(next)
    if (next.step === 'paired') setStep('done')
    setMessage(pairMessage(next, next.host?.name ?? ''))
  }), [step, check?.url])

  const pick = (target: AddTarget) => {
    setFound(target)
    setUrl(target.url)
    setTrusted(false)
    setMessage(null)
  }
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
  const back = () => {
    if (step === 'code') void window.adfApi.cancelRemotePairing()
    onBack?.()
  }
  const waiting = pair?.step === 'claiming' || pair?.step === 'waiting'
  const addressReady = !!check?.url && (!insecure || trusted)

  return (
    <Dialog open title="Add" onClose={close} lightDismiss={false}>
      {confirmDialog}
      <div className="space-y-3 text-[12px]">
        {step === 'address' && (
          <>
            <FoundList targets={targets} selected={found?.url ?? null} disabled={busy} onPick={pick} />
            {empty && <p className="text-[11px] text-[var(--adf-ui-text-subtle)]">{empty}</p>}
            {search?.problem && <p className="text-[11px] text-[var(--adf-ui-text-subtle)]">{search.problem}</p>}
            {found && <p className="text-[var(--adf-ui-text-muted)]">{found.name} at {found.address}, fingerprint {found.fingerprint}.</p>}
            <label className="block space-y-1">
              <span className="text-[var(--adf-ui-text)]">Address</span>
              <TextInput value={url} onChange={(e) => { setUrl(e.target.value); if (found && e.target.value !== found.url) setFound(null) }} placeholder="https://adf.example.com" spellCheck={false} autoComplete="off" aria-label="Address" autoFocus />
            </label>
            {check?.kind === 'invalid' && <p className="text-[var(--adf-ui-danger)]">{check.reason}</p>}
            {insecure && (
              <label className="flex items-center gap-2 cursor-pointer text-[var(--adf-ui-text-muted)]">
                <input type="checkbox" checked={trusted} onChange={(e) => setTrusted(e.target.checked)} className="rounded text-blue-500" />
                I trust this network; the token is sent unencrypted.
              </label>
            )}
            <details>
              <summary className="cursor-pointer select-none text-[var(--adf-ui-text-muted)]">Details</summary>
              <div className="mt-2 flex items-end gap-2">
                <label className="block flex-1 space-y-1">
                  <span className="text-[var(--adf-ui-text)]">Token</span>
                  <TextInput type="password" value={token} onChange={(e) => setToken(e.target.value)} spellCheck={false} autoComplete="off" aria-label="Token" />
                </label>
                <Button disabled={!addressReady || !token.trim()} loading={busy} onClick={() => void saveToken()}>Save</Button>
              </div>
            </details>
          </>
        )}
        {step === 'code' && pair?.host && (
          <>
            <p className="text-[var(--adf-ui-text-muted)]">Check that {pair.host.name} shows fingerprint {pair.host.fingerprint}.</p>
            <label className="block space-y-1">
              <span className="text-[var(--adf-ui-text)]">Code</span>
              <TextInput value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" maxLength={7} placeholder="123 456" disabled={waiting} aria-label="Pairing code" className="font-mono text-[18px] tracking-[0.2em]" />
            </label>
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
              {onBack && <Button onClick={back}>Back</Button>}
              <Button onClick={close}>Cancel</Button>
              {step === 'address' && <Button variant="primary" disabled={!addressReady} loading={busy} onClick={() => void next()}>Next</Button>}
              {step === 'code' && <Button variant="primary" disabled={code.replace(/\s/g, '').length !== 6} loading={busy || waiting} onClick={() => void sendCode()}>Pair</Button>}
              {step === 'token' && <Button variant="primary" disabled={!token.trim()} loading={busy} onClick={() => void saveToken()}>Save</Button>}
            </>
          )}
        </div>
      </div>
    </Dialog>
  )
}

/** The help line of each Add choice (owner decision 2026-10-21). */
export const CONNECT_HELP = 'Use a runtime on another computer.'
export const SHARE_HELP = 'Let another computer use this runtime.'

function ChoiceButton({ title, help, disabled, reason, onClick }: { title: string; help: string; disabled?: boolean; reason?: string | null; onClick: () => void }) {
  const button = (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full flex-col items-start gap-0.5 rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] px-3 py-2.5 text-left hover:bg-[var(--adf-ui-surface-hover)] disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span className="text-[13px] font-medium text-[var(--adf-ui-text)]">{title}</span>
      <span className="text-[12px] text-[var(--adf-ui-text-muted)]">{help}</span>
    </button>
  )
  return disabled && reason ? <Tooltip tip={reason}>{button}</Tooltip> : button
}

/** Add's first step (static in tests): Connect or Share. Share needs this computer's daemon (local mode). */
export function AddChoice({ share, onConnect, onShare }: { share: { available: boolean; reason: string | null }; onConnect: () => void; onShare: () => void }) {
  return (
    <div className="grid gap-2">
      <ChoiceButton title="Connect" help={CONNECT_HELP} onClick={onConnect} />
      <ChoiceButton title="Share" help={SHARE_HELP} disabled={!share.available} reason={share.reason} onClick={onShare} />
    </div>
  )
}

/** Add: Connect (this Studio uses a remote) or Share (another computer uses this runtime). */
export function AddDialog({ onClose }: { onClose: () => void }) {
  const [choice, setChoice] = useState<'choose' | 'connect' | 'share'>('choose')
  const [share, setShare] = useState<{ available: boolean; reason: string | null }>({ available: true, reason: null })
  useEffect(() => {
    let alive = true
    window.adfApi?.getRemoteAccess?.().then((v) => { if (alive) setShare({ available: v.available, reason: v.unavailableReason }) }).catch(() => {})
    return () => { alive = false }
  }, [])
  if (choice === 'connect') return <AddConnectionDialog onClose={onClose} onBack={() => setChoice('choose')} />
  return (
    <Dialog open title="Add" onClose={onClose} lightDismiss={false}>
      {choice === 'choose' ? (
        <div className="space-y-3 text-[12px]">
          <AddChoice share={share} onConnect={() => setChoice('connect')} onShare={() => setChoice('share')} />
          <div className="flex justify-end pt-1">
            <Button onClick={onClose}>Cancel</Button>
          </div>
        </div>
      ) : (
        <SharePanel onBack={() => setChoice('choose')} onDone={onClose} />
      )}
    </Dialog>
  )
}

/**
 * Remotes with no runtime on another computer saved: "None.". This
 * computer's daemon, Background and Inside Studio (legacy) stay one click
 * away under Details.
 */
export function SimpleConnections({ busy, onLegacy, details, extra }: {
  busy: boolean
  onLegacy: () => void
  details: React.ReactNode
  extra?: React.ReactNode
}) {
  return (
    <SettingsGroup title="Remotes" hint={REMOTES_HINT} docs={DOCS.backendConnection}>
      <p className="px-4 pb-3 text-[12px] text-[var(--adf-ui-text-muted)]">None.</p>
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

/** The Remotes heading's tooltip. */
export const REMOTES_HINT = 'Runtimes this Studio uses.'

/** Add, the one on the page, with the page's message line. */
export function AddBar({ busy, message, onAdd }: { busy: boolean; message: { kind: 'ok' | 'error'; text: string } | null; onAdd: () => void }) {
  return (
    <div className="flex items-center justify-end gap-3">
      <MessageLine message={message} />
      <Button variant="primary" disabled={busy} onClick={onAdd}>Add</Button>
    </div>
  )
}

export function ConnectionSettings() {
  const view = useConnectionStore((s) => s.view)
  const [backend, setBackend] = useState<BackendSettingsView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [adding, setAdding] = useState(false)
  const { track } = useSettingsSave()

  useEffect(() => {
    startConnectionFeed()
    let cancelled = false
    window.adfApi?.getBackendSettings()
      .then((next) => { if (!cancelled) setBackend(next) })
      .catch(() => { if (!cancelled) setLoadError('Could not read the connection settings.') })
    return () => { cancelled = true }
  }, [])

  // No remote saved: Remotes says "None.", and nothing searches the network until Add → Connect.
  const simple = !!view && view.current.kind === 'local' && !remoteConnectionsSaved(view)

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
      if (!result.ok) return { ok: false, error: result.error }
      setBackend(result.view)
      if (result.notices.length > 0) setMessage({ kind: 'ok', text: result.notices.join(' ') })
      return { ok: true as const }
    }), () => setBackend(prev))
  }
  /** Devices → On quit → Keep running: the same setting as Background. */
  const keepRunning = async () => {
    await track(window.adfApi.setBackendSettings({ keepDaemonRunning: true }).then((r) => {
      if (!r.ok) return { ok: false as const, error: r.error }
      setBackend(r.view)
      return { ok: true as const }
    }))
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
      <div role="status" className="rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-warning)]/30 bg-[var(--adf-ui-warning-subtle)] px-3 py-2 text-[12px] text-[var(--adf-ui-text)]">
        {override && <p>{override}</p>}
        {backend.active.notices.map((notice) => <p key={notice}>{notice}</p>)}
      </div>
    )}
    {nextLine && (
      <div role="status" className="flex items-center justify-between gap-3 rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] px-3 py-2 text-[12px] text-[var(--adf-ui-text)]">
        <span>{nextLine}</span>
        <Button size="compact" onClick={() => void window.adfApi.restartStudio()}>Restart</Button>
      </div>
    )}
  </>

  const addBar = <AddBar busy={busy} message={message} onAdd={() => setAdding(true)} />
  const devices = <DevicesGroup onKeepRunning={keepRunning} />

  if (simple) {
    return (
      <>
        {notices}
        {addBar}
        <SimpleConnections busy={busy} onLegacy={() => connect('embedded')} details={thisComputerRows} extra={switchRows} />
        {devices}
        {adding && <AddDialog onClose={() => setAdding(false)} />}
      </>
    )
  }

  return (
    <>
      {notices}
      {addBar}

      <SettingsGroup title="Remotes" hint={REMOTES_HINT} docs={DOCS.backendConnection}>
        <ConnectionRows rows={view.rows.filter((r) => r.kind !== 'found')} busy={busy} onConnect={connect} onAdd={() => setAdding(true)} onRemove={remove} />
        {switchRows}
      </SettingsGroup>

      {devices}

      {local && <SettingsGroup title={view.rows.find((r) => r.kind === 'local')?.name ?? LOCAL_LABEL}>{thisComputerRows}</SettingsGroup>}

      {adding && <AddDialog onClose={() => setAdding(false)} />}
    </>
  )
}
