/**
 * CI guard: every umbilical event type the runtime emits is declared in the
 * typed registry (src/shared/types/umbilical-events.ts).
 *
 * Companion to umbilical-emit-guard.test.ts, which enforces that all events go
 * through emitUmbilicalEvent in the first place. This test enforces that the
 * event_type they carry is a known member of UMBILICAL_EVENT_TYPES, so tap
 * filters, docs, and downstream consumers stay in sync with the emitters.
 *
 * Two shapes are scanned:
 *   1. Direct `emitUmbilicalEvent({ ... event_type: '<literal>' ... })` blocks.
 *   2. Thin per-file wrapper emitters (WRAPPER_EMITTERS) whose first argument
 *      is the event type literal.
 *
 * Blocks whose event_type is a runtime expression (not a literal) are only
 * permitted in DYNAMIC_EMIT_ALLOWLIST — today the agent-authored `custom.*`
 * site plus the two wrapper implementations.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import {
  UMBILICAL_EVENT_TYPES,
  isKnownUmbilicalEventType,
} from '../../src/shared/types/umbilical-events'

const REPO_ROOT = join(__dirname, '..', '..')
const MAIN_ROOT = join(REPO_ROOT, 'src', 'main')

/** Files allowed to pass a non-literal event_type through to the helper. */
const DYNAMIC_EMIT_ALLOWLIST = new Set<string>([
  // adf.emit_event — agent-authored `custom.*` events, validated at runtime.
  'src/main/runtime/adf-call-handler.ts',
  // Wrapper implementations; their literal call sites are checked separately.
  'src/main/runtime/stream-binding-manager.ts',
  'src/main/runtime/tap-manager.ts',
  'src/main/adf/adf-workspace.ts',
  'src/main/runtime/agent-executor.ts',
  'src/main/tools/tool-registry.ts',
])

/** Thin wrappers around emitUmbilicalEvent whose first arg is the event type. */
const WRAPPER_EMITTERS: Array<{ file: string; pattern: RegExp }> = [
  { file: 'src/main/runtime/stream-binding-manager.ts', pattern: /this\.emit\(\s*'([^']+)'/g },
  { file: 'src/main/runtime/tap-manager.ts', pattern: /emitTapLifecycle\(\s*'([^']+)'/g },
]

/**
 * Wrappers whose first argument is the event type but may be a ternary of
 * literals. Scanned with the same balanced-paren reader used for direct calls,
 * so `cond ? 'a.x' : 'a.y'` contributes BOTH branches.
 */
const WRAPPER_CALLS: Array<{ file: string; callee: string }> = [
  { file: 'src/main/adf/adf-workspace.ts', callee: 'this.emitUmbilical(' },
  { file: 'src/main/runtime/agent-executor.ts', callee: 'this.emitRuntimeEvent(' },
  { file: 'src/main/tools/tool-registry.ts', callee: 'ToolRegistry.emitToolEvent(' },
]

interface Finding {
  file: string
  eventType: string
}

function walkTypeScriptFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry)
    const st = statSync(abs)
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue
      walkTypeScriptFiles(abs, out)
    } else if (st.isFile() && (abs.endsWith('.ts') || abs.endsWith('.tsx'))) {
      out.push(abs)
    }
  }
  return out
}

function relPath(abs: string): string {
  return relative(REPO_ROOT, abs).split(sep).join('/')
}

/** Extract the balanced `(...)` argument text starting at `openParen`. */
function readCallArgs(content: string, openParen: number): string {
  let depth = 0
  for (let i = openParen; i < content.length; i += 1) {
    const ch = content[i]
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) return content.slice(openParen + 1, i)
    }
  }
  return content.slice(openParen + 1)
}

/** The `event_type:` value expression within a call-args blob, if present. */
function readEventTypeExpression(args: string): string | null {
  const match = /\bevent_type\s*:/.exec(args)
  if (!match) return null
  const start = match.index + match[0].length
  let depth = 0
  for (let i = start; i < args.length; i += 1) {
    const ch = args[i]
    if (ch === '(' || ch === '[' || ch === '{') depth += 1
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1
    else if (ch === ',' && depth === 0) return args.slice(start, i)
  }
  return args.slice(start)
}

/** The text of the first argument in a call-args blob. */
function readFirstArgument(args: string): string {
  let depth = 0
  for (let i = 0; i < args.length; i += 1) {
    const ch = args[i]
    if (ch === '(' || ch === '[' || ch === '{') depth += 1
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1
    else if (ch === ',' && depth === 0) return args.slice(0, i)
  }
  return args
}

/**
 * Drop the condition of `cond ? 'a' : 'b'` so literals compared against inside
 * the condition (`stop_reason === 'error' ? ...`) are not mistaken for event
 * types. Only the branches carry event types.
 */
function stripTernaryCondition(expr: string): string {
  for (let i = 0; i < expr.length; i += 1) {
    if (expr[i] !== '?') continue
    if (expr[i + 1] === '?' || expr[i + 1] === '.') { i += 1; continue }
    return expr.slice(i + 1)
  }
  return expr
}

function scanEmitCallSites(): { literals: Finding[]; dynamic: string[] } {
  const literals: Finding[] = []
  const dynamic: string[] = []

  for (const abs of walkTypeScriptFiles(MAIN_ROOT)) {
    const rel = relPath(abs)
    if (rel === 'src/main/runtime/emit-umbilical.ts') continue
    const content = readFileSync(abs, 'utf-8')

    let cursor = 0
    for (;;) {
      const idx = content.indexOf('emitUmbilicalEvent(', cursor)
      if (idx === -1) break
      const openParen = idx + 'emitUmbilicalEvent'.length
      const args = readCallArgs(content, openParen)
      cursor = openParen + Math.max(args.length, 1)

      const expr = readEventTypeExpression(args)
      const found = expr
        ? [...stripTernaryCondition(expr).matchAll(/'([^']*)'|"([^"]*)"/g)].map(m => m[1] ?? m[2])
        : []

      if (found.length === 0) dynamic.push(rel)
      else for (const eventType of found) literals.push({ file: rel, eventType })
    }
  }

  for (const wrapper of WRAPPER_EMITTERS) {
    const content = readFileSync(join(REPO_ROOT, wrapper.file), 'utf-8')
    for (const match of content.matchAll(wrapper.pattern)) {
      literals.push({ file: wrapper.file, eventType: match[1] })
    }
  }

  for (const wrapper of WRAPPER_CALLS) {
    const content = readFileSync(join(REPO_ROOT, wrapper.file), 'utf-8')
    let cursor = 0
    for (;;) {
      const idx = content.indexOf(wrapper.callee, cursor)
      if (idx === -1) break
      const openParen = idx + wrapper.callee.length - 1
      const args = readCallArgs(content, openParen)
      cursor = openParen + Math.max(args.length, 1)

      const firstArg = readFirstArgument(args)
      const found = [...stripTernaryCondition(firstArg).matchAll(/'([^']*)'|"([^"]*)"/g)]
        .map(m => m[1] ?? m[2])

      if (found.length === 0) dynamic.push(wrapper.file)
      else for (const eventType of found) literals.push({ file: wrapper.file, eventType })
    }
  }

  return { literals, dynamic }
}

describe('umbilical event registry', () => {
  const { literals, dynamic } = scanEmitCallSites()

  it('finds emit call sites to check (guard is not silently vacuous)', () => {
    expect(literals.length).toBeGreaterThan(30)
  })

  it('every emitted event_type literal is declared in UMBILICAL_EVENT_TYPES', () => {
    const offenders = literals
      .filter(f => !isKnownUmbilicalEventType(f.eventType))
      .map(f => `${f.file}: "${f.eventType}"`)

    expect(
      [...new Set(offenders)],
      `Emitted event types must be declared in src/shared/types/umbilical-events.ts.\nOffenders:\n${offenders.join('\n')}`,
    ).toEqual([])
  })

  it('only allowlisted files pass a dynamic event_type to emitUmbilicalEvent', () => {
    const offenders = [...new Set(dynamic)].filter(file => !DYNAMIC_EMIT_ALLOWLIST.has(file))
    expect(
      offenders,
      `Dynamic event_type expressions must be allowlisted in this test.\nOffenders:\n${offenders.join('\n')}`,
    ).toEqual([])
  })

  it('registry has no duplicates and never declares custom.*', () => {
    expect(new Set(UMBILICAL_EVENT_TYPES).size).toBe(UMBILICAL_EVENT_TYPES.length)
    expect(UMBILICAL_EVENT_TYPES.filter(t => t.startsWith('custom.'))).toEqual([])
  })

  it('isKnownUmbilicalEventType accepts custom.* and rejects junk', () => {
    expect(isKnownUmbilicalEventType('tool.completed')).toBe(true)
    expect(isKnownUmbilicalEventType('custom.order_placed')).toBe(true)
    expect(isKnownUmbilicalEventType('custom.')).toBe(false)
    expect(isKnownUmbilicalEventType('tool.exploded')).toBe(false)
    expect(isKnownUmbilicalEventType('')).toBe(false)
  })
})
