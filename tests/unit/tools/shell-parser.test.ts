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

  it('turns 2>/dev/null into a discard redirect (no fs_write)', () => {
    const cmd = firstCmd('cmd 2>/dev/null')
    expect(cmd.redirects).toEqual([{ type: 'discard', fd: 2 }])
    // '2' should have been removed from args
    expect(cmd.args.every(a => a.type !== 'literal' || (a as any).value !== '2')).toBe(true)
  })

  it('turns >/dev/null into a discard redirect for stdout', () => {
    const cmd = firstCmd('cmd >/dev/null')
    expect(cmd.redirects).toEqual([{ type: 'discard', fd: 1 }])
  })

  it('keeps stdout redirect with explicit fd 1', () => {
    const cmd = firstCmd('cmd 1>file')
    expect(cmd.redirects).toHaveLength(1)
    expect(cmd.redirects[0]).toEqual({ type: 'out', target: 'file' })
  })

  it('keeps a stderr file redirect with fd 2', () => {
    const cmd = firstCmd('cmd 2>errors.log')
    expect(cmd.redirects).toEqual([{ type: 'out', target: 'errors.log', fd: 2 }])
  })

  it('a spaced digit before > stays an argument (echo 2 > f)', () => {
    const cmd = firstCmd('echo 2 > f')
    expect(cmd.args).toEqual([{ type: 'literal', value: '2' }])
    expect(cmd.redirects).toEqual([{ type: 'out', target: 'f' }])
  })

  it('QUOTED /dev/null is still a discard (bash: quoting does not change the device)', () => {
    expect(firstCmd('cmd 2>"/dev/null"').redirects).toEqual([{ type: 'discard', fd: 2 }])
    expect(firstCmd("cmd > '/dev/null'").redirects).toEqual([{ type: 'discard', fd: 1 }])
  })

  it('append to /dev/null is also a discard', () => {
    expect(firstCmd('cmd 2>>/dev/null').redirects).toEqual([{ type: 'discard', fd: 2 }])
  })

  it('rejects /dev/stdout and /dev/stderr targets with a clear error', () => {
    expect(() => parse('cmd > /dev/stdout')).toThrow(
      /redirect to \/dev\/stdout is not supported in adf_shell; use 2>&1/
    )
    expect(() => parse('cmd 2>/dev/stderr')).toThrow(
      /redirect to \/dev\/stderr is not supported in adf_shell; use >&2/
    )
    expect(() => parse('cmd < /dev/stdout')).toThrow(ParseError)
  })

  it('a variable target becomes a runtime-resolved targetNode (not a file named after the variable)', () => {
    const cmd = firstCmd('cmd > $F')
    expect(cmd.redirects).toEqual([
      { type: 'out', targetNode: { type: 'variable', name: 'F' } },
    ])
  })

  it('a glued composite target ("$DIR"/out.txt) is kept whole as one targetNode', () => {
    const cmd = firstCmd('cmd > "$DIR"/out.txt')
    expect(cmd.redirects).toHaveLength(1)
    const r = cmd.redirects[0]
    expect(r.type).toBe('out')
    expect(r.target).toBeUndefined()
    expect(r.targetNode).toEqual({
      type: 'quoted',
      quote: 'double',
      parts: [
        { type: 'quoted', quote: 'double', parts: [{ type: 'variable', name: 'DIR' }] },
        { type: 'literal', value: '/out.txt' },
      ],
    })
    // the glued tail must NOT leak into the arg list
    expect(cmd.args).toEqual([])
  })

  it('a static quoted target parses to a plain string target', () => {
    expect(firstCmd('cmd > "out.txt"').redirects).toEqual([{ type: 'out', target: 'out.txt' }])
  })
})

// ── fd duplication ──

describe('parser — fd duplication', () => {
  it('parses 2>&1 as a dup redirect', () => {
    const cmd = firstCmd('cmd 2>&1')
    expect(cmd.redirects).toEqual([{ type: 'dup', fd: 2, targetFd: 1 }])
  })

  it('parses >&2 as a dup redirect from stdout', () => {
    const cmd = firstCmd('echo err >&2')
    expect(cmd.redirects).toEqual([{ type: 'dup', fd: 1, targetFd: 2 }])
  })

  it('parses cmd 2>&1 | head without error', () => {
    const node = asPipeline(parse('cmd 2>&1 | head'))
    expect(node.stages).toHaveLength(2)
    expect(node.stages[0].redirects).toEqual([{ type: 'dup', fd: 2, targetFd: 1 }])
    expect(node.stages[1].name).toBe('head')
  })

  it('parses mixed file redirect + dup (> f 2>&1)', () => {
    const cmd = firstCmd('cmd > f 2>&1')
    expect(cmd.redirects).toEqual([
      { type: 'out', target: 'f' },
      { type: 'dup', fd: 2, targetFd: 1 },
    ])
  })

  it('parses redirect + semicolon chain (cmd 2>&1; next)', () => {
    const node = asChain(parse('cmd 2>&1; next'))
    expect(node.operator).toBe(';')
    expect(node.left.stages[0].redirects).toEqual([{ type: 'dup', fd: 2, targetFd: 1 }])
  })
})

// ── Prefix assignments ──

describe('parser — prefix assignments', () => {
  it('parses VAR=val cmd', () => {
    const cmd = firstCmd('GREETING=hello cmd arg')
    expect(cmd.name).toBe('cmd')
    expect(cmd.assignments).toEqual([
      { name: 'GREETING', value: [{ type: 'literal', value: 'hello' }] },
    ])
    expect(cmd.args).toEqual([{ type: 'literal', value: 'arg' }])
  })

  it('parses multiple assignments', () => {
    const cmd = firstCmd('A=1 B=2 cmd')
    expect(cmd.assignments!.map(a => a.name)).toEqual(['A', 'B'])
    expect(cmd.name).toBe('cmd')
  })

  it('parses a quoted assignment value (VAR="a b")', () => {
    const cmd = firstCmd('VAR="a b" cmd')
    expect(cmd.name).toBe('cmd')
    expect(cmd.assignments).toHaveLength(1)
    expect(cmd.assignments![0].name).toBe('VAR')
    expect(cmd.assignments![0].value[0].type).toBe('quoted')
  })

  it('parses a variable assignment value (VAR=$OTHER)', () => {
    const cmd = firstCmd('VAR=$OTHER cmd')
    expect(cmd.assignments![0].value).toEqual([{ type: 'variable', name: 'OTHER' }])
  })

  it('parses a bare assignment with no command', () => {
    const cmd = firstCmd('VAR=hello')
    expect(cmd.name).toBe('')
    expect(cmd.assignments).toEqual([
      { name: 'VAR', value: [{ type: 'literal', value: 'hello' }] },
    ])
  })

  it('a spaced word after VAR= is the command, not the value', () => {
    const cmd = firstCmd('VAR= cmd')
    expect(cmd.name).toBe('cmd')
    expect(cmd.assignments).toEqual([{ name: 'VAR', value: [] }])
  })
})

// ── Default expansion ──

describe('parser — default expansion', () => {
  it('parses ${VAR:-def} into a variable arg with op/word', () => {
    const cmd = firstCmd('echo ${NAME:-fallback}')
    expect(cmd.args[0]).toEqual({ type: 'variable', name: 'NAME', op: ':-', word: 'fallback' })
  })

  it('parses ${VAR-def} inside double quotes', () => {
    const cmd = firstCmd('echo "x ${NAME-fb} y"')
    const q = cmd.args[0] as QuotedArg
    expect(q.parts.some(p => p.type === 'variable' && (p as any).op === '-' && (p as any).word === 'fb')).toBe(true)
  })

  it('parses $? inside double quotes', () => {
    const cmd = firstCmd('echo "exit=$?"')
    const q = cmd.args[0] as QuotedArg
    expect(q.parts.some(p => p.type === 'variable' && (p as any).name === '?')).toBe(true)
  })

  it('rejects unsupported expansion operators with a clear error', () => {
    expect(() => parse('echo ${NAME:=x}')).toThrow(/only \$\{VAR-default\} and \$\{VAR:-default\}/)
    expect(() => parse('echo ${NAME:+x}')).toThrow(ParseError)
  })
})

// ── Background & ──

describe('parser — background operator', () => {
  it('rejects a & b with a clear error (no silent sequential fallback)', () => {
    expect(() => parse('false & echo hi')).toThrow(
      /background execution \(&\) is not supported in adf_shell.*remove the & or use && or ;/
    )
    expect(() => parse('false & echo hi')).toThrow(ParseError)
  })

  it('rejects a trailing & instead of silently running in the foreground', () => {
    expect(() => parse('sleep 1 &')).toThrow(/background execution \(&\) is not supported/)
  })

  it('&& is unaffected', () => {
    const node = asChain(parse('a && b'))
    expect(node.operator).toBe('&&')
  })
})

// ── Arithmetic ──

describe('parser — arithmetic expansion', () => {
  it('rejects $(( )) with a clear error', () => {
    expect(() => parse('echo $((1+2))')).toThrow(/arithmetic expansion/)
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

  it("marks a quoted-delimiter heredoc (<<'EOF') as quoted", () => {
    const cmd = firstCmd("cat <<'EOF'\n$FOO\nEOF")
    expect(cmd.heredoc!.quoted).toBe(true)
    const unquoted = firstCmd('cat <<EOF\n$FOO\nEOF')
    expect(unquoted.heredoc!.quoted).toBeUndefined()
  })
})

// ── Glued word arguments ──

describe('parser — glued word arguments join into ONE argument', () => {
  it('literal glued to a variable (gate_exit=$?) is one argument', () => {
    const cmd = firstCmd('echo gate_exit=$?')
    expect(cmd.args).toHaveLength(1)
    expect(cmd.args[0]).toEqual({
      type: 'quoted', quote: 'double',
      parts: [
        { type: 'literal', value: 'gate_exit=' },
        { type: 'variable', name: '?' },
      ],
    })
  })

  it('literal + variable + literal (x$?y) is one argument', () => {
    const cmd = firstCmd('echo x$?y')
    expect(cmd.args).toHaveLength(1)
    const q = cmd.args[0] as QuotedArg
    expect(q.parts).toEqual([
      { type: 'literal', value: 'x' },
      { type: 'variable', name: '?' },
      { type: 'literal', value: 'y' },
    ])
  })

  it('a=$?b is one argument', () => {
    const cmd = firstCmd('echo a=$?b')
    expect(cmd.args).toHaveLength(1)
  })

  it('"pre"$VAR"post" is one argument', () => {
    const cmd = firstCmd('echo "pre"$VAR"post"')
    expect(cmd.args).toHaveLength(1)
    const q = cmd.args[0] as QuotedArg
    expect(q.parts).toHaveLength(3)
    expect(q.parts[1]).toEqual({ type: 'variable', name: 'VAR' })
  })

  it('p=$VAR as an ordinary arg (not command-leading) is one argument, not an assignment', () => {
    const cmd = firstCmd('echo p=$VAR')
    expect(cmd.assignments).toBeUndefined()
    expect(cmd.args).toHaveLength(1)
  })

  it('word glued to a substitution ($(x).txt) is one argument', () => {
    const cmd = firstCmd('echo $(x).txt')
    expect(cmd.args).toHaveLength(1)
    const q = cmd.args[0] as QuotedArg
    expect(q.parts[0].type).toBe('substitution')
    expect(q.parts[1]).toEqual({ type: 'literal', value: '.txt' })
  })

  it('all-literal glued runs collapse back to a single literal (glob still possible)', () => {
    const cmd = firstCmd('echo a\\;b')
    expect(cmd.args).toEqual([{ type: 'literal', value: 'a;b' }])
  })

  it('spaced arguments are NOT joined', () => {
    const cmd = firstCmd('echo a $VAR')
    expect(cmd.args).toHaveLength(2)
  })

  it('a glued fd digit before a redirect is still an fd, not an argument (cmd 2>f)', () => {
    const cmd = firstCmd('cmd 2>f')
    expect(cmd.args).toEqual([])
    expect(cmd.redirects).toEqual([{ type: 'out', target: 'f', fd: 2 }])
  })

  it('leading VAR=$? assignment still parses as an assignment', () => {
    const cmd = firstCmd('VAR=$? cmd')
    expect(cmd.name).toBe('cmd')
    expect(cmd.assignments).toEqual([
      { name: 'VAR', value: [{ type: 'variable', name: '?' }] },
    ])
  })
})

// ── Errors ──

describe('parser — errors', () => {
  it('throws ParseError for missing redirect target', () => {
    expect(() => parse('echo >')).toThrow(ParseError)
  })
})
