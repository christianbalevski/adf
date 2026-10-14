/**
 * Characterization of MESH_FOUND_AGENT's checks and file name (Studio's
 * ipc/index.ts handler, before the E1 extraction into utils/found-agent.ts):
 * the refusal sentences, their order, the tracked-root and new-root rules,
 * the slug, and the folder being created before the existence check.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { foundAgentFileName, prepareFoundAgent } from '../../../src/main/utils/found-agent'

let root: string
let tracked: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'adf-found-'))
  tracked = join(root, 'fleet')
  mkdirSync(tracked)
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('MESH_FOUND_AGENT checks (E1)', () => {
  it('slugs the typed name, agent when nothing is left', () => {
    expect(foundAgentFileName('Agent One!')).toBe('agent-one')
    expect(foundAgentFileName('--x_y--')).toBe('x_y')
    expect(foundAgentFileName('ÄÖÜ')).toBe('agent')
  })

  it('refuses an empty name first, then a destination outside tracked folders', () => {
    expect(prepareFoundAgent({ dir: join(root, 'elsewhere'), name: '   ' }, [tracked])).toEqual({ ok: false, error: 'Agent name required' })
    expect(prepareFoundAgent({ dir: join(root, 'elsewhere'), name: 'a' }, [tracked])).toEqual({ ok: false, error: 'Destination is outside tracked directories' })
    expect(existsSync(join(root, 'elsewhere'))).toBe(false)
  })

  it('accepts a folder inside a tracked folder and creates it', () => {
    const dir = join(tracked, 'team')
    expect(prepareFoundAgent({ dir, name: ' agent-1 ' }, [tracked])).toEqual({ ok: true, name: 'agent-1', dir, fileName: 'agent-1', filePath: join(dir, 'agent-1.adf') })
    expect(existsSync(dir)).toBe(true)
  })

  it('accepts a sibling of a tracked root only with newRoot', () => {
    const sibling = join(root, 'new-root')
    expect(prepareFoundAgent({ dir: sibling, name: 'a' }, [tracked])).toEqual({ ok: false, error: 'Destination is outside tracked directories' })
    expect(prepareFoundAgent({ dir: sibling, name: 'a', newRoot: true }, [tracked])).toMatchObject({ ok: true, filePath: join(sibling, 'a.adf') })
  })

  it('refuses a file that already exists, after creating the folder', () => {
    const dir = join(tracked, 'taken')
    mkdirSync(dir)
    writeFileSync(join(dir, 'agent-2.adf'), '')
    expect(prepareFoundAgent({ dir, name: 'Agent 2' }, [tracked])).toEqual({ ok: false, error: 'agent-2.adf already exists here' })
  })
})
