import type { ComparableRecording } from './recording'

/**
 * THE normalizer. Every rule that makes two recordings comparable lives in
 * this file, and each one says what it hides.
 *
 * Principle: replace a value only when it is expected to differ between two
 * correct runs (clock, randomness, the run's temp root, ports picked at run
 * time). Prefer replacing a value the harness KNOWS (the root path, the
 * owner DID from the run's settings) by its role over pattern matching, so a
 * backend that uses a different DID or path shows up as a difference. Random
 * values are numbered by first appearance inside one recording, so "the same
 * id twice" and "two different ids" stay distinguishable.
 *
 * Not normalized on purpose: everything not covered by a rule below is
 * compared as is, including array order, counts, error strings, token
 * estimates and path separators. Object key order is not compared (the
 * formatter sorts keys; no consumer depends on it).
 *
 * Rules exist only for values observed to vary. There is no duration rule:
 * no recorded payload carries a duration yet. When one does, add a rule here
 * keyed by that field name, not a pattern over all numbers.
 *
 * Two layers:
 * - `normalizeRecording` (R1-R10): used for every comparison, including
 *   embedded vs daemon on the same machine.
 * - `toGoldenForm` (G1): additionally applied only before comparing with the
 *   committed recordings, which must match on every OS.
 */

export interface NormalizationContext {
  /** Spellings of the run's temp root (realpath, 8.3 short form, …). */
  roots: readonly string[]
  /** Loopback ports chosen at run time. */
  ports: { value: string; name: string }[]
  /** Values read from the run's own state after the run, replaced by role. */
  named: { value: string | undefined; name: string }[]
  /** Fixture ids are fixed by the harness and never replaced. */
  fixtureIds: readonly string[]
}

const IS_WIN = process.platform === 'win32'

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Epoch milliseconds between 2020-01-01 and 2100-01-01. */
const EPOCH_MS_MIN = 1_577_836_800_000
const EPOCH_MS_MAX = 4_102_444_800_000

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

  // Rule R1 — run root. Every path the run touches is under one temp dir
  // whose name is random. Replaced by `<ROOT>` in every spelling (realpath,
  // the 8.3 short form os.tmpdir() may return on Windows, forward slashes as
  // in file URLs). Case-insensitive on Windows only, where the filesystem
  // is. Hides: the temp dir name. Keeps: everything after the root,
  // including separators.
  const rootSpellings = [...new Set(ctx.roots.flatMap((r) => [r, r.replace(/\\/g, '/')]))]
    .sort((a, b) => b.length - a.length)
  const rootRe = rootSpellings.length
    ? new RegExp(rootSpellings.map(escapeRegExp).join('|'), IS_WIN ? 'gi' : 'g')
    : null

  // Rule R2 — run-time ports. The mock LLM and the mesh server listen on
  // ports picked per run. Replaced only where they follow a loopback host,
  // as `<NAME>`. Hides: the port number. Keeps: host, scheme, path.
  const portRes = ctx.ports.map(({ value, name }) => ({
    re: new RegExp(`(127\\.0\\.0\\.1|localhost|\\[::1\\]):${escapeRegExp(value)}\\b`, 'g'),
    to: `$1:<${name}>`,
  }))

  // Rule R3 — named run state. The owner DID, runtime DID and runtime id
  // are generated at first boot of each run's fresh user-data dir; the
  // harness reads them from that run's settings file afterwards and replaces
  // them by role (`<did:owner>`). A backend that signs with a DIFFERENT DID
  // falls through to R4 and shows as `<did#n>`, i.e. as a difference.
  const named = ctx.named
    .filter((n): n is { value: string; name: string } => typeof n.value === 'string' && n.value.length > 0)
    .sort((a, b) => b.value.length - a.value.length)

  const replaceString = (input: string): string => {
    let s = input
    if (rootRe) s = s.replace(rootRe, '<ROOT>')
    for (const { re, to } of portRes) s = s.replace(re, to)
    for (const { value, name } of named) s = s.split(value).join(`<${name}>`)

    // Rule R4 — other DIDs. Agent DIDs are minted from fresh random keys on
    // every run. Numbered by first appearance (`<did#1>`), so the same agent
    // DID in two places stays the same placeholder.
    s = s.replace(/did:key:z[1-9A-HJ-NP-Za-km-z]{20,}/g, (m) => numbered('did', m))

    // Rule R5 — UUIDs. Message, request and record ids generated with
    // randomUUID(). Numbered by first appearance. Fixture ids (fixed by the
    // harness) are left alone.
    s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, (m) =>
      fixtureIds.has(m.toLowerCase()) ? m : numbered('uuid', m.toLowerCase()))

    // Rule R6 — ISO-8601 instants (`2026-10-14T15:19:32.123Z`). Wall clock.
    s = s.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})\b/g, '<iso>')

    // Rule R7 — the wall-clock stamp the runtime prefixes to chat messages
    // the model sees (`[2026-10-14 15:19:32 UTC]`). Wall clock.
    s = s.replace(/\b\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC\b/g, '<utc-time>')

    // Rule R8 — epoch milliseconds embedded in strings (`session-1791991172180`).
    // Exactly 13 digits inside the 2020-2100 range. Wall clock.
    s = s.replace(/(?<!\d)\d{13}(?!\d)/g, (m) => {
      const n = Number(m)
      return n >= EPOCH_MS_MIN && n < EPOCH_MS_MAX ? '<epoch-ms>' : m
    })
    return s
  }

  const walk = (value: unknown, key?: string): unknown => {
    if (typeof value === 'string') return replaceString(value)
    if (typeof value === 'number') {
      // Rule R9 — epoch-millisecond numbers (`timestamp`, `created_at`, …)
      // in the 2020-2100 range, under any key. Wall clock. Hides: the
      // instant and therefore ordering by time; order is still compared
      // through array position.
      if (Number.isInteger(value) && value >= EPOCH_MS_MIN && value < EPOCH_MS_MAX) return '<epoch-ms>'
      // Rule R2 (numeric form) — a port number under a key named like a port.
      if (key && /port$/i.test(key)) {
        const port = ctx.ports.find((p) => p.value === String(value))
        if (port) return `<${port.name}>`
      }
      return value
    }
    if (Array.isArray(value)) return value.map((v) => walk(v))
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        // Rule R10 — a property whose value is `undefined` is dropped. Electron's
        // structured clone keeps `{ x: undefined }`; JSON (the daemon's wire)
        // drops it. Reading `payload.x` gives undefined either way. Hides: a
        // renderer that tests `'x' in payload` (none does today).
        if (v === undefined) continue
        out[replaceString(k)] = walk(v, k)
      }
      return out
    }
    return value
  }

  return walk(recording) as ComparableRecording
}

/**
 * Golden-file form of a normalized recording.
 *
 * Rule G1 — path separators under `<ROOT>` become `/`, so one committed
 * recording serves Windows, macOS and Linux. Applied ONLY for the golden
 * comparison; two backends on one machine are still compared with their
 * separators intact.
 */
export function toGoldenForm(recording: ComparableRecording): ComparableRecording {
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return value.includes('<ROOT>') ? value.replace(/<ROOT>[^\s"'`<>|]*/g, (m) => m.replace(/\\/g, '/')) : value
    }
    if (Array.isArray(value)) return value.map(walk)
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [walk(k) as string, walk(v)]))
    }
    return value
  }
  return walk(recording) as ComparableRecording
}
