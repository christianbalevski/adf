/**
 * Shell tokenizer: string → Token[]
 *
 * Handles: |, >, >>, <, &&, ||, ;, $VAR, ${VAR}, $(cmd),
 * single/double quotes, heredocs (<<TAG...TAG), backslash escapes, # comments.
 */

export type TokenType =
  | 'word'
  | 'pipe'
  | 'redirect_out'
  | 'redirect_append'
  | 'redirect_in'
  | 'redirect_dup'   // &N after a redirect operator (2>&1, >&2)
  | 'and'
  | 'or'
  | 'semi'
  | 'amp'            // bare & (background — not supported, parser rejects it)
  | 'variable'       // $VAR, ${VAR}, ${VAR:-default}, $?
  | 'substitution'   // $(...)
  | 'single_quoted'
  | 'double_quoted'
  | 'heredoc_marker' // <<TAG
  | 'heredoc_body'   // content between markers
  | 'eof'

export interface Token {
  type: TokenType
  value: string
  /** For double_quoted tokens, the raw content before expansion */
  raw?: string
  /** For variable tokens from ${VAR<op>word}: the expansion operator ('-', ':-', …) */
  op?: string
  /** For variable tokens from ${VAR<op>word}: the default/alternate word */
  word?: string
  /** For heredoc_marker tokens: tag was quoted (<<'EOF') → body stays literal */
  quoted?: boolean
  /** No whitespace between this token and the previous one (word gluing,
   *  e.g. VAR="a b" is word `VAR=` + a glued double_quoted token) */
  glued?: boolean
}

/** Structured form of a `${...}` expansion body. */
export interface BracedExpansion {
  name: string
  op?: string
  word?: string
}

/**
 * Split `${...}` content into name + optional operator + word.
 * `VAR` → {name}; `VAR:-x` → {name, op:':-', word:'x'}; `VAR-x` → {name, op:'-', word:'x'}.
 * Unknown operators are carried through so the parser can reject them with a
 * clear error. Content that doesn't start with a valid name is kept whole as
 * the name (legacy behavior — resolves to '').
 */
export function parseBracedExpansion(content: string): BracedExpansion {
  const m = content.match(/^([A-Za-z_][A-Za-z0-9_]*|\?)/)
  if (!m) return { name: content }
  const name = m[1]
  const rest = content.slice(name.length)
  if (!rest) return { name }
  const opMatch = rest.match(/^(:?[-=?+])/) ?? rest.match(/^(##|%%|[#%/^,])/)
  if (opMatch) return { name, op: opMatch[1], word: rest.slice(opMatch[1].length) }
  return { name: content }
}

export function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const len = input.length

  // End position (exclusive) of the previously emitted word-like token, used
  // to mark glued tokens (no intervening whitespace/operator) so the parser
  // can join `VAR=` + `"a b"` into one assignment.
  let lastEnd = -1

  // Collect heredoc markers to resolve after tokenizing each line
  const heredocMarkers: string[] = []
  let heredocPending = false

  while (i < len) {
    const startPos = i
    const ch = input[i]

    // Skip whitespace
    if (ch === ' ' || ch === '\t') {
      i++
      continue
    }

    // Skip comments
    if (ch === '#') {
      while (i < len && input[i] !== '\n') i++
      continue
    }

    // Newlines: treat as semicolons for script support
    if (ch === '\n') {
      // Check for pending heredoc body
      if (heredocPending && heredocMarkers.length > 0) {
        const marker = heredocMarkers.shift()!
        const bodyStart = i + 1
        const endPattern = '\n' + marker
        let bodyEnd = input.indexOf(endPattern, bodyStart)
        if (bodyEnd === -1) {
          // Marker at end of input without trailing newline
          const altEnd = input.indexOf(marker, bodyStart)
          if (altEnd !== -1 && (altEnd === bodyStart || input[altEnd - 1] === '\n')) {
            bodyEnd = altEnd - 1
            tokens.push({ type: 'heredoc_body', value: input.slice(bodyStart, bodyEnd < bodyStart ? bodyStart : bodyEnd) })
            i = altEnd + marker.length
          } else {
            // Unterminated heredoc — take rest
            tokens.push({ type: 'heredoc_body', value: input.slice(bodyStart) })
            i = len
          }
        } else {
          tokens.push({ type: 'heredoc_body', value: input.slice(bodyStart, bodyEnd) })
          i = bodyEnd + endPattern.length
        }
        if (heredocMarkers.length === 0) heredocPending = false
        continue
      }
      // Otherwise treat newline as semicolon (& already separates commands)
      const last = tokens[tokens.length - 1]
      if (tokens.length > 0 && last.type !== 'semi' && last.type !== 'amp') {
        tokens.push({ type: 'semi', value: ';' })
      }
      i++
      continue
    }

    // Two-char operators
    if (i + 1 < len) {
      const two = input[i] + input[i + 1]
      if (two === '&&') { tokens.push({ type: 'and', value: '&&' }); i += 2; continue }
      if (two === '||') { tokens.push({ type: 'or', value: '||' }); i += 2; continue }
      if (two === '>>') {
        tokens.push({ type: 'redirect_append', value: '>>', ...(startPos === lastEnd ? { glued: true } : {}) })
        i += 2
        continue
      }
      if (two === '<<') {
        // Heredoc marker
        i += 2
        // Skip optional quotes around tag
        let quoteChar = ''
        if (i < len && (input[i] === "'" || input[i] === '"')) {
          quoteChar = input[i]
          i++
        }
        let tag = ''
        while (i < len && input[i] !== ' ' && input[i] !== '\t' && input[i] !== '\n' && input[i] !== quoteChar) {
          tag += input[i]
          i++
        }
        if (quoteChar && i < len && input[i] === quoteChar) i++
        tokens.push({ type: 'heredoc_marker', value: tag, ...(quoteChar ? { quoted: true } : {}) })
        heredocMarkers.push(tag)
        heredocPending = true
        continue
      }
    }

    // Single-char operators
    if (ch === '|') { tokens.push({ type: 'pipe', value: '|' }); i++; continue }
    if (ch === '>') {
      tokens.push({ type: 'redirect_out', value: '>', ...(startPos === lastEnd ? { glued: true } : {}) })
      i++
      continue
    }
    if (ch === '<') {
      tokens.push({ type: 'redirect_in', value: '<', ...(startPos === lastEnd ? { glued: true } : {}) })
      i++
      continue
    }
    if (ch === ';') { tokens.push({ type: 'semi', value: ';' }); i++; continue }

    // Bare & (not part of &&): fd duplication (2>&1, >&2) or background
    if (ch === '&') {
      // &N directly after a redirect operator is fd duplication — emit a
      // dup token the parser turns into a stream-merge redirect.
      const prev = tokens[tokens.length - 1]
      if (
        i + 1 < len && /[0-9]/.test(input[i + 1]) &&
        prev && (prev.type === 'redirect_out' || prev.type === 'redirect_append' || prev.type === 'redirect_in')
      ) {
        i++ // skip &
        let fd = ''
        while (i < len && /[0-9]/.test(input[i])) { fd += input[i]; i++ }
        tokens.push({ type: 'redirect_dup', value: fd })
        continue
      }
      // Bare & (background): not supported — kept as a token so the parser
      // rejects it with a clear error instead of silently reinterpreting it.
      tokens.push({ type: 'amp', value: '&' })
      i++
      continue
    }

    // Command substitution $(...)
    if (ch === '$' && i + 1 < len && input[i + 1] === '(') {
      i += 2 // skip $(
      let depth = 1
      let inner = ''
      while (i < len && depth > 0) {
        if (input[i] === '(') depth++
        else if (input[i] === ')') { depth--; if (depth === 0) break }
        inner += input[i]
        i++
      }
      if (i < len) i++ // skip closing )
      tokens.push({ type: 'substitution', value: inner, ...(startPos === lastEnd ? { glued: true } : {}) })
      lastEnd = i
      continue
    }

    // Variable $VAR, ${VAR}, ${VAR:-default}, $?
    if (ch === '$' && i + 1 < len) {
      const glued = startPos === lastEnd ? { glued: true } : {}
      i++ // skip $
      if (input[i] === '{') {
        i++ // skip {
        let content = ''
        while (i < len && input[i] !== '}') { content += input[i]; i++ }
        if (i < len) i++ // skip }
        const exp = parseBracedExpansion(content)
        tokens.push({
          type: 'variable', value: exp.name,
          ...(exp.op !== undefined ? { op: exp.op, word: exp.word ?? '' } : {}),
          ...glued,
        })
      } else if (input[i] === '?') {
        i++
        tokens.push({ type: 'variable', value: '?', ...glued })
      } else {
        let name = ''
        while (i < len && /[a-zA-Z0-9_]/.test(input[i])) { name += input[i]; i++ }
        if (name) {
          tokens.push({ type: 'variable', value: name, ...glued })
        } else {
          tokens.push({ type: 'word', value: '$', ...glued })
        }
      }
      lastEnd = i
      continue
    }

    // Single-quoted string
    if (ch === "'") {
      i++ // skip opening quote
      let val = ''
      while (i < len && input[i] !== "'") { val += input[i]; i++ }
      if (i < len) i++ // skip closing quote
      tokens.push({ type: 'single_quoted', value: val, ...(startPos === lastEnd ? { glued: true } : {}) })
      lastEnd = i
      continue
    }

    // Double-quoted string (may contain $VAR, ${VAR}, $(cmd))
    if (ch === '"') {
      i++ // skip opening quote
      let raw = ''
      while (i < len && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < len) {
          const next = input[i + 1]
          // Only \", \\, \$, \` are real escapes inside double quotes
          if (next === '"' || next === '\\' || next === '$' || next === '`') {
            raw += next
          } else {
            raw += '\\' + next
          }
          i += 2
        } else {
          raw += input[i]
          i++
        }
      }
      if (i < len) i++ // skip closing quote
      tokens.push({ type: 'double_quoted', value: raw, raw, ...(startPos === lastEnd ? { glued: true } : {}) })
      lastEnd = i
      continue
    }

    // Backslash escape outside quotes
    if (ch === '\\' && i + 1 < len) {
      i++
      // Escaped newline = line continuation, skip both
      if (input[i] === '\n') { i++; continue }
      tokens.push({ type: 'word', value: input[i], ...(startPos === lastEnd ? { glued: true } : {}) })
      i++
      lastEnd = i
      continue
    }

    // Plain word (unquoted)
    let word = ''
    while (
      i < len &&
      input[i] !== ' ' && input[i] !== '\t' && input[i] !== '\n' &&
      input[i] !== '|' && input[i] !== '>' && input[i] !== '<' &&
      input[i] !== ';' && input[i] !== '&' && input[i] !== '$' &&
      input[i] !== '"' && input[i] !== "'" && input[i] !== '#' &&
      input[i] !== '(' && input[i] !== ')'
    ) {
      if (input[i] === '\\' && i + 1 < len) {
        word += input[i + 1]
        i += 2
      } else {
        word += input[i]
        i++
      }
    }
    if (word) {
      tokens.push({ type: 'word', value: word, ...(startPos === lastEnd ? { glued: true } : {}) })
      lastEnd = i
    }

    // Safety: if nothing advanced the position, skip the character to prevent infinite loop
    if (i === startPos) {
      i++
    }
  }

  // Remove trailing semi (empty statement). A trailing & is KEPT so the
  // parser can reject background execution plainly — dropping it silently
  // ran `cmd &` in the foreground without telling anyone.
  while (tokens.length > 0 && tokens[tokens.length - 1].type === 'semi') {
    tokens.pop()
  }

  tokens.push({ type: 'eof', value: '' })
  return tokens
}
