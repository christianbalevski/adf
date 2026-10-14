import type { ComparableRecording } from './recording'

/**
 * THE normalizer. Every rule that makes two recordings comparable lives in
 * this file, and each one says what it hides.
 *
 * Principle: replace a value only when it is expected to differ between two
 * correct runs (clock, randomness, the run's temp root, ports picked at run
 * time). Prefer replacing a value the harness KNOWS (a root spelling, the
 * fixture owner DID) by its role over pattern matching, so a backend that
 * uses a different DID or path spelling shows up as a difference. Random
 * values are numbered by first appearance (objects walked in sorted key
 * order, the same order the formatter prints), so "the same id twice" and
 * "two different ids" stay distinguishable.
 *
 * Everything not covered by a rule is compared as is: array order, counts,
 * error names, codes and messages, token estimates, path separators and
 * case, `undefined`-valued properties (the renderer's rowsEqual compares
 * key counts, so `{x: undefined}` and `{}` differ for it). Object key order
 * is not compared (the formatter sorts keys; no consumer depends on it).
 *
 * Rules exist only for values observed to vary. There is no duration rule:
 * no recorded payload carries a duration yet. When one does, add a rule here
 * keyed by that field name, not a pattern over all numbers.
 *
 * Two layers:
 * - `normalizeRecording` (R1-R13): every comparison, including embedded vs
 *   daemon on the same machine.
 * - `toGoldenForm` (G1): additionally, only before comparing with the
 *   committed recordings, which must match on every OS.
 *
 * Values that are not plain objects, arrays or primitives (Map, Date, Buffer,
 * class instances) throw: they would otherwise render as `{}` and hide
 * content, and they do not survive the daemon's JSON wire unchanged.
 */

export interface NormalizationContext {
  /** Each spelling of the run root with its own token. */
  rootSpellings: readonly { spelling: string; token: string }[]
  /** Loopback ports chosen at run time. */
  ports: { value: string; name: string }[]
  /** Known values replaced by role, e.g. the fixture owner DID. */
  named: { value: string | undefined; name: string }[]
  /** Fixture ids are fixed by the harness and never replaced. */
  fixtureIds: readonly string[]
  /** Process ids of the run's runtime hosts and clients, by role (R13). */
  pids?: { value: number; name: string }[]
  /** Signature → verified against its issuer (signatures.ts); used by R10. */
  signatures?: ReadonlyMap<string, boolean>
  /** Wall-clock window of the run [from, to] in epoch ms; timestamps outside stay raw. */
  window: { from: number; to: number }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const ISO_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})\b/g
const UTC_STAMP_RE = /\b(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC\b/g
const EPOCH_IN_STRING_RE = /(?<!\d)\d{13}(?!\d)/g
const EPOCH_US_IN_STRING_RE = /(?<!\d)\d{16}(?!\d)/g

function isPlain(value: object): boolean {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null || proto === Array.prototype
}

export function normalizeRecording(recording: ComparableRecording, ctx: NormalizationContext): ComparableRecording {
  const counters = new Map<string, Map<string, number>>()
  /** Stable placeholder for a random value: same input, same number, within this recording. */
  const numbered = (kind: string, value: string): string => {
    let seen = counters.get(kind)
    if (!seen) counters.set(kind, (seen = new Map()))
    let n = seen.get(value)
    if (n === undefined) seen.set(value, (n = seen.size + 1))
    return `<${kind}#${n}>`
  }

  const fixtureIds = new Set(ctx.fixtureIds.map((id) => id.toLowerCase()))
  /** A stamp of `precision` ms covers [ms, ms + precision); it is in the window if that overlaps it. */
  const inWindow = (ms: number, precision = 1) => ms + precision - 1 >= ctx.window.from && ms <= ctx.window.to

  // Rule R1 — run root. Every path the run touches is under one temp dir
  // whose name is random. Each spelling code may produce gets its OWN token
  // (`<ROOT>` = realpath, `<ROOT:tmpdir-spelling>` = the 8.3 form os.tmpdir()
  // may return on Windows, `…:fwd>` = forward slashes, `…:lower-drive>` =
  // lowercase drive letter). Matching is exact and case-sensitive, so a
  // backend that spells the path differently shows a different token, and
  // any other case change leaves the random dir name raw (a visible diff).
  // Hides: the temp dir name only.
  const rootRe = ctx.rootSpellings.length
    ? new RegExp(ctx.rootSpellings.map((s) => escapeRegExp(s.spelling)).join('|'), 'g')
    : null
  const rootToken = new Map(ctx.rootSpellings.map((s) => [s.spelling, s.token]))

  // Rule R2 — run-time ports. The mock LLM, the mesh server and any backend
  // server listen on ports picked per run. Replaced only right after a
  // loopback host, as `<NAME>`. Hides: the port number.
  const portRes = ctx.ports.map(({ value, name }) => ({
    re: new RegExp(`(127\\.0\\.0\\.1|localhost|\\[::1\\]):${escapeRegExp(value)}\\b`, 'g'),
    to: `$1:<${name}>`,
  }))

  // Rule R3 — named values. The owner and runtime identity are fixed
  // fixtures (identity.fixture.json); their DIDs become `<did:owner>` and
  // `<did:runtime>`. A backend that mints or signs with a DIFFERENT DID
  // falls through to R4 and shows as `<did#n>`. Also named: the fixture
  // delegation's signature (`<sig:runtime-delegation>`) and the scratch-dir
  // names derived from the pid and each fixture's path (scenario.ts).
  const named = ctx.named
    .filter((n): n is { value: string; name: string } => typeof n.value === 'string' && n.value.length > 0)
    .sort((a, b) => b.value.length - a.value.length)

  // Rule R8 — wall-clock instants inside the run window: epoch-ms numbers,
  // 13-digit epoch-ms runs inside strings (`session-1791991172180`),
  // ISO-8601 strings and the `YYYY-MM-DD HH:MM:SS UTC` stamp the runtime
  // prefixes to chat messages, and 16-digit epoch microseconds. Each becomes
  // `<t>`, or `<t:earlier>` when R9 finds it out of order. Values outside
  // the window (fixture dates, the fixed delegation's issue date, constants)
  // stay raw.
  //
  // Not rank tokens: two events in the same millisecond in one run and one
  // millisecond apart in the next would get different ranks, so ranks are
  // not stable. Order is what matters and is compared through R9.
  type Stamp = { ms: number; precision: number }
  const stampsOf = (s: string): Stamp[] => {
    const out: Stamp[] = []
    for (const m of s.matchAll(ISO_RE)) {
      const ms = Date.parse(m[0])
      const precision = m[0].includes('.') ? 1 : 1000
      if (inWindow(ms, precision)) out.push({ ms, precision })
    }
    for (const m of s.matchAll(UTC_STAMP_RE)) {
      const ms = Date.parse(`${m[1]}T${m[2]}Z`)
      if (inWindow(ms, 1000)) out.push({ ms, precision: 1000 })
    }
    for (const m of s.matchAll(EPOCH_IN_STRING_RE)) {
      const ms = Number(m[0])
      if (inWindow(ms)) out.push({ ms, precision: 1 })
    }
    return out
  }

  /** `floor` = latest instant that must not be later than this one (R9), or -Infinity. */
  const timeToken = (stamp: Stamp, floor: number) =>
    stamp.ms + stamp.precision - 1 < floor ? '<t:earlier>' : '<t>'

  const replaceString = (input: string, floor: number, seen: number[]): string => {
    let s = input
    if (rootRe) s = s.replace(rootRe, (m) => rootToken.get(m) ?? m)
    for (const { re, to } of portRes) s = s.replace(re, to)
    for (const { value, name } of named) s = s.split(value).join(`<${name}>`)

    // Rule R4 — other DIDs. Agent DIDs are minted from fresh random keys on
    // every run. Numbered by first appearance (`<did#1>`).
    s = s.replace(/did:key:z[1-9A-HJ-NP-Za-km-z]{20,}/g, (m) => numbered('did', m))

    // Rule R5 — UUIDs (message, request, record ids from randomUUID()).
    // Numbered by first appearance. Fixture ids are left alone.
    s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, (m) =>
      fixtureIds.has(m.toLowerCase()) ? m : numbered('uuid', m.toLowerCase()))

    // Rule R10 — Ed25519 signatures. The fixture delegation's signature is
    // named by R3 (`<sig:runtime-delegation>`). Every other one was verified
    // against its issuer's DID before normalization (signatures.ts) and
    // prints as `<sig:valid#n>` or `<sig:INVALID#n>`, numbered by first
    // appearance. A signature that was not part of a verifiable attestation
    // stays raw: a visible difference, never a silent pass.
    s = s.replace(/ed25519:[A-Za-z0-9+/]{80,}={0,2}/g, (m) => {
      const valid = ctx.signatures?.get(m)
      return valid === undefined ? m : numbered(valid ? 'sig:valid' : 'sig:INVALID', m)
    })

    // Rule R8 (string forms).
    const tok = (raw: string, stamp: Stamp | null) => {
      if (!stamp) return raw
      seen.push(stamp.ms)
      return timeToken(stamp, floor)
    }
    s = s.replace(ISO_RE, (m) => tok(m, stampsOf(m)[0] ?? null))
    s = s.replace(UTC_STAMP_RE, (m) => tok(m, stampsOf(m)[0] ?? null))
    s = s.replace(EPOCH_IN_STRING_RE, (m) => tok(m, stampsOf(m)[0] ?? null))
    // Epoch microseconds (16 digits): the umbilical sequence seed in adf_meta.
    s = s.replace(EPOCH_US_IN_STRING_RE, (m) => {
      const ms = Math.floor(Number(m) / 1000)
      return inWindow(ms) ? tok(m, { ms, precision: 1 }) : m
    })
    return s
  }

  // Rule R13 — runtime host registry (agent-lease.ts). The registry files
  // are named after the host's pid (`hosts/<pid>.json`, `clients/<pid>.json`)
  // and leases record their holder's `pid`. A pid the harness knows (its
  // own process, a backend's daemon) becomes `<pid:ROLE>` in those file
  // names and in `pid` fields under `state.leases`; any other pid stays raw.
  // The records' runtimeId, endpoint, machine id and hostname are named by
  // role through R3 (scenario.ts reads them from the records), and lease file
  // names (sha256 of an agent's canonical path) become `<lease:agent-n>`.
  const pidName = new Map((ctx.pids ?? []).map((p) => [p.value, p.name]))
  const replaceRegistryPid = (s: string) =>
    s.replace(/\b(hosts|clients)([\\/])(\d+)\.json\b/g, (m, sub: string, sep: string, pid: string) => {
      const name = pidName.get(Number(pid))
      return name ? `${sub}${sep}<${name}>.json` : m
    })

  // Rule R11 — identity key material in the dumped .adf: `adf_identity.value`
  // holds freshly generated keys and envelopes (random each run). The bytes
  // become `<key-bytes#k> len=N`: length kept, content numbered by hash. Scoped
  // to that one column; every other blob keeps its real hash.
  const IDENTITY_VALUE_PATH = /^state\.adf\..*\.tables\.adf_identity\.rows\[\d+\]\.value$/
  const BYTES_RE = /^<bytes len=(\d+) sha256=([0-9a-f]+)>$/

  // Rule R12 — the turn checkpoint in `adf_meta` (key
  // `adf_runtime_turn_checkpoint`) carries a random 10-character turn id.
  // Numbered as `<turn-id#n>`; scoped to that row.
  const UPSERT_TABLE_ROWS = /^state\.adf\..*\.tables\.(adf_meta|adf_config|adf_files|adf_identity)\.rows$/
  const META_ROW_PATH =/^state\.adf\..*\.tables\.adf_meta\.rows\[\d+\]$/
  const preprocessRow = (path: string, row: Record<string, unknown>): Record<string, unknown> => {
    if (META_ROW_PATH.test(path) && row.key === 'adf_runtime_turn_checkpoint' && typeof row.value === 'string') {
      return { ...row, value: row.value.replace(/"id":"([A-Za-z0-9_-]{10})"/, (_m, id: string) => `"id":"${numbered('turn-id', id)}"`) }
    }
    return row
  }

  /**
   * Rule R9 — order. An instant is `<t:earlier>` when it is strictly before
   * an instant of an EARLIER element: of the same array (every array: steps,
   * uiLog entries, state rows in rowid order, …), of any enclosing array, or,
   * for pushes, of any push sent before it on any channel (global send
   * order). `floor` carries that bound down; `seen` collects the instants
   * of the value walked. Equal instants are in order.
   *
   * Exception: rows of tables written by upsert (key-value and per-path
   * tables: adf_meta, adf_config, adf_files, adf_identity). Their rowid order
   * is insertion order while their timestamps are of the last update, so
   * sibling rows are not compared with each other (each is still compared
   * with the enclosing floor). Observed: adf_meta rows flipped between
   * `<t>` and `<t:earlier>` from run to run.
   */
  const walk = (value: unknown, path: string, floor: number, seen: number[], key?: string): unknown => {
    if (typeof value === 'number' && key === 'pid' && path.startsWith('state.leases.') && pidName.has(value)) {
      return `<${pidName.get(value)}>`
    }
    if (typeof value === 'string' && (path.startsWith('state.tree') || path.startsWith('state.leases'))) value = replaceRegistryPid(value)
    if (typeof value === 'string') {
      const bytes = IDENTITY_VALUE_PATH.test(path) ? BYTES_RE.exec(value) : null
      if (bytes) return `${numbered('key-bytes', bytes[2])} len=${bytes[1]}`
      return replaceString(value, floor, seen)
    }
    if (typeof value === 'number') {
      // Rule R8 (numeric form): epoch-ms numbers in the run window.
      if (Number.isInteger(value) && inWindow(value)) {
        seen.push(value)
        return timeToken({ ms: value, precision: 1 }, floor)
      }
      // Rule R2 (numeric form) — a port number under a key named like a port.
      if (key && /port$/i.test(key)) {
        const port = ctx.ports.find((p) => p.value === String(value))
        if (port) return `<${port.name}>`
      }
      return value
    }
    if (value === null || typeof value !== 'object') return value
    if (!isPlain(value)) {
      throw new Error(`parity normalizer: non-plain value (${Object.prototype.toString.call(value)}) at ${path}`)
    }
    if (Array.isArray(value)) {
      let running = floor
      const ordered = !UPSERT_TABLE_ROWS.test(path)
      return value.map((v, i) => {
        const own: number[] = []
        const out = walk(v, `${path}[${i}]`, running, own)
        if (ordered) for (const ms of own) running = Math.max(running, ms)
        seen.push(...own)
        return out
      })
    }
    const obj = preprocessRow(path, value as Record<string, unknown>)
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(obj).sort()) {
      const outKey = path === 'state.leases' ? replaceRegistryPid(replaceString(k, floor, [])) : replaceString(k, floor, [])
      out[outKey] = walk(obj[k], `${path}.${k}`, floor, seen, k)
    }
    return out
  }

  // R9 for pushes: the floor of each push is the latest instant of every
  // push sent before it (global seq order, all channels).
  const instantsOf = (value: unknown): number[] => {
    if (typeof value === 'string') {
      const us = [...value.matchAll(EPOCH_US_IN_STRING_RE)].map((m) => Math.floor(Number(m[0]) / 1000)).filter((ms) => inWindow(ms))
      return [...stampsOf(value).map((st) => st.ms), ...us]
    }
    if (typeof value === 'number') return Number.isInteger(value) && inWindow(value) ? [value] : []
    if (Array.isArray(value)) return value.flatMap(instantsOf)
    if (value && typeof value === 'object') return Object.values(value).flatMap(instantsOf)
    return []
  }
  const pushFloor = new Map<string, number[]>()
  {
    const order = Object.entries(recording.pushSeq ?? {})
      .flatMap(([ch, seqs]) => seqs.map((seq, i) => ({ ch, i, seq })))
      .sort((a, b) => a.seq - b.seq)
    let running = -Infinity
    for (const { ch, i } of order) {
      const floors = pushFloor.get(ch) ?? []
      floors[i] = running
      pushFloor.set(ch, floors)
      for (const ms of instantsOf(recording.pushes[ch]?.[i])) running = Math.max(running, ms)
    }
  }
  const walkStream = (ch: string, payloads: unknown[]): unknown[] =>
    payloads.map((p, i) => walk(p, `pushes.${ch}[${i}]`, pushFloor.get(ch)?.[i] ?? -Infinity, []))

  // Walk in print order (the formatter's section order) so numbering matches what is read.
  const none: number[] = []
  return {
    scenario: recording.scenario,
    steps: walk(recording.steps, 'steps', -Infinity, none) as ComparableRecording['steps'],
    pushes: Object.fromEntries(Object.keys(recording.pushes).sort()
      .map((ch) => [ch, walkStream(ch, recording.pushes[ch])])),
    timelines: walk(recording.timelines, 'timelines', -Infinity, none) as ComparableRecording['timelines'],
    local: walk(recording.local, 'local', -Infinity, none) as ComparableRecording['local'],
    llm: walk(recording.llm, 'llm', -Infinity, none) as ComparableRecording['llm'],
    state: walk(recording.state, 'state', -Infinity, none) as ComparableRecording['state'],
  }
}

/**
 * Golden-file form of a normalized recording.
 *
 * Rule G1 — one committed recording serves Windows, macOS and Linux: path
 * separators after `<ROOT>` become `/`, and `<ROOT:fwd>` (the Windows
 * forward-slash spelling, identical to `<ROOT>` elsewhere) becomes `<ROOT>`.
 * Also drops `s …` lines (sockets) from the file listing: the lease
 * endpoint is a socket file on macOS/Linux and a named pipe outside the tree
 * on Windows; the host record names the endpoint either way.
 * Applied ONLY for the golden comparison; two backends on one machine are
 * still compared with separators, spellings and sockets intact.
 */
export function toGoldenForm(recording: ComparableRecording): ComparableRecording {
  const fix = (s: string) => s
    .replace(/<ROOT:fwd>/g, '<ROOT>')
    .replace(/<ROOT>[^\s"'`<>|]*/g, (m) => m.replace(/\\/g, '/'))
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return value.includes('<ROOT') ? fix(value) : value
    if (Array.isArray(value)) return value.map(walk)
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [walk(k) as string, walk(v)]))
    }
    return value
  }
  const out = walk(recording) as ComparableRecording
  return { ...out, state: { ...out.state, tree: out.state.tree.filter((line) => !line.startsWith('s ')) } }
}
