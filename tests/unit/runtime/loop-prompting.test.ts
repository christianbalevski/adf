import { describe, it, expect } from 'vitest'
import { AgentExecutor } from '../../../src/main/runtime/agent-executor'
import {
  buildLoopPreamble,
  buildMainLoopsSection,
  deriveLoopConfig,
} from '../../../src/main/adf/derive-loop-config'
import type { AgentConfig, LoopConfig } from '../../../src/shared/types/adf-v02.types'

/**
 * The two halves of the loop prompting contract:
 *
 *  - a SIDE loop learns what it is through its derived `instructions`
 *    (preamble + goal), because it never sees main's prompt;
 *  - MAIN learns it has loops through a '## Your Loops' section that must not
 *    exist at all for the loop-less majority (byte-identical regression bar).
 */

function host(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    adf_version: '0.2',
    id: 'did:adf:agent-1',
    name: 'agent-1',
    handle: 'agent-1',
    instructions: 'be the agent',
    model: { provider: 'anthropic', model_id: 'claude', temperature: 1 },
    tools: [
      { name: 'fs_read', enabled: true, visible: true },
      { name: 'loop_send', enabled: true, visible: true },
      { name: 'loop_list', enabled: true, visible: true },
    ],
    ...overrides,
  } as unknown as AgentConfig
}

/**
 * Loops carry the inter-loop pair explicitly now — they are ordinary
 * allow-listed tools, not essentials, so a loop that does not name them is a
 * deliberately mute one (exercised below).
 */
function loop(overrides: Partial<LoopConfig> = {}): LoopConfig {
  return {
    name: 'reflector',
    goal: 'reflect on the day',
    enabled: true,
    tools: ['loop_send', 'loop_list'],
    ...overrides,
  } as LoopConfig
}

/** buildSystemPrompt only needs a workspace for {{path}} resolution. */
function systemPrompt(config: AgentConfig): string {
  const session = { getWorkspace: () => ({ readFile: () => null }) } as never
  const executor = new AgentExecutor(config, {} as never, {} as never, session, '', {})
  return (executor as unknown as { buildSystemPrompt(): string }).buildSystemPrompt()
}

describe('side-loop preamble', () => {
  it('derived instructions are the preamble followed by the goal', () => {
    const derived = deriveLoopConfig(host(), loop({ goal: 'reflect on the day' }))
    expect(derived.instructions).toBe(
      `${buildLoopPreamble('reflector', 'agent-1', ['loop_send', 'loop_list'])}` +
        '\n\nYour goal:\n\nreflect on the day'
    )
  })

  it('names the loop, the agent, and main as the outward-facing loop', () => {
    const text = buildLoopPreamble('reflector', 'lyra', ['loop_send', 'loop_list'])
    expect(text).toContain('You are the "reflector" loop')
    expect(text).toContain('inside agent "lyra"')
    expect(text).toContain('"main" owns the outside world')
    expect(text).toContain('[from loop:reflector]')
    expect(text).toContain('loop_send')
    expect(text).toContain('loop_list')
    expect(text).toContain('end your turn')
  })

  it('stays short — it is re-sent on every turn of every loop', () => {
    const text = buildLoopPreamble('reflector', 'agent-1', ['loop_send', 'loop_list'])
    expect(text.split(/\s+/).length).toBeLessThan(220)
  })

  it('promises loop_send/loop_list only when the loop was granted them', () => {
    const mute = buildLoopPreamble('reflector', 'agent-1', ['fs_read'])
    expect(mute).not.toContain('loop_send')
    expect(mute).not.toContain('loop_list')
    expect(mute).toContain('no tool for addressing the other loops')

    const sendOnly = buildLoopPreamble('reflector', 'agent-1', ['loop_send'])
    expect(sendOnly).toContain('loop_send')
    expect(sendOnly).not.toContain('loop_list')

    const listOnly = buildLoopPreamble('reflector', 'agent-1', ['loop_list'])
    expect(listOnly).toContain('loop_list')
    expect(listOnly).not.toContain('loop_send')
  })

  it('a mute loop gets derived instructions that name no tool it lacks', () => {
    const derived = deriveLoopConfig(host(), loop({ tools: [] }))
    expect(derived.instructions).not.toContain('loop_send')
    expect(derived.instructions).not.toContain('loop_list')
  })

  it('falls back to the agent name when the config has no handle', () => {
    const derived = deriveLoopConfig(host({ handle: undefined }), loop())
    expect(derived.instructions).toContain('inside agent "agent-1"')
  })
})

describe('main loops section', () => {
  it('is null for a loop-less agent', () => {
    expect(buildMainLoopsSection(undefined, { loopManageEnabled: false })).toBeNull()
    expect(buildMainLoopsSection([], { loopManageEnabled: false })).toBeNull()
  })

  it('lists each loop with its goal and disabled state', () => {
    const text = buildMainLoopsSection(
      [loop(), loop({ name: 'watcher', goal: 'watch the feed', enabled: false })],
      { loopManageEnabled: false }
    ) as string
    expect(text).toContain('- **reflector** — reflect on the day')
    expect(text).toContain('- **watcher** — watch the feed _(disabled — not running)_')
    expect(text).toContain('[from loop:<name>]')
    expect(text).toContain('does not verify what it says')
    expect(text).not.toContain('loop_manage')
  })

  it('mentions loop_send/loop_list only when main actually has them', () => {
    const without = buildMainLoopsSection([loop()], { loopManageEnabled: false }) as string
    expect(without).not.toContain('loop_send')
    expect(without).not.toContain('loop_list')

    const with_ = buildMainLoopsSection([loop()], {
      loopManageEnabled: false,
      loopSendEnabled: true,
      loopListEnabled: true,
    }) as string
    expect(with_).toContain('`loop_send` addresses one loop by name')
    expect(with_).toContain('`loop_list` shows each loop')
  })

  it('truncates a long goal rather than inlining the whole charter', () => {
    const text = buildMainLoopsSection([loop({ goal: 'x'.repeat(400) })], {
      loopManageEnabled: false,
    }) as string
    expect(text).toContain('…')
    expect(text).not.toContain('x'.repeat(200))
  })

  it('mentions loop_manage only when it is enabled', () => {
    const text = buildMainLoopsSection([loop()], { loopManageEnabled: true }) as string
    expect(text).toContain('`loop_manage` is yours')
    expect(text).toContain('archives its stream')
  })
})

describe('system prompt assembly', () => {
  it('a loop-less agent gains nothing — byte-identical with loops absent or empty', () => {
    const withoutKey = systemPrompt(host())
    const withEmpty = systemPrompt(host({ loops: [] }))
    expect(withEmpty).toBe(withoutKey)
    expect(withoutKey).not.toContain('## Your Loops')
    expect(withoutKey).not.toContain('[from loop:')
  })

  it('one side loop appends the section and nothing else changes', () => {
    const base = systemPrompt(host())
    const withLoop = systemPrompt(host({ loops: [loop()] }))
    // host() declares loop_send/loop_list enabled, so the section names them.
    const section = buildMainLoopsSection([loop()], {
      loopManageEnabled: false,
      loopSendEnabled: true,
      loopListEnabled: true,
    }) as string
    expect(withLoop).toBe(`${base}\n\n---\n\n${section}`)
  })

  it('the section reflects loop_manage being enabled on the host', () => {
    const prompt = systemPrompt(
      host({
        loops: [loop()],
        tools: [{ name: 'loop_manage', enabled: true, visible: true }],  // and nothing else
      })
    )
    expect(prompt).toContain('`loop_manage` is yours')
  })

  it('a derived side-loop config carries no loops section (loops do not nest)', () => {
    const derived = deriveLoopConfig(host({ loops: [loop()] }), loop())
    const prompt = systemPrompt(derived)
    expect(prompt).not.toContain('## Your Loops')
    expect(prompt).toContain('You are the "reflector" loop')
  })
})
