import type { BackgroundAgentStatus, RendererBackgroundAgentEvent } from '../../shared/types/ipc.types'

function deriveHandle(payload: RendererBackgroundAgentEvent['payload']): string {
  return (payload as Record<string, unknown>).handle as string
    ?? payload.filePath.split('/').pop()?.replace('.adf', '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    ?? 'agent'
}

/**
 * Fold a batch of background events over the status list.
 *
 * Returns the SAME array when nothing moved — every subscriber re-renders on a
 * fresh reference, so a repeated state or loop count has to stay silent.
 */
export function foldAgentStatuses(
  agents: BackgroundAgentStatus[],
  events: RendererBackgroundAgentEvent[]
): BackgroundAgentStatus[] {
  let next = agents
  for (const event of events) {
    const filePath = event.payload.filePath
    switch (event.type) {
      case 'agent_started': {
        next = [...next.filter((a) => a.filePath !== filePath), {
          filePath,
          handle: deriveHandle(event.payload),
          state: event.payload.state ?? 'idle',
          activeLoops: 0
        }]
        break
      }
      case 'agent_stopped': {
        if (!next.some((a) => a.filePath === filePath)) break
        next = next.filter((a) => a.filePath !== filePath)
        break
      }
      case 'agent_state_changed': {
        const state = event.payload.state
        if (!state) break
        const idx = next.findIndex((a) => a.filePath === filePath)
        if (idx === -1 || next[idx].state === state) break
        next = [...next]
        next[idx] = { ...next[idx], state }
        break
      }
      case 'agent_loops_changed': {
        const activeLoops = event.payload.activeLoops ?? 0
        const idx = next.findIndex((a) => a.filePath === filePath)
        if (idx === -1 || next[idx].activeLoops === activeLoops) break
        next = [...next]
        next[idx] = { ...next[idx], activeLoops }
        break
      }
    }
  }
  return next
}
