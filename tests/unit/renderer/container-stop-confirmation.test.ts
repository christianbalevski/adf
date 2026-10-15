import { describe, expect, it } from 'vitest'
import { containerStopConfirmation } from '../../../src/renderer/components/settings/ContainerDestroyDialog'
import type { ContainerSummary } from '../../../src/shared/types/compute.types'

// Settings → Compute Stop (W5-D3): asks before stopping a container another
// live runtime on this machine uses, as it asked for the shared container
// while agents use it.

const row = (patch: Partial<ContainerSummary>): ContainerSummary => ({
  name: 'adf-agent-1-11111111', running: true, managed: true, scope: 'dedicated', ...patch,
} as ContainerSummary)

describe('containerStopConfirmation', () => {
  it('stops without asking when nothing else uses the container', () => {
    expect(containerStopConfirmation(row({}), false, [])).toBeNull()
    expect(containerStopConfirmation(row({ name: 'adf-mcp', scope: 'shared' }), true, [])).toBeNull()
  })

  it('names the other runtimes using it', () => {
    expect(containerStopConfirmation(row({ users: ['daemon pid 4242'] }), false, []))
      .toBe('Stop adf-agent-1-11111111? daemon pid 4242 also uses this container; its agents lose it until it starts again.')
    expect(containerStopConfirmation(row({ users: ['daemon pid 4242', 'studio-embedded pid 7'] }), false, []))
      .toMatch(/daemon pid 4242, studio-embedded pid 7 also use this container; their agents/)
  })

  it('keeps the shared container\'s active-agent question, with the users after it', () => {
    expect(containerStopConfirmation(row({ name: 'adf-mcp', scope: 'shared', users: ['daemon pid 4242'] }), true, ['a', 'b']))
      .toBe('Stop adf-mcp? 2 active agent(s) may be interrupted. daemon pid 4242 also uses this container; its agents lose it until it starts again.')
  })

  it('never asks for a stopped container (Start)', () => {
    expect(containerStopConfirmation(row({ running: false, users: ['daemon pid 4242'] }), false, [])).toBeNull()
  })
})
