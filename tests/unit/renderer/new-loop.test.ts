import { describe, expect, it } from 'vitest'
import { grantableLoopTools, newLoop, newLoopBlocker, nextLoopName } from '../../../src/renderer/utils/new-loop'
import { MAX_SIDE_LOOPS, type LoopConfig, type ToolDeclaration } from '../../../src/shared/types/adf-v02.types'
import { LoopConfigSchema } from '../../../src/main/adf/adf-schema'

function decl(name: string, overrides: Partial<ToolDeclaration> = {}): ToolDeclaration {
  return { name, enabled: true, visible: true, ...overrides }
}

function loops(...names: string[]): LoopConfig[] {
  return names.map((name) => ({ name, enabled: true }))
}

describe('nextLoopName', () => {
  it('starts at loop-1', () => {
    expect(nextLoopName([])).toBe('loop-1')
  })

  it('takes the first free number, filling gaps', () => {
    expect(nextLoopName(['loop-1', 'loop-2'])).toBe('loop-3')
    expect(nextLoopName(['loop-1', 'loop-3'])).toBe('loop-2')
    expect(nextLoopName(['reflector', 'loop-2'])).toBe('loop-1')
  })
})

describe('grantableLoopTools', () => {
  it('offers enabled host tools only, never restricted or prohibited ones, sorted', () => {
    const tools = [
      decl('msg_send'),
      decl('fs_read'),
      decl('fs_write', { enabled: false }),
      decl('shell_exec', { restricted: true }),
      decl('sys_update_config'),
      decl('loop_manage'),
    ]
    expect(grantableLoopTools(tools)).toEqual(['fs_read', 'msg_send'])
  })
})

describe('newLoop', () => {
  it('is blank: next free name, enabled, autostart off, no goal, seeded tools the host can grant', () => {
    const created = newLoop(loops('loop-1'), [decl('loop_send'), decl('sys_set_state'), decl('loop_list', { enabled: false })])
    expect(created).toEqual({ name: 'loop-2', enabled: true, autostart: false, tools: ['loop_send', 'sys_set_state'] })
    expect(LoopConfigSchema.safeParse(created).success).toBe(true)
  })

  it('leaves tools out when the host can grant none of the seed', () => {
    expect(newLoop(undefined, [decl('fs_read')])).toEqual({ name: 'loop-1', enabled: true, autostart: false })
  })
})

describe('newLoopBlocker', () => {
  it('blocks at the side-loop cap and says why', () => {
    expect(newLoopBlocker(undefined)).toBeNull()
    const full = loops(...Array.from({ length: MAX_SIDE_LOOPS }, (_, i) => `l${i}`))
    expect(newLoopBlocker(full.slice(1))).toBeNull()
    expect(newLoopBlocker(full)).toMatch(new RegExp(`maximum \\(${MAX_SIDE_LOOPS}\\)`))
  })
})
