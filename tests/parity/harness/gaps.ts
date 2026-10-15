import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { IPC } from '../../../src/shared/constants/ipc-channels'
import { CLIENT_SETTINGS_KEYS } from '../../../src/shared/constants/client-settings-keys'
import { clientSettingsDefaults } from '../../../src/main/backend/daemon-mode/settings'
import { REMOTE_OWNER_BACKUP_SENTENCE, REMOTE_OWNER_IDENTITY_SENTENCE } from '../../../src/shared/constants/remote-owner-identity'
import type { ComparableRecording, RawRecording, StepRecord } from './recording'

/**
 * The daemon backend's known differences from the embedded baseline, as
 * named transforms (tracker W2-C, README "Daemon backend").
 *
 * Each entry acts on ONE place of the daemon's normalized recording, is
 * tagged with the workstream that removes the difference (or `mode` for a
 * documented per-mode expectation), and is applied to the daemon side only.
 * A transform checks that the daemon shows exactly the known difference
 * before it rewrites it; it returns how often it matched. daemon.test.ts
 * fails when an entry matches nothing in a scenario it lists (the gap was
 * fixed: remove the entry), and when anything is left after all entries ran.
 * So the list can only shrink.
 *
 * docs/design/daemon-backend-gaps.md "Parity diffs after W2-C" is generated
 * from this list (renderGapTable; tests/parity/gaps-doc.test.ts keeps them
 * in step).
 */

/** The daemon bundle's version (electron.vite.config.ts defines __ADF_VERSION__ from package.json). */
const BUILD_VERSION = (JSON.parse(readFileSync(resolve(__dirname, '../../../package.json'), 'utf-8')) as { version: string }).version

export type GapTag = 'W1-A' | 'W2-A' | 'W2-C2' | 'W0-C' | 'W0-D' | 'W3-A' | 'W4-A' | 'E3' | 'W5-A' | 'mode'

/** Which daemon-mode run a recording comes from: local mode, or remote mode behind the remote-acting proxy (W4-B). */
export type ParityBackendKind = 'daemon' | 'remote'

export interface GapEntry {
  id: string
  ws: GapTag
  scenarios: readonly string[]
  /** The runs the entry applies to; default both. A by-design difference of remote mode names `['remote']`. */
  backends?: readonly ParityBackendKind[]
  /** The one place the transform acts on. */
  path: string
  /** The difference, in one sentence. */
  what: string
  /** `raw.daemon`: the daemon run before normalization, for entries that must check a value the normalizer replaced. */
  apply(daemon: ComparableRecording, embedded: ComparableRecording, raw?: { daemon: RawRecording }, backend?: ParityBackendKind): number
}

/** daemon-mode/handlers/providers.ts REMOTE_VALUES_UNSUPPORTED (not imported: that module pulls in Studio main). A change fails the entry as unmatched. */
const REMOTE_VALUES_UNSUPPORTED = "Stored credential values stay on the daemon's machine: a remote daemon never sends them to Studio."

const CORE = ['open-agent', 'start-agent', 'chat-tool-call'] as const
/** W3-B scenarios (tests/parity/settings, tests/parity/identity) that run no agent. */
const W3B_NO_AGENT = ['provider-round-trip', 'agent-provider-key', 'subscription-status', 'owner-identity', 'locked-credentials', 'owner-import', 'owner-sealed-key'] as const
/** The W3-B scenarios that start agent-1 and leave it running (as chat-tool-call). */
const W3B_RUNNING = ['agent-keystore', 'agent-claim'] as const
/** W3-C scenarios (tests/parity/mcp): no agent runs, the fixture files are edited closed. */
const W3C = ['w3c-install-progress', 'w3c-mcp-attach-credentials', 'w3c-adapter-telegram', 'w3c-mcp-connect-test', 'w3c-mcp-oauth-connect'] as const
/** Scenarios that open a file that is not running, held by the client session (W2-C2). */
const HELD_ONLY = ['legacy-password-unlock'] as const
/** W3-A scenarios (tests/parity/documents) that start an agent and stop it before the state dump. */
const W3A_RAN = ['switch-with-background', 'password-unlock', 'config-during-start', 'rename-while-running'] as const
/** W3-A scenarios that run no agent. */
const W3A_NO_AGENT = ['review-accept-foreign', 'template-create', 'delete', 'doc-resources'] as const
/** W3-F scenarios (tests/parity/conflicts) that start an agent and stop it before the state dump. */
const W3F_RAN = ['w3f-write-conflicts'] as const
const ALL = [...CORE, ...W3B_NO_AGENT, ...W3B_RUNNING, ...W3C, ...HELD_ONLY, ...W3A_RAN, ...W3A_NO_AGENT, ...W3F_RAN] as const
const RUNNING = ['start-agent', 'chat-tool-call', ...W3B_RUNNING] as const
/** The mesh scenarios (tests/parity/mesh, W3-D). */
const MESH = ['fleet-map', 'emergency-stop'] as const
/** The mesh-status channels whose results carry fleet rows (MESH_STATUS, MESH_FLEET_STATUS, MESH_MAP_POLL). */
const FLEET_ROW_CHANNELS = new Set<string>([IPC.MESH_STATUS, IPC.MESH_FLEET_STATUS, IPC.MESH_MAP_POLL])

// --- helpers ------------------------------------------------------------------

/** Key-sorted JSON: two normalized values are equal when this is. */
function canon(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
    : v))
}
const same = (a: unknown, b: unknown): boolean => canon(a) === canon(b)
const clone = <T>(v: T): T => structuredClone(v)

type Row = Record<string, unknown>
function table(rec: ComparableRecording, name: string): Array<{ file: string; rows: Row[] }> {
  return Object.entries(rec.state.adf).flatMap(([file, dump]) => (dump.tables[name] ? [{ file, rows: dump.tables[name].rows as Row[] }] : []))
}
const leaseFiles = (rec: ComparableRecording) => Object.keys(rec.state.leases)

/**
 * Walk a daemon value and the embedded value at the same place: `visit`
 * sees every pair of objects and answers how many changes it made. Arrays
 * are walked only when their lengths match.
 */
function walkPair(d: unknown, e: unknown, visit: (d: Row, e: Row) => number): number {
  if (Array.isArray(d) && Array.isArray(e)) return d.length === e.length ? d.reduce<number>((n, v, i) => n + walkPair(v, e[i], visit), 0) : 0
  if (!d || !e || typeof d !== 'object' || typeof e !== 'object' || Array.isArray(d) || Array.isArray(e)) return 0
  let n = visit(d as Row, e as Row)
  for (const k of Object.keys(d)) if (k in (e as Row)) n += walkPair((d as Row)[k], (e as Row)[k], visit)
  return n
}

/** walkPair with the daemon's raw (not normalized) value at the same place. */
function walkRaw(d: unknown, e: unknown, r: unknown, visit: (d: Row, e: Row, r: Row) => number): number {
  if (Array.isArray(d) && Array.isArray(e) && Array.isArray(r)) {
    return d.length === e.length && d.length === r.length ? d.reduce<number>((n, v, i) => n + walkRaw(v, e[i], r[i], visit), 0) : 0
  }
  const obj = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v)
  if (!obj(d) || !obj(e) || !obj(r)) return 0
  let n = visit(d, e, r)
  for (const k of Object.keys(d)) if (k in e && k in r) n += walkRaw(d[k], e[k], r[k], visit)
  return n
}

/** The invoke results of fleet-row channels, daemon and embedded side by side. */
function fleetResults(d: ComparableRecording, e: ComparableRecording): Array<[unknown, unknown]> {
  const out: Array<[unknown, unknown]> = []
  d.steps.forEach((step, i) => {
    const base = e.steps[i]
    if (step.kind !== 'invoke' || base?.kind !== 'invoke' || step.channel !== base.channel || !FLEET_ROW_CHANNELS.has(step.channel)) return
    out.push([step.result, base.result])
  })
  return out
}

/** A timeline's lines for step `n`, between `> n …` and `< n`. */
function stepBlock(lines: string[], n: number): { from: number; to: number } | null {
  const from = lines.findIndex((l) => l.startsWith(`> ${n} `))
  const to = lines.findIndex((l, i) => i > from && (l === `< ${n}` || l.startsWith(`< ${n} `)))
  return from >= 0 && to > from ? { from: from + 1, to } : null
}
const isMeshEventLine = (line: string) => /^ {2}(?:\[app\] )?adf:mesh:event /.test(line)

type MenuItem = { label?: string; type?: string; role?: string; enabled?: boolean; submenu?: MenuItem[] }
const STATUS_LINE = /^ADF daemon: /

/**
 * The Help items daemon mode adds (menu.ts daemonHelpItems), stripped one by
 * one: the separator and "Open Daemon Log" right after "ADF Studio
 * Documentation", then the disabled status line and "Reconnect to the ADF
 * Daemon" when present. Anything else stays (and shows in the diff).
 * Answers null when the menu lacks the daemon items.
 */
function stripDaemonHelp(items: unknown): { items: MenuItem[]; status: boolean } | null {
  if (!Array.isArray(items)) return null
  let found = false
  let status = false
  const out = (items as MenuItem[]).map((item) => {
    if (item.role !== 'help' || !Array.isArray(item.submenu)) return item
    const sub = [...item.submenu]
    const at = sub.findIndex((s) => s.label === 'ADF Studio Documentation') + 1
    if (at === 0 || sub[at]?.type !== 'separator' || sub[at + 1]?.label !== 'Open Daemon Log') return item
    found = true
    let end = at + 2
    if (sub[end]?.enabled === false && STATUS_LINE.test(sub[end]?.label ?? '')) { status = true; end++ }
    if (status && sub[end]?.label === 'Reconnect to the ADF Daemon') end++
    sub.splice(at, end - at)
    return { ...item, submenu: sub }
  })
  return found ? { items: out, status } : null
}

// --- the list -----------------------------------------------------------------

export const GAP_ALLOWLIST: readonly GapEntry[] = [
  {
    id: 'mode:wire-undefined-keys',
    ws: 'mode',
    scenarios: ['chat-tool-call'],
    path: 'pushes: payload keys whose embedded value is `undefined` (e.g. file_updated `previousContent`)',
    what: 'The client stream is JSON: a key whose value is undefined is omitted (D5.1 wire serialization), where embedded IPC keeps the key with undefined. The renderer reads both the same.',
    apply(d, e) {
      let n = 0
      const restore = (dv: unknown, ev: unknown): void => {
        if (!dv || !ev || typeof dv !== 'object' || typeof ev !== 'object') return
        if (Array.isArray(ev)) {
          if (Array.isArray(dv)) ev.forEach((item, i) => restore(dv[i], item))
          return
        }
        const dObj = dv as Record<string, unknown>
        for (const [k, v] of Object.entries(ev as Record<string, unknown>)) {
          if (v === undefined && !(k in dObj)) { dObj[k] = undefined; n++ } else restore(dObj[k], v)
        }
      }
      for (const [ch, list] of Object.entries(e.pushes)) {
        const mine = d.pushes[ch]
        if (!mine || mine.length !== list.length) continue
        list.forEach((ev, i) => { if (same(mine[i], ev)) restore(mine[i], ev) })
      }
      return n
    },
  },
  {
    id: 'w5a:restore-delegation-date',
    ws: 'W5-A',
    scenarios: ['owner-import'],
    path: 'runtimeDelegation: IDENTITY_OWNER_STATUS results after the restore, and adf-settings.json',
    what: 'Visible: after restoring the same owner, embedded Studio re-signs its runtime delegation, so Settings → Identity shows a new signing date and signature; the daemon keeps the delegation it adopted from Studio (§5.3: only Studio writes its runtime identity), still valid, with the old date. W5-A decides: the daemon re-signs, or Studio rewrites the studio-runtime entry after a restore (W4-A).',
    apply(d, e) {
      let n = 0
      const ORIGINAL = '<sig:runtime-delegation>'
      type Delegation = { issuer?: unknown; subject?: unknown; role?: unknown; signature?: unknown; issued_at?: unknown }
      const swap = (mine: Delegation | undefined, theirs: Delegation | undefined): Delegation | undefined => {
        if (!mine || !theirs || mine.signature !== ORIGINAL || theirs.signature === ORIGINAL) return undefined
        if (mine.issuer !== theirs.issuer || mine.subject !== theirs.subject || mine.role !== theirs.role) return undefined
        if (!/^<sig:valid#\d+>$/.test(String(theirs.signature))) return undefined
        n++
        return clone(theirs)
      }
      d.steps.forEach((step, i) => {
        const base = e.steps[i]
        if (step.kind !== 'invoke' || base?.kind !== 'invoke' || step.channel !== IPC.IDENTITY_OWNER_STATUS) return
        const r = step.result as { runtimeDelegation?: Delegation }
        const next = swap(r?.runtimeDelegation, (base.result as { runtimeDelegation?: Delegation })?.runtimeDelegation)
        if (next) r.runtimeDelegation = next
      })
      const settings = d.state.userDataJson['adf-settings.json'] as { runtimeDelegation?: Delegation } | undefined
      const baseSettings = e.state.userDataJson['adf-settings.json'] as { runtimeDelegation?: Delegation } | undefined
      const next = swap(settings?.runtimeDelegation, baseSettings?.runtimeDelegation)
      if (next && settings) settings.runtimeDelegation = next
      return n
    },
  },
  {
    id: 'mode:help-menu',
    ws: 'mode',
    scenarios: [...ALL, ...MESH],
    path: 'local calls: Menu.setApplicationMenu (Help: the separator, "Open Daemon Log", the status line, "Reconnect to the ADF Daemon")',
    what: 'Daemon mode adds a separator, "Open Daemon Log" and, while not connected, the status line (and "Reconnect to the ADF Daemon") to Help (§8.1). A menu built while not connected (at boot: connecting) is rebuilt on connect; those calls carry the status line and are the daemon mode\'s own.',
    apply(d, e) {
      const menus = (calls: typeof d.local) => calls.filter((c) => c.api === 'Menu.setApplicationMenu').length
      let n = 0
      const out: typeof d.local = []
      for (const call of d.local) {
        if (call.api !== 'Menu.setApplicationMenu') { out.push(call); continue }
        const stripped = stripDaemonHelp(call.args[0])
        if (!stripped) return 0
        n++
        if (stripped.status) continue
        out.push({ ...call, args: [stripped.items, ...call.args.slice(1)] })
      }
      // Every remaining call is one embedded makes too.
      if (menus(out) !== menus(e.local)) return 0
      d.local = out
      return n
    },
  },
  {
    id: 'mode:client-settings-file',
    ws: 'mode',
    scenarios: [...ALL, ...MESH],
    path: 'state: user-data/studio-client-settings.json, compared as one merged view with adf-settings.json',
    what: 'Client keys live in studio-client-settings.json (§4.2); a key in both files MUST have one value.',
    apply(d) {
      const settings = d.state.userDataJson['adf-settings.json'] as Record<string, unknown> | undefined
      const client = d.state.userDataJson['studio-client-settings.json'] as Record<string, unknown> | undefined
      if (!settings || !client) return 0
      for (const [key, value] of Object.entries(client)) {
        if (key in settings && !same(settings[key], value)) {
          throw new Error(`parity gaps: client key ${key} is in both settings files with different values (${canon(settings[key])} / ${canon(value)})`)
        }
        settings[key] = value
      }
      d.state.userDataJson['adf-settings.json'] = Object.fromEntries(Object.keys(settings).sort().map((k) => [k, settings[k]]))
      delete d.state.userDataJson['studio-client-settings.json']
      d.state.tree = d.state.tree.filter((l) => l !== 'f user-data/studio-client-settings.json')
      return 1
    },
  },
  {
    id: 'mode:client-defaults-unwritten',
    ws: 'mode',
    scenarios: [...ALL, ...MESH],
    path: 'state: user-data/adf-settings.json (merged with studio-client-settings.json): client keys at their shipped default',
    what: 'Embedded SettingsService writes every client key, defaults included; in daemon mode a client key at its default is in no file (ClientSettingsStore answers the default, and the daemon never writes client keys, §4.1).',
    apply(d, e) {
      const settings = d.state.userDataJson['adf-settings.json'] as Record<string, unknown> | undefined
      const base = e.state.userDataJson['adf-settings.json'] as Record<string, unknown> | undefined
      if (!settings || !base || 'studio-client-settings.json' in d.state.userDataJson) return 0
      const defaults = clientSettingsDefaults() as Record<string, unknown>
      let n = 0
      for (const key of CLIENT_SETTINGS_KEYS) {
        if (key in settings || !(key in base) || !(key in defaults) || !same(base[key], defaults[key])) continue
        settings[key] = defaults[key]
        n++
      }
      if (n > 0) d.state.userDataJson['adf-settings.json'] = Object.fromEntries(Object.keys(settings).sort().map((k) => [k, settings[k]]))
      return n
    },
  },
  {
    id: 'mode:handover-marker',
    ws: 'mode',
    scenarios: [...ALL, ...MESH],
    path: 'state: user-data/studio-handover.json',
    what: 'The switch to local mode records that the daemon holds the moved credentials (handover.ts), so the switch back moves them to Studio; embedded Studio that never switched has no marker.',
    apply(d) {
      const marker = d.state.userDataJson['studio-handover.json'] as Record<string, unknown> | undefined
      if (!marker || marker.holder !== 'daemon' || marker.v !== 2) return 0
      delete d.state.userDataJson['studio-handover.json']
      d.state.tree = d.state.tree.filter((l) => l !== 'f user-data/studio-handover.json')
      return 1
    },
  },
  {
    id: 'mode:redacted-provider-keys',
    ws: 'mode',
    scenarios: ['provider-round-trip', 'agent-provider-key'],
    path: 'steps: providers[].apiKey in SETTINGS_GET results and in the SETTINGS_SET args that write them back; the PROVIDER_CREDENTIAL_SET value of "Copy app key"',
    what: 'The daemon answers app provider keys as __redacted__ (§4.2) and the renderer writes back what it read; the daemon keeps the stored key and copies the app key itself, so the persisted keys are the same.',
    apply(d, e) {
      const REDACTED = '__redacted__'
      let n = 0
      // `__redacted__` where embedded has a real key: `apiKey` of an entry of a
      // `providers` list at the same index (the settings object's), nothing else.
      const swapProviders = (dv: unknown, ev: unknown): void => {
        const mine = (dv as { providers?: unknown } | null)?.providers
        const theirs = (ev as { providers?: unknown } | null)?.providers
        if (!Array.isArray(mine) || !Array.isArray(theirs)) return
        mine.forEach((entry, i) => {
          const base = theirs[i] as { id?: unknown; apiKey?: unknown } | undefined
          const p = entry as { id?: unknown; apiKey?: unknown } | null
          if (!p || p.apiKey !== REDACTED || !base || base.id !== p.id) return
          if (typeof base.apiKey !== 'string' || base.apiKey === '' || base.apiKey === REDACTED) return
          p.apiKey = base.apiKey
          n++
        })
      }
      d.steps.forEach((step, i) => {
        const base = e.steps[i]
        if (step.kind !== 'invoke' || base?.kind !== 'invoke' || step.channel !== base.channel) return
        if (step.channel === IPC.SETTINGS_GET) swapProviders(step.result, base.result)
        if (step.channel === IPC.SETTINGS_SET) swapProviders(step.args[0], base.args[0])
        if (step.channel === IPC.PROVIDER_CREDENTIAL_SET) {
          const a = step.args[0] as { value?: unknown } | undefined
          const b = base.args[0] as { value?: unknown } | undefined
          if (a?.value === REDACTED && typeof b?.value === 'string' && b.value !== REDACTED) {
            step.args = [{ ...a, value: b.value }, ...step.args.slice(1)]
            n++
          }
        }
      })
      return n
    },
  },
  {
    id: 'w0c:daemon-lease-agent-id',
    ws: 'W0-C',
    scenarios: ['chat-tool-call', ...W3B_RUNNING, 'fleet-map'],
    path: 'state.leases: the agent lease\'s agentId',
    what: 'Bug: the daemon\'s agent lease records agentId null.',
    apply(d, e) {
      let n = 0
      for (const [file, rec] of Object.entries(d.state.leases)) {
        const base = e.state.leases[file] as Record<string, unknown> | undefined
        const r = rec as Record<string, unknown>
        if (!base || !('holder' in r) || r.agentId !== null || base.agentId === null) continue
        r.agentId = base.agentId
        n++
      }
      return n
    },
  },
  {
    id: 'mode:daemon-build-version',
    ws: 'mode',
    // The daemon writes its host record at boot, so every scenario has one.
    scenarios: [...ALL, ...MESH],
    path: 'state.leases: `version` of the daemon\'s host record and lease holder',
    what: 'The daemon records its bundle\'s build version (package.json); the harness\'s Studio runs with the fake app version 0.0.0-parity. One build in a real install.',
    apply(d) {
      let n = 0
      for (const rec of Object.values(d.state.leases)) {
        const r = rec as Record<string, unknown>
        const holder = (r.holder ?? r) as Record<string, unknown>
        if (holder.kind === 'daemon' && holder.version === BUILD_VERSION) { holder.version = '0.0.0-parity'; n++ }
      }
      return n
    },
  },
  {
    id: 'mode:lease-roles',
    ws: 'mode',
    scenarios: [...ALL, ...MESH],
    path: 'state.leases and their tree lines: runtime host and Studio records',
    what: 'In daemon mode the daemon is the runtime host (hosts/<pid:daemon>.json, lease holder kind daemon, with its controlUrl, §10.2) and Studio a client (clients/<pid>.json, §10.3); mapped to the embedded roles.',
    apply(d, e, _raw, backend) {
      // Checked before anything is rewritten: Studio's client record is the
      // embedded host record in client form, and every daemon record names
      // the daemon's own port.
      const client = d.state.leases['clients/<pid:this-process>.json'] as Record<string, unknown> | undefined
      const host = e.state.leases['hosts/<pid:this-process>.json'] as Record<string, unknown> | undefined
      if (!client || !host) return 0
      const { containers: _c, ...hostFields } = host
      const wantClient = { ...hostFields, kind: 'studio-client', mode: backend === 'remote' ? 'remote' : 'local', endpoint: '<lease-endpoint:studio-client>', runtimeId: '<lease-runtime-id:studio-client>', controlUrl: client.controlUrl }
      // The client record names the daemon Studio uses (W4-A; it named the default port 7385 before): in remote mode its URL, the proxy.
      const usedUrl = backend === 'remote' ? 'http://127.0.0.1:<REMOTE_PROXY_PORT>' : 'http://127.0.0.1:<DAEMON_PORT>'
      if (client.controlUrl !== usedUrl || !same(client, wantClient)) return 0
      const daemonRecords = Object.values(d.state.leases).map((rec) => rec as Record<string, unknown>)
        .flatMap((r) => [r, ...(r.holder && typeof r.holder === 'object' ? [r.holder as Record<string, unknown>] : [])])
        .filter((r) => r.kind === 'daemon')
      if (daemonRecords.length === 0 || daemonRecords.some((r) => r.controlUrl !== 'http://127.0.0.1:<DAEMON_PORT>')) return 0
      let n = 0
      const role = (r: Record<string, unknown>) => {
        if (r.kind !== 'daemon') return
        r.kind = 'studio-embedded'
        if ('mode' in r) r.mode = 'embedded'
        r.pid = '<pid:this-process>'
        r.endpoint = '<lease-endpoint:studio-embedded>'
        r.runtimeId = '<lease-runtime-id:studio-embedded>'
        delete r.controlUrl
        n++
      }
      const leases: Record<string, unknown> = {}
      for (const [file, rec] of Object.entries(d.state.leases)) {
        if (file === 'clients/<pid:this-process>.json') { n++; continue }
        const r = clone(rec) as Record<string, unknown>
        if (file === 'hosts/<pid:daemon>.json') { role(r); leases['hosts/<pid:this-process>.json'] = r; continue }
        if (r.holder && typeof r.holder === 'object') role(r.holder as Record<string, unknown>)
        leases[file] = r
      }
      d.state.leases = Object.fromEntries(Object.keys(leases).sort((a, b) => (a < b ? -1 : 1)).map((k) => [k, leases[k]]))
      d.state.tree = d.state.tree
        .filter((l) => l !== 'd leases/clients/' && l !== 'f leases/clients/<pid:this-process>.json')
        .map((l) => l.replace('leases/hosts/<pid:daemon>.json', 'leases/hosts/<pid:this-process>.json'))
      return n
    },
  },
  {
    id: 'mode:daemon-files',
    ws: 'mode',
    scenarios: [...ALL, ...MESH],
    path: 'state.tree: files of the daemon process',
    what: 'Named: user-data/runtime-enc-key(.pub) (the daemon\'s enc key), user-data/daemon-local-proof-<port>, its scratch root under temp/ (scratch-root:daemon); user-data/templates/ is created on first use, not at boot.',
    apply(d, e) {
      let n = 0
      const extra = new Set(['f user-data/runtime-enc-key', 'f user-data/runtime-enc-key.pub', 'f user-data/<daemon-local-proof-file>'])
      d.state.tree = d.state.tree.filter((l) => { if (extra.has(l)) { n++; return false } return true })
        .map((l) => { if (l.includes('<scratch-root:daemon>')) { n++; return l.replace('<scratch-root:daemon>', '<scratch-root:this-process>') } return l })
      if (e.state.tree.includes('d user-data/templates/') && !d.state.tree.includes('d user-data/templates/')) { d.state.tree.push('d user-data/templates/'); n++ }
      d.state.tree.sort((a, b) => (a.slice(2) < b.slice(2) ? -1 : a.slice(2) > b.slice(2) ? 1 : 0))
      return n
    },
  },
  {
    id: 'mode:effective-runtime-host',
    ws: 'mode',
    scenarios: [...RUNNING, ...MESH, ...W3A_RAN, ...W3F_RAN],
    path: 'state: adf_meta adf_effective_runtime `host` field only',
    what: 'The agent file records which host profile ran it: `daemon`, not `studioForeground`.',
    apply(d) {
      let n = 0
      for (const { rows } of table(d, 'adf_meta')) {
        for (const r of rows) {
          if (r.key !== 'adf_effective_runtime' || typeof r.value !== 'string') continue
          const next = r.value.replace('"host":"daemon"', '"host":"studioForeground"')
          if (next !== r.value) { r.value = next; n++ }
        }
      }
      return n
    },
  },
  {
    id: 'mode:json-undefined-keys',
    ws: 'mode',
    scenarios: MESH,
    path: 'steps: keys whose value is `undefined` in MESH_STATUS, MESH_FLEET_STATUS and MESH_MAP_POLL results',
    what: 'The daemon answers in JSON, which has no `undefined`: a row key embedded sets to undefined (`nextWakeAt`, `contextTokens`, …) is absent. Reading it gives undefined either way; only a key count (rowsEqual) sees it, and every poll of one mode has the same keys.',
    apply(d, e) {
      let n = 0
      for (const [dv, ev] of fleetResults(d, e)) {
        n += walkPair(dv, ev, (dr, er) => {
          let k = 0
          for (const key of Object.keys(er)) {
            if (er[key] === undefined && !(key in dr)) { dr[key] = undefined; k++ }
          }
          return k
        })
      }
      return n
    },
  },
  {
    id: 'mode:emergency-stop-teardown-pushes',
    ws: 'mode',
    scenarios: ['emergency-stop'],
    path: 'EMERGENCY_STOP: the BACKGROUND_AGENT_EVENT_BATCH pushes after embedded\'s and their timeline lines in the step',
    what: 'The daemon reports the background agent\'s stop as host events (agent_stopping, agent_stopped); embedded tears down without them. The renderer resets its stores after the call in both modes.',
    apply(d, e) {
      const batch = IPC.BACKGROUND_AGENT_EVENT_BATCH
      const step = e.steps.findIndex((s) => s.kind === 'invoke' && s.channel === IPC.EMERGENCY_STOP)
      if (step < 0) return 0
      const dBatches = d.pushes[batch] ?? []
      const eBatches = e.pushes[batch] ?? []
      if (dBatches.length <= eBatches.length || !same(dBatches.slice(0, eBatches.length), eBatches)) return 0
      const extra = dBatches.slice(eBatches.length).flatMap((b) => (Array.isArray(b) ? b : [b])) as Array<{ type?: string; payload?: { state?: string } }>
      const teardown = new Set(['agent_stopping', 'agent_stopped', 'agent_state_changed'])
      if (!extra.every((ev) => teardown.has(ev.type ?? '') && (ev.type !== 'agent_state_changed' || ev.payload?.state === 'off')) || !extra.some((ev) => ev.type === 'agent_stopped')) return 0
      const line = /^ {2}\[app\] adf:background-agent:event-batch (agent_stopping|agent_stopped|agent_state_changed:off)$/
      let n = 0
      for (const lines of Object.values(d.timelines)) {
        const db = stepBlock(lines, step + 1)
        if (!db) return 0
        const block = lines.slice(db.from, db.to)
        const kept = block.filter((l) => !line.test(l))
        if (block.length - kept.length !== extra.length) return 0
        lines.splice(db.from, db.to - db.from, ...kept)
        n += extra.length
      }
      d.pushes[batch] = clone(eBatches)
      return n
    },
  },
  {
    id: 'mode:invoke-args-stamped',
    ws: 'mode',
    scenarios: W3F_RAN,
    path: 'DOC_SET_AGENT_CONFIG step args: `metadata.updated_at`',
    what: 'The embedded handler stamps `metadata.updated_at` on the config it was given (AdfDatabase.setConfig), and the harness records invoke args by reference after the handler ran; Electron clones IPC args, so the renderer never sees the stamp. The daemon side sends the args as JSON and records them unchanged.',
    apply(d, e) {
      let n = 0
      d.steps.forEach((step, i) => {
        const base = e.steps[i]
        if (step.kind !== 'invoke' || base?.kind !== 'invoke' || step.channel !== IPC.DOC_SET_AGENT_CONFIG || base.channel !== step.channel) return
        const mine = (step.args?.[0] as { metadata?: Record<string, unknown> } | undefined)?.metadata
        const theirs = (base.args?.[0] as { metadata?: Record<string, unknown> } | undefined)?.metadata
        if (!mine || !theirs || mine.updated_at === theirs.updated_at) return
        mine.updated_at = theirs.updated_at
        n++
      })
      return n
    },
  },
  {
    id: 'mode:mesh-foreground-handover',
    ws: 'mode',
    scenarios: MESH,
    path: 'MESH_EVENT: agent_left + agent_joined of the agent a FILE_OPEN moves to the background, agent_left at shutdown; their timeline lines and the step push watermarks they shift',
    what: 'Embedded unregisters the open agent from the mesh when another file opens and registers it again as a background agent (agent_left, agent_joined), and unregisters every agent on quit. In the daemon an agent has one registration whatever window shows it, and quitting Studio does not stop it (§8.3).',
    apply(d, e) {
      const ch = IPC.MESH_EVENT
      const list = e.pushes[ch] ?? []
      const timeline = Object.values(e.timelines)[0]
      if (list.length === 0 || !timeline) return 0
      // Steps whose mesh events are Studio's own: a FILE_OPEN that switches files, and the shutdown.
      const opens = e.steps.flatMap((st, i) => (st.kind === 'invoke' && st.channel === IPC.FILE_OPEN ? [i] : []))
      const windows = [
        ...opens.slice(1).map((i) => ({ step: i + 1, types: ['agent_left', 'agent_joined'] })),
        ...e.steps.flatMap((st, i) => (st.kind === 'shutdown' ? [{ step: i + 1, types: ['agent_left'] }] : [])),
      ]
      // Mesh events are app pushes, in every timeline in send order: the k-th mesh line is list[k].
      const meshLine = /^ {2}(?:\[app\] )?adf:mesh:event ([a-z_]+)/
      const typeOf = (p: unknown) => (p as { type?: string })?.type ?? ''
      const dropped = new Set<number>()
      let k = -1
      timeline.forEach((l, at) => {
        const m = meshLine.exec(l)
        if (!m) return
        k++
        const inWindow = windows.some((w) => {
          const block = stepBlock(timeline, w.step)
          return !!block && at >= block.from && at < block.to && w.types.includes(m[1])
        })
        if (inWindow && typeOf(list[k]) === m[1]) dropped.add(k)
      })
      if (k + 1 !== list.length) return 0
      if (dropped.size === 0) return 0
      if (!same(list.filter((_p, i) => !dropped.has(i)), d.pushes[ch] ?? [])) return 0
      // The same lines out of each embedded timeline's step blocks must give the daemon's.
      const line = /^ {2}(?:\[app\] )?adf:mesh:event (agent_left|agent_joined)\b/
      for (const [agent, lines] of Object.entries(e.timelines)) {
        const filtered = [...lines]
        for (const w of windows) {
          const block = stepBlock(filtered, w.step)
          if (!block) return 0
          const kept = filtered.slice(block.from, block.to).filter((l) => { const m = line.exec(l); return !m || !w.types.includes(m[1]) })
          filtered.splice(block.from, block.to - block.from, ...kept)
        }
        if (!same(filtered, d.timelines[agent])) return 0
      }
      if (d.steps.length !== e.steps.length || d.steps.some((st, i) => !same(withoutPushes(st), withoutPushes(e.steps[i])))) return 0
      d.pushes[ch] = clone(list)
      if (d.pushSeq && e.pushSeq) d.pushSeq[ch] = clone(e.pushSeq[ch])
      d.timelines = clone(e.timelines)
      d.steps = d.steps.map((st, i) => ({ ...st, pushes: clone(e.steps[i].pushes) }) as StepRecord)
      return dropped.size
    },
  },

  // --- remote mode only (W4-B, design §9.4): by-design differences --------------

  {
    id: 'remote:no-stored-values',
    ws: 'mode',
    backends: ['remote'],
    scenarios: ['agent-claim', 'agent-keystore', 'legacy-password-unlock', 'agent-provider-key', 'locked-credentials', 'w3c-adapter-telegram', 'w3c-mcp-attach-credentials'],
    path: 'results of IDENTITY_REVEAL, IDENTITY_GET, PROVIDER_CREDENTIAL_GET, MCP_CREDENTIAL_GET, ADAPTER_CREDENTIAL_GET',
    what: 'A remote daemon never sends stored values: reveal answers { value: null, reason }, IDENTITY_GET and the MCP credential form the __redacted__ placeholder, the provider form { credentials: {}, error }, the channel form no values (storedKeys only). Each daemon result must have exactly that shape.',
    apply(d, e) {
      let n = 0
      d.steps.forEach((step, i) => {
        const base = e.steps[i]
        if (step.kind !== 'invoke' || base?.kind !== 'invoke' || step.channel !== base.channel) return
        const r = step.result as Record<string, unknown> | string | null | undefined
        const b = base.result as Record<string, unknown> | string | null | undefined
        const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
        let redacted = false
        switch (step.channel) {
          case IPC.IDENTITY_REVEAL:
            redacted = same(r, { value: null, reason: REMOTE_VALUES_UNSUPPORTED }) && obj(b) && typeof b.value === 'string'
            break
          case IPC.IDENTITY_GET:
            redacted = r === '__redacted__' && typeof b === 'string'
            break
          case IPC.PROVIDER_CREDENTIAL_GET:
            redacted = same(r, { credentials: {}, error: REMOTE_VALUES_UNSUPPORTED }) && obj(b)
            break
          case IPC.MCP_CREDENTIAL_GET: {
            const rc = obj(r) && obj(r.credentials) ? r.credentials : null
            const bc = obj(b) && obj(b.credentials) ? b.credentials : null
            redacted = !!rc && !!bc && Object.keys(rc).length > 0 && same(Object.keys(rc).sort(), Object.keys(bc).sort()) && Object.values(rc).every((v) => v === '__redacted__')
            break
          }
          case IPC.ADAPTER_CREDENTIAL_GET:
            redacted = obj(r) && obj(b) && same(r.credentials, {}) && same(r.storedKeys, b.storedKeys) && obj(b.credentials) && Object.keys(b.credentials).length > 0
            break
        }
        if (!redacted) return
        step.result = clone(base.result)
        n++
      })
      return n
    },
  },

  {
    id: 'remote:credentials-locked-on-daemon-machine',
    ws: 'mode',
    backends: ['remote'],
    scenarios: ['locked-credentials'],
    path: 'local calls: the locked-credential question (dialog.showMessageBox message)',
    what: 'The Replace or Cancel question names where the credentials are locked: "on the daemon\'s machine" in remote mode, "on this machine" in embedded and local mode.',
    apply(d, e) {
      if (d.local.length !== e.local.length) return 0
      let n = 0
      d.local.forEach((call, i) => {
        const base = e.local[i]
        if (call.api !== 'dialog.showMessageBox' || base.api !== 'dialog.showMessageBox') return
        const msg = (call.args[0] as { message?: unknown })?.message
        const baseMsg = (base.args[0] as { message?: unknown })?.message
        if (typeof msg !== 'string' || typeof baseMsg !== 'string') return
        if (msg.replace("on the daemon's machine.", 'on this machine.') !== baseMsg || msg === baseMsg) return
        ;(call.args[0] as { message: string }).message = baseMsg
        n++
      })
      return n
    },
  },

  {
    id: 'remote:owner-identity-on-server',
    ws: 'mode',
    backends: ['remote'],
    scenarios: ['owner-identity', 'owner-import'],
    path: 'results of IDENTITY_OWNER_STATUS, _REVEAL_MNEMONIC, _CONFIRM_BACKUP, _IMPORT; adf-settings.json ownerSeedBackupConfirmed',
    what: 'Owner identity actions happen on the server in remote mode: the status has no mnemonic to show (hasMnemonic false), reveal answers { mnemonic: null, reason }, confirm-backup and import answer the run-on-the-server sentence without a request, so the backup stays unconfirmed.',
    apply(d, e) {
      if (d.steps.length !== e.steps.length) return 0
      let n = 0
      const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
      // The backup stays unconfirmed only because of a refused step that confirmed it in embedded
      // (confirm-backup, or a restore that succeeded): before one, backupConfirmed must match.
      let unconfirmedByRefusal = false
      d.steps.forEach((step, i) => {
        const base = e.steps[i]
        if (step.kind !== 'invoke' || base?.kind !== 'invoke' || step.channel !== base.channel) return
        const r = step.result
        let ok = false
        switch (step.channel) {
          case IPC.IDENTITY_OWNER_STATUS: {
            if (!obj(r) || !obj(base.result) || r.hasMnemonic !== false || base.result.hasMnemonic !== true) break
            const backupDiffers = r.backupConfirmed !== base.result.backupConfirmed
            if (backupDiffers && !(unconfirmedByRefusal && r.backupConfirmed === false && base.result.backupConfirmed === true)) break
            ok = same({ ...r, hasMnemonic: true, backupConfirmed: base.result.backupConfirmed }, base.result)
            break
          }
          case IPC.IDENTITY_OWNER_REVEAL_MNEMONIC:
            ok = same(r, { mnemonic: null, reason: REMOTE_OWNER_BACKUP_SENTENCE })
            break
          case IPC.IDENTITY_OWNER_CONFIRM_BACKUP:
          case IPC.IDENTITY_OWNER_IMPORT:
            ok = same(r, { success: false, error: REMOTE_OWNER_IDENTITY_SENTENCE })
            if (ok && obj(base.result) && base.result.success === true) unconfirmedByRefusal = true
            break
        }
        if (!ok) return
        step.result = clone(base.result)
        n++
      })
      const settings = d.state.userDataJson['adf-settings.json'] as Record<string, unknown> | undefined
      const baseSettings = e.state.userDataJson['adf-settings.json'] as Record<string, unknown> | undefined
      if (unconfirmedByRefusal && settings && baseSettings && settings.ownerSeedBackupConfirmed === false && baseSettings.ownerSeedBackupConfirmed === true) {
        settings.ownerSeedBackupConfirmed = true
        n++
      }
      return n
    },
  },
  {
    id: 'remote:asks-before-sign-in-page',
    ws: 'mode',
    backends: ['remote'],
    scenarios: ['w3c-mcp-oauth-connect'],
    path: 'local calls: the question before shell.openExternal of an OAuth page',
    what: 'In remote mode no sign-in page opens without a click: a native question naming the daemon\'s host and the page\'s host comes right before the page opens (oauth-relay.ts). Embedded and local mode open it directly.',
    apply(d) {
      let n = 0
      d.local = d.local.filter((call, i) => {
        const message = (call.args[0] as { message?: unknown } | undefined)?.message
        const question = call.api === 'dialog.showMessageBox' && typeof message === 'string' && /^Open a sign-in page on \S+\?$/.test(message)
        if (question && d.local[i + 1]?.api === 'shell.openExternal') { n++; return false }
        return true
      })
      return n
    },
  },
  {
    id: 'remote:no-os-recent-documents',
    ws: 'mode',
    backends: ['remote'],
    scenarios: ['agent-claim', 'agent-keystore', 'chat-tool-call', 'config-during-start', 'delete', 'doc-resources', 'emergency-stop', 'fleet-map', 'legacy-password-unlock', 'open-agent', 'password-unlock', 'rename-while-running', 'review-accept-foreign', 'start-agent', 'switch-with-background', 'w3f-write-conflicts'],
    path: 'local calls: app.addRecentDocument',
    what: 'In remote mode an opened file is a path on the daemon\'s machine: it goes into Open Recent (client settings) but not into the OS recent documents, where the Windows shell may contact a UNC host (W4-B review).',
    apply(d, e) {
      const recents = e.local.filter((c) => c.api === 'app.addRecentDocument').length
      if (recents === 0 || d.local.some((c) => c.api === 'app.addRecentDocument')) return 0
      if (!same(d.local, e.local.filter((c) => c.api !== 'app.addRecentDocument'))) return 0
      d.local = clone(e.local)
      return recents
    },
  },
]

/** Apply every entry for `scenario`; the ids of entries that matched nothing are returned. */
export function applyGapAllowlist(scenario: string, daemon: ComparableRecording, embedded: ComparableRecording, raw?: { daemon: RawRecording }, backend: ParityBackendKind = 'daemon'): { unmatched: string[]; counts: Record<string, number> } {
  const unmatched: string[] = []
  const counts: Record<string, number> = {}
  for (const entry of GAP_ALLOWLIST) {
    if (!entry.scenarios.includes(scenario)) continue
    if (!(entry.backends ?? ['daemon', 'remote']).includes(backend)) continue
    const n = entry.apply(daemon, embedded, raw, backend)
    counts[entry.id] = n
    if (n === 0) unmatched.push(entry.id)
  }
  return { unmatched, counts }
}

/** The gaps-doc table, generated from the list. */
export function renderGapTable(): string {
  const lines = ['| Entry | Workstream | Scenarios | Where | Difference |', '|---|---|---|---|---|']
  for (const e of GAP_ALLOWLIST) {
    lines.push(`| \`${e.id}\` | ${e.ws === 'mode' ? 'by design' : e.ws}${e.backends && e.backends.length === 1 ? ` (${e.backends[0]} only)` : ''} | ${e.scenarios.join(', ')} | ${e.path.replace(/\|/g, '\\|')} | ${e.what.replace(/\|/g, '\\|')} |`)
  }
  return lines.join('\n')
}
