/**
 * Settings → Networking (docs/guides/settings.md#networking): agent
 * messaging only. Remote access (other computers using this runtime) is in
 * Settings → Connections (Add → Share, Devices).
 *
 * - Status card: one line ("Mesh on · Home (192.168.1.0/24) (allowed) · 3
 *   agents shared") and the only per-network consent action, Allow on the
 *   current network, with the service that waits for it named.
 * - Sharing: Mesh, Network (the mesh's LAN mode) and the shared Agents.
 * - Networks: the allowed networks, each with Remove, then each current
 *   network that cannot be identified, with why and Help (no Allow: §3.3.1).
 * - Runtimes: the runtimes found on the LAN, the tailnet or at an address,
 *   with Add for an address; Managed when Connections has that computer.
 * - Advanced, collapsed but never hidden: Autostart, Port, Server,
 *   Tailscale, Addresses, HTTPS, Firewall, Endpoints.
 *
 * Copy rule (owner): labels are one word or a noun; at most one effect
 * sentence per row; the rest is a tooltip or the guide.
 */

import { useCallback, useEffect, useState } from 'react'
import { Button, IconButton, SettingsGroup, SettingsRow, Switch, TextInput } from '../ui'
import { DocsLink, InfoHint } from '../common/DocsLink'
import { Tooltip } from '../common/Tooltip'
import { OrbitalAvatar } from '../orbital/OrbitalAvatar'
import { orbitalSeedFor } from '../orbital/orbital-seed'
import { DOCS } from '../../../shared/constants/docs-links'
import type { MeshAgentStatus, MeshEvent } from '../../../shared/types/ipc.types'
import type { NetworkView } from '../../../shared/types/remote-access.types'
import type { NetworkStatusView, RemoteAccessView } from '../../../shared/types/remote-access-ipc.types'
import type { ConnectionRow } from '../../../shared/types/connection.types'
import type { RuntimeId } from '../../../shared/runtime-tag'
import { pausedText, publicNetworkWarning, unidentifiedText } from '../../../shared/utils/network-consent-text'
import { selectMeshSlice, useMeshStore } from '../../stores/mesh.store'
import { useConnectionStore } from '../../stores/connection.store'
import { useMesh } from '../../hooks/useMesh'
import { agentWindowsAvailable, openAgentWindow } from '../../utils/window-kind'
import { useSettingsApi } from './settings-runtime'
import { useSettingsSave } from './settings-save'
import { checkPeerAddress, checkWholeNumber } from './settings-inputs'
import { changeOn, meshServerHosts } from './RemoteAccessSettings'

/** The Mesh switch's tooltip: what turning it off interrupts. */
export const MESH_OFF_NOTE = 'Off stops agent messaging, agent websites and APIs, and delivery from peer runtimes.'

/** The effect sentences of the Sharing switches (one each). */
export const MESH_EFFECT = 'Agents on this computer message each other.'
export const NETWORK_EFFECT = 'Other computers on allowed networks reach agents you share.'

/** A stable empty list (a store selector must not return a new array each call). */
const NO_ROWS: ConnectionRow[] = []

/** Mesh events that change what the page shows. `message_routed` fires per message and is left out. */
const MESH_STATUS_EVENTS = new Set<MeshEvent['type']>([
  'agent_state_changed',
  'agent_joined',
  'agent_left',
  'lan_peer_discovered',
  'lan_peer_expired',
])

// --- Pure helpers (tested) ------------------------------------------------------

/** Agents other computers can reach once a network is allowed: visibility lan or public. */
export function sharedAgents<T extends Pick<MeshAgentStatus, 'visibility'>>(agents: T[]): T[] {
  return agents.filter((a) => a.visibility === 'lan' || a.visibility === 'public')
}

/** "Mesh on · Home (192.168.1.0/24) (allowed) · 3 agents shared"; `networks` null: not this computer's (a remote runtime). */
export function networkingStatusLine({ meshOn, networks, shared }: { meshOn: boolean; networks: NetworkView[] | null; shared: number }): string {
  const parts = [meshOn ? 'Mesh on' : 'Mesh off']
  if (networks) {
    parts.push(networks.length === 0
      ? 'No network'
      : networks.map((n) => `${n.label} (${n.allowed ? 'allowed' : 'not allowed'})`).join(', '))
  }
  parts.push(`${shared} ${shared === 1 ? 'agent' : 'agents'} shared`)
  return parts.join(' · ')
}

/** "agent-1 is public.", under the paused line (one sentence; the button is Allow). */
export function publicAgentsLine(handles: string[]): string | null {
  if (handles.length === 0) return null
  const names = handles.length === 1 ? handles[0] : `${handles.slice(0, -1).join(', ')} and ${handles[handles.length - 1]}`
  return `${names} ${handles.length === 1 ? 'is' : 'are'} public.`
}

export interface ConsentLine {
  key: string
  /** Null: an unidentified network, which cannot be allowed. */
  networkId: string | null
  lines: string[]
  warning: string | null
  /** An unidentified network: why, one sentence each ("Studio cannot identify this network. The router does not answer."). */
  reason: string | null
  /** The failed step's technical detail (tooltip), or null. */
  detail: string | null
}

/**
 * One entry per current network that is not allowed: the service that
 * waits for it, named ("Remote access", "Agent sharing" or both; never
 * remote access when only the mesh waits), the public agents, and the
 * Public warning. Every line is one sentence. The card's lines are built
 * here only.
 */
export function consentLines(view: Pick<NetworkStatusView, 'networks' | 'waiting'>, publicHandles: string[]): ConsentLine[] {
  const waiting = view.waiting ?? { remoteAccess: false, mesh: false }
  const services = { remoteAccess: waiting.remoteAccess, mesh: waiting.mesh || publicHandles.length > 0 }
  return view.networks.filter((n) => !n.allowed).map((n) => {
    const lines: string[] = []
    if (services.remoteAccess || services.mesh) lines.push(pausedText(services, n.label))
    const pub = n.id ? publicAgentsLine(publicHandles) : null
    if (pub) lines.push(pub)
    const exposed = !!n.id && n.kind === 'lan' && n.osCategory !== 'private'
    return {
      key: n.id ?? `unidentified:${n.ifaces.join(',')}`,
      networkId: n.id,
      lines,
      warning: exposed && (services.remoteAccess || services.mesh) ? publicNetworkWarning(services) : null,
      reason: n.id ? null : unidentifiedText(n.problem),
      detail: n.id ? null : n.problem?.detail ?? null,
    }
  })
}

/**
 * The mesh server's warning (mesh-server.ts PUBLIC_LOOPBACK_WARNING: a public
 * agent with no allowed network to listen on, e.g. a headless VPS), unless a
 * consent line already offers Allow for a network here.
 */
export function meshWarningLine(server: { warning?: string | null }, consent: ConsentLine[]): string | null {
  if (!server.warning) return null
  return consent.some((c) => c.networkId) ? null : server.warning
}

/** The current networks that cannot be identified (never allowed, so never in the allowed list). */
export function unidentifiedNetworks(networks: NetworkView[]): NetworkView[] {
  return networks.filter((n) => !n.id)
}

/** Why a network cannot be identified, with Help (the guide) and the technical detail as its tooltip. */
export function UnidentifiedReason({ reason, detail }: { reason: string; detail: string | null }) {
  return (
    <span className="block">
      {reason}
      {detail
        ? <Tooltip tip={detail} className="inline-flex"><DocsLink href={DOCS.unidentifiedNetwork} label="Help" className="ml-1.5 !text-[11px]" /></Tooltip>
        : <DocsLink href={DOCS.unidentifiedNetwork} label="Help" className="ml-1.5 !text-[11px]" />}
    </span>
  )
}

/** The addresses detail under Advanced: LAN addresses, Tailscale, firewall. */
export function networkDetailText(view: NetworkStatusView): string {
  const parts: string[] = []
  parts.push(view.lan.length > 0 ? `LAN ${view.lan.map((a) => a.address).join(', ')}${view.lan.every((a) => !a.allowed) ? ', not listening' : ''}` : 'No LAN address')
  parts.push(view.tailscale === 'running' ? `Tailscale on${view.tailnetAddress ? ` (${view.tailnetAddress})` : ''}` : view.tailscale === 'stopped' ? 'Tailscale stopped' : 'Tailscale not installed')
  return parts.join(' · ')
}

export interface FoundRuntime {
  runtime_id: string
  host: string
  port: number
  url: string
  /** undefined = announced, but its directory did not answer. */
  agent_count?: number
  source?: 'mdns' | 'tailnet' | 'manual'
  /** Remote access on that runtime (TXT `fp`, `daemon_port`, mdns-service.ts). */
  fingerprint?: string
  daemon_port?: number
}

/** How a runtime was found, as its badge says. */
export function foundBy(source: FoundRuntime['source']): 'LAN' | 'Tailnet' | 'Address' {
  return source === 'tailnet' ? 'Tailnet' : source === 'manual' ? 'Address' : 'LAN'
}

function hostOf(url: string | null): string | null {
  if (!url) return null
  try { return new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase() } catch { return null }
}

/** The explicit port of `url` ('' or null: the scheme's default, or not a URL). */
function portOf(url: string | null): string | null {
  if (!url) return null
  try { return new URL(url).port || null } catch { return null }
}

type ManagedRuntime = Pick<FoundRuntime, 'host' | 'url' | 'fingerprint' | 'daemon_port'>
type ManagedRow = Pick<ConnectionRow, 'kind' | 'url'> & { fingerprint?: string | null }

/**
 * This Studio also has that computer under Connections: a saved row with the
 * fingerprint it announces; else (a fingerprint missing on either side) a
 * saved row on the same host and daemon port, unless another runtime of
 * `found` announces that row's fingerprint.
 */
export function isManaged(runtime: ManagedRuntime, rows: ManagedRow[], found: readonly ManagedRuntime[] = []): boolean {
  const hosts = new Set([runtime.host.toLowerCase(), hostOf(runtime.url)].filter((h): h is string => !!h))
  return rows.some((r) => {
    if (r.kind !== 'saved') return false
    if (r.fingerprint && runtime.fingerprint) return r.fingerprint === runtime.fingerprint
    const host = hostOf(r.url)
    if (!host || !hosts.has(host)) return false
    const port = portOf(r.url)
    if (port && runtime.daemon_port && port !== String(runtime.daemon_port)) return false
    return !(r.fingerprint && found.some((f) => f !== runtime && f.fingerprint === r.fingerprint))
  })
}

/** An address the user added that matches a found runtime (`host:port`, or a bare host). */
export function addressMatches(address: string, runtime: Pick<FoundRuntime, 'host' | 'port'>): boolean {
  const a = address.trim().toLowerCase().replace(/^\[|\](?=:|$)/g, '')
  const host = runtime.host.toLowerCase()
  return a === host || a === `${host}:${runtime.port}` || a === `[${host}]:${runtime.port}`
}

/** The one list: found runtimes, then added addresses nothing answered at yet. */
export function runtimeList(found: FoundRuntime[], addresses: string[]): Array<{ kind: 'found'; runtime: FoundRuntime; address: string | null } | { kind: 'address'; address: string }> {
  const rows: Array<{ kind: 'found'; runtime: FoundRuntime; address: string | null } | { kind: 'address'; address: string }> = []
  const used = new Set<string>()
  for (const runtime of found) {
    const address = runtime.source === 'manual' ? addresses.find((a) => !used.has(a) && addressMatches(a, runtime)) ?? null : null
    if (address) used.add(address)
    rows.push({ kind: 'found', runtime, address })
  }
  for (const address of addresses) if (!used.has(address)) rows.push({ kind: 'address', address })
  return rows
}

// --- Parts ---------------------------------------------------------------------------

function LearnMore({ href }: { href: string }) {
  return <DocsLink href={href} label="Learn more" className="ml-1.5 !text-[11px]" />
}

function Badge({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'accent' }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${tone === 'accent' ? 'bg-[var(--adf-ui-accent-subtle)] text-[var(--adf-ui-accent)]' : 'bg-[var(--adf-ui-surface-hover)] text-[var(--adf-ui-text-muted)]'}`}>
      {children}
    </span>
  )
}

/** The status card: one line, then Allow for each current network not allowed, with what waits for it. */
export function NetworkingStatusCard({ line, consent, busy, note, firewall, warning = null, onAllow }: {
  line: string
  consent: ConsentLine[]
  busy: boolean
  note: string | null
  firewall: string | null
  /** meshWarningLine. */
  warning?: string | null
  onAllow: (id: string) => void
}) {
  return (
    <div role="status" className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] px-3 py-2 text-[12px] text-[var(--adf-ui-text)]">
      <span>{line}<LearnMore href={DOCS.networkingStatus} /></span>
      {consent.map((c) => (
        <div key={c.key} className="flex w-full flex-wrap items-center justify-between gap-2">
          <span className="space-y-0.5">
            {c.lines.map((l) => <span key={l} className="block">{l}</span>)}
            {c.reason && <UnidentifiedReason reason={c.reason} detail={c.detail} />}
          </span>
          {c.networkId && <Button size="compact" disabled={busy} onClick={() => onAllow(c.networkId!)}>Allow</Button>}
          {c.warning && <span className="w-full text-[11px] text-[var(--adf-ui-danger)]">{c.warning}</span>}
        </div>
      ))}
      {warning && <span className="w-full text-[11px] text-[var(--adf-ui-danger)]">{warning}</span>}
      {(firewall || note) && <span className="w-full text-[11px] text-[var(--adf-ui-danger)]">{note ?? firewall}</span>}
    </div>
  )
}

/** One sentence: the first of `text`, ended with a period when it has no end. */
function oneSentence(text: string): string {
  const t = text.trim()
  const first = /^.*?[.!?](?=\s|$)/s.exec(t)?.[0] ?? t
  return /[.!?]$/.test(first) ? first : `${first}.`
}

/** The HTTPS row under Advanced: on or off, else the real cause (no Local daemon, its error, Tailscale). */
export function httpsText(view: RemoteAccessView | null): string {
  if (!view) return 'Checking…'
  const tailscale = view.status?.tailscale
  if (!tailscale) {
    const cause = view.unavailableReason ?? view.error
    return cause ? oneSentence(cause) : 'Checking…'
  }
  if (tailscale.state !== 'running') return 'Needs Tailscale.'
  if (tailscale.serve === 'unknown') return 'Tailscale did not answer.'
  return tailscale.serve === 'on' ? `On${tailscale.httpsUrl ? `: ${tailscale.httpsUrl}` : ''}.` : 'Off.'
}

/** The firewall rule state under Advanced: what blocks, and the exact commands to run (R9: never run by Studio). */
interface LanFirewallState {
  supported: boolean
  ruleConfigured: boolean | null
  reachable: boolean | null
  lanIp: string | null
  detail: string
  commands?: string[]
  port: number
  serverLanBound: boolean
  verified: boolean
}

export function firewallText(fw: LanFirewallState): string {
  if (fw.verified) return `Open${fw.lanIp ? ` on ${fw.lanIp}:${fw.port}` : ''}.`
  if (!fw.serverLanBound) return 'The mesh server is not listening on a network yet.'
  if (fw.supported && fw.ruleConfigured === false) return 'Peers see this runtime but list 0 agents until a firewall rule lets them in.'
  if (fw.supported && fw.ruleConfigured === null) return fw.detail
  if (!fw.supported) return fw.detail
  return `The firewall rule is there, but the server did not answer on ${fw.lanIp ?? 'the LAN address'}.`
}

export function FirewallCommands({ commands }: { commands: string[] }) {
  if (commands.length === 0) return null
  return (
    <div className="mt-1 space-y-1">
      <p className="text-[11px] text-[var(--adf-ui-text-muted)]">Run in an administrator shell:</p>
      <pre className="whitespace-pre-wrap break-all rounded border border-[var(--adf-ui-border)] bg-[var(--adf-ui-canvas)] px-2 py-1 font-mono text-[11px] text-[var(--adf-ui-text)]">{commands.join('\n')}</pre>
      <div className="flex items-center gap-2">
        <Button size="compact" variant="ghost" onClick={() => void navigator.clipboard?.writeText(commands.join('\n')).catch(() => {})}>Copy</Button>
        <DocsLink href={DOCS.meshFirewall} />
      </div>
    </div>
  )
}

function FirewallRow({ lan, restarting, hostName }: { lan: boolean; restarting: boolean; hostName: string | null }) {
  const api = useSettingsApi()
  const [fw, setFw] = useState<LanFirewallState | null>(null)
  useEffect(() => {
    if (!lan || restarting || hostName || !api?.checkLanFirewall) return
    let alive = true
    api.checkLanFirewall().then((r) => { if (alive) setFw(r as LanFirewallState) }).catch(() => { if (alive) setFw(null) })
    return () => { alive = false }
  }, [lan, restarting, hostName])
  const description = hostName ? changeOn(hostName) : !lan ? 'Checked while Network is on.' : fw ? firewallText(fw) : 'Checking…'
  return (
    <SettingsRow separator stacked label="Firewall" description={description}>
      {fw && !fw.verified && !hostName && lan && <FirewallCommands commands={fw.commands ?? []} />}
    </SettingsRow>
  )
}

// --- The page ---------------------------------------------------------------------

export function NetworkingSettings({ remote, runtimeName, pickedMesh }: {
  /** The picked runtime is on another computer: its network, firewall and allowed networks are changed there. */
  remote: boolean
  runtimeName: string
  pickedMesh: RuntimeId | undefined
}) {
  const api = useSettingsApi()
  const { commit, offerUndo } = useSettingsSave()
  const [meshAutoStart, setMeshAutoStart] = useState(true)
  const [meshLan, setMeshLan] = useState(false)
  const [meshPort, setMeshPort] = useState(7295)
  const [manualPeers, setManualPeers] = useState<string[]>([])
  const [tailnetOn, setTailnetOn] = useState(true)
  const [meshServerStatus, setMeshServerStatus] = useState<{ running: boolean; port: number; host: string; lanAddresses?: string[]; warning?: string }>({ running: false, port: 7295, host: '127.0.0.1' })
  const [meshAgents, setMeshAgents] = useState<MeshAgentStatus[]>([])
  const [lanInfo, setLanInfo] = useState<{ hostname: string; addresses: Array<{ iface: string; address: string; family: 'IPv4' | 'IPv6'; mac: string }> }>({ hostname: '', addresses: [] })
  const [meshRestarting, setMeshRestarting] = useState(false)
  const [meshPortDraft, setMeshPortDraft] = useState('7295')
  const [meshPortError, setMeshPortError] = useState<string | null>(null)
  const [meshSwitching, setMeshSwitching] = useState(false)
  const [meshSwitchError, setMeshSwitchError] = useState<string | null>(null)
  const [netView, setNetView] = useState<NetworkStatusView | null>(null)
  const [netNote, setNetNote] = useState<string | null>(null)
  const [netBusy, setNetBusy] = useState(false)
  const [remoteView, setRemoteView] = useState<RemoteAccessView | null>(null)
  const [serveBusy, setServeBusy] = useState(false)
  const [serveError, setServeError] = useState<string | null>(null)
  const [found, setFound] = useState<FoundRuntime[]>([])
  const [rechecking, setRechecking] = useState(false)
  const [draft, setDraft] = useState('')
  const [draftError, setDraftError] = useState<string | null>(null)
  const meshEnabled = useMeshStore((s) => selectMeshSlice(s, pickedMesh).enabled)
  const { enableMesh, disableMesh } = useMesh(pickedMesh)
  const savedRows = useConnectionStore((s) => s.view?.rows) ?? NO_ROWS

  useEffect(() => { setMeshPortDraft(String(meshPort)); setMeshPortError(null) }, [meshPort])

  // The runtime's settings this page edits.
  useEffect(() => {
    let alive = true
    api?.getSettings?.().then((settings) => {
      if (!alive) return
      const s = settings as unknown as Record<string, unknown>
      setMeshAutoStart(s.meshEnabled !== false)
      setMeshLan(!!s.meshLan)
      setMeshPort((s.meshPort as number) ?? 7295)
      setManualPeers((s.meshManualPeers as string[] | undefined) ?? [])
      setTailnetOn(s.tailnetDiscovery !== false)
    }).catch(() => {})
    return () => { alive = false }
  }, [])

  // The server, its agents and addresses, live on mesh events (debounced).
  useEffect(() => {
    const refresh = () => {
      api?.getMeshServerStatus?.().then(setMeshServerStatus).catch(() => {})
      api?.getMeshStatus?.().then((s) => setMeshAgents(s.agents)).catch(() => {})
    }
    refresh()
    api?.getMeshServerLanIps?.().then(setLanInfo).catch(() => {})
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsub = api?.onMeshEvent?.((event: MeshEvent) => {
      if (!MESH_STATUS_EVENTS.has(event.type)) return
      clearTimeout(timer)
      timer = setTimeout(refresh, 500)
    })
    return () => { clearTimeout(timer); unsub?.() }
  }, [meshEnabled])

  // This computer's network and remote access (HTTPS): not a remote runtime's.
  useEffect(() => {
    if (remote) return
    const load = () => {
      window.adfApi?.getNetworkStatus?.().then(setNetView).catch(() => {})
      window.adfApi?.getRemoteAccess?.().then(setRemoteView).catch(() => {})
    }
    load()
    const timer = setInterval(load, 10_000)
    const off = window.adfApi?.onRemoteAccessChanged?.(() => load())
    return () => { clearInterval(timer); off?.() }
  }, [remote])

  // The runtimes found, live on LAN peer events.
  const refreshFound = useCallback(async (force = false) => {
    const list = await api?.getDiscoveredRuntimes?.(force)
    if (list) setFound(list as FoundRuntime[])
  }, [])
  useEffect(() => {
    void refreshFound()
    const unsub = api?.onMeshEvent?.((event: { type?: string }) => {
      if (event?.type === 'lan_peer_discovered' || event?.type === 'lan_peer_expired') void refreshFound()
    })
    return unsub
  }, [refreshFound])

  /** Show `next` now and write it; a refusal puts `prev` back. */
  const persist = <T,>(patch: Record<string, unknown>, set: (value: T) => void, next: T, prev: T) => {
    set(next)
    return commit(patch, () => set(prev))
  }
  const restartMeshServer = async () => {
    setMeshRestarting(true)
    try {
      const res = await api?.restartMeshServer()
      if (res) setMeshServerStatus({ running: res.running ?? false, port: res.port ?? meshPort, host: res.host ?? (meshLan ? '0.0.0.0' : '127.0.0.1') })
    } finally {
      setMeshRestarting(false)
    }
  }
  const applyMeshPort = async () => {
    const checked = checkWholeNumber(meshPortDraft, 1, 65535)
    if (!checked.ok) { setMeshPortError(checked.error); return }
    if (checked.value === meshPort) return
    // Commit before the restart: main reads the saved port back.
    const saved = await persist({ meshPort: checked.value }, setMeshPort, checked.value, meshPort)
    if (saved && meshServerStatus.running && checked.value !== meshServerStatus.port) await restartMeshServer()
  }
  /** The Mesh switch: the mesh and its server together, now; Autostart is separate (meshEnabled). */
  const switchMesh = async (on: boolean) => {
    setMeshSwitching(true)
    setMeshSwitchError(null)
    try {
      const result = on ? await enableMesh() : await disableMesh()
      if (!result.success) {
        setMeshSwitchError(result.error ?? `Mesh ${on ? 'start' : 'stop'} failed.`)
        return
      }
      const server = on ? await api?.startMeshServer() : await api?.stopMeshServer()
      if (server) {
        setMeshServerStatus({ running: server.running ?? false, port: server.port ?? meshServerStatus.port, host: server.host ?? meshServerStatus.host })
        if (!server.success && server.error) setMeshSwitchError(server.error)
      }
    } catch (err) {
      setMeshSwitchError(err instanceof Error ? err.message : String(err))
    } finally {
      setMeshSwitching(false)
    }
  }
  const changeNetwork = async (action: 'allow' | 'forget', id: string) => {
    setNetNote(null)
    setNetBusy(true)
    try {
      const result = action === 'allow' ? await window.adfApi.allowNetwork(id) : await window.adfApi.forgetNetwork(id)
      if (!result.ok) setNetNote(result.error)
    } catch {
      setNetNote('Studio could not change the allowed networks.')
    } finally {
      setNetBusy(false)
      window.adfApi?.getNetworkStatus?.().then(setNetView).catch(() => {})
    }
  }
  const savePeers = async (next: string[]) => {
    const prev = manualPeers
    setManualPeers(next)
    await commit({ meshManualPeers: next }, () => setManualPeers(prev))
  }
  const addAddress = async () => {
    const checked = checkPeerAddress(draft)
    if (!checked.ok) { setDraftError(checked.error); return }
    setDraft('')
    setDraftError(null)
    await savePeers([...manualPeers.filter((p) => p !== checked.value), checked.value])
  }
  const removeAddress = (address: string) => {
    const before = manualPeers
    void savePeers(manualPeers.filter((x) => x !== address)).then(() => offerUndo(`Removed ${address}.`, () => void savePeers(before)))
  }
  const recheck = async () => {
    setRechecking(true)
    try { await refreshFound(true) } finally { setRechecking(false) }
  }
  const switchServe = async (enabled: boolean) => {
    setServeBusy(true)
    setServeError(null)
    try {
      const result = await window.adfApi.setRemoteTailscaleServe(enabled)
      if (result.ok) setRemoteView(result.view)
      else if (result.code !== 'cancelled') setServeError(result.error)
    } finally {
      setServeBusy(false)
    }
  }

  const shared = sharedAgents(meshAgents)
  const publicHandles = meshAgents.filter((a) => a.visibility === 'public').map((a) => a.handle ?? a.filePath)
  const thisComputer = !remote && !!netView?.available
  const statusLine = networkingStatusLine({ meshOn: meshEnabled, networks: thisComputer ? netView!.networks : null, shared: shared.length })
  const consent = thisComputer ? consentLines(netView!, publicHandles) : []
  const tailscale = remoteView?.status?.tailscale ?? null
  const rows = runtimeList(found, manualPeers)

  return (
    <>
      <NetworkingStatusCard
        line={statusLine}
        consent={consent}
        busy={netBusy}
        note={netNote}
        firewall={thisComputer && netView!.firewall.state === 'blocked' ? netView!.firewall.message : null}
        warning={meshWarningLine(meshServerStatus, consent)}
        onAllow={(id) => void changeNetwork('allow', id)}
      />

      <SettingsGroup title="Sharing" docs={DOCS.settingsNetworking}>
        <SettingsRow label={<>Mesh<InfoHint tip={MESH_OFF_NOTE} /></>} description={MESH_EFFECT} error={meshSwitchError ?? undefined}>
          <Switch label="Mesh" checked={meshEnabled} disabled={meshSwitching} onChange={(next) => void switchMesh(next)} />
        </SettingsRow>
        <SettingsRow
          separator
          label={<>Network<InfoHint tip="Listens on private networks and Tailscale, only on a network you allowed. An agent with lan or public visibility turns it on too." /></>}
          description={NETWORK_EFFECT}
          help={meshRestarting ? 'Restarting…' : undefined}
        >
          <Switch
            label="Network"
            checked={meshLan}
            disabled={meshRestarting}
            onChange={async (lan) => {
              const saved = await persist({ meshLan: lan }, setMeshLan, lan, meshLan)
              if (saved && meshServerStatus.running) await restartMeshServer()
            }}
          />
        </SettingsRow>
        <SettingsRow separator stacked label={<>Agents<InfoHint tip="Agents with lan or public visibility (Agent → Config → Messaging)." /></>} description={<>{shared.length} shared<LearnMore href={DOCS.visibility} /></>}>
          {shared.length > 0 && (
            <ul className="space-y-0.5 text-[12px]">
              {shared.map((a) => (
                <li key={a.filePath} className="flex items-center gap-2">
                  <OrbitalAvatar seed={orbitalSeedFor({ did: a.did, filePath: a.filePath })} icon={a.icon} iconSeed={a.agentId || a.filePath} size={14} emojiSize={12} />
                  {agentWindowsAvailable
                    ? <button type="button" className="font-mono text-[var(--adf-ui-accent)] hover:underline" onClick={() => openAgentWindow({ filePath: a.filePath, agentId: a.agentId ?? null, ...(a.handle ? { name: a.handle } : {}), ...(pickedMesh ? { runtimeId: pickedMesh } : {}) })}>{a.handle}</button>
                    : <span className="font-mono text-[var(--adf-ui-text)]">{a.handle}</span>}
                  <Badge>{a.visibility === 'public' ? 'Public' : 'LAN'}</Badge>
                </li>
              ))}
            </ul>
          )}
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Networks">
        {remote
          ? <SettingsRow label="Networks" description={changeOn(runtimeName)} />
          : !netView?.available || (netView.allowedNetworks.length === 0 && unidentifiedNetworks(netView.networks).length === 0)
            ? <SettingsRow label="None" />
            : <>
              {netView.allowedNetworks.map((n, i) => (
                <SettingsRow key={n.id} separator={i > 0} label={n.label} description={netView.networks.some((c) => c.id === n.id) ? 'Current' : undefined}>
                  <Button size="compact" disabled={netBusy} onClick={() => void changeNetwork('forget', n.id)}>Remove</Button>
                </SettingsRow>
              ))}
              {unidentifiedNetworks(netView.networks).map((n, i) => (
                <SettingsRow
                  key={`unidentified:${n.kind}:${n.ifaces.join(',')}`}
                  separator={netView.allowedNetworks.length > 0 || i > 0}
                  label={n.label}
                  description={<UnidentifiedReason reason={unidentifiedText(n.problem)} detail={n.problem?.detail ?? null} />}
                />
              ))}
            </>}
      </SettingsGroup>

      <SettingsGroup title="Runtimes" hint="Runtimes found on this network, on your tailnet, or at an address you added. Agent counts come from each runtime's directory.">
        {rows.length === 0
          ? <p className="px-4 pb-3 text-[12px] text-[var(--adf-ui-text-subtle)]">None found.</p>
          : (
            <ul className="divide-y divide-[var(--adf-ui-separator)] border-t border-[var(--adf-ui-separator)]">
              {rows.map((row) => {
                const address = row.address
                return (
                  <li key={row.kind === 'found' ? `${row.runtime.runtime_id}|${row.runtime.url}` : `address:${row.address}`} className="flex flex-wrap items-center gap-2 px-4 py-2 text-[12px]">
                    {row.kind === 'found' ? (
                      <>
                        <span className="font-mono text-[var(--adf-ui-text)]">{row.runtime.host}</span>
                        <Badge>{foundBy(row.runtime.source)}</Badge>
                        {isManaged(row.runtime, savedRows, found) && <Tooltip tip="Also under Settings → Connections"><span><Badge tone="accent">Managed</Badge></span></Tooltip>}
                        {row.runtime.url && <span className="font-mono text-[11px] text-[var(--adf-ui-text-subtle)]">{row.runtime.url.replace(/^https?:\/\//, '')}</span>}
                        {row.runtime.agent_count === undefined
                          ? <Tooltip tip="The runtime announced itself but its directory did not answer: a firewall, the wrong interface, or its mesh server is down."><span className="text-[var(--adf-ui-warning)]">Unreachable</span></Tooltip>
                          : <span className="text-[var(--adf-ui-text-subtle)]">{row.runtime.agent_count} {row.runtime.agent_count === 1 ? 'agent' : 'agents'}</span>}
                      </>
                    ) : (
                      <>
                        <span className="font-mono text-[var(--adf-ui-text)]">{row.address}</span>
                        <Badge>Address</Badge>
                        <span className="text-[var(--adf-ui-text-subtle)]">No answer</span>
                      </>
                    )}
                    {address && (
                      <IconButton className="ml-auto" onClick={() => removeAddress(address)} aria-label={`Remove ${address}`} variant="danger" title="Remove">✕</IconButton>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        <SettingsRow separator label="Address" error={draftError ?? undefined}>
          <div className="flex items-center gap-1.5">
            <TextInput
              aria-label="Address"
              value={draft}
              aria-invalid={!!draftError}
              onChange={(e) => { setDraft(e.target.value); setDraftError(null) }}
              onKeyDown={(e) => { if (e.key === 'Enter') void addAddress() }}
              placeholder="host:port, e.g. 100.101.102.103:7295"
              spellCheck={false}
              className="!w-72 font-mono !text-[12px]"
            />
            <Button onClick={() => void addAddress()} size="compact">Add</Button>
            <Tooltip tip="Probe the tailnet and the addresses now, then fetch each runtime's directory">
              <Button onClick={() => void recheck()} disabled={rechecking} loading={rechecking} size="compact">Recheck</Button>
            </Tooltip>
          </div>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup>
        <details>
          <summary className="cursor-pointer select-none px-4 py-3 text-[13px] font-semibold text-[var(--adf-ui-text)]">Advanced</summary>
          <SettingsRow separator label={<>Autostart<InfoHint tip="Start the mesh when the runtime starts. The Mesh switch does not change this." /></>}>
            <Switch label="Autostart" checked={meshAutoStart} onChange={(next) => void persist({ meshEnabled: next }, setMeshAutoStart, next, meshAutoStart)} />
          </SettingsRow>
          <SettingsRow
            separator
            label="Port"
            description={meshServerStatus.running ? 'Apply restarts the server on the new port.' : 'Used when the server starts.'}
            error={meshPortError ?? undefined}
          >
            <div className="flex items-center gap-2">
              <TextInput
                aria-label="Port"
                inputMode="numeric"
                value={meshPortDraft}
                disabled={meshRestarting}
                aria-invalid={!!meshPortError}
                onChange={(e) => { setMeshPortDraft(e.target.value); setMeshPortError(null) }}
                onKeyDown={(e) => { if (e.key === 'Enter') void applyMeshPort() }}
                className="!w-24 !text-[12px]"
              />
              <Button size="compact" disabled={meshRestarting || meshPortDraft.trim() === String(meshPort)} onClick={() => void applyMeshPort()}>Apply</Button>
            </div>
          </SettingsRow>
          <SettingsRow
            separator
            label="Server"
            description={meshServerStatus.running ? `Running on ${meshServerHosts(meshServerStatus)}, port ${meshServerStatus.port}` : 'Stopped'}
          >
            <span aria-hidden="true" className={`block size-2 rounded-full ${meshServerStatus.running ? 'bg-[var(--adf-ui-success)]' : 'bg-[var(--adf-ui-danger)]'}`} />
          </SettingsRow>
          <SettingsRow separator label={<>Tailscale<InfoHint tip="Probe the computers on your tailnet for ADF runtimes." /></>}>
            <Switch
              label="Tailscale"
              checked={tailnetOn}
              onChange={(next) => {
                setTailnetOn(next)
                void commit({ tailnetDiscovery: next }, () => setTailnetOn(!next))
              }}
            />
          </SettingsRow>
          <SettingsRow
            separator
            stacked
            label="Addresses"
            description={thisComputer ? networkDetailText(netView!) : lanInfo.hostname ? <span className="font-mono">{lanInfo.hostname}</span> : undefined}
            help={!meshLan ? 'Other computers reach these once Network is on.' : undefined}
          >
            {lanInfo.addresses.length > 0 && (
              <div className="space-y-1">
                {lanInfo.addresses.map((addr) => {
                  const display = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address
                  const url = `http://${display}:${meshServerStatus.port}`
                  const live = meshServerStatus.running && meshLan
                  return (
                    <div key={`${addr.iface}-${addr.address}`} className="flex items-center gap-2">
                      <span className="max-w-[140px] truncate rounded bg-[var(--adf-ui-surface-hover)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--adf-ui-text-muted)]" title={addr.iface}>{addr.iface}</span>
                      <span className="text-[11px] uppercase text-[var(--adf-ui-text-subtle)]">{addr.family}</span>
                      {live
                        ? <a href={url} target="_blank" rel="noopener noreferrer" className="truncate font-mono text-xs text-[var(--adf-ui-accent)] hover:underline">{url}</a>
                        : <span className="truncate font-mono text-xs text-[var(--adf-ui-text-muted)]">{addr.address}</span>}
                      <button onClick={() => navigator.clipboard?.writeText(live ? url : addr.address)} className="ml-auto text-[11px] text-[var(--adf-ui-text-subtle)] hover:text-[var(--adf-ui-text)]" title="Copy">Copy</button>
                    </div>
                  )
                })}
              </div>
            )}
          </SettingsRow>
          <SettingsRow
            separator
            label={<>HTTPS<InfoHint tip="tailscale serve in front of this runtime's daemon, for computers that use it over your tailnet." /></>}
            description={remote ? changeOn(runtimeName) : httpsText(remoteView)}
            error={serveError ?? undefined}
          >
            {!remote && tailscale?.state === 'running' && tailscale.serve !== 'unknown' && (
              <Button size="compact" disabled={serveBusy} onClick={() => void switchServe(tailscale.serve !== 'on')}>{tailscale.serve === 'on' ? 'Disable' : 'Enable'}</Button>
            )}
          </SettingsRow>
          <FirewallRow lan={meshLan || shared.length > 0} restarting={meshRestarting} hostName={remote ? runtimeName : null} />
          <SettingsRow separator stacked label="Endpoints" description={remote ? changeOn(runtimeName) : meshEnabled ? `${meshAgents.length} serving.` : 'Mesh is off.'}>
            {meshEnabled && !remote && meshAgents.length > 0 && (
              <ul className="space-y-1">
                {meshAgents.map((agent) => {
                  const url = meshServerStatus.running ? `http://127.0.0.1:${meshServerStatus.port}/agents/${agent.handle ?? ''}` : null
                  return (
                    <li key={agent.filePath} className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <OrbitalAvatar seed={orbitalSeedFor({ did: agent.did, filePath: agent.filePath })} icon={agent.icon} iconSeed={agent.agentId || agent.filePath} size={16} emojiSize={14} />
                          <span className="truncate text-[13px] font-medium text-[var(--adf-ui-text)]">{agent.handle}</span>
                        </div>
                        {url && <a href={url} target="_blank" rel="noopener noreferrer" className="block truncate font-mono text-[11px] text-[var(--adf-ui-accent)] hover:underline">{url}</a>}
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {agent.publicEnabled && <span title="Serves its public folder" className="rounded bg-[var(--adf-ui-success-subtle)] px-1.5 py-0.5 text-[11px] text-[var(--adf-ui-success)]">Site</span>}
                        {(agent.apiRouteCount ?? 0) > 0 && <span className="rounded bg-[var(--adf-ui-accent-subtle)] px-1.5 py-0.5 text-[11px] text-[var(--adf-ui-accent)]">{agent.apiRouteCount} route{agent.apiRouteCount !== 1 ? 's' : ''}</span>}
                        {(agent.sharedCount ?? 0) > 0 && <span className="rounded bg-[var(--adf-ui-surface-hover)] px-1.5 py-0.5 text-[11px] text-[var(--adf-ui-text-muted)]">{agent.sharedCount} {agent.sharedCount === 1 ? 'pattern' : 'patterns'}</span>}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </SettingsRow>
        </details>
      </SettingsGroup>
    </>
  )
}
