import { describe, it, expect } from 'vitest'
import {
  buildMenuBarModel,
  formatTokens,
  MENU_BAR_SECTION_MAX,
  type MenuBarAgent,
  type MenuBarSnapshot
} from '../../src/main/tray/menu-bar-model'
import type { PendingNotification } from '../../src/shared/types/ipc.types'

function pending(i: number, over: Partial<PendingNotification> = {}): PendingNotification {
  return {
    id: `/a/agent${i}.adf|main|hil_${i}`,
    kind: 'approval',
    requestId: `hil_${i}`,
    filePath: `/a/agent${i}.adf`,
    agentName: `agent${i}`,
    loop: 'main',
    toolName: 'fs_write',
    preview: `notes/${i}.md`,
    requestedAt: i,
    ...over
  }
}

function agent(name: string, over: Partial<MenuBarAgent> = {}): MenuBarAgent {
  return { filePath: `/a/${name}.adf`, name, state: 'idle', ...over }
}

function snap(over: Partial<MenuBarSnapshot> = {}): MenuBarSnapshot {
  return { surface: 'ADF Studio', pending: [], agents: [], tokensToday: { input: 0, output: 0 }, ...over }
}

const labels = (s: MenuBarSnapshot): string[] =>
  buildMenuBarModel(s).items.map((i) => (i.kind === 'separator' ? '---' : i.label))

describe('buildMenuBarModel', () => {
  it('names the runtime in the header, open and quit rows', () => {
    const l = labels(snap({ surface: 'ADF Daemon' }))
    expect(l[0]).toBe('ADF Daemon — No agents running')
    expect(l).toContain('Open ADF Daemon')
    expect(l).toContain('Quit ADF Daemon')
  })

  it('shows no title and no waiting section when nothing is pending', () => {
    const model = buildMenuBarModel(snap())
    expect(model.title).toBe('')
    expect(labels(snap())).not.toContain('Waiting on you')
  })

  it('counts pending requests in the title and lists each as a reveal action', () => {
    const p = [pending(1), pending(2, { kind: 'ask', toolName: undefined, preview: 'Which repo?' })]
    const model = buildMenuBarModel(snap({ pending: p }))
    expect(model.title).toBe('2')
    expect(model.tooltip).toBe('ADF Studio — No agents running · 2 waiting on you')
    const rows = model.items.filter((i) => i.kind === 'action' && i.action.type === 'reveal')
    expect(rows.map((r) => r.kind === 'action' && r.label)).toEqual([
      'agent1 — fs_write: notes/1.md',
      'agent2 — asks: Which repo?'
    ])
  })

  it('names a non-main loop beside the agent', () => {
    expect(labels(snap({ pending: [pending(1, { loop: 'research' })] }))).toContain(
      'agent1 (research) — fs_write: notes/1.md'
    )
  })

  it('collapses overflow into an "N more…" row that reveals the next one', () => {
    const p = Array.from({ length: MENU_BAR_SECTION_MAX + 3 }, (_, i) => pending(i))
    const more = buildMenuBarModel(snap({ pending: p })).items.find(
      (i) => i.kind === 'action' && i.label === '3 more…'
    )
    expect(more).toMatchObject({ action: { type: 'reveal', notification: { id: p[MENU_BAR_SECTION_MAX].id } } })
  })

  it('lists running agents, foreground first, and leaves out agents that are off', () => {
    const l = labels(snap({
      agents: [
        agent('zeta', { state: 'active', activeLoops: 2 }),
        agent('beta', { state: 'off' }),
        agent('alpha', { state: 'error' }),
        agent('open-one', { state: 'idle', foreground: true })
      ]
    }))
    expect(l[0]).toBe('ADF Studio — 3 agents running')
    const start = l.indexOf('Running')
    expect(l.slice(start + 1, start + 4)).toEqual([
      '○  open-one — idle, open',
      '✕  alpha — error',
      '●  zeta — working, 2 loops'
    ])
    expect(l.join('\n')).not.toContain('beta')
  })

  it('opens the agent file when its row is clicked', () => {
    const row = buildMenuBarModel(snap({ agents: [agent('alpha')] })).items.find(
      (i) => i.kind === 'action' && i.label.includes('alpha')
    )
    expect(row).toMatchObject({ action: { type: 'open-agent', filePath: '/a/alpha.adf' } })
  })

  it("shows today's token totals", () => {
    expect(labels(snap({ tokensToday: { input: 41_234, output: 950 } }))).toContain(
      'Today: 41k tokens in · 950 out'
    )
  })
})

describe('formatTokens', () => {
  it('compacts large counts', () => {
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1_234)).toBe('1.2k')
    expect(formatTokens(41_234)).toBe('41k')
    expect(formatTokens(3_400_000)).toBe('3.4M')
  })
})
