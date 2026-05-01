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
  | 'and'
  | 'or'
  | 'semi'
  | 'variable'       // $VAR or ${VAR}
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
}

export function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const len = input.length

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
      // Otherwise treat newline as semicolon
      if (tokens.length > 0 && tokens[tokens.length - 1].type !== 'semi') {
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
      if (two === '>>') { tokens.push({ type: 'redirect_append', value: '>>' }); i += 2; continue }
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
        tokens.push({ type: 'heredoc_marker', value: tag })
        heredocMarkers.push(tag)
        heredocPending = true
        continue
      }
    }

    // Single-char operators
    if (ch === '|') { tokens.push({ type: 'pipe', value: '|' }); i++; continue }
    if (ch === '>') { tokens.push({ type: 'redirect_out', value: '>' }); i++; continue }
    if (ch === '<') { tokens.push({ type: 'redirect_in', value: '<' }); i++; continue }
    if (ch === ';') { tokens.push({ type: 'semi', value: ';' }); i++; continue }

    // Bare & (not part of &&): handle fd redirects like 2>&1 or treat as semicolon
    if (ch === '&') {
      // Check if previous token was redirect_out and this is &N (e.g. 2>&1)
      // Skip the &N entirely — our shell merges stderr into stdout already
      if (i + 1 < len && /[0-9]/.test(input[i + 1])) {
        i += 2 // skip &N
        continue
      }
      // Bare & at end of command: treat as semicolon (no background jobs)
      tokens.push({ type: 'semi', value: ';' })
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
      tokens.push({ type: 'substitution', value: inner })
      continue
    }

    // Variable $VAR or ${VAR}
    if (ch === '$' && i + 1 < len) {
      i++ // skip $
      if (input[i] === '{') {
        i++ // skip {
        let name = ''
        while (i < len && input[i] !== '}') { name += input[i]; i++ }
        if (i < len) i++ // skip }
        tokens.push({ type: 'variable', value: name })
      } else {
        let name = ''
        while (i < len && /[a-zA-Z0-9_]/.test(input[i])) { name += input[i]; i++ }
        if (name) {
          tokens.push({ type: 'variable', value: name })
        } else {
          tokens.push({ type: 'word', value: '$' })
        }
      }
      continue
    }

    // Single-quoted string
    if (ch === "'") {
      i++ // skip opening quote
      let val = ''
      while (i < len && input[i] !== "'") { val += input[i]; i++ }
      if (i < len) i++ // skip closing quote
      tokens.push({ type: 'single_quoted', value: val })
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
      tokens.push({ type: 'double_quoted', value: raw, raw })
      continue
    }

    // Backslash escape outside quotes
    if (ch === '\\' && i + 1 < len) {
      i++
      // Escaped newline = line continuation, skip both
      if (input[i] === '\n') { i++; continue }
      tokens.push({ type: 'word', value: input[i] })
      i++
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
      tokens.push({ type: 'word', value: word })
    }

    // Safety: if nothing advanced the position, skip the character to prevent infinite loop
    if (i === startPos) {
      i++
    }
  }

  // Remove trailing semi
  while (tokens.length > 0 && tokens[tokens.length - 1].type === 'semi') {
    tokens.pop()
  }

  tokens.push({ type: 'eof', value: '' })
  return tokens
}
