/**
 * Settings → Backend, "Allow other computers to connect"
 * (docs/design/remote-access.md §7, §9.1):
 *
 * - `ThisComputerGroup`: the host panel (local mode). Every action goes to
 *   main, which asks the daemon and confirms in a native dialog where the
 *   design says so. A new device token is shown once, here, and dropped on
 *   Done; nothing else here ever holds a token.
 * - `FoundOnNetwork` and `PairDialog`: the client side under Remote
 *   computer. Discovery and pairing run in main; the token never reaches
 *   the renderer.
 *
 * Copy is short: a label and at most one sentence per row, with Learn more
 * linking to the guide (owner feedback 2026-10-18).
 */

import { useEffect, useRef, useState } from 'react'
import { Button, SettingsGroup, SettingsRow, TextInput } from '../ui'
import { Dialog } from '../common/Dialog'
import { DocsLink } from '../common/DocsLink'
import { DOCS } from '../../../shared/constants/docs-links'
import type { PairingWindowView, RemoteAccessStatus, RemoteDevice, RemoteUrl } from '../../../shared/types/remote-access.types'
import type { RemoteAccessView, RemoteDiscoveryEntry, RemoteDiscoveryUpdate, RemotePairState } from '../../../shared/types/remote-access-ipc.types'

// --- Pure helpers (tested) ------------------------------------------------------

/** The status line (§8; owner decision 4 for a Public network). */
export function remoteStatusLine(status: RemoteAccessStatus): string {
  if (!status.enabled) return 'Not reachable from other computers.'
  if (status.firewall.state === 'public_network') return 'Not reachable on this network (Public).'
  if (status.state === 'on') {
    const listening = status.addresses.filter((a) => a.listening).map((a) => a.address)
    return listening.length > 0 ? `Reachable from other computers at ${listening.join(', ')}.` : 'Reachable from other computers.'
  }
  return status.message || status.problem || 'Not reachable from other computers.'
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

// --- Host: presentational parts ---------------------------------------------------

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

export function RemoteAddressList({ urls }: { urls: RemoteUrl[] }) {
  if (urls.length === 0) return <p className="text-[12px] text-[var(--adf-ui-text-muted)]">No address yet.</p>
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
  if (devices.length === 0) return <p className="text-[12px] text-[var(--adf-ui-text-muted)]">No computers yet.</p>
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

/** "Pair a computer": the code in large digits, the countdown and the tries left. */
export function PairingCodePanel({ pairing, name, fingerprint, now }: { pairing: PairingWindowView; name: string; fingerprint: string | null; now?: number }) {
  return (
    <div className="space-y-3 text-center">
      <p className="text-[12px] text-[var(--adf-ui-text-muted)]">On the other computer, choose Pair next to {name} and enter:</p>
      <p className="font-mono text-[40px] font-semibold tracking-[0.15em] text-[var(--adf-ui-text)]" aria-label="Pairing code">{formatCode(pairing.code)}</p>
      <p className="text-[12px] text-[var(--adf-ui-text-muted)]">
        Expires in {pairingCountdown(pairing.expiresAt, now)} · {pairing.attemptsLeft} {pairing.attemptsLeft === 1 ? 'try' : 'tries'} left
        {fingerprint ? <> · Fingerprint {fingerprint}</> : null}
      </p>
      {pairing.claim && <p className="text-[12px] text-[var(--adf-ui-text)]">{pairing.claim.deviceName} entered the code. Answer the question Studio shows.</p>}
    </div>
  )
}

/** The new device token, shown once. */
export function NewTokenPanel({ label, token, onDone }: { label: string; token: string; onDone: () => void }) {
  return (
    <div className="space-y-2">
      <div className="text-[12px] text-[var(--adf-ui-text)]">Token for {label}. Shown once; it is as powerful as your seed phrase.</div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded border border-[var(--adf-ui-border)] bg-[var(--adf-ui-canvas)] px-2 py-1 text-[12px]">{token}</code>
        <Button size="compact" onClick={() => copy(token)}>Copy</Button>
        <Button size="compact" variant="primary" onClick={onDone}>Done</Button>
      </div>
      <div className="text-[11px] text-[var(--adf-ui-text-subtle)]">On that computer: Settings → Backend → Remote computer, then paste an address and this token.</div>
    </div>
  )
}

// --- Host: This computer -----------------------------------------------------------

function LearnMore({ href }: { href: string }) {
  return <DocsLink href={href} label="Learn more" className="ml-1.5 !text-[11px]" />
}

export function ThisComputerGroup({ onKeepRunning }: { onKeepRunning: () => Promise<void> }) {
  const [view, setView] = useState<RemoteAccessView | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  /** "Add a computer": the label being typed, then the token shown once. */
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
    <SettingsGroup title="This computer" description="Let your other computers use the agents on this computer." docs={DOCS.backendAllowConnections}>
      <SettingsRow
        label="Allow other computers to connect"
        description={<>They get full control: a token is as powerful as your seed phrase.<LearnMore href={DOCS.backendAllowConnections} /></>}
        help={view.available ? undefined : view.unavailableReason ?? undefined}
        error={view.error ?? undefined}
      >
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            disabled={disabled || !status}
            onChange={(event) => void act(() => window.adfApi.setRemoteAccess({ enabled: event.target.checked }))}
            className="rounded text-blue-500"
            aria-label="Allow other computers to connect"
          />
          <span className="text-[12px] text-[var(--adf-ui-text-muted)]">{enabled ? 'On' : 'Off'}</span>
        </label>
      </SettingsRow>
      {status && (
        <SettingsRow
          separator
          label="Status"
          description={remoteStatusLine(status)}
          help={status.enabled ? `${status.name}${status.fingerprint ? ` · fingerprint ${status.fingerprint}` : ''}` : undefined}
          error={status.firewall.state === 'blocked' ? status.firewall.message : status.mdns.problem ?? undefined}
        />
      )}
      {enabled && view.stopsWithStudio && (
        <SettingsRow separator label="When Studio quits" description="Other computers lose the connection when Studio quits.">
          <Button size="compact" disabled={busy} onClick={() => void onKeepRunning().then(() => window.adfApi.getRemoteAccess()).then(setView).catch(() => {})}>Keep Running When Studio Quits</Button>
        </SettingsRow>
      )}
      {enabled && status && (
        <>
          <SettingsRow stacked separator label="Addresses" description={<>Give one of these to the other computer.<LearnMore href={DOCS.backendAllowConnections} /></>}>
            <RemoteAddressList urls={status.urls} />
            {status.tailscale.state === 'running' && status.tailscale.serve !== 'unknown' && (
              <div className="mt-2">
                <Button size="compact" disabled={busy} onClick={() => void act(() => window.adfApi.setRemoteTailscaleServe(status.tailscale.serve !== 'on'))}>
                  {status.tailscale.serve === 'on' ? 'Turn Off https with Tailscale' : 'Turn On https with Tailscale'}
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
          <SettingsRow stacked separator label="Computers" description={<>Pair with a code, or add one with a token.<LearnMore href={DOCS.backendPairComputer} /></>}>
            {created ? (
              <NewTokenPanel label={created.label} token={created.token} onDone={() => setCreated(null)} />
            ) : adding !== null ? (
              <div className="flex items-center gap-2">
                <TextInput value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="Which computer is this for?" aria-label="Computer name" maxLength={64} autoFocus />
                <Button size="compact" variant="primary" loading={busy} onClick={() => void addDevice()}>Create Token</Button>
                <Button size="compact" disabled={busy} onClick={() => setAdding(null)}>Cancel</Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Button size="compact" variant="primary" disabled={busy} onClick={() => { setPairingShown(true); if (!pairing) void act(() => window.adfApi.openRemotePairing()) }}>Pair a Computer</Button>
                <Button size="compact" disabled={busy} onClick={() => setAdding('')}>Add a Computer</Button>
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
        title="Pair a computer"
        lightDismiss={false}
        onClose={() => { setPairingShown(false); if (pairing) void act(() => window.adfApi.closeRemotePairing()) }}
      >
        {pairing && status && <PairingCodePanel pairing={pairing} name={status.name} fingerprint={status.fingerprint} now={now} />}
        <div className="mt-4 flex justify-end">
          <Button onClick={() => { setPairingShown(false); void act(() => window.adfApi.closeRemotePairing()) }}>Cancel</Button>
        </div>
      </Dialog>
    </SettingsGroup>
  )
}

// --- Client: Remote computer --------------------------------------------------------

/** One computer found, as the list shows it. */
export function DiscoveredList({ update, onPair }: { update: RemoteDiscoveryUpdate | null; onPair: (entry: RemoteDiscoveryEntry) => void }) {
  if (!update) return <p className="text-[12px] text-[var(--adf-ui-text-muted)]">Looking…</p>
  return (
    <div className="space-y-1.5">
      {update.entries.length === 0 && <p className="text-[12px] text-[var(--adf-ui-text-muted)]">None found yet. On the other computer, turn on Allow other computers to connect.</p>}
      <ul className="divide-y divide-[var(--adf-ui-separator)]">
        {update.entries.map((e) => (
          <li key={e.fingerprint} className="flex items-center justify-between gap-3 py-1.5">
            <div className="min-w-0 text-[12px]">
              <div className="flex flex-wrap items-center gap-2 font-medium text-[var(--adf-ui-text)]">
                {e.name}
                <EncryptionBadge encrypted={e.encrypted} />
                {e.alreadyPaired && <span className="text-[11px] font-normal text-[var(--adf-ui-text-muted)]">Already paired</span>}
                {!e.alreadyPaired && e.pairingOpen && <span className="text-[11px] font-normal text-[var(--adf-ui-accent)]">Ready to pair</span>}
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

export function FoundOnNetwork({ onPaired, onSwitch }: { onPaired: () => void; onSwitch: () => void }) {
  const [update, setUpdate] = useState<RemoteDiscoveryUpdate | null>(null)
  const [pairWith, setPairWith] = useState<RemoteDiscoveryEntry | null>(null)
  useEffect(() => {
    const off = window.adfApi?.onRemoteDiscoveryUpdate?.(setUpdate)
    void window.adfApi?.startRemoteDiscovery?.().catch(() => {})
    return () => { off?.(); void window.adfApi?.stopRemoteDiscovery?.().catch(() => {}) }
  }, [])
  return (
    <>
      <SettingsRow stacked label="Found on your network" description={<>Pair with a computer that allows connections.<LearnMore href={DOCS.backendConnectToComputer} /></>}>
        <DiscoveredList update={update} onPair={setPairWith} />
      </SettingsRow>
      {pairWith && <PairDialog entry={pairWith} onClose={() => setPairWith(null)} onPaired={onPaired} onSwitch={() => { setPairWith(null); onSwitch() }} />}
    </>
  )
}

/** The dialog's message line: what to do now, or why it stopped. */
export function pairMessage(state: RemotePairState | null, hostName: string): { kind: 'ok' | 'error'; text: string } | null {
  if (!state) return null
  if (state.step === 'waiting') return { kind: 'ok', text: state.message ?? `Waiting for ${hostName} to allow this computer…` }
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
    <Dialog open title={`Pair with ${entry.name}`} onClose={close} lightDismiss={false}>
      <div className="space-y-3 text-[12px]">
        <p className="text-[var(--adf-ui-text-muted)]">Fingerprint {entry.fingerprint} at {entry.address}. Check that {entry.name} shows the same fingerprint.</p>
        {!done && (
          <>
            <label className="block space-y-1">
              <span className="text-[var(--adf-ui-text)]">This computer's name</span>
              <TextInput value={deviceName} onChange={(e) => setDeviceName(e.target.value)} placeholder="This computer's host name" maxLength={64} disabled={working} aria-label="This computer's name" />
            </label>
            {!entry.encrypted && (
              <label className="flex items-center gap-2 cursor-pointer text-[var(--adf-ui-text-muted)]">
                <input type="checkbox" checked={trusted} disabled={working} onChange={(e) => setTrusted(e.target.checked)} className="rounded text-blue-500" />
                I trust this network; the token is sent unencrypted.
              </label>
            )}
            <label className="block space-y-1">
              <span className="text-[var(--adf-ui-text)]">Code shown on {entry.name}</span>
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
