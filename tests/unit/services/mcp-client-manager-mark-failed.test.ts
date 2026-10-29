import { describe, expect, it } from 'vitest'

import type { McpServerConfig } from '../../../src/shared/types/adf-v02.types'
import { McpClientManager } from '../../../src/main/services/mcp-client-manager'

/**
 * A connect that fails before or outside an attempt (container not ready,
 * no command) is held as the server's error state with its reason, so the
 * Config panel's MCP card shows it instead of the console alone.
 */

const stdio = (patch: Partial<McpServerConfig> = {}): McpServerConfig =>
  ({ name: 'agent-1-tools', transport: 'stdio', command: 'noop', args: ['--secret-flag'], ...patch }) as McpServerConfig

describe('McpClientManager.markFailed', () => {
  it('adds an error state with the reason and emits status-changed', () => {
    const manager = new McpClientManager()
    const events: Array<[string, string, string | undefined]> = []
    manager.on('status-changed', (name, status, error) => events.push([name, status, error]))

    manager.markFailed(stdio(), 'MCP container for "agent-1-tools" is not ready: podman down')

    expect(manager.getServerState('agent-1-tools')).toMatchObject({
      status: 'error',
      error: 'MCP container for "agent-1-tools" is not ready: podman down',
      toolCount: 0,
    })
    expect(manager.getServerLogs('agent-1-tools').at(-1)?.message).toMatch(/not ready/)
    expect(events).toEqual([['agent-1-tools', 'error', 'MCP container for "agent-1-tools" is not ready: podman down']])
  })

  it('records needs_compute when the compute environment is missing', () => {
    const manager = new McpClientManager()
    const events: Array<[string, string]> = []
    manager.on('status-changed', (name, status) => events.push([name, status]))
    manager.markFailed(stdio(), 'MCP server "agent-1-tools" runs in a container, and the compute environment is not ready: Podman is not installed.', 'needs_compute')
    expect(manager.getServerState('agent-1-tools')).toMatchObject({ status: 'needs_compute' })
    expect(events).toEqual([['agent-1-tools', 'needs_compute']])
  })

  it('holds a status record, not a spawn spec', async () => {
    const manager = new McpClientManager()
    manager.markFailed(stdio(), 'failed')
    // A restart of the record has nothing to start: no command, no args.
    const internal = (manager as unknown as { servers: Map<string, { config: McpServerConfig }> }).servers.get('agent-1-tools')
    expect(internal?.config).toEqual({ name: 'agent-1-tools', transport: 'stdio' })
    await manager.disconnect('agent-1-tools')
    expect(manager.getServerState('agent-1-tools')).toBeNull()
  })

  it('a connect refused before any attempt is recorded too', async () => {
    const manager = new McpClientManager()
    const tools = await manager.connect(stdio({ command: undefined }))
    expect(tools).toBeNull()
    expect(manager.getServerState('agent-1-tools')).toMatchObject({ status: 'error', error: 'No command to start "agent-1-tools"' })
  })
})
