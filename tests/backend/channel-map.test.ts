/**
 * The daemon-backend channel map (src/main/backend/channel-map.ts) against the
 * code it describes: every channel classified once, each entry's kind matching
 * how preload and main use the channel, every listed route documented in the
 * OpenAPI contract, and the gap list doc in step with the map.
 *
 * The compile-time half (`satisfies Record<IpcChannel | RawChannel, …>`) makes
 * an unclassified IPC constant a type error; these checks cover what the type
 * system cannot see.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import spec from '../../docs/daemon/openapi.json'
import { IPC } from '../../src/shared/constants/ipc-channels'
import {
  CHANNEL_MAP,
  RAW_CHANNELS,
  listChannelGaps,
  type ChannelEntry,
  type ChannelKind,
  type MappedChannel,
} from '../../src/main/backend/channel-map'

const ROOT = join(__dirname, '..', '..')

function sourceFiles(dir: string): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(p))
    else if (/\.tsx?$/.test(entry.name)) out.push({ path: p, text: readFileSync(p, 'utf8') })
  }
  return out
}

const mainFiles = sourceFiles(join(ROOT, 'src', 'main'))
const preload = readFileSync(join(ROOT, 'src', 'preload', 'index.ts'), 'utf8')
const entries = Object.entries(CHANNEL_MAP) as Array<[MappedChannel, ChannelEntry]>
const nameOf = new Map<string, string>(Object.entries(IPC).map(([name, value]) => [value, name]))

/** How preload and main actually use an IPC constant. */
function observedKind(name: string): { kind: ChannelKind; registered: boolean; sent: boolean } {
  const ref = `IPC\\.${name}\\b`
  const registered = mainFiles.some((f) => new RegExp(`ipcMain\\.(handle|on)\\(\\s*${ref}`).test(f.text))
  const sent = mainFiles.some((f) => new RegExp(`\\.send\\(\\s*${ref}`).test(f.text))
  if (new RegExp(`ipcRenderer\\.invoke\\(\\s*${ref}`).test(preload)) return { kind: 'invoke', registered, sent }
  if (new RegExp(`ipcRenderer\\.send\\(\\s*${ref}`).test(preload)) return { kind: 'send', registered, sent }
  if (new RegExp(`ipcRenderer\\.on\\(\\s*${ref}`).test(preload)) return { kind: 'push', registered, sent }
  return { kind: 'none', registered, sent }
}

/** "GET /agents/:id/config" -> openapi.json has paths['/agents/{id}/config'].get */
function documented(route: string): boolean {
  const match = /^(GET|POST|PUT|PATCH|DELETE) (\/\S*)$/.exec(route)
  if (!match) return false
  const path = match[2].replace(/:([A-Za-z]+)/g, '{$1}')
  const ops = (spec as { paths: Record<string, Record<string, unknown>> }).paths[path]
  return !!ops && match[1].toLowerCase() in ops
}

describe('channel map', () => {
  it('classifies every IPC channel and raw channel exactly once', () => {
    const expected = [...Object.values(IPC), ...RAW_CHANNELS].sort()
    expect(Object.keys(CHANNEL_MAP).sort()).toEqual(expected)
    expect(new Set(Object.values(IPC)).size).toBe(Object.values(IPC).length)
  })

  it('gives each IPC channel the kind preload and main use it as', () => {
    const mismatches: string[] = []
    for (const [name, value] of Object.entries(IPC)) {
      const entry = CHANNEL_MAP[value]
      const seen = observedKind(name)
      if (entry.kind !== seen.kind) mismatches.push(`${name}: map says ${entry.kind}, preload uses it as ${seen.kind}`)
      if ((seen.kind === 'invoke' || seen.kind === 'send') && !seen.registered) mismatches.push(`${name}: no ipcMain handler in src/main`)
      if (seen.kind === 'push' && !seen.sent) mismatches.push(`${name}: no webContents.send in src/main`)
      if (seen.kind === 'none' && (seen.registered || seen.sent)) mismatches.push(`${name}: used in main but not exposed in preload`)
    }
    expect(mismatches).toEqual([])
  })

  it('lists every raw string channel src/main uses, and only those', () => {
    const raw = new Set<string>()
    for (const f of mainFiles) {
      for (const line of f.text.split('\n')) {
        if (/^\s*(\*|\/\/)/.test(line)) continue // comments
        for (const m of line.matchAll(/(?:\.send|ipcMain\.(?:handle|on|once))\(\s*['"`]([^'"`]+)['"`]/g)) raw.add(m[1])
      }
    }
    expect([...raw].sort()).toEqual([...RAW_CHANNELS].sort())
  })

  it('gives each proxied channel a route, a gap or both, and each proxied push a frame', () => {
    const bad: string[] = []
    for (const [channel, entry] of entries) {
      const label = nameOf.get(channel) ?? channel
      if (entry.class === 'local') {
        if (entry.gaps.length > 0) bad.push(`${label}: local entry with gaps`)
        if (entry.frame) bad.push(`${label}: local entry with a frame`)
        continue
      }
      if (entry.kind === 'push') {
        if (!entry.frame) bad.push(`${label}: push without a client-stream frame`)
        if (entry.routes.length > 0) bad.push(`${label}: push with request routes`)
      } else if (entry.class === 'proxied' && entry.routes.length === 0 && entry.gaps.length === 0) {
        bad.push(`${label}: proxied with neither a route nor a gap`)
      }
      if ((entry.class === 'remote-variant' || entry.class === 'remote-unsupported') && !entry.remote) {
        bad.push(`${label}: ${entry.class} without its remote behaviour`)
      }
    }
    expect(bad).toEqual([])
  })

  it('names only routes documented in docs/daemon/openapi.json', () => {
    const missing = entries.flatMap(([channel, entry]) =>
      entry.routes.filter((route) => !documented(route)).map((route) => `${nameOf.get(channel) ?? channel}: ${route}`))
    expect(missing).toEqual([])
  })

  it('keeps docs/design/daemon-backend-gaps.md in step with the map, need by need', () => {
    const doc = readFileSync(join(ROOT, 'docs', 'design', 'daemon-backend-gaps.md'), 'utf8')
    // "## W1-D" section -> need -> channel names, from rows "| need | `A`, `B` |".
    const inDoc = new Map<string, Map<string, string[]>>()
    for (const part of doc.split(/^## /m).slice(1)) {
      const ws = /^(W\d-[A-Z])\b/.exec(part)?.[1]
      if (!ws) continue
      const rows = new Map<string, string[]>()
      for (const line of part.split('\n')) {
        if (!line.startsWith('| ') || line.startsWith('| Need |')) continue
        const cut = line.lastIndexOf(' | ')
        const need = line.slice(2, cut).replaceAll('\\|', '|')
        const channels = [...line.slice(cut).matchAll(/`([^`]+)`/g)].map((m) => m[1]).sort()
        rows.set(need, channels)
      }
      inDoc.set(ws, rows)
    }

    const inMap = new Map<string, Map<string, string[]>>()
    for (const g of listChannelGaps()) {
      const rows = inMap.get(g.ws) ?? new Map<string, string[]>()
      const list = rows.get(g.need) ?? []
      const name = nameOf.get(g.channel) ?? g.channel
      if (!list.includes(name)) list.push(name)
      rows.set(g.need, list)
      inMap.set(g.ws, rows)
    }
    const flatten = (m: Map<string, Map<string, string[]>>) =>
      [...m].flatMap(([ws, rows]) => [...rows].map(([need, names]) => `${ws} | ${need} | ${[...names].sort().join(', ')}`)).sort()
    expect(flatten(inDoc)).toEqual(flatten(inMap))
  })

  it('keeps embedded side effects out of notes', () => {
    // A note that describes what embedded mode does is a parity difference;
    // it belongs in `gaps`, where a workstream owns it.
    const offenders = entries
      .filter(([, entry]) => entry.note && /\bembedded\b/i.test(entry.note))
      .map(([channel, entry]) => `${nameOf.get(channel) ?? channel}: ${entry.note}`)
    expect(offenders).toEqual([])
  })
})
