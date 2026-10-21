/**
 * Remote access in Settings (docs/design/remote-access.md §7, §9.1;
 * settings-scopes.md §6, §7): other devices that use the local agent server.
 *
 * - Studio → Connections → Add → Share (`SharePanel`): the name devices see
 *   ("Share this server as", the runtime alias), what Share needs, in one
 *   sentence naming every network it will listen on, and Allow, which asks
 *   main (REMOTE_ACCESS_SHARE: one native dialog, then remote access on and
 *   each network it named allowed; review A1). Then the 6-digit pairing
 *   code with its countdown (Renew once it is gone), the firewall guidance,
 *   and the addresses: one table, grouped by network, one Copy per row. The
 *   other computer enters the code; this computer still asks Allow device (a
 *   native dialog, remote-access.md §5.4), then "Approved: <name>.". A token
 *   shown once is under Token. Leaving Share with no device added turns
 *   remote access off again when Share turned it on (review A5).
 * - Studio → Connections → Devices (`DevicesGroup`): the Remote access
 *   switch and the devices that can access the local server, each with
 *   Revoke.
 * - Studio → Connections → Add → Connect: pairMessage for the client side
 *   (ConnectionSettings.tsx). Discovery and pairing run in main; the token
 *   never reaches the renderer.
 *
 * Every action goes to main, which asks the daemon. A new device token is
 * shown once, here, and dropped on Done; nothing else here holds a token.
 *
 * Copy: labels are one word or a noun; help text is short sentences, one
 * fact each (ASD-STE100 style). In the UI the runtime is a "server".
 */

import { useEffect, useRef, useState } from 'react'
import { Button, Switch, TextInput } from '../ui'
import { DocsLink } from '../common/DocsLink'
import { DOCS } from '../../../shared/constants/docs-links'
import type { NetworkView, PairingWindowView, RemoteAccessStatus, RemoteDevice, RemoteUrl } from '../../../shared/types/remote-access.types'
import type { RemoteAccessView, RemotePairState } from '../../../shared/types/remote-access-ipc.types'
import { andList, listenPlan, PUBLIC_WARNING, unidentifiedText } from '../../../shared/utils/network-consent-text'
import { PageSection, SectionRow, StateDot } from './page-section'

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
  if (others.length > 0) groups.push({ title: 'Other', urls: others })
  return groups
}

/** Under the address table when an address is plain http. */
export const NOT_ENCRYPTED_WARNING = 'Not encrypted: anyone on that network can read the token.'

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

/** The server Share shares: "this server", or `<name> (Local)` when the page names it (review A6). */
export function sharedRuntime(runtime: string | null | undefined): string {
  return runtime || 'this server'
}

/** Devices' help sentence: "Devices that can access <name> (Local)." */
export function devicesHint(runtime: string | null | undefined): string {
  return `Devices that can access ${sharedRuntime(runtime)}.`
}

/**
 * What Share needs before anything listens (owner decision 2026-10-18 b:
 * never listen without consent, given per network): remote access on, and
 * each current network allowed. The sentence names every current network
 * it will listen on, those allowed earlier too, and the Public warning
 * covers them all (review A2). Null when nothing is needed. Main's dialog
 * (REMOTE_ACCESS_SHARE) is the confirmation.
 */
export function shareConsent(status: RemoteAccessStatus, runtime: string | null = null): { enable: boolean; networks: NetworkView[]; text: string; warning: string | null } | null {
  const plan = listenPlan(status, { allow: true })
  const networks = plan.allow as NetworkView[]
  const enable = !status.enabled
  if (!enable && networks.length === 0) return null
  const here = status.networks.filter((n) => !!n.id).map((n) => n.label)
  const where = here.length > 0 ? ` on ${andList(here)}` : ''
  return {
    enable,
    networks,
    text: `Devices that you pair${where} get full control of ${sharedRuntime(runtime)}, as powerful as your seed phrase.`,
    warning: plan.exposed ? PUBLIC_NETWORK_WARNING : null,
  }
}

/** Shown in Share when leaving keeps remote access on (review A5). */
export const STAYS_ON_LINE = 'Remote access stays on; turn it off in Devices.'

/**
 * Leaving Share (Back, Cancel, closing the dialog) after its Allow: `off`
 * when Share turned remote access on and no device was added (paired or a
 * token), so nothing keeps listening for nobody; `stays` (STAYS_ON_LINE)
 * when Share changed something that stays; null when it changed nothing.
 */
export function shareLeave({ turnedOn, allowed, added }: { turnedOn: boolean; allowed: boolean; added: boolean }): 'off' | 'stays' | null {
  if (turnedOn && !added) return 'off'
  return turnedOn || allowed ? 'stays' : null
}

/** "Approved: <label>." once a device that entered the code is allowed: the newest paired device since Share opened. */
export function addedDeviceLine(before: ReadonlySet<string>, devices: RemoteDevice[]): string | null {
  const added = devices.find((d) => d.origin === 'paired' && !before.has(d.id))
  return added ? `Approved: ${added.label}.` : null
}

/** The line of every host-only control with a remote server (settings-scopes.md §7). */
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

/** Devices' heading summary: "Off", "On", "On · 2 devices"; "Not available" outside Local mode. */
export function devicesSummary(view: RemoteAccessView): string {
  if (!view.available) return 'Not available'
  const status = view.status
  if (!status) return ''
  const n = status.devices.length
  const devices = n > 0 ? ` · ${n} ${n === 1 ? 'device' : 'devices'}` : ''
  return `${status.enabled ? 'On' : 'Off'}${devices}`
}

/** Under Remote access while Studio stops the server at quit (keepDaemonRunning off, Studio started it). */
export const STOPS_WITH_STUDIO = 'When you quit Studio, Studio stops this server. Then devices cannot connect until you start Studio again. To change this, turn on Keep running after Studio quits.'

// --- Presentational parts ----------------------------------------------------------

function EncryptionBadge({ encrypted }: { encrypted: boolean }) {
  return (
    <span className={`whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium ${encrypted ? 'bg-[var(--adf-ui-success-subtle,var(--adf-ui-surface-hover))] text-[var(--adf-ui-success,var(--adf-ui-text))]' : 'bg-[var(--adf-ui-warning-subtle)] text-[var(--adf-ui-text)]'}`}>
      {encrypted ? 'Encrypted' : 'Not encrypted'}
    </span>
  )
}

function copy(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => {})
}

/** Copy, then "Copied" for a moment: the user sees that it worked. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <Button size="compact" variant="ghost" onClick={() => { copy(text); setCopied(true) }} aria-label={label} className="w-16">
      {copied ? 'Copied' : 'Copy'}
    </Button>
  )
}

function LearnMore({ href }: { href: string }) {
  return <DocsLink href={href} label="Learn more" className="ml-1.5 !text-[11px]" />
}

/**
 * Share's addresses (static in tests): one table, grouped by network
 * (Tailscale, each LAN by its name, Other). One row per address: the
 * address, its encryption, and its own Copy, aligned in one column.
 */
export function AddressTable({ status }: { status: Pick<RemoteAccessStatus, 'urls' | 'networks'> }) {
  const groups = groupedUrls(status)
  if (groups.length === 0) return <p className="text-[12px] text-[var(--adf-ui-text-muted)]">No address.</p>
  const plain = status.urls.some((u) => !u.encrypted)
  return (
    <div className="space-y-1.5">
      <div className="overflow-hidden rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)]">
        <table className="w-full border-collapse text-[12px]" aria-label="Addresses">
          {groups.map((g, gi) => (
            <tbody key={g.title} data-address-group={g.title}>
              <tr className={gi > 0 ? 'border-t border-[var(--adf-ui-separator)]' : ''}>
                <th scope="rowgroup" colSpan={3} className="bg-[var(--adf-ui-surface-hover)] px-3 py-1.5 text-left text-[11px] font-semibold text-[var(--adf-ui-text-muted)]">{g.title}</th>
              </tr>
              {orderedUrls(g.urls).map((u) => (
                <tr key={u.url} className="border-t border-[var(--adf-ui-separator)]" data-address={u.url}>
                  <td className="w-full break-all px-3 py-1.5 font-mono text-[12px] text-[var(--adf-ui-text)]">{u.url}</td>
                  <td className="px-2 py-1.5 text-right align-middle"><EncryptionBadge encrypted={u.encrypted} /></td>
                  <td className="py-1 pr-1.5 text-right align-middle"><CopyButton text={u.url} label={`Copy ${u.url}`} /></td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
      {plain && <p className="text-[11px] text-[var(--adf-ui-text-subtle)]">{NOT_ENCRYPTED_WARNING}</p>}
    </div>
  )
}

/** The devices list (static in tests): name, how it was added, last seen, Revoke. */
export function RemoteDeviceList({ devices, busy, onRemove, now }: { devices: RemoteDevice[]; busy: boolean; onRemove: (device: RemoteDevice) => void; now?: number }) {
  if (devices.length === 0) return <SectionRow><span className="text-[var(--adf-ui-text-muted)]">None. To add a device, click Add, then Share.</span></SectionRow>
  return (
    <div>
      {devices.map((d) => (
        <SectionRow key={d.id} data-device={d.id} actions={<Button size="compact" variant="danger" disabled={busy} onClick={() => onRemove(d)}>Revoke</Button>}>
          <div className="text-[13px] font-medium text-[var(--adf-ui-text)]">{d.label}</div>
          <div className="mt-0.5 flex items-center gap-2 text-[var(--adf-ui-text-muted)]">
            <span>{d.origin === 'paired' ? 'Paired' : 'Token'}</span>
            <span aria-hidden="true">·</span>
            {d.connected ? <StateDot tone="ok">{lastSeenText(d, now)}</StateDot> : <span>{lastSeenText(d, now)}</span>}
          </div>
        </SectionRow>
      ))}
    </div>
  )
}

/** Share, code view: the code in large digits, the countdown, the tries left and the fingerprint. */
export function PairingCodePanel({ pairing, fingerprint, now }: { pairing: PairingWindowView; fingerprint: string | null; now?: number }) {
  const print = pairing.fingerprint || fingerprint
  return (
    <div className="space-y-1.5 rounded-[var(--adf-ui-container-radius)] border border-[var(--adf-ui-border)] bg-[var(--adf-ui-canvas)] px-4 py-4 text-center" data-pairing-code="">
      <p className="text-[12px] text-[var(--adf-ui-text-muted)]">Enter this code on the other computer.</p>
      <p className="font-mono text-[40px] font-semibold leading-tight tracking-[0.15em] text-[var(--adf-ui-text)]" aria-label="Pairing code">{formatCode(pairing.code)}</p>
      <p className="text-[12px] text-[var(--adf-ui-text-muted)]">
        Expires in <span className="font-mono tabular-nums text-[var(--adf-ui-text)]">{pairingCountdown(pairing.expiresAt, now)}</span> · {pairing.attemptsLeft} {pairing.attemptsLeft === 1 ? 'try' : 'tries'} left
      </p>
      {print && <p className="text-[11px] text-[var(--adf-ui-text-subtle)]">Fingerprint <span className="font-mono">{print}</span></p>}
      {pairing.lockedSources > 0 && <p className="text-[12px] text-[var(--adf-ui-danger)]">{pairing.lockedSources} {pairing.lockedSources === 1 ? 'device is' : 'devices are'} locked out after 5 wrong codes.</p>}
      {pairing.claim && <p className="text-[12px] font-medium text-[var(--adf-ui-text)]">A device entered the code. Answer the Allow device dialog.</p>}
    </div>
  )
}

/** The new device token, shown once. */
export function NewTokenPanel({ label, token, onDone }: { label: string; token: string; onDone: () => void }) {
  return (
    <div className="space-y-2">
      <div className="text-[12px] text-[var(--adf-ui-text)]">Token for {label}. Studio shows it only one time. It is as powerful as your seed phrase.</div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded border border-[var(--adf-ui-border)] bg-[var(--adf-ui-canvas)] px-2 py-1 text-[12px]">{token}</code>
        <CopyButton text={token} label="Copy token" />
        <Button size="compact" variant="primary" onClick={onDone}>Done</Button>
      </div>
      <div className="text-[11px] text-[var(--adf-ui-text-subtle)]">On the other computer, click Add, then Connect, and enter the token.</div>
    </div>
  )
}

/** Share's consent, inline: one sentence, the Public warning, one explicit Allow. */
export function ShareConsent({ consent, busy, onAllow }: { consent: NonNullable<ReturnType<typeof shareConsent>>; busy: boolean; onAllow: () => void }) {
  return (
    <div className="space-y-2 rounded-[var(--adf-ui-container-radius)] border border-[var(--adf-ui-border)] px-4 py-3" data-share-consent="">
      <p className="leading-5 text-[var(--adf-ui-text)]">{consent.text}<LearnMore href={DOCS.remoteAccessPair} /></p>
      {consent.warning && <p className="text-[11px] text-[var(--adf-ui-danger)]">{consent.warning}</p>}
      <div className="flex justify-end">
        <Button variant="primary" loading={busy} onClick={onAllow}>Allow</Button>
      </div>
    </div>
  )
}

/** A block of Share: a small heading, then its content. */
function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-[12px] font-semibold text-[var(--adf-ui-text)]">{title}</h3>
      {children}
    </section>
  )
}

/** The label of Share's name field (owner wording). */
export const SHARE_AS_LABEL = 'Share this server as'

/** Under the name field. The name is the runtime alias: one name everywhere. */
export const SHARE_AS_HELP = 'Devices see this server by this name. It is also the alias in Settings → Identity.'

/** Share's name field (static in tests): saved on Enter or when the field loses focus. */
export function ShareNameField({ name, draft, busy, note, onDraft, onSave }: {
  name: string
  draft: string | null
  busy: boolean
  note: { kind: 'ok' | 'error'; text: string } | null
  onDraft: (draft: string) => void
  onSave: () => void
}) {
  const value = draft ?? name
  return (
    <div className="space-y-1">
      <label className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[12px] font-medium text-[var(--adf-ui-text)]">{SHARE_AS_LABEL}</span>
        <TextInput
          value={value}
          onChange={(e) => onDraft(e.target.value)}
          onBlur={onSave}
          onKeyDown={(e) => { if (e.key === 'Enter') onSave() }}
          disabled={busy}
          maxLength={63}
          spellCheck={false}
          aria-label={SHARE_AS_LABEL}
          className="min-w-0 flex-1"
        />
      </label>
      <p className="text-[11px] text-[var(--adf-ui-text-subtle)]">{SHARE_AS_HELP}</p>
      {note && <p role="status" className={`text-[11px] ${note.kind === 'error' ? 'text-[var(--adf-ui-danger)]' : 'text-[var(--adf-ui-text-muted)]'}`}>{note.text}</p>}
    </div>
  )
}

// --- Add → Share -------------------------------------------------------------------

type ActResult = { ok: true; view: RemoteAccessView } | { ok: false; code: string; error: string }

/**
 * Add → Share: other devices use this server. Asks consent inline when
 * remote access is off or a current network is not allowed (never listens
 * without it), then shows the code and the addresses, and opens a pairing
 * window. The claim is still allowed or denied on this computer (Allow
 * device).
 */
export function SharePanel({ runtime = null, onBack, onDone }: { runtime?: string | null; onBack: () => void; onDone: () => void }) {
  const [view, setView] = useState<RemoteAccessView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [label, setLabel] = useState('')
  const [created, setCreated] = useState<{ label: string; token: string } | null>(null)
  const [nameDraft, setNameDraft] = useState<string | null>(null)
  const [nameNote, setNameNote] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  // Share opened a pairing window (Renew once it is gone), and what its Allow changed (review A3, A5).
  const [opened, setOpened] = useState(false)
  const [turnedOn, setTurnedOn] = useState(false)
  const [allowed, setAllowed] = useState(false)
  const before = useRef<ReadonlySet<string> | null>(null)
  const openedRef = useRef(false)

  useEffect(() => {
    let alive = true
    window.adfApi?.getRemoteAccess?.().then((v) => { if (alive) setView(v) }).catch(() => {})
    const off = window.adfApi?.onRemoteAccessChanged?.((change) => setView(change.view))
    const timer = setInterval(() => { window.adfApi?.getRemoteAccess?.().then((v) => { if (alive) setView(v) }).catch(() => {}) }, 5_000)
    return () => { alive = false; off?.(); clearInterval(timer) }
  }, [])

  const status = view?.status ?? null
  if (status && before.current === null) before.current = new Set(status.devices.map((d) => d.id))
  const consent = status ? shareConsent(status, runtime) : null
  const approved = status && before.current ? addedDeviceLine(before.current, status.devices) : null
  const pairing = status?.pairing ?? null
  const leave = shareLeave({ turnedOn, allowed, added: !!approved || !!created })
  const approvedRef = useRef(false)
  approvedRef.current = !!approved
  const leaveRef = useRef(leave)
  leaveRef.current = leave

  // Leaving Share: the pairing window it opened closes unless a computer claimed it; remote access goes off again
  // when Share turned it on and no device was added (review A5). Main logs both; the Devices switch shows it.
  useEffect(() => () => {
    if (openedRef.current && !approvedRef.current) void window.adfApi?.closeRemotePairing?.().catch(() => {})
    if (leaveRef.current === 'off') void window.adfApi?.setRemoteAccess({ enabled: false }).catch(() => {})
  }, [])

  const openPairing = () => {
    openedRef.current = true
    setOpened(true)
    void act(() => window.adfApi.openRemotePairing())
  }
  // Once it listens: the code (the existing pairing window), opened for this Share; afterwards Renew (review A3).
  useEffect(() => {
    if (!status || consent || approved || openedRef.current || !canAddDevice(status) || status.pairing) return
    openPairing()
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
      setError('Studio could not reach the server.')
      return false
    } finally {
      setBusy(false)
    }
  }
  // Allow asks main: one native dialog naming every network, then on and those networks allowed (review A1).
  const allow = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await window.adfApi.shareRemoteAccess()
      if (result.turnedOn) setTurnedOn(true)
      if (result.ok) { setView(result.view); setAllowed(true) }
      else if (result.code !== 'cancelled') setError(result.error)
    } catch {
      setError('Studio could not reach the server.')
    } finally {
      setBusy(false)
    }
  }
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
  /** The name devices see (the runtime alias): saved when changed, "Saved." or the refusal under the field. */
  const saveName = async () => {
    const next = nameDraft?.trim() ?? ''
    if (!status || nameDraft === null || !next || next === status.name) { setNameDraft(null); return }
    setBusy(true)
    setNameNote(null)
    try {
      const result = await window.adfApi.setRemoteAccess({ name: next })
      if (result.ok) { setView(result.view); setNameDraft(null); setNameNote({ kind: 'ok', text: 'Saved.' }) }
      else if (result.code !== 'cancelled') setNameNote({ kind: 'error', text: result.error })
    } catch {
      setNameNote({ kind: 'error', text: 'Studio could not reach the server.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <SharePanelView
      view={view}
      runtime={runtime}
      busy={busy}
      error={error}
      now={now}
      opened={opened}
      leave={leave}
      approved={approved}
      label={label}
      created={created}
      nameDraft={nameDraft}
      nameNote={nameNote}
      onName={setNameDraft}
      onSaveName={() => void saveName()}
      onLabel={setLabel}
      onAllow={() => void allow()}
      onRenew={openPairing}
      onCreateToken={() => void createToken()}
      onBack={onBack}
      onDone={onDone}
    />
  )
}

/** Share's markup (static in tests). */
export function SharePanelView({ view, runtime = null, busy, error, now, opened = false, leave = null, approved, label, created, nameDraft = null, nameNote = null, onName = () => {}, onSaveName = () => {}, onLabel, onAllow, onRenew, onCreateToken, onBack, onDone }: {
  view: RemoteAccessView | null
  /** `<name> (Local)` while there is more than one server (review A6). */
  runtime?: string | null
  busy: boolean
  error: string | null
  now?: number
  /** Share opened a pairing window: once it is gone (expired, wrong codes, a failed open), Renew (review A3). */
  opened?: boolean
  /** What leaving does (shareLeave): `stays` shows STAYS_ON_LINE (review A5). */
  leave?: 'off' | 'stays' | null
  approved: string | null
  label: string
  created: { label: string; token: string } | null
  nameDraft?: string | null
  nameNote?: { kind: 'ok' | 'error'; text: string } | null
  onName?: (draft: string) => void
  onSaveName?: () => void
  onLabel: (label: string) => void
  onAllow: () => void
  onRenew: () => void
  onCreateToken: () => void
  onBack: () => void
  onDone: () => void
}) {
  const status = view?.status ?? null
  const consent = status ? shareConsent(status, runtime) : null
  const pairing = status?.pairing ?? null
  const expired = !!pairing && pairingCountdown(pairing.expiresAt, now) === '0:00'
  const firewall = status && status.firewall.state !== 'ok' && (status.firewall.message || status.firewall.commands.length > 0) ? status.firewall : null
  return (
    <div className="space-y-4 text-[12px]">
      {!view && <p className="text-[var(--adf-ui-text-muted)]">Loading…</p>}
      {view && !view.available && <p className="text-[var(--adf-ui-text-muted)]">{view.unavailableReason}</p>}
      {view?.available && !status && <p className="text-[var(--adf-ui-danger)]">{view.error ?? 'Studio could not read remote access.'}</p>}
      {status && <ShareNameField name={status.name} draft={nameDraft} busy={busy} note={nameNote} onDraft={onName} onSave={onSaveName} />}
      {status && consent && <ShareConsent consent={consent} busy={busy} onAllow={onAllow} />}
      {status?.networks.filter((n) => !n.id).map((n) => (
        <p key={`unidentified:${n.kind}:${n.ifaces.join(',')}`} className="text-[var(--adf-ui-text-muted)]">
          {unidentifiedText(n.problem)}<DocsLink href={DOCS.unidentifiedNetwork} label="Help" className="ml-1.5 !text-[11px]" />
        </p>
      ))}
      {status && !consent && (
        <>
          <Block title="Code">
            {approved
              ? <p className="rounded-[var(--adf-ui-container-radius)] border border-[var(--adf-ui-border)] px-4 py-3 text-[13px] font-medium text-[var(--adf-ui-text)]">{approved}</p>
              : pairing && !expired
                ? <PairingCodePanel pairing={pairing} fingerprint={status.fingerprint} now={now} />
                : canAddDevice(status)
                  ? (
                    <div className="flex items-center justify-between gap-2 rounded-[var(--adf-ui-container-radius)] border border-[var(--adf-ui-border)] px-4 py-3">
                      <span className="text-[var(--adf-ui-text-muted)]">{pairing ? 'The code expired.' : opened ? 'No code.' : 'Opening…'}</span>
                      {(pairing || opened) && <Button size="compact" disabled={busy} onClick={onRenew}>Renew</Button>}
                    </div>
                  )
                  : <p className="text-[var(--adf-ui-text-muted)]">{remoteStatusLine(status)}</p>}
          </Block>
          {firewall && (
            <Block title="Firewall">
              <div className={`space-y-1 text-[11px] ${firewall.state === 'blocked' ? 'text-[var(--adf-ui-danger)]' : 'text-[var(--adf-ui-text-subtle)]'}`}>
                {firewall.message && <p>{firewall.message}</p>}
                {firewall.commands.length > 0 && <ul className="space-y-0.5 rounded border border-[var(--adf-ui-border)] bg-[var(--adf-ui-canvas)] px-2 py-1 font-mono text-[var(--adf-ui-text)]">{firewall.commands.map((c) => <li key={c} className="break-all">{c}</li>)}</ul>}
              </div>
            </Block>
          )}
          <Block title="Addresses">
            <AddressTable status={status} />
          </Block>
          {!approved && (
            <details className="text-[12px]">
              <summary className="cursor-pointer select-none font-semibold text-[var(--adf-ui-text)]">Token</summary>
              <div className="mt-2 space-y-2">
                {created ? <NewTokenPanel label={created.label} token={created.token} onDone={onDone} /> : (
                  <>
                    <p className="text-[var(--adf-ui-text-muted)]">A token connects a device without a code, for example a script or the ADF CLI.</p>
                    <div className="flex items-end gap-2">
                      <label className="block flex-1 space-y-1">
                        <span className="font-medium text-[var(--adf-ui-text)]">Device</span>
                        <TextInput value={label} onChange={(e) => onLabel(e.target.value)} placeholder="laptop-1" aria-label="Device name" maxLength={64} />
                      </label>
                      <Button disabled={busy} onClick={onCreateToken}>Create</Button>
                    </div>
                  </>
                )}
              </div>
            </details>
          )}
        </>
      )}
      {error && <p role="status" className="text-[var(--adf-ui-danger)]">{error}</p>}
      {leave === 'stays' && <p className="text-[var(--adf-ui-text-muted)]">{STAYS_ON_LINE}</p>}
      <div className="flex justify-end gap-2 border-t border-[var(--adf-ui-separator)] pt-3">
        <Button onClick={onBack}>Back</Button>
        {approved || created ? <Button variant="primary" onClick={onDone}>Done</Button> : <Button onClick={onDone}>Cancel</Button>}
      </div>
    </div>
  )
}

// --- Studio → Connections → Devices -------------------------------------------------

/**
 * Devices: the Remote access switch (turning it on asks in a native dialog,
 * remote-access.md §7) and the devices that can access the local server,
 * each with Revoke. Only in Local mode; otherwise the reason.
 */
export function DevicesGroup({ runtime = null }: { runtime?: string | null }) {
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
      setMessage({ kind: 'error', text: 'Studio could not reach the server.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <DevicesGroupView
      runtime={runtime}
      view={view}
      busy={busy}
      message={message}
      now={now}
      onSwitch={(next) => void act(() => window.adfApi.setRemoteAccess({ enabled: next }))}
      onRevoke={(d) => void act(() => window.adfApi.removeRemoteDevice(d.id))}
    />
  )
}

/** Devices' markup (static in tests): collapsed while remote access is off and no device is listed. */
export function DevicesGroupView({ view, runtime = null, busy, message, now, onSwitch, onRevoke }: {
  view: RemoteAccessView | null
  /** The local server, `<name> (Local)`. */
  runtime?: string | null
  busy: boolean
  message: { kind: 'ok' | 'error'; text: string } | null
  now?: number
  onSwitch: (next: boolean) => void
  onRevoke: (device: RemoteDevice) => void
}) {
  if (!view) return null
  const status = view.status
  const enabled = status?.enabled === true
  const open = enabled || (status?.devices.length ?? 0) > 0
  return (
    <PageSection id="devices" title="Devices" help={devicesHint(runtime)} summary={devicesSummary(view)} docs={DOCS.remoteAccessDevices} collapsible open={open}>
      <SectionRow actions={<Switch label="Remote access" checked={enabled} disabled={!view.available || busy || !status} onChange={onSwitch} />}>
        <div className="text-[13px] font-medium text-[var(--adf-ui-text)]">Remote access</div>
        <div className="mt-0.5 leading-5 text-[var(--adf-ui-text-muted)]">Devices that you pair can connect to {sharedRuntime(runtime)}.</div>
        {(view.available ? (status ? remoteStatusLine(status) : null) : view.unavailableReason) && (
          <div className="mt-1 text-[11px] text-[var(--adf-ui-text-subtle)]">{view.available ? (status ? remoteStatusLine(status) : null) : view.unavailableReason}</div>
        )}
        {view.error && <div className="mt-1 text-[11px] text-[var(--adf-ui-danger)]">{view.error}</div>}
        {enabled && view.stopsWithStudio && <div className="mt-1 text-[11px] text-[var(--adf-ui-text-muted)]" data-stops-with-studio="">{STOPS_WITH_STUDIO}</div>}
      </SectionRow>
      {status && <RemoteDeviceList devices={status.devices} busy={busy} now={now} onRemove={onRevoke} />}
      {message && (
        <SectionRow>
          <span role="status" className={message.kind === 'error' ? 'text-[var(--adf-ui-danger)]' : 'text-[var(--adf-ui-text-muted)]'}>{message.text}</span>
        </SectionRow>
      )}
    </PageSection>
  )
}
