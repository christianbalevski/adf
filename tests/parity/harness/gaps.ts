import { IPC } from '../../../src/shared/constants/ipc-channels'
import { CLIENT_SETTINGS_KEYS } from '../../../src/shared/constants/client-settings-keys'
import { clientSettingsDefaults } from '../../../src/main/backend/daemon-mode/settings'
import { EMULATE_W4A } from './daemon-backend'
import type { ComparableRecording, StepRecord } from './recording'

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

export type GapTag = 'W1-A' | 'W2-A' | 'W2-B' | 'W0-C' | 'W0-D' | 'W3-A' | 'W4-A' | 'mode'

export interface GapEntry {
  id: string
  ws: GapTag
  scenarios: readonly string[]
  /** The one place the transform acts on. */
  path: string
  /** The difference, in one sentence. */
  what: string
  apply(daemon: ComparableRecording, embedded: ComparableRecording): number
}

const ALL = ['open-agent', 'start-agent', 'chat-tool-call'] as const
const RUNNING = ['start-agent', 'chat-tool-call'] as const
/** Scenarios whose agent file nobody holds open when the state is dumped (chat-tool-call's still runs). */
const NOT_RUNNING_AT_DUMP = ['open-agent', 'start-agent'] as const

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
    scenarios: ALL,
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
    id: 'w2b:open-document-reads',
    ws: 'W2-B',
    scenarios: ALL,
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
    id: 'w2b:agent-event-stream',
    ws: 'W2-B',
    scenarios: RUNNING,
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
    id: 'w2b:streaming-check',
    ws: 'W2-B',
    scenarios: RUNNING,
    path: 'problems: the streaming check',
    what: 'No text_delta_batch reaches the window (same cause as w2b:agent-event-stream).',
    apply(d) {
      const before = d.problems?.length ?? 0
      d.problems = (d.problems ?? []).filter((p) => !/^streaming: \d+ text slice\(s\) arrived as 0 text_delta_batch push\(es\)$/.test(p))
      const n = before - d.problems.length
      if (d.problems.length === 0) delete d.problems
      return n
    },
  },
  {
    id: 'w2b:identity-on-open',
    ws: 'W2-B',
    scenarios: ALL,
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
    id: 'w2b:identity-meta',
    ws: 'W2-B',
    scenarios: ALL,
    path: 'state: adf_meta rows adf_did, adf_owner_did, adf_runtime_did',
    what: 'Same cause as w2b:identity-on-open: the identity stamps are written on open.',
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
    id: 'w2b:open-document-handle',
    ws: 'W2-B',
    scenarios: NOT_RUNNING_AT_DUMP,
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
    id: 'w2b:open-document-wal',
    ws: 'W2-B',
    scenarios: NOT_RUNNING_AT_DUMP,
    path: 'state.tree: the -wal and -shm files of an open agent file',
    what: 'Same cause as w2b:open-document-handle: the file is not held open, so no -wal/-shm beside it.',
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
    scenarios: ALL,
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
    scenarios: ALL,
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
    scenarios: ALL,
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
    id: 'w4a:client-record-control-url',
    ws: 'W4-A',
    scenarios: ALL,
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
    scenarios: ['open-agent'],
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
    scenarios: ['chat-tool-call'],
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
    scenarios: RUNNING,
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
    scenarios: ALL,
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
    scenarios: ALL,
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
    scenarios: RUNNING,
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
]

/** Apply every entry for `scenario`; the ids of entries that matched nothing are returned. */
export function applyGapAllowlist(scenario: string, daemon: ComparableRecording, embedded: ComparableRecording): { unmatched: string[]; counts: Record<string, number> } {
  const unmatched: string[] = []
  const counts: Record<string, number> = {}
  for (const entry of GAP_ALLOWLIST) {
    if (!entry.scenarios.includes(scenario)) continue
    const n = entry.apply(daemon, embedded)
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
