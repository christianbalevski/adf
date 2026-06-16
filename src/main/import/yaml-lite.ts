/**
 * A dependency-free reader for the small slice of YAML the importer needs:
 * front-matter on Markdown files and the scalar/map/list shape of source
 * config files. It is deliberately a *subset* — block maps, block lists,
 * inline `[a, b]` / `{a: b}` flows, quoted and bare scalars, numbers and
 * booleans. Anchors, multi-line block scalars, and tags are not supported;
 * callers treat anything unusual as "not present" and emit a warning rather
 * than failing the whole import.
 */

export type YamlValue =
  | string
  | number
  | boolean
  | null
  | YamlValue[]
  | { [key: string]: YamlValue }

/** Split a Markdown document into its YAML front-matter and body. */
export function parseFrontmatter(input: string): {
  data: Record<string, YamlValue>
  body: string
} {
  const text = input.replace(/^﻿/, '')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return { data: {}, body: text }
  const data = parseYaml(match[1])
  const body = text.slice(match[0].length)
  return {
    data: (data && typeof data === 'object' && !Array.isArray(data))
      ? (data as Record<string, YamlValue>)
      : {},
    body,
  }
}

interface Line {
  indent: number
  content: string
}

/** Parse a YAML document into a plain JS value. Returns {} on empty input. */
export function parseYaml(input: string): YamlValue {
  const lines: Line[] = []
  for (const raw of input.replace(/^﻿/, '').split(/\r?\n/)) {
    const stripped = stripComment(raw)
    if (stripped.trim() === '') continue
    lines.push({ indent: raw.length - raw.trimStart().length, content: stripped.trim() })
  }
  if (lines.length === 0) return {}
  const [value] = parseBlock(lines, 0, lines[0].indent)
  return value
}

/** Parse a block of lines at >= `indent`, starting at `i`. Returns [value, nextIndex]. */
function parseBlock(lines: Line[], i: number, indent: number): [YamlValue, number] {
  if (i >= lines.length) return [null, i]
  const isList = lines[i].content.startsWith('- ') || lines[i].content === '-'

  if (isList) {
    const arr: YamlValue[] = []
    while (i < lines.length && lines[i].indent === indent &&
           (lines[i].content.startsWith('- ') || lines[i].content === '-')) {
      const rest = lines[i].content === '-' ? '' : lines[i].content.slice(2).trim()
      if (rest === '') {
        // Nested block belongs to this item.
        const [val, next] = parseBlock(lines, i + 1, i + 1 < lines.length ? lines[i + 1].indent : indent + 1)
        arr.push(val)
        i = next
      } else if (isMapEntry(rest)) {
        // Inline first key of a mapping item: re-parse as a synthetic block.
        const synthetic: Line[] = [{ indent: indent + 2, content: rest }]
        let j = i + 1
        while (j < lines.length && lines[j].indent > indent) {
          synthetic.push(lines[j]); j++
        }
        const [val] = parseBlock(synthetic, 0, indent + 2)
        arr.push(val)
        i = j
      } else {
        arr.push(parseScalar(rest))
        i++
      }
    }
    return [arr, i]
  }

  // Block mapping.
  const map: Record<string, YamlValue> = {}
  while (i < lines.length && lines[i].indent === indent) {
    const { content } = lines[i]
    const colon = findColon(content)
    if (colon === -1) { i++; continue }
    const key = unquote(content.slice(0, colon).trim())
    const after = content.slice(colon + 1).trim()
    if (after !== '') {
      map[key] = parseScalar(after)
      i++
    } else {
      // Value is a nested block on the following more-indented lines.
      if (i + 1 < lines.length && lines[i + 1].indent > indent) {
        const [val, next] = parseBlock(lines, i + 1, lines[i + 1].indent)
        map[key] = val
        i = next
      } else {
        map[key] = null
        i++
      }
    }
  }
  return [map, i]
}

function isMapEntry(s: string): boolean {
  return findColon(s) !== -1 && !s.startsWith('[') && !s.startsWith('{')
}

/** Index of the key/value colon, ignoring colons inside quotes/flows. */
function findColon(s: string): number {
  let inSingle = false, inDouble = false, depth = 0
  for (let k = 0; k < s.length; k++) {
    const c = s[k]
    if (c === "'" && !inDouble) inSingle = !inSingle
    else if (c === '"' && !inSingle) inDouble = !inDouble
    else if (!inSingle && !inDouble) {
      if (c === '[' || c === '{') depth++
      else if (c === ']' || c === '}') depth--
      else if (c === ':' && depth === 0 && (k + 1 >= s.length || s[k + 1] === ' ')) return k
    }
  }
  return -1
}

function stripComment(line: string): string {
  let inSingle = false, inDouble = false
  for (let k = 0; k < line.length; k++) {
    const c = line[k]
    if (c === "'" && !inDouble) inSingle = !inSingle
    else if (c === '"' && !inSingle) inDouble = !inDouble
    else if (c === '#' && !inSingle && !inDouble && (k === 0 || line[k - 1] === ' ')) {
      return line.slice(0, k)
    }
  }
  return line
}

function parseScalar(raw: string): YamlValue {
  const s = raw.trim()
  if (s.startsWith('[') && s.endsWith(']')) {
    return splitFlow(s.slice(1, -1)).map(parseScalar)
  }
  if (s.startsWith('{') && s.endsWith('}')) {
    const obj: Record<string, YamlValue> = {}
    for (const part of splitFlow(s.slice(1, -1))) {
      const colon = findColon(part)
      if (colon === -1) continue
      obj[unquote(part.slice(0, colon).trim())] = parseScalar(part.slice(colon + 1).trim())
    }
    return obj
  }
  if (s === '' || s === '~' || s === 'null') return null
  if (s === 'true') return true
  if (s === 'false') return false
  if (/^-?\d+$/.test(s)) return parseInt(s, 10)
  if (/^-?\d*\.\d+$/.test(s)) return parseFloat(s)
  return unquote(s)
}

function splitFlow(s: string): string[] {
  const out: string[] = []
  let depth = 0, inSingle = false, inDouble = false, start = 0
  for (let k = 0; k < s.length; k++) {
    const c = s[k]
    if (c === "'" && !inDouble) inSingle = !inSingle
    else if (c === '"' && !inSingle) inDouble = !inDouble
    else if (!inSingle && !inDouble) {
      if (c === '[' || c === '{') depth++
      else if (c === ']' || c === '}') depth--
      else if (c === ',' && depth === 0) { out.push(s.slice(start, k)); start = k + 1 }
    }
  }
  const last = s.slice(start).trim()
  if (last !== '') out.push(last)
  return out.map(x => x.trim()).filter(x => x !== '')
}

function unquote(s: string): string {
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\t/g, '\t')
  }
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") {
    return s.slice(1, -1).replace(/''/g, "'")
  }
  return s
}

/** Safe nested lookup: get(obj, 'model', 'default'). Returns undefined if any hop is missing. */
export function get(obj: YamlValue | undefined, ...path: string[]): YamlValue | undefined {
  let cur: YamlValue | undefined = obj
  for (const key of path) {
    if (cur && typeof cur === 'object' && !Array.isArray(cur) && key in cur) {
      cur = (cur as Record<string, YamlValue>)[key]
    } else {
      return undefined
    }
  }
  return cur
}

export function asString(v: YamlValue | undefined): string | undefined {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined
}

export function asNumber(v: YamlValue | undefined): number | undefined {
  return typeof v === 'number' ? v : undefined
}
