import { describe, it, expect } from 'vitest'
import {
  buildEnvSchemaFromKeys,
  resolveMcpEnvVars,
  resolveMcpRequestHeaders,
  resolveMcpSpawnConfig
} from '../../../src/main/services/mcp-spawn-utils'
import { buildMcpServerConfigFromRegistration, isSensitiveMcpHeader } from '../../../src/shared/utils/mcp-config'
import type { McpServerConfig, McpInstalledPackage } from '../../../src/shared/types/adf-v02.types'

// Minimal mock of PackageResolver
function mockNpmResolver(installedPackages: Record<string, McpInstalledPackage> = {}) {
  return {
    getInstalled: (pkg: string) => installedPackages[pkg],
    listInstalled: () => Object.values(installedPackages)
  } as any
}

function mockUvxResolver(installedPackages: Record<string, McpInstalledPackage> = {}) {
  return {
    getInstalled: (pkg: string) => installedPackages[pkg]
  }
}

describe('resolveMcpSpawnConfig', () => {
  describe('npm packages', () => {
    it('resolves managed npm package to node + entry point', () => {
      const serverCfg: McpServerConfig = {
        name: 'test-server',
        transport: 'stdio',
        npm_package: '@scope/server',
        args: []
      }
      const installed: McpInstalledPackage = {
        package: '@scope/server',
        version: '1.0.0',
        command: '/path/to/entry.js',
        installPath: '/path/to/install',
        installedAt: Date.now()
      }
      const result = resolveMcpSpawnConfig(serverCfg, {
        npmResolver: mockNpmResolver({ '@scope/server': installed })
      })
      expect(result.command).toBe('node')
      expect(result.args).toEqual(['/path/to/entry.js'])
    })

    it('falls back to npx for unmanaged npm package', () => {
      const serverCfg: McpServerConfig = {
        name: 'test-server',
        transport: 'stdio',
        npm_package: '@scope/server',
        args: []
      }
      const result = resolveMcpSpawnConfig(serverCfg, {
        npmResolver: mockNpmResolver()
      })
      expect(result.command).toBe('npx')
      expect(result.args).toEqual(['-y', '@scope/server'])
    })

    it('strips npx prefix args from user args', () => {
      const serverCfg: McpServerConfig = {
        name: 'test-server',
        transport: 'stdio',
        npm_package: 'my-server',
        args: ['-y', 'my-server', '--port', '3000']
      }
      const result = resolveMcpSpawnConfig(serverCfg, {
        npmResolver: mockNpmResolver()
      })
      expect(result.command).toBe('npx')
      expect(result.args).toEqual(['-y', 'my-server', '--port', '3000'])
    })

    it('strips entry point from args for managed packages', () => {
      const installed: McpInstalledPackage = {
        package: 'my-server',
        version: '1.0.0',
        command: '/managed/entry.js',
        installPath: '/managed',
        installedAt: Date.now()
      }
      const serverCfg: McpServerConfig = {
        name: 'test-server',
        transport: 'stdio',
        npm_package: 'my-server',
        args: ['/managed/entry.js', '--port', '3000']
      }
      const result = resolveMcpSpawnConfig(serverCfg, {
        npmResolver: mockNpmResolver({ 'my-server': installed })
      })
      expect(result.command).toBe('node')
      expect(result.args).toEqual(['/managed/entry.js', '--port', '3000'])
    })

    it('preserves existing command for npm packages that already have one', () => {
      const serverCfg: McpServerConfig = {
        name: 'test-server',
        transport: 'stdio',
        npm_package: 'my-server',
        command: 'custom-runner',
        args: ['--flag']
      }
      const result = resolveMcpSpawnConfig(serverCfg, {
        npmResolver: mockNpmResolver()
      })
      expect(result.command).toBe('custom-runner')
    })
  })

  describe('uvx packages', () => {
    it('resolves managed uvx package to direct entry point', () => {
      const installed: McpInstalledPackage = {
        package: 'browser-use-mcp-server',
        version: '0.3.0',
        command: '/home/user/.local/bin/browser-use-mcp-server',
        installPath: '',
        installedAt: Date.now(),
        runtime: 'uvx'
      }
      const serverCfg: McpServerConfig = {
        name: 'browser-use',
        transport: 'stdio',
        pypi_package: 'browser-use-mcp-server',
        source: 'uvx:browser-use-mcp-server@0.3.0'
      }
      const result = resolveMcpSpawnConfig(serverCfg, {
        npmResolver: mockNpmResolver(),
        uvxResolver: mockUvxResolver({ 'browser-use-mcp-server': installed })
      })
      expect(result.command).toBe('/home/user/.local/bin/browser-use-mcp-server')
      expect(result.args).toEqual([])
    })

    it('falls back to uv tool run when uvBinPath is provided', () => {
      const serverCfg: McpServerConfig = {
        name: 'browser-use',
        transport: 'stdio',
        pypi_package: 'browser-use-mcp-server',
        source: 'uvx:browser-use-mcp-server'
      }
      const result = resolveMcpSpawnConfig(serverCfg, {
        npmResolver: mockNpmResolver(),
        uvxResolver: mockUvxResolver(),
        uvBinPath: '/usr/local/bin/uv'
      })
      expect(result.command).toBe('/usr/local/bin/uv')
      expect(result.args).toEqual(['tool', 'run', 'browser-use-mcp-server'])
    })

    it('falls back to bare uvx when no resolver or uvBinPath', () => {
      const serverCfg: McpServerConfig = {
        name: 'browser-use',
        transport: 'stdio',
        pypi_package: 'browser-use-mcp-server'
      }
      const result = resolveMcpSpawnConfig(serverCfg, {
        npmResolver: mockNpmResolver()
      })
      expect(result.command).toBe('uvx')
      expect(result.args).toEqual(['browser-use-mcp-server'])
    })

    it('passes user args through for uvx packages', () => {
      const serverCfg: McpServerConfig = {
        name: 'browser-use',
        transport: 'stdio',
        pypi_package: 'browser-use-mcp-server',
        args: ['--headless']
      }
      const result = resolveMcpSpawnConfig(serverCfg, {
        npmResolver: mockNpmResolver()
      })
      expect(result.command).toBe('uvx')
      expect(result.args).toEqual(['browser-use-mcp-server', '--headless'])
    })
  })

  describe('pip packages', () => {
    it('throws for pip: source prefix', () => {
      const serverCfg: McpServerConfig = {
        name: 'test-server',
        transport: 'stdio',
        source: 'pip:some-server'
      }
      expect(() =>
        resolveMcpSpawnConfig(serverCfg, { npmResolver: mockNpmResolver() })
      ).toThrow('pip: source not yet supported')
    })
  })

  describe('command: "uvx" (Claude Desktop import)', () => {
    it('rewrites uvx command to uv tool run when uvBinPath is provided', () => {
      const serverCfg: McpServerConfig = {
        name: 'alpaca',
        transport: 'stdio',
        command: 'uvx',
        args: ['alpaca-mcp-server', 'serve']
      }
      const result = resolveMcpSpawnConfig(serverCfg, {
        npmResolver: mockNpmResolver(),
        uvBinPath: '/home/user/.adf-studio/mcp-bin/uv'
      })
      expect(result.command).toBe('/home/user/.adf-studio/mcp-bin/uv')
      expect(result.args).toEqual(['tool', 'run', 'alpaca-mcp-server', 'serve'])
    })

    it('keeps bare uvx command when no uvBinPath (will fail at spawn)', () => {
      const serverCfg: McpServerConfig = {
        name: 'alpaca',
        transport: 'stdio',
        command: 'uvx',
        args: ['alpaca-mcp-server', 'serve']
      }
      const result = resolveMcpSpawnConfig(serverCfg, {
        npmResolver: mockNpmResolver()
      })
      expect(result.command).toBe('uvx')
      expect(result.args).toEqual(['alpaca-mcp-server', 'serve'])
    })
  })

  describe('custom servers', () => {
    it('returns custom command and args as-is', () => {
      const serverCfg: McpServerConfig = {
        name: 'custom-server',
        transport: 'stdio',
        command: '/usr/bin/my-server',
        args: ['--config', '/path/to/config']
      }
      const result = resolveMcpSpawnConfig(serverCfg, {
        npmResolver: mockNpmResolver()
      })
      expect(result.command).toBe('/usr/bin/my-server')
      expect(result.args).toEqual(['--config', '/path/to/config'])
    })

    it('returns undefined command when nothing is specified', () => {
      const serverCfg: McpServerConfig = {
        name: 'empty-server',
        transport: 'stdio'
      }
      const result = resolveMcpSpawnConfig(serverCfg, {
        npmResolver: mockNpmResolver()
      })
      expect(result.command).toBeUndefined()
    })
  })
})

describe('resolveMcpEnvVars', () => {
  it('resolves env vars for npm_package namespace', () => {
    const serverCfg: McpServerConfig = {
      name: 'test',
      transport: 'stdio',
      npm_package: 'my-server',
      env_keys: ['API_KEY', 'SECRET']
    }
    const getDecrypted = (key: string) => {
      if (key === 'mcp:my-server:API_KEY') return 'key123'
      if (key === 'mcp:my-server:SECRET') return 'secret456'
      return null
    }
    const result = resolveMcpEnvVars(serverCfg, getDecrypted)
    expect(result).toEqual({ API_KEY: 'key123', SECRET: 'secret456' })
  })

  it('resolves env vars for pypi_package namespace', () => {
    const serverCfg: McpServerConfig = {
      name: 'test',
      transport: 'stdio',
      pypi_package: 'python-server',
      env_keys: ['TOKEN']
    }
    const getDecrypted = (key: string) => {
      if (key === 'mcp:python-server:TOKEN') return 'tok789'
      return null
    }
    const result = resolveMcpEnvVars(serverCfg, getDecrypted)
    expect(result).toEqual({ TOKEN: 'tok789' })
  })

  it('returns empty when no env_keys', () => {
    const serverCfg: McpServerConfig = {
      name: 'test',
      transport: 'stdio',
      npm_package: 'my-server'
    }
    const result = resolveMcpEnvVars(serverCfg, () => null)
    expect(result).toEqual({})
  })

  it('falls back to server name when no package', () => {
    const serverCfg: McpServerConfig = {
      name: 'test',
      transport: 'stdio',
      env_keys: ['KEY']
    }
    const result = resolveMcpEnvVars(serverCfg, (k) => k === 'mcp:test:KEY' ? 'value' : null)
    expect(result).toEqual({ KEY: 'value' })
  })

  it('skips keys with null values', () => {
    const serverCfg: McpServerConfig = {
      name: 'test',
      transport: 'stdio',
      npm_package: 'server',
      env_keys: ['FOUND', 'MISSING']
    }
    const getDecrypted = (key: string) => key.includes('FOUND') ? 'value' : null
    const result = resolveMcpEnvVars(serverCfg, getDecrypted)
    expect(result).toEqual({ FOUND: 'value' })
  })
})

describe('HTTP MCP helpers', () => {
  it('builds request headers from static headers, bearer env, and header env mappings', () => {
    const serverCfg: McpServerConfig = {
      name: 'remote',
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: { 'X-Static': 'static' },
      bearer_token_env_var: 'MCP_TOKEN',
      header_env: [{ header: 'X-API-Key', env: 'API_KEY' }],
      env: {
        MCP_TOKEN: 'tok',
        API_KEY: 'key'
      }
    }

    expect(resolveMcpRequestHeaders(serverCfg)).toEqual({
      'X-Static': 'static',
      Authorization: 'Bearer tok',
      'X-API-Key': 'key'
    })
  })

  it('builds app-scoped env schema entries with credential refs', () => {
    const serverCfg: McpServerConfig = {
      name: 'github',
      transport: 'stdio',
      npm_package: '@modelcontextprotocol/server-github'
    }

    expect(buildEnvSchemaFromKeys(serverCfg, ['GITHUB_TOKEN'], 'app')).toEqual([
      {
        key: 'GITHUB_TOKEN',
        scope: 'app',
        required: true,
        credential_ref: 'mcp:@modelcontextprotocol/server-github:GITHUB_TOKEN'
      }
    ])
  })

  it('builds agent-safe HTTP MCP config from a runtime registration', () => {
    const result = buildMcpServerConfigFromRegistration({
      id: 'mcp:remote',
      name: 'remote',
      type: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: [
        { key: 'X-Routing-Key', value: 'route-a' },
        { key: 'Authorization', value: 'Bearer secret' }
      ],
      bearerTokenEnvVar: 'MCP_TOKEN',
      credentialStorage: 'app'
    })

    expect(result).toEqual({
      name: 'remote',
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      source: 'http:https://mcp.example.com/mcp',
      headers: { 'X-Routing-Key': 'route-a' },
      bearer_token_env_var: 'MCP_TOKEN',
      env_schema: [{
        key: 'MCP_TOKEN',
        scope: 'app',
        required: true,
        credential_ref: 'mcp:remote:MCP_TOKEN'
      }]
    })
  })

  it('classifies common secret-bearing HTTP headers as sensitive', () => {
    expect(isSensitiveMcpHeader('Authorization')).toBe(true)
    expect(isSensitiveMcpHeader('X-API-Key')).toBe(true)
    expect(isSensitiveMcpHeader('X-Routing-Key')).toBe(false)
  })
})
