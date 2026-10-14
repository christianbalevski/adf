// Characterization of Studio's MESH_STATUS body (getMeshStatus in
// ipc/index.ts, also the debug slice of MESH_MAP_POLL) and of
// readRecentToolsFromWorkspace (MESH_GET_RECENT_TOOLS), written against the
// handler code before both moved into src/main/services (rule E1). The daemon's
// /fleet routes call the same functions.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { buildMeshStatus } from '../../../src/main/services/mesh-status'
import { readRecentToolsFromWorkspace } from '../../../src/main/services/recent-tools'

const agents = [{ filePath: '/a/agent-1.adf', handle: 'agent-1', state: 'active' }]
const debug = {
  running: true,
  busRegistrations: [{ name: 'agent-1', channels: ['main'] }],
  backgroundAgents: [],
  foregroundAgents: [],
  messageLog: [{ seq: 1, from: 'agent-1' }, { seq: 2, from: 'agent-2' }, { seq: 3, from: 'agent-1' }],
}

describe('buildMeshStatus', () => {
  it('mesh off: the short shape, and the empty debug shape', async () => {
    const src = { isRunning: () => false, liveAgents: () => agents, debugInfo: () => debug }
    expect(await buildMeshStatus(src)).toEqual({ running: false, agents: [] })
    expect(await buildMeshStatus(src, { debug: true })).toEqual({
      running: false, agents: [], busRegistrations: [], backgroundAgents: [], foregroundAgents: [], messageLog: [],
    })
  })

  it('mesh on: live agents, plus the debug info and the log cursor', async () => {
    const src = { isRunning: () => true, liveAgents: () => agents, debugInfo: () => debug }
    expect(await buildMeshStatus(src)).toEqual({ running: true, agents })
    expect(await buildMeshStatus(src, { debug: true })).toEqual({ ...debug, running: true, agents, logSeq: 3 })
    expect(await buildMeshStatus(src, { debug: true, sinceSeq: 1 })).toEqual({
      ...debug, running: true, agents, logSeq: 3, messageLog: debug.messageLog.slice(1), logIncremental: true,
    })
  })

  it('a debug read that throws keeps running/agents and reports the error', async () => {
    const src = { isRunning: () => true, liveAgents: () => agents, debugInfo: () => { throw new Error('bus gone') } }
    expect(await buildMeshStatus(src, { debug: true })).toEqual({
      running: true, agents, busRegistrations: [], backgroundAgents: [], foregroundAgents: [], messageLog: [], error: 'Error: bus gone',
    })
  })
})

describe('readRecentToolsFromWorkspace', () => {
  const dirs: string[] = []
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

  it('pairs tool_use with tool_result, keeps pending calls, and returns the last `limit`', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-recent-tools-'))
    dirs.push(dir)
    const ws = AdfWorkspace.create(join(dir, 'agent-1.adf'), { name: 'agent-1' })
    try {
      ws.appendToLoop('assistant', [
        { type: 'tool_use', id: 't1', name: 'fs_read', input: { path: 'a.txt' } },
        { type: 'tool_use', id: 't2', name: 'sys_code', input: { _reason: 'count lines' } },
      ])
      ws.appendToLoop('user', [
        { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
        { type: 'tool_result', tool_use_id: 't2', content: 'boom', is_error: true },
      ])
      ws.appendToLoop('assistant', [{ type: 'tool_use', id: 't3', name: 'fs_write', input: { path: 'b.txt', content: 'x'.repeat(100) } }])

      const tools = readRecentToolsFromWorkspace(ws, 5)
      expect(tools.map((t) => ({ name: t.name, args: t.args, isError: t.isError }))).toEqual([
        { name: 'fs_read', args: '{"path":"a.txt"}', isError: false },
        { name: 'sys_code', args: 'count lines', isError: true },
        { name: 'fs_write', args: `${JSON.stringify({ path: 'b.txt', content: 'x'.repeat(100) }).slice(0, 40)}...`, isError: undefined },
      ])
      expect(readRecentToolsFromWorkspace(ws, 1).map((t) => t.name)).toEqual(['fs_write'])
      expect(typeof tools[0].timestamp).toBe('number')
    } finally {
      ws.close()
    }
  })
})
