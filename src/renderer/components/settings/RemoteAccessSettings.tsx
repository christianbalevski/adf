/**
 * Remote access in Settings (docs/design/remote-access.md §7, §9.1):
 *
 * - Settings → Networking: `NetworkStatusLine` (the network the mesh and
 *   remote access both use) and `RemoteAccessGroup`, the host side (local
 *   mode). Every action goes to main, which asks the daemon and confirms in
 *   a native dialog where the design says so. A new device token is shown
 *   once, here, and dropped on Done; nothing else here holds a token.
 * - Settings → Backend: `RemoteAccessSummary` (one line and a link), and the
 *   client side under Remote computer, `DiscoveredRow` and `PairDialog`.
 *   Discovery and pairing run in main; the token never reaches the renderer.
 *
 * Copy (owner rule 2026-10-18): headings, labels, buttons and dialog titles
 * are plain nouns or short verb phrases; at most one short sentence under a
 * heading; the rest is behind Learn more.
 */

import { useEffect, useRef, useState } from 'react'
import { Button, SettingsGroup, SettingsRow, TextInput } from '../ui'
import { Dialog } from '../common/Dialog'
import { DocsLink } from '../common/DocsLink'
import { DOCS } from '../../../shared/constants/docs-links'
import type { PairingWindowView, RemoteAccessStatus, RemoteDevice, RemoteUrl } from '../../../shared/types/remote-access.types'
import type { NetworkStatusView, RemoteAccessView, RemoteDiscoveryEntry, RemoteDiscoveryUpdate, RemotePairState } from '../../../shared/types/remote-access-ipc.types'
import type { MeshAgentStatus } from '../../../shared/types/ipc.types'

// --- Pure helpers (tested) ------------------------------------------------------

/** Remote access's own line (§8; owner decision 4 for a Public network). */
export function remoteStatusLine(status: RemoteAccessStatus): string {
  if (!status.enabled) return 'Off.'
  if (status.firewall.state === 'public_network') return 'Not reachable on this network (Public).'
  if (status.state === 'on') {
    const listening = status.addresses.filter((a) => a.listening).map((a) => a.address)
    return listening.length > 0 ? `Listening on ${listening.join(', ')}.` : 'On.'
  }
  return status.message || status.problem || 'Off.'
}

/** "On · 2 devices" (Settings → Backend's one line). */
export function remoteSummary(view: RemoteAccessView | null): string {
  const status = view?.status
  if (!view?.available || !status) return 'Off'
  if (!status.enabled) return 'Off'
  const n = status.devices.length
  return `On · ${n} ${n === 1 ? 'device' : 'devices'}`
}

/** The status line at the top of Settings → Networking. */
export function networkStatusText(view: NetworkStatusView): string {
  const parts: string[] = []
  const lan = view.lan[0]
  if (view.network === 'none') parts.push('Network: no LAN address')
  else parts.push(`Network: ${view.network === 'private' ? 'Private' : 'Public'}${lan ? ` (${lan.iface})` : ''}`)
  if (view.lan.length > 0) parts.push(`LAN ${view.lan.map((a) => a.address).join(', ')}${view.network === 'public' ? ', not listening' : ''}`)
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
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${encrypted ? 'bg-[var(--adf-ui-success-subtle,var(--adf-ui-surface-hover))] text-[var(--adf-ui-success,var(--adf-ui-text))]' : 'bg-[var(--adf-ui-warning-subtle)] text-[var(--adf-ui-text)]'}`}>
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

/** "Pair device": the code in large digits, the countdown and the tries left. */
export function PairingCodePanel({ pairing, fingerprint, now }: { pairing: PairingWindowView; fingerprint: string | null; now?: number }) {
  return (
    <div className="space-y-3 text-center">
      <p className="text-[12px] text-[var(--adf-ui-text-muted)]">Enter this code on the device.</p>
      <p className="font-mono text-[40px] font-semibold tracking-[0.15em] text-[var(--adf-ui-text)]" aria-label="Pairing code">{formatCode(pairing.code)}</p>
      <p className="text-[12px] text-[var(--adf-ui-text-muted)]">
        Expires in {pairingCountdown(pairing.expiresAt, now)} · {pairing.attemptsLeft} {pairing.attemptsLeft === 1 ? 'try' : 'tries'} left
        {(pairing.fingerprint || fingerprint) ? <> · Fingerprint {pairing.fingerprint || fingerprint}</> : null}
      </p>
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
      <div className="text-[11px] text-[var(--adf-ui-text-subtle)]">On the device: Settings → Backend → Remote computer.</div>
    </div>
  )
}

// --- Settings → Networking -----------------------------------------------------------

/** One line: network category, LAN address, Tailscale, firewall. Mesh and remote access both follow it. */
export function NetworkStatusLine() {
  const [view, setView] = useState<NetworkStatusView | null>(null)
  const [canMark, setCanMark] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const load = () => {
    window.adfApi?.getNetworkStatus?.().then(setView).catch(() => {})
    window.adfApi?.getRemoteAccess?.().then((v) => setCanMark(v.available)).catch(() => {})
  }
  useEffect(() => {
    load()
    const timer = setInterval(load, 10_000)
    return () => clearInterval(timer)
  }, [])
  if (!view?.available) return null
  const mark = async () => {
    setNote(null)
    const result = await window.adfApi.setRemoteAccess({ trustNetwork: true })
    if (!result.ok) setNote(result.error)
    load()
  }
  return (
    <div role="status" className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] px-3 py-2 text-[12px] text-[var(--adf-ui-text)]">
      <span>{networkStatusText(view)}<LearnMore href={DOCS.networkingStatus} /></span>
      {view.network === 'public' && view.markable && canMark && <Button size="compact" onClick={() => void mark()}>Mark private</Button>}
      {(view.firewall.state === 'blocked' || view.problem || note) && (
        <span className="w-full text-[11px] text-[var(--adf-ui-danger)]">{note ?? (view.firewall.state === 'blocked' ? view.firewall.message : view.problem)}</span>
      )}
    </div>
  )
}

export function RemoteAccessGroup({ onKeepRunning }: { onKeepRunning: () => Promise<void> }) {
  const [view, setView] = useState<RemoteAccessView | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  /** "Add device": the name being typed, then the token shown once. */
  const [adding, setAdding] = useState<string | null>(null)
  const [created, setCreated] = useState<{ label: string; token: string } | null>(null)
  const [pairingShown, setPairingShown] = useState(false)
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
  useEffect(() => { if (!pairing) setPairingShown(false) }, [pairing])

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

  const addDevice = async () => {
    setBusy(true)
    setMessage(null)
    try {
      const result = await window.adfApi.addRemoteDevice(adding ?? '')
      if (result.ok) {
        setView(result.view)
        setCreated({ label: result.device.label, token: result.token })
        setAdding(null)
      } else {
        setMessage({ kind: 'error', text: result.error })
      }
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
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            disabled={disabled || !status}
            onChange={(event) => void act(() => window.adfApi.setRemoteAccess({ enabled: event.target.checked }))}
            className="rounded text-blue-500"
            aria-label="Remote access"
          />
          <span className="text-[12px] text-[var(--adf-ui-text-muted)]">{enabled ? 'On' : 'Off'}</span>
        </label>
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
          <SettingsRow stacked separator label="Devices" description={<>Pair with a code, or add with a token.<LearnMore href={DOCS.remoteAccessPair} /></>}>
            {created ? (
              <NewTokenPanel label={created.label} token={created.token} onDone={() => setCreated(null)} />
            ) : adding !== null ? (
              <div className="flex items-center gap-2">
                <TextInput value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="Device name" aria-label="Device name" maxLength={64} autoFocus />
                <Button size="compact" variant="primary" loading={busy} onClick={() => void addDevice()}>Create token</Button>
                <Button size="compact" disabled={busy} onClick={() => setAdding(null)}>Cancel</Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Button size="compact" variant="primary" disabled={busy} onClick={() => { setPairingShown(true); if (!pairing) void act(() => window.adfApi.openRemotePairing()) }}>Pair device</Button>
                <Button size="compact" disabled={busy} onClick={() => setAdding('')}>Add device</Button>
              </div>
            )}
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
      <Dialog
        open={!!pairing && pairingShown}
        title="Pair device"
        lightDismiss={false}
        onClose={() => { setPairingShown(false); if (pairing) void act(() => window.adfApi.closeRemotePairing()) }}
      >
        {pairing && status && <PairingCodePanel pairing={pairing} fingerprint={status.fingerprint} now={now} />}
        <div className="mt-4 flex justify-end">
          <Button onClick={() => { setPairingShown(false); void act(() => window.adfApi.closeRemotePairing()) }}>Cancel</Button>
        </div>
      </Dialog>
    </SettingsGroup>
  )
}

// --- Settings → Backend ----------------------------------------------------------------

/** This computer: one line, "Remote access: On · 2 devices", and a link to Networking. */
export function RemoteAccessSummary({ onOpenNetworking }: { onOpenNetworking: () => void }) {
  const [view, setView] = useState<RemoteAccessView | null>(null)
  useEffect(() => {
    window.adfApi?.getRemoteAccess?.().then(setView).catch(() => {})
    return window.adfApi?.onRemoteAccessChanged?.((change) => setView(change.view))
  }, [])
  if (!view?.available) return null
  return (
    <SettingsRow separator label="Remote access" description={remoteSummary(view)}>
      <Button size="compact" onClick={onOpenNetworking}>Open Networking</Button>
    </SettingsRow>
  )
}

/** One computer found, as the list shows it. */
export function DiscoveredList({ update, onPair }: { update: RemoteDiscoveryUpdate | null; onPair: (entry: RemoteDiscoveryEntry) => void }) {
  if (!update) return <p className="text-[12px] text-[var(--adf-ui-text-muted)]">Looking…</p>
  return (
    <div className="space-y-1.5">
      {update.entries.length === 0 && <p className="text-[12px] text-[var(--adf-ui-text-muted)]">None yet. Turn on Remote access on the other computer.</p>}
      <ul className="divide-y divide-[var(--adf-ui-separator)]">
        {update.entries.map((e) => (
          <li key={e.fingerprint} className="flex items-center justify-between gap-3 py-1.5">
            <div className="min-w-0 text-[12px]">
              <div className="flex flex-wrap items-center gap-2 font-medium text-[var(--adf-ui-text)]">
                {e.name}
                <EncryptionBadge encrypted={e.encrypted} />
                {e.alreadyPaired && <span className="text-[11px] font-normal text-[var(--adf-ui-text-muted)]">Paired</span>}
                {!e.alreadyPaired && e.pairingOpen && <span className="text-[11px] font-normal text-[var(--adf-ui-accent)]">Pairing open</span>}
              </div>
              <div className="text-[var(--adf-ui-text-muted)]">{e.address} · {e.fingerprint}</div>
            </div>
            <Button size="compact" onClick={() => onPair(e)}>Pair</Button>
          </li>
        ))}
      </ul>
      {update.problem && <p className="text-[11px] text-[var(--adf-ui-text-subtle)]">{update.problem}</p>}
    </div>
  )
}

export function DiscoveredRow({ onPaired, onSwitch }: { onPaired: () => void; onSwitch: () => void }) {
  const [update, setUpdate] = useState<RemoteDiscoveryUpdate | null>(null)
  const [pairWith, setPairWith] = useState<RemoteDiscoveryEntry | null>(null)
  useEffect(() => {
    const off = window.adfApi?.onRemoteDiscoveryUpdate?.(setUpdate)
    void window.adfApi?.startRemoteDiscovery?.().catch(() => {})
    return () => { off?.(); void window.adfApi?.stopRemoteDiscovery?.().catch(() => {}) }
  }, [])
  return (
    <>
      <SettingsRow stacked label="Discovered" description={<>Computers with remote access on.<LearnMore href={DOCS.remoteAccessDiscovered} /></>}>
        <DiscoveredList update={update} onPair={setPairWith} />
      </SettingsRow>
      {pairWith && <PairDialog entry={pairWith} onClose={() => setPairWith(null)} onPaired={onPaired} onSwitch={() => { setPairWith(null); onSwitch() }} />}
    </>
  )
}

/** The dialog's message line: what to do now, or why it stopped. */
export function pairMessage(state: RemotePairState | null, hostName: string): { kind: 'ok' | 'error'; text: string } | null {
  if (!state) return null
  if (state.step === 'waiting') return { kind: 'ok', text: state.message ?? `Waiting for ${hostName} to allow this device…` }
  if (state.step === 'paired') return { kind: 'ok', text: state.message ?? `Paired with ${hostName}.` }
  if (state.step === 'claiming') return { kind: 'ok', text: 'Sending the code…' }
  if (state.message) return { kind: state.code ? 'error' : 'ok', text: state.message }
  return null
}

export function PairDialog({ entry, onClose, onPaired, onSwitch }: { entry: RemoteDiscoveryEntry; onClose: () => void; onPaired: () => void; onSwitch: () => void }) {
  const [deviceName, setDeviceName] = useState('')
  const [trusted, setTrusted] = useState(false)
  const [code, setCode] = useState('')
  const [state, setState] = useState<RemotePairState | null>(null)
  const [mismatch, setMismatch] = useState<string | null>(null)
  const paired = useRef(false)

  useEffect(() => window.adfApi?.onRemotePairingState?.((next) => {
    if (next.host && next.host.url !== entry.url) return
    setState(next)
    if (next.step === 'paired' && !paired.current) { paired.current = true; onPaired() }
  }), [entry.url, onPaired])

  const step = state?.step ?? null
  const working = step === 'claiming' || step === 'waiting'
  const done = step === 'paired'
  const codeEnabled = (entry.encrypted || trusted) && !working && !done

  const pair = async () => {
    setMismatch(null)
    let current = state
    if (!current || current.step !== 'need_code' || current.host?.url !== entry.url) {
      current = await window.adfApi.startRemotePairing({ url: entry.url, ...(deviceName.trim() ? { deviceName: deviceName.trim() } : {}), allowInsecureHttp: !entry.encrypted && trusted })
      setState(current)
      if (current.step !== 'need_code' || current.code) return
      if (current.host && current.host.fingerprint !== entry.fingerprint) {
        await window.adfApi.cancelRemotePairing()
        setMismatch(`${entry.address} now answers as another computer (${current.host.fingerprint}). Pair from the list again.`)
        return
      }
    }
    setState(await window.adfApi.submitRemotePairingCode(code.replace(/\s/g, '')))
  }
  const close = () => {
    if (working || step === 'need_code') void window.adfApi.cancelRemotePairing()
    onClose()
  }
  const message = mismatch ? { kind: 'error' as const, text: mismatch } : pairMessage(state, entry.name)

  return (
    <Dialog open title="Pair" onClose={close} lightDismiss={false}>
      <div className="space-y-3 text-[12px]">
        <p className="text-[var(--adf-ui-text-muted)]">{entry.name} at {entry.address}, fingerprint {entry.fingerprint}. Check that the host shows the same fingerprint.</p>
        {!done && (
          <>
            <label className="block space-y-1">
              <span className="text-[var(--adf-ui-text)]">Device name</span>
              <TextInput value={deviceName} onChange={(e) => setDeviceName(e.target.value)} placeholder="Runtime alias or host name" maxLength={64} disabled={working} aria-label="Device name" />
            </label>
            {!entry.encrypted && (
              <label className="flex items-center gap-2 cursor-pointer text-[var(--adf-ui-text-muted)]">
                <input type="checkbox" checked={trusted} disabled={working} onChange={(e) => setTrusted(e.target.checked)} className="rounded text-blue-500" />
                I trust this network; the token is sent unencrypted.
              </label>
            )}
            <label className="block space-y-1">
              <span className="text-[var(--adf-ui-text)]">Code</span>
              <TextInput value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" maxLength={7} placeholder="123 456" disabled={!codeEnabled} aria-label="Pairing code" className="font-mono text-[18px] tracking-[0.2em]" />
            </label>
          </>
        )}
        {message && <p role="status" className={message.kind === 'error' ? 'text-[var(--adf-ui-danger)]' : 'text-[var(--adf-ui-text-muted)]'}>{message.text}</p>}
        <div className="flex justify-end gap-2 pt-1">
          {done ? (
            <>
              <Button onClick={onClose}>Done</Button>
              <Button variant="primary" onClick={onSwitch}>Switch to This Daemon</Button>
            </>
          ) : (
            <>
              <Button onClick={close}>Cancel</Button>
              <Button variant="primary" disabled={!codeEnabled || code.replace(/\s/g, '').length !== 6} loading={working} onClick={() => void pair()}>Pair</Button>
            </>
          )}
        </div>
      </div>
    </Dialog>
  )
}
