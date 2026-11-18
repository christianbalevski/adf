import { describe, expect, it } from 'vitest'
import {
  deriveLoopConfig,
  listAvailableLoopTools,
  validateLoopToolList,
  LOOP_DEFAULT_ON_TOOLS,
  MAIN_LOOP,
  buildLoopPreamble,
} from '../../../src/main/adf/derive-loop-config'
import { CODE_EXECUTION_DEFAULTS, DEFAULT_NEW_LOOP_TOOLS } from '../../../src/shared/types/adf-v02.types'
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
  // Superseding the old "essentials" rule: there is no union after the
  // intersection any more, so loop_send/loop_list need BOTH host-enabled and a
  // named place in this loop's allow-list — same as fs_read.
  describe('the inter-loop tools are granted iff host-enabled AND allow-listed', () => {
    const cases: Array<{ label: string; decl: ToolDeclaration | null; ask: string[]; granted: boolean }> = [
      { label: 'host-enabled + asked for', decl: tool('loop_send'), ask: ['loop_send'], granted: true },
      { label: 'host-enabled but not asked for', decl: tool('loop_send'), ask: [], granted: false },
      { label: 'asked for but host-disabled', decl: tool('loop_send', { enabled: false }), ask: ['loop_send'], granted: false },
      { label: 'asked for but undeclared on the host', decl: null, ask: ['loop_send'], granted: false },
      { label: 'neither', decl: null, ask: [], granted: false },
    ]

    for (const { label, decl, ask, granted } of cases) {
      it(`${label} → ${granted ? 'granted' : 'NOT granted'}`, () => {
        const parent = host({ tools: decl ? [tool('fs_read'), decl] : [tool('fs_read')] })
        const derived = deriveLoopConfig(parent, loop({ tools: ask }))
        expect(declFor(derived, 'loop_send')?.enabled ?? false).toBe(granted)
      })
    }

    it('never unions them in — an empty allow-list is a mute loop', () => {
      const parent = host({
        // loop_compact/loop_clear declared-and-disabled so the default-on rule
        // leaves nothing behind and the assertion is about these two only.
        tools: [
          tool('fs_read'), tool('loop_send'), tool('loop_list'),
          tool('loop_compact', { enabled: false }), tool('loop_clear', { enabled: false }),
        ],
      })
      const derived = deriveLoopConfig(parent, loop({ tools: [] }))
      expect(grantedNames(derived)).toEqual([])
    })

    it('DEFAULT_NEW_LOOP_TOOLS is the pair plus sys_set_state, and only a suggestion', () => {
      expect([...DEFAULT_NEW_LOOP_TOOLS]).toEqual(['loop_send', 'loop_list', 'sys_set_state'])
    })
  })

  it('grants the requested intersection and nothing else', () => {
    const derived = deriveLoopConfig(host(), loop({ tools: ['fs_read'] }))
    expect(declFor(derived, 'fs_read')?.enabled).toBe(true)
    expect(declFor(derived, 'msg_send')?.enabled).toBe(false)
    expect(declFor(derived, 'msg_send')?.visible).toBe(false)
  })

  it('carries `restricted` and `locked` on a granted tool, as main has them', () => {
    // Granted + restricted behaves as on main: an LLM call asks the human, the
    // loop's authorized code bypasses.
    const derived = deriveLoopConfig(
      host({ tools: [tool('fs_read', { restricted: true, locked: true }), tool('msg_send')] }),
      loop({ tools: ['fs_read'] }),
    )
    expect(declFor(derived, 'fs_read')).toEqual({
      name: 'fs_read', enabled: true, visible: true, restricted: true, locked: true,
    })
  })

  it('never carries `restricted` (or `locked`) on a tool the loop was NOT granted', () => {
    // LOAD-BEARING: adf-call-handler computes authorizedBypass from
    // `restricted && authorized` and skips the enabled check on it, so a flag
    // on a non-granted tool would let the loop's authorized code call it.
    const derived = deriveLoopConfig(
      host({ tools: [tool('fs_read', { restricted: true, locked: true }), tool('msg_send')] }),
      loop({ tools: ['msg_send'] }),
    )
    expect(declFor(derived, 'fs_read')).toEqual({ name: 'fs_read', enabled: false, visible: false })
  })

  it('grants a tool whose MCP server is restricted; the cloned mcp config keeps the gate', () => {
    const parent = host({
      tools: [tool('mcp_notion_search')],
      mcp: { servers: [{ name: 'notion', transport: 'stdio', restricted: true }] },
    } as unknown as Partial<AgentConfig>)
    const derived = deriveLoopConfig(parent, loop({ tools: ['mcp_notion_search'] }))
    expect(declFor(derived, 'mcp_notion_search')?.enabled).toBe(true)
    expect(derived.mcp?.servers?.[0]?.restricted).toBe(true)
  })

  it('can grant sys_update_config, loop_manage and sys_create_adf', () => {
    const parent = host({ tools: [tool('sys_update_config'), tool('loop_manage'), tool('sys_create_adf')] })
    const derived = deriveLoopConfig(parent, loop({ tools: ['sys_update_config', 'loop_manage', 'sys_create_adf'] }))
    expect(grantedNames(derived)).toEqual(
      expect.arrayContaining(['loop_manage', 'sys_create_adf', 'sys_update_config']),
    )
    // Still flat: a loop holding loop_manage has no roster of its own.
    expect(derived.loops).toEqual([])
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
      // Granted, and still gated: the restricted flag rides along.
      { label: 'restricted by the host', decl: tool('loop_clear', { restricted: true }), granted: true },
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

    it('a restricted default-on tool keeps its restricted flag', () => {
      const parent = host({ tools: [tool('fs_read'), tool('loop_clear', { restricted: true })] })
      const derived = deriveLoopConfig(parent, loop({ tools: [] }))
      expect(declFor(derived, 'loop_clear')?.restricted).toBe(true)
    })
  })

  describe('duplicate declarations resolve exactly as the executor resolves them', () => {
    // dedupeToolDeclarations: first-wins, `restricted`/`locked` sticky-true. A
    // derive that used a raw first-wins `.find()` would carry the tool
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
      it(`${label} → granted, restricted`, () => {
        const parent = host({ tools })
        expect(validateLoopToolList(parent, ['fs_read']).ok).toEqual(['fs_read'])
        expect(listAvailableLoopTools(parent)).toContain('fs_read')
        const derived = deriveLoopConfig(parent, loop({ tools: ['fs_read'] }))
        expect(declFor(derived, 'fs_read')).toMatchObject({ enabled: true, restricted: true })
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

    const cases: Array<{ name: string; bucket: 'ok' | 'unknown' | 'disabled' }> = [
      { name: 'fs_read', bucket: 'ok' },
      // Its own bucket now: an owner's "off for now" is not a typo, and the
      // caller proceeds without it rather than failing the whole create.
      { name: 'msg_send', bucket: 'disabled' },
      { name: 'never_heard_of_it', bucket: 'unknown' },
      { name: 'shell_exec', bucket: 'ok' }, // restricted: approval in the loop's tab
      { name: 'sys_update_config', bucket: 'ok' },
      // Not declared on this host fixture.
      { name: 'loop_manage', bucket: 'unknown' },
    ]

    for (const { name, bucket } of cases) {
      it(`${name} → ${bucket}`, () => {
        const result = validateLoopToolList(parent, [name])
        expect(result[bucket]).toEqual([name])
      })
    }

    it('reports a disabled-AND-restricted name as disabled', () => {
      const p = host({ tools: [tool('mcp_x', { enabled: false, restricted: true })] })
      const result = validateLoopToolList(p, ['mcp_x'])
      expect(result.disabled).toEqual(['mcp_x'])
      expect(result).not.toHaveProperty('prohibited')
    })
  })
})

describe('deriveLoopConfig — compaction threshold', () => {
  /** How the executor reads it (agent-executor.ts). */
  function effective(config: AgentConfig): number {
    return config.context?.compact_threshold ?? config.model.compact_threshold ?? 100_000
  }

  it('autonomous is per-loop and never inherited from the host', () => {
    const parent = host({ autonomous: true })
    expect(deriveLoopConfig(parent, loop()).autonomous).toBe(false)
    expect(deriveLoopConfig(parent, loop({ autonomous: true })).autonomous).toBe(true)
    expect(deriveLoopConfig(host({ autonomous: false }), loop({ autonomous: true })).autonomous).toBe(true)
  })

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

describe('deriveLoopConfig — code_execution', () => {
  it('inherits the host code_execution as-is, packages included', () => {
    const parent = host({
      code_execution: {
        ...CODE_EXECUTION_DEFAULTS,
        network: true,
        get_identity: true,
        restricted_methods: ['model_invoke'],
        packages: [{ name: 'lodash', version: '4.0.0', enabled: true }],
      },
    } as unknown as Partial<AgentConfig>)
    const derived = deriveLoopConfig(parent, loop())
    expect(derived.code_execution).toEqual(parent.code_execution)
    // a copy, not the parent's object
    expect(derived.code_execution).not.toBe(parent.code_execution)
  })

  it('a later host revocation shows up on the next derive (no cached grant)', () => {
    const parent = host()
    expect(deriveLoopConfig(parent, loop()).code_execution?.model_invoke).toBe(true)
    const revoked = { ...parent, code_execution: { ...parent.code_execution!, model_invoke: false } }
    expect(deriveLoopConfig(revoked, loop()).code_execution?.model_invoke).toBe(false)
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

describe('deriveLoopConfig — no goal', () => {
  it('instructions are the preamble alone, with no empty goal heading', () => {
    const preamble = buildLoopPreamble('reflector', 'agent-1', grantedNames(deriveLoopConfig(host(), loop())))
    for (const goal of [undefined, '', '  \n ']) {
      const derived = deriveLoopConfig(host(), loop({ goal }))
      expect(derived.instructions).toBe(preamble)
      expect(derived.instructions).not.toContain('Your goal')
    }
  })
})

