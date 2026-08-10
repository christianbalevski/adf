import { mkdtempSync, rmSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'

import { AdfWorkspace } from '../../src/main/adf/adf-workspace'
import { MockLLMProvider } from '../../src/main/runtime/headless'
import {
  assembleAgent,
  type AssembledAgent,
  type AssembleAgentOptions,
  type LifecycleResource,
} from '../../src/main/runtime/assemble-agent'
import type { ChannelAdapterManager } from '../../src/main/services/channel-adapter-manager'
import {
  profileHasAsyncTeardown,
  type AgentProfileName,
} from '../../src/main/runtime/agent-capability-profiles'
import { TriggerEvaluator } from '../../src/main/runtime/trigger-evaluator'
import { ToolRegistry } from '../../src/main/tools/tool-registry'
import { withSource } from '../../src/main/runtime/execution-context'
import { createDispatch, createEvent } from '../../src/shared/types/adf-event.types'
import type { CreateAgentOptions } from '../../src/shared/types/adf-v02.types'

interface Fixture<P extends AgentProfileName> {
  agent: AssembledAgent<P>
  provider: MockLLMProvider
  workspace: AdfWorkspace
}

const agents: Array<AssembledAgent<AgentProfileName>> = []
const tempDirs: string[] = []

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function chatDispatch(message = 'hello from lifecycle test') {
  return createDispatch(
    createEvent({
      type: 'chat',
      source: 'test:lifecycle',
      data: {
        message: {
          seq: 0,
          role: 'user',
          content_json: [{ type: 'text' as const, text: message }],
          created_at: Date.now(),
        },
      },
    }),
    { scope: 'agent' },
  )
}

function makeFixture<P extends AgentProfileName>(
  profile: P,
  options: {
    createOptions?: Partial<CreateAgentOptions>
    resources?: LifecycleResource[]
    assembleOptions?: Partial<Omit<
      AssembleAgentOptions<P>,
      'profile' | 'workspace' | 'config' | 'provider' | 'registry' | 'resources'
    >>
  } = {},
): Fixture<P> {
  const dir = mkdtempSync(join(tmpdir(), `adf-assemble-${profile}-`))
  const workspace = AdfWorkspace.create(join(dir, 'agent.adf'), {
    name: `${profile}-lifecycle-test`,
    autonomous: false,
    start_in_state: 'active',
    ...options.createOptions,
  })
  const provider = new MockLLMProvider({ tokensPerResponse: 4 })
  const agent = assembleAgent({
    profile,
    workspace,
    config: workspace.getAgentConfig(),
    provider,
    registry: new ToolRegistry(),
    resources: options.resources,
    ...options.assembleOptions,
  })

  tempDirs.push(dir)
  agents.push(agent as AssembledAgent<AgentProfileName>)
  return { agent, provider, workspace }
}

afterEach(async () => {
  vi.useRealTimers()
  for (const agent of agents.splice(0).reverse()) {
    await agent.disposeAsync({ mode: 'immediate' })
  }
  for (const dir of tempDirs.splice(0).reverse()) {
    rmSync(dir, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

const CHECKPOINT_META_KEY = 'adf_runtime_turn_checkpoint'

function makeLoadFixture(mutate?: (workspace: AdfWorkspace) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'adf-assemble-load-'))
  tempDirs.push(dir)
  const workspace = AdfWorkspace.create(join(dir, 'agent.adf'), {
    name: 'load-reconcile-test',
    autonomous: false,
    start_in_state: 'active',
  })
  mutate?.(workspace)
  return { workspace, dir }
}

function assembleFrom(workspace: AdfWorkspace, config = workspace.getAgentConfig()) {
  const provider = new MockLLMProvider({ tokensPerResponse: 4 })
  const agent = assembleAgent({
    profile: 'headlessLive',
    workspace,
    config,
    provider,
    registry: new ToolRegistry(),
  })
  agents.push(agent as AssembledAgent<AgentProfileName>)
  return { agent, provider }
}

function loopNoticeTexts(workspace: AdfWorkspace): string[] {
  return workspace.getLoop()
    .filter(entry => entry.role === 'user')
    .flatMap(entry => entry.content_json
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map(block => block.text))
}

describe('assembled-agent load-time recovery and reconciliation', () => {
  it('tells the recovered agent how long the interrupted turn has been stale', () => {
    const startedAt = Date.now() - 3 * 60 * 60 * 1000
    const { workspace } = makeLoadFixture(ws => {
      ws.setMeta(CHECKPOINT_META_KEY, JSON.stringify({
        id: 'turn-stale',
        status: 'in_progress',
        started_at: startedAt,
        updated_at: startedAt,
        event_type: 'chat',
        scope: 'agent',
        replay: 'not_attempted',
      }), 'readonly')
    })
    assembleFrom(workspace)

    const notice = loopNoticeTexts(workspace).find(text => text.includes('was interrupted before clean completion'))
    expect(notice).toBeDefined()
    expect(notice).toContain(new Date(startedAt).toISOString())
    expect(notice).toContain('about 3h 0m has passed')
  })

  it('tells the agent in-loop when the prior checkpoint could not be read', () => {
    const { workspace } = makeLoadFixture(ws => {
      ws.setMeta(CHECKPOINT_META_KEY, '{ this is not json', 'readonly')
    })
    assembleFrom(workspace)

    expect(loopNoticeTexts(workspace).filter(text =>
      text.includes('could not read the previous turn checkpoint'),
    )).toHaveLength(1)
    expect(JSON.parse(workspace.getMeta(CHECKPOINT_META_KEY) ?? 'null')).toMatchObject({
      status: 'interrupted',
      reason: 'malformed_checkpoint',
    })
  })

  it('reconciles tasks a crash left non-terminal and leaves lambda-owned approvals open', () => {
    const { workspace } = makeLoadFixture(ws => {
      ws.insertTask('task-running', 'sys_code', '{}', 'agent')
      ws.updateTaskStatus('task-running', 'running')
      ws.insertTask('task-hil', 'sys_update_config', '{}', 'agent', true, true)
      ws.updateTaskStatus('task-hil', 'pending_approval')
      ws.insertTask('task-lambda-hil', 'sys_fetch', '{}', 'lambda')
      ws.updateTaskStatus('task-lambda-hil', 'pending_approval')
    })
    assembleFrom(workspace)

    expect(workspace.getTask('task-running')?.status).toBe('failed')
    expect(workspace.getTask('task-hil')?.status).toBe('cancelled')
    // Not executor-managed: a lambda or the UI can still resolve it after restart.
    expect(workspace.getTask('task-lambda-hil')?.status).toBe('pending_approval')
    expect(workspace.getLogs(50).filter(log => log.event === 'task_orphaned')).toHaveLength(2)
  })

  it('warns but never rejects when the config does not match AgentConfigSchema', () => {
    const { workspace } = makeLoadFixture()
    const config = workspace.getAgentConfig()
    config.instructions = ''
    const { agent } = assembleFrom(workspace, config)

    expect(agent.getLifecycleState()).toBe('created')
    const warnings = workspace.getLogs(50).filter(log => log.event === 'config_validation')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.level).toBe('warn')
    expect(warnings[0]?.message).toContain('instructions')
  })

  it('flags duplicate tools[] entries instead of letting the last one win', async () => {
    const { workspace } = makeLoadFixture()
    const config = workspace.getAgentConfig()
    config.tools = [
      ...config.tools.filter(tool => tool.name !== 'sys_update_config'),
      { name: 'sys_update_config', enabled: true, visible: true, restricted: true },
      // Self-de-restriction attempt: under last-wins this shadowed the entry above.
      { name: 'sys_update_config', enabled: true, visible: true, restricted: false },
    ]
    const { agent } = assembleFrom(workspace, config)
    await agent.start()
    await agent.dispatch(chatDispatch('duplicate tool declarations'))

    const warnings = workspace.getLogs(50).filter(log => log.event === 'duplicate_tool_declaration')
    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings[0]?.message).toContain('sys_update_config')
  })
})

describe('canonical assembled-agent lifecycle', () => {
  it('routes every workspace mutation through file-change triggers and keeps self events opt-in', () => {
    const triggers = {
      on_file_change: {
        enabled: true,
        targets: [{ scope: 'system', filter: { watch: 'skills/*', include_self: true } }],
      },
    }
    const { agent, workspace } = makeFixture('daemon', { createOptions: { triggers } })
    const events: AdfEventDispatch[] = []
    agent.triggerEvaluator.on('trigger', (event: AdfEventDispatch) => events.push(event))

    withSource('agent:turn_123', workspace.getAgentConfig().id, () => {
      workspace.writeFile('skills/example/SKILL.md', '---\nname: example\n---')
      // Uploads, imports, and fs_transfer-to-vfs use the binary workspace path.
      workspace.writeFileBuffer('skills/example/imported.md', Buffer.from('imported'), 'text/markdown')
      workspace.renameInternalFile('skills/example/SKILL.md', 'skills/example/RENAMED.md')
      workspace.deleteFile('skills/example/RENAMED.md')
    })

    expect(events.map(event => event.event.data.path)).toEqual([
      'skills/example/SKILL.md',
      'skills/example/imported.md',
      'skills/example/SKILL.md',
      'skills/example/RENAMED.md',
      'skills/example/RENAMED.md',
    ])
    expect(events.map(event => event.event.data.operation)).toEqual([
      'created', 'created', 'deleted', 'created', 'deleted',
    ])
  })

  it('does not wake on a self-generated workspace mutation unless include_self is enabled', () => {
    const triggers = {
      on_file_change: {
        enabled: true,
        targets: [{ scope: 'system', filter: { watch: 'skills/*' } }],
      },
    }
    const { agent, workspace } = makeFixture('daemon', { createOptions: { triggers } })
    const events: AdfEventDispatch[] = []
    agent.triggerEvaluator.on('trigger', (event: AdfEventDispatch) => events.push(event))

    withSource('agent:turn_123', workspace.getAgentConfig().id, () => {
      workspace.writeFile('skills/example/SKILL.md', '---\nname: example\n---')
    })

    expect(events).toHaveLength(0)
  })

  it('rejects dispatch while created and while asynchronous startup is pending', async () => {
    const gate = deferred()
    const resource: LifecycleResource = { name: 'startup-gate', start: () => gate.promise }
    const { agent } = makeFixture('daemon', { resources: [resource] })
    const dispatch = chatDispatch()

    await expect(agent.dispatch(dispatch)).rejects.toThrow(
      'Cannot dispatch while agent lifecycle is created',
    )

    const starting = agent.start()
    expect(agent.getLifecycleState()).toBe('starting')
    await expect(agent.dispatch(dispatch)).rejects.toThrow(
      'Cannot dispatch while agent lifecycle is starting',
    )

    gate.resolve()
    await starting
    expect(agent.getLifecycleState()).toBe('running')
  })

  it('shares concurrent start calls and starts each resource once', async () => {
    const gate = deferred()
    const start = vi.fn(() => gate.promise)
    const { agent } = makeFixture('daemon', {
      resources: [{ name: 'slow-start', start }],
    })

    const first = agent.start()
    const second = agent.start()

    expect(second).toBe(first)
    expect(start).toHaveBeenCalledTimes(1)

    gate.resolve()
    await Promise.all([first, second])
    await agent.start()

    expect(agent.getLifecycleState()).toBe('running')
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('lets stop supersede an in-progress start without returning to running', async () => {
    const gate = deferred()
    const stopResource = vi.fn(async () => {})
    const { agent } = makeFixture('daemon', {
      resources: [{ name: 'startup-gate', start: () => gate.promise, stop: stopResource }],
    })

    const starting = agent.start()
    const stopping = agent.stop({ mode: 'immediate' })
    expect(agent.getLifecycleState()).toBe('stopping')

    gate.resolve()
    await Promise.all([starting, stopping])

    expect(agent.getLifecycleState()).toBe('stopped')
    expect(stopResource).toHaveBeenCalledOnce()
    await expect(agent.start()).rejects.toThrow('Cannot start agent from lifecycle stopped')
    await expect(agent.dispatch(chatDispatch())).rejects.toThrow(
      'Cannot dispatch while agent lifecycle is stopped',
    )
  })

  it('rolls back every resource in reverse order and continues past cleanup errors', async () => {
    const calls: string[] = []
    const startupError = new Error('second resource failed')
    const { agent } = makeFixture('daemon', {
      resources: [
        {
          name: 'first',
          start: () => { calls.push('start:first') },
          stop: () => { calls.push('stop:first'); throw new Error('cleanup failure') },
        },
        {
          name: 'second',
          start: () => { calls.push('start:second'); throw startupError },
          stop: () => { calls.push('stop:second') },
        },
        {
          name: 'pre-acquired-third',
          start: () => { calls.push('start:third') },
          stop: () => { calls.push('stop:third') },
        },
      ],
    })

    await expect(agent.start()).rejects.toBe(startupError)

    expect(calls).toEqual([
      'start:first',
      'start:second',
      'stop:third',
      'stop:second',
      'stop:first',
    ])
    expect(agent.getLifecycleState()).toBe('stopped')
  })

  it('starts timer polling for headlessLive but not benchmark', async () => {
    const startTimerPolling = vi.spyOn(TriggerEvaluator.prototype, 'startTimerPolling')
    const live = makeFixture('headlessLive')
    const benchmark = makeFixture('benchmark')

    await live.agent.start()
    expect(startTimerPolling).toHaveBeenCalledTimes(1)
    expect(startTimerPolling).toHaveBeenLastCalledWith(live.workspace)

    await benchmark.agent.start()
    expect(startTimerPolling).toHaveBeenCalledTimes(1)
  })

  it('dispatches a complete dispatch object after reaching running', async () => {
    const { agent, provider } = makeFixture('headlessLive')
    const dispatch = chatDispatch('run this turn')
    const beforeDispatch = vi.fn()
    agent.attachHost({ beforeDispatch })

    await agent.start()
    await agent.dispatch(dispatch)

    expect(beforeDispatch).toHaveBeenCalledOnce()
    expect(beforeDispatch).toHaveBeenCalledWith(dispatch)
    expect(provider.getCallCount()).toBe(1)
  })

  it('atomically replaces the owning host and makes detach idempotent', async () => {
    const { agent, provider } = makeFixture('headlessLive')
    const firstHost = vi.fn()
    const secondHost = vi.fn()

    await agent.start()
    const firstAttachment = agent.attachHost({ beforeDispatch: firstHost })
    await agent.dispatch(chatDispatch('first host'))

    const secondAttachment = agent.attachHost({ beforeDispatch: secondHost })
    firstAttachment.detach()
    firstAttachment.detach()
    await agent.dispatch(chatDispatch('replacement host'))

    secondAttachment.detach()
    secondAttachment.detach()
    await agent.dispatch(chatDispatch('detached host'))

    expect(firstHost).toHaveBeenCalledTimes(1)
    expect(secondHost).toHaveBeenCalledTimes(1)
    expect(provider.getCallCount()).toBe(3)
  })

  it('shares concurrent stop calls and stops each resource once', async () => {
    const gate = deferred()
    const stop = vi.fn(() => gate.promise)
    const { agent } = makeFixture('daemon', {
      resources: [{ name: 'slow-stop', stop }],
    })
    await agent.start()

    const first = agent.stop({ mode: 'immediate' })
    const second = agent.stop({ mode: 'immediate' })

    expect(second).toBe(first)
    expect(agent.getLifecycleState()).toBe('stopping')
    expect(stop).toHaveBeenCalledTimes(1)

    gate.resolve()
    await Promise.all([first, second])
    await agent.stop({ mode: 'immediate' })

    expect(agent.getLifecycleState()).toBe('stopped')
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('tracks host pre-dispatch work so graceful stop cannot race past it', async () => {
    const hostGate = deferred()
    const { agent } = makeFixture('daemon')
    const abort = vi.spyOn(agent.executor, 'abort')
    const executeTurn = vi.spyOn(agent.executor, 'executeTurn')
    agent.attachHost({ beforeDispatch: () => hostGate.promise })
    await agent.start()

    const dispatching = agent.dispatch(chatDispatch())
    const stopping = agent.stop({ mode: 'graceful', graceMs: 1_000 })
    await Promise.resolve()

    expect(agent.getLifecycleState()).toBe('stopping')
    expect(executeTurn).not.toHaveBeenCalled()
    expect(abort).not.toHaveBeenCalled()

    hostGate.resolve()
    await Promise.all([dispatching, stopping])

    expect(executeTurn).toHaveBeenCalledOnce()
    expect(abort).toHaveBeenCalledOnce()
  })

  it('aborts a tracked dispatch only when the graceful deadline expires', async () => {
    vi.useFakeTimers()
    const never = deferred()
    const { agent } = makeFixture('daemon')
    vi.spyOn(agent.executor, 'executeTurn').mockReturnValue(never.promise)
    const abort = vi.spyOn(agent.executor, 'abort')
    await agent.start()

    void agent.dispatch(chatDispatch())
    const stopping = agent.stop({ mode: 'graceful', graceMs: 25 })
    await vi.advanceTimersByTimeAsync(24)
    expect(abort).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await stopping
    expect(abort).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('cleans assembler-owned listeners and callbacks during stop', async () => {
    const adapter = new EventEmitter() as ChannelAdapterManager
    const { agent, workspace } = makeFixture('daemon', {
      assembleOptions: { adapterManager: adapter },
    })
    const onLog = vi.spyOn(agent.triggerEvaluator, 'onLog')
    await agent.start()

    expect(adapter.listenerCount('inbound')).toBe(1)
    expect(agent.triggerEvaluator.listenerCount('trigger')).toBe(1)
    expect(agent.executor.listenerCount('event')).toBe(1)

    await agent.stop({ mode: 'immediate' })

    expect(adapter.listenerCount('inbound')).toBe(0)
    expect(agent.triggerEvaluator.listenerCount('trigger')).toBe(0)
    expect(agent.executor.listenerCount('event')).toBe(0)
    workspace.insertLog('info', 'test', 'after-stop', null, 'should not be forwarded')
    expect(onLog).not.toHaveBeenCalled()
  })

  it('tears down asynchronous resources and workspace exactly once through all entry points', async () => {
    const stop = vi.fn(async () => {})
    const { agent, workspace } = makeFixture('daemon', {
      resources: [{ name: 'dispose-counting-async', stop }],
    })
    const disposeWorkspace = vi.spyOn(workspace, 'dispose')
    await agent.start()

    await Promise.all([
      agent.stop({ mode: 'immediate' }),
      agent.stop({ mode: 'immediate' }),
      agent.disposeAsync({ mode: 'immediate' }),
      agent.disposeAsync({ mode: 'immediate' }),
    ])
    await agent.stop({ mode: 'immediate' })
    await agent.disposeAsync({ mode: 'immediate' })

    expect(stop).toHaveBeenCalledTimes(1)
    expect(disposeWorkspace).toHaveBeenCalledTimes(1)
    expect(agent.getLifecycleState()).toBe('disposed')
  })

  it('tears down synchronous resources and workspace exactly once through repeated dispose calls', async () => {
    const disposeSync = vi.fn()
    const { agent, workspace } = makeFixture('headlessLive', {
      resources: [{ name: 'dispose-counting-sync', disposeSync }],
    })
    const disposeWorkspace = vi.spyOn(workspace, 'dispose')
    await agent.start()

    agent.dispose()
    agent.dispose()
    await agent.stop({ mode: 'immediate' })
    await agent.disposeAsync({ mode: 'immediate' })

    expect(disposeSync).toHaveBeenCalledTimes(1)
    expect(disposeWorkspace).toHaveBeenCalledTimes(1)
    expect(agent.getLifecycleState()).toBe('disposed')
  })

  it('transfers workspace-close ownership with foreground/background handoff', async () => {
    const foregroundBuilt = makeFixture('studioForeground', {
      assembleOptions: { ownsWorkspace: false },
    })
    const foregroundWorkspaceDispose = vi.spyOn(foregroundBuilt.workspace, 'dispose')
    await foregroundBuilt.agent.start()

    foregroundBuilt.agent.setWorkspaceOwnership(true)
    await foregroundBuilt.agent.disposeAsync({ mode: 'immediate' })
    expect(foregroundWorkspaceDispose).toHaveBeenCalledOnce()

    const backgroundBuilt = makeFixture('studioBackground')
    const backgroundWorkspaceDispose = vi.spyOn(backgroundBuilt.workspace, 'dispose')
    await backgroundBuilt.agent.start()

    backgroundBuilt.agent.setWorkspaceOwnership(false)
    await backgroundBuilt.agent.disposeAsync({ mode: 'immediate' })
    expect(backgroundWorkspaceDispose).not.toHaveBeenCalled()
    backgroundBuilt.workspace.dispose()
  })

  it('exposes synchronous dispose only for sync-safe profiles', () => {
    type HeadlessHasDispose = 'dispose' extends keyof AssembledAgent<'headlessLive'> ? true : false
    type BenchmarkHasDispose = 'dispose' extends keyof AssembledAgent<'benchmark'> ? true : false
    type DaemonHasDispose = 'dispose' extends keyof AssembledAgent<'daemon'> ? true : false

    expectTypeOf<HeadlessHasDispose>().toEqualTypeOf<true>()
    expectTypeOf<BenchmarkHasDispose>().toEqualTypeOf<true>()
    expectTypeOf<DaemonHasDispose>().toEqualTypeOf<false>()

    const headless = makeFixture('headlessLive').agent
    const benchmark = makeFixture('benchmark').agent
    const daemon = makeFixture('daemon').agent

    expect('dispose' in headless).toBe(true)
    expect('dispose' in benchmark).toBe(true)
    expect('dispose' in daemon).toBe(false)
    expect(profileHasAsyncTeardown('headlessLive')).toBe(false)
    expect(profileHasAsyncTeardown('benchmark')).toBe(false)
    expect(profileHasAsyncTeardown('daemon')).toBe(true)
  })

  it('rejects async teardown resources supplied to a sync-safe profile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-sync-invariant-'))
    const workspace = AdfWorkspace.create(join(dir, 'agent.adf'), {
      name: 'sync-invariant-test',
      autonomous: false,
    })
    tempDirs.push(dir)

    expect(() => assembleAgent({
      profile: 'headlessLive',
      workspace,
      config: workspace.getAgentConfig(),
      provider: new MockLLMProvider(),
      registry: new ToolRegistry(),
      adapterManager: new EventEmitter() as ChannelAdapterManager,
    })).toThrow('Sync-safe profile headlessLive contains async teardown resources: adapters')

    workspace.dispose()
  })

  it('evaluates configured startup targets and the default startup turn only once', async () => {
    const { agent } = makeFixture('headlessLive', {
      createOptions: {
        triggers: {
          on_startup: { enabled: true, targets: [{ scope: 'agent' }] },
        },
      },
    })
    const evaluateStartup = vi.spyOn(agent.triggerEvaluator, 'onStartup')
    const executeTurn = vi.spyOn(agent.executor, 'executeTurn')
    await agent.start()

    await expect(agent.dispatchStartup()).resolves.toBe(true)
    await expect(agent.dispatchStartup()).resolves.toBe(false)

    expect(evaluateStartup).toHaveBeenCalledTimes(1)
    expect(executeTurn).toHaveBeenCalledTimes(2)
    expect(executeTurn.mock.calls.map(([dispatch]) => (
      'event' in dispatch ? dispatch.event.type : dispatch.events[0]?.type
    ))).toEqual(['startup', 'startup'])
  })

  it('suppresses both startup paths once when a pending user message exists', async () => {
    const { agent } = makeFixture('headlessLive', {
      createOptions: {
        triggers: {
          on_startup: { enabled: true, targets: [{ scope: 'agent' }] },
        },
      },
    })
    const evaluateStartup = vi.spyOn(agent.triggerEvaluator, 'onStartup')
    const executeTurn = vi.spyOn(agent.executor, 'executeTurn')
    await agent.start()

    await expect(agent.dispatchStartup({ hasUserMessage: true })).resolves.toBe(false)
    await expect(agent.dispatchStartup()).resolves.toBe(false)

    expect(evaluateStartup).not.toHaveBeenCalled()
    expect(executeTurn).not.toHaveBeenCalled()
  })
})
