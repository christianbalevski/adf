/**
 * Settings → Studio → Connections (docs/design/settings-scopes.md §5,
 * docs/design/multi-runtime.md §6.5). In the UI the runtime (the ADF
 * daemon) is an **agent server**. From top to bottom:
 *
 * - **Add**, the one on the page: Connect or Share (`AddDialog`).
 * - **Local server**: this computer's agent server, "<name> (Local)". It is
 *   always connected while Studio runs it. Its state, Details (pid, who
 *   started it, URL, version, key), the More menu (Inside Studio (legacy)),
 *   and Keep running after Studio quits (`keepDaemonRunning`). Inside Studio
 *   (legacy) is listed here while it runs or is saved.
 * - **Remote servers**: the saved connections (shared with `adf`:
 *   cli-remotes.json and the OS keychain), each connected while it is saved,
 *   with its state and its More menu (Remove: it disconnects and forgets).
 *   The local server is never listed here.
 * - **Devices**: the computers and Studios that can access the local server:
 *   the Remote access switch, the devices, Revoke
 *   (RemoteAccessSettings.tsx DevicesGroup).
 *
 * Remote servers and Devices collapse to their heading line when they hold
 * nothing; the heading keeps the count or the state in view.
 *
 * Add → Connect: the servers found on this computer's networks as picks,
 * then Address, Code and Token, all visible. A code pairs (the server's
 * fingerprint is checked before the code is sent); a token is saved
 * directly. Add → Share: RemoteAccessSettings.tsx SharePanel. No token of a
 * connection ever reaches the renderer.
 *
 * Local and Inside Studio (legacy) are whole-Studio modes: choosing one
 * saves it for the next launch (multi-runtime.md §7.2). Nothing restarts
 * unless the owner presses Restart.
 *
 * Copy: labels are one word or a noun; help text is short sentences, one
 * fact each (ASD-STE100 style).
 */

import { useEffect, useRef, useState } from 'react'
import { Button, IconButton, Switch, TextInput } from '../ui'
import { useSettingsSave } from './settings-save'
import { Dialog } from '../common/Dialog'
import { useConfirm, type ConfirmOptions } from '../common/ConfirmDialog'
import { ContextMenu } from '../common/ContextMenu'
import { Tooltip } from '../common/Tooltip'
import { RemoteMark } from '../common/RemoteMark'
import { ConnectIcon, ServerIcon, ShareIcon } from '../common/ServerIcons'
import { LOCAL_LABEL } from '../../../shared/runtime-name'
import { DocsLink } from '../common/DocsLink'
import { DOCS } from '../../../shared/constants/docs-links'
import { checkRemoteDaemonUrl } from '../../../shared/utils/remote-backend-url'
import { CONNECTION_STATE_LABELS, type ConnectionResult, type ConnectionRow, type ConnectionState, type ConnectionsView } from '../../../shared/types/connection.types'
import type { BackendDaemonStatus, BackendSettingsView, StudioRunMode } from '../../../shared/types/backend.types'
import type { RemotePairErrorCode, RemotePairStartRequest, RemotePairState } from '../../../shared/types/remote-access-ipc.types'
import { DevicesGroup, SharePanel, pairMessage } from './RemoteAccessSettings'
import type { RemoteDiscoveryEntry } from '../../../shared/types/remote-access-ipc.types'
import { startConnectionFeed, useConnectionStore } from '../../stores/connection.store'
import { DetailsList, PageSection, SectionRow, StateDot } from './page-section'
import { runtimeLabel, useRuntimes } from '../../stores/runtimes.store'
import { LOCAL_RUNTIME } from '../../../shared/runtime-tag'

/** The modes as users see them. Inside Studio is the legacy backend, kept for this release only. */
const MODE_LABELS: Record<StudioRunMode, string> = {
  embedded: 'Inside Studio (legacy)',
  local: LOCAL_LABEL,
}

/** A "Learn more" link after a row's sentence. */
function LearnMore({ href }: { href: string }) {
  return <DocsLink href={href} label="Learn more" className="ml-1.5 !text-[11px]" />
}

/** The launch that moved this install off Embedded to the new default (W5-I), in one line; what moved is under Details. */
export function defaultSwitchLine(record: NonNullable<BackendSettingsView['defaultSwitch']>): string {
  const when = Number.isNaN(Date.parse(record.at)) ? record.at : new Date(record.at).toLocaleString()
  return `On ${when}, Studio${record.version ? ` ${record.version}` : ''} moved agents from inside Studio to the local server.`
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

/** Who started the local server, as Details says it. */
export function startedByText(daemon: Pick<BackendDaemonStatus, 'startedBy' | 'how'>): string | null {
  if (!daemon.startedBy) return null
  if (daemon.how === 'spawned') return 'this Studio'
  return daemon.startedBy === 'studio' ? 'Studio' : daemon.startedBy === 'cli' ? 'the ADF CLI' : 'a service'
}

/**
 * The local server's state line: the connection (or its progress). A key
 * the owner does not trust stays on the line (it needs an action); the rest
 * is under Details (daemonDetails).
 */
export function daemonLine(daemon: BackendDaemonStatus): string {
  const parts = [daemon.progress ?? DAEMON_LABELS[daemon.connection]]
  // K12 (no OS keychain): the owner's trust in the server's key, set with adf identity trust-daemon.
  if (daemon.trust?.state === 'not-trusted') parts.push('Key not trusted')
  return parts.join(' · ')
}

/** The local server's Details: pid, who started it, URL, version, the key's trust and how to set it, a missing local proof. */
export function daemonDetails(daemon: BackendDaemonStatus): string[] {
  const lines: string[] = []
  if (daemon.pid) lines.push(`PID: ${daemon.pid}`)
  const by = startedByText(daemon)
  if (by) lines.push(`Started by: ${by}`)
  if (daemon.url) lines.push(`URL: ${daemon.url}`)
  if (daemon.version) lines.push(`Version: ${daemon.version}`)
  if (daemon.trust?.state === 'trusted') lines.push('Key: trusted by the owner')
  if (daemon.trust?.state === 'not-trusted') lines.push('Key: not trusted. To trust it, run adf identity trust-daemon.')
  if (daemon.localProof && !daemon.localProof.available) lines.push(`Local proof: not available (${daemon.localProof.problem ?? 'unknown reason'})`)
  return lines
}

/** The tone of a state dot. */
function stateTone(state: ConnectionState | BackendDaemonStatus['connection'] | null): 'ok' | 'busy' | 'down' | 'off' {
  if (state === 'connected') return 'ok'
  if (state === 'connecting') return 'busy'
  if (state === 'retrying' || state === 'not-connected' || state === 'disconnected' || state === 'failed') return 'down'
  return 'off'
}

/**
 * Keep running after Studio quits (`keepDaemonRunning`, the one quit
 * setting): what happens at quit, in one sentence. A server that the CLI or
 * a service started is never stopped by Studio.
 */
export function keepRunningText(keep: boolean, daemon: Pick<BackendDaemonStatus, 'startedBy' | 'how'> | null): string {
  if (keep) return 'When you quit Studio, the server and its agents keep running.'
  if (daemon?.startedBy === 'cli') return 'Studio does not stop this server when you quit Studio, because the ADF CLI started it.'
  if (daemon?.startedBy === 'service') return 'Studio does not stop this server when you quit Studio, because a service started it.'
  return 'When you quit Studio, Studio stops the server and its agents.'
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

/** The rows of each section: Local server (local, Inside Studio (legacy)) and Remote servers (saved). Found rows are only in Connect. */
export function splitRows(rows: ConnectionRow[]): { local: ConnectionRow[]; remote: ConnectionRow[] } {
  return {
    local: rows.filter((r) => r.kind === 'local' || r.kind === 'embedded'),
    remote: rows.filter((r) => r.kind === 'saved'),
  }
}

/** "None", "1 server", "2 servers". */
export function serverCount(n: number): string {
  return n === 0 ? 'None' : `${n} ${n === 1 ? 'server' : 'servers'}`
}

export interface RowMenuItem { label: string; onSelect: () => void; danger?: boolean }

/**
 * A row's More menu (···). The menu is a ContextMenu: a body portal with
 * fixed position, so a section's rounded, clipped card never cuts it.
 */
export function RowMenu({ items, disabled }: { items: RowMenuItem[]; disabled: boolean }) {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  const ref = useRef<HTMLButtonElement>(null)
  if (items.length === 0) return null
  const toggle = () => {
    if (position) { setPosition(null); return }
    const rect = ref.current?.getBoundingClientRect()
    setPosition(rect ? { x: rect.right, y: rect.bottom + 4 } : { x: 0, y: 0 })
  }
  return (
    <>
      <IconButton ref={ref} aria-label="More" aria-haspopup="menu" aria-expanded={position !== null} disabled={disabled} onClick={toggle} variant={position ? 'selected' : 'neutral'}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
      </IconButton>
      <RowMenuPopup items={items} position={position} onClose={() => setPosition(null)} anchor={ref} />
    </>
  )
}

/** The More menu's popup: a ContextMenu, rendered into document.body (a portal) at a fixed position. */
export function RowMenuPopup({ items, position, onClose, anchor }: { items: RowMenuItem[]; position: { x: number; y: number } | null; onClose: () => void; anchor?: React.RefObject<HTMLElement | null> }) {
  return <ContextMenu position={position} onClose={onClose} placement={{ x: 'end' }} label="More" anchor={anchor} items={items.map((item) => ({ label: item.label, onSelect: item.onSelect, danger: item.danger }))} />
}

function NotEncryptedBadge() {
  return <span className="rounded bg-[var(--adf-ui-warning-subtle)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--adf-ui-text)]">Not encrypted</span>
}

/** Under Connect's list while the network search runs and found nothing to pair with. */
export function emptyDiscoveryLine(view: Pick<ConnectionsView, 'rows' | 'discovery'>): string | null {
  if (!view.discovery || view.discovery.problem) return null
  return view.rows.some((r) => r.kind === 'found') ? null : 'No server found yet. On the other computer, click Add, then Share.'
}

/** One server row (static markup in tests): icon, name, state, detail, one action, the More menu. */
function ServerRow({ row, busy, separator, menu, onConnect, stateNode, children }: {
  row: ConnectionRow
  busy: boolean
  separator: boolean
  menu: RowMenuItem[]
  onConnect: (id: string) => void
  /** In place of the row's state: the local server's own line. */
  stateNode?: React.ReactNode
  children?: React.ReactNode
}) {
  const detail = connectionDetail(row)
  return (
    <SectionRow
      separator={separator}
      data-connection={row.id}
      actions={<>
        {row.action === 'connect' && <Button size="compact" disabled={busy} onClick={() => onConnect(row.id)}>Connect</Button>}
        <RowMenu items={menu} disabled={busy} />
      </>}
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <span className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-[var(--adf-ui-text)]">
          {row.kind === 'saved' ? <RemoteMark size={14} className="text-[var(--adf-ui-text-muted)]" /> : <span className="text-[var(--adf-ui-text-muted)]"><ServerIcon size={14} /></span>}
          <span className="truncate">{row.name}</span>
        </span>
        {stateNode ?? (row.state && <StateDot tone={stateTone(row.state)}>{CONNECTION_STATE_LABELS[row.state]}</StateDot>)}
        {row.kind === 'saved' && !row.encrypted && <NotEncryptedBadge />}
      </div>
      {detail && <div className="mt-0.5 break-all pl-[22px] font-mono text-[11px] text-[var(--adf-ui-text-muted)]">{detail}</div>}
      {children && <div className="pl-[22px]">{children}</div>}
    </SectionRow>
  )
}

/** Remote servers (static markup in tests): the saved connections, each with its state and More menu. Never the local server. */
export function ConnectionRows({ rows, busy, onConnect, onRemove }: {
  rows: ConnectionRow[]
  busy: boolean
  onConnect: (id: string) => void
  onRemove: (id: string) => void
}) {
  const remote = splitRows(rows).remote
  if (remote.length === 0) return <SectionRow><span className="text-[var(--adf-ui-text-muted)]">None. To add a server, click Add, then Connect.</span></SectionRow>
  return (
    <div>
      {remote.map((row) => (
        <ServerRow
          key={row.id}
          row={row}
          busy={busy}
          separator
          onConnect={onConnect}
          menu={row.removable ? [{ label: 'Remove', onSelect: () => onRemove(row.id), danger: true }] : []}
        />
      ))}
    </div>
  )
}

/** Local server (static markup in tests): the local row (and Inside Studio (legacy)), Details, Keep running after Studio quits. */
export function LocalServerSection({ rows, backend, busy, onConnect, onKeepRunning }: {
  rows: ConnectionRow[]
  backend: BackendSettingsView
  busy: boolean
  onConnect: (id: string) => void
  onKeepRunning: (next: boolean) => void
}) {
  const local = splitRows(rows).local
  const legacyRow = local.some((r) => r.kind === 'embedded')
  const daemon = backend.daemon ?? null
  const inUse = backend.active.mode === 'local'
  const localRow = local.find((r) => r.kind === 'local')
  return (
    <PageSection id="local" title="Local server" help={LOCAL_HELP} docs={DOCS.backendLocalServer} collapsible open>
      {local.map((row, i) => {
        const menu: RowMenuItem[] = row.kind === 'local' && !legacyRow ? [{ label: 'Inside Studio (legacy)', onSelect: () => onConnect('embedded') }] : []
        const daemonHere = row.kind === 'local' && inUse && daemon
        const errors = daemonHere ? [
          daemon.localProof && !daemon.localProof.available
            ? 'Studio refuses reveal and identity import. Fix the permissions of the server\'s data folder, then restart the server.'
            : null,
          daemon.keychainProblem,
        ].filter(Boolean).join(' ') : ''
        return (
          <ServerRow key={row.id} row={row} busy={busy} separator menu={menu} onConnect={onConnect} stateNode={daemonHere ? <StateDot tone={stateTone(daemon.connection)}>{daemonLine(daemon)}</StateDot> : undefined}>
            {daemonHere && <>
              {daemon.message && <div className="mt-1 text-[11px] text-[var(--adf-ui-text-subtle)]">{daemon.message}</div>}
              {errors && <div className="mt-1 text-[11px] text-[var(--adf-ui-danger)]">{errors}</div>}
              <DetailsList lines={daemonDetails(daemon)} />
            </>}
          </ServerRow>
        )
      })}
      {inUse && localRow && (
        <SectionRow actions={<Switch label="Keep running after Studio quits" checked={backend.configured.keepDaemonRunning} disabled={busy} onChange={onKeepRunning} />}>
          <div className="text-[13px] font-medium text-[var(--adf-ui-text)]">Keep running after Studio quits</div>
          <div className="mt-0.5 leading-5 text-[var(--adf-ui-text-muted)]">{keepRunningText(backend.configured.keepDaemonRunning, daemon)}<LearnMore href={DOCS.backendQuit} /></div>
        </SectionRow>
      )}
      {backend.defaultSwitch && (
        <SectionRow>
          <div className="text-[13px] font-medium text-[var(--adf-ui-text)]">Default changed</div>
          <div className="mt-0.5 leading-5 text-[var(--adf-ui-text-muted)]">{defaultSwitchLine(backend.defaultSwitch)}<LearnMore href={DOCS.backendUpgrade} /></div>
          {defaultSwitchDetails(backend.defaultSwitch).notDone && <div className="mt-1 text-[11px] text-[var(--adf-ui-text-subtle)]">{defaultSwitchDetails(backend.defaultSwitch).notDone}</div>}
          <DetailsList lines={[defaultSwitchDetails(backend.defaultSwitch).moved]} />
        </SectionRow>
      )}
    </PageSection>
  )
}

/** The Local server heading's help sentence. */
export const LOCAL_HELP = 'The agent server on this computer.'

/** Remote servers: collapsed while none is saved; the heading keeps the count. */
export function RemoteServersSection({ rows, busy, onConnect, onRemove }: {
  rows: ConnectionRow[]
  busy: boolean
  onConnect: (id: string) => void
  onRemove: (id: string) => void
}) {
  const count = splitRows(rows).remote.length
  return (
    <PageSection id="remote" title="Remote servers" help={REMOTES_HELP} summary={serverCount(count)} docs={DOCS.backendRemoteServers} collapsible open={count > 0}>
      <ConnectionRows rows={rows} busy={busy} onConnect={onConnect} onRemove={onRemove} />
    </PageSection>
  )
}

/** The Remote servers heading's help sentence. */
export const REMOTES_HELP = 'Agent servers on other computers that this Studio connects to.'

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
  return `${found.address} now answers as another server (${shown}). Select it in the list again.`
}

/** Connect's list: the Not paired rows of this computer's network search. */
export function foundTargets(rows: ConnectionRow[]): AddTarget[] {
  return rows
    .filter((r) => r.kind === 'found' && !!r.url && !!r.fingerprint)
    .map((r) => ({ name: r.name, url: r.url!, address: r.address ?? r.url!, fingerprint: r.fingerprint!, encrypted: r.encrypted, pairingOpen: r.pairingOpen }))
}

/** The servers found (static in tests): pick one, or type an address below. */
export function FoundList({ targets, selected, disabled, onPick }: { targets: AddTarget[]; selected: string | null; disabled: boolean; onPick: (target: AddTarget) => void }) {
  if (targets.length === 0) return null
  return (
    <ul aria-label="Found" className="divide-y divide-[var(--adf-ui-separator)] overflow-hidden rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)]">
      {targets.map((t) => (
        <li key={`${t.fingerprint}@${t.url}`}>
          <button
            type="button"
            disabled={disabled}
            aria-pressed={selected === t.url}
            onClick={() => onPick(t)}
            className={`flex w-full items-center gap-2.5 px-3 py-2 text-left ${selected === t.url ? 'bg-[var(--adf-ui-accent-subtle)]' : 'hover:bg-[var(--adf-ui-surface-hover)]'}`}
          >
            <span className="shrink-0 text-[var(--adf-ui-text-muted)]"><ServerIcon size={14} /></span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium text-[var(--adf-ui-text)]">{t.name}</span>
              <span className="block break-all font-mono text-[11px] text-[var(--adf-ui-text-muted)]">{[t.address, t.fingerprint, t.pairingOpen ? 'Pairing open' : null].filter(Boolean).join(' · ')}</span>
            </span>
            {!t.encrypted && <span className="shrink-0"><NotEncryptedBadge /></span>}
          </button>
        </li>
      ))}
    </ul>
  )
}

/** The one sentence under Connect's fields. */
export const CONNECT_FIELDS_HELP = 'Enter a code or a token. To get a code, click Add, then Share on the other server.'

/** What Connect sends with the fields as filled: a token is saved, a code pairs. Both or neither: nothing. */
export function connectMethod(code: string, token: string): 'code' | 'token' | 'both' | null {
  const c = code.replace(/\s/g, '')
  const t = token.trim()
  if (c && t) return 'both'
  if (t) return 'token'
  return c ? 'code' : null
}

/** A labelled field on Connect: the label above, one word. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[12px] font-medium text-[var(--adf-ui-text)]">{label}</span>
      {children}
    </label>
  )
}

/** Connect's form (static in tests): the found picks, then Address, Code and Token, all visible. */
export function ConnectForm({ targets, searching = false, found, url, code, token, insecure, trusted, invalid, empty, problem, busy, onPick, onUrl, onCode, onToken, onTrusted }: {
  targets: AddTarget[]
  /** The network search runs. */
  searching?: boolean
  found: AddTarget | null
  url: string
  code: string
  token: string
  insecure: boolean
  trusted: boolean
  invalid: string | null
  empty: string | null
  problem: string | null
  busy: boolean
  onPick: (target: AddTarget) => void
  onUrl: (url: string) => void
  onCode: (code: string) => void
  onToken: (token: string) => void
  onTrusted: (trusted: boolean) => void
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <div className="text-[12px] font-medium text-[var(--adf-ui-text)]">Found</div>
        <FoundList targets={targets} selected={found?.url ?? null} disabled={busy} onPick={onPick} />
        {targets.length === 0 && !empty && !problem && <p className="text-[12px] text-[var(--adf-ui-text-subtle)]">{searching ? 'Searching your networks…' : 'No server found.'}</p>}
        {empty && <p className="text-[12px] text-[var(--adf-ui-text-subtle)]">{empty}</p>}
        {problem && <p className="text-[12px] text-[var(--adf-ui-text-subtle)]">{problem}</p>}
        {found && <p className="text-[12px] text-[var(--adf-ui-text-muted)]">{found.name} at {found.address}, fingerprint {found.fingerprint}.</p>}
      </div>
      <Field label="Address">
        <TextInput value={url} onChange={(e) => onUrl(e.target.value)} placeholder="https://host-1.tail1234.ts.net" spellCheck={false} autoComplete="off" aria-label="Address" className="font-mono" autoFocus />
      </Field>
      {invalid && <p className="text-[12px] text-[var(--adf-ui-danger)]">{invalid}</p>}
      {insecure && (
        <label className="flex items-start gap-2 text-[12px] text-[var(--adf-ui-text-muted)]">
          <input type="checkbox" checked={trusted} onChange={(e) => onTrusted(e.target.checked)} className="mt-0.5 rounded text-blue-500" aria-label="Send without encryption" />
          <span><span className="font-medium text-[var(--adf-ui-text)]">Send without encryption</span><span className="block">This address uses http. Anyone on this network can read the code and the token.</span></span>
        </label>
      )}
      <div className="grid grid-cols-1 gap-3 min-[560px]:grid-cols-2">
        <Field label="Code">
          <TextInput value={code} onChange={(e) => onCode(e.target.value)} inputMode="numeric" maxLength={7} placeholder="123 456" spellCheck={false} autoComplete="off" aria-label="Code" className="font-mono tracking-[0.15em]" />
        </Field>
        <Field label="Token">
          <TextInput type="password" value={token} onChange={(e) => onToken(e.target.value)} spellCheck={false} autoComplete="off" aria-label="Token" className="font-mono" />
        </Field>
      </div>
      <p className="text-[12px] leading-5 text-[var(--adf-ui-text-muted)]">{CONNECT_FIELDS_HELP}<LearnMore href={DOCS.backendAddConnection} /></p>
    </div>
  )
}

/**
 * Add → Connect (settings-scopes.md §5.3, multi-runtime.md §6.5): a server
 * found on the network, or an Address; then a Code or a Token. With a code,
 * Connect asks the server's hello, then shows its fingerprint to check, and
 * Pair sends the code. With a token, Connect saves the connection at once
 * (main checks the hello and pins the fingerprint). Without a hello the
 * token is the only way, and the connection has no fingerprint. On a found
 * server the hello must show its fingerprint. On success the connection is
 * saved and connects: Done is the only button.
 */
export function AddConnectionDialog({ onClose, onBack, found: initialFound = null }: { onClose: () => void; onBack?: () => void; found?: AddTarget | null }) {
  const rows = useConnectionStore((s) => s.view?.rows ?? null)
  const search = useConnectionStore((s) => s.view?.discovery ?? null)
  const targets = foundTargets(rows ?? [])
  const [found, setFound] = useState<AddTarget | null>(initialFound)
  const [url, setUrl] = useState(initialFound?.url ?? '')
  const [trusted, setTrusted] = useState(false)
  const [step, setStep] = useState<'form' | 'check' | 'done'>('form')
  const [pair, setPair] = useState<RemotePairState | null>(null)
  const [code, setCode] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [confirmDialog, confirm] = useConfirm()
  const check = url.trim() ? checkRemoteDaemonUrl(url) : null
  const insecure = check?.kind === 'insecure-http'
  const empty = rows ? emptyDiscoveryLine({ rows, discovery: search }) : null
  const method = connectMethod(code, token)

  // This computer's network search, while Connect is open.
  useEffect(() => {
    void window.adfApi?.startRemoteDiscovery?.().catch(() => {})
    return () => { void window.adfApi?.stopRemoteDiscovery?.().catch(() => {}) }
  }, [])

  useEffect(() => window.adfApi?.onRemotePairingState?.((next) => {
    if (step !== 'check' || (next.host && check?.url && next.host.url !== check.url)) return
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
  /** Code: the hello, then the fingerprint to check. */
  const hello = async () => {
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
      if (state.step === 'need_code' && !state.code) { setStep('check'); setMessage(state.message ? { kind: 'ok', text: state.message } : null); return }
      if (state.code && TOKEN_ONLY.has(state.code)) { setMessage({ kind: 'error', text: 'This server has no fingerprint, so it cannot pair with a code. Enter a token.' }); return }
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
  const connect = () => {
    if (method === 'token') void saveToken()
    else if (method === 'code') void hello()
  }
  const close = () => {
    if (step === 'check') void window.adfApi.cancelRemotePairing()
    onClose()
  }
  const back = () => {
    if (step === 'check') { void window.adfApi.cancelRemotePairing(); setStep('form'); setPair(null); setMessage(null); return }
    onBack?.()
  }
  const waiting = pair?.step === 'claiming' || pair?.step === 'waiting'
  const addressReady = !!check?.url && (!insecure || trusted)
  const codeReady = code.replace(/\s/g, '').length === 6

  return (
    <Dialog open title="Connect" onClose={close} lightDismiss={false} wide>
      {confirmDialog}
      <div className="space-y-4 text-[12px]">
        {step === 'form' && (
          <ConnectForm
            targets={targets}
            searching={!!search && !search.problem}
            found={found}
            url={url}
            code={code}
            token={token}
            insecure={insecure}
            trusted={trusted}
            invalid={check?.kind === 'invalid' ? check.reason ?? null : null}
            empty={empty}
            problem={search?.problem ?? null}
            busy={busy}
            onPick={pick}
            onUrl={(next) => { setUrl(next); if (found && next !== found.url) setFound(null) }}
            onCode={setCode}
            onToken={setToken}
            onTrusted={setTrusted}
          />
        )}
        {step === 'check' && pair?.host && (
          <div className="space-y-3">
            <div className="flex items-center gap-2.5 rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] px-3 py-2.5">
              <span className="text-[var(--adf-ui-text-muted)]"><ServerIcon size={16} /></span>
              <span className="min-w-0">
                <span className="block text-[13px] font-medium text-[var(--adf-ui-text)]">{pair.host.name}</span>
                <span className="block break-all font-mono text-[11px] text-[var(--adf-ui-text-muted)]">{pair.host.url} · {pair.host.fingerprint}</span>
              </span>
            </div>
            <p className="text-[var(--adf-ui-text-muted)]">Check that {pair.host.name} shows fingerprint {pair.host.fingerprint}.</p>
            <Field label="Code">
              <TextInput value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" maxLength={7} placeholder="123 456" disabled={waiting} aria-label="Code" className="font-mono text-[18px] tracking-[0.2em]" />
            </Field>
          </div>
        )}
        {method === 'both' && step === 'form' && <p className="text-[var(--adf-ui-danger)]">Enter a code or a token, not both.</p>}
        <MessageLine message={message} />
        <div className="flex justify-end gap-2 border-t border-[var(--adf-ui-separator)] pt-3">
          {step === 'done' ? (
            <Button variant="primary" onClick={onClose}>Done</Button>
          ) : (
            <>
              {(onBack || step === 'check') && <Button onClick={back}>Back</Button>}
              <Button onClick={close}>Cancel</Button>
              {step === 'form' && <Button variant="primary" disabled={!addressReady || (method !== 'code' && method !== 'token')} loading={busy} onClick={connect}>Connect</Button>}
              {step === 'check' && <Button variant="primary" disabled={!codeReady} loading={busy || waiting} onClick={() => void sendCode()}>Pair</Button>}
            </>
          )}
        </div>
      </div>
    </Dialog>
  )
}

/** The help line of each Add choice (owner decision 2026-10-21, server naming). */
export const CONNECT_HELP = 'Connect to a remote agent server.'
/** Share always shares the local server: named `<name> (Local)` while there is more than one server (review A6). */
export function shareHelp(runtime: string | null | undefined): string {
  return runtime ? `Share ${runtime}.` : 'Share this server.'
}
export const SHARE_HELP = shareHelp(null)

function ChoiceCard({ title, help, icon, disabled, reason, onClick }: { title: string; help: string; icon: React.ReactNode; disabled?: boolean; reason?: string | null; onClick: () => void }) {
  const card = (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      data-choice={title.toLowerCase()}
      className="group flex h-full w-full flex-col items-center gap-3 rounded-[var(--adf-ui-container-radius)] border border-[var(--adf-ui-border)] bg-[var(--adf-ui-canvas)] px-4 py-5 text-center transition-colors hover:border-[var(--adf-ui-accent)] hover:bg-[var(--adf-ui-accent-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--adf-ui-accent)] disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-[var(--adf-ui-border)] disabled:hover:bg-[var(--adf-ui-canvas)]"
    >
      <span className="text-[var(--adf-ui-text-muted)] transition-colors group-hover:text-[var(--adf-ui-accent)]">{icon}</span>
      <span className="space-y-0.5">
        <span className="block text-[13px] font-semibold text-[var(--adf-ui-text)]">{title}</span>
        <span className="block text-[12px] text-[var(--adf-ui-text-muted)]">{help}</span>
      </span>
    </button>
  )
  return disabled && reason ? <Tooltip tip={reason} className="flex">{card}</Tooltip> : card
}

/** Add's first step (static in tests): Connect and Share, side by side. Share needs the local server (Local mode). */
export function AddChoice({ share, runtime = null, onConnect, onShare }: { share: { available: boolean; reason: string | null }; runtime?: string | null; onConnect: () => void; onShare: () => void }) {
  return (
    <div className="grid grid-cols-2 gap-3" data-add-choice="">
      <ChoiceCard title="Connect" help={CONNECT_HELP} icon={<ConnectIcon size={44} />} onClick={onConnect} />
      <ChoiceCard title="Share" help={shareHelp(runtime)} icon={<ShareIcon size={44} />} disabled={!share.available} reason={share.reason} onClick={onShare} />
    </div>
  )
}

/** Add: Connect (this Studio uses a remote server) or Share (other computers use this server). */
export function AddDialog({ runtime = null, onClose }: { runtime?: string | null; onClose: () => void }) {
  const [choice, setChoice] = useState<'choose' | 'connect' | 'share'>('choose')
  const [share, setShare] = useState<{ available: boolean; reason: string | null }>({ available: true, reason: null })
  useEffect(() => {
    let alive = true
    window.adfApi?.getRemoteAccess?.().then((v) => { if (alive) setShare({ available: v.available, reason: v.unavailableReason }) }).catch(() => {})
    return () => { alive = false }
  }, [])
  if (choice === 'connect') return <AddConnectionDialog onClose={onClose} onBack={() => setChoice('choose')} />
  return (
    <Dialog open title={choice === 'share' ? 'Share' : 'Add'} onClose={onClose} lightDismiss={false} wide>
      {choice === 'choose' ? (
        <div className="space-y-4 text-[12px]">
          <AddChoice share={share} runtime={runtime} onConnect={() => setChoice('connect')} onShare={() => setChoice('share')} />
          <div className="flex justify-end border-t border-[var(--adf-ui-separator)] pt-3">
            <Button onClick={onClose}>Cancel</Button>
          </div>
        </div>
      ) : (
        <SharePanel runtime={runtime} onBack={() => setChoice('choose')} onDone={onClose} />
      )}
    </Dialog>
  )
}

/** Add, the one on the page, with the page's message line. */
export function AddBar({ busy, message, onAdd }: { busy: boolean; message: { kind: 'ok' | 'error'; text: string } | null; onAdd: () => void }) {
  return (
    <div className="flex items-center justify-end gap-3">
      <MessageLine message={message} />
      <Button variant="primary" disabled={busy} onClick={onAdd}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        Add
      </Button>
    </div>
  )
}

/** The page (static in tests): notices, Add, Local server, Remote servers, Devices. */
export function ConnectionsPage({ view, backend, busy, message, onAdd, onConnect, onRemove, onKeepRunning, onRestart, devices }: {
  view: ConnectionsView
  backend: BackendSettingsView
  busy: boolean
  message: { kind: 'ok' | 'error'; text: string } | null
  onAdd: () => void
  onConnect: (id: string) => void
  onRemove: (id: string) => void
  onKeepRunning: (next: boolean) => void
  onRestart: () => void
  devices: React.ReactNode
}) {
  const override = overrideLine(backend)
  const nextLine = nextLaunchLine(backend, view.next)
  return (
    <div className="space-y-5" data-connections-page="">
      {(backend.active.notices.length > 0 || override) && (
        <div role="status" className="rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-warning)]/30 bg-[var(--adf-ui-warning-subtle)] px-3 py-2 text-[12px] text-[var(--adf-ui-text)]">
          {override && <p>{override}</p>}
          {backend.active.notices.map((notice) => <p key={notice}>{notice}</p>)}
        </div>
      )}
      {nextLine && (
        <div role="status" className="flex items-center justify-between gap-3 rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] px-3 py-2 text-[12px] text-[var(--adf-ui-text)]">
          <span>{nextLine}</span>
          <Button size="compact" onClick={onRestart}>Restart</Button>
        </div>
      )}
      <AddBar busy={busy} message={message} onAdd={onAdd} />
      <LocalServerSection rows={view.rows} backend={backend} busy={busy} onConnect={onConnect} onKeepRunning={onKeepRunning} />
      <RemoteServersSection rows={view.rows} busy={busy} onConnect={onConnect} onRemove={onRemove} />
      {devices}
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
  const shared = runtimeLabel(LOCAL_RUNTIME, useRuntimes())

  useEffect(() => {
    startConnectionFeed()
    let cancelled = false
    window.adfApi?.getBackendSettings()
      .then((next) => { if (!cancelled) setBackend(next) })
      .catch(() => { if (!cancelled) setLoadError('Studio could not read the connection settings.') })
    return () => { cancelled = true }
  }, [])

  // While the local server connects, follow it.
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

  /** Keep running after Studio quits: written at once, "Saved" in the header, put back on a refusal. */
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

  if (!view || !backend) {
    return (
      <PageSection id="loading" title="Connections">
        <SectionRow separator={false}><span className="text-[var(--adf-ui-text-muted)]">{loadError ?? 'Loading…'}</span></SectionRow>
      </PageSection>
    )
  }

  // Share names the local server while there is more than one (review A6); Devices always names it.
  const localName = view.rows.find((r) => r.kind === 'local')?.name ?? (view.current.kind === 'local' ? view.current.name : LOCAL_LABEL)

  return (
    <>
      <ConnectionsPage
        view={view}
        backend={backend}
        busy={busy}
        message={message}
        onAdd={() => setAdding(true)}
        onConnect={connect}
        onRemove={remove}
        onKeepRunning={saveKeepRunning}
        onRestart={() => void window.adfApi.restartStudio()}
        devices={<DevicesGroup runtime={localName} />}
      />
      {adding && <AddDialog runtime={shared} onClose={() => setAdding(false)} />}
    </>
  )
}
