import { describe, expect, it } from 'vitest'
import { resolveContainerCommand } from '../../../src/main/services/container-command-resolver'

describe('resolveContainerCommand browser MCP routing', () => {
  it('attaches Playwright MCP to the ADF-owned browser over container loopback', () => {
    expect(resolveContainerCommand({
      name: 'playwright',
      transport: 'stdio',
      npm_package: '@playwright/mcp',
    })).toEqual({
      command: 'npx',
      args: ['-y', '@playwright/mcp', '--cdp-endpoint', 'http://127.0.0.1:9222'],
    })
  })

  it('preserves an explicitly configured Playwright CDP endpoint', () => {
    expect(resolveContainerCommand({
      name: 'playwright',
      transport: 'stdio',
      npm_package: '@playwright/mcp',
      args: ['--cdp-endpoint=http://browser:9333'],
    }).args).toEqual(['-y', '@playwright/mcp', '--cdp-endpoint=http://browser:9333'])
  })

  it('runs legacy Puppeteer configs through maintained Playwright without changing the server prefix', () => {
    expect(resolveContainerCommand({
      name: 'puppeteer',
      transport: 'stdio',
      npm_package: '@modelcontextprotocol/server-puppeteer',
    })).toEqual({
      command: 'npx',
      args: ['-y', '@playwright/mcp', '--cdp-endpoint', 'http://127.0.0.1:9222'],
    })
  })

  it('recognizes versioned Playwright packages', () => {
    expect(resolveContainerCommand({
      name: 'playwright',
      transport: 'stdio',
      npm_package: '@playwright/mcp@latest',
    }).args).toEqual([
      '-y', '@playwright/mcp@latest', '--cdp-endpoint', 'http://127.0.0.1:9222',
    ])
  })
})
