/**
 * Remote access in Settings (docs/design/remote-access.md §7, §9.1;
 * settings-scopes.md §6, §7): other computers using this runtime.
 *
 * - Studio → Connections → Add → Share (`SharePanel`): consent inline
 *   (remote access on, and Allow on each current network not allowed, with
 *   one explicit Allow), then this runtime's addresses by network with
 *   Copy, and the 6-digit pairing code with its countdown. The other
 *   computer enters it; this computer still asks Allow device (a native
 *   dialog, remote-access.md §5.4), then "Approved: <name>.". A token
 *   shown once is under Details.
 * - Studio → Connections → Devices (`DevicesGroup`): the Remote access
 *   switch and the computers using this runtime, each with Revoke.
 * - Studio → Connections → Add → Connect: pairMessage for the client side
 *   (ConnectionSettings.tsx). Discovery and pairing run in main; the token
 *   never reaches the renderer.
 *
 * Every action goes to main, which asks the daemon. A new device token is
 * shown once, here, and dropped on Done; nothing else here holds a token.
 *
 * Copy (owner rule): labels are one word or a noun; at most one sentence
 * under a heading; the rest is behind Learn more.
 */

import { useEffect, useRef, useState } from 'react'
import { Button, SettingsGroup, SettingsRow, Switch, TextInput } from '../ui'
import { DocsLink } from '../common/DocsLink'
import { DOCS } from '../../../shared/constants/docs-links'
import type { NetworkView, PairingWindowView, RemoteAccessStatus, RemoteDevice, RemoteUrl } from '../../../shared/types/remote-access.types'
import type { RemoteAccessView, RemotePairState } from '../../../shared/types/remote-access-ipc.types'
import { PUBLIC_WARNING, unidentifiedText } from '../../../shared/utils/network-consent-text'

// --- Pure helpers (tested) ------------------------------------------------------

/** Remote access's own line (§8; "Paused on <network>." until the user allows it, owner decision 2026-10-18 b). */
export function remoteStatusLine(status: RemoteAccessStatus): string {
  if (!status.enabled) return 'Off.'
  if (status.state === 'on') {
    const listening = status.addresses.filter((a) => a.listening).map((a) => a.address)
    return listening.length > 0 ? `Listening on ${listening.join(', ')}.` : 'On.'
  }
  return status.message || status.problem || 'Off.'
}

/** A pairing window needs a listener: on but paused (or with no address), no device could reach the code. */
export function canAddDevice(status: RemoteAccessStatus | null): boolean {
  return !!status && status.enabled && status.state === 'on'
}

/** The mesh server's listeners: LAN mode lists its private-network and Tailscale addresses (lan-reach.ts). */
export function meshServerHosts(status: { host: string; lanAddresses?: string[] }): string {
  if (status.host !== '0.0.0.0') return status.host
  if (!status.lanAddresses) return 'all interfaces'
  if (status.lanAddresses.includes('0.0.0.0')) return 'all interfaces'
  return status.lanAddresses.length > 0 ? ['127.0.0.1', ...status.lanAddresses].join(', ') : '127.0.0.1 only (no private network)'
}

const URL_ORDER: Record<RemoteUrl['kind'], number> = { 'tailscale-https': 0, tailnet: 1, lan: 2, 'mdns-name': 3 }

/** Addresses in the order Share offers them: Tailscale https, tailnet, LAN, the .local name (§5.7). */
export function orderedUrls(urls: RemoteUrl[]): RemoteUrl[] {
  return [...urls].sort((a, b) => URL_ORDER[a.kind] - URL_ORDER[b.kind])
}

function urlHost(url: string): string {
  try { return new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase() } catch { return url }
}

/**
 * Share's addresses by network: Tailscale (the `tailscale serve` https URL
 * first, then the tailnet address), each LAN by its network's name, then
 * the others (the .local name, an address of no known network).
 */
export function groupedUrls(status: Pick<RemoteAccessStatus, 'urls' | 'networks'>): Array<{ title: string; urls: RemoteUrl[] }> {
  const groups: Array<{ title: string; urls: RemoteUrl[] }> = []
  const used = new Set<string>()
  const tailscale = orderedUrls(status.urls.filter((u) => u.kind === 'tailscale-https' || u.kind === 'tailnet'))
  if (tailscale.length > 0) {
    groups.push({ title: 'Tailscale', urls: tailscale })
    for (const u of tailscale) used.add(u.url)
  }
  for (const network of status.networks.filter((n) => n.kind === 'lan')) {
    const hosts = new Set(network.addresses.map((a) => a.toLowerCase()))
    const urls = status.urls.filter((u) => u.kind === 'lan' && !used.has(u.url) && hosts.has(urlHost(u.url)))
    if (urls.length === 0) continue
    groups.push({ title: network.label, urls })
    for (const u of urls) used.add(u.url)
  }
  const others = orderedUrls(status.urls.filter((u) => !used.has(u.url)))
  if (others.length > 0) groups.push({ title: 'Others', urls: others })
  return groups
}

export const NOT_ENCRYPTED_WARNING = 'Anyone on this network can read the token.'

/** "Last seen" in the devices list. */
export function lastSeenText(device: RemoteDevice, now = Date.now()): string {
  if (device.connected) return 'Connected now'
  if (!device.lastSeenAt) return 'Never connected'
  const at = Date.parse(device.lastSeenAt)
  if (Number.isNaN(at)) return `Last seen ${device.lastSeenAt}`
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  const when = minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} h ago` : new Date(at).toLocaleDateString()
  return `Last seen ${when}${device.lastSeenAddress ? ` (${device.lastSeenAddress})` : ''}`
}

/** "1:45" until the pairing window closes; "0:00" once it has. */
export function pairingCountdown(expiresAt: string, now = Date.now()): string {
  const left = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000))
  return Number.isNaN(left) ? '' : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
}

/** The code as the host shows it: "123 456". */
export function formatCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code
}

/** The warning under Allow: a LAN the OS reports Public, or does not report. */
export const PUBLIC_NETWORK_WARNING = PUBLIC_WARNING

export function networkWarning(network: NetworkView): string | null {
  return network.id && network.kind === 'lan' && network.osCategory !== 'private' ? PUBLIC_NETWORK_WARNING : null
}

/**
 * What Share needs before anything listens (owner decision 2026-10-18 b:
 * never listen without consent, given per network): remote access on, and
 * each current network allowed. Null when nothing is needed.
 */
export function shareConsent(status: RemoteAccessStatus): { enable: boolean; networks: NetworkView[]; text: string; warning: string | null } | null {
  const networks = status.networks.filter((n) => !n.allowed && !!n.id)
  const enable = !status.enabled
  if (!enable && networks.length === 0) return null
  const where = networks.length > 0 ? ` on ${networks.map((n) => n.label).join(' and ')}` : ''
  return {
    enable,
    networks,
    text: `Computers you pair${where} get full control of this runtime, as powerful as your seed phrase.`,
    warning: networks.some((n) => networkWarning(n)) ? PUBLIC_NETWORK_WARNING : null,
  }
}

/** "Approved: <label>." once a device that entered the code is allowed: the newest paired device since Share opened. */
export function addedDeviceLine(before: ReadonlySet<string>, devices: RemoteDevice[]): string | null {
  const added = devices.find((d) => d.origin === 'paired' && !before.has(d.id))
  return added ? `Approved: ${added.label}.` : null
}

/** The line of every host-only control with a remote runtime (settings-scopes.md §7). */
export function changeOn(name: string): string {
  return `Change on ${name}.`
}

/** The Connect dialog's message line: what to do now, or why it stopped. */
export function pairMessage(state: RemotePairState | null, hostName: string): { kind: 'ok' | 'error'; text: string } | null {
  if (!state) return null
  if (state.step === 'waiting') return { kind: 'ok', text: state.message ?? `Waiting for ${hostName} to allow this device…` }
  if (state.step === 'paired') return { kind: 'ok', text: state.message ?? `Paired with ${hostName}.` }
  if (state.step === 'claiming') return { kind: 'ok', text: 'Sending the code…' }
  if (state.message) return { kind: state.code ? 'error' : 'ok', text: state.message }
  return null
}

// --- Presentational parts ----------------------------------------------------------

function EncryptionBadge({ encrypted }: { encrypted: boolean }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${encrypted ? 'bg-[var(--adf-ui-success-subtle,var(--adf-ui-surface-hover))] text-[var(--adf-ui-success,var(--adf-ui-text))]' : 'bg-[var(--adf-ui-warning-subtle)] text-[var(--adf-ui-text)]'}`}>
      {encrypted ? 'Encrypted' : 'Not encrypted'}
    </span>
  )
}

function copy(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => {})
}

function LearnMore({ href }: { href: string }) {
  return <DocsLink href={href} label="Learn more" className="ml-1.5 !text-[11px]" />
}

export function RemoteAddressList({ urls }: { urls: RemoteUrl[] }) {
  if (urls.length === 0) return <p className="text-[12px] text-[var(--adf-ui-text-muted)]">No address.</p>
  return (
    <ul className="space-y-1.5">
      {orderedUrls(urls).map((u) => (
        <li key={u.url} className="flex flex-wrap items-center gap-2 text-[12px]">
          <code className="break-all text-[var(--adf-ui-text)]">{u.url}</code>
          <EncryptionBadge encrypted={u.encrypted} />
          <Button size="compact" variant="ghost" onClick={() => copy(u.url)} aria-label={`Copy ${u.url}`}>Copy</Button>
          {!u.encrypted && <span className="w-full text-[11px] text-[var(--adf-ui-text-subtle)]">{NOT_ENCRYPTED_WARNING}</span>}
        </li>
      ))}
    </ul>
  )
}

/** Share's addresses, one heading per network (groupedUrls). */
export function GroupedAddresses({ status }: { status: Pick<RemoteAccessStatus, 'urls' | 'networks'> }) {
  const groups = groupedUrls(status)
  if (groups.length === 0) return <p className="text-[12px] text-[var(--adf-ui-text-muted)]">No address.</p>
  return (
    <div className="space-y-2">
      {groups.map((g) => (
        <div key={g.title}>
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--adf-ui-text-subtle)]">{g.title}</div>
          <RemoteAddressList urls={g.urls} />
        </div>
      ))}
    </div>
  )
}

export function RemoteDeviceList({ devices, busy, onRemove, now }: { devices: RemoteDevice[]; busy: boolean; onRemove: (device: RemoteDevice) => void; now?: number }) {
  if (devices.length === 0) return <p className="text-[12px] text-[var(--adf-ui-text-muted)]">None.</p>
  return (
    <ul className="divide-y divide-[var(--adf-ui-separator)]">
      {devices.map((d) => (
        <li key={d.id} className="flex items-center justify-between gap-3 py-1.5">
          <div className="min-w-0 text-[12px]">
            <div className="font-medium text-[var(--adf-ui-text)]">{d.label}</div>
            <div className={d.connected ? 'text-[var(--adf-ui-accent)]' : 'text-[var(--adf-ui-text-muted)]'}>
              {d.origin === 'paired' ? 'Paired' : 'Token'} · {lastSeenText(d, now)}
            </div>
          </div>
          <Button size="compact" variant="danger" disabled={busy} onClick={() => onRemove(d)}>Revoke</Button>
        </li>
      ))}
    </ul>
  )
}

/** Share, code view: the code in large digits, the countdown and the tries left. */
export function PairingCodePanel({ pairing, fingerprint, now }: { pairing: PairingWindowView; fingerprint: string | null; now?: number }) {
  return (
    <div className="space-y-2 text-center">
      <p className="text-[12px] text-[var(--adf-ui-text-muted)]">Enter this code on the other computer.</p>
      <p className="font-mono text-[40px] font-semibold tracking-[0.15em] text-[var(--adf-ui-text)]" aria-label="Pairing code">{formatCode(pairing.code)}</p>
      <p className="text-[12px] text-[var(--adf-ui-text-muted)]">
        Expires in {pairingCountdown(pairing.expiresAt, now)} · {pairing.attemptsLeft} wrong {pairing.attemptsLeft === 1 ? 'code' : 'codes'} left
        {(pairing.fingerprint || fingerprint) ? <> · Fingerprint {pairing.fingerprint || fingerprint}</> : null}
      </p>
      {pairing.lockedSources > 0 && <p className="text-[12px] text-[var(--adf-ui-danger)]">{pairing.lockedSources} {pairing.lockedSources === 1 ? 'device' : 'devices'} locked out after 5 wrong codes.</p>}
      {pairing.claim && <p className="text-[12px] text-[var(--adf-ui-text)]">A device entered the code. Answer the Allow device dialog.</p>}
    </div>
  )
}

/** The new device token, shown once. */
export function NewTokenPanel({ label, token, onDone }: { label: string; token: string; onDone: () => void }) {
  return (
    <div className="space-y-2">
      <div className="text-[12px] text-[var(--adf-ui-text)]">Token for {label}, shown once. It is as powerful as your seed phrase.</div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded border border-[var(--adf-ui-border)] bg-[var(--adf-ui-canvas)] px-2 py-1 text-[12px]">{token}</code>
        <Button size="compact" onClick={() => copy(token)}>Copy</Button>
        <Button size="compact" variant="primary" onClick={onDone}>Done</Button>
      </div>
      <div className="text-[11px] text-[var(--adf-ui-text-subtle)]">On the other computer: Add, Connect, then Details.</div>
    </div>
  )
}

/** Share's consent, inline: one sentence, the Public warning, one explicit Allow. */
export function ShareConsent({ consent, busy, onAllow }: { consent: NonNullable<ReturnType<typeof shareConsent>>; busy: boolean; onAllow: () => void }) {
  return (
    <div className="space-y-2">
      <p className="text-[var(--adf-ui-text)]">{consent.text}<LearnMore href={DOCS.remoteAccessPair} /></p>
      {consent.warning && <p className="text-[11px] text-[var(--adf-ui-danger)]">{consent.warning}</p>}
      <div className="flex justify-end">
        <Button variant="primary" loading={busy} onClick={onAllow}>Allow</Button>
      </div>
    </div>
  )
}

// --- Add → Share -------------------------------------------------------------------

type ActResult = { ok: true; view: RemoteAccessView } | { ok: false; code: string; error: string }

/**
 * Add → Share: another computer uses this runtime. Asks consent inline when
 * remote access is off or a current network is not allowed (never listens
 * without it), then shows the addresses and opens a pairing window. The
 * claim is still allowed or denied on this computer (Allow device).
 */
export function SharePanel({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const [view, setView] = useState<RemoteAccessView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [label, setLabel] = useState('')
  const [created, setCreated] = useState<{ label: string; token: string } | null>(null)
  const before = useRef<ReadonlySet<string> | null>(null)
  const opened = useRef(false)

  useEffect(() => {
    let alive = true
    window.adfApi?.getRemoteAccess?.().then((v) => { if (alive) setView(v) }).catch(() => {})
    const off = window.adfApi?.onRemoteAccessChanged?.((change) => setView(change.view))
    const timer = setInterval(() => { window.adfApi?.getRemoteAccess?.().then((v) => { if (alive) setView(v) }).catch(() => {}) }, 5_000)
    return () => { alive = false; off?.(); clearInterval(timer) }
  }, [])

  const status = view?.status ?? null
  if (status && before.current === null) before.current = new Set(status.devices.map((d) => d.id))
  const consent = status ? shareConsent(status) : null
  const approved = status && before.current ? addedDeviceLine(before.current, status.devices) : null
  const pairing = status?.pairing ?? null
  const approvedRef = useRef(false)
  approvedRef.current = !!approved

  // Leaving Share before a computer claimed the code closes the window this Share opened.
  useEffect(() => () => {
    if (opened.current && !approvedRef.current) void window.adfApi?.closeRemotePairing?.().catch(() => {})
  }, [])

  // Once it listens: the code (the existing pairing window), opened for this Share.
  useEffect(() => {
    if (!status || consent || approved || opened.current || !canAddDevice(status) || status.pairing) return
    opened.current = true
    void act(() => window.adfApi.openRemotePairing())
  }, [status, consent, approved])
  useEffect(() => {
    if (!pairing) return
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [pairing])

  async function act(fn: () => Promise<ActResult>): Promise<boolean> {
    setBusy(true)
    setError(null)
    try {
      const result = await fn()
      if (result.ok) setView(result.view)
      else if (result.code !== 'cancelled') setError(result.error)
      return result.ok
    } catch {
      setError('Studio could not reach the ADF daemon.')
      return false
    } finally {
      setBusy(false)
    }
  }
  const allow = async () => {
    if (!consent) return
    // The Allow under the sentence is the confirmation: no second dialog.
    if (consent.enable && !await act(() => window.adfApi.setRemoteAccess({ enabled: true, confirmed: true }))) return
    for (const n of consent.networks) {
      const result = await window.adfApi.allowNetwork(n.id!)
      if (!result.ok) { setError(result.error); break }
    }
    const next = await window.adfApi.getRemoteAccess().catch(() => null)
    if (next) setView(next)
  }
  const renew = () => { void act(() => window.adfApi.openRemotePairing()) }
  const createToken = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await window.adfApi.addRemoteDevice(label)
      if (result.ok) { setView(result.view); setCreated({ label: result.device.label, token: result.token }) }
      else setError(result.error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <SharePanelView
      view={view}
      busy={busy}
      error={error}
      now={now}
      approved={approved}
      label={label}
      created={created}
      onLabel={setLabel}
      onAllow={() => void allow()}
      onRenew={renew}
      onCreateToken={() => void createToken()}
      onBack={onBack}
      onDone={onDone}
    />
  )
}

/** Share's markup (static in tests). */
export function SharePanelView({ view, busy, error, now, approved, label, created, onLabel, onAllow, onRenew, onCreateToken, onBack, onDone }: {
  view: RemoteAccessView | null
  busy: boolean
  error: string | null
  now?: number
  approved: string | null
  label: string
  created: { label: string; token: string } | null
  onLabel: (label: string) => void
  onAllow: () => void
  onRenew: () => void
  onCreateToken: () => void
  onBack: () => void
  onDone: () => void
}) {
  const status = view?.status ?? null
  const consent = status ? shareConsent(status) : null
  const pairing = status?.pairing ?? null
  const expired = !!pairing && pairingCountdown(pairing.expiresAt, now) === '0:00'
  return (
    <div className="space-y-3 text-[12px]">
      {!view && <p className="text-[var(--adf-ui-text-muted)]">Loading…</p>}
      {view && !view.available && <p className="text-[var(--adf-ui-text-muted)]">{view.unavailableReason}</p>}
      {view?.available && !status && <p className="text-[var(--adf-ui-danger)]">{view.error ?? 'Studio could not read remote access.'}</p>}
      {status && consent && <ShareConsent consent={consent} busy={busy} onAllow={onAllow} />}
      {status?.networks.filter((n) => !n.id).map((n) => (
        <p key={`unidentified:${n.kind}:${n.ifaces.join(',')}`} className="text-[var(--adf-ui-text-muted)]">
          {unidentifiedText(n.problem)}<DocsLink href={DOCS.unidentifiedNetwork} label="Help" className="ml-1.5 !text-[11px]" />
        </p>
      ))}
      {status && !consent && (
        <>
          {approved
            ? <p className="text-[13px] font-medium text-[var(--adf-ui-text)]">{approved}</p>
            : pairing && !expired
              ? <PairingCodePanel pairing={pairing} fingerprint={status.fingerprint} now={now} />
              : canAddDevice(status)
                ? <div className="flex items-center justify-between gap-2"><span className="text-[var(--adf-ui-text-muted)]">{pairing ? 'The code expired.' : 'Opening…'}</span>{pairing && <Button size="compact" disabled={busy} onClick={onRenew}>Renew</Button>}</div>
                : <p className="text-[var(--adf-ui-text-muted)]">{remoteStatusLine(status)}</p>}
          <div>
            <div className="mb-1 text-[13px] font-medium text-[var(--adf-ui-text)]">Addresses</div>
            <GroupedAddresses status={status} />
          </div>
          {!approved && (
            <details className="text-[12px]">
              <summary className="cursor-pointer select-none text-[var(--adf-ui-text-muted)]">Details</summary>
              <div className="mt-2 space-y-2">
                {created ? <NewTokenPanel label={created.label} token={created.token} onDone={onDone} /> : (
                  <div className="flex items-end gap-2">
                    <label className="block flex-1 space-y-1">
                      <span className="text-[var(--adf-ui-text)]">Device name</span>
                      <TextInput value={label} onChange={(e) => onLabel(e.target.value)} placeholder="Device name" aria-label="Device name" maxLength={64} />
                    </label>
                    <Button disabled={busy} onClick={onCreateToken}>Create</Button>
                  </div>
                )}
              </div>
            </details>
          )}
        </>
      )}
      {error && <p role="status" className="text-[var(--adf-ui-danger)]">{error}</p>}
      <div className="flex justify-end gap-2 pt-1">
        <Button onClick={onBack}>Back</Button>
        {approved || created ? <Button variant="primary" onClick={onDone}>Done</Button> : <Button onClick={onDone}>Cancel</Button>}
      </div>
    </div>
  )
}

// --- Studio → Connections → Devices -------------------------------------------------

/**
 * Devices: the Remote access switch (turning it on asks in a native dialog,
 * remote-access.md §7) and the computers using this runtime, each with
 * Revoke. Only in local mode; otherwise the reason.
 */
export function DevicesGroup({ onKeepRunning, className = '' }: { onKeepRunning: () => Promise<void>; className?: string }) {
  const [view, setView] = useState<RemoteAccessView | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let alive = true
    window.adfApi?.getRemoteAccess?.().then((v) => { if (alive) setView(v) }).catch(() => {})
    const off = window.adfApi?.onRemoteAccessChanged?.((change) => {
      setView(change.view)
      if (change.notice) setMessage({ kind: 'ok', text: change.notice })
    })
    return () => { alive = false; off?.() }
  }, [])
  const enabled = view?.status?.enabled === true
  // While on: re-read every 5 s (Connected now).
  useEffect(() => {
    if (!enabled) return
    const timer = setInterval(() => {
      window.adfApi?.getRemoteAccess?.().then(setView).catch(() => {})
      setNow(Date.now())
    }, 5_000)
    return () => clearInterval(timer)
  }, [enabled])

  const act = async (fn: () => Promise<ActResult>) => {
    setBusy(true)
    setMessage(null)
    try {
      const result = await fn()
      if (result.ok) setView(result.view)
      else if (result.code !== 'cancelled') setMessage({ kind: 'error', text: result.error })
    } catch {
      setMessage({ kind: 'error', text: 'Studio could not reach the ADF daemon.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <DevicesGroupView
      className={className}
      view={view}
      busy={busy}
      message={message}
      now={now}
      onSwitch={(next) => void act(() => window.adfApi.setRemoteAccess({ enabled: next }))}
      onKeepRunning={() => void onKeepRunning().then(() => window.adfApi.getRemoteAccess()).then(setView).catch(() => {})}
      onRevoke={(d) => void act(() => window.adfApi.removeRemoteDevice(d.id))}
    />
  )
}

/** Devices' markup (static in tests). */
export function DevicesGroupView({ view, busy, message, now, onSwitch, onKeepRunning, onRevoke, className = '' }: {
  view: RemoteAccessView | null
  busy: boolean
  message: { kind: 'ok' | 'error'; text: string } | null
  now?: number
  onSwitch: (next: boolean) => void
  onKeepRunning: () => void
  onRevoke: (device: RemoteDevice) => void
  className?: string
}) {
  if (!view) return null
  const status = view.status
  const enabled = status?.enabled === true
  return (
    <SettingsGroup title="Devices" hint="Computers using this runtime." docs={DOCS.remoteAccessDevices} className={className}>
      <SettingsRow
        label="Remote access"
        description="Computers you add use this runtime."
        help={view.available ? (status ? remoteStatusLine(status) : undefined) : view.unavailableReason ?? undefined}
        error={view.error ?? undefined}
      >
        <Switch label="Remote access" checked={enabled} disabled={!view.available || busy || !status} onChange={onSwitch} />
      </SettingsRow>
      {enabled && view.stopsWithStudio && (
        <SettingsRow separator label="On quit" description="Devices lose the connection when Studio quits.">
          <Button size="compact" disabled={busy} onClick={onKeepRunning}>Keep running</Button>
        </SettingsRow>
      )}
      {status && (
        <div className="border-t border-[var(--adf-ui-separator)] px-4 py-2">
          <RemoteDeviceList devices={status.devices} busy={busy} now={now} onRemove={onRevoke} />
        </div>
      )}
      {message && (
        <div className="border-t border-[var(--adf-ui-separator)] px-4 py-2.5">
          <span role="status" className={`text-[12px] ${message.kind === 'error' ? 'text-[var(--adf-ui-danger)]' : 'text-[var(--adf-ui-text-muted)]'}`}>{message.text}</span>
        </div>
      )}
    </SettingsGroup>
  )
}
