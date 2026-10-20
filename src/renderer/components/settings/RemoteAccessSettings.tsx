/**
 * Remote access in Settings (docs/design/remote-access.md §7, §9.1;
 * settings-scopes.md §6, §7):
 *
 * - Runtime → Networking: `NetworkStatusLine` (the networks the mesh and
 *   remote access both use, Allow on this network, Allowed networks with
 *   Remove) and `RemoteAccessGroup`, the host side (local mode), with the
 *   one Add device dialog (the code, or a token). Every action goes to
 *   main, which asks the daemon and confirms in a native dialog where the
 *   design says so. A new device token is shown once, here, and dropped on
 *   Done; nothing else here holds a token. With a remote runtime these are
 *   host-only: `HostOnlyRemoteAccess` says "Change on <name>."
 * - Studio → Connections: the Add dialog (ConnectionSettings.tsx) pairs with
 *   a computer found on the network or at a typed address, with pairMessage.
 *   Discovery and pairing run in main; the token never reaches the renderer.
 *
 * Copy (owner rule 2026-10-18): headings, labels, buttons and dialog titles
 * are plain nouns or short verb phrases; at most one short sentence under a
 * heading; the rest is behind Learn more.
 */

import { useEffect, useRef, useState } from 'react'
import { Button, SettingsGroup, SettingsRow, Switch, TextInput } from '../ui'
import { Dialog } from '../common/Dialog'
import { DocsLink } from '../common/DocsLink'
import { Tooltip } from '../common/Tooltip'
import { DOCS } from '../../../shared/constants/docs-links'
import type { NetworkView, PairingWindowView, RemoteAccessStatus, RemoteDevice, RemoteUrl } from '../../../shared/types/remote-access.types'
import type { NetworkStatusView, RemoteAccessView, RemoteDiscoveryUpdate, RemotePairState } from '../../../shared/types/remote-access-ipc.types'
import type { MeshAgentStatus } from '../../../shared/types/ipc.types'

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

/** Add device needs a listener: on but paused (or with no address), no device could reach the code. */
export function canAddDevice(status: RemoteAccessStatus | null): boolean {
  return !!status && status.enabled && status.state === 'on'
}

/** The status line at the top of Settings → Networking. */
export function networkStatusText(view: NetworkStatusView): string {
  const parts: string[] = []
  const lans = view.networks.filter((n) => n.kind === 'lan')
  if (lans.length === 0) parts.push('Network: no LAN address')
  else parts.push(`Network: ${lans.map((n) => `${n.label}${n.allowed ? '' : ' (not allowed)'}`).join(', ')}`)
  if (view.lan.length > 0) parts.push(`LAN ${view.lan.map((a) => a.address).join(', ')}${view.lan.every((a) => !a.allowed) ? ', not listening' : ''}`)
  parts.push(view.tailscale === 'running' ? `Tailscale on${view.tailnetAddress ? ` (${view.tailnetAddress})` : ''}` : view.tailscale === 'stopped' ? 'Tailscale stopped' : 'Tailscale not installed')
  parts.push(`Firewall ${view.firewall.state === 'blocked' ? 'blocked' : view.firewall.state === 'unknown' ? 'unknown' : 'ok'}`)
  return parts.join(' · ')
}

/** Agents by visibility, with the LanAgentsList predicate (visibility 'lan'). */
export function meshVisibilityCounts(agents: Array<Pick<MeshAgentStatus, 'visibility'>>): { lan: number; public: number; private: number } {
  let lan = 0, pub = 0, priv = 0
  for (const a of agents) {
    if (a.visibility === 'lan') lan++
    else if (a.visibility === 'public') pub++
    else priv++
  }
  return { lan, public: pub, private: priv }
}

export function meshVisibilityLine(agents: Array<Pick<MeshAgentStatus, 'visibility'>>): string {
  const c = meshVisibilityCounts(agents)
  return `${c.lan} ${c.lan === 1 ? 'agent' : 'agents'} visible on LAN · ${c.public} public · ${c.private} private`
}

/** The mesh server's listeners: LAN mode lists its private-network and Tailscale addresses (lan-reach.ts). */
export function meshServerHosts(status: { host: string; lanAddresses?: string[] }): string {
  if (status.host !== '0.0.0.0') return status.host
  if (!status.lanAddresses) return 'all interfaces'
  if (status.lanAddresses.includes('0.0.0.0')) return 'all interfaces'
  return status.lanAddresses.length > 0 ? ['127.0.0.1', ...status.lanAddresses].join(', ') : '127.0.0.1 only (no private network)'
}

const URL_ORDER: Record<RemoteUrl['kind'], number> = { 'tailscale-https': 0, tailnet: 1, lan: 2, 'mdns-name': 3 }

/** Addresses in the order the panel offers them: Tailscale https, tailnet, LAN, the .local name (§5.7). */
export function orderedUrls(urls: RemoteUrl[]): RemoteUrl[] {
  return [...urls].sort((a, b) => URL_ORDER[a.kind] - URL_ORDER[b.kind])
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

export function RemoteDeviceList({ devices, busy, onRemove, now }: { devices: RemoteDevice[]; busy: boolean; onRemove: (device: RemoteDevice) => void; now?: number }) {
  if (devices.length === 0) return <p className="text-[12px] text-[var(--adf-ui-text-muted)]">No devices.</p>
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

/** Add device, code view: the code in large digits, the countdown and the tries left. */
export function PairingCodePanel({ pairing, fingerprint, now }: { pairing: PairingWindowView; fingerprint: string | null; now?: number }) {
  return (
    <div className="space-y-3 text-center">
      <p className="text-[12px] text-[var(--adf-ui-text-muted)]">Enter this code on the device.</p>
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
      <div className="text-[11px] text-[var(--adf-ui-text-subtle)]">On the device: Settings → Connections → Add.</div>
    </div>
  )
}

// --- Settings → Networking -----------------------------------------------------------

/** The warning under Allow on this network: a LAN the OS reports Public, or does not report. */
export const PUBLIC_NETWORK_WARNING = 'Public network. The token is sent unencrypted.'

export function networkWarning(network: NetworkView): string | null {
  return network.id && network.kind === 'lan' && network.osCategory !== 'private' ? PUBLIC_NETWORK_WARNING : null
}

/**
 * The status line (networks, LAN address, Tailscale, firewall), Allow on
 * this network for each network not allowed, and Allowed networks with
 * Remove. Mesh and remote access both follow it (owner decision 2026-10-18 b).
 */
export function NetworkStatusLine() {
  const [view, setView] = useState<NetworkStatusView | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const load = () => {
    window.adfApi?.getNetworkStatus?.().then(setView).catch(() => {})
  }
  useEffect(() => {
    load()
    const timer = setInterval(load, 10_000)
    const off = window.adfApi?.onRemoteAccessChanged?.(() => load())
    return () => { clearInterval(timer); off?.() }
  }, [])
  if (!view?.available) return null
  const change = async (action: 'allow' | 'forget', id: string) => {
    setNote(null)
    setBusy(true)
    try {
      const result = action === 'allow' ? await window.adfApi.allowNetwork(id) : await window.adfApi.forgetNetwork(id)
      if (!result.ok) setNote(result.error)
    } catch {
      setNote('Studio could not change the allowed networks.')
    } finally {
      setBusy(false)
      load()
    }
  }
  return <NetworkConsentPanel view={view} busy={busy} note={note} onAllow={(id) => void change('allow', id)} onRemove={(id) => void change('forget', id)} />
}

/** The status line with "Remote access paused on <network>." and Allow on this network, then Allowed networks with Remove. */
export function NetworkConsentPanel({ view, busy, note, onAllow, onRemove }: {
  view: NetworkStatusView
  busy: boolean
  note: string | null
  onAllow: (id: string) => void
  onRemove: (id: string) => void
}) {
  const waiting = view.networks.filter((n) => !n.allowed)
  return (
    <>
      <div role="status" className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] px-3 py-2 text-[12px] text-[var(--adf-ui-text)]">
        <span>{networkStatusText(view)}<LearnMore href={DOCS.networkingStatus} /></span>
        {waiting.map((n) => (
          <div key={n.id ?? `unidentified-${n.ifaces.join(',')}`} className="flex w-full flex-wrap items-center justify-between gap-2">
            <span>Remote access paused on {n.label}.</span>
            {n.id && <Button size="compact" disabled={busy} onClick={() => onAllow(n.id!)}>Allow on this network</Button>}
            {networkWarning(n) && <span className="w-full text-[11px] text-[var(--adf-ui-danger)]">{networkWarning(n)}</span>}
          </div>
        ))}
        {(view.firewall.state === 'blocked' || note) && (
          <span className="w-full text-[11px] text-[var(--adf-ui-danger)]">{note ?? view.firewall.message}</span>
        )}
      </div>
      <SettingsGroup title="Allowed networks">
        {view.allowedNetworks.length === 0
          ? <SettingsRow label="None" />
          : view.allowedNetworks.map((n) => (
            <SettingsRow key={n.id} label={n.label} description={view.networks.some((c) => c.id === n.id) ? 'Current network' : undefined}>
              <Button size="compact" disabled={busy} onClick={() => onRemove(n.id)}>Remove</Button>
            </SettingsRow>
          ))}
      </SettingsGroup>
    </>
  )
}

export function RemoteAccessGroup({ onKeepRunning }: { onKeepRunning: () => Promise<void> }) {
  const [view, setView] = useState<RemoteAccessView | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  /** The one Add device dialog: the code, or a token (settings-scopes.md §6). */
  const [adding, setAdding] = useState(false)
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

  const status = view?.status ?? null
  const enabled = status?.enabled === true
  const pairing = status?.pairing ?? null
  // While on: re-read every 5 s (Connected now); a pairing window ticks every second.
  useEffect(() => {
    if (!enabled) return
    const timer = setInterval(() => {
      window.adfApi?.getRemoteAccess?.().then(setView).catch(() => {})
    }, 5_000)
    return () => clearInterval(timer)
  }, [enabled])
  useEffect(() => {
    if (!pairing) return
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [pairing])

  const act = async (fn: () => Promise<{ ok: true; view: RemoteAccessView } | { ok: false; code: string; error: string }>, okText?: string) => {
    setBusy(true)
    setMessage(null)
    try {
      const result = await fn()
      if (result.ok) {
        setView(result.view)
        if (okText) setMessage({ kind: 'ok', text: okText })
      } else if (result.code !== 'cancelled') {
        setMessage({ kind: 'error', text: result.error })
      }
      return result.ok
    } catch {
      setMessage({ kind: 'error', text: 'Studio could not reach the ADF daemon.' })
      return false
    } finally {
      setBusy(false)
    }
  }

  if (!view) return null
  const disabled = !view.available || busy

  return (
    <SettingsGroup title="Remote access" description="Your devices use this computer's agents." docs={DOCS.remoteAccess}>
      <SettingsRow
        label="Remote access"
        description={<>A device token is as powerful as your seed phrase.<LearnMore href={DOCS.remoteAccess} /></>}
        help={view.available ? (status ? remoteStatusLine(status) : undefined) : view.unavailableReason ?? undefined}
        error={view.error ?? undefined}
      >
        <Switch label="Remote access" checked={enabled} disabled={disabled || !status} onChange={(next) => void act(() => window.adfApi.setRemoteAccess({ enabled: next }))} />
      </SettingsRow>
      {enabled && view.stopsWithStudio && (
        <SettingsRow separator label="On quit" description="Devices lose the connection when Studio quits.">
          <Button size="compact" disabled={busy} onClick={() => void onKeepRunning().then(() => window.adfApi.getRemoteAccess()).then(setView).catch(() => {})}>Keep running</Button>
        </SettingsRow>
      )}
      {enabled && status && (
        <>
          <SettingsRow stacked separator label="Addresses" description={<>Use one on the other device.<LearnMore href={DOCS.remoteAccess} /></>}>
            <RemoteAddressList urls={status.urls} />
            {status.tailscale.state === 'running' && status.tailscale.serve !== 'unknown' && (
              <div className="mt-2">
                <Button size="compact" disabled={busy} onClick={() => void act(() => window.adfApi.setRemoteTailscaleServe(status.tailscale.serve !== 'on'))}>
                  {status.tailscale.serve === 'on' ? 'Disable Tailscale https' : 'Enable Tailscale https'}
                </Button>
              </div>
            )}
            {status.firewall.state === 'unknown' && status.firewall.commands.length > 0 && (
              <details className="mt-2 text-[11px] text-[var(--adf-ui-text-subtle)]">
                <summary className="cursor-pointer select-none">Firewall</summary>
                <p className="mt-1">{status.firewall.message}</p>
                <ul className="mt-1 space-y-0.5 font-mono">{status.firewall.commands.map((c) => <li key={c}>{c}</li>)}</ul>
              </details>
            )}
          </SettingsRow>
          <SettingsRow stacked separator label="Devices" description={<>Devices that use this computer&apos;s agents.<LearnMore href={DOCS.remoteAccessPair} /></>}>
            <Tooltip tip={canAddDevice(status) ? 'Show a code to enter on the device' : remoteStatusLine(status)}>
              <Button size="compact" variant="primary" disabled={busy || !canAddDevice(status)} onClick={() => setAdding(true)}>Add device</Button>
            </Tooltip>
            <div className="mt-2">
              <RemoteDeviceList
                devices={status.devices}
                busy={busy}
                now={now}
                onRemove={(d) => void act(() => window.adfApi.removeRemoteDevice(d.id))}
              />
            </div>
          </SettingsRow>
        </>
      )}
      {message && (
        <div className="border-t border-[var(--adf-ui-separator)] px-4 py-2.5">
          <span role="status" className={`text-[12px] ${message.kind === 'error' ? 'text-[var(--adf-ui-danger)]' : 'text-[var(--adf-ui-text-muted)]'}`}>{message.text}</span>
        </div>
      )}
      {adding && status && (
        <AddDeviceDialog
          pairing={pairing}
          fingerprint={status.fingerprint}
          devices={status.devices}
          now={now}
          onOpenCode={() => act(() => window.adfApi.openRemotePairing())}
          onCloseCode={() => act(() => window.adfApi.closeRemotePairing())}
          onCreateToken={async (label) => {
            const result = await window.adfApi.addRemoteDevice(label)
            if (result.ok) setView(result.view)
            return result.ok ? { ok: true, label: result.device.label, token: result.token } : { ok: false, error: result.error }
          }}
          onClose={() => setAdding(false)}
        />
      )}
    </SettingsGroup>
  )
}

/** "Added <label>." once a device that entered the code is allowed: the newest paired device since the dialog opened. */
export function addedDeviceLine(before: ReadonlySet<string>, devices: RemoteDevice[]): string | null {
  const added = devices.find((d) => d.origin === 'paired' && !before.has(d.id))
  return added ? `Added ${added.label}.` : null
}

/**
 * Add device (settings-scopes.md §6): opens on the 6-digit code (the pairing
 * window opens with the dialog); "Use a token instead" closes the window and
 * creates a token shown once. "Use a code instead" opens a new window.
 */
export function AddDeviceDialog({ pairing, fingerprint, devices, now, onOpenCode, onCloseCode, onCreateToken, onClose, initialView = 'code' }: {
  pairing: PairingWindowView | null
  fingerprint: string | null
  devices: RemoteDevice[]
  now?: number
  onOpenCode: () => Promise<boolean>
  onCloseCode: () => Promise<boolean>
  onCreateToken: (label: string) => Promise<{ ok: true; label: string; token: string } | { ok: false; error: string }>
  onClose: () => void
  /** Tests: the view to render first. */
  initialView?: 'code' | 'token'
}) {
  const [view, setView] = useState<'code' | 'token'>(initialView)
  const [label, setLabel] = useState('')
  const [created, setCreated] = useState<{ label: string; token: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const before = useRef<ReadonlySet<string>>(new Set(devices.map((d) => d.id)))
  const opened = useRef(false)
  useEffect(() => {
    if (initialView !== 'code' || opened.current) return
    opened.current = true
    if (!pairing) void onOpenCode()
    // Opened once, with the dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const added = addedDeviceLine(before.current, devices)
  const close = () => {
    if (view === 'code' && pairing) void onCloseCode()
    onClose()
  }
  const toToken = () => {
    if (pairing) void onCloseCode()
    setError(null)
    setView('token')
  }
  const toCode = () => {
    setError(null)
    setView('code')
    void onOpenCode()
  }
  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await onCreateToken(label)
      if (result.ok) setCreated({ label: result.label, token: result.token })
      else setError(result.error)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open title="Add device" onClose={close} lightDismiss={false}>
      <div className="space-y-3 text-[12px]">
        {view === 'code' && (
          added
            ? <p className="text-[var(--adf-ui-text)]">{added}</p>
            : pairing
              ? <PairingCodePanel pairing={pairing} fingerprint={fingerprint} now={now} />
              : <p className="text-[var(--adf-ui-text-muted)]">Opening…</p>
        )}
        {view === 'code' && !added && (
          <div className="text-center">
            <button type="button" className="text-[var(--adf-ui-accent)] hover:underline" onClick={toToken}>Use a token instead</button>
          </div>
        )}
        {view === 'token' && (created ? (
          <NewTokenPanel label={created.label} token={created.token} onDone={onClose} />
        ) : (
          <>
            <label className="block space-y-1">
              <span className="text-[var(--adf-ui-text)]">Device name</span>
              <TextInput value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Device name" aria-label="Device name" maxLength={64} autoFocus />
            </label>
            <button type="button" className="text-[var(--adf-ui-accent)] hover:underline" onClick={toCode}>Use a code instead</button>
          </>
        ))}
        {error && <p role="status" className="text-[var(--adf-ui-danger)]">{error}</p>}
        {!created && (
          <div className="flex justify-end gap-2 pt-1">
            {view === 'code' && added
              ? <Button variant="primary" onClick={onClose}>Done</Button>
              : <Button onClick={close}>Cancel</Button>}
            {view === 'token' && <Button variant="primary" loading={busy} onClick={() => void create()}>Create token</Button>}
          </div>
        )}
      </div>
    </Dialog>
  )
}

/** The line of every host-only control with a remote runtime (settings-scopes.md §7). */
export function changeOn(name: string): string {
  return `Change on ${name}.`
}

/** Remote access, Allowed networks and Devices of a remote runtime: changed on that computer only (settings-scopes.md §7). */
export function HostOnlyRemoteAccess({ name }: { name: string }) {
  return (
    <SettingsGroup title="Remote access" docs={DOCS.remoteAccess}>
      <SettingsRow label="Remote access" description={changeOn(name)} />
    </SettingsGroup>
  )
}

// --- Settings → Connections ---------------------------------------------------------------

/** The dialog's message line: what to do now, or why it stopped. */
export function pairMessage(state: RemotePairState | null, hostName: string): { kind: 'ok' | 'error'; text: string } | null {
  if (!state) return null
  if (state.step === 'waiting') return { kind: 'ok', text: state.message ?? `Waiting for ${hostName} to allow this device…` }
  if (state.step === 'paired') return { kind: 'ok', text: state.message ?? `Paired with ${hostName}.` }
  if (state.step === 'claiming') return { kind: 'ok', text: 'Sending the code…' }
  if (state.message) return { kind: state.code ? 'error' : 'ok', text: state.message }
  return null
}
