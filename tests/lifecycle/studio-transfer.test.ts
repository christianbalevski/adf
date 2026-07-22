import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { BackgroundAgentManager } from '../../src/main/runtime/background-agent-manager'
import type { AgentHostBindings, AssembledAgent, HostAttachment } from '../../src/main/runtime/assemble-agent'
import type { SettingsService } from '../../src/main/services/settings.service'
import type { AgentConfig } from '../../src/shared/types/adf-v02.types'

const managers: BackgroundAgentManager[] = []

afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose()
  vi.restoreAllMocks()
})

function makeManager(): BackgroundAgentManager {
  const manager = new BackgroundAgentManager({} as SettingsService, '', {})
  managers.push(manager)
  return manager
}

function makeStableHandle() {
  let activeHost: { detached: boolean; hooks: AgentHostBindings } | null = null
  const attachHost = vi.fn((hooks: AgentHostBindings): HostAttachment => {
    if (activeHost) activeHost.detached = true
    const attachment = { detached: false, hooks }
    activeHost = attachment
    return {
      detach: () => {
        if (attachment.detached) return
        attachment.detached = true
        if (activeHost === attachment) activeHost = null
      },
    }
  })
  const pendingApproval = { requestId: 'approval-in-flight' }
  const executor = {
    isMessageTriggered: false,
    getState: () => 'awaiting_approval',
    getPendingApprovals: () => [pendingApproval],
  }
  const session = {
    flushToLoop: vi.fn(),
    getMessages: () => [{ role: 'user', content: [] }],
  }
  const evaluator = { getDisplayState: () => 'suspended' }
  const workspace = { getLoop: () => [] }
  const disposeAsync = vi.fn(async () => {})
  const setWorkspaceOwnership = vi.fn()
  const handle = {
    executor,
    session,
    workspace,
    triggerEvaluator: evaluator,
    registry: { marker: 'registry' },
    mcpManager: { marker: 'mcp' },
    adapterManager: { marker: 'adapter' },
    adfCallHandler: { marker: 'adf-call' },
    scratchDir: '/tmp/stable-scratch',
    tapManager: { marker: 'tap' },
    streamBindingManager: { marker: 'streams' },
    attachHost,
    disposeAsync,
    setWorkspaceOwnership,
  } as unknown as AssembledAgent<'studioForeground'>

  return {
    handle,
    attachHost,
    disposeAsync,
    setWorkspaceOwnership,
    executor,
    session,
    evaluator,
    pendingApproval,
    activeHostCount: () => activeHost === null ? 0 : 1,
  }
}

const config = {
  id: 'studio-transfer-agent',
  name: 'Studio transfer agent',
  tools: [],
} as unknown as AgentConfig

describe('Studio foreground/background stable-handle transfer', () => {
  it('preserves every live identity and keeps exactly one owning host over repeated cycles', async () => {
    const manager = makeManager()
    const stable = makeStableHandle()
    const filePath = '/tmp/studio-transfer.adf'

    for (let cycle = 0; cycle < 4; cycle += 1) {
      await manager.transitionToBackground(filePath, config, stable.handle)
      expect(stable.activeHostCount()).toBe(1)
      expect(stable.setWorkspaceOwnership).toHaveBeenLastCalledWith(true)

      const managed = manager.getAgent(filePath)
      expect(managed?.assembledAgent).toBe(stable.handle)
      expect(managed?.executor).toBe(stable.executor)
      expect(managed?.session).toBe(stable.session)
      expect(managed?.triggerEvaluator).toBe(stable.evaluator)
      expect(managed?.executor.getPendingApprovals()).toEqual([stable.pendingApproval])

      const extracted = manager.extractBackgroundAgent(filePath)
      expect(extracted?.assembledAgent).toBe(stable.handle)
      expect(extracted?.executor).toBe(stable.executor)
      expect(extracted?.session).toBe(stable.session)
      expect(extracted?.triggerEvaluator).toBe(stable.evaluator)
      expect(stable.activeHostCount()).toBe(0)
      expect(stable.setWorkspaceOwnership).toHaveBeenLastCalledWith(false)
      expect(stable.disposeAsync).not.toHaveBeenCalled()
    }

    expect(stable.attachHost).toHaveBeenCalledTimes(4)
  })

  it('claims a transferred handle once when concurrent background stop entry points race', async () => {
    const manager = makeManager()
    const stable = makeStableHandle()
    const filePath = '/tmp/studio-stop-race.adf'
    const stoppedEvents: string[] = []
    manager.on('background_agent_event', (event) => {
      if (event.type === 'agent_stopped') stoppedEvents.push(event.payload.filePath)
    })

    await manager.transitionToBackground(filePath, config, stable.handle)
    const results = await Promise.all([
      manager.stopAgent(filePath),
      manager.stopAgent(filePath),
    ])

    expect(results.sort()).toEqual([false, true])
    expect(stable.disposeAsync).toHaveBeenCalledTimes(1)
    expect(stable.disposeAsync).toHaveBeenCalledWith({ mode: 'owner-off' })
    expect(stable.activeHostCount()).toBe(0)
    expect(stoppedEvents).toEqual([filePath])
  })

  it('rejects a second runtime handle for an already-owned background path', async () => {
    const manager = makeManager()
    const first = makeStableHandle()
    const second = makeStableHandle()
    const filePath = '/tmp/studio-duplicate-owner.adf'

    await manager.transitionToBackground(filePath, config, first.handle)

    await expect(
      manager.transitionToBackground(filePath, config, second.handle),
    ).rejects.toThrow(`Cannot attach a second assembled agent for ${filePath}`)
    expect(manager.getAgent(filePath)?.assembledAgent).toBe(first.handle)
    expect(first.activeHostCount()).toBe(1)
    expect(second.activeHostCount()).toBe(0)

    await manager.stopAgent(filePath)
  })
})

describe('Studio lifecycle ownership fences', () => {
  const ipcSource = readFileSync(
    join(__dirname, '..', '..', 'src', 'main', 'ipc', 'index.ts'),
    'utf8',
  )

  it('checks the startup destination before attaching the foreground host', () => {
    const start = ipcSource.indexOf('await assembled.start()')
    const destinationCheck = ipcSource.indexOf('if (fileChanged())', start)
    const foregroundAttach = ipcSource.indexOf(
      'assembled.attachHost(foregroundHost)',
      destinationCheck,
    )

    expect(start).toBeGreaterThan(-1)
    expect(destinationCheck).toBeGreaterThan(start)
    expect(foregroundAttach).toBeGreaterThan(destinationCheck)
  })

  it('keeps foreground aliases out of manual lifecycle teardown', () => {
    const forbiddenOwnershipBypasses = [
      /agentExecutor\??\.abort\s*\(/,
      /triggerEvaluator\??\.dispose\s*\(/,
      /currentMcpManager[^\n]*disconnectAll\s*\(/,
      /currentAdapterManager[^\n]*stopAll\s*\(/,
      /currentTapManager\??\.dispose\s*\(/,
      /currentStreamBindingManager\??\.stopAll\s*\(/,
    ]

    for (const bypass of forbiddenOwnershipBypasses) {
      expect(ipcSource, `manual lifecycle bypass matched ${bypass}`).not.toMatch(bypass)
    }
  })
})
