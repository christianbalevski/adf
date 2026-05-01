import { describe, it, expect } from 'vitest'
import { tokenize } from '../../../src/main/tools/shell/parser/tokenizer'
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
  it('treats bare & as semicolon', () => {
    const tokens = tokenize('echo a & echo b')
    expect(typeList(tokens)).toContain('semi')
  })

  it('skips &N in fd redirects like 2>&1', () => {
    const tokens = tokenize('cmd 2>&1')
    // &1 should be consumed/skipped
    const words = tokens.filter(t => t.type === 'word')
    // Should not have &1 as a separate word
    expect(words.every(t => !t.value.includes('&'))).toBe(true)
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
