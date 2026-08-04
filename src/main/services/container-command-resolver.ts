/**
 * Resolve MCP server commands for execution inside a container.
 *
 * Unlike the host resolver (resolveMcpSpawnConfig) which resolves to
 * host-local installed paths, this builds commands that work inside
 * the container where npm/npx/uv/uvx are available on PATH.
 *
 * - npm packages → `npx -y <package> [args]`
 * - pypi/uvx packages → `uvx <package> [args]`
 * - custom commands → pass through (must exist in container)
 */

import type { McpServerConfig } from '../../shared/types/adf-v02.types'

const PLAYWRIGHT_MCP_PACKAGE = '@playwright/mcp'
const ARCHIVED_PUPPETEER_MCP_PACKAGE = '@modelcontextprotocol/server-puppeteer'
const MANAGED_BROWSER_CDP_ENDPOINT = 'http://127.0.0.1:9222'

export function isPlaywrightMcpServer(serverCfg: McpServerConfig): boolean {
  return serverCfg.npm_package === ARCHIVED_PUPPETEER_MCP_PACKAGE
    || /^@playwright\/mcp(?:@[^/]+)?$/.test(serverCfg.npm_package ?? '')
}

export function resolveContainerCommand(
  serverCfg: McpServerConfig
): { command: string; args: string[] } {
  const userArgs = (serverCfg.args ?? []).filter(Boolean)

  // npm packages → npx (downloads + caches on first run)
  if (serverCfg.npm_package) {
    // Transparently keep existing agent configs working after the old official
    // Puppeteer server was archived. The ADF server name/tool prefix stays
    // stable, while the maintained Playwright implementation runs underneath.
    const runtimePackage = serverCfg.npm_package === ARCHIVED_PUPPETEER_MCP_PACKAGE
      ? PLAYWRIGHT_MCP_PACKAGE
      : serverCfg.npm_package
    // Strip legacy npx prefixes from user args
    let cleanArgs = [...userArgs]
    if (cleanArgs[0] === '-y' && cleanArgs[1] === serverCfg.npm_package) {
      cleanArgs = cleanArgs.slice(2)
    }
    if (isPlaywrightMcpServer(serverCfg) && !cleanArgs.some((arg) => arg === '--cdp-endpoint' || arg.startsWith('--cdp-endpoint='))) {
      cleanArgs.push('--cdp-endpoint', MANAGED_BROWSER_CDP_ENDPOINT)
    }
    return { command: 'npx', args: ['-y', runtimePackage, ...cleanArgs] }
  }

  // Python/uvx packages → uvx (uv is installed in the container)
  if (serverCfg.pypi_package) {
    return { command: 'uvx', args: [serverCfg.pypi_package, ...userArgs] }
  }

  // Command is "uvx" → pass through (uvx is on PATH in the container)
  if (serverCfg.command === 'uvx') {
    return { command: 'uvx', args: userArgs }
  }

  // Command is "npx" → pass through
  if (serverCfg.command === 'npx') {
    return { command: 'npx', args: userArgs }
  }

  // Command is "node" → pass through (node is in the container)
  // but args may contain host paths — those need rewriting by the caller
  if (serverCfg.command === 'node') {
    return { command: 'node', args: userArgs }
  }

  // Custom command → pass through as-is
  return { command: serverCfg.command ?? 'echo', args: userArgs }
}
