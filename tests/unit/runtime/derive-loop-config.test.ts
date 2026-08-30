import { describe, expect, it } from 'vitest'
import {
  deriveLoopConfig,
  listAvailableLoopTools,
  validateLoopToolList,
  LOOP_ESSENTIAL_TOOLS,
  LOOP_DEFAULT_ON_TOOLS,
  SIDE_LOOP_CODE_EXECUTION,
  MAIN_LOOP,
  buildLoopPreamble,
} from '../../../src/main/adf/derive-loop-config'
import { CODE_EXECUTION_DEFAULTS } from '../../../src/shared/types/adf-v02.types'
import type {
  AgentConfig,
  LoopConfig,
  ToolDeclaration,
  TriggerTarget,
} from '../../../src/shared/types/adf-v02.types'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function tool(
  name: string,
  overrides: Partial<ToolDeclaration> = {},
): ToolDeclaration {
  return { name, enabled: true, visible: true, ...overrides }
}

function host(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    adf_version: '0.2',
    id: 'agent-1',
    name: 'agent-1',
    instructions: 'be the agent',
    model: { provider: 'anthropic', model_id: 'claude', temperature: 1 },
    tools: [tool('fs_read'), tool('sys_lambda'), tool('msg_send')],
    code_execution: { ...CODE_EXECUTION_DEFAULTS },
    ...overrides,
  } as unknown as AgentConfig
}

function loop(overrides: Partial<LoopConfig> = {}): LoopConfig {
  return {
    name: 'reflector',
    goal: 'reflect on the day',
    enabled: true,
    ...overrides,
  } as LoopConfig
}

/** Names the derived config actually turns ON. */
function grantedNames(config: AgentConfig): string[] {
  return config.tools.filter(t => t.enabled).map(t => t.name).sort()
}

function declFor(config: AgentConfig, name: string): ToolDeclaration | undefined {
  return config.tools.find(t => t.name === name)
}

// ---------------------------------------------------------------------------

describe('deriveLoopConfig — tool allow-list', () => {
  it('grants the essentials even when the host never declared them', () => {
    const derived = deriveLoopConfig(host(), loop({ tools: [] }))
    for (const name of LOOP_ESSENTIAL_TOOLS) {
      expect(declFor(derived, name)).toEqual({ name, enabled: true, visible: true })
    }
  })

  it('grants the requested intersection and nothing else', () => {
    const derived = deriveLoopConfig(host(), loop({ tools: ['fs_read'] }))
    expect(declFor(derived, 'fs_read')?.enabled).toBe(true)
    expect(declFor(derived, 'msg_send')?.enabled).toBe(false)
    expect(declFor(derived, 'msg_send')?.visible).toBe(false)
  })

  it('never carries `restricted` (or `locked`) into a derived declaration', () => {
    // LOAD-BEARING: adf-call-handler computes authorizedBypass from
    // `restricted && authorized`, so a carried flag would let a side loop's
    // authorized code call the tool with the disabled/HIL checks bypassed.
    const derived = deriveLoopConfig(
      host({ tools: [tool('fs_read', { restricted: true, locked: true }), tool('msg_send')] }),
      loop({ tools: [] }),
    )
    for (const decl of derived.tools) {
      expect(decl).not.toHaveProperty('restricted')
      expect(decl).not.toHaveProperty('locked')
    }
  })

  describe('default-on tools', () => {
    const cases: Array<{
      label: string
      decl: ToolDeclaration | null
      granted: boolean
    }> = [
      { label: 'undeclared on the host', decl: null, granted: true },
      { label: 'declared and enabled', decl: tool('loop_clear'), granted: true },
      { label: 'explicitly disabled by the host', decl: tool('loop_clear', { enabled: false }), granted: false },
      // The finding: a restricted default-on name used to skip the prohibition
      // check entirely, so a side loop got un-gated what main HIL-gates.
      { label: 'restricted by the host', decl: tool('loop_clear', { restricted: true }), granted: false },
      { label: 'restricted AND disabled', decl: tool('loop_clear', { enabled: false, restricted: true }), granted: false },
    ]

    for (const { label, decl, granted } of cases) {
      it(`loop_clear ${label} → ${granted ? 'granted' : 'NOT granted'}`, () => {
        const parent = host({ tools: decl ? [tool('fs_read'), decl] : [tool('fs_read')] })
        const derived = deriveLoopConfig(parent, loop({ tools: [] }))
        expect(declFor(derived, 'loop_clear')?.enabled ?? false).toBe(granted)
      })
    }

    it('is defined as loop_compact + loop_clear', () => {
      expect([...LOOP_DEFAULT_ON_TOOLS]).toEqual(['loop_compact', 'loop_clear'])
    })

    it('does not grant a default-on tool restricted by its MCP server', () => {
      const parent = host({
        tools: [tool('mcp_notion_search')],
        mcp: { servers: [{ name: 'notion', transport: 'stdio', restricted: true }] },
      } as unknown as Partial<AgentConfig>)
      const derived = deriveLoopConfig(parent, loop({ tools: ['mcp_notion_search'] }))
      expect(declFor(derived, 'mcp_notion_search')?.enabled).toBe(false)
    })
  })

  describe('duplicate declarations resolve exactly as the executor resolves them', () => {
    // dedupeToolDeclarations: first-wins, `restricted`/`locked` sticky-true. A
    // derive that used a raw first-wins `.find()` would call the tool
    // unrestricted whenever the restricted copy came second, and hand the side
    // loop an un-gated tool while main is still HIL-gated.
    const orders: Array<{ label: string; tools: ToolDeclaration[] }> = [
      {
        label: 'restricted first, unrestricted duplicate second',
        tools: [tool('fs_read', { restricted: true }), tool('fs_read', { restricted: false })],
      },
      {
        label: 'unrestricted first, restricted duplicate second',
        tools: [tool('fs_read', { restricted: false }), tool('fs_read', { restricted: true })],
      },
    ]

    for (const { label, tools } of orders) {
      it(`${label} → prohibited`, () => {
        const parent = host({ tools })
        expect(validateLoopToolList(parent, ['fs_read']).prohibited).toEqual(['fs_read'])
        expect(listAvailableLoopTools(parent)).not.toContain('fs_read')
        const derived = deriveLoopConfig(parent, loop({ tools: ['fs_read'] }))
        expect(declFor(derived, 'fs_read')?.enabled).toBe(false)
      })
    }

    it('emits one derived declaration per name', () => {
      const parent = host({
        tools: [tool('fs_read'), tool('fs_read'), tool('msg_send')],
      })
      const derived = deriveLoopConfig(parent, loop({ tools: ['fs_read'] }))
      expect(derived.tools.filter(t => t.name === 'fs_read')).toHaveLength(1)
    })

    it('never advertises a name validateLoopToolList would reject', () => {
      const parent = host({
        tools: [
          tool('fs_read', { restricted: false }),
          tool('fs_read', { restricted: true }),
          tool('msg_send'),
        ],
      })
      for (const name of listAvailableLoopTools(parent)) {
        expect(validateLoopToolList(parent, [name]).ok).toEqual([name])
      }
    })
  })

  describe('validateLoopToolList classification', () => {
    const parent = host({
      tools: [
        tool('fs_read'),
        tool('msg_send', { enabled: false }),
        tool('shell_exec', { restricted: true }),
        tool('sys_update_config'),
      ],
    })

    const cases: Array<{ name: string; bucket: 'ok' | 'unknown' | 'prohibited' }> = [
      { name: 'fs_read', bucket: 'ok' },
      { name: 'msg_send', bucket: 'unknown' },      // declared but disabled
      { name: 'never_heard_of_it', bucket: 'unknown' },
      { name: 'shell_exec', bucket: 'prohibited' }, // restricted → no HIL channel
      { name: 'sys_update_config', bucket: 'prohibited' },
      { name: 'loop_manage', bucket: 'prohibited' },
      { name: 'sys_create_adf', bucket: 'prohibited' },
    ]

    for (const { name, bucket } of cases) {
      it(`${name} → ${bucket}`, () => {
        const result = validateLoopToolList(parent, [name])
        expect(result[bucket]).toEqual([name])
      })
    }
  })
})

describe('deriveLoopConfig — compaction threshold', () => {
  /** How the executor reads it (agent-executor.ts). */
  function effective(config: AgentConfig): number {
    return config.context?.compact_threshold ?? config.model.compact_threshold ?? 100_000
  }

  it('inherits the host threshold when the loop names none', () => {
    const parent = host({ context: { compact_threshold: 120_000 } } as unknown as Partial<AgentConfig>)
    const derived = deriveLoopConfig(parent, loop())
    expect(derived.context?.compact_threshold).toBe(120_000)
    expect(effective(derived)).toBe(120_000)
  })

  it('inherits the default (no threshold anywhere) when neither sets one', () => {
    const derived = deriveLoopConfig(host(), loop())
    expect(derived.context?.compact_threshold).toBeUndefined()
    expect(effective(derived)).toBe(100_000)
  })

  it('overrides the host threshold with the loop\'s own', () => {
    const parent = host({ context: { compact_threshold: 120_000 } } as unknown as Partial<AgentConfig>)
    const derived = deriveLoopConfig(parent, loop({ compact_threshold: 30_000 }))
    expect(derived.context?.compact_threshold).toBe(30_000)
    expect(effective(derived)).toBe(30_000)
    // the host config is never touched
    expect(parent.context?.compact_threshold).toBe(120_000)
  })

  it('sets it on a host that has no context section at all', () => {
    const derived = deriveLoopConfig(host(), loop({ compact_threshold: 30_000 }))
    expect(effective(derived)).toBe(30_000)
  })

  it('reads an explicit null as inherit, not as "no threshold"', () => {
    const parent = host({ context: { compact_threshold: 120_000 } } as unknown as Partial<AgentConfig>)
    const derived = deriveLoopConfig(parent, loop({ compact_threshold: null }))
    expect(effective(derived)).toBe(120_000)
  })

  it('wins over a compact_threshold riding inside the loop model override', () => {
    // The executor prefers context over model, so the loop value has to land in
    // context or the inherited host number would shadow it.
    const parent = host({ context: { compact_threshold: 120_000 } } as unknown as Partial<AgentConfig>)
    const derived = deriveLoopConfig(
      parent,
      loop({
        model: { provider: 'anthropic', model_id: 'haiku', compact_threshold: 40_000 } as never,
        compact_threshold: 30_000,
      }),
    )
    expect(effective(derived)).toBe(30_000)
  })
})

describe('deriveLoopConfig — code_execution attenuation', () => {
  it('pins every CodeExecutionConfig key the defaults declare', () => {
    // A key added to CodeExecutionConfig without a decision here would silently
    // inherit the host's value — this is the test that forces the decision.
    const derived = deriveLoopConfig(host(), loop())
    for (const key of Object.keys(CODE_EXECUTION_DEFAULTS)) {
      expect(derived.code_execution).toHaveProperty(key)
    }
    for (const key of Object.keys(SIDE_LOOP_CODE_EXECUTION)) {
      expect(derived.code_execution).toHaveProperty(key)
    }
    expect(Object.keys(derived.code_execution ?? {}).sort())
      .toEqual([...new Set([...Object.keys(CODE_EXECUTION_DEFAULTS), 'packages'])].sort())
  })

  it('denies identity, task_resolve, attestations and network whatever the host allows', () => {
    const derived = deriveLoopConfig(host(), loop())
    expect(derived.code_execution).toMatchObject({
      get_identity: false,
      set_identity: false,
      task_resolve: false,
      attestation_list: false,
      attestation_add: false,
      attestation_issue: false,
      network: false,
      model_invoke: true,
      sys_lambda: true,
      identity_status: true,
      loop_inject: true,
      emit_event: true,
    })
  })

  it('inherits NO sandbox packages (pure-JS packages get an unrestricted require)', () => {
    const parent = host({
      code_execution: {
        ...CODE_EXECUTION_DEFAULTS,
        packages: [{ name: 'lodash', version: '4.0.0', enabled: true }],
      },
    } as unknown as Partial<AgentConfig>)
    const derived = deriveLoopConfig(parent, loop())
    expect(derived.code_execution?.packages).toEqual([])
    // and the parent is untouched
    expect(parent.code_execution?.packages).toHaveLength(1)
  })

  it('accumulates the host restricted_methods on top of the profile', () => {
    const parent = host({
      code_execution: { ...CODE_EXECUTION_DEFAULTS, restricted_methods: ['model_invoke'] },
    } as unknown as Partial<AgentConfig>)
    const derived = deriveLoopConfig(parent, loop())
    expect((derived.code_execution?.restricted_methods ?? []).sort())
      .toEqual(['attestation_issue', 'model_invoke'])
  })
})

describe('deriveLoopConfig — triggers', () => {
  function withTargets(targets: TriggerTarget[]): AgentConfig {
    return host({
      triggers: { on_timer: { enabled: true, targets } },
    } as unknown as Partial<AgentConfig>)
  }

  it('keeps only the targets that name this loop', () => {
    const parent = withTargets([
      { scope: 'agent', loop: 'reflector' },
      { scope: 'agent', loop: 'consolidator' },
      { scope: 'agent' },  // absent loop = main
    ])
    const derived = deriveLoopConfig(parent, loop({ name: 'reflector' }))
    expect(derived.triggers?.on_timer?.targets).toEqual([{ scope: 'agent', loop: 'reflector' }])
  })

  it('drops a system-scope target even when it names this loop (§2.3 SEC-2/5)', () => {
    // A system-scope lambda/command runs through the agent-wide
    // SystemScopeHandler under MAIN's authority. sys_set_timer refuses to let a
    // loop create one; a config-declared target is the same hole via config.
    const parent = withTargets([
      { scope: 'system', lambda: 'jobs/reflect.ts:run', loop: 'reflector' },
      { scope: 'agent', loop: 'reflector' },
    ])
    const derived = deriveLoopConfig(parent, loop({ name: 'reflector' }))
    expect(derived.triggers?.on_timer?.targets).toEqual([{ scope: 'agent', loop: 'reflector' }])
  })

  it('drops the whole trigger when every target that names the loop is system-scope', () => {
    const parent = withTargets([
      { scope: 'system', command: 'echo hi', loop: 'reflector' },
      { scope: 'system', lambda: 'jobs/x.ts:run', loop: 'reflector' },
    ])
    const derived = deriveLoopConfig(parent, loop({ name: 'reflector' }))
    expect(derived.triggers?.on_timer).toBeUndefined()
  })

  it('does not share target objects with the parent config', () => {
    const parent = withTargets([{ scope: 'agent', loop: 'reflector', debounce_ms: 100 }])
    const derived = deriveLoopConfig(parent, loop({ name: 'reflector' }))
    const target = derived.triggers?.on_timer?.targets?.[0] as TriggerTarget
    target.debounce_ms = 999
    expect(parent.triggers?.on_timer?.targets?.[0]?.debounce_ms).toBe(100)
  })
})

describe('deriveLoopConfig — shape', () => {
  it('refuses to derive a config for main', () => {
    expect(() => deriveLoopConfig(host(), loop({ name: MAIN_LOOP }))).toThrow(/main/)
  })

  it('stamps metadata.loop_name, empties loops, and takes the goal as instructions', () => {
    const derived = deriveLoopConfig(host(), loop({ goal: 'reflect' }))
    expect(derived.metadata?.loop_name).toBe('reflector')
    expect(derived.loops).toEqual([])
    // The goal is the whole charter, but it rides behind the standing preamble
    // that tells the loop it is a loop (see loop-prompting.test.ts).
    expect(derived.instructions).toBe(
      `${buildLoopPreamble('reflector', 'agent-1')}\n\nYour goal:\n\nreflect`,
    )
  })

  it('inherits the parent model unless the loop overrides it', () => {
    const parent = host()
    expect(deriveLoopConfig(parent, loop()).model).toEqual(parent.model)
    const overridden = deriveLoopConfig(
      parent,
      loop({ model: { provider: 'openai', model_id: 'gpt' } } as Partial<LoopConfig>),
    )
    expect(overridden.model).toMatchObject({ provider: 'openai', model_id: 'gpt' })
  })

  it('shares no sub-object with the parent', () => {
    const parent = host()
    const derived = deriveLoopConfig(parent, loop({ tools: ['fs_read'] }))
    derived.tools.push(tool('shell_exec'))
    expect(parent.tools.map(t => t.name)).not.toContain('shell_exec')
    expect(grantedNames(derived)).toContain('fs_read')
  })
})
