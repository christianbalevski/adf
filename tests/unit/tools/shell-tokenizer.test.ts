import { describe, it, expect } from 'vitest'
import { tokenize, parseBracedExpansion } from '../../../src/main/tools/shell/parser/tokenizer'
import type { Token } from '../../../src/main/tools/shell/parser/tokenizer'

/** Helper: extract [type, value] pairs, excluding eof */
function types(tokens: Token[]): Array<[string, string]> {
  return tokens.filter(t => t.type !== 'eof').map(t => [t.type, t.value])
}

/** Helper: get just token types, excluding eof */
function typeList(tokens: Token[]): string[] {
  return tokens.filter(t => t.type !== 'eof').map(t => t.type)
}

// ── Basic words ──

describe('tokenizer — basic words', () => {
  it('tokenizes simple words', () => {
    const tokens = tokenize('echo hello world')
    expect(types(tokens)).toEqual([
      ['word', 'echo'],
      ['word', 'hello'],
      ['word', 'world'],
    ])
  })

  it('always ends with eof', () => {
    const tokens = tokenize('echo')
    expect(tokens[tokens.length - 1].type).toBe('eof')
  })

  it('handles empty input', () => {
    const tokens = tokenize('')
    expect(tokens).toHaveLength(1)
    expect(tokens[0].type).toBe('eof')
  })
})

// ── Operators ──

describe('tokenizer — operators', () => {
  it('tokenizes pipe', () => {
    const tokens = tokenize('cat f | grep x')
    expect(typeList(tokens)).toContain('pipe')
  })

  it('tokenizes && and ||', () => {
    const tokens = tokenize('a && b || c')
    const tl = typeList(tokens)
    expect(tl).toContain('and')
    expect(tl).toContain('or')
  })

  it('tokenizes semicolons', () => {
    const tokens = tokenize('a; b')
    expect(typeList(tokens)).toContain('semi')
  })

  it('tokenizes redirect operators', () => {
    expect(typeList(tokenize('echo x > f'))).toContain('redirect_out')
    expect(typeList(tokenize('echo x >> f'))).toContain('redirect_append')
    expect(typeList(tokenize('cat < f'))).toContain('redirect_in')
  })
})

// ── Variables ──

describe('tokenizer — variables', () => {
  it('tokenizes $VAR', () => {
    const tokens = tokenize('echo $HOME')
    const varToken = tokens.find(t => t.type === 'variable')
    expect(varToken).toBeDefined()
    expect(varToken!.value).toBe('HOME')
  })

  it('tokenizes ${VAR}', () => {
    const tokens = tokenize('echo ${HOME}')
    const varToken = tokens.find(t => t.type === 'variable')
    expect(varToken).toBeDefined()
    expect(varToken!.value).toBe('HOME')
  })

  it('bare $ mid-word becomes word', () => {
    // $ followed by a non-alphanumeric char emits word '$'
    const tokens = tokenize('echo $ foo')
    // The $ is at position where i+1 < len and input[i+1] is space
    // Tokenizer: ch='$', i+1<len → enters variable branch → no valid name → word '$'
    const wordTokens = tokens.filter(t => t.type === 'word')
    expect(wordTokens.some(t => t.value === '$')).toBe(true)
  })
})

// ── Command substitution ──

describe('tokenizer — command substitution', () => {
  it('tokenizes $(cmd)', () => {
    const tokens = tokenize('echo $(whoami)')
    const sub = tokens.find(t => t.type === 'substitution')
    expect(sub).toBeDefined()
    expect(sub!.value).toBe('whoami')
  })

  it('handles nested parentheses', () => {
    const tokens = tokenize('$(echo $(cat f))')
    const sub = tokens.find(t => t.type === 'substitution')
    expect(sub).toBeDefined()
    // Inner content should contain the nested $(cat f)
    expect(sub!.value).toContain('cat f')
  })
})

// ── Quoting ──

describe('tokenizer — quoting', () => {
  it('tokenizes single-quoted strings', () => {
    const tokens = tokenize("echo 'hello world'")
    const sq = tokens.find(t => t.type === 'single_quoted')
    expect(sq).toBeDefined()
    expect(sq!.value).toBe('hello world')
  })

  it('tokenizes double-quoted strings', () => {
    const tokens = tokenize('echo "hello world"')
    const dq = tokens.find(t => t.type === 'double_quoted')
    expect(dq).toBeDefined()
    expect(dq!.value).toBe('hello world')
  })

  it('handles escape sequences in double quotes', () => {
    // \" → "
    const t1 = tokenize('echo "a\\"b"')
    expect(t1.find(t => t.type === 'double_quoted')!.value).toBe('a"b')

    // \\ → backslash
    const t2 = tokenize('echo "a\\\\b"')
    expect(t2.find(t => t.type === 'double_quoted')!.value).toBe('a\\b')

    // \$ → $
    const t3 = tokenize('echo "a\\$b"')
    expect(t3.find(t => t.type === 'double_quoted')!.value).toBe('a$b')
  })

  it('preserves non-escape backslashes in double quotes', () => {
    // \n is NOT a real escape in double quotes — backslash preserved
    const tokens = tokenize('echo "a\\nb"')
    expect(tokens.find(t => t.type === 'double_quoted')!.value).toBe('a\\nb')
  })
})

// ── Heredocs ──

describe('tokenizer — heredocs', () => {
  it('tokenizes basic heredoc', () => {
    const tokens = tokenize('cat <<EOF\nhello\nEOF')
    expect(tokens.find(t => t.type === 'heredoc_marker')!.value).toBe('EOF')
    expect(tokens.find(t => t.type === 'heredoc_body')!.value).toBe('hello')
  })

  it('handles quoted tag', () => {
    const tokens = tokenize("cat <<'EOF'\nhello\nEOF")
    expect(tokens.find(t => t.type === 'heredoc_marker')!.value).toBe('EOF')
    expect(tokens.find(t => t.type === 'heredoc_body')!.value).toBe('hello')
  })

  it('handles unterminated heredoc', () => {
    const tokens = tokenize('cat <<EOF\nhello')
    expect(tokens.find(t => t.type === 'heredoc_body')!.value).toBe('hello')
  })
})

// ── Comments ──

describe('tokenizer — comments', () => {
  it('strips comments', () => {
    const tokens = tokenize('echo a # ignore this')
    const words = tokens.filter(t => t.type === 'word')
    expect(words.map(t => t.value)).toEqual(['echo', 'a'])
  })
})

// ── Backslash escapes ──

describe('tokenizer — backslash escapes', () => {
  it('handles backslash escape outside quotes', () => {
    const tokens = tokenize('echo a\\;b')
    // Escaped semicolon should be treated as literal character
    const words = tokens.filter(t => t.type === 'word')
    expect(words.some(t => t.value.includes(';'))).toBe(true)
  })

  it('handles line continuation', () => {
    const tokens = tokenize('echo hello\\\nworld')
    // Line continuation: backslash-newline is skipped, words join
    const words = tokens.filter(t => t.type === 'word')
    const combined = words.map(t => t.value).join('')
    expect(combined).toContain('hello')
    expect(combined).toContain('world')
  })
})

// ── Bare & ──

describe('tokenizer — bare ampersand', () => {
  it('emits amp token for bare & between commands', () => {
    const tokens = tokenize('echo a & echo b')
    expect(typeList(tokens)).toContain('amp')
  })

  it('drops a trailing & (nothing to background)', () => {
    const tokens = tokenize('sleep 1 &')
    const nonEof = tokens.filter(t => t.type !== 'eof')
    expect(nonEof[nonEof.length - 1].type).not.toBe('amp')
  })

  it('does not emit a spurious semi after & at a newline', () => {
    const tokens = tokenize('echo a &\necho b')
    const tl = typeList(tokens)
    expect(tl.filter(t => t === 'amp')).toHaveLength(1)
    expect(tl).not.toContain('semi')
  })
})

// ── fd duplication ──

describe('tokenizer — fd duplication', () => {
  it('emits redirect_dup for 2>&1', () => {
    const tokens = tokenize('cmd 2>&1')
    expect(types(tokens)).toEqual([
      ['word', 'cmd'],
      ['word', '2'],
      ['redirect_out', '>'],
      ['redirect_dup', '1'],
    ])
  })

  it('emits redirect_dup for >&2', () => {
    const tokens = tokenize('echo err >&2')
    const dup = tokens.find(t => t.type === 'redirect_dup')
    expect(dup).toBeDefined()
    expect(dup!.value).toBe('2')
  })

  it('2>&1 followed by pipe tokenizes cleanly', () => {
    const tokens = tokenize('cmd 2>&1 | head')
    const tl = typeList(tokens)
    expect(tl).toContain('redirect_dup')
    expect(tl).toContain('pipe')
    expect(tl[tl.length - 1]).toBe('word') // head
  })

  it('& before a digit without a preceding redirect is not a dup', () => {
    const tokens = tokenize('echo a & 2')
    expect(typeList(tokens)).toContain('amp')
    expect(typeList(tokens)).not.toContain('redirect_dup')
  })
})

// ── $? and ${VAR:-default} ──

describe('tokenizer — exit status and default expansion', () => {
  it('tokenizes $? as a variable named ?', () => {
    const tokens = tokenize('echo $?')
    const varToken = tokens.find(t => t.type === 'variable')
    expect(varToken).toBeDefined()
    expect(varToken!.value).toBe('?')
  })

  it('tokenizes ${VAR:-default} with op and word', () => {
    const tokens = tokenize('echo ${NAME:-fallback}')
    const varToken = tokens.find(t => t.type === 'variable')!
    expect(varToken.value).toBe('NAME')
    expect(varToken.op).toBe(':-')
    expect(varToken.word).toBe('fallback')
  })

  it('tokenizes ${VAR-default} with op -', () => {
    const tokens = tokenize('echo ${NAME-fallback}')
    const varToken = tokens.find(t => t.type === 'variable')!
    expect(varToken.value).toBe('NAME')
    expect(varToken.op).toBe('-')
    expect(varToken.word).toBe('fallback')
  })

  it('plain ${VAR} has no op', () => {
    const tokens = tokenize('echo ${NAME}')
    const varToken = tokens.find(t => t.type === 'variable')!
    expect(varToken.value).toBe('NAME')
    expect(varToken.op).toBeUndefined()
  })

  it('carries unknown operators through for the parser to reject', () => {
    const tokens = tokenize('echo ${NAME:=x}')
    const varToken = tokens.find(t => t.type === 'variable')!
    expect(varToken.value).toBe('NAME')
    expect(varToken.op).toBe(':=')
  })
})

describe('parseBracedExpansion', () => {
  it('splits name, op, and word', () => {
    expect(parseBracedExpansion('VAR')).toEqual({ name: 'VAR' })
    expect(parseBracedExpansion('VAR:-def')).toEqual({ name: 'VAR', op: ':-', word: 'def' })
    expect(parseBracedExpansion('VAR-def')).toEqual({ name: 'VAR', op: '-', word: 'def' })
    expect(parseBracedExpansion('VAR:-a-b:c')).toEqual({ name: 'VAR', op: ':-', word: 'a-b:c' })
  })

  it('keeps invalid content whole as the name', () => {
    expect(parseBracedExpansion('1abc')).toEqual({ name: '1abc' })
  })
})

// ── Heredoc quoted flag ──

describe('tokenizer — heredoc quoting', () => {
  it("marks <<'EOF' as quoted", () => {
    const tokens = tokenize("cat <<'EOF'\n$FOO\nEOF")
    const marker = tokens.find(t => t.type === 'heredoc_marker')!
    expect(marker.quoted).toBe(true)
  })

  it('leaves <<EOF unquoted', () => {
    const tokens = tokenize('cat <<EOF\n$FOO\nEOF')
    const marker = tokens.find(t => t.type === 'heredoc_marker')!
    expect(marker.quoted).toBeUndefined()
  })
})

// ── Glued tokens ──

describe('tokenizer — glued tokens', () => {
  it('marks a quoted token glued to the previous word', () => {
    const tokens = tokenize('VAR="a b" cmd')
    const dq = tokens.find(t => t.type === 'double_quoted')!
    expect(dq.glued).toBe(true)
  })

  it('does not mark separated tokens as glued', () => {
    const tokens = tokenize('echo "a b"')
    const dq = tokens.find(t => t.type === 'double_quoted')!
    expect(dq.glued).toBeUndefined()
  })

  it('marks a variable glued to the previous word', () => {
    const tokens = tokenize('VAR=$HOME cmd')
    const varToken = tokens.find(t => t.type === 'variable')!
    expect(varToken.glued).toBe(true)
  })
})

// ── Trailing semicolons and newlines ──

describe('tokenizer — trailing semicolons and newlines', () => {
  it('strips trailing semicolons', () => {
    const tokens = tokenize('echo a;')
    // Last token before eof should not be semi
    const nonEof = tokens.filter(t => t.type !== 'eof')
    if (nonEof.length > 0) {
      expect(nonEof[nonEof.length - 1].type).not.toBe('semi')
    }
  })

  it('treats newlines as semicolons', () => {
    const tokens = tokenize('echo a\necho b')
    expect(typeList(tokens)).toContain('semi')
  })
})
