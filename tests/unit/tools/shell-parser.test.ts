import { describe, it, expect } from 'vitest'
import { parse, ParseError } from '../../../src/main/tools/shell/parser/parser'
import type { PipelineNode, ChainNode, CommandNode, QuotedArg } from '../../../src/main/tools/shell/parser/ast'

/** Helper: assert node is pipeline and return it */
function asPipeline(node: any): PipelineNode {
  expect(node.kind).toBe('pipeline')
  return node as PipelineNode
}

/** Helper: assert node is chain and return it */
function asChain(node: any): ChainNode {
  expect(node.kind).toBe('chain')
  return node as ChainNode
}

/** Helper: get the first (or only) command from a simple pipeline */
function firstCmd(input: string): CommandNode {
  const node = asPipeline(parse(input))
  return node.stages[0]
}

// ── AST structure ──

describe('parser — AST structure', () => {
  it('parses simple command', () => {
    const cmd = firstCmd('echo hello')
    expect(cmd.name).toBe('echo')
    expect(cmd.args).toHaveLength(1)
    expect(cmd.args[0]).toEqual({ type: 'literal', value: 'hello' })
  })

  it('parses pipeline with two stages', () => {
    const node = asPipeline(parse('cat f | grep x'))
    expect(node.stages).toHaveLength(2)
    expect(node.stages[0].name).toBe('cat')
    expect(node.stages[1].name).toBe('grep')
  })

  it('parses && chain', () => {
    const node = asChain(parse('a && b'))
    expect(node.operator).toBe('&&')
    expect(node.left.stages[0].name).toBe('a')
    const right = asPipeline(node.right)
    expect(right.stages[0].name).toBe('b')
  })

  it('parses || chain', () => {
    const node = asChain(parse('a || b'))
    expect(node.operator).toBe('||')
  })

  it('parses ; chain', () => {
    const node = asChain(parse('a; b'))
    expect(node.operator).toBe(';')
  })

  it('parses nested chain right-associatively', () => {
    // a && b || c → chain(a, &&, chain(b, ||, c))
    // The parser uses recursive parseChain for the right side,
    // producing right-associative grouping.
    const outer = asChain(parse('a && b || c'))
    expect(outer.operator).toBe('&&')
    expect(outer.left.stages[0].name).toBe('a')
    const inner = asChain(outer.right)
    expect(inner.operator).toBe('||')
    expect(inner.left.stages[0].name).toBe('b')
    const rightmost = asPipeline(inner.right)
    expect(rightmost.stages[0].name).toBe('c')
  })

  it('trailing ; + EOF returns just the pipeline', () => {
    const node = parse('a;')
    // After 'a', sees ';', then EOF → returns just pipeline 'a'
    expect(node.kind).toBe('pipeline')
    expect((node as PipelineNode).stages[0].name).toBe('a')
  })

  it('parses empty input as empty pipeline', () => {
    const node = asPipeline(parse(''))
    expect(node.stages).toHaveLength(0)
  })
})

// ── Argument types ──

describe('parser — argument types', () => {
  it('parses variable arg', () => {
    const cmd = firstCmd('echo $VAR')
    expect(cmd.args[0]).toEqual({ type: 'variable', name: 'VAR' })
  })

  it('parses substitution arg', () => {
    const cmd = firstCmd('echo $(whoami)')
    expect(cmd.args[0].type).toBe('substitution')
    const sub = cmd.args[0] as any
    expect(sub.pipeline.kind).toBe('pipeline')
    expect(sub.pipeline.stages[0].name).toBe('whoami')
  })

  it('parses single-quoted arg', () => {
    const cmd = firstCmd("echo 'hello world'")
    expect(cmd.args[0].type).toBe('quoted')
    const q = cmd.args[0] as QuotedArg
    expect(q.quote).toBe('single')
    expect(q.parts).toEqual([{ type: 'literal', value: 'hello world' }])
  })

  it('parses double-quoted with variable', () => {
    const cmd = firstCmd('echo "$HOME/dir"')
    expect(cmd.args[0].type).toBe('quoted')
    const q = cmd.args[0] as QuotedArg
    expect(q.quote).toBe('double')
    // Parts should be: VariableArg(HOME) + LiteralArg(/dir)
    expect(q.parts.some(p => p.type === 'variable' && (p as any).name === 'HOME')).toBe(true)
    expect(q.parts.some(p => p.type === 'literal' && (p as any).value === '/dir')).toBe(true)
  })

  it('parses double-quoted with substitution', () => {
    const cmd = firstCmd('echo "$(date)"')
    const q = cmd.args[0] as QuotedArg
    expect(q.quote).toBe('double')
    expect(q.parts.some(p => p.type === 'substitution')).toBe(true)
  })
})

// ── Redirects ──

describe('parser — redirects', () => {
  it('parses output redirect', () => {
    const cmd = firstCmd('echo x > file')
    expect(cmd.redirects).toHaveLength(1)
    expect(cmd.redirects[0]).toEqual({ type: 'out', target: 'file' })
  })

  it('parses append redirect', () => {
    const cmd = firstCmd('echo x >> file')
    expect(cmd.redirects).toHaveLength(1)
    expect(cmd.redirects[0]).toEqual({ type: 'append', target: 'file' })
  })

  it('parses input redirect', () => {
    const cmd = firstCmd('cat < file')
    expect(cmd.redirects).toHaveLength(1)
    expect(cmd.redirects[0]).toEqual({ type: 'in', target: 'file' })
  })

  it('ignores stderr redirect (fd >= 2)', () => {
    const cmd = firstCmd('cmd 2>/dev/null')
    // fd 2 redirect should be ignored
    expect(cmd.redirects).toHaveLength(0)
    // '2' should have been removed from args
    expect(cmd.args.every(a => a.type !== 'literal' || (a as any).value !== '2')).toBe(true)
  })

  it('keeps stdout redirect with explicit fd 1', () => {
    const cmd = firstCmd('cmd 1>file')
    expect(cmd.redirects).toHaveLength(1)
    expect(cmd.redirects[0]).toEqual({ type: 'out', target: 'file' })
  })
})

// ── Heredoc ──

describe('parser — heredoc', () => {
  it('parses heredoc with body', () => {
    const cmd = firstCmd('cat <<EOF\nhello world\nEOF')
    expect(cmd.heredoc).toBeDefined()
    expect(cmd.heredoc!.tag).toBe('EOF')
    expect(cmd.heredoc!.content).toBe('hello world')
  })

  it('handles empty heredoc body', () => {
    // Heredoc marker without a following body token
    // parse('cat <<EOF') — the tokenizer handles unterminated heredoc
    const cmd = firstCmd('cat <<EOF\n\nEOF')
    expect(cmd.heredoc).toBeDefined()
    expect(cmd.heredoc!.tag).toBe('EOF')
  })
})

// ── Errors ──

describe('parser — errors', () => {
  it('throws ParseError for missing redirect target', () => {
    expect(() => parse('echo >')).toThrow(ParseError)
  })
})
