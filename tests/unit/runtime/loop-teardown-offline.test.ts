import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync } from 'fs'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { teardownRemovedLoopsOffline } from '../../../src/main/adf/loop-teardown'
import type { AgentConfig, LoopConfig } from '../../../src/shared/types/adf-v02.types'

let rootDir: string
let ws: AdfWorkspace

const loop = (name: string): LoopConfig => ({ name, goal: '', enabled: true })
const every = { mode: 'interval' as const, every_ms: 60_000 }

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'adf-loop-teardown-'))
  ws = AdfWorkspace.create(join(rootDir, 'agent.adf'), { name: 'loop-teardown' })
  ws.setAgentConfig({ ...ws.getAgentConfig(), loops: [loop('loop-1'), loop('loop-2')] })
})

afterEach(() => {
  ws.close()
  rmSync(rootDir, { recursive: true, force: true })
})

describe('teardownRemovedLoopsOffline', () => {
  it('archives a removed loop\'s stream so a loop re-added under that name starts empty', async () => {
    ws.forLoop('loop-2').appendToLoop('user', [{ type: 'text', text: 'old work' }])
    const previous = ws.getAgentConfig()
    const next: AgentConfig = { ...previous, loops: [loop('loop-1')] }
    ws.setAgentConfig(next)

    expect(await teardownRemovedLoopsOffline(ws, previous, next)).toEqual(['loop-2'])
    expect(ws.forLoop('loop-2').getLoop()).toHaveLength(0)
    expect(ws.listAudits().filter(a => a.source === 'loop:loop-2')).toHaveLength(1)
  })

  it('leaves kept loops alone', async () => {
    ws.forLoop('loop-1').appendToLoop('user', [{ type: 'text', text: 'keep me' }])
    const previous = ws.getAgentConfig()
    const next: AgentConfig = { ...previous, loops: [loop('loop-1')] }

    await teardownRemovedLoopsOffline(ws, previous, next)
    expect(ws.forLoop('loop-1').getLoop()).toHaveLength(1)
    expect(ws.listAudits().filter(a => a.source === 'loop:loop-1')).toHaveLength(0)
  })

  it('drops the removed loop\'s timers but keeps locked ones', async () => {
    const mainTimer = ws.addTimer(every, Date.now() + 60_000, undefined, ['agent'])
    const loopTimer = ws.forLoop('loop-2').addTimer(every, Date.now() + 60_000, undefined, ['agent'])
    const lockedTimer = ws.forLoop('loop-2').addTimer(every, Date.now() + 60_000, undefined, ['agent'], undefined, undefined, true)
    const previous = ws.getAgentConfig()

    await teardownRemovedLoopsOffline(ws, previous, { ...previous, loops: [loop('loop-1')] })
    const remaining = ws.getTimers().map(t => t.id)
    expect(remaining).toContain(mainTimer)
    expect(remaining).toContain(lockedTimer)
    expect(remaining).not.toContain(loopTimer)
  })

  it('treats a rename as a removal of the old name', async () => {
    ws.forLoop('loop-2').appendToLoop('user', [{ type: 'text', text: 'old name' }])
    const previous = ws.getAgentConfig()

    expect(await teardownRemovedLoopsOffline(ws, previous, { ...previous, loops: [loop('loop-1'), loop('renamed')] })).toEqual(['loop-2'])
    expect(ws.forLoop('loop-2').getLoop()).toHaveLength(0)
  })
})
