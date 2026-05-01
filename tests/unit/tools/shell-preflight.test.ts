import { describe, it, expect, vi } from 'vitest'
import { parse } from '../../../src/main/tools/shell/parser/parser'
import { collectResolvedTools, preflight } from '../../../src/main/tools/shell/executor/preflight'

// ── 1. collectResolvedTools — static tool resolution ──

describe('collectResolvedTools', () => {
  it('resolves cat to fs_read', () => {
    const ast = parse('cat foo.txt')
    const tools = collectResolvedTools(ast)
    expect(tools).toContain('fs_read')
  })

  it('deduplicates tools across pipeline stages', () => {
    // cat and grep both use fs_read
    const ast = parse('cat foo | grep bar')
    const tools = collectResolvedTools(ast)
    const fsReadCount = tools.filter(t => t === 'fs_read').length
    expect(fsReadCount).toBe(1)
  })

  it('adds fs_write for output redirect', () => {
    const ast = parse('echo hello > out.txt')
    const tools = collectResolvedTools(ast)
    expect(tools).toContain('fs_write')
  })

  it('adds fs_write for append redirect', () => {
    const ast = parse('echo hello >> out.txt')
    const tools = collectResolvedTools(ast)
    expect(tools).toContain('fs_write')
  })

  it('adds fs_read for input redirect', () => {
    const ast = parse('grep foo < in.txt')
    const tools = collectResolvedTools(ast)
    expect(tools).toContain('fs_read')
  })

  it('walks both sides of a chain', () => {
    const ast = parse('cat foo.txt && echo done > out.txt')
    const tools = collectResolvedTools(ast)
    expect(tools).toContain('fs_read')
    expect(tools).toContain('fs_write')
  })

  it('resolves sqlite3 to db_query and db_execute', () => {
    const ast = parse('sqlite3 "SELECT 1"')
    const tools = collectResolvedTools(ast)
    expect(tools).toContain('db_query')
    expect(tools).toContain('db_execute')
  })
})

// ── 2. collectResolvedTools — dynamic MCP tool resolution ──

describe('collectResolvedTools with MCP dynamic resolution', () => {
  it('collects tools from resolveToolsFromArgs', async () => {
    // Use the real mcp handler which has resolveToolsFromArgs
    const ast = parse('mcp myserver mytool')
    const tools = collectResolvedTools(ast)
    // MCP handler uses resolveToolsFromArgs to build tool names from args
    expect(tools).toEqual(expect.arrayContaining([expect.stringContaining('mcp_')]))
  })
})

// ── 3. preflight — disabled tool ──

describe('preflight — disabled tool', () => {
  it('returns exit 126 when a resolved tool is disabled', () => {
    const ast = parse('cat foo.txt')
    const config: any = {
      tools: [{ name: 'fs_read', enabled: false, visible: false }],
      triggers: {},
    }
    const workspace: any = { insertTask: vi.fn() }

    const result = preflight(ast, config, workspace, 'cat foo.txt')

    expect(result.allowed).toBe(false)
    expect(result.exit_code).toBe(126)
    expect(result.stderr).toContain('fs_read')
    expect(result.stderr).toContain('disabled')
  })
})

// ── 4. preflight — approval required (HIL) ──

describe('preflight — approval required', () => {
  it('returns exit 130 with approval_required list for HIL tools', () => {
    const ast = parse('echo x > out.txt')
    const config: any = {
      tools: [{ name: 'fs_write', enabled: true, visible: true, restricted: true }],
      triggers: {},
    }
    const workspace: any = { insertTask: vi.fn() }

    const result = preflight(ast, config, workspace, 'echo x > out.txt')

    expect(result.allowed).toBe(false)
    expect(result.exit_code).toBe(130)
    expect(result.approval_required).toContain('fs_write')
  })
})

// ── 5. preflight — MCP server-level restricted ──

describe('preflight — MCP server restricted', () => {
  it('flags MCP tools whose server requires approval', () => {
    // Build an AST that resolves to mcp_myserver_query
    // We need to simulate this — use a simple pipeline with a single command
    // whose resolved tools include an MCP tool name.
    // Since we can't easily get mcp handler to resolve a specific tool name
    // without more setup, test this by constructing a minimal AST manually.
    const ast: any = {
      kind: 'pipeline',
      stages: [{
        kind: 'command',
        name: 'mcp',
        args: [{ type: 'literal', value: 'myserver' }, { type: 'literal', value: 'query' }],
        redirects: [],
      }],
    }
    const config: any = {
      tools: [],
      mcp: { servers: [{ name: 'myserver', restricted: true }] },
      triggers: {},
    }
    const workspace: any = { insertTask: vi.fn() }

    const result = preflight(ast, config, workspace, 'mcp myserver query')

    expect(result.allowed).toBe(false)
    expect(result.exit_code).toBe(130)
    expect(result.approval_required).toEqual(
      expect.arrayContaining([expect.stringContaining('mcp_myserver')])
    )
  })
})

// ── 6. preflight — on_tool_call trigger interception ──

describe('preflight — on_tool_call trigger interception', () => {
  it('returns exit 130 with intercepted_tools and creates a task', () => {
    const ast = parse('cat foo.txt')
    const config: any = {
      tools: [{ name: 'fs_read', enabled: true, visible: true }],
      triggers: {
        on_tool_call: {
          enabled: true,
          targets: [{ filter: { tools: ['fs_*'] } }],
        },
      },
    }
    const workspace: any = { insertTask: vi.fn() }

    const result = preflight(ast, config, workspace, 'cat foo.txt')

    expect(result.allowed).toBe(false)
    expect(result.exit_code).toBe(130)
    expect(result.intercepted_tools).toContain('fs_read')
    expect(result.task_id).toBeDefined()
    expect(result.status).toBe('pending')
    expect(workspace.insertTask).toHaveBeenCalledOnce()
  })

  it('task creation failure does not prevent interception result', () => {
    const ast = parse('cat foo.txt')
    const config: any = {
      tools: [{ name: 'fs_read', enabled: true, visible: true }],
      triggers: {
        on_tool_call: {
          enabled: true,
          targets: [{ filter: { tools: ['fs_*'] } }],
        },
      },
    }
    const workspace: any = {
      insertTask: vi.fn(() => { throw new Error('DB error') }),
    }

    const result = preflight(ast, config, workspace, 'cat foo.txt')

    // Should still return interception result despite task creation failure
    expect(result.allowed).toBe(false)
    expect(result.exit_code).toBe(130)
    expect(result.intercepted_tools).toContain('fs_read')
  })
})

// ── 7. preflight — approval takes precedence over interception ──

describe('preflight — approval precedence', () => {
  it('returns approval_required without creating a task when both apply', () => {
    const ast = parse('cat foo.txt')
    const config: any = {
      tools: [{ name: 'fs_read', enabled: true, visible: true, restricted: true }],
      triggers: {
        on_tool_call: {
          enabled: true,
          targets: [{ filter: { tools: ['fs_*'] } }],
        },
      },
    }
    const workspace: any = { insertTask: vi.fn() }

    const result = preflight(ast, config, workspace, 'cat foo.txt')

    expect(result.allowed).toBe(false)
    expect(result.exit_code).toBe(130)
    expect(result.approval_required).toContain('fs_read')
    // Task should NOT be created when approval takes precedence
    expect(workspace.insertTask).not.toHaveBeenCalled()
  })
})

// ── 8. preflight — no restrictions → allowed ──

describe('preflight — allowed', () => {
  it('returns allowed when no tools are restricted', () => {
    const ast = parse('echo hello')
    const config: any = {
      tools: [],
      triggers: {},
    }
    const workspace: any = { insertTask: vi.fn() }

    const result = preflight(ast, config, workspace, 'echo hello')

    expect(result.allowed).toBe(true)
  })

  it('returns allowed for enabled tool without approval requirement', () => {
    const ast = parse('cat foo.txt')
    const config: any = {
      tools: [{ name: 'fs_read', enabled: true, visible: true }],
      triggers: {},
    }
    const workspace: any = { insertTask: vi.fn() }

    const result = preflight(ast, config, workspace, 'cat foo.txt')

    expect(result.allowed).toBe(true)
  })
})

// ── 9. preflight — glob pattern matching in trigger filter ──

describe('preflight — trigger filter glob patterns', () => {
  it('fs_* matches fs_read, fs_write, fs_delete', () => {
    // Test with redirect-heavy command that resolves multiple fs_ tools
    const ast = parse('cat foo.txt > out.txt')
    const config: any = {
      tools: [
        { name: 'fs_read', enabled: true, visible: true },
        { name: 'fs_write', enabled: true, visible: true },
      ],
      triggers: {
        on_tool_call: {
          enabled: true,
          targets: [{ filter: { tools: ['fs_*'] } }],
        },
      },
    }
    const workspace: any = { insertTask: vi.fn() }

    const result = preflight(ast, config, workspace, 'cat foo.txt > out.txt')

    expect(result.intercepted_tools).toContain('fs_read')
    expect(result.intercepted_tools).toContain('fs_write')
  })

  it('exact match db_query matches only db_query', () => {
    const ast = parse('sqlite3 "SELECT 1"')
    const config: any = {
      tools: [
        { name: 'db_query', enabled: true, visible: true },
        { name: 'db_execute', enabled: true, visible: true },
      ],
      triggers: {
        on_tool_call: {
          enabled: true,
          targets: [{ filter: { tools: ['db_query'] } }],
        },
      },
    }
    const workspace: any = { insertTask: vi.fn() }

    const result = preflight(ast, config, workspace, 'sqlite3 "SELECT 1"')

    expect(result.intercepted_tools).toContain('db_query')
    expect(result.intercepted_tools).not.toContain('db_execute')
  })

  it('disabled trigger does not intercept', () => {
    const ast = parse('cat foo.txt')
    const config: any = {
      tools: [{ name: 'fs_read', enabled: true, visible: true }],
      triggers: {
        on_tool_call: {
          enabled: false,
          targets: [{ filter: { tools: ['fs_*'] } }],
        },
      },
    }
    const workspace: any = { insertTask: vi.fn() }

    const result = preflight(ast, config, workspace, 'cat foo.txt')

    expect(result.allowed).toBe(true)
  })
})
