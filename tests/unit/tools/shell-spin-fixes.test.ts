import { describe, it, expect, vi } from 'vitest'
import { ShellTool } from '../../../src/main/tools/shell/shell.tool'

/** Fixes from the live agent spin report: printf arg reuse, silent export,
 *  jq -R raw input, and byte-faithful pipelines. */

function makeShell(vfs: Record<string, string> = {}) {
  const files = { ...vfs }
  const reg: any = {
    executeTool: vi.fn(async (name: string, input: any) => {
      if (name === 'fs_read') {
        if (!(input.path in files)) return { content: 'nf', isError: true }
        return { content: JSON.stringify({ path: input.path, content: files[input.path], mime_type: 'text/plain', size: files[input.path].length }), isError: false }
      }
      if (name === 'fs_write') { files[input.path] = input.content; return { content: 'ok', isError: false } }
      return { content: '{}', isError: false }
    }),
    get: () => undefined, getAll: () => [],
  }
  const ws: any = { insertLog: () => {}, listFiles: () => Object.keys(files).map(p => ({ path: p })), setIdentity: () => {}, getIdentity: () => '' }
  const config: any = { name: 'a', tools: [{ name: 'adf_shell', enabled: true }], limits: { execution_timeout_ms: 5000 } }
  return { shell: new ShellTool(reg, ws, config, null), ws, files }
}
async function run(shell: ShellTool, ws: any, command: string) {
  return JSON.parse((await shell.execute({ command }, ws)).content as string)
}

describe('printf reuses the format over all args (POSIX)', () => {
  it('printf %s\\n a b → two lines', async () => {
    const { shell, ws } = makeShell()
    const r = await run(shell, ws, `printf '%s\\n' hello world | wc -l`)
    expect(r.stdout.trim()).toBe('2')
  })
  it('printf with no conversions prints the format once', async () => {
    const { shell, ws } = makeShell()
    const r = await run(shell, ws, `printf 'literal'`)
    expect(r.stdout).toBe('literal')
  })
})

describe('export is silent', () => {
  it('export does not leak KEY=value to stdout', async () => {
    const { shell, ws } = makeShell()
    const r = await run(shell, ws, `export PROBE='quiet'; printf '%s' "$PROBE"`)
    expect(r.stdout).toBe('quiet') // NOT "PROBE=quiet\nquiet"
  })
})

describe('jq -R raw input', () => {
  it('jq -R reads raw text as a string', async () => {
    const { shell, ws } = makeShell()
    const r = await run(shell, ws, `printf 'hello' | jq -R '.'`)
    expect(r.stdout.trim()).toBe('"hello"')
  })
})

describe('byte-faithful pipelines', () => {
  it('a\\nb\\n through sort preserves the trailing byte (wc -c = 4)', async () => {
    const { shell, ws } = makeShell()
    const r = await run(shell, ws, `printf 'a\\nb\\n' | sort | wc -c`)
    expect(r.stdout.trim()).toBe('4')
  })
  it('through cut preserves trailing byte', async () => {
    const { shell, ws } = makeShell()
    const r = await run(shell, ws, `printf 'a\\nb\\n' | cut -c1 | wc -c`)
    expect(r.stdout.trim()).toBe('4')
  })
})
