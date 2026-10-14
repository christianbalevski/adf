import { IPC } from '../../../src/shared/constants/ipc-channels'
import { CLIENT_SETTINGS_KEYS } from '../../../src/shared/constants/client-settings-keys'
import { clientSettingsDefaults } from '../../../src/main/backend/daemon-mode/settings'
import { EMULATE_W4A } from './daemon-backend'
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

export type GapTag = 'W1-A' | 'W2-A' | 'W2-C2' | 'W0-C' | 'W0-D' | 'W3-A' | 'W4-A' | 'E3' | 'W5-A' | 'mode'

export interface GapEntry {
  id: string
  ws: GapTag
  scenarios: readonly string[]
  /** The one place the transform acts on. */
  path: string
  /** The difference, in one sentence. */
  what: string
  /** `raw.daemon`: the daemon run before normalization, for entries that must check a value the normalizer replaced. */
  apply(daemon: ComparableRecording, embedded: ComparableRecording, raw?: { daemon: RawRecording }): number
}

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
const ALL = [...CORE, ...W3B_NO_AGENT, ...W3B_RUNNING, ...W3C, ...HELD_ONLY, ...W3A_RAN, ...W3A_NO_AGENT] as const
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
function withoutPushes(step: StepRecord): unknown {
  const { pushes: _p, ...rest } = step as StepRecord & { pushes: unknown }
  return rest
}

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
    id: 'w4a:local-mode-switch',
    ws: 'W4-A',
    scenarios: [...ALL, ...MESH],
    path: 'harness: emulateLocalModeSwitch() (daemon-backend.ts)',
    what: 'The harness does what the switch to local mode will do: client keys moved to studio-client-settings.json, owner phrase and studio-runtime entry in the (test) keychain.',
    apply(d) {
      if (!EMULATE_W4A) return 0
      // Proof the emulation ran: the client file holds client keys only.
      const client = d.state.userDataJson['studio-client-settings.json'] as Record<string, unknown> | undefined
      const keys = new Set<string>(CLIENT_SETTINGS_KEYS)
      return client && Object.keys(client).length > 0 && Object.keys(client).every((k) => keys.has(k)) ? 1 : 0
    },
  },
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
    id: 'w4a:daemon-writes-client-defaults',
    ws: 'W4-A',
    scenarios: [...ALL, ...MESH],
    path: 'state: client keys at their shipped default in the daemon\'s adf-settings.json',
    what: 'The daemon\'s settings store writes the defaults of Studio client keys (menuBarEnabled, updateChecksEnabled, …) into adf-settings.json after the switch moved them out.',
    apply(d) {
      const settings = d.state.userDataJson['adf-settings.json'] as Record<string, unknown> | undefined
      const client = d.state.userDataJson['studio-client-settings.json'] as Record<string, unknown> | undefined
      if (!settings || !client) return 0
      const defaults = clientSettingsDefaults() as Record<string, unknown>
      let n = 0
      for (const key of CLIENT_SETTINGS_KEYS) {
        if (!(key in settings) || !(key in client) || same(settings[key], client[key])) continue
        if (!same(settings[key], defaults[key])) continue
        delete settings[key]
        n++
      }
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
    id: 'w4a:client-record-control-url',
    ws: 'W4-A',
    scenarios: [...ALL, ...MESH],
    path: 'state.leases: clients/<pid:this-process>.json controlUrl',
    what: 'Bug: Studio\'s client record names the default daemon port 7385 whatever port the daemon uses (registerClient takes no URL).',
    apply(d) {
      const rec = d.state.leases['clients/<pid:this-process>.json'] as Record<string, unknown> | undefined
      return rec && rec.controlUrl === 'http://127.0.0.1:7385' ? 1 : 0
    },
  },
  {
    id: 'w0c:daemon-host-record-lazy',
    ws: 'W0-C',
    scenarios: ['open-agent', ...W3B_NO_AGENT, ...W3C, ...HELD_ONLY, ...W3A_NO_AGENT],
    path: 'state.leases: the daemon\'s hosts/<pid>.json while it holds no lease',
    what: 'Bug: the daemon writes its runtime host record only once it holds an agent lease; §10.3 has every runtime host register (embedded Studio does at boot).',
    apply(d, e) {
      const embeddedHost = e.state.leases['hosts/<pid:this-process>.json']
      if (!embeddedHost || leaseFiles(d).some((f) => f.startsWith('hosts/'))) return 0
      d.state.leases['hosts/<pid:daemon>.json'] = { ...(clone(embeddedHost) as Record<string, unknown>), kind: 'daemon', mode: 'daemon', pid: '<pid:daemon>', endpoint: '<lease-endpoint:daemon>', runtimeId: '<lease-runtime-id:daemon>', controlUrl: 'http://127.0.0.1:<DAEMON_PORT>' }
      d.state.tree.push('d leases/hosts/', 'f leases/hosts/<pid:daemon>.json')
      return 1
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
    id: 'w0d:daemon-version-null',
    ws: 'W0-D',
    scenarios: [...RUNNING, ...MESH, ...W3A_RAN],
    path: 'state.leases: `version` of the daemon\'s host record and lease holder',
    what: 'Bug: the daemon records version null in its host record and agent leases.',
    apply(d) {
      let n = 0
      for (const rec of Object.values(d.state.leases)) {
        const r = rec as Record<string, unknown>
        const holder = (r.holder ?? r) as Record<string, unknown>
        if (holder.kind === 'daemon' && holder.version === null) { holder.version = '0.0.0-parity'; n++ }
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
    apply(d, e) {
      // Checked before anything is rewritten: Studio's client record is the
      // embedded host record in client form, and every daemon record names
      // the daemon's own port.
      const client = d.state.leases['clients/<pid:this-process>.json'] as Record<string, unknown> | undefined
      const host = e.state.leases['hosts/<pid:this-process>.json'] as Record<string, unknown> | undefined
      if (!client || !host) return 0
      const { containers: _c, ...hostFields } = host
      const wantClient = { ...hostFields, kind: 'studio-client', mode: 'local', endpoint: '<lease-endpoint:studio-client>', runtimeId: '<lease-runtime-id:studio-client>', controlUrl: client.controlUrl }
      if (typeof client.controlUrl !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(client.controlUrl) || !same(client, wantClient)) return 0
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
    scenarios: [...RUNNING, ...MESH, ...W3A_RAN],
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
    id: 'e3:emergency-stop-startup-dispatch-error',
    ws: 'E3',
    scenarios: ['emergency-stop'],
    path: 'EMERGENCY_STOP: the embedded AGENT_EVENT error push and its timeline line',
    what: 'Embedded bug (tracker §6, E3 candidate): during the teardown the open agent\'s startup dispatch reports "Cannot dispatch startup while agent lifecycle is disposed" on AGENT_EVENT. Daemon mode sends no such error.',
    apply(d, e) {
      const step = e.steps.findIndex((s) => s.kind === 'invoke' && s.channel === IPC.EMERGENCY_STOP)
      if (step < 0) return 0
      const errors = (e.pushes[IPC.AGENT_EVENT] ?? []) as Array<{ type?: string; payload?: { error?: string } }>
      if ((d.pushes[IPC.AGENT_EVENT] ?? []).length !== 0 || errors.length !== 1 || errors[0].type !== 'error' || !/lifecycle is disposed/.test(errors[0].payload?.error ?? '')) return 0
      let n = 0
      for (const [agent, lines] of Object.entries(d.timelines)) {
        const eb = stepBlock(e.timelines[agent] ?? [], step + 1)
        const db = stepBlock(lines, step + 1)
        if (!eb || !db) return 0
        const errorLines = e.timelines[agent].slice(eb.from, eb.to).filter((l) => /^ {2}adf:agent:event error$/.test(l))
        if (errorLines.length === 0) continue
        lines.splice(db.to, 0, ...errorLines)
        n += errorLines.length
      }
      if (n !== 1) return 0
      d.pushes[IPC.AGENT_EVENT] = clone(e.pushes[IPC.AGENT_EVENT])
      // Channels in name order, as the recording keeps them.
      d.pushes = Object.fromEntries(Object.keys(d.pushes).sort().map((c) => [c, d.pushes[c]]))
      if (d.pushSeq) d.pushSeq[IPC.AGENT_EVENT] = clone(e.pushSeq?.[IPC.AGENT_EVENT] ?? [])
      return n
    },
  },
  {
    id: 'e3:stop-startup-dispatch-error',
    ws: 'E3',
    scenarios: ['password-unlock', 'config-during-start', 'rename-while-running'],
    path: 'AGENT_STOP: the embedded AGENT_EVENT error push, its timeline line and the step push watermarks it shifts',
    what: 'Embedded bug (tracker §6, E3 candidate, as e3:emergency-stop-startup-dispatch-error): stopping an agent started idle sends "Cannot dispatch startup while agent lifecycle is disposed" on AGENT_EVENT, which the chat shows as an error. Daemon mode sends no such error.',
    apply(d, e) {
      const step = e.steps.findIndex((st) => st.kind === 'invoke' && st.channel === IPC.AGENT_STOP)
      if (step < 0) return 0
      const errors = (e.pushes[IPC.AGENT_EVENT] ?? []) as Array<{ type?: string; payload?: { error?: string } }>
      if ((d.pushes[IPC.AGENT_EVENT] ?? []).length !== 0 || errors.length !== 1 || errors[0].type !== 'error' || !/Cannot dispatch startup while agent lifecycle is disposed/.test(errors[0].payload?.error ?? '')) return 0
      let n = 0
      for (const [agent, lines] of Object.entries(d.timelines)) {
        const eb = stepBlock(e.timelines[agent] ?? [], step + 1)
        const db = stepBlock(lines, step + 1)
        if (!eb || !db) continue
        const block = e.timelines[agent].slice(eb.from, eb.to)
        const at = block.findIndex((l) => /^ {2}adf:agent:event error$/.test(l))
        if (at < 0) continue
        lines.splice(db.from + at, 0, block[at])
        n++
      }
      if (n !== 1) return 0
      if (d.steps.length !== e.steps.length || d.steps.some((st, i) => !same(withoutPushes(st), withoutPushes(e.steps[i])))) return 0
      d.pushes[IPC.AGENT_EVENT] = clone(e.pushes[IPC.AGENT_EVENT])
      d.pushes = Object.fromEntries(Object.keys(d.pushes).sort().map((c) => [c, d.pushes[c]]))
      if (d.pushSeq) d.pushSeq[IPC.AGENT_EVENT] = clone(e.pushSeq?.[IPC.AGENT_EVENT] ?? [])
      d.steps = d.steps.map((st, i) => ({ ...st, pushes: clone(e.steps[i].pushes) }) as StepRecord)
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

]

/** Apply every entry for `scenario`; the ids of entries that matched nothing are returned. */
export function applyGapAllowlist(scenario: string, daemon: ComparableRecording, embedded: ComparableRecording, raw?: { daemon: RawRecording }): { unmatched: string[]; counts: Record<string, number> } {
  const unmatched: string[] = []
  const counts: Record<string, number> = {}
  for (const entry of GAP_ALLOWLIST) {
    if (!entry.scenarios.includes(scenario)) continue
    const n = entry.apply(daemon, embedded, raw)
    counts[entry.id] = n
    if (n === 0) unmatched.push(entry.id)
  }
  return { unmatched, counts }
}

/** The gaps-doc table, generated from the list. */
export function renderGapTable(): string {
  const lines = ['| Entry | Workstream | Scenarios | Where | Difference |', '|---|---|---|---|---|']
  for (const e of GAP_ALLOWLIST) {
    lines.push(`| \`${e.id}\` | ${e.ws === 'mode' ? 'by design' : e.ws} | ${e.scenarios.join(', ')} | ${e.path.replace(/\|/g, '\\|')} | ${e.what.replace(/\|/g, '\\|')} |`)
  }
  return lines.join('\n')
}
