import { describe, expect, it, vi } from 'vitest'
import { SetTimerTool } from '../../../src/main/tools/built-in/sys-set-timer.tool'
import { LoopSendTool, LOOP_SEND_MAX_CHARS } from '../../../src/main/tools/built-in/loop-send.tool'
import { LoopManageTool } from '../../../src/main/tools/built-in/loop-manage.tool'
import {
  LoopConfigSchema,
  LoopsConfigSchema,
  LOOP_GOAL_MAX_CHARS,
  LOOP_TOOLS_MAX,
  MAX_SIDE_LOOPS,
} from '../../../src/main/adf/adf-schema'
import { CODE_EXECUTION_DEFAULTS } from '../../../src/shared/types/adf-v02.types'
import type { AgentConfig, LoopConfig, ToolDeclaration } from '../../../src/shared/types/adf-v02.types'
import type { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import type {
  LoopCreateResult,
  LoopDeleteResult,
  LoopInfo,
  LoopPoolApi,
  LoopSendResult,
} from '../../../src/main/adf/loop-pool.types'
import { LOOP_AUTOSTART_MESSAGE } from '../../../src/main/adf/loop-pool.types'

// ---------------------------------------------------------------------------
// Fakes — the LoopPoolApi seam exists so the tools are testable before the
// runtime pool does.
// ---------------------------------------------------------------------------

function decl(name: string, overrides: Partial<ToolDeclaration> = {}): ToolDeclaration {
  return { name, enabled: true, visible: true, ...overrides }
}

function hostConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    adf_version: '0.2',
    id: 'agent-1',
    name: 'agent-1',
    instructions: 'be the agent',
    model: { provider: 'anthropic', model_id: 'claude' },
    tools: [decl('fs_read'), decl('msg_send'), decl('shell_exec', { restricted: true }), decl('loop_manage')],
    code_execution: { ...CODE_EXECUTION_DEFAULTS },
    ...overrides,
  } as unknown as AgentConfig
}

interface FakeWorkspaceOptions {
  loop?: string
  config?: AgentConfig
}

function fakeWorkspace(options: FakeWorkspaceOptions = {}): AdfWorkspace & {
  addTimer: ReturnType<typeof vi.fn>
} {
  return {
    getLoopName: () => options.loop ?? 'main',
    getAgentConfig: () => options.config ?? hostConfig(),
    addTimer: vi.fn(() => 'timer-1'),
  } as unknown as AdfWorkspace & { addTimer: ReturnType<typeof vi.fn> }
}

interface FakePoolOptions {
  loops?: LoopConfig[]
  statuses?: Record<string, 'idle' | 'running'>
  sendResult?: LoopSendResult
  createResult?: LoopCreateResult | undefined
}

function fakePool(options: FakePoolOptions = {}): LoopPoolApi & {
  calls: { create: LoopConfig[]; update: Array<[string, Partial<LoopConfig>]>; del: string[]; send: unknown[][] }
} {
  const loops = options.loops ?? []
  const calls = {
    create: [] as LoopConfig[],
    update: [] as Array<[string, Partial<LoopConfig>]>,
    del: [] as string[],
    send: [] as unknown[][],
  }

  return {
    calls,
    listLoops(): LoopInfo[] {
      return [
        { name: 'main', goal: 'be the agent', status: 'idle', enabled: true, isMain: true },
        ...loops.map(l => ({
          name: l.name,
          goal: l.goal,
          status: options.statuses?.[l.name] ?? ('idle' as const),
          enabled: l.enabled,
          isMain: false,
        })),
      ]
    },
    hasLoop(name: string): boolean {
      return name === 'main' || loops.some(l => l.name === name)
    },
    getLoop(name: string): LoopConfig | undefined {
      return loops.find(l => l.name === name)
    },
    async sendToLoop(from, to, content, wake): Promise<LoopSendResult> {
      calls.send.push([from, to, content, wake])
      return options.sendResult ?? { delivered: true, woke: wake }
    },
    async createLoop(config: LoopConfig): Promise<LoopCreateResult> {
      calls.create.push(config)
      return options.createResult as LoopCreateResult
    },
    async updateLoop(name: string, patch: Partial<LoopConfig>): Promise<void> {
      calls.update.push([name, patch])
    },
    async deleteLoop(name: string): Promise<LoopDeleteResult> {
      calls.del.push(name)
      return { archivedEntries: 3, interruptedTurn: false }
    },
  }
}

function sideLoop(name: string, overrides: Partial<LoopConfig> = {}): LoopConfig {
  return { name, goal: `goal of ${name}`, enabled: true, ...overrides } as LoopConfig
}

// ===========================================================================
// sys_set_timer — the side-loop guard
// ===========================================================================

describe('sys_set_timer side-loop guard', () => {
  const timerTool = new SetTimerTool()

  function input(overrides: Record<string, unknown> = {}): unknown {
    return timerTool.inputSchema.parse({
      schedule: { type: 'delay', delay_ms: 60_000 },
      scope: ['agent'],
      payload: 'wake up and reflect',
      ...overrides,
    })
  }

  const cases: Array<{
    label: string
    loop: string
    overrides: Record<string, unknown>
    allowed: boolean
    match?: RegExp
  }> = [
    {
      label: 'side loop, plain agent-scope payload timer',
      loop: 'reflector', overrides: {}, allowed: true,
    },
    {
      label: 'side loop, system-scope lambda',
      loop: 'reflector',
      overrides: { scope: ['system'], lambda: 'jobs/x.ts:run' },
      allowed: false,
      match: /cannot schedule a lambda timer/,
    },
    {
      label: 'side loop, agent-scope but carrying a lambda',
      loop: 'reflector',
      overrides: { lambda: 'jobs/x.ts:run' },
      allowed: false,
      match: /cannot schedule a lambda timer/,
    },
    {
      label: 'side loop, locked agent-scope payload timer',
      loop: 'reflector',
      overrides: { locked: true },
      allowed: false,
      match: /locked timers are operator-only/,
    },
    {
      label: 'side loop, locked AND lambda',
      loop: 'reflector',
      overrides: { locked: true, lambda: 'jobs/x.ts:run' },
      allowed: false,
    },
    {
      label: 'side loop, locked:false is not a lock',
      loop: 'reflector', overrides: { locked: false }, allowed: true,
    },
    { label: 'main, lambda', loop: 'main', overrides: { scope: ['system'], lambda: 'jobs/x.ts:run' }, allowed: true },
    { label: 'main, locked', loop: 'main', overrides: { locked: true }, allowed: true },
    { label: 'main, locked lambda', loop: 'main', overrides: { locked: true, lambda: 'jobs/x.ts:run' }, allowed: true },
  ]

  for (const { label, loop, overrides, allowed, match } of cases) {
    it(`${label} → ${allowed ? 'allowed' : 'refused'}`, async () => {
      const workspace = fakeWorkspace({ loop })
      const result = await timerTool.execute(input(overrides), workspace)
      expect(result.isError).toBe(!allowed)
      expect(workspace.addTimer).toHaveBeenCalledTimes(allowed ? 1 : 0)
      if (match) expect(result.content).toMatch(match)
    })
  }

  it('tells a refused loop what actually makes an agent-scope timer reach it', () => {
    // Wave 3 routing: the timer ROW carries its loop and the evaluator
    // dispatches an agent-scope wake to that loop, so the prerequisite is no
    // longer "a parent target must name you" — it is the on_timer gate itself
    // (enabled, with an agent-scope target). The guard text must say the true
    // one, or the loop follows it into a timer that never fires.
    const workspace = fakeWorkspace({ loop: 'reflector' })
    return timerTool.execute(input({ lambda: 'jobs/x.ts:run' }), workspace).then(result => {
      expect(result.content).toMatch(/on_timer trigger is enabled/)
      expect(result.content).toMatch(/agent-scope target/)
      expect(result.content).toMatch(/inline/)
    })
  })

  it('refuses a locked timer even when the lambda would have been allowed anyway', async () => {
    const workspace = fakeWorkspace({ loop: 'reflector' })
    const result = await timerTool.execute(input({ locked: true }), workspace)
    expect(result.content).toMatch(/locked/i)
    expect(result.content).not.toMatch(/lambda timer/)
  })
})

// ===========================================================================
// sys_set_timer — targeting a loop (the reflector pattern, from main)
// ===========================================================================

describe('sys_set_timer loop targeting', () => {
  const timerTool = new SetTimerTool()

  function input(overrides: Record<string, unknown> = {}): unknown {
    return timerTool.inputSchema.parse({
      schedule: { type: 'delay', delay_ms: 60_000 },
      scope: ['agent'],
      payload: 'wake up and reflect',
      ...overrides,
    })
  }

  /** The stamp argument the workspace facade receives (8th positional). */
  function stampOf(workspace: ReturnType<typeof fakeWorkspace>): unknown {
    return workspace.addTimer.mock.calls[0]?.[7]
  }

  const config = hostConfig({ loops: [sideLoop('reflector'), sideLoop('critic', { enabled: false })] } as Partial<AgentConfig>)

  it('main may stamp a timer with a declared side loop', async () => {
    const workspace = fakeWorkspace({ loop: 'main', config })
    const result = await timerTool.execute(input({ loop: 'reflector' }), workspace)
    expect(result.isError).toBe(false)
    expect(stampOf(workspace)).toBe('reflector')
    expect(result.content).toMatch(/Wakes loop: reflector/)
  })

  it('a disabled loop is still a legal target — enabling it is a separate act', async () => {
    const workspace = fakeWorkspace({ loop: 'main', config })
    const result = await timerTool.execute(input({ loop: 'critic' }), workspace)
    expect(result.isError).toBe(false)
    expect(stampOf(workspace)).toBe('critic')
  })

  it('main naming "main" writes no stamp — the default is left clean', async () => {
    const workspace = fakeWorkspace({ loop: 'main', config })
    const result = await timerTool.execute(input({ loop: 'main' }), workspace)
    expect(result.isError).toBe(false)
    expect(stampOf(workspace)).toBeUndefined()
    expect(result.content).not.toMatch(/Wakes loop/)
  })

  it('main omitting the param writes no stamp', async () => {
    const workspace = fakeWorkspace({ loop: 'main', config })
    const result = await timerTool.execute(input(), workspace)
    expect(result.isError).toBe(false)
    expect(stampOf(workspace)).toBeUndefined()
  })

  it('an unknown loop is refused, and the refusal lists what exists', async () => {
    const workspace = fakeWorkspace({ loop: 'main', config })
    const result = await timerTool.execute(input({ loop: 'ghost' }), workspace)
    expect(result.isError).toBe(true)
    expect(workspace.addTimer).not.toHaveBeenCalled()
    expect(result.content).toMatch(/Unknown loop "ghost"/)
    expect(result.content).toMatch(/main, reflector, critic/)
  })

  it('a side loop may not choose the target loop, even its own name', async () => {
    for (const requested of ['critic', 'main', 'reflector']) {
      const workspace = fakeWorkspace({ loop: 'reflector', config })
      const result = await timerTool.execute(input({ loop: requested }), workspace)
      expect(result.isError).toBe(true)
      expect(workspace.addTimer).not.toHaveBeenCalled()
      expect(result.content).toMatch(/main-only/)
    }
  })

  it('a side loop without the param still self-stamps through the facade', async () => {
    const workspace = fakeWorkspace({ loop: 'reflector', config })
    const result = await timerTool.execute(input(), workspace)
    expect(result.isError).toBe(false)
    // The tool passes no override; AdfWorkspace.addTimer forces the bound loop.
    expect(stampOf(workspace)).toBeUndefined()
  })
})

// ===========================================================================
// LoopConfigSchema — the name is an identifier, not free text
// ===========================================================================

describe('LoopConfigSchema', () => {
  function parse(overrides: Record<string, unknown> = {}) {
    return LoopConfigSchema.safeParse({ name: 'reflector', goal: 'reflect', enabled: true, ...overrides })
  }

  const names: Array<{ name: string; ok: boolean }> = [
    { name: 'reflector', ok: true },
    { name: 'r', ok: true },
    { name: 'loop-2', ok: true },
    { name: 'consolidator_v2', ok: true },
    { name: '2fast', ok: true },
    { name: 'main', ok: false },            // reserved
    { name: 'main ', ok: false },           // trailing space reads as main
    { name: ' main', ok: false },
    { name: 'MAIN', ok: false },            // case-folds onto main in a UI
    { name: 'Reflector', ok: false },
    { name: 'loop:main', ok: false },       // spoofs the audit source
    { name: 'a\nb', ok: false },            // control chars in the [from loop:] stamp
    { name: 'a b', ok: false },
    { name: '', ok: false },
    { name: '-leading-dash', ok: false },
    { name: 'x'.repeat(32), ok: true },
    { name: 'x'.repeat(33), ok: false },
    { name: '../../etc', ok: false },
  ]

  for (const { name, ok } of names) {
    it(`name ${JSON.stringify(name)} → ${ok ? 'accepted' : 'rejected'}`, () => {
      expect(parse({ name }).success).toBe(ok)
    })
  }

  it('quotes the naming rule in the message', () => {
    const result = parse({ name: 'MAIN' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map(i => i.message).join(' ')).toMatch(/lowercase letters, digits/)
    }
  })

  it('caps the goal — it becomes the whole system instruction', () => {
    expect(parse({ goal: 'x'.repeat(LOOP_GOAL_MAX_CHARS) }).success).toBe(true)
    expect(parse({ goal: 'x'.repeat(LOOP_GOAL_MAX_CHARS + 1) }).success).toBe(false)
    expect(parse({ goal: '' }).success).toBe(false)
  })

  it('caps the tool allow-list length', () => {
    expect(parse({ tools: Array.from({ length: LOOP_TOOLS_MAX }, (_, i) => `t_${i}`) }).success).toBe(true)
    expect(parse({ tools: Array.from({ length: LOOP_TOOLS_MAX + 1 }, (_, i) => `t_${i}`) }).success).toBe(false)
  })

  it('rejects the hard-prohibited tool names', () => {
    for (const name of ['sys_update_config', 'loop_manage', 'sys_create_adf']) {
      expect(parse({ tools: [name] }).success).toBe(false)
    }
  })

  // Mirrors the host's `context.compact_threshold`
  // (z.number().int().positive().nullable().optional()) — the loop value lands
  // in exactly that field of the derived config.
  const thresholds: Array<{ value: unknown; ok: boolean }> = [
    { value: 50_000, ok: true },
    { value: 1, ok: true },
    { value: null, ok: true },       // null reads as "inherit", like the host field
    { value: 0, ok: false },         // positive
    { value: -1, ok: false },
    { value: 1.5, ok: false },       // int
    { value: '50000', ok: false },
  ]

  for (const { value, ok } of thresholds) {
    it(`compact_threshold ${JSON.stringify(value)} → ${ok ? 'accepted' : 'rejected'}`, () => {
      expect(parse({ compact_threshold: value }).success).toBe(ok)
    })
  }

  it('compact_threshold is optional — absent means inherit', () => {
    const result = parse()
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.compact_threshold).toBeUndefined()
  })

  it('rejects duplicate loop names case-insensitively', () => {
    const one = { name: 'reflector', goal: 'a', enabled: true }
    expect(LoopsConfigSchema.safeParse([one, { ...one }]).success).toBe(false)
    // Uppercase never survives the name rule, so the case-folded uniqueness
    // check is belt-and-braces for anything reaching the array by a looser path.
    expect(LoopsConfigSchema.safeParse([one, { ...one, name: 'Reflector' }]).success).toBe(false)
    expect(LoopsConfigSchema.safeParse([one, { ...one, name: 'critic' }]).success).toBe(true)
  })
})

// ===========================================================================
// loop_manage
// ===========================================================================

describe('loop_manage', () => {
  const poollessTool = new LoopManageTool(() => null)

  it('offers no `list` action — that is loop_list, an ordinary tool main holds', () => {
    const schema = new LoopManageTool(() => null).toProviderFormat()
      .input_schema as { properties: { action: { enum: string[] } } }
    expect(schema.properties.action.enum).toEqual(['create', 'get', 'update', 'delete'])
  })

  function make(pool: LoopPoolApi): LoopManageTool {
    return new LoopManageTool(() => pool)
  }

  it('refuses any caller that is not main', async () => {
    const pool = fakePool()
    const result = await make(pool).execute(
      { action: 'get', name: 'reflector' },
      fakeWorkspace({ loop: 'reflector' }),
    )
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/main loop only/)
  })

  it('degrades to a clear error when the pool is absent', async () => {
    const result = await poollessTool.execute({ action: 'get', name: 'reflector' }, fakeWorkspace())
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/Loop runtime is unavailable/)
  })

  describe('create validation', () => {
    const cases: Array<{ label: string; config: Record<string, unknown>; match: RegExp }> = [
      { label: 'bad name', config: { name: 'MAIN', goal: 'g' }, match: /Invalid loop config/ },
      { label: 'name with a colon', config: { name: 'loop:main', goal: 'g' }, match: /Invalid loop config/ },
      { label: 'missing goal', config: { name: 'reflector' }, match: /Invalid loop config/ },
      { label: 'over-long goal', config: { name: 'reflector', goal: 'x'.repeat(LOOP_GOAL_MAX_CHARS + 1) }, match: /Invalid loop config/ },
      { label: 'prohibited tool', config: { name: 'reflector', goal: 'g', tools: ['sys_update_config'] }, match: /prohibited tool/ },
      { label: 'unknown tool', config: { name: 'reflector', goal: 'g', tools: ['no_such_tool'] }, match: /no such tool on this agent/ },
      { label: 'restricted host tool', config: { name: 'reflector', goal: 'g', tools: ['shell_exec'] }, match: /never grantable to a loop/ },
    ]

    for (const { label, config, match } of cases) {
      it(`rejects ${label}`, async () => {
        const pool = fakePool()
        const result = await make(pool).execute({ action: 'create', config }, fakeWorkspace())
        expect(result.isError).toBe(true)
        expect(result.content).toMatch(match)
        expect(pool.calls.create).toHaveLength(0)
      })
    }

    it('quotes the available tools when a name is unavailable', async () => {
      const pool = fakePool()
      const result = await make(pool).execute(
        { action: 'create', config: { name: 'reflector', goal: 'g', tools: ['nope'] } },
        fakeWorkspace(),
      )
      expect(result.content).toMatch(/Available: fs_read, msg_send/)
      // never advertises the restricted or prohibited ones
      expect(result.content).not.toMatch(/shell_exec/)
      expect(result.content).not.toMatch(/Available:[^.]*loop_manage/)
    })

    it('rejects creating a loop that already exists', async () => {
      const pool = fakePool({ loops: [sideLoop('reflector')] })
      const result = await make(pool).execute(
        { action: 'create', config: { name: 'reflector', goal: 'g' } },
        fakeWorkspace(),
      )
      expect(result.isError).toBe(true)
      expect(result.content).toMatch(/already exists/)
    })

    it('rejects creating main', async () => {
      const pool = fakePool()
      const result = await make(pool).execute(
        { action: 'create', config: { name: 'main', goal: 'g' } },
        fakeWorkspace(),
      )
      expect(result.isError).toBe(true)
      expect(pool.calls.create).toHaveLength(0)
    })

    it(`refuses the ${MAX_SIDE_LOOPS + 1}th side loop`, async () => {
      const full = Array.from({ length: MAX_SIDE_LOOPS }, (_, i) => sideLoop(`loop_${i}`))
      const pool = fakePool({ loops: full })
      const result = await make(pool).execute(
        { action: 'create', config: { name: 'one_more', goal: 'g' } },
        fakeWorkspace(),
      )
      expect(result.isError).toBe(true)
      expect(result.content).toMatch(new RegExp(`maximum \\(${MAX_SIDE_LOOPS}\\)`))
      expect(pool.calls.create).toHaveLength(0)
    })

    it(`allows the ${MAX_SIDE_LOOPS}th side loop`, async () => {
      const nearlyFull = Array.from({ length: MAX_SIDE_LOOPS - 1 }, (_, i) => sideLoop(`loop_${i}`))
      const pool = fakePool({ loops: nearlyFull })
      const result = await make(pool).execute(
        { action: 'create', config: { name: 'one_more', goal: 'g' } },
        fakeWorkspace(),
      )
      expect(result.isError).toBe(false)
      expect(pool.calls.create).toHaveLength(1)
    })
  })

  describe('create reporting', () => {
    it('reports the pool\'s effective tool set, not the request', async () => {
      const pool = fakePool({
        createResult: { effectiveTools: ['fs_read', 'loop_send', 'loop_list', 'loop_compact'] },
      })
      const result = await make(pool).execute(
        { action: 'create', config: { name: 'reflector', goal: 'g', tools: ['fs_read'] } },
        fakeWorkspace(),
      )
      expect(result.isError).toBe(false)
      expect(result.content).toMatch(/Tools: fs_read, loop_send, loop_list, loop_compact\./)
    })

    it('falls back to the prediction when the pool returns nothing', async () => {
      const pool = fakePool({ createResult: undefined })
      const result = await make(pool).execute(
        { action: 'create', config: { name: 'reflector', goal: 'g', tools: ['fs_read'] } },
        fakeWorkspace(),
      )
      expect(result.content).toMatch(/Tools: fs_read\./)
    })

    it('seeds the default loop tools when `tools` is omitted entirely', async () => {
      // Not an implicit grant — a DEFAULT. It lands in loop.tools, where the
      // owner (or a later update) can see it and take it away.
      const config = hostConfig({ tools: [decl('fs_read'), decl('loop_send'), decl('loop_list'), decl('sys_set_state')] })
      const pool = fakePool()
      await make(pool).execute(
        { action: 'create', config: { name: 'reflector', goal: 'g' } },
        fakeWorkspace({ config }),
      )
      expect(pool.calls.create[0].tools).toEqual(['loop_send', 'loop_list', 'sys_set_state'])
    })

    it('takes an explicit list literally, including an empty one', async () => {
      const config = hostConfig({ tools: [decl('fs_read'), decl('loop_send'), decl('loop_list')] })
      const pool = fakePool()
      await make(pool).execute(
        { action: 'create', config: { name: 'hermit', goal: 'g', tools: [] } },
        fakeWorkspace({ config }),
      )
      expect(pool.calls.create[0].tools).toEqual([])

      await make(pool).execute(
        { action: 'create', config: { name: 'reader', goal: 'g', tools: ['fs_read'] } },
        fakeWorkspace({ config }),
      )
      expect(pool.calls.create[1].tools).toEqual(['fs_read'])
    })

    it('drops a default the host cannot grant rather than failing the create', async () => {
      // The owner turned loop_send off on the agent; a name the model never
      // typed must not be what makes its create fail.
      const config = hostConfig({ tools: [decl('fs_read'), decl('loop_send', { enabled: false }), decl('loop_list')] })
      const pool = fakePool()
      const result = await make(pool).execute(
        { action: 'create', config: { name: 'reflector', goal: 'g' } },
        fakeWorkspace({ config }),
      )
      expect(result.isError).toBe(false)
      expect(pool.calls.create[0].tools).toEqual(['loop_list'])
    })

    it('proceeds when an explicitly requested tool is merely host-DISABLED, and says so', async () => {
      const config = hostConfig({ tools: [decl('fs_read'), decl('msg_send', { enabled: false })] })
      const pool = fakePool({ createResult: { effectiveTools: ['fs_read'] } })
      const result = await make(pool).execute(
        { action: 'create', config: { name: 'reflector', goal: 'g', tools: ['fs_read', 'msg_send'] } },
        fakeWorkspace({ config }),
      )
      expect(result.isError).toBe(false)
      // The name is kept — it takes effect if the owner enables it later.
      expect(pool.calls.create[0].tools).toEqual(['fs_read', 'msg_send'])
      expect(result.content).toMatch(/Excluded for now: msg_send/)
      expect(result.content).toMatch(/disabled on this agent/)
    })

    it('says nothing about exclusions when there are none', async () => {
      const pool = fakePool({ createResult: { effectiveTools: ['fs_read'] } })
      const result = await make(pool).execute(
        { action: 'create', config: { name: 'reflector', goal: 'g', tools: ['fs_read'] } },
        fakeWorkspace(),
      )
      expect(result.content).not.toMatch(/Excluded for now/)
    })

    it('defaults enabled to true and passes the validated config to the pool', async () => {
      const pool = fakePool()
      await make(pool).execute(
        { action: 'create', config: { name: 'reflector', goal: 'reflect' } },
        fakeWorkspace(),
      )
      expect(pool.calls.create[0]).toMatchObject({ name: 'reflector', goal: 'reflect', enabled: true, autostart: true })
    })

    it('autostarts by default: main wakes the new loop with a kickoff message', async () => {
      const pool = fakePool()
      const result = await make(pool).execute(
        { action: 'create', config: { name: 'reflector', goal: 'reflect' } },
        fakeWorkspace(),
      )
      expect(result.isError).toBe(false)
      expect(pool.calls.send).toEqual([['main', 'reflector', LOOP_AUTOSTART_MESSAGE, true]])
      expect(result.content).toMatch(/running its first turn/)
      expect(result.content).toMatch(/whenever this agent starts/)
    })

    it('autostart: false leaves the loop waiting for a trigger, timer or loop_send', async () => {
      const pool = fakePool()
      const result = await make(pool).execute(
        { action: 'create', config: { name: 'reflector', goal: 'reflect', autostart: false } },
        fakeWorkspace(),
      )
      expect(result.isError).toBe(false)
      expect(pool.calls.send).toHaveLength(0)
      expect(result.content).toMatch(/waiting/)
      expect(pool.calls.create[0]).toMatchObject({ autostart: false })
    })

    it('update can flip autostart and passes it through as a patch', async () => {
      const pool = fakePool({ loops: [sideLoop('reflector')] })
      const result = await make(pool).execute(
        { action: 'update', name: 'reflector', config: { autostart: true } },
        fakeWorkspace(),
      )
      expect(result.isError).toBe(false)
      expect(pool.calls.update).toEqual([['reflector', { autostart: true }]])
    })

    it('autonomous is off unless asked for, and passes through on create and update', async () => {
      const pool = fakePool({ loops: [sideLoop('reflector')] })
      await make(pool).execute(
        { action: 'create', config: { name: 'critic', goal: 'g' } },
        fakeWorkspace(),
      )
      expect(pool.calls.create[0]).not.toHaveProperty('autonomous')
      await make(pool).execute(
        { action: 'create', config: { name: 'critic2', goal: 'g', autonomous: true } },
        fakeWorkspace(),
      )
      expect(pool.calls.create[1]).toMatchObject({ autonomous: true })
      const result = await make(pool).execute(
        { action: 'update', name: 'reflector', config: { autonomous: true } },
        fakeWorkspace(),
      )
      expect(result.isError).toBe(false)
      expect(pool.calls.update).toEqual([['reflector', { autonomous: true }]])
    })

    it('does not kick off a loop created disabled', async () => {
      const pool = fakePool()
      const result = await make(pool).execute(
        { action: 'create', config: { name: 'reflector', goal: 'reflect', enabled: false } },
        fakeWorkspace(),
      )
      expect(result.isError).toBe(false)
      expect(pool.calls.send).toHaveLength(0)
      expect(result.content).toMatch(/disabled/)
    })

    it('reports when the kickoff was delivered but did not wake', async () => {
      const pool = fakePool({ sendResult: { delivered: true, woke: false, reason: 'loop disabled' } })
      const result = await make(pool).execute(
        { action: 'create', config: { name: 'reflector', goal: 'reflect' } },
        fakeWorkspace(),
      )
      expect(result.isError).toBe(false)
      expect(result.content).toMatch(/has not started \(loop disabled\)/)
    })

    it('carries compact_threshold through to the pool', async () => {
      const pool = fakePool()
      const result = await make(pool).execute(
        { action: 'create', config: { name: 'reflector', goal: 'reflect', compact_threshold: 40_000 } },
        fakeWorkspace(),
      )
      expect(result.isError).toBe(false)
      expect(pool.calls.create[0]).toMatchObject({ compact_threshold: 40_000 })
    })

    it('omits compact_threshold entirely when unset — absent is what inherits', async () => {
      const pool = fakePool()
      await make(pool).execute(
        { action: 'create', config: { name: 'reflector', goal: 'reflect' } },
        fakeWorkspace(),
      )
      expect(pool.calls.create[0]).not.toHaveProperty('compact_threshold')
    })

    it('rejects a non-positive compact_threshold', async () => {
      const pool = fakePool()
      const result = await make(pool).execute(
        { action: 'create', config: { name: 'reflector', goal: 'reflect', compact_threshold: 0 } },
        fakeWorkspace(),
      )
      expect(result.isError).toBe(true)
      expect(result.content).toMatch(/Invalid loop config/)
      expect(pool.calls.create).toHaveLength(0)
    })
  })

  describe('update', () => {
    it('refuses a rename', async () => {
      const pool = fakePool({ loops: [sideLoop('reflector')] })
      const result = await make(pool).execute(
        { action: 'update', name: 'reflector', config: { name: 'critic' } },
        fakeWorkspace(),
      )
      expect(result.isError).toBe(true)
      expect(result.content).toMatch(/cannot be renamed/)
      expect(pool.calls.update).toHaveLength(0)
    })

    it('refuses to manage main', async () => {
      const pool = fakePool()
      const result = await make(pool).execute(
        { action: 'update', name: 'main', config: { goal: 'g' } },
        fakeWorkspace(),
      )
      expect(result.isError).toBe(true)
      expect(result.content).toMatch(/sys_update_config/)
    })

    it('sends only the named fields as the patch', async () => {
      const pool = fakePool({ loops: [sideLoop('reflector', { tools: ['fs_read'] })] })
      const result = await make(pool).execute(
        { action: 'update', name: 'reflector', config: { goal: 'a new charter' } },
        fakeWorkspace(),
      )
      expect(result.isError).toBe(false)
      expect(pool.calls.update).toEqual([['reflector', { goal: 'a new charter' }]])
    })

    it('validates the MERGED loop, not the patch alone', async () => {
      const pool = fakePool({ loops: [sideLoop('reflector')] })
      const result = await make(pool).execute(
        { action: 'update', name: 'reflector', config: { tools: ['shell_exec'] } },
        fakeWorkspace(),
      )
      expect(result.isError).toBe(true)
      expect(result.content).toMatch(/never grantable to a loop/)
      expect(pool.calls.update).toHaveLength(0)
    })

    it('update accepts a host-DISABLED tool and reports the exclusion', async () => {
      const config = hostConfig({ tools: [decl('fs_read'), decl('msg_send', { enabled: false })] })
      const pool = fakePool({ loops: [sideLoop('reflector', { tools: ['fs_read'] })] })
      const result = await make(pool).execute(
        { action: 'update', name: 'reflector', config: { tools: ['fs_read', 'msg_send'] } },
        fakeWorkspace({ config }),
      )
      expect(result.isError).toBe(false)
      expect(pool.calls.update).toEqual([['reflector', { tools: ['fs_read', 'msg_send'] }]])
      expect(result.content).toMatch(/Excluded for now: msg_send/)
    })

    it('patches compact_threshold on its own', async () => {
      const pool = fakePool({ loops: [sideLoop('reflector')] })
      const result = await make(pool).execute(
        { action: 'update', name: 'reflector', config: { compact_threshold: 250_000 } },
        fakeWorkspace(),
      )
      expect(result.isError).toBe(false)
      expect(pool.calls.update).toEqual([['reflector', { compact_threshold: 250_000 }]])
    })

    it('rejects an invalid compact_threshold on update', async () => {
      const pool = fakePool({ loops: [sideLoop('reflector')] })
      const result = await make(pool).execute(
        { action: 'update', name: 'reflector', config: { compact_threshold: -5 } },
        fakeWorkspace(),
      )
      expect(result.isError).toBe(true)
      expect(result.content).toMatch(/Invalid loop config/)
      expect(pool.calls.update).toHaveLength(0)
    })

    it('rejects a patch that names no changeable field', async () => {
      const pool = fakePool({ loops: [sideLoop('reflector')] })
      const result = await make(pool).execute(
        { action: 'update', name: 'reflector', config: {} },
        fakeWorkspace(),
      )
      expect(result.isError).toBe(true)
      expect(result.content).toMatch(/Nothing to update/)
    })

    it('reports an unknown loop with the side-loop list', async () => {
      const pool = fakePool({ loops: [sideLoop('reflector')] })
      const result = await make(pool).execute(
        { action: 'update', name: 'ghost', config: { goal: 'g' } },
        fakeWorkspace(),
      )
      expect(result.isError).toBe(true)
      expect(result.content).toMatch(/Inner loops: reflector/)
    })
  })

  describe('delete', () => {
    it('refuses to delete main', async () => {
      const pool = fakePool({ loops: [sideLoop('reflector')] })
      const result = await make(pool).execute({ action: 'delete', name: 'main' }, fakeWorkspace())
      expect(result.isError).toBe(true)
      expect(pool.calls.del).toHaveLength(0)
    })

    it('reports the archived entry count', async () => {
      const pool = fakePool({ loops: [sideLoop('reflector')] })
      const result = await make(pool).execute({ action: 'delete', name: 'reflector' }, fakeWorkspace())
      expect(result.isError).toBe(false)
      expect(result.content).toMatch(/3 entries.*loop:reflector/)
    })
  })

  it('surfaces a pool error as a tool error rather than throwing', async () => {
    const pool = fakePool()
    pool.createLoop = async () => { throw new Error('pool said no') }
    const result = await make(pool).execute(
      { action: 'create', config: { name: 'reflector', goal: 'g' } },
      fakeWorkspace(),
    )
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/pool said no/)
  })
})

// ===========================================================================
// loop_send
// ===========================================================================

describe('loop_send', () => {
  function make(pool: LoopPoolApi | null): LoopSendTool {
    return new LoopSendTool(() => pool)
  }

  it('refuses a send to your own loop', async () => {
    const pool = fakePool({ loops: [sideLoop('reflector')] })
    const result = await make(pool).execute(
      { to_loop: 'reflector', content: 'hi' },
      fakeWorkspace({ loop: 'reflector' }),
    )
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/your own loop/)
    expect(pool.calls.send).toHaveLength(0)
  })

  it('refuses an unknown loop and names the ones that exist', async () => {
    const pool = fakePool({ loops: [sideLoop('reflector')] })
    const result = await make(pool).execute({ to_loop: 'ghost', content: 'hi' }, fakeWorkspace())
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/Loops on this agent: main, reflector/)
  })

  describe('content cap (mirrors the loop_inject limit)', () => {
    const sendTool = new LoopSendTool(() => null)
    const cases: Array<{ label: string; content: string; ok: boolean }> = [
      { label: 'empty', content: '', ok: false },
      { label: 'ordinary', content: 'hello', ok: true },
      { label: 'at the cap', content: 'x'.repeat(LOOP_SEND_MAX_CHARS), ok: true },
      { label: 'over the cap', content: 'x'.repeat(LOOP_SEND_MAX_CHARS + 1), ok: false },
    ]
    for (const { label, content, ok } of cases) {
      it(`${label} → ${ok ? 'accepted' : 'rejected'}`, () => {
        expect(sendTool.inputSchema.safeParse({ to_loop: 'main', content }).success).toBe(ok)
      })
    }
    it('is the default loop_inject bound (max_tool_result_tokens 16000 * 3)', () => {
      expect(LOOP_SEND_MAX_CHARS).toBe(16_000 * 3)
    })
  })

  it('stamps the sender loop and hands the pool the caller-derived name', async () => {
    const pool = fakePool({ loops: [sideLoop('reflector')] })
    const result = await make(pool).execute(
      { to_loop: 'main', content: 'have a look at this' },
      fakeWorkspace({ loop: 'reflector' }),
    )
    expect(result.isError).toBe(false)
    expect(result.content).toMatch(/\[from loop:reflector\]/)
    expect(pool.calls.send).toEqual([['reflector', 'main', 'have a look at this', false]])
  })

  it('says the loop is running when the pool woke it', async () => {
    const pool = fakePool({
      loops: [sideLoop('reflector')],
      sendResult: { delivered: true, woke: true },
    })
    const result = await make(pool).execute({ to_loop: 'reflector', content: 'go', wake: true }, fakeWorkspace())
    expect(result.content).toMatch(/running a turn now/)
  })

  describe('a disabled target is delivered but never read', () => {
    it('does not claim it will be read on the next run', async () => {
      const pool = fakePool({
        loops: [sideLoop('reflector', { enabled: false })],
        sendResult: { delivered: true, woke: false, reason: 'loop disabled' },
      })
      const result = await make(pool).execute({ to_loop: 'reflector', content: 'hi' }, fakeWorkspace())
      expect(result.isError).toBe(false)
      expect(result.content).toMatch(/DISABLED/)
      expect(result.content).toMatch(/re-enabled/)
      expect(result.content).not.toMatch(/read this on its next run/)
    })

    it('says the same thing when a wake was requested', async () => {
      const pool = fakePool({
        loops: [sideLoop('reflector', { enabled: false })],
        sendResult: { delivered: true, woke: false, reason: 'loop disabled' },
      })
      const result = await make(pool).execute(
        { to_loop: 'reflector', content: 'hi', wake: true },
        fakeWorkspace(),
      )
      expect(result.content).toMatch(/DISABLED/)
      expect(result.content).not.toMatch(/read this on its next run/)
    })

    it('still promises the next run for an ENABLED target', async () => {
      const pool = fakePool({ loops: [sideLoop('reflector')] })
      const result = await make(pool).execute({ to_loop: 'reflector', content: 'hi' }, fakeWorkspace())
      expect(result.content).toMatch(/read this on its next run/)
      expect(result.content).not.toMatch(/DISABLED/)
    })
  })

  it('reports a non-delivery as an error', async () => {
    const pool = fakePool({
      loops: [sideLoop('reflector')],
      sendResult: { delivered: false, woke: false, reason: 'stream is locked' },
    })
    const result = await make(pool).execute({ to_loop: 'reflector', content: 'hi' }, fakeWorkspace())
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/stream is locked/)
  })

  describe('pool-absent degradation', () => {
    it('errors rather than throwing when the accessor returns null', async () => {
      const result = await make(null).execute({ to_loop: 'main', content: 'hi' }, fakeWorkspace({ loop: 'reflector' }))
      expect(result.isError).toBe(true)
      expect(result.content).toMatch(/Loop runtime is unavailable/)
    })

    it('errors rather than throwing when the accessor itself throws', async () => {
      const throwing = new LoopSendTool(() => { throw new Error('mid-teardown') })
      const result = await throwing.execute({ to_loop: 'main', content: 'hi' }, fakeWorkspace({ loop: 'reflector' }))
      expect(result.isError).toBe(true)
      expect(result.content).toMatch(/Loop runtime is unavailable/)
    })
  })

  it('turns a pool throw into a tool error', async () => {
    const pool = fakePool({ loops: [sideLoop('reflector')] })
    pool.sendToLoop = async () => { throw new Error('append failed') }
    const result = await make(pool).execute({ to_loop: 'reflector', content: 'hi' }, fakeWorkspace())
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/append failed/)
  })
})
