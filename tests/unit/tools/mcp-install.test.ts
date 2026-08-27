import { describe, expect, it, vi } from 'vitest'
import { McpInstallTool } from '../../../src/main/tools/built-in/mcp-install.tool'

describe('McpInstallTool', () => {
  it('derives a useful server name for Playwright MCP installs', async () => {
    const config: any = { mcp: { servers: [] } }
    const workspace = {
      getAgentConfig: vi.fn(() => config),
      setAgentConfig: vi.fn(),
      setIdentity: vi.fn(),
    }
    const tool = new McpInstallTool(vi.fn().mockResolvedValue({ toolsDiscovered: 21 }))

    const result = await tool.execute({ package: '@playwright/mcp', type: 'npm' }, workspace as any)
    const content = JSON.parse(result.content)

    expect(content.name).toBe('playwright')
    expect(config.mcp.servers[0]).toEqual(expect.objectContaining({
      name: 'playwright',
      npm_package: '@playwright/mcp',
    }))
    expect(config.compute).toEqual(expect.objectContaining({ enabled: true, browser: true }))
  })

  it('refuses env credentials when the credentials envelope is locked (never plaintext)', async () => {
    const config: any = { mcp: { servers: [] } }
    const workspace = {
      getAgentConfig: vi.fn(() => config),
      setAgentConfig: vi.fn(),
      setIdentity: vi.fn(),
      getEnvelopeState: vi.fn(() => 'locked'),
    }
    const connect = vi.fn().mockResolvedValue({ toolsDiscovered: 3 })
    const tool = new McpInstallTool(connect)

    const result = await tool.execute({
      package: '@x/gh', type: 'npm', name: 'gh',
      env: { GH_TOKEN: 'secret-token' },
    }, workspace as any)
    const content = JSON.parse(result.content)

    expect(result.isError).toBe(true)
    expect(content).toEqual(expect.objectContaining({ success: false, configured: true }))
    expect(content.error).toMatch(/locked.*refusing to store env credential\(s\) GH_TOKEN in plaintext/s)
    expect(workspace.setIdentity).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled() // connect skipped so the refusal surfaces unmasked
    expect(config.mcp.servers).toHaveLength(1) // declaration still persisted
  })

  it('keeps the legacy plaintext contract for pre-envelope files (envelope absent)', async () => {
    const config: any = { mcp: { servers: [] } }
    const workspace = {
      getAgentConfig: vi.fn(() => config),
      setAgentConfig: vi.fn(),
      setIdentity: vi.fn(),
      getEnvelopeState: vi.fn(() => 'absent'),
    }
    const tool = new McpInstallTool(vi.fn().mockResolvedValue({ toolsDiscovered: 1 }))

    const result = await tool.execute({
      package: '@x/gh', type: 'npm', name: 'gh',
      env: { GH_TOKEN: 'secret-token' },
    }, workspace as any)

    expect(result.isError).toBe(false)
    expect(workspace.setIdentity).toHaveBeenCalledWith('mcp:gh:GH_TOKEN', 'secret-token')
  })

  it('reports a saved server as failed when immediate discovery cannot connect', async () => {
    const config: any = {
      compute: { enabled: true },
      mcp: { servers: [] },
    }
    const workspace = {
      getAgentConfig: vi.fn(() => config),
      setAgentConfig: vi.fn(),
      setIdentity: vi.fn(),
    }
    const tool = new McpInstallTool(vi.fn().mockRejectedValue(
      new Error('MCP container for "puppeteer" is not ready: container state improper'),
    ))

    const result = await tool.execute({
      package: '@modelcontextprotocol/server-puppeteer',
      type: 'npm',
    }, workspace as any)
    const content = JSON.parse(result.content)

    expect(result.isError).toBe(true)
    expect(content).toEqual(expect.objectContaining({
      success: false,
      configured: true,
      name: 'puppeteer',
      location: 'isolated container',
      tools_discovered: 0,
      error: expect.stringContaining('container state improper'),
    }))
    expect(config.mcp.servers).toHaveLength(1)
  })
})

describe('McpInstallTool attach mode (Settings registrations)', () => {
  const regs = () => [
    { id: '1', name: 'github', type: 'npm' as const, npmPackage: '@x/gh', runLocation: 'shared' as const,
      env: [{ key: 'GH_TOKEN', value: 'v' }] },
    { id: '2', name: 'drive', type: 'npm' as const, npmPackage: '@x/drive', runLocation: 'host' as const,
      agentVisible: true, auth: true, authArgs: ['auth'],
      credentialFiles: [{ path: '~/.x/keys.json', required: true }] },
    { id: '3', name: 'files', type: 'npm' as const, npmPackage: '@x/fs', runLocation: 'host' as const }, // invisible (host default)
  ]

  function ws() {
    const config: any = { mcp: { servers: [] } }
    return {
      config,
      workspace: {
        getAgentConfig: vi.fn(() => config),
        setAgentConfig: vi.fn(),
        setIdentity: vi.fn(),
      },
    }
  }

  it('attaches a visible registration by package instead of installing', async () => {
    const { config, workspace } = ws()
    const connect = vi.fn().mockResolvedValue({ toolsDiscovered: 7, location: 'shared container' })
    const tool = new McpInstallTool(connect, regs)

    const result = await tool.execute({ package: '@x/gh', type: 'npm' }, workspace as any)
    const content = JSON.parse(result.content)

    expect(content).toEqual(expect.objectContaining({ success: true, attached_existing: true, name: 'github' }))
    expect(content.message).toMatch(/Attached existing server/)
    expect(config.mcp.servers[0]).toEqual(expect.objectContaining({
      name: 'github',
      npm_package: '@x/gh',
      run_location: 'shared',
    }))
    expect(connect).toHaveBeenCalledWith('github', { auth: undefined, authArgs: undefined, authPort: undefined })
  })

  it('attaches by name, carries run_location host and the registration auth flow', async () => {
    const { config, workspace } = ws()
    const connect = vi.fn().mockResolvedValue({ toolsDiscovered: 3, location: 'host' })
    const tool = new McpInstallTool(connect, regs)

    const result = await tool.execute({ package: '@piotr/other-drive', type: 'npm', name: 'drive' }, workspace as any)
    const content = JSON.parse(result.content)

    expect(content.attached_existing).toBe(true)
    expect(config.mcp.servers[0]).toEqual(expect.objectContaining({
      name: 'drive',
      npm_package: '@x/drive',      // the REGISTRATION's package, not the requested one
      run_location: 'host',
      credential_files: [{ path: '~/.x/keys.json', required: true }],
    }))
    // Registration-declared auth inherited when the caller passes none
    expect(connect).toHaveBeenCalledWith('drive', { auth: true, authArgs: ['auth'], authPort: undefined })
  })

  it('refuses an invisible registration with a plain error instead of duplicating it', async () => {
    const { config, workspace } = ws()
    const connect = vi.fn()
    const tool = new McpInstallTool(connect, regs)

    const result = await tool.execute({ package: '@x/fs', type: 'npm' }, workspace as any)
    const content = JSON.parse(result.content)

    expect(result.isError).toBe(true)
    expect(content.error).toMatch(/not made available to agents.*Available to agents/s)
    expect(config.mcp.servers).toHaveLength(0)
    expect(connect).not.toHaveBeenCalled()
  })

  it('still installs fresh when no registration matches', async () => {
    const { config, workspace } = ws()
    const connect = vi.fn().mockResolvedValue({ toolsDiscovered: 2 })
    const tool = new McpInstallTool(connect, regs)

    const result = await tool.execute({ package: '@brand/new-mcp', type: 'npm' }, workspace as any)
    const content = JSON.parse(result.content)

    expect(content.success).toBe(true)
    expect(content.attached_existing).toBeUndefined()
    expect(config.mcp.servers[0]).toEqual(expect.objectContaining({ npm_package: '@brand/new-mcp' }))
  })

  it('reports already_installed when the registration is attached twice', async () => {
    const { config, workspace } = ws()
    config.mcp.servers.push({ name: 'github' })
    const tool = new McpInstallTool(vi.fn(), regs)

    const result = await tool.execute({ package: '@x/gh', type: 'npm' }, workspace as any)
    const content = JSON.parse(result.content)
    expect(content).toEqual(expect.objectContaining({ success: true, already_installed: true, name: 'github' }))
  })

  it('re-install with env on an existing server stores the credentials (not a dead no-op)', async () => {
    const { config, workspace } = ws()
    config.mcp.servers.push({ name: 'gh', npm_package: '@x/gh' })
    ;(workspace as any).getEnvelopeState = vi.fn(() => 'unlocked')
    const tool = new McpInstallTool(vi.fn())

    const result = await tool.execute({
      package: '@x/gh', type: 'npm', name: 'gh', env: { GH_TOKEN: 'tok' },
    }, workspace as any)
    const content = JSON.parse(result.content)
    expect(content).toEqual(expect.objectContaining({ success: true, already_installed: true, credentials_updated: true }))
    expect(workspace.setIdentity).toHaveBeenCalledWith('mcp:gh:GH_TOKEN', 'tok')
    expect(config.mcp.servers[0].env_keys).toContain('GH_TOKEN')
  })

  it('re-install with credential_files on an existing server merges declarations and seals content (no silent drop)', async () => {
    const { config, workspace } = ws()
    config.mcp.servers.push({
      name: 'gcal', npm_package: '@x/gcal',
      credential_files: [{ path: '/workspace/.config/old/keys.json', required: true }],
    })
    ;(workspace as any).setIdentitySealed = vi.fn()
    const connect = vi.fn()
    const tool = new McpInstallTool(connect)

    const result = await tool.execute({
      package: '@x/gcal', type: 'npm', name: 'gcal',
      credential_files: [{ path: '/workspace/.config/new/keys.json', required: true, content: '{"k":1}' }],
    }, workspace as any)
    const content = JSON.parse(result.content)

    expect(result.isError).toBe(false)
    expect(content).toEqual(expect.objectContaining({
      success: true, already_installed: true, credentials_updated: true,
      credential_files_sealed: ['/workspace/.config/new/keys.json'],
    }))
    expect(content.message).toMatch(/mcp_restart/)
    // Declarations merged by path — the old one is kept, the new one added.
    expect(config.mcp.servers[0].credential_files).toEqual([
      { path: '/workspace/.config/old/keys.json', required: true },
      { path: '/workspace/.config/new/keys.json', required: true },
    ])
    expect((workspace as any).setIdentitySealed).toHaveBeenCalledWith(
      'mcp:@x/gcal:file:/workspace/.config/new/keys.json', expect.any(String),
    )
    expect(connect).not.toHaveBeenCalled() // no auth requested → no reconnect
  })

  it('re-install with auth:true on an existing server re-runs the auth preflight + reconnect (not a dead fast-path)', async () => {
    const { config, workspace } = ws()
    config.mcp.servers.push({ name: 'gcal', npm_package: '@x/gcal' })
    const connect = vi.fn().mockResolvedValue({ toolsDiscovered: 7 })
    const tool = new McpInstallTool(connect)

    const result = await tool.execute({
      package: '@x/gcal', type: 'npm', name: 'gcal', auth: true, auth_args: ['auth'],
    }, workspace as any)
    const content = JSON.parse(result.content)

    expect(result.isError).toBe(false)
    expect(connect).toHaveBeenCalledWith('gcal', { auth: true, authArgs: ['auth'], authPort: undefined })
    expect(content).toEqual(expect.objectContaining({
      success: true, already_installed: true, reauthorized: true, tools_discovered: 7,
    }))
  })

  it('re-install with auth:true reports persisted state when the auth flow fails', async () => {
    const { config, workspace } = ws()
    config.mcp.servers.push({ name: 'gcal', npm_package: '@x/gcal' })
    const connect = vi.fn().mockRejectedValue(new Error('Interactive MCP authorization timed out after 300s'))
    const tool = new McpInstallTool(connect)

    const result = await tool.execute({
      package: '@x/gcal', type: 'npm', name: 'gcal', auth: true,
    }, workspace as any)
    const content = JSON.parse(result.content)

    expect(result.isError).toBe(true)
    expect(content).toEqual(expect.objectContaining({
      success: false, already_installed: true, configured: true,
      error: expect.stringContaining('timed out'),
    }))
    expect(content.message).toMatch(/persist/)
    expect(config.mcp.servers).toHaveLength(1) // registration untouched
  })

  it('fresh-install connect failure enumerates what persisted (registration + sealed files)', async () => {
    const { config, workspace } = ws()
    ;(workspace as any).setIdentitySealed = vi.fn()
    const connect = vi.fn().mockRejectedValue(new Error('auth timed out'))
    const tool = new McpInstallTool(connect)

    const result = await tool.execute({
      package: '@x/gcal', type: 'npm', name: 'gcal', auth: true,
      credential_files: [{ path: '/workspace/.config/gcal/keys.json', content: '{}' }],
    }, workspace as any)
    const content = JSON.parse(result.content)

    expect(result.isError).toBe(true)
    expect(content.persisted).toEqual({
      registration: true,
      credential_files_sealed: ['/workspace/.config/gcal/keys.json'],
    })
    expect(content.message).toMatch(/nothing was rolled back/i)
    expect(config.mcp.servers).toHaveLength(1)
  })

  it('re-install with env on an existing server refuses plaintext on a locked envelope', async () => {
    const { config, workspace } = ws()
    config.mcp.servers.push({ name: 'gh', npm_package: '@x/gh' })
    ;(workspace as any).getEnvelopeState = vi.fn(() => 'locked')
    const tool = new McpInstallTool(vi.fn())

    const result = await tool.execute({
      package: '@x/gh', type: 'npm', name: 'gh', env: { GH_TOKEN: 'tok' },
    }, workspace as any)
    const content = JSON.parse(result.content)
    expect(result.isError).toBe(true)
    expect(content.error).toMatch(/locked.*refusing to store/s)
    expect(workspace.setIdentity).not.toHaveBeenCalled()
  })
})
