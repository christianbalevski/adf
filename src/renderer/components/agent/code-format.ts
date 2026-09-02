/**
 * Lightweight pretty-printer for minified JS/TS that agents ship in
 * `sys_code` calls — models routinely collapse a whole script onto one
 * line, which is unreadable in the tool inspector. This is not a parser:
 * it is a bracket-aware line breaker that respects strings, template
 * literals, comments and regex literals, breaks after `;` (outside
 * `for(...)` heads), after `{` and before `}`, and puts each property of a
 * non-trivial object literal on its own line. Short `{...}` spans stay
 * inline so `{a:1}` doesn't balloon into three lines.
 */

const INLINE_BRACE_MAX = 48
const DENSE_LINE = 110

/** True when at least one line is long enough that breaking it helps. */
export function isDenseCode(code: string): boolean {
  return code.split('\n').some((line) => line.length > DENSE_LINE && /[;{]/.test(line))
}

/** Characters after which a `/` starts a regex literal instead of division. */
const REGEX_PRECEDERS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', 'return', 'typeof', 'case', 'in', 'of'])

interface Token {
  text: string
  /** Atomic spans (string/comment/regex/template) are never broken. */
  atomic: boolean
}

function tokenize(code: string): Token[] {
  const out: Token[] = []
  let i = 0
  let lastSignificant = ''
  const push = (text: string, atomic: boolean): void => {
    out.push({ text, atomic })
    if (!/^\s+$/.test(text)) lastSignificant = text
  }

  while (i < code.length) {
    const ch = code[i]
    const next = code[i + 1]

    if (ch === '/' && next === '/') {
      let j = code.indexOf('\n', i)
      if (j === -1) j = code.length
      push(code.slice(i, j), true)
      i = j
      continue
    }
    if (ch === '/' && next === '*') {
      let j = code.indexOf('*/', i + 2)
      j = j === -1 ? code.length : j + 2
      push(code.slice(i, j), true)
      i = j
      continue
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1
      while (j < code.length && code[j] !== ch && code[j] !== '\n') {
        if (code[j] === '\\') j++
        j++
      }
      push(code.slice(i, Math.min(j + 1, code.length)), true)
      i = j + 1
      continue
    }
    if (ch === '`') {
      let j = i + 1
      let depth = 0
      while (j < code.length) {
        const c = code[j]
        if (c === '\\') { j += 2; continue }
        if (depth === 0 && c === '`') break
        if (c === '$' && code[j + 1] === '{') { depth++; j += 2; continue }
        if (depth > 0 && c === '}') depth--
        j++
      }
      push(code.slice(i, Math.min(j + 1, code.length)), true)
      i = j + 1
      continue
    }
    if (ch === '/') {
      const prevWord = /[A-Za-z_$][\w$]*$/.exec(lastSignificant)?.[0] ?? lastSignificant
      if (lastSignificant === '' || REGEX_PRECEDERS.has(prevWord) || REGEX_PRECEDERS.has(lastSignificant.slice(-1))) {
        let j = i + 1
        let inClass = false
        while (j < code.length && code[j] !== '\n') {
          const c = code[j]
          if (c === '\\') { j += 2; continue }
          if (inClass) { if (c === ']') inClass = false }
          else if (c === '[') inClass = true
          else if (c === '/') break
          j++
        }
        j++
        while (j < code.length && /[a-z]/i.test(code[j])) j++
        push(code.slice(i, j), true)
        i = j
        continue
      }
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1
      while (j < code.length && /[\w$]/.test(code[j])) j++
      push(code.slice(i, j), false)
      i = j
      continue
    }
    if (/\s/.test(ch)) {
      let j = i + 1
      while (j < code.length && /\s/.test(code[j])) j++
      push(code.slice(i, j), false)
      i = j
      continue
    }
    push(ch, false)
    i++
  }
  return out
}

/** Index of the token closing the bracket opened at `open`, or -1. */
function matchClose(tokens: Token[], open: number): number {
  const pairs: Record<string, string> = { '{': '}', '(': ')', '[': ']' }
  const stack: string[] = [pairs[tokens[open].text]]
  for (let i = open + 1; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.atomic) continue
    if (pairs[t.text]) stack.push(pairs[t.text])
    else if (t.text === '}' || t.text === ')' || t.text === ']') {
      if (stack[stack.length - 1] === t.text) stack.pop()
      if (stack.length === 0) return i
    }
  }
  return -1
}

/** Should the `{...}` span be kept on one line? */
function inlineBrace(tokens: Token[], open: number, close: number): boolean {
  if (close === -1) return false
  let length = 0
  for (let i = open; i <= close; i++) {
    const t = tokens[i]
    length += t.text.length
    if (length > INLINE_BRACE_MAX) return false
    if (!t.atomic && (t.text === ';' || (i !== open && t.text === '{') || t.text.includes('\n'))) return false
  }
  return true
}

type Frame = { kind: '{' | '(' | '['; inline: boolean }

/**
 * Re-flow dense JS/TS onto multiple indented lines. Idempotent enough on
 * already-formatted code: existing newlines are preserved, runs of
 * whitespace collapse, and indentation is regenerated from bracket depth.
 */
export function prettifyCode(code: string, indentUnit = '  '): string {
  const tokens = tokenize(code)
  const stack: Frame[] = []
  let out = ''
  let atLineStart = true

  const depth = (): number => stack.filter((f) => !f.inline).length
  const newline = (): void => {
    out = out.replace(/[ \t]+$/, '')
    if (!out.endsWith('\n') && out.length > 0) out += '\n'
    atLineStart = true
  }
  const emit = (text: string): void => {
    if (atLineStart) {
      if (text.trim() === '') return
      out += indentUnit.repeat(depth())
      atLineStart = false
    }
    out += text
  }
  /** Is the enclosing frame a block-mode `{`? */
  const blockCtx = (): boolean => {
    const top = stack[stack.length - 1]
    return !top || (top.kind === '{' && !top.inline)
  }
  const nextSignificant = (from: number): string => {
    for (let i = from; i < tokens.length; i++) {
      if (!/^\s+$/.test(tokens[i].text)) return tokens[i].text
    }
    return ''
  }

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.atomic) {
      emit(t.text)
      if (t.text.startsWith('//')) newline()
      continue
    }
    const text = t.text

    if (/^\s+$/.test(text)) {
      if (text.includes('\n')) newline()
      else if (!atLineStart && !out.endsWith(' ')) out += ' '
      continue
    }

    if (text === '{' || text === '(' || text === '[') {
      const inline = text === '{' ? inlineBrace(tokens, i, matchClose(tokens, i)) : true
      emit(text)
      stack.push({ kind: text, inline })
      if (text === '{' && !inline) newline()
      continue
    }

    if (text === '}' || text === ')' || text === ']') {
      const top = stack[stack.length - 1]
      const closesBlock = text === '}' && top?.kind === '{' && !top.inline
      if (top && top.kind === text.replace(')', '(').replace(']', '[').replace('}', '{')) stack.pop()
      if (closesBlock) newline()
      emit(text)
      if (closesBlock) {
        const after = nextSignificant(i + 1)
        // `}` followed by continuation (`)`, `,`, `;`, `.`, `else`, `catch`…) stays glued.
        if (!/^[),;.\]:?]|^(else|catch|finally|while)$/.test(after) && after !== '') newline()
      }
      continue
    }

    if (text === ';') {
      emit(text)
      // `for (a; b; c)` — no breaks inside a paren head.
      if (stack.every((f) => f.kind !== '(')) newline()
      else if (nextSignificant(i + 1) !== ')') out += ' '
      continue
    }

    if (text === ',') {
      emit(text)
      if (blockCtx()) newline()
      else out += ' '
      continue
    }

    emit(text)
    if (text === 'else' || text === 'return' || text === 'const' || text === 'let' || text === 'var' || text === 'await' || text === 'new' || text === 'typeof') {
      const after = nextSignificant(i + 1)
      if (after && /^[\w$'"`{([!]/.test(after) && !tokens[i + 1]?.text.startsWith(' ')) out += ' '
    }
  }
  return out.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim()
}

/** Prettify only when the code is dense; otherwise return it untouched. */
export function formatCodeForDisplay(code: string): string {
  const trimmed = code.trim()
  return isDenseCode(trimmed) ? prettifyCode(trimmed) : trimmed
}
