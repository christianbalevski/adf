import { describe, expect, it } from 'vitest'
import { deleteLoopConsequence, loopMenuState, patchLoopByName, removeLoopByName } from '../../../src/renderer/utils/loop-menu'
import type { LoopConfig } from '../../../src/shared/types/adf-v02.types'
import { LoopConfigSchema } from '../../../src/main/adf/adf-schema'

describe('loopMenuState', () => {
  it('offers Disable on an enabled loop and Enable on a disabled one', () => {
    expect(loopMenuState({ enabled: true }).toggleEnabled).toEqual({ label: 'Disable', enabled: false })
    expect(loopMenuState({ enabled: false }).toggleEnabled).toEqual({ label: 'Enable', enabled: true })
  })

  it('greys out autostart on for a goal-less loop, with the reason', () => {
    for (const goal of [undefined, '', '   ']) {
      const item = loopMenuState({ enabled: true, goal }).toggleAutostart
      expect(item).toEqual({ label: 'Turn autostart on', autostart: true, disabledReason: 'Add a goal first' })
    }
  })

  it('allows autostart on for an enabled loop with a goal', () => {
    expect(loopMenuState({ enabled: true, goal: 'tidy notes' }).toggleAutostart.disabledReason).toBeNull()
  })

  it('greys out autostart on for a disabled loop, as the config card does', () => {
    expect(loopMenuState({ enabled: false, goal: 'tidy notes' }).toggleAutostart.disabledReason).toBe('Enable the loop first')
  })

  it('always allows autostart off, even on a goal-less config written past the schema', () => {
    const item = loopMenuState({ enabled: true, autostart: true }).toggleAutostart
    expect(item).toEqual({ label: 'Turn autostart off', autostart: false, disabledReason: null })
  })

  it('never offers a change the schema refuses', () => {
    const cases: Array<Pick<LoopConfig, 'enabled' | 'autostart' | 'goal'>> = [
      { enabled: true }, { enabled: true, goal: 'g' }, { enabled: false }, { enabled: true, autostart: true, goal: 'g' },
    ]
    for (const loop of cases) {
      const { toggleAutostart } = loopMenuState(loop)
      if (toggleAutostart.disabledReason) continue
      const next = { name: 'loop-1', ...loop, autostart: toggleAutostart.autostart || undefined }
      expect(LoopConfigSchema.safeParse(next).success).toBe(true)
    }
  })
})

describe('deleteLoopConsequence', () => {
  it('says the stream is archived when the agent is running', () => {
    expect(deleteLoopConsequence('loop-2', true)).toBe('The loop stops and its stream is archived to the audit log as loop:loop-2.')
  })

  it('says the stream is archived when the agent is stopped too', () => {
    expect(deleteLoopConsequence('loop-2', false)).toBe('Its stream is archived to the audit log as loop:loop-2.')
  })
})

describe('patchLoopByName / removeLoopByName', () => {
  const loops: LoopConfig[] = [{ name: 'a', enabled: true }, { name: 'b', enabled: true, goal: 'g' }]

  it('patches only the named loop and never its name', () => {
    expect(patchLoopByName(loops, 'b', { enabled: false, name: 'x' })).toEqual([
      { name: 'a', enabled: true },
      { name: 'b', enabled: false, goal: 'g' },
    ])
  })

  it('leaves the list alone for an unknown name', () => {
    expect(patchLoopByName(loops, 'zz', { enabled: false })).toEqual(loops)
    expect(removeLoopByName(loops, 'zz')).toEqual(loops)
  })

  it('removes the named loop', () => {
    expect(removeLoopByName(loops, 'a')).toEqual([{ name: 'b', enabled: true, goal: 'g' }])
    expect(removeLoopByName(undefined, 'a')).toEqual([])
  })
})
