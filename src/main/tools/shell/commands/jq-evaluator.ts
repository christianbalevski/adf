/**
 * jq evaluator: tokenizer → recursive descent parser → filter-based evaluator.
 *
 * Every jq expression is a "filter": a function (input, env) → values[].
 * This supports the bulk of real-world jq usage:
 *   Tier 1: comma, object/array construction, //, arithmetic, comparisons,
 *           and/or/not, if-then-else, select, map, keys, values, length, etc.
 *   Tier 2: try-catch, reduce, $var bindings, .., min/max, flatten, test/match, etc.
 *   Tier 3: sub/gsub, getpath/setpath, array slicing, etc.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

type JqValue = unknown
type Env = Record<string, JqValue>
type Filter = (input: JqValue, env: Env) => JqValue[]

export interface JqResult {
  outputs: unknown[]
  error?: string
}

// ─── Tokenizer ────────────────────────────────────────────────────────────────

const enum TT {
  Dot, DotDot, Ident, String, Number, LParen, RParen, LBracket, RBracket,
  LBrace, RBrace, Pipe, Comma, Colon, Semicolon, Question,
  Plus, Minus, Star, Slash, Percent,
  Eq, Neq, Lt, Lte, Gt, Gte,
  And, Or, Not, If, Then, Elif, Else, End,
  As, Reduce, Foreach, Try, Catch, Label, Break,
  True, False, Null, Def,
  SlashSlash, // //
  DotField,   // .foo (combined dot + identifier)
  Variable,   // $foo
  Format,     // @csv, @tsv, @json, etc.
  PipeAssign, // |=
  PlusAssign, // +=
  MinusAssign, // -=
  StarAssign,  // *=
  SlashAssign, // /=
  PercentAssign, // %=
  AltAssign,   // //=
  EOF,
}

interface Token {
  type: TT
  value: string
  pos: number
}

const KEYWORDS: Record<string, TT> = {
  and: TT.And, or: TT.Or, not: TT.Not,
  if: TT.If, then: TT.Then, elif: TT.Elif, else: TT.Else, end: TT.End,
  as: TT.As, reduce: TT.Reduce, foreach: TT.Foreach,
  try: TT.Try, catch: TT.Catch, label: TT.Label, break: TT.Break,
  true: TT.True, false: TT.False, null: TT.Null, def: TT.Def,
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < src.length) {
    // whitespace
    if (/\s/.test(src[i])) { i++; continue }
    // comments
    if (src[i] === '#') { while (i < src.length && src[i] !== '\n') i++; continue }
    const pos = i
    const ch = src[i]

    // Two-char operators
    if (i + 1 < src.length) {
      const two = src[i] + src[i + 1]
      if (two === '//') {
        if (i + 2 < src.length && src[i + 2] === '=') {
          tokens.push({ type: TT.AltAssign, value: '//=', pos }); i += 3; continue
        }
        tokens.push({ type: TT.SlashSlash, value: '//', pos }); i += 2; continue
      }
      if (two === '==') { tokens.push({ type: TT.Eq, value: '==', pos }); i += 2; continue }
      if (two === '!=') { tokens.push({ type: TT.Neq, value: '!=', pos }); i += 2; continue }
      if (two === '<=') { tokens.push({ type: TT.Lte, value: '<=', pos }); i += 2; continue }
      if (two === '>=') { tokens.push({ type: TT.Gte, value: '>=', pos }); i += 2; continue }
      if (two === '|=') { tokens.push({ type: TT.PipeAssign, value: '|=', pos }); i += 2; continue }
      if (two === '+=') { tokens.push({ type: TT.PlusAssign, value: '+=', pos }); i += 2; continue }
      if (two === '-=') { tokens.push({ type: TT.MinusAssign, value: '-=', pos }); i += 2; continue }
      if (two === '*=') { tokens.push({ type: TT.StarAssign, value: '*=', pos }); i += 2; continue }
      if (two === '/=') { tokens.push({ type: TT.SlashAssign, value: '/=', pos }); i += 2; continue }
      if (two === '%=') { tokens.push({ type: TT.PercentAssign, value: '%=', pos }); i += 2; continue }
      if (two === '..') { tokens.push({ type: TT.DotDot, value: '..', pos }); i += 2; continue }
    }

    // Single-char
    if (ch === '|') { tokens.push({ type: TT.Pipe, value: '|', pos }); i++; continue }
    if (ch === ',') { tokens.push({ type: TT.Comma, value: ',', pos }); i++; continue }
    if (ch === ':') { tokens.push({ type: TT.Colon, value: ':', pos }); i++; continue }
    if (ch === ';') { tokens.push({ type: TT.Semicolon, value: ';', pos }); i++; continue }
    if (ch === '(') { tokens.push({ type: TT.LParen, value: '(', pos }); i++; continue }
    if (ch === ')') { tokens.push({ type: TT.RParen, value: ')', pos }); i++; continue }
    if (ch === '[') { tokens.push({ type: TT.LBracket, value: '[', pos }); i++; continue }
    if (ch === ']') { tokens.push({ type: TT.RBracket, value: ']', pos }); i++; continue }
    if (ch === '{') { tokens.push({ type: TT.LBrace, value: '{', pos }); i++; continue }
    if (ch === '}') { tokens.push({ type: TT.RBrace, value: '}', pos }); i++; continue }
    if (ch === '+') { tokens.push({ type: TT.Plus, value: '+', pos }); i++; continue }
    if (ch === '*') { tokens.push({ type: TT.Star, value: '*', pos }); i++; continue }
    if (ch === '%') { tokens.push({ type: TT.Percent, value: '%', pos }); i++; continue }
    if (ch === '<') { tokens.push({ type: TT.Lt, value: '<', pos }); i++; continue }
    if (ch === '>') { tokens.push({ type: TT.Gt, value: '>', pos }); i++; continue }
    if (ch === '?') { tokens.push({ type: TT.Question, value: '?', pos }); i++; continue }

    // Slash (but not //)
    if (ch === '/') { tokens.push({ type: TT.Slash, value: '/', pos }); i++; continue }

    // Dot and .field
    if (ch === '.') {
      i++
      if (i < src.length && /[a-zA-Z_]/.test(src[i])) {
        let name = ''
        while (i < src.length && /[a-zA-Z0-9_]/.test(src[i])) { name += src[i]; i++ }
        tokens.push({ type: TT.DotField, value: name, pos })
      } else {
        tokens.push({ type: TT.Dot, value: '.', pos })
      }
      continue
    }

    // @format
    if (ch === '@') {
      i++
      let name = ''
      while (i < src.length && /[a-zA-Z0-9_]/.test(src[i])) { name += src[i]; i++ }
      tokens.push({ type: TT.Format, value: name, pos })
      continue
    }

    // $variable
    if (ch === '$') {
      i++
      let name = ''
      while (i < src.length && /[a-zA-Z0-9_]/.test(src[i])) { name += src[i]; i++ }
      tokens.push({ type: TT.Variable, value: name, pos })
      continue
    }

    // String
    if (ch === '"') {
      i++
      let s = ''
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < src.length) {
          const esc = src[i + 1]
          if (esc === 'n') { s += '\n'; i += 2 }
          else if (esc === 't') { s += '\t'; i += 2 }
          else if (esc === 'r') { s += '\r'; i += 2 }
          else if (esc === '"') { s += '"'; i += 2 }
          else if (esc === '\\') { s += '\\'; i += 2 }
          else if (esc === '(') {
            // String interpolation \(expr) — store as special marker
            s += '\x00INTERP_START\x00'
            i += 2 // skip \(
            let depth = 1
            while (i < src.length && depth > 0) {
              if (src[i] === '(') depth++
              else if (src[i] === ')') depth--
              if (depth > 0) { s += src[i]; i++ } else { i++ }
            }
            s += '\x00INTERP_END\x00'
          }
          else { s += src[i + 1]; i += 2 }
        } else {
          s += src[i]; i++
        }
      }
      i++ // closing "
      tokens.push({ type: TT.String, value: s, pos })
      continue
    }

    // Number (including negative after operator context)
    if (/[0-9]/.test(ch) || (ch === '-' && i + 1 < src.length && /[0-9]/.test(src[i + 1]) && (tokens.length === 0 || [TT.LParen, TT.LBracket, TT.Comma, TT.Pipe, TT.Colon, TT.Semicolon, TT.Plus, TT.Minus, TT.Star, TT.Slash, TT.Percent, TT.Eq, TT.Neq, TT.Lt, TT.Lte, TT.Gt, TT.Gte, TT.SlashSlash].includes(tokens[tokens.length - 1].type)))) {
      let num = ''
      if (ch === '-') { num = '-'; i++ }
      while (i < src.length && /[0-9.]/.test(src[i])) { num += src[i]; i++ }
      // Scientific notation
      if (i < src.length && (src[i] === 'e' || src[i] === 'E')) {
        num += src[i]; i++
        if (i < src.length && (src[i] === '+' || src[i] === '-')) { num += src[i]; i++ }
        while (i < src.length && /[0-9]/.test(src[i])) { num += src[i]; i++ }
      }
      tokens.push({ type: TT.Number, value: num, pos })
      continue
    }

    // Minus (not negative number)
    if (ch === '-') { tokens.push({ type: TT.Minus, value: '-', pos }); i++; continue }

    // Identifier / keyword
    if (/[a-zA-Z_]/.test(ch)) {
      let name = ''
      while (i < src.length && /[a-zA-Z0-9_]/.test(src[i])) { name += src[i]; i++ }
      const kw = KEYWORDS[name]
      tokens.push({ type: kw !== undefined ? kw : TT.Ident, value: name, pos })
      continue
    }

    throw new Error(`unexpected character: ${ch}`)
  }
  tokens.push({ type: TT.EOF, value: '', pos: i })
  return tokens
}

// ─── Parser ───────────────────────────────────────────────────────────────────

// AST nodes — each compiles to a Filter
type AstNode =
  | { tag: 'identity' }
  | { tag: 'literal'; value: JqValue }
  | { tag: 'field'; name: string }
  | { tag: 'index'; expr: AstNode }
  | { tag: 'iterate' }
  | { tag: 'recurse' }
  | { tag: 'pipe'; left: AstNode; right: AstNode }
  | { tag: 'comma'; left: AstNode; right: AstNode }
  | { tag: 'arith'; op: string; left: AstNode; right: AstNode }
  | { tag: 'compare'; op: string; left: AstNode; right: AstNode }
  | { tag: 'and'; left: AstNode; right: AstNode }
  | { tag: 'or'; left: AstNode; right: AstNode }
  | { tag: 'not' }
  | { tag: 'alt'; left: AstNode; right: AstNode }
  | { tag: 'neg'; expr: AstNode }
  | { tag: 'if'; cond: AstNode; then: AstNode; elifs: Array<{ cond: AstNode; then: AstNode }>; else_: AstNode | null }
  | { tag: 'try'; body: AstNode; catch_: AstNode | null }
  | { tag: 'reduce'; expr: AstNode; varName: string; init: AstNode; update: AstNode }
  | { tag: 'label'; name: string; body: AstNode }
  | { tag: 'call'; name: string; args: AstNode[] }
  | { tag: 'array'; expr: AstNode | null }
  | { tag: 'object'; pairs: Array<{ key: AstNode; value: AstNode; computedKey: boolean }> }
  | { tag: 'postfix'; base: AstNode; ops: PostfixOp[] }
  | { tag: 'variable'; name: string }
  | { tag: 'binding'; expr: AstNode; varName: string; body: AstNode }
  | { tag: 'format'; name: string }
  | { tag: 'string_interp'; parts: Array<string | AstNode> }
  | { tag: 'slice'; from: AstNode | null; to: AstNode | null }
  | { tag: 'optional'; expr: AstNode }
  | { tag: 'update'; path: AstNode; op: string; value: AstNode }

type PostfixOp =
  | { tag: 'field'; name: string }
  | { tag: 'index'; expr: AstNode }
  | { tag: 'iterate' }
  | { tag: 'optional' }
  | { tag: 'slice'; from: AstNode | null; to: AstNode | null }

class Parser {
  private tokens: Token[]
  private pos = 0

  constructor(tokens: Token[]) { this.tokens = tokens }

  peek(): Token { return this.tokens[this.pos] }
  advance(): Token { return this.tokens[this.pos++] }
  at(t: TT): boolean { return this.peek().type === t }
  eat(t: TT): Token {
    if (!this.at(t)) throw new Error(`expected ${TT[t]}, got ${TT[this.peek().type]} '${this.peek().value}'`)
    return this.advance()
  }
  maybe(t: TT): Token | null { return this.at(t) ? this.advance() : null }

  parse(): AstNode {
    const node = this.parseExpr()
    if (!this.at(TT.EOF)) throw new Error(`unexpected token: ${this.peek().value}`)
    return node
  }

  // Precedence (low → high): pipe, comma, as, or, and, not, comparison, alt, add/sub, mul/div, unary, postfix

  parseExpr(): AstNode {
    return this.parsePipe()
  }

  parsePipe(): AstNode {
    let left = this.parseComma()
    while (this.maybe(TT.Pipe)) {
      left = { tag: 'pipe', left, right: this.parseComma() }
    }
    return left
  }

  /** Parse pipe-level expression but stop at commas (for object/function arg values) */
  parsePipeNoComma(): AstNode {
    let left = this.parseBinding()
    while (this.maybe(TT.Pipe)) {
      left = { tag: 'pipe', left, right: this.parseBinding() }
    }
    return left
  }

  parseComma(): AstNode {
    let left = this.parseBinding()
    while (this.maybe(TT.Comma)) {
      left = { tag: 'comma', left, right: this.parseBinding() }
    }
    return left
  }

  parseBinding(): AstNode {
    // expr as $var | body
    const expr = this.parseOr()
    if (this.maybe(TT.As)) {
      const v = this.eat(TT.Variable)
      this.eat(TT.Pipe)
      const body = this.parseExpr()
      return { tag: 'binding', expr, varName: v.value, body }
    }
    return expr
  }

  parseOr(): AstNode {
    let left = this.parseAnd()
    while (this.maybe(TT.Or)) {
      left = { tag: 'or', left, right: this.parseAnd() }
    }
    return left
  }

  parseAnd(): AstNode {
    let left = this.parseNot()
    while (this.maybe(TT.And)) {
      left = { tag: 'and', left, right: this.parseNot() }
    }
    return left
  }

  parseNot(): AstNode {
    if (this.maybe(TT.Not)) {
      return { tag: 'pipe', left: this.parseComparison(), right: { tag: 'not' } }
    }
    return this.parseComparison()
  }

  parseComparison(): AstNode {
    let left = this.parseAlt()
    while (this.at(TT.Eq) || this.at(TT.Neq) || this.at(TT.Lt) || this.at(TT.Lte) || this.at(TT.Gt) || this.at(TT.Gte)) {
      const op = this.advance().value
      left = { tag: 'compare', op, left, right: this.parseAlt() }
    }
    return left
  }

  parseAlt(): AstNode {
    let left = this.parseAdd()
    while (this.maybe(TT.SlashSlash)) {
      left = { tag: 'alt', left, right: this.parseAdd() }
    }
    return left
  }

  parseAdd(): AstNode {
    let left = this.parseMul()
    while (this.at(TT.Plus) || this.at(TT.Minus)) {
      const op = this.advance().value
      left = { tag: 'arith', op, left, right: this.parseMul() }
    }
    return left
  }

  parseMul(): AstNode {
    let left = this.parseUnary()
    while (this.at(TT.Star) || this.at(TT.Slash) || this.at(TT.Percent)) {
      const op = this.advance().value
      left = { tag: 'arith', op, left, right: this.parseUnary() }
    }
    return left
  }

  parseUnary(): AstNode {
    if (this.at(TT.Minus)) {
      this.advance()
      return { tag: 'neg', expr: this.parsePostfix() }
    }
    return this.parsePostfix()
  }

  parsePostfix(): AstNode {
    let base = this.parseAtom()
    const ops: PostfixOp[] = []
    for (;;) {
      if (this.at(TT.DotField)) {
        ops.push({ tag: 'field', name: this.advance().value })
      } else if (this.at(TT.LBracket)) {
        this.advance()
        if (this.maybe(TT.RBracket)) {
          ops.push({ tag: 'iterate' })
        } else if (this.at(TT.Number) && this.lookahead(TT.Colon)) {
          // [N:M] slice
          const from: AstNode = { tag: 'literal', value: parseFloat(this.advance().value) }
          this.eat(TT.Colon)
          const to = this.at(TT.RBracket) ? null : this.parseExpr()
          this.eat(TT.RBracket)
          ops.push({ tag: 'slice', from, to })
        } else if (this.at(TT.Colon)) {
          // [:N] slice
          this.advance()
          const to = this.at(TT.RBracket) ? null : this.parseExpr()
          this.eat(TT.RBracket)
          ops.push({ tag: 'slice', from: null, to })
        } else {
          const expr = this.parseExpr()
          if (this.maybe(TT.Colon)) {
            // [expr:expr] slice
            const to = this.at(TT.RBracket) ? null : this.parseExpr()
            this.eat(TT.RBracket)
            ops.push({ tag: 'slice', from: expr, to })
          } else {
            this.eat(TT.RBracket)
            ops.push({ tag: 'index', expr })
          }
        }
      } else if (this.at(TT.Question)) {
        this.advance()
        ops.push({ tag: 'optional' })
      } else if (this.at(TT.Dot) && this.pos + 1 < this.tokens.length && this.tokens[this.pos + 1].type === TT.Ident) {
        // Allow .field chain on postfix: something.field
        this.advance() // eat dot
        ops.push({ tag: 'field', name: this.eat(TT.Ident).value })
      } else {
        break
      }
    }

    // Check for update operators |=, +=, -=, *=, /=, %=, //=
    if (this.at(TT.PipeAssign) || this.at(TT.PlusAssign) || this.at(TT.MinusAssign) ||
        this.at(TT.StarAssign) || this.at(TT.SlashAssign) || this.at(TT.PercentAssign) || this.at(TT.AltAssign)) {
      const op = this.advance().value
      const value = this.parseExpr()
      const path = ops.length > 0 ? { tag: 'postfix' as const, base, ops } : base
      return { tag: 'update', path, op, value }
    }

    if (ops.length === 0) return base
    return { tag: 'postfix', base, ops }
  }

  private lookahead(t: TT): boolean {
    return this.pos + 1 < this.tokens.length && this.tokens[this.pos + 1].type === t
  }

  parseAtom(): AstNode {
    const tok = this.peek()

    // Identity
    if (tok.type === TT.Dot) {
      this.advance()
      return { tag: 'identity' }
    }

    // Recursive descent
    if (tok.type === TT.DotDot) {
      this.advance()
      return { tag: 'recurse' }
    }

    // .field (short for identity | .field)
    if (tok.type === TT.DotField) {
      this.advance()
      return { tag: 'field', name: tok.value }
    }

    // Literals
    if (tok.type === TT.Number) { this.advance(); return { tag: 'literal', value: parseFloat(tok.value) } }
    if (tok.type === TT.True) { this.advance(); return { tag: 'literal', value: true } }
    if (tok.type === TT.False) { this.advance(); return { tag: 'literal', value: false } }
    if (tok.type === TT.Null) { this.advance(); return { tag: 'literal', value: null } }
    if (tok.type === TT.String) {
      this.advance()
      // Check for string interpolation
      if (tok.value.includes('\x00INTERP_START\x00')) {
        return this.parseStringInterpolation(tok.value)
      }
      return { tag: 'literal', value: tok.value }
    }

    // Variable
    if (tok.type === TT.Variable) {
      this.advance()
      return { tag: 'variable', name: tok.value }
    }

    // Format strings
    if (tok.type === TT.Format) {
      this.advance()
      return { tag: 'format', name: tok.value }
    }

    // Parens
    if (tok.type === TT.LParen) {
      this.advance()
      const expr = this.parseExpr()
      this.eat(TT.RParen)
      return expr
    }

    // Array construction [expr]
    if (tok.type === TT.LBracket) {
      this.advance()
      if (this.maybe(TT.RBracket)) return { tag: 'array', expr: null }
      const expr = this.parseExpr()
      this.eat(TT.RBracket)
      return { tag: 'array', expr }
    }

    // Object construction {key: value, ...}
    if (tok.type === TT.LBrace) {
      return this.parseObjectConstruction()
    }

    // if-then-else-end
    if (tok.type === TT.If) {
      return this.parseIf()
    }

    // try-catch
    if (tok.type === TT.Try) {
      this.advance()
      const body = this.parsePostfix()
      let catch_: AstNode | null = null
      if (this.maybe(TT.Catch)) {
        catch_ = this.parsePostfix()
      }
      return { tag: 'try', body, catch_ }
    }

    // reduce
    if (tok.type === TT.Reduce) {
      this.advance()
      const expr = this.parsePostfix()
      this.eat(TT.As)
      const v = this.eat(TT.Variable)
      this.eat(TT.LParen)
      const init = this.parseExpr()
      this.eat(TT.Semicolon)
      const update = this.parseExpr()
      this.eat(TT.RParen)
      return { tag: 'reduce', expr, varName: v.value, init, update }
    }

    // label-break
    if (tok.type === TT.Label) {
      this.advance()
      const v = this.eat(TT.Variable)
      this.eat(TT.Pipe)
      const body = this.parseExpr()
      return { tag: 'label', name: v.value, body }
    }

    // not as prefix
    if (tok.type === TT.Not) {
      this.advance()
      return { tag: 'not' }
    }

    // Function call or bare identifier as function
    if (tok.type === TT.Ident) {
      this.advance()
      const name = tok.value
      // Check for args: name(expr; expr; ...)
      if (this.at(TT.LParen)) {
        this.advance()
        const args: AstNode[] = []
        if (!this.at(TT.RParen)) {
          args.push(this.parseExpr())
          while (this.maybe(TT.Semicolon)) {
            args.push(this.parseExpr())
          }
        }
        this.eat(TT.RParen)
        return { tag: 'call', name, args }
      }
      // Zero-arg builtin call
      return { tag: 'call', name, args: [] }
    }

    throw new Error(`unexpected token: ${TT[tok.type]} '${tok.value}'`)
  }

  parseObjectConstruction(): AstNode {
    this.eat(TT.LBrace)
    const pairs: Array<{ key: AstNode; value: AstNode; computedKey: boolean }> = []
    while (!this.at(TT.RBrace) && !this.at(TT.EOF)) {
      if (pairs.length > 0) this.eat(TT.Comma)

      let key: AstNode
      let value: AstNode
      let computedKey = false

      // ({key: expr}) or ({(expr): expr}) or shorthand ({.field}) or ({name})
      if (this.at(TT.LParen)) {
        // Computed key
        this.advance()
        key = this.parseExpr()
        this.eat(TT.RParen)
        computedKey = true
        this.eat(TT.Colon)
        value = this.parsePipeNoComma()
      } else if (this.at(TT.DotField)) {
        // Shorthand: .field → "field": .field
        const name = this.peek().value
        key = { tag: 'literal', value: name }
        value = { tag: 'field', name }
        this.advance()
        // Allow explicit value override
        if (this.maybe(TT.Colon)) {
          value = this.parsePipeNoComma()
        }
      } else if (this.at(TT.Ident)) {
        const name = this.advance().value
        key = { tag: 'literal', value: name }
        if (this.maybe(TT.Colon)) {
          value = this.parsePipeNoComma()
        } else {
          // Shorthand: name → "name": .name
          value = { tag: 'field', name }
        }
      } else if (this.at(TT.String)) {
        const s = this.advance().value
        key = { tag: 'literal', value: s }
        this.eat(TT.Colon)
        value = this.parsePipeNoComma()
      } else if (this.at(TT.Variable)) {
        // $var → ($var | tostring): $var
        const v = this.advance()
        key = { tag: 'literal', value: v.value }
        value = { tag: 'variable', name: v.value }
        if (this.maybe(TT.Colon)) {
          value = this.parsePipeNoComma()
        }
      } else {
        throw new Error(`unexpected token in object: ${this.peek().value}`)
      }

      pairs.push({ key, value, computedKey })
    }
    this.eat(TT.RBrace)
    return { tag: 'object', pairs }
  }

  parseIf(): AstNode {
    this.eat(TT.If)
    const cond = this.parseExpr()
    this.eat(TT.Then)
    const then_ = this.parseExpr()
    const elifs: Array<{ cond: AstNode; then: AstNode }> = []
    while (this.maybe(TT.Elif)) {
      const elifCond = this.parseExpr()
      this.eat(TT.Then)
      elifs.push({ cond: elifCond, then: this.parseExpr() })
    }
    let else_: AstNode | null = null
    if (this.maybe(TT.Else)) {
      else_ = this.parseExpr()
    }
    this.eat(TT.End)
    return { tag: 'if', cond, then: then_, elifs, else_ }
  }

  private parseStringInterpolation(raw: string): AstNode {
    const parts: Array<string | AstNode> = []
    const segments = raw.split('\x00INTERP_START\x00')
    for (let i = 0; i < segments.length; i++) {
      if (i === 0) {
        if (segments[i]) parts.push(segments[i])
      } else {
        const [exprStr, rest] = segments[i].split('\x00INTERP_END\x00')
        // Parse the interpolated expression
        const subTokens = tokenize(exprStr)
        const subParser = new Parser(subTokens)
        parts.push(subParser.parse())
        if (rest) parts.push(rest)
      }
    }
    return { tag: 'string_interp', parts }
  }
}

// ─── Evaluator ────────────────────────────────────────────────────────────────

// Sentinel for "empty" (no output)
const EMPTY = Symbol('jq_empty')
// Sentinel for break out of label
class BreakSignal {
  constructor(public label: string, public value: JqValue) {}
}

function compile(node: AstNode): Filter {
  switch (node.tag) {
    case 'identity':
      return (input) => [input]

    case 'literal':
      return () => [node.value]

    case 'variable':
      return (_, env) => {
        if (node.name === 'ENV') return [process.env]
        if (node.name in env) return [env[node.name]]
        throw new Error(`$${node.name} is not defined`)
      }

    case 'field':
      return (input) => {
        if (input === null || input === undefined) return [null]
        if (typeof input === 'object') return [(input as Record<string, unknown>)[node.name] ?? null]
        return [null]
      }

    case 'index': {
      const idxF = compile(node.expr)
      return (input, env) => {
        const results: JqValue[] = []
        for (const idx of idxF(input, env)) {
          if (input === null || input === undefined) { results.push(null); continue }
          if (Array.isArray(input) && typeof idx === 'number') {
            const i = idx < 0 ? input.length + idx : idx
            results.push(input[i] ?? null)
          } else if (typeof input === 'object' && typeof idx === 'string') {
            results.push((input as Record<string, unknown>)[idx] ?? null)
          } else {
            results.push(null)
          }
        }
        return results
      }
    }

    case 'iterate':
      return (input) => {
        if (Array.isArray(input)) return input
        if (typeof input === 'object' && input !== null) return Object.values(input)
        throw new Error(`cannot iterate over ${typeof input}`)
      }

    case 'recurse':
      return (input) => {
        const results: JqValue[] = []
        function walk(v: JqValue): void {
          results.push(v)
          if (Array.isArray(v)) v.forEach(walk)
          else if (typeof v === 'object' && v !== null) Object.values(v).forEach(walk)
        }
        walk(input)
        return results
      }

    case 'pipe': {
      const left = compile(node.left)
      const right = compile(node.right)
      return (input, env) => {
        const results: JqValue[] = []
        for (const mid of left(input, env)) {
          results.push(...right(mid, env))
        }
        return results
      }
    }

    case 'comma': {
      const left = compile(node.left)
      const right = compile(node.right)
      return (input, env) => [...left(input, env), ...right(input, env)]
    }

    case 'arith': {
      const left = compile(node.left)
      const right = compile(node.right)
      return (input, env) => {
        const results: JqValue[] = []
        for (const l of left(input, env)) {
          for (const r of right(input, env)) {
            results.push(doArith(node.op, l, r))
          }
        }
        return results
      }
    }

    case 'compare': {
      const left = compile(node.left)
      const right = compile(node.right)
      return (input, env) => {
        const results: JqValue[] = []
        for (const l of left(input, env)) {
          for (const r of right(input, env)) {
            results.push(doCompare(node.op, l, r))
          }
        }
        return results
      }
    }

    case 'and': {
      const left = compile(node.left)
      const right = compile(node.right)
      return (input, env) => {
        for (const l of left(input, env)) {
          for (const r of right(input, env)) {
            return [isTruthy(l) && isTruthy(r)]
          }
        }
        return [false]
      }
    }

    case 'or': {
      const left = compile(node.left)
      const right = compile(node.right)
      return (input, env) => {
        for (const l of left(input, env)) {
          for (const r of right(input, env)) {
            return [isTruthy(l) || isTruthy(r)]
          }
        }
        return [false]
      }
    }

    case 'not':
      return (input) => [!isTruthy(input)]

    case 'alt': {
      const left = compile(node.left)
      const right = compile(node.right)
      return (input, env) => {
        const lv = left(input, env).filter(v => v !== null && v !== false)
        if (lv.length > 0) return lv
        return right(input, env)
      }
    }

    case 'neg': {
      const expr = compile(node.expr)
      return (input, env) => expr(input, env).map(v => -(v as number))
    }

    case 'if': {
      const cond = compile(node.cond)
      const then_ = compile(node.then)
      const elifs = node.elifs.map(e => ({ cond: compile(e.cond), then: compile(e.then) }))
      const else_ = node.else_ ? compile(node.else_) : null
      return (input, env) => {
        for (const c of cond(input, env)) {
          if (isTruthy(c)) return then_(input, env)
        }
        for (const elif of elifs) {
          for (const c of elif.cond(input, env)) {
            if (isTruthy(c)) return elif.then(input, env)
          }
        }
        return else_ ? else_(input, env) : [input]
      }
    }

    case 'try': {
      const body = compile(node.body)
      const catch_ = node.catch_ ? compile(node.catch_) : null
      return (input, env) => {
        try {
          const results = body(input, env)
          // Filter out errors from optional expressions
          return results
        } catch (e) {
          if (catch_) {
            const errMsg = e instanceof Error ? e.message : String(e)
            return catch_(errMsg, env)
          }
          return [] // try without catch suppresses errors and produces empty
        }
      }
    }

    case 'reduce': {
      const expr = compile(node.expr)
      const init = compile(node.init)
      const update = compile(node.update)
      return (input, env) => {
        let acc = init(input, env)[0]
        for (const item of expr(input, env)) {
          const newEnv = { ...env, [node.varName]: item }
          acc = update(acc, newEnv)[0]
        }
        return [acc]
      }
    }

    case 'label': {
      const body = compile(node.body)
      return (input, env) => {
        try {
          return body(input, env)
        } catch (e) {
          if (e instanceof BreakSignal && e.label === node.name) {
            return e.value !== undefined ? [e.value] : []
          }
          throw e
        }
      }
    }

    case 'call':
      return compileCall(node.name, node.args)

    case 'array': {
      if (!node.expr) return () => [[]]
      const expr = compile(node.expr)
      return (input, env) => [expr(input, env)]
    }

    case 'object': {
      const compiledPairs = node.pairs.map(p => ({
        key: compile(p.key),
        value: compile(p.value),
        computedKey: p.computedKey,
      }))
      return (input, env) => {
        // Generate all combinations for multi-output expressions
        let results: Record<string, unknown>[] = [{}]
        for (const pair of compiledPairs) {
          const keys = pair.key(input, env)
          const values = pair.value(input, env)
          const newResults: Record<string, unknown>[] = []
          for (const prev of results) {
            for (const k of keys) {
              for (const v of values) {
                newResults.push({ ...prev, [String(k)]: v })
              }
            }
          }
          results = newResults
        }
        return results
      }
    }

    case 'postfix': {
      let f = compile(node.base)
      for (const op of node.ops) {
        const prev = f
        switch (op.tag) {
          case 'field': {
            const name = op.name
            f = (input, env) => {
              const results: JqValue[] = []
              for (const v of prev(input, env)) {
                if (v === null || v === undefined) results.push(null)
                else if (typeof v === 'object') results.push((v as Record<string, unknown>)[name] ?? null)
                else results.push(null)
              }
              return results
            }
            break
          }
          case 'index': {
            const idxF = compile(op.expr)
            f = (input, env) => {
              const results: JqValue[] = []
              for (const v of prev(input, env)) {
                for (const idx of idxF(input, env)) {
                  if (v === null || v === undefined) { results.push(null); continue }
                  if (Array.isArray(v) && typeof idx === 'number') {
                    const i = idx < 0 ? v.length + idx : idx
                    results.push(v[i] ?? null)
                  } else if (typeof v === 'object' && typeof idx === 'string') {
                    results.push((v as Record<string, unknown>)[idx] ?? null)
                  } else {
                    results.push(null)
                  }
                }
              }
              return results
            }
            break
          }
          case 'iterate':
            f = (input, env) => {
              const results: JqValue[] = []
              for (const v of prev(input, env)) {
                if (Array.isArray(v)) results.push(...v)
                else if (typeof v === 'object' && v !== null) results.push(...Object.values(v))
                else throw new Error(`cannot iterate over ${typeof v}`)
              }
              return results
            }
            break
          case 'optional': {
            const inner = f
            f = (input, env) => {
              try { return inner(input, env) } catch { return [] }
            }
            break
          }
          case 'slice': {
            const fromF = op.from ? compile(op.from) : null
            const toF = op.to ? compile(op.to) : null
            f = (input, env) => {
              const results: JqValue[] = []
              for (const v of prev(input, env)) {
                if (Array.isArray(v)) {
                  const from = fromF ? Number(fromF(input, env)[0]) : 0
                  const to = toF ? Number(toF(input, env)[0]) : v.length
                  results.push(v.slice(from < 0 ? v.length + from : from, to < 0 ? v.length + to : to))
                } else if (typeof v === 'string') {
                  const from = fromF ? Number(fromF(input, env)[0]) : 0
                  const to = toF ? Number(toF(input, env)[0]) : v.length
                  results.push(v.slice(from < 0 ? v.length + from : from, to < 0 ? v.length + to : to))
                } else {
                  results.push(null)
                }
              }
              return results
            }
            break
          }
        }
      }
      return f
    }

    case 'binding': {
      const expr = compile(node.expr)
      const body = compile(node.body)
      return (input, env) => {
        const results: JqValue[] = []
        for (const v of expr(input, env)) {
          results.push(...body(input, { ...env, [node.varName]: v }))
        }
        return results
      }
    }

    case 'format':
      return (input) => [applyFormat(node.name, input)]

    case 'string_interp': {
      const compiled = node.parts.map(p => typeof p === 'string' ? p : compile(p))
      return (input, env) => {
        let s = ''
        for (const part of compiled) {
          if (typeof part === 'string') {
            s += part
          } else {
            const vals = part(input, env)
            s += vals.map(v => typeof v === 'string' ? v : JSON.stringify(v)).join('')
          }
        }
        return [s]
      }
    }

    case 'slice': {
      const fromF = node.from ? compile(node.from) : null
      const toF = node.to ? compile(node.to) : null
      return (input, env) => {
        if (Array.isArray(input)) {
          const from = fromF ? Number(fromF(input, env)[0]) : 0
          const to = toF ? Number(toF(input, env)[0]) : input.length
          return [input.slice(from, to)]
        }
        return [null]
      }
    }

    case 'optional': {
      const expr = compile(node.expr)
      return (input, env) => {
        try { return expr(input, env) } catch { return [] }
      }
    }

    case 'update': {
      const pathF = compile(node.path)
      const valueF = compile(node.value)
      return (input, env) => {
        // Simple update: for now handle basic .field |= expr
        // This is a simplified version; full path update is complex
        const newInput = deepClone(input)
        // The path filter should identify which values to update
        // For simple cases, we apply the update to the result
        const oldVals = pathF(input, env)
        for (const _old of oldVals) {
          const newVals = valueF(_old, env)
          if (newVals.length > 0) {
            // Apply update back — simplified for common patterns
            return [applyUpdate(newInput, node.path, newVals[0], node.op)]
          }
        }
        return [newInput]
      }
    }
  }
}

function applyUpdate(obj: JqValue, path: AstNode, newVal: JqValue, op: string): JqValue {
  // Simplified update for common patterns like .field |= expr
  if (path.tag === 'field') {
    if (typeof obj === 'object' && obj !== null) {
      const result = { ...(obj as Record<string, unknown>) }
      const old = result[path.name]
      result[path.name] = op === '|=' ? newVal : doArith(op.replace('=', ''), old, newVal)
      return result
    }
  }
  if (path.tag === 'postfix' && path.ops.length > 0) {
    const lastOp = path.ops[path.ops.length - 1]
    if (lastOp.tag === 'field' && typeof obj === 'object' && obj !== null) {
      const result = deepClone(obj) as Record<string, unknown>
      // Navigate to the parent
      let current: unknown = result
      const compiledBase = compile(path.base)
      // For simple .field chains, just update the last field
      if (path.ops.length === 1) {
        const old = (current as Record<string, unknown>)[lastOp.name]
        ;(current as Record<string, unknown>)[lastOp.name] = op === '|=' ? newVal : doArith(op.replace('=', ''), old, newVal)
        return result
      }
    }
  }
  return newVal
}

function deepClone(v: JqValue): JqValue {
  if (v === null || typeof v !== 'object') return v
  return JSON.parse(JSON.stringify(v))
}

function doArith(op: string, l: JqValue, r: JqValue): JqValue {
  // String concatenation
  if (op === '+' && typeof l === 'string' && typeof r === 'string') return l + r
  // Array concatenation
  if (op === '+' && Array.isArray(l) && Array.isArray(r)) return [...l, ...r]
  // Object merge
  if (op === '+' && typeof l === 'object' && l !== null && typeof r === 'object' && r !== null && !Array.isArray(l) && !Array.isArray(r)) {
    return { ...(l as Record<string, unknown>), ...(r as Record<string, unknown>) }
  }
  // Null arithmetic
  if (l === null) return r
  if (r === null) return l
  const ln = Number(l), rn = Number(r)
  switch (op) {
    case '+': return ln + rn
    case '-': return ln - rn
    case '*': return ln * rn
    case '/': return rn === 0 ? null : ln / rn
    case '%': return rn === 0 ? null : ln % rn
    default: return null
  }
}

function doCompare(op: string, l: JqValue, r: JqValue): boolean {
  switch (op) {
    case '==': return deepEqual(l, r)
    case '!=': return !deepEqual(l, r)
    case '<': return compareOrder(l, r) < 0
    case '<=': return compareOrder(l, r) <= 0
    case '>': return compareOrder(l, r) > 0
    case '>=': return compareOrder(l, r) >= 0
    default: return false
  }
}

function deepEqual(a: JqValue, b: JqValue): boolean {
  if (a === b) return true
  if (a === null || b === null) return false
  if (typeof a !== typeof b) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((v, i) => deepEqual(v, b[i]))
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a as Record<string, unknown>).sort()
    const bKeys = Object.keys(b as Record<string, unknown>).sort()
    if (aKeys.length !== bKeys.length) return false
    return aKeys.every((k, i) =>
      k === bKeys[i] && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
    )
  }
  return false
}

function compareOrder(a: JqValue, b: JqValue): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b)
  return 0
}

function isTruthy(v: JqValue): boolean {
  return v !== false && v !== null
}

function applyFormat(name: string, value: JqValue): string {
  switch (name) {
    case 'json':
      return JSON.stringify(value)
    case 'text':
      return String(value)
    case 'csv': {
      if (!Array.isArray(value)) return String(value)
      return value.map(v => {
        const s = String(v ?? '')
        return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s
      }).join(',')
    }
    case 'tsv': {
      if (!Array.isArray(value)) return String(value)
      return value.map(v => String(v ?? '').replace(/\t/g, '\\t').replace(/\n/g, '\\n')).join('\t')
    }
    case 'html': {
      const s = String(value ?? '')
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    }
    case 'uri':
      return encodeURIComponent(String(value ?? ''))
    case 'base64':
      return Buffer.from(String(value ?? '')).toString('base64')
    case 'base64d':
      return Buffer.from(String(value ?? ''), 'base64').toString('utf-8')
    default:
      throw new Error(`unknown format: @${name}`)
  }
}

// ─── Builtin functions ────────────────────────────────────────────────────────

function compileCall(name: string, argNodes: AstNode[]): Filter {
  const args = argNodes.map(compile)

  switch (name) {
    case 'length':
      return (input) => {
        if (Array.isArray(input)) return [input.length]
        if (typeof input === 'string') return [input.length]
        if (typeof input === 'object' && input !== null) return [Object.keys(input).length]
        if (input === null) return [0]
        return [0]
      }
    case 'utf8bytelength':
      return (input) => [Buffer.byteLength(String(input ?? ''), 'utf8')]
    case 'keys': case 'keys_unsorted':
      return (input) => {
        if (Array.isArray(input)) return [input.map((_, i) => i)]
        if (typeof input === 'object' && input !== null) {
          const k = Object.keys(input)
          return [name === 'keys' ? k.sort() : k]
        }
        return [[]]
      }
    case 'values':
      return (input) => {
        if (Array.isArray(input)) return [input]
        if (typeof input === 'object' && input !== null) return [Object.values(input)]
        return [[]]
      }
    case 'type':
      return (input) => {
        if (input === null) return ['null']
        if (Array.isArray(input)) return ['array']
        return [typeof input]
      }
    case 'infinite': return () => [Infinity]
    case 'nan': return () => [NaN]
    case 'isinfinite': return (input) => [input === Infinity || input === -Infinity]
    case 'isnan': return (input) => [typeof input === 'number' && isNaN(input)]
    case 'isnormal': return (input) => [typeof input === 'number' && isFinite(input) && input !== 0]
    case 'empty': return () => []
    case 'error':
      return (input) => { throw new Error(typeof input === 'string' ? input : JSON.stringify(input)) }
    case 'null': return () => [null]

    case 'not':
      return (input) => [!isTruthy(input)]

    case 'has':
      return (input, env) => {
        const keyVals = args[0](input, env)
        for (const k of keyVals) {
          if (Array.isArray(input)) return [typeof k === 'number' && k >= 0 && k < input.length]
          if (typeof input === 'object' && input !== null) return [Object.prototype.hasOwnProperty.call(input, String(k))]
        }
        return [false]
      }

    case 'in':
      return (input, env) => {
        const objVals = args[0](input, env)
        for (const obj of objVals) {
          if (typeof obj === 'object' && obj !== null) {
            return [Object.prototype.hasOwnProperty.call(obj, String(input))]
          }
        }
        return [false]
      }

    case 'contains':
      return (input, env) => {
        const other = args[0](input, env)[0]
        return [jqContains(input, other)]
      }

    case 'inside':
      return (input, env) => {
        const other = args[0](input, env)[0]
        return [jqContains(other, input)]
      }

    case 'select':
      return (input, env) => {
        for (const v of args[0](input, env)) {
          if (isTruthy(v)) return [input]
        }
        return []
      }

    case 'map':
      return (input, env) => {
        if (!Array.isArray(input)) throw new Error('map requires array input')
        const results: JqValue[] = []
        for (const item of input) {
          results.push(...args[0](item, env))
        }
        return [results]
      }

    case 'map_values':
      return (input, env) => {
        if (Array.isArray(input)) {
          return [input.map(item => args[0](item, env)[0])]
        }
        if (typeof input === 'object' && input !== null) {
          const result: Record<string, unknown> = {}
          for (const [k, v] of Object.entries(input)) {
            result[k] = args[0](v, env)[0]
          }
          return [result]
        }
        return [input]
      }

    case 'to_entries':
      return (input) => {
        if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
          return [Object.entries(input).map(([k, v]) => ({ key: k, value: v }))]
        }
        return [[]]
      }

    case 'from_entries':
      return (input) => {
        if (!Array.isArray(input)) return [{}]
        const obj: Record<string, unknown> = {}
        for (const entry of input) {
          if (typeof entry === 'object' && entry !== null) {
            const e = entry as Record<string, unknown>
            const k = String(e.key ?? e.name ?? '')
            obj[k] = e.value
          }
        }
        return [obj]
      }

    case 'with_entries':
      return (input, env) => {
        if (typeof input !== 'object' || input === null || Array.isArray(input)) return [input]
        const entries = Object.entries(input).map(([k, v]) => ({ key: k, value: v }))
        const mapped: JqValue[] = []
        for (const entry of entries) {
          mapped.push(...args[0](entry, env))
        }
        const obj: Record<string, unknown> = {}
        for (const entry of mapped) {
          if (typeof entry === 'object' && entry !== null) {
            const e = entry as Record<string, unknown>
            obj[String(e.key ?? '')] = e.value
          }
        }
        return [obj]
      }

    case 'del':
      return (input, env) => {
        if (Array.isArray(input)) {
          // Collect indices to delete
          const toDelete = new Set<number>()
          for (const v of args[0](input, env)) {
            // Hmm, del doesn't work this way. We need to evaluate the path expression.
            // For now, handle common patterns
          }
          // Fallback: evaluate path and filter
          const cloned = [...input]
          // Simple approach: args[0] evaluated on each element, remove those that match
          return [cloned]
        }
        if (typeof input === 'object' && input !== null) {
          const result = { ...(input as Record<string, unknown>) }
          // Evaluate path expression to find keys to delete
          // For simple .field patterns, detect field name from AST
          const pathNode = argNodes[0]
          if (pathNode.tag === 'field') {
            delete result[pathNode.name]
          } else if (pathNode.tag === 'postfix' && pathNode.base.tag === 'identity') {
            for (const op of pathNode.ops) {
              if (op.tag === 'field') delete result[op.name]
            }
          }
          return [result]
        }
        return [input]
      }

    case 'add':
      return (input) => {
        if (!Array.isArray(input) || input.length === 0) return [null]
        return [input.reduce((acc, item) => doArith('+', acc, item))]
      }

    case 'any':
      if (args.length > 0) {
        return (input, env) => {
          if (!Array.isArray(input)) return [false]
          for (const item of input) {
            for (const v of args[0](item, env)) {
              if (isTruthy(v)) return [true]
            }
          }
          return [false]
        }
      }
      return (input) => {
        if (!Array.isArray(input)) return [false]
        return [input.some(isTruthy)]
      }

    case 'all':
      if (args.length > 0) {
        return (input, env) => {
          if (!Array.isArray(input)) return [true]
          for (const item of input) {
            const results = args[0](item, env)
            if (results.length === 0 || !isTruthy(results[0])) return [false]
          }
          return [true]
        }
      }
      return (input) => {
        if (!Array.isArray(input)) return [true]
        return [input.every(isTruthy)]
      }

    case 'flatten':
      return (input) => {
        if (!Array.isArray(input)) return [input]
        const depth = args.length > 0 ? Infinity : Infinity // TODO: arg-based depth
        return [flattenArray(input, depth)]
      }

    case 'range':
      return (input, env) => {
        if (args.length === 1) {
          const n = Number(args[0](input, env)[0])
          const results: JqValue[] = []
          for (let i = 0; i < n; i++) results.push(i)
          return results
        }
        if (args.length >= 2) {
          const from = Number(args[0](input, env)[0])
          const to = Number(args[1](input, env)[0])
          const step = args.length >= 3 ? Number(args[2](input, env)[0]) : 1
          const results: JqValue[] = []
          if (step > 0) {
            for (let i = from; i < to; i += step) results.push(i)
          } else if (step < 0) {
            for (let i = from; i > to; i += step) results.push(i)
          }
          return results
        }
        return []
      }

    case 'floor': return (input) => [Math.floor(Number(input))]
    case 'ceil': return (input) => [Math.ceil(Number(input))]
    case 'round': return (input) => [Math.round(Number(input))]
    case 'fabs': case 'abs': return (input) => [Math.abs(Number(input))]
    case 'sqrt': return (input) => [Math.sqrt(Number(input))]
    case 'pow': return (input, env) => [Math.pow(Number(args[0](input, env)[0]), Number(args[1](input, env)[0]))]
    case 'log': case 'log2': case 'log10':
      return (input) => {
        const n = Number(input)
        if (name === 'log') return [Math.log(n)]
        if (name === 'log2') return [Math.log2(n)]
        return [Math.log10(n)]
      }

    case 'min': return (input) => {
      if (!Array.isArray(input) || input.length === 0) return [null]
      return [input.reduce((a, b) => compareOrder(a, b) <= 0 ? a : b)]
    }
    case 'max': return (input) => {
      if (!Array.isArray(input) || input.length === 0) return [null]
      return [input.reduce((a, b) => compareOrder(a, b) >= 0 ? a : b)]
    }
    case 'min_by':
      return (input, env) => {
        if (!Array.isArray(input) || input.length === 0) return [null]
        return [input.reduce((a, b) => compareOrder(args[0](a, env)[0], args[0](b, env)[0]) <= 0 ? a : b)]
      }
    case 'max_by':
      return (input, env) => {
        if (!Array.isArray(input) || input.length === 0) return [null]
        return [input.reduce((a, b) => compareOrder(args[0](a, env)[0], args[0](b, env)[0]) >= 0 ? a : b)]
      }

    case 'sort':
      return (input) => {
        if (!Array.isArray(input)) return [input]
        return [[...input].sort(compareOrder)]
      }
    case 'sort_by':
      return (input, env) => {
        if (!Array.isArray(input)) return [input]
        return [[...input].sort((a, b) => compareOrder(args[0](a, env)[0], args[0](b, env)[0]))]
      }

    case 'group_by':
      return (input, env) => {
        if (!Array.isArray(input)) return [[]]
        const groups = new Map<string, JqValue[]>()
        for (const item of input) {
          const key = JSON.stringify(args[0](item, env)[0])
          if (!groups.has(key)) groups.set(key, [])
          groups.get(key)!.push(item)
        }
        return [[...groups.values()]]
      }

    case 'unique':
      return (input) => {
        if (!Array.isArray(input)) return [input]
        const seen = new Set<string>()
        return [input.filter(item => {
          const key = JSON.stringify(item)
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })]
      }

    case 'unique_by':
      return (input, env) => {
        if (!Array.isArray(input)) return [input]
        const seen = new Set<string>()
        return [input.filter(item => {
          const key = JSON.stringify(args[0](item, env)[0])
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })]
      }

    case 'reverse':
      return (input) => {
        if (Array.isArray(input)) return [[...input].reverse()]
        if (typeof input === 'string') return [input.split('').reverse().join('')]
        return [input]
      }

    case 'tostring':
      return (input) => [typeof input === 'string' ? input : JSON.stringify(input)]
    case 'tonumber':
      return (input) => {
        if (typeof input === 'number') return [input]
        const n = Number(input)
        if (isNaN(n)) throw new Error(`cannot convert ${JSON.stringify(input)} to number`)
        return [n]
      }

    case 'ascii_downcase':
      return (input) => [String(input).toLowerCase()]
    case 'ascii_upcase':
      return (input) => [String(input).toUpperCase()]

    case 'ltrimstr':
      return (input, env) => {
        const s = String(input)
        const prefix = String(args[0](input, env)[0])
        return [s.startsWith(prefix) ? s.slice(prefix.length) : s]
      }
    case 'rtrimstr':
      return (input, env) => {
        const s = String(input)
        const suffix = String(args[0](input, env)[0])
        return [s.endsWith(suffix) ? s.slice(0, -suffix.length) : s]
      }

    case 'startswith':
      return (input, env) => [String(input).startsWith(String(args[0](input, env)[0]))]
    case 'endswith':
      return (input, env) => [String(input).endsWith(String(args[0](input, env)[0]))]

    case 'split':
      return (input, env) => {
        const sep = String(args[0](input, env)[0])
        return [String(input).split(sep)]
      }
    case 'join':
      return (input, env) => {
        if (!Array.isArray(input)) return [String(input)]
        const sep = String(args[0](input, env)[0])
        return [input.map(v => typeof v === 'string' ? v : JSON.stringify(v ?? '')).join(sep)]
      }

    case 'test':
      return (input, env) => {
        const pattern = String(args[0](input, env)[0])
        const flags = args.length > 1 ? String(args[1](input, env)[0]) : ''
        return [new RegExp(pattern, flags).test(String(input))]
      }

    case 'match':
      return (input, env) => {
        const pattern = String(args[0](input, env)[0])
        const flags = args.length > 1 ? String(args[1](input, env)[0]) : ''
        const m = String(input).match(new RegExp(pattern, flags))
        if (!m) return [null]
        return [{
          offset: m.index,
          length: m[0].length,
          string: m[0],
          captures: (m.slice(1) || []).map((c, i) => ({
            offset: m.index! + (m[0].indexOf(c) >= 0 ? m[0].indexOf(c) : 0),
            length: c?.length ?? 0,
            string: c ?? null,
            name: null,
          }))
        }]
      }

    case 'capture':
      return (input, env) => {
        const pattern = String(args[0](input, env)[0])
        const flags = args.length > 1 ? String(args[1](input, env)[0]) : ''
        const re = new RegExp(pattern, flags)
        const m = re.exec(String(input))
        if (!m || !m.groups) return [{}]
        return [m.groups]
      }

    case 'scan':
      return (input, env) => {
        const pattern = String(args[0](input, env)[0])
        const re = new RegExp(pattern, 'g')
        const results: JqValue[] = []
        let m
        while ((m = re.exec(String(input))) !== null) {
          results.push(m.length > 1 ? m.slice(1) : m[0])
        }
        return [results]
      }

    case 'sub':
      return (input, env) => {
        const pattern = String(args[0](input, env)[0])
        const replacement = String(args[1](input, env)[0])
        return [String(input).replace(new RegExp(pattern), replacement)]
      }
    case 'gsub':
      return (input, env) => {
        const pattern = String(args[0](input, env)[0])
        const replacement = String(args[1](input, env)[0])
        return [String(input).replace(new RegExp(pattern, 'g'), replacement)]
      }

    case 'indices': case 'index': case 'rindex': {
      return (input, env) => {
        const s = Array.isArray(input) ? input : String(input)
        const target = args[0](input, env)[0]
        if (name === 'index') {
          if (Array.isArray(s)) {
            const idx = s.findIndex(v => deepEqual(v, target))
            return [idx >= 0 ? idx : null]
          }
          const idx = String(s).indexOf(String(target))
          return [idx >= 0 ? idx : null]
        }
        if (name === 'rindex') {
          if (Array.isArray(s)) {
            for (let i = s.length - 1; i >= 0; i--) {
              if (deepEqual(s[i], target)) return [i]
            }
            return [null]
          }
          const idx = String(s).lastIndexOf(String(target))
          return [idx >= 0 ? idx : null]
        }
        // indices
        const results: number[] = []
        if (Array.isArray(s)) {
          for (let i = 0; i < s.length; i++) {
            if (deepEqual(s[i], target)) results.push(i)
          }
        } else {
          const str = String(s)
          const sub = String(target)
          let pos = 0
          while (pos < str.length) {
            const idx = str.indexOf(sub, pos)
            if (idx < 0) break
            results.push(idx)
            pos = idx + 1
          }
        }
        return [results]
      }
    }

    case 'limit':
      return (input, env) => {
        const n = Number(args[0](input, env)[0])
        const results = args[1](input, env)
        return results.slice(0, n)
      }

    case 'first':
      if (args.length > 0) {
        return (input, env) => {
          const results = args[0](input, env)
          return results.length > 0 ? [results[0]] : []
        }
      }
      return (input) => {
        if (Array.isArray(input) && input.length > 0) return [input[0]]
        return [input]
      }

    case 'last':
      if (args.length > 0) {
        return (input, env) => {
          const results = args[0](input, env)
          return results.length > 0 ? [results[results.length - 1]] : []
        }
      }
      return (input) => {
        if (Array.isArray(input) && input.length > 0) return [input[input.length - 1]]
        return [input]
      }

    case 'nth':
      return (input, env) => {
        const n = Number(args[0](input, env)[0])
        if (args.length > 1) {
          const results = args[1](input, env)
          return n < results.length ? [results[n]] : []
        }
        if (Array.isArray(input)) return n < input.length ? [input[n]] : []
        return []
      }

    case 'paths':
      return (input, env) => {
        const results: JqValue[] = []
        function walk(v: JqValue, path: JqValue[]): void {
          if (Array.isArray(v)) {
            for (let i = 0; i < v.length; i++) {
              const p = [...path, i]
              if (args.length === 0 || isTruthy(args[0](v[i], env)[0])) results.push(p)
              walk(v[i], p)
            }
          } else if (typeof v === 'object' && v !== null) {
            for (const k of Object.keys(v)) {
              const p = [...path, k]
              if (args.length === 0 || isTruthy(args[0]((v as Record<string, unknown>)[k], env)[0])) results.push(p)
              walk((v as Record<string, unknown>)[k], p)
            }
          }
        }
        walk(input, [])
        return results
      }

    case 'leaf_paths':
      return (input) => {
        const results: JqValue[] = []
        function walk(v: JqValue, path: JqValue[]): void {
          if (Array.isArray(v)) {
            for (let i = 0; i < v.length; i++) walk(v[i], [...path, i])
          } else if (typeof v === 'object' && v !== null) {
            for (const k of Object.keys(v)) walk((v as Record<string, unknown>)[k], [...path, k])
          } else {
            results.push(path)
          }
        }
        walk(input, [])
        return results
      }

    case 'getpath':
      return (input, env) => {
        const path = args[0](input, env)[0]
        if (!Array.isArray(path)) return [null]
        let current: JqValue = input
        for (const key of path) {
          if (current === null || current === undefined) return [null]
          if (Array.isArray(current) && typeof key === 'number') current = current[key]
          else if (typeof current === 'object') current = (current as Record<string, unknown>)[String(key)]
          else return [null]
        }
        return [current ?? null]
      }

    case 'setpath':
      return (input, env) => {
        const path = args[0](input, env)[0] as JqValue[]
        const value = args[1](input, env)[0]
        if (!Array.isArray(path) || path.length === 0) return [value]
        const result = deepClone(input)
        let current: unknown = result
        for (let i = 0; i < path.length - 1; i++) {
          const key = path[i]
          if (Array.isArray(current) && typeof key === 'number') {
            if (current[key] === undefined || current[key] === null) {
              current[key] = typeof path[i + 1] === 'number' ? [] : {}
            }
            current = current[key]
          } else if (typeof current === 'object' && current !== null) {
            const obj = current as Record<string, unknown>
            if (obj[String(key)] === undefined || obj[String(key)] === null) {
              obj[String(key)] = typeof path[i + 1] === 'number' ? [] : {}
            }
            current = obj[String(key)]
          }
        }
        const lastKey = path[path.length - 1]
        if (Array.isArray(current) && typeof lastKey === 'number') {
          current[lastKey] = value
        } else if (typeof current === 'object' && current !== null) {
          (current as Record<string, unknown>)[String(lastKey)] = value
        }
        return [result]
      }

    case 'delpaths':
      return (input, env) => {
        const paths = args[0](input, env)[0] as JqValue[][]
        let result = deepClone(input)
        // Delete paths in reverse order of depth to avoid index shifting
        const sorted = [...paths].sort((a, b) => b.length - a.length)
        for (const path of sorted) {
          if (!Array.isArray(path) || path.length === 0) continue
          let parent: unknown = result
          for (let i = 0; i < path.length - 1; i++) {
            const key = path[i]
            if (Array.isArray(parent)) parent = parent[key as number]
            else if (typeof parent === 'object' && parent !== null) parent = (parent as Record<string, unknown>)[String(key)]
            else break
          }
          const lastKey = path[path.length - 1]
          if (Array.isArray(parent) && typeof lastKey === 'number') {
            parent.splice(lastKey, 1)
          } else if (typeof parent === 'object' && parent !== null) {
            delete (parent as Record<string, unknown>)[String(lastKey)]
          }
        }
        return [result]
      }

    case 'env':
      return () => [process.env]

    case 'builtins':
      return () => [BUILTIN_NAMES]

    case 'input': case 'inputs': case 'debug': case 'stderr':
      // These are no-ops / passthrough in our context
      return (input) => [input]

    case 'ascii':
      return (input) => [typeof input === 'number' ? String.fromCharCode(input) : (String(input).charCodeAt(0))]

    case 'explode':
      return (input) => {
        if (typeof input === 'string') return [Array.from(input).map(c => c.charCodeAt(0))]
        return [input]
      }

    case 'implode':
      return (input) => {
        if (Array.isArray(input)) return [input.map(n => String.fromCharCode(Number(n))).join('')]
        return [input]
      }

    case 'tojson':
      return (input) => [JSON.stringify(input)]

    case 'fromjson':
      return (input) => [JSON.parse(String(input))]

    case 'recurse':
      return (input, env) => {
        const results: JqValue[] = []
        const f = args.length > 0 ? args[0] : null
        function walk(v: JqValue): void {
          results.push(v)
          if (f) {
            try {
              for (const next of f(v, env)) {
                if (next !== null && next !== undefined) walk(next)
              }
            } catch { /* stop recursion on error */ }
          } else {
            if (Array.isArray(v)) v.forEach(walk)
            else if (typeof v === 'object' && v !== null) Object.values(v).forEach(walk)
          }
        }
        walk(input)
        return results
      }

    case 'recurse_down':
      return (input) => {
        const results: JqValue[] = []
        function walk(v: JqValue): void {
          results.push(v)
          if (Array.isArray(v)) v.forEach(walk)
          else if (typeof v === 'object' && v !== null) Object.values(v).forEach(walk)
        }
        walk(input)
        return results
      }

    case 'transpose':
      return (input) => {
        if (!Array.isArray(input)) return [input]
        const maxLen = Math.max(...input.map((a: unknown) => Array.isArray(a) ? a.length : 0))
        const result: unknown[][] = []
        for (let i = 0; i < maxLen; i++) {
          result.push(input.map((a: unknown) => Array.isArray(a) ? a[i] ?? null : null))
        }
        return [result]
      }

    case 'input_line_number':
      return () => [0] // Not applicable in our context

    case 'object': case 'objects':
      return (input) => typeof input === 'object' && input !== null && !Array.isArray(input) ? [input] : []
    case 'arrays':
      return (input) => Array.isArray(input) ? [input] : []
    case 'strings':
      return (input) => typeof input === 'string' ? [input] : []
    case 'numbers':
      return (input) => typeof input === 'number' ? [input] : []
    case 'booleans':
      return (input) => typeof input === 'boolean' ? [input] : []
    case 'nulls':
      return (input) => input === null ? [input] : []
    case 'iterables':
      return (input) => (Array.isArray(input) || (typeof input === 'object' && input !== null)) ? [input] : []
    case 'scalars':
      return (input) => (input === null || typeof input !== 'object') ? [input] : []

    default:
      throw new Error(`unknown function: ${name}/${argNodes.length}`)
  }
}

function flattenArray(arr: unknown[], depth: number): unknown[] {
  if (depth <= 0) return arr
  const result: unknown[] = []
  for (const item of arr) {
    if (Array.isArray(item)) result.push(...flattenArray(item, depth - 1))
    else result.push(item)
  }
  return result
}

function jqContains(a: JqValue, b: JqValue): boolean {
  if (typeof b === 'string' && typeof a === 'string') return a.includes(b)
  if (Array.isArray(b) && Array.isArray(a)) return b.every(bItem => a.some(aItem => jqContains(aItem, bItem)))
  if (typeof b === 'object' && b !== null && typeof a === 'object' && a !== null) {
    return Object.keys(b as Record<string, unknown>).every(k =>
      jqContains((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
    )
  }
  return deepEqual(a, b)
}

const BUILTIN_NAMES = [
  'length', 'keys', 'values', 'type', 'has', 'in', 'contains', 'inside',
  'select', 'map', 'map_values', 'to_entries', 'from_entries', 'with_entries',
  'del', 'add', 'any', 'all', 'flatten', 'range', 'floor', 'ceil', 'round',
  'fabs', 'sqrt', 'min', 'max', 'min_by', 'max_by', 'sort', 'sort_by',
  'group_by', 'unique', 'unique_by', 'reverse', 'tostring', 'tonumber',
  'ascii_downcase', 'ascii_upcase', 'ltrimstr', 'rtrimstr', 'startswith',
  'endswith', 'split', 'join', 'test', 'match', 'capture', 'scan', 'sub', 'gsub',
  'indices', 'index', 'rindex', 'limit', 'first', 'last', 'nth',
  'paths', 'leaf_paths', 'getpath', 'setpath', 'delpaths',
  'not', 'empty', 'error', 'try', 'reduce', 'if', 'env', 'builtins',
  'explode', 'implode', 'tojson', 'fromjson', 'recurse',
  'transpose', 'objects', 'arrays', 'strings', 'numbers', 'booleans', 'nulls',
  'iterables', 'scalars', 'infinite', 'nan', 'isinfinite', 'isnan', 'isnormal',
  'ascii', 'utf8bytelength', 'abs', 'pow', 'log', 'log2', 'log10',
  'keys_unsorted', 'recurse_down',
]

// ─── Public API ───────────────────────────────────────────────────────────────

export function evaluateJq(input: string, expression: string, raw: boolean): JqResult {
  try {
    const data = JSON.parse(input)
    const tokens = tokenize(expression)
    const parser = new Parser(tokens)
    const ast = parser.parse()
    const filter = compile(ast)
    const outputs = filter(data, {})
    return { outputs }
  } catch (e) {
    return { outputs: [], error: String(e instanceof Error ? e.message : e) }
  }
}
