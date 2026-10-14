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

export type GapTag = 'W1-A' | 'W2-A' | 'W2-C2' | 'W0-C' | 'W0-D' | 'W3-A' | 'W4-A' | 'E3' | 'mode'

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
const ALL = [...CORE, ...W3B_NO_AGENT, ...W3B_RUNNING] as const
const RUNNING = ['start-agent', 'chat-tool-call', ...W3B_RUNNING] as const
/** Scenarios whose agent file nobody holds open when the state is dumped (chat-tool-call's still runs). */
const NOT_RUNNING_AT_DUMP = ['open-agent', 'start-agent'] as const
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
function setRows(rec: ComparableRecording, file: string, name: string, rows: Row[]): void {
  rec.state.adf[file].tables[name].rows = rows
}
function withoutPushes(step: StepRecord): unknown {
  const { pushes: _p, ...rest } = step as StepRecord & { pushes: unknown }
  return rest
}
const leaseFiles = (rec: ComparableRecording) => Object.keys(rec.state.leases)

/** AGENT_EVENT types the interim GET /events adapter carries (client-stream.ts). */
const ADAPTER_EVENT_TYPES = new Set(['state_changed', 'turn_complete', 'error'])
const eventLineType = (line: string): string | null => {
  const m = /^ {2}(?:\[app\] )?adf:agent:event ([a-z_]+)/.exec(line)
  return m ? m[1] : null
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
    id: 'w2c2:open-document-reads',
    ws: 'W2-C2',
    scenarios: CORE,
    path: 'steps: every DOC_GET_BATCH and DOC_READ_INTERNAL_FILE before the first AGENT_START (and their `(threw)` timeline markers), no other step',
    what: 'Reading a file that is not running throws "not available in daemon mode yet: W2-B": the daemon serves open documents (W2-A), but Studio holds one only through its client session.',
    apply(d, e) {
      const reads = new Set<string>([IPC.DOC_GET_BATCH, IPC.DOC_READ_INTERNAL_FILE])
      const start = e.steps.findIndex((s) => s.kind === 'invoke' && s.channel === IPC.AGENT_START)
      const before = start < 0 ? e.steps : e.steps.slice(0, start)
      const want = before.filter((s) => s.kind === 'invoke' && reads.has(s.channel)).length
      const hits: number[] = []
      for (const [i, step] of d.steps.entries()) {
        const base = e.steps[i]
        if (step.kind !== 'invoke-error' || base?.kind !== 'invoke' || base.channel !== step.channel) continue
        if (!reads.has(step.channel) || (start >= 0 && i >= start)) return 0
        if ((step.error as { code?: unknown }).code !== 'daemon_mode_unavailable' || !/: W2-B\b/.test(step.error.message)) return 0
        hits.push(i)
      }
      if (hits.length !== want) return 0
      for (const i of hits) {
        d.steps[i] = clone(e.steps[i])
        for (const lines of Object.values(d.timelines)) {
          const at = lines.indexOf(`< ${i + 1} (threw)`)
          if (at >= 0) lines[at] = `< ${i + 1}`
        }
      }
      return hits.length
    },
  },
  {
    id: 'w3a:start-session-id',
    ws: 'W3-A',
    scenarios: [...RUNNING, ...MESH],
    path: 'steps: AGENT_START result `sessionId`; in MESH_STATUS, MESH_FLEET_STATUS and MESH_MAP_POLL results, the `createdAt` of fixture agents',
    what: 'The start route answers no runtime session id. Without its instant, a fixture agent\'s creation instant in a later fleet row is no longer before an earlier step\'s (R9): `<t>` where embedded has `<t:earlier>`. Only when the raw `createdAt` is that file\'s own `adf_created_at`.',
    apply(d, e, raw) {
      let n = 0
      d.steps.forEach((step, i) => {
        const base = e.steps[i]
        if (step.kind !== 'invoke' || base?.kind !== 'invoke' || step.channel !== IPC.AGENT_START) return
        const r = step.result as Record<string, unknown>
        const b = base.result as Record<string, unknown>
        if (!b || b.sessionId === undefined || !r || 'sessionId' in r) return
        if (!same({ ...r, sessionId: b.sessionId }, b)) return
        step.result = clone(b)
        n++
      })
      if (!raw) return n
      // The fixture files' creation stamps, as the daemon run left them on disk.
      const created = new Map<string, string>()
      for (const [file, dump] of Object.entries(raw.daemon.state.adf)) {
        const row = (dump.tables.adf_meta?.rows as Row[] | undefined)?.find((m) => m.key === 'adf_created_at')
        if (row && typeof row.value === 'string') created.set(file, row.value)
      }
      const stampOf = (filePath: string): string | undefined => {
        const p = filePath.replace(/\\/g, '/')
        for (const [file, stamp] of created) if (p.endsWith(`/${file}`)) return stamp
        return undefined
      }
      d.steps.forEach((step, i) => {
        const base = e.steps[i]
        const rawStep = raw.daemon.steps[i] as { kind?: string; channel?: string; result?: unknown } | undefined
        if (step.kind !== 'invoke' || base?.kind !== 'invoke' || !FLEET_ROW_CHANNELS.has(step.channel) || rawStep?.channel !== step.channel) return
        n += walkRaw(step.result, base.result, rawStep.result, (dr, er, rr) => {
          if (dr.createdAt !== '<t>' || er.createdAt !== '<t:earlier>' || typeof rr.filePath !== 'string') return 0
          const stamp = stampOf(rr.filePath)
          if (!stamp || rr.createdAt !== stamp) return 0
          dr.createdAt = '<t:earlier>'
          return 1
        })
      })
      return n
    },
  },
  {
    id: 'w2c2:agent-event-stream',
    ws: 'W2-C2',
    scenarios: ['start-agent', 'chat-tool-call'],
    path: 'AGENT_EVENT: the pushes, their timeline lines and the step push watermarks they shift',
    what: 'The interim GET /events adapter carries only state_changed, turn_complete and error; deltas, tool calls, context, metadata, file updates and loop_seq come with the client stream.',
    apply(d, e) {
      const ch = IPC.AGENT_EVENT
      const full = e.pushes[ch] ?? []
      const kept = full.filter((p) => ADAPTER_EVENT_TYPES.has((p as { type?: string }).type ?? ''))
      if (full.length === kept.length || !same(kept, d.pushes[ch] ?? [])) return 0
      for (const [agent, lines] of Object.entries(e.timelines)) {
        const filtered = lines.filter((l) => { const t = eventLineType(l); return t === null || ADAPTER_EVENT_TYPES.has(t) })
        if (!same(filtered, d.timelines[agent])) return 0
      }
      if (d.steps.length !== e.steps.length || d.steps.some((s, i) => !same(withoutPushes(s), withoutPushes(e.steps[i])))) return 0
      d.pushes[ch] = clone(full)
      d.timelines = clone(e.timelines)
      d.steps = d.steps.map((s, i) => ({ ...s, pushes: clone(e.steps[i].pushes) }) as StepRecord)
      return 1
    },
  },
  {
    id: 'w2c2:streaming-check',
    ws: 'W2-C2',
    scenarios: ['start-agent', 'chat-tool-call'],
    path: 'problems: the streaming check',
    what: 'No text_delta_batch reaches the window (same cause as w2c2:agent-event-stream).',
    apply(d) {
      const before = d.problems?.length ?? 0
      d.problems = (d.problems ?? []).filter((p) => !/^streaming: \d+ text slice\(s\) arrived as 0 text_delta_batch push\(es\)$/.test(p))
      const n = before - d.problems.length
      if (d.problems.length === 0) delete d.problems
      return n
    },
  },
  {
    id: 'w2c2:identity-on-open',
    ws: 'W2-C2',
    scenarios: [...CORE, 'agent-keystore', ...MESH],
    path: 'state: adf_identity and adf_attestations rows',
    what: 'The daemon runs its open steps (ensureWorkspaceIdentity on open, W2-A) only for a document a client session holds: no keys, no owner and operator attestations.',
    apply(d, e) {
      let n = 0
      for (const name of ['adf_identity', 'adf_attestations']) {
        for (const { file, rows } of table(d, name)) {
          const base = e.state.adf[file]?.tables[name]?.rows as Row[] | undefined
          if (rows.length === 0 && base && base.length > 0) { setRows(d, file, name, clone(base)); n++ }
        }
      }
      return n
    },
  },
  {
    id: 'w2c2:identity-meta',
    ws: 'W2-C2',
    scenarios: [...CORE, 'agent-keystore', ...MESH],
    path: 'state: adf_meta rows adf_did, adf_owner_did, adf_runtime_did',
    what: 'Same cause as w2c2:identity-on-open: the identity stamps are written on open.',
    apply(d, e) {
      let n = 0
      for (const { file, rows } of table(d, 'adf_meta')) {
        const base = (e.state.adf[file]?.tables.adf_meta?.rows ?? []) as Row[]
        for (const key of ['adf_did', 'adf_owner_did', 'adf_runtime_did']) {
          const want = base.find((r) => r.key === key)
          if (!want || rows.some((r) => r.key === key)) continue
          rows.push(clone(want))
          n++
        }
        rows.sort((a, b) => String(a.key).localeCompare(String(b.key)))
      }
      return n
    },
  },
  {
    id: 'w2c2:claim-previous-did',
    ws: 'W2-C2',
    scenarios: ['agent-claim'],
    path: 'the claim\'s clone attestation (IDENTITY_ATTESTATIONS_GET result, adf_attestations) and adf_meta adf_did_history',
    what: 'Same cause as w2c2:identity-on-open: the daemon minted no DID on open, so its claim has no previous DID to record (no clone attestation, no DID history).',
    apply(d, e) {
      let n = 0
      const isClone = (a: unknown) => (a as { role?: unknown })?.role === 'clone'
      // The attestations the panel reads after the claim.
      d.steps.forEach((step, i) => {
        const base = e.steps[i]
        if (step.kind !== 'invoke' || base?.kind !== 'invoke' || step.channel !== IPC.IDENTITY_ATTESTATIONS_GET) return
        const mine = (step.result as { attestations?: unknown[] })?.attestations
        const theirs = (base.result as { attestations?: unknown[] })?.attestations
        if (!mine || !theirs || mine.some(isClone)) return
        if (!same(mine, theirs.filter((a) => !isClone(a)))) return
        step.result = clone(base.result)
        n++
      })
      for (const { file, rows } of table(d, 'adf_attestations')) {
        const base = (e.state.adf[file]?.tables.adf_attestations?.rows ?? []) as Row[]
        const withoutIds = (r: Row[]) => r.map(({ id: _id, ...rest }) => rest)
        if (rows.some(isClone) || !base.some(isClone)) continue
        if (!same(withoutIds(rows), withoutIds(base.filter((r) => !isClone(r))))) continue
        setRows(d, file, 'adf_attestations', clone(base))
        n++
      }
      for (const { rows } of table(d, 'adf_meta')) {
        const want = Object.values(e.state.adf).flatMap((dump) => (dump.tables.adf_meta?.rows ?? []) as Row[]).find((r) => r.key === 'adf_did_history')
        if (!want || rows.some((r) => r.key === 'adf_did_history')) continue
        rows.push(clone(want))
        rows.sort((a, b) => String(a.key).localeCompare(String(b.key)))
        n++
      }
      return n
    },
  },
  {
    id: 'mode:restore-keeps-adopted-delegation',
    ws: 'mode',
    scenarios: ['owner-import'],
    path: 'runtimeDelegation: IDENTITY_OWNER_STATUS results after the restore, and adf-settings.json',
    what: 'Restoring the same owner re-signs Studio\'s runtime delegation in embedded mode; the daemon keeps the one it adopted from Studio (§5.3: only Studio writes its runtime identity), which stays valid.',
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
    id: 'w2c2:open-document-handle',
    ws: 'W2-C2',
    scenarios: [...NOT_RUNNING_AT_DUMP, 'emergency-stop'],
    path: 'state: adf_meta row adf_clean_close',
    what: 'Nothing holds the file open (no client session to hold it), so the fixture\'s clean-close marker stays set.',
    apply(d, e) {
      let n = 0
      for (const { file, rows } of table(d, 'adf_meta')) {
        const base = (e.state.adf[file]?.tables.adf_meta?.rows ?? []) as Row[]
        if (base.some((r) => r.key === 'adf_clean_close')) continue
        const at = rows.findIndex((r) => r.key === 'adf_clean_close')
        if (at >= 0) { rows.splice(at, 1); n++ }
      }
      return n
    },
  },
  {
    id: 'w2c2:open-document-wal',
    ws: 'W2-C2',
    scenarios: [...NOT_RUNNING_AT_DUMP, 'emergency-stop'],
    path: 'state.tree: the -wal and -shm files of an open agent file',
    what: 'Same cause as w2c2:open-document-handle: the file is not held open, so no -wal/-shm beside it.',
    apply(d, e) {
      let n = 0
      for (const line of e.state.tree) {
        if (!/\.adf-(wal|shm)$/.test(line) || d.state.tree.includes(line)) continue
        d.state.tree.push(line)
        n++
      }
      if (n) d.state.tree.sort((a, b) => (a.slice(2) < b.slice(2) ? -1 : a.slice(2) > b.slice(2) ? 1 : 0))
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
    scenarios: ['open-agent', ...W3B_NO_AGENT],
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
    scenarios: [...RUNNING, ...MESH],
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
    scenarios: [...RUNNING, ...MESH],
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
    id: 'w2c2:fleet-row-did',
    ws: 'W2-C2',
    scenarios: MESH,
    path: 'steps: `did` of the fleet rows in MESH_STATUS, MESH_FLEET_STATUS and MESH_MAP_POLL results',
    what: 'Same cause as w2c2:identity-on-open: an agent the daemon never held open has no DID, so its rows carry none.',
    apply(d, e) {
      let n = 0
      for (const [dv, ev] of fleetResults(d, e)) {
        n += walkPair(dv, ev, (dr, er) => {
          if (typeof er.filePath !== 'string' || typeof er.did !== 'string' || 'did' in dr) return 0
          dr.did = er.did
          return 1
        })
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
    path: 'EMERGENCY_STOP: its BACKGROUND_AGENT_EVENT_BATCH pushes and their timeline lines',
    what: 'The daemon reports the background agent\'s stop (agent_state_changed off, agent_stopped); embedded tears down without it. The renderer resets its stores after the call in both modes.',
    apply(d, e) {
      const batch = IPC.BACKGROUND_AGENT_EVENT_BATCH
      const step = e.steps.findIndex((s) => s.kind === 'invoke' && s.channel === IPC.EMERGENCY_STOP)
      if (step < 0) return 0
      const dBatches = d.pushes[batch] ?? []
      const eBatches = e.pushes[batch] ?? []
      const teardown = dBatches.at(-1) as Array<{ type?: string }> | undefined
      if (dBatches.length !== eBatches.length + 1 || !same(dBatches.slice(0, -1), eBatches)) return 0
      if (!Array.isArray(teardown) || teardown.map((ev) => ev.type).join() !== 'agent_state_changed,agent_stopped') return 0
      const teardownLines = '  [app] adf:background-agent:event-batch agent_state_changed:off\n  [app] adf:background-agent:event-batch agent_stopped'
      let n = 0
      for (const lines of Object.values(d.timelines)) {
        const db = stepBlock(lines, step + 1)
        if (!db || lines.slice(db.from, db.to).join('\n') !== teardownLines) return 0
        lines.splice(db.from, db.to - db.from)
        n++
      }
      d.pushes[batch] = clone(eBatches)
      if (d.pushSeq) d.pushSeq[batch] = clone(e.pushSeq?.[batch] ?? [])
      return n + 1
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
      if (d.pushSeq) d.pushSeq[IPC.AGENT_EVENT] = clone(e.pushSeq?.[IPC.AGENT_EVENT] ?? [])
      return n
    },
  },
  {
    id: 'w2c2:mesh-event-stream',
    ws: 'W2-C2',
    scenarios: MESH,
    path: 'MESH_EVENT: the pushes, their timeline lines and the step push watermarks they shift',
    what: 'The interim GET /events adapter carries no mesh topic: agent_joined, agent_left and message_routed come with the client stream.',
    apply(d, e) {
      const ch = IPC.MESH_EVENT
      const full = e.pushes[ch] ?? []
      if (full.length === 0 || (d.pushes[ch] ?? []).length !== 0) return 0
      const others = (rec: ComparableRecording) => Object.fromEntries(Object.entries(rec.pushes).filter(([c]) => c !== ch))
      if (!same(others(d), others(e))) return 0
      for (const [agent, lines] of Object.entries(e.timelines)) {
        if (!same(lines.filter((l) => !isMeshEventLine(l)), d.timelines[agent])) return 0
      }
      if (d.steps.length !== e.steps.length || d.steps.some((s, i) => !same(withoutPushes(s), withoutPushes(e.steps[i])))) return 0
      d.pushes = clone(e.pushes)
      if (e.pushSeq) d.pushSeq = clone(e.pushSeq)
      d.timelines = clone(e.timelines)
      d.steps = d.steps.map((s, i) => ({ ...s, pushes: clone(e.steps[i].pushes) }) as StepRecord)
      return 1
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
