/**
 * Recursive descent parser: Token[] → AST
 *
 * Grammar:
 *   shell    → chain EOF
 *   chain    → pipeline (('&&'|'||'|';') pipeline)*
 *   pipeline → command ('|' command)*
 *   command  → WORD arg* redirect*
 */

import type { Token, TokenType } from './tokenizer'
import { tokenize, parseBracedExpansion } from './tokenizer'
import type {
  ShellNode,
  PipelineNode,
  CommandNode,
  ArgumentNode,
  RedirectNode,
  HeredocNode,
  AssignmentNode,
  ChainOperator
} from './ast'

class ParseError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'ParseError'
  }
}

class Parser {
  private tokens: Token[]
  private pos: number

  constructor(tokens: Token[]) {
    this.tokens = tokens
    this.pos = 0
  }

  private peek(): Token {
    return this.tokens[this.pos] ?? { type: 'eof', value: '' }
  }

  private advance(): Token {
    const t = this.tokens[this.pos]
    this.pos++
    return t
  }

  private expect(type: TokenType): Token {
    const t = this.peek()
    if (t.type !== type) {
      throw new ParseError(`Expected ${type}, got ${t.type} ("${t.value}")`)
    }
    return this.advance()
  }

  private isChainOp(t: Token): t is Token & { type: 'and' | 'or' | 'semi' | 'amp' } {
    return t.type === 'and' || t.type === 'or' || t.type === 'semi' || t.type === 'amp'
  }

  private isRedirect(t: Token): boolean {
    return t.type === 'redirect_out' || t.type === 'redirect_append' || t.type === 'redirect_in'
  }

  private isArg(t: Token): boolean {
    return (
      t.type === 'word' ||
      t.type === 'single_quoted' ||
      t.type === 'double_quoted' ||
      t.type === 'variable' ||
      t.type === 'substitution'
    )
  }

  /** Validate a ${VAR<op>word} operator — only default expansion is supported */
  private checkExpansionOp(name: string, op: string): void {
    if (op !== '-' && op !== ':-') {
      throw new ParseError(
        `\${${name}${op}...}: only \${VAR-default} and \${VAR:-default} expansion is supported in adf_shell`
      )
    }
  }

  /** Parse a token into an ArgumentNode */
  private parseArg(t: Token): ArgumentNode {
    switch (t.type) {
      case 'word':
        return { type: 'literal', value: t.value }
      case 'variable':
        if (t.op !== undefined) {
          this.checkExpansionOp(t.value, t.op)
          return { type: 'variable', name: t.value, op: t.op, word: t.word ?? '' }
        }
        return { type: 'variable', name: t.value }
      case 'substitution':
        return { type: 'substitution', pipeline: this.parseSubstitution(t.value) }
      case 'single_quoted':
        return { type: 'quoted', quote: 'single', parts: [{ type: 'literal', value: t.value }] }
      case 'double_quoted':
        return { type: 'quoted', quote: 'double', parts: this.parseDoubleQuoted(t.value) }
      default:
        throw new ParseError(`Unexpected token type ${t.type} in argument position`)
    }
  }

  /** Parse the content of a double-quoted string into parts (literal + variable + substitution) */
  private parseDoubleQuoted(raw: string): ArgumentNode[] {
    const parts: ArgumentNode[] = []
    let i = 0
    let literal = ''

    while (i < raw.length) {
      if (raw[i] === '$' && i + 1 < raw.length) {
        if (literal) { parts.push({ type: 'literal', value: literal }); literal = '' }

        if (raw[i + 1] === '(') {
          // Command substitution
          i += 2
          let depth = 1
          let inner = ''
          while (i < raw.length && depth > 0) {
            if (raw[i] === '(') depth++
            else if (raw[i] === ')') { depth--; if (depth === 0) break }
            inner += raw[i]
            i++
          }
          if (i < raw.length) i++ // skip )
          parts.push({ type: 'substitution', pipeline: this.parseSubstitution(inner) })
        } else if (raw[i + 1] === '{') {
          // ${VAR} / ${VAR:-default}
          i += 2
          let content = ''
          while (i < raw.length && raw[i] !== '}') { content += raw[i]; i++ }
          if (i < raw.length) i++ // skip }
          const exp = parseBracedExpansion(content)
          if (exp.op !== undefined) {
            this.checkExpansionOp(exp.name, exp.op)
            parts.push({ type: 'variable', name: exp.name, op: exp.op, word: exp.word ?? '' })
          } else {
            parts.push({ type: 'variable', name: exp.name })
          }
        } else if (raw[i + 1] === '?') {
          // $? — last exit code
          i += 2
          parts.push({ type: 'variable', name: '?' })
        } else {
          // $VAR
          i++
          let name = ''
          while (i < raw.length && /[a-zA-Z0-9_]/.test(raw[i])) { name += raw[i]; i++ }
          if (name) {
            parts.push({ type: 'variable', name })
          } else {
            literal += '$'
          }
        }
      } else {
        literal += raw[i]
        i++
      }
    }
    if (literal) parts.push({ type: 'literal', value: literal })
    return parts.length > 0 ? parts : [{ type: 'literal', value: '' }]
  }

  /** Parse a command substitution string into a PipelineNode */
  private parseSubstitution(inner: string): PipelineNode {
    // $((expr)) reaches here as inner "(expr)" — arithmetic, not a command
    if (inner.startsWith('(') && inner.trimEnd().endsWith(')')) {
      throw new ParseError(
        'arithmetic expansion $(( )) is not supported in adf_shell — use jq or a .js script'
      )
    }
    const subTokens = tokenize(inner)
    const subParser = new Parser(subTokens)
    // Parse as a full shell node, but for substitution we only support a single pipeline
    const node = subParser.parseShell()
    if (node.kind === 'pipeline') return node
    // If it's a chain, wrap the left side (simplified)
    return node.left
  }

  // --- Grammar rules ---

  parseShell(): ShellNode {
    if (this.peek().type === 'eof') {
      // Empty command
      return { kind: 'pipeline', stages: [] }
    }
    return this.parseChain()
  }

  private parseChain(): ShellNode {
    let left = this.parsePipeline()

    while (this.isChainOp(this.peek())) {
      const opToken = this.advance()
      // Bare & separates commands like `;` — background execution is not
      // supported; the executor notes it and runs sequentially.
      const background = opToken.type === 'amp'
      const operator: ChainOperator = opToken.value === '&&' ? '&&' : opToken.value === '||' ? '||' : ';'

      // A newline (tokenized as `semi`) right after `&&`/`||` is a line
      // continuation in scripts, not an empty command — skip it.
      if (operator !== ';') {
        while (this.peek().type === 'semi') this.advance()
      }

      // If next token is EOF after a semi, just return left
      if (this.peek().type === 'eof') return left

      const right = this.parseChain()
      left = { kind: 'chain', left, operator, right, ...(background ? { background: true } : {}) }
    }

    return left
  }

  private parsePipeline(): PipelineNode {
    const stages: CommandNode[] = [this.parseCommand()]

    while (this.peek().type === 'pipe') {
      this.advance() // skip |
      // A newline after `|` continues the pipeline (line continuation).
      while (this.peek().type === 'semi') this.advance()
      stages.push(this.parseCommand())
    }

    return { kind: 'pipeline', stages }
  }

  private parseCommand(): CommandNode {
    // Leading NAME=value words are env assignments for this command's scope.
    // Glued tokens continue the value (VAR="a b", VAR=$X'y').
    const assignments: AssignmentNode[] = []
    while (this.peek().type === 'word' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(this.peek().value)) {
      const tok = this.advance()
      const eq = tok.value.indexOf('=')
      const parts: ArgumentNode[] = []
      const rest = tok.value.slice(eq + 1)
      if (rest) parts.push({ type: 'literal', value: rest })
      while (this.peek().glued && this.isArg(this.peek())) {
        parts.push(this.parseArg(this.advance()))
      }
      assignments.push({ name: tok.value.slice(0, eq), value: parts })
    }

    const nameToken = this.peek()
    if (!this.isArg(nameToken) && nameToken.type !== 'heredoc_marker') {
      // Bare assignment(s) with no command: VAR=x — sets the session variable
      if (assignments.length > 0) {
        return { kind: 'command', name: '', args: [], redirects: [], assignments }
      }
      throw new ParseError(`Expected command name, got ${nameToken.type} ("${nameToken.value}")`)
    }

    // Command name is the first word/quoted token
    this.advance()
    const name = nameToken.value

    const args: ArgumentNode[] = []
    const redirects: RedirectNode[] = []
    let heredoc: HeredocNode | undefined

    while (this.peek().type !== 'eof') {
      const t = this.peek()

      // Stop at pipeline/chain operators
      if (t.type === 'pipe' || this.isChainOp(t)) break

      // Redirects
      if (this.isRedirect(t)) {
        // A digit word GLUED to the redirect is a fd number (2>/dev/null,
        // 2>>log); a spaced digit is an ordinary arg (echo 2 > f writes "2").
        let fdNum = t.type === 'redirect_in' ? 0 : 1
        if (t.glued && args.length > 0) {
          const lastArg = args[args.length - 1]
          if (lastArg.type === 'literal' && /^[0-9]$/.test(lastArg.value)) {
            fdNum = parseInt(lastArg.value, 10)
            args.pop() // remove fd number from args
          }
        }
        this.advance()
        const targetToken = this.peek()

        // fd duplication: >&N / 2>&1 — merge one stream into another
        if (targetToken.type === 'redirect_dup') {
          this.advance()
          if (t.type !== 'redirect_in') {
            redirects.push({ type: 'dup', fd: fdNum, targetFd: parseInt(targetToken.value, 10) })
          }
          continue
        }

        if (!this.isArg(targetToken)) {
          throw new ParseError(`Expected redirect target, got ${targetToken.type}`)
        }
        this.advance()

        // /dev/null: discard the stream — no VFS file, no fs_write needed
        if (targetToken.type === 'word' && (targetToken.value === '/dev/null' || targetToken.value === 'dev/null')) {
          redirects.push({ type: 'discard', fd: fdNum })
          continue
        }

        const rType = t.type === 'redirect_in' ? 'in' : t.type === 'redirect_append' ? 'append' : 'out'
        if (rType === 'in') {
          redirects.push({ type: 'in', target: targetToken.value })
        } else {
          redirects.push({ type: rType, target: targetToken.value, ...(fdNum !== 1 ? { fd: fdNum } : {}) })
        }
        continue
      }

      // Heredoc marker
      if (t.type === 'heredoc_marker') {
        this.advance()
        // Expect heredoc body follows
        const bodyToken = this.peek()
        const quoted = t.quoted ? { quoted: true } : {}
        if (bodyToken.type === 'heredoc_body') {
          this.advance()
          heredoc = { tag: t.value, content: bodyToken.value, ...quoted }
        } else {
          heredoc = { tag: t.value, content: '', ...quoted }
        }
        continue
      }

      // Arguments
      if (this.isArg(t)) {
        this.advance()
        args.push(this.parseArg(t))
        continue
      }

      break
    }

    return {
      kind: 'command', name, args, redirects, heredoc,
      ...(assignments.length > 0 ? { assignments } : {}),
    }
  }
}

/**
 * Parse a shell command string into an AST.
 * Throws ParseError on syntax errors.
 */
export function parse(input: string): ShellNode {
  const tokens = tokenize(input)
  const parser = new Parser(tokens)
  const ast = parser.parseShell()
  return ast
}

export { ParseError }
