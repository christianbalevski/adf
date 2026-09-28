import { MAIN_LOOP, type UmbilicalEvent } from '../../api/types'
import type { EventFilters } from './state'

export interface EventScope {
  selectedAgentId: string | null
  selectedLoop: string
}

/**
 * Type filter terms, comma or space separated. `tool.` / `tool.*` match a
 * prefix, a bare word matches anywhere in the type, `-turn.delta` excludes.
 */
export function parseTypeFilter(text: string): { include: string[]; exclude: string[] } {
  const include: string[] = []
  const exclude: string[] = []
  for (const raw of text.split(/[\s,]+/)) {
    const term = raw.trim().toLowerCase().replace(/\*$/, '')
    if (!term || term === '-') continue
    if (term.startsWith('-') || term.startsWith('!')) exclude.push(term.slice(1))
    else include.push(term)
  }
  return { include, exclude }
}

function matchesTerm(type: string, term: string): boolean {
  return term.endsWith('.') ? type.startsWith(term) : type.includes(term)
}

export function eventMatches(event: UmbilicalEvent, filters: EventFilters, scope: EventScope, terms = parseTypeFilter(filters.types)): boolean {
  const type = event.event_type.toLowerCase()
  if (terms.include.length > 0 && !terms.include.some(t => matchesTerm(type, t))) return false
  if (terms.exclude.some(t => matchesTerm(type, t))) return false
  if (filters.agent === 'selected' || filters.loop === 'selected') {
    if (!scope.selectedAgentId || event.agent_id !== scope.selectedAgentId) return false
  }
  if (filters.loop === 'selected' && (event.loop ?? MAIN_LOOP) !== scope.selectedLoop) return false
  return true
}

export function filterEvents(events: UmbilicalEvent[], filters: EventFilters, scope: EventScope): UmbilicalEvent[] {
  const terms = parseTypeFilter(filters.types)
  return events.filter(e => eventMatches(e, filters, scope, terms))
}

export function eventKey(event: UmbilicalEvent): string {
  return `${event.agent_id ?? '-'}:${event.seq}:${event.timestamp}:${event.event_type}`
}

/** One-line payload summary: the fields people scan for first, then the rest. */
export function summarizePayload(payload: Record<string, unknown> | undefined, max = 400): string {
  if (!payload) return ''
  const first = ['state', 'name', 'kind', 'text', 'model', 'content', 'message', 'error', 'reason']
  const parts: string[] = []
  let length = 0
  const add = (part: string) => { parts.push(part); length += part.length + 1 }
  for (const key of first) {
    const value = payload[key]
    if (value === undefined || value === null || value === '') continue
    add(`${key}=${typeof value === 'string' ? JSON.stringify(value.length > 60 ? `${value.slice(0, 60)}…` : value) : short(value)}`)
    if (length >= max) return parts.join(' ')
  }
  for (const key in payload) {
    const value = payload[key]
    if (first.includes(key) || value === undefined) continue
    add(`${key}=${short(value)}`)
    if (length >= max) break
  }
  return parts.join(' ')
}

const SHORT = 60

function short(value: unknown): string {
  const text = boundedJson(value, SHORT + 1)
  return text.length > SHORT ? `${text.slice(0, SHORT)}…` : text
}

/**
 * JSON text of `value`, stopping once about `max` characters are out: a huge
 * tool result costs the same as a short one (rows are summarized per event).
 */
export function boundedJson(value: unknown, max: number): string {
  let out = ''
  const seen = new Set<unknown>()
  const walk = (v: unknown): void => {
    if (out.length >= max) return
    if (v === null || v === undefined || typeof v === 'function' || typeof v === 'symbol') { out += 'null'; return }
    if (typeof v === 'string') { out += JSON.stringify(v.length > max ? v.slice(0, max) : v); return }
    if (typeof v === 'number' || typeof v === 'boolean') { out += String(v); return }
    if (typeof v === 'bigint') { out += v.toString(); return }
    if (seen.has(v)) { out += '"[circular]"'; return }
    seen.add(v)
    if (Array.isArray(v)) {
      out += '['
      for (let i = 0; i < v.length && out.length < max; i++) { if (i) out += ','; walk(v[i]) }
      out += ']'
    } else {
      out += '{'
      let i = 0
      for (const key in v as Record<string, unknown>) {
        if (out.length >= max) break
        const item = (v as Record<string, unknown>)[key]
        if (item === undefined) continue
        if (i++) out += ','
        out += `${JSON.stringify(key)}:`
        walk(item)
      }
      out += '}'
    }
    seen.delete(v)
  }
  walk(value)
  return out
}

export interface EventRow {
  summary: string
  /** Lower-cased text the `/` search matches (type, loop, payload summary). */
  search: string
}

const rowCache = new WeakMap<UmbilicalEvent, EventRow>()

/** Per-event derived text, computed once per event object (events are immutable). */
export function eventRow(event: UmbilicalEvent): EventRow {
  let row = rowCache.get(event)
  if (!row) {
    const summary = summarizePayload(event.payload)
    row = { summary, search: `${event.event_type} ${event.loop ?? MAIN_LOOP} ${summary}`.toLowerCase() }
    rowCache.set(event, row)
  }
  return row
}
