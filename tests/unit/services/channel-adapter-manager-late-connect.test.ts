import { afterEach, describe, expect, it } from 'vitest'

import { ChannelAdapterManager } from '../../../src/main/services/channel-adapter-manager'
import type { AdapterStatus, ChannelAdapter } from '../../../src/shared/types/channel-adapter.types'
import type { AdfWorkspace } from '../../../src/main/adf/adf-workspace'

const workspace = {} as AdfWorkspace

/** start() returns while still connecting; the connection comes up later (a poll loop's first answer). */
class LateConnectAdapter implements ChannelAdapter {
  current: AdapterStatus = 'disconnected'
  async start(): Promise<void> { this.current = 'connecting' }
  async stop(): Promise<void> { this.current = 'disconnected' }
  async send() { return { success: true as const } }
  canDeliver(): boolean { return this.current === 'connected' }
  status(): AdapterStatus { return this.current }
}

let manager: ChannelAdapterManager | null = null
afterEach(async () => { await manager?.stopAll(); manager = null })

describe('ChannelAdapterManager with an adapter that connects after start() returns', () => {
  it('reports connected as soon as the adapter is, without waiting for the health check', async () => {
    manager = new ChannelAdapterManager()
    const adapter = new LateConnectAdapter()
    const changes: string[] = []
    manager.on('status-changed', (_type: string, status: string) => changes.push(status))
    await manager.startAdapter('late', () => adapter, { enabled: true }, workspace)

    expect(manager.isConnected('late')).toBe(false)
    expect(manager.getStatus('late')).toBe('connecting')

    adapter.current = 'connected'
    expect(manager.isConnected('late')).toBe(true)
    expect(manager.getStatus('late')).toBe('connected')
    expect(manager.getState('late')?.status).toBe('connected')
    expect(changes.at(-1)).toBe('connected')
  })
})
