import { describe, it, expect, vi } from 'vitest'
import { parse, ParseError } from '../../../src/main/tools/shell/parser/parser'
import { ShellTool } from '../../../src/main/tools/shell/shell.tool'

/**
 * Heredoc tags — DATA LOSS reproduction.
 *
 * `cat > mind.md << 'EOF' … EOF` is ordinary bash, but the tokenizer only
 * accepted a tag GLUED to `<<`. With a space it produced an EMPTY tag, the
 * quoted tag became an argument (`cat EOF`), the body collapsed to its first
 * line, and the rest of the input was silently dropped. cat then failed on a
 * missing file "EOF" — while the `> mind.md` redirect still ran and truncated
 * a 42KB mind.md to zero bytes.
 *
 * Two defenses, both pinned here: the spaced form parses correctly, and a
 * tagless heredoc is a ParseError so NOTHING executes (a parse failure cannot
 * truncate a redirect target).
 */

describe('heredoc tag parsing', () => {
  it('accepts a space before the tag, quoted and unquoted', () => {
    for (const cmd of ["cat << 'EOF'\nbody line\nEOF\n", 'cat << EOF\nbody line\nEOF\n', "cat <<'EOF'\nbody line\nEOF\n", 'cat <<EOF\nbody line\nEOF\n']) {
      const node = parse(cmd) as any
      const command = node.stages[0]
      expect(command.name).toBe('cat')
      expect(command.args).toEqual([])          // the tag is NOT an argument
      expect(command.heredoc?.tag).toBe('EOF')
      expect(command.heredoc?.content).toBe('body line')
    }
  })

  it('keeps the quoted-tag distinction (literal body) with a space', () => {
    expect((parse("cat << 'EOF'\n$HOME\nEOF\n") as any).stages[0].heredoc.quoted).toBe(true)
    expect((parse('cat << EOF\n$HOME\nEOF\n') as any).stages[0].heredoc.quoted).toBeUndefined()
  })

  it('parses the exact reported command: redirect before the heredoc', () => {
    const node = parse("cat > mind.md << 'EOF'\n# Rootstock mind\n- Direct. Short.\nEOF\n") as any
    const command = node.stages[0]
    expect(command.redirects).toEqual([{ type: 'out', target: 'mind.md' }])
    expect(command.heredoc.tag).toBe('EOF')
    expect(command.heredoc.content).toBe('# Rootstock mind\n- Direct. Short.')
    expect(command.args).toEqual([])
  })

  it('a tagless heredoc is a parse error, not an empty one', () => {
    expect(() => parse('cat <<\n')).toThrow(ParseError)
    expect(() => parse('cat <<\n')).toThrow(/heredoc needs a tag/)
  })

  // parseShell also refuses leftover tokens now. No input reaches that guard
  // today — the mangled heredoc did, by leaving a stray body token behind — so
  // it is a net for the next tokenizer change, not a behavior to pin here.
})

// ── End to end: the write that was lost ──

function makeShell() {
  const writes: Array<{ path: string; content: string }> = []
  const files: Record<string, string> = { 'mind.md': 'ORIGINAL 42KB OF MIND' }
  const fakeRegistry: any = {
    executeTool: vi.fn(async (name: string, input: any) => {
      if (name === 'fs_write') {
        writes.push({ path: input.path, content: input.content })
        files[input.path] = input.content
        return { content: 'OK', isError: false }
      }
      if (name === 'fs_read') {
        const c = files[input.path]
        if (c === undefined) return { content: `File not found: "${input.path}"`, isError: true }
        return { content: JSON.stringify({ path: input.path, content: c, mime_type: 'text/markdown', size: c.length }), isError: false }
      }
      return { content: '', isError: false }
    }),
    get: () => undefined,
    getAll: () => [],
  }
  const fakeWorkspace: any = {
    insertLog: () => {},
    insertTask: () => {},
    listFiles: () => Object.keys(files).map(p => ({ path: p, size: files[p].length, mime_type: 'text/markdown' })),
    readFile: (p: string) => files[p] ?? null,
  }
  const config: any = {
    name: 'agent-1',
    tools: ['adf_shell', 'fs_write', 'fs_read', 'fs_list'].map(name => ({ name, enabled: true, restricted: false })),
    limits: { execution_timeout_ms: 5000 },
  }
  return { shell: new ShellTool(fakeRegistry, fakeWorkspace, config, null), fakeWorkspace, writes, files }
}

async function run(shell: ShellTool, ws: any, command: string) {
  return JSON.parse((await shell.execute({ command }, ws)).content as string)
}

describe('silent-failure siblings from the same session', () => {
  it('grep rejects BRE escapes instead of matching nothing', async () => {
    const { shell, fakeWorkspace } = makeShell()
    const r = await run(shell, fakeWorkspace, `grep -n '^#\\|^## ' mind.md`)
    expect(r.exit_code).not.toBe(0)
    expect(r.stderr).toContain('BRE syntax')
    expect(r.stderr).toContain('-F')
  })

  it('the ERE form works, and -F keeps a literal pipe usable', async () => {
    const { shell, fakeWorkspace } = makeShell()
    const ere = await run(shell, fakeWorkspace, `echo '# head' | grep '^#|^## '`)
    expect(ere.exit_code).toBe(0)
    expect(ere.stdout).toContain('# head')
    // -F takes the bare character (it escapes the pattern for you).
    const literal = await run(shell, fakeWorkspace, `echo 'a|b' | grep -F '|'`)
    expect(literal.exit_code).toBe(0)
    expect(literal.stdout).toContain('a|b')
    const klass = await run(shell, fakeWorkspace, `echo 'a|b' | grep '[|]'`)
    expect(klass.exit_code).toBe(0)
  })

  it('mkdir is a no-op that explains the flat VFS instead of "command not found"', async () => {
    const { shell, fakeWorkspace } = makeShell()
    const r = await run(shell, fakeWorkspace, 'mkdir -p archive')
    expect(r.exit_code).toBe(0)                 // was 127 — halted scripts mid-pipeline
    expect(r.stderr).toContain('flat')
    const chained = await run(shell, fakeWorkspace, 'mkdir -p archive 2>/dev/null; echo went-on')
    expect(chained.stdout).toContain('went-on')
  })
})

describe('heredoc write end to end', () => {
  it('`cat > file << TAG` writes the body (was: truncated the file to empty)', async () => {
    const { shell, fakeWorkspace, writes, files } = makeShell()
    const r = await run(shell, fakeWorkspace, "cat > mind.md << 'EOF'\n# Compact mind\n- Rule one\nEOF\n")
    expect(r.exit_code).toBe(0)
    expect(writes).toHaveLength(1)
    expect(writes[0].path).toBe('mind.md')
    expect(files['mind.md']).toContain('# Compact mind')
    expect(files['mind.md']).toContain('- Rule one')
  })

  it('a malformed heredoc does not truncate the redirect target', async () => {
    const { shell, fakeWorkspace, writes, files } = makeShell()
    const r = await run(shell, fakeWorkspace, 'cat > mind.md <<\nsome body\n')
    expect(r.exit_code).not.toBe(0)
    expect(r.stderr).toContain('heredoc needs a tag')
    expect(writes).toEqual([])                             // fs_write never ran
    expect(files['mind.md']).toBe('ORIGINAL 42KB OF MIND')  // content intact
  })
})
