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
    id: 'w3a:start-session-id',
    ws: 'W3-A',
    scenarios: RUNNING,
    path: 'steps: AGENT_START result `sessionId`',
    what: 'The start route answers no runtime session id.',
    apply(d, e) {
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
      return n
    },
  },
  {
    id: 'w3a:chat-echo',
    ws: 'W3-A',
    scenarios: ['chat-tool-call'],
    path: 'AGENT_EVENT: one `trigger_message` (triggerType chat, the AGENT_INVOKE text) per AGENT_INVOKE, its timeline line and the step push watermarks it shifts',
    what: 'The chat route has no `echoed`: the daemon announces Studio\'s own chat as a trigger_message, which the renderer shows as a second user bubble (embedded dispatches it with echoed: true).',
    apply(d, e) {
      const ch = IPC.AGENT_EVENT
      const sent = d.steps.flatMap((st) => (st.kind === 'invoke' && st.channel === IPC.AGENT_INVOKE ? [String((st.args[0] as { userMessage?: unknown })?.userMessage)] : []))
      const echo = (p: unknown, text: string) => {
        const ev = p as { type?: string; payload?: { triggerType?: unknown; content?: unknown } }
        return ev?.type === 'trigger_message' && ev.payload?.triggerType === 'chat' && ev.payload.content === text
      }
      if (sent.length === 0 || (e.pushes[ch] ?? []).some((p) => sent.some((t) => echo(p, t)))) return 0
      const pushes = [...(d.pushes[ch] ?? [])]
      for (const text of sent) {
        const at = pushes.findIndex((p) => echo(p, text))
        if (at < 0) return 0
        pushes.splice(at, 1)
      }
      if (!same(pushes, e.pushes[ch] ?? [])) return 0
      const line = /^ {2}(?:\[app\] )?adf:agent:event trigger_message$/
      const timelines: Record<string, string[]> = {}
      let lines = 0
      for (const [agent, list] of Object.entries(d.timelines)) {
        timelines[agent] = list.filter((l) => !(line.test(l) && ++lines))
      }
      if (lines !== sent.length || !same(timelines, e.timelines)) return 0
      const bare = (st: StepRecord) => { const { pushes: _p, ...rest } = st as StepRecord & { pushes: unknown }; return rest }
      if (d.steps.length !== e.steps.length || d.steps.some((st, i) => !same(bare(st), bare(e.steps[i])))) return 0
      d.pushes[ch] = pushes
      d.timelines = timelines
      d.steps = d.steps.map((st, i) => ({ ...st, pushes: clone(e.steps[i].pushes) }) as StepRecord)
      return sent.length
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
