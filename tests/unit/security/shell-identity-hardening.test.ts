import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { statusHandlers } from '../../../src/main/tools/shell/commands/status'
import { EnvironmentResolver } from '../../../src/main/tools/shell/executor/environment'
import type { AgentConfig } from '@shared/types/adf-v02.types'

/**
 * Finding #2, shell surface: `export` must not overwrite crypto:* key material,
 * and shell variable expansion (${...}) must use the code-safe identity reader
 * so it cannot leak signing keys or code-hidden rows.
 */
const exportHandler = statusHandlers.find(h => h.name === 'export')!

function makeEnvCtx(workspace: AdfWorkspace, args: string[]) {
  const exported: Record<string, string> = {}
  const ctx: any = {
    args,
    flags: {},
    workspace,
    env: { export: (k: string, v: string) => { exported[k] = v } },
    config: {},
  }
  return { ctx, exported }
}

describe('shell identity hardening', () => {
  let ws: AdfWorkspace
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'adf-shellsec-'))
    ws = AdfWorkspace.create(join(dir, 'agent-1.adf'), { name: 'agent-1' })
    ws.setIdentity('crypto:signing:private_key', 'REAL-KEY')
  })

  afterAll(() => {
    try { ws.close() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
  })

  it('export rejects crypto:* purposes and leaves the key intact', async () => {
    const { ctx, exported } = makeEnvCtx(ws, ['crypto:signing:private_key=HACKED'])
    const r = await exportHandler.execute(ctx)
    expect(r.exit_code).not.toBe(0)
    expect(ws.getIdentity('crypto:signing:private_key')).toBe('REAL-KEY')
    // The session env must not have been mutated either.
    expect(exported['crypto:signing:private_key']).toBeUndefined()
  })

  it('export stores an ordinary credential', async () => {
    const { ctx } = makeEnvCtx(ws, ['OPENAI_API_KEY=sk-test'])
    const r = await exportHandler.execute(ctx)
    expect(r.exit_code).toBe(0)
    expect(ws.getIdentityForCode('openai_api_key', null)).toBe('sk-test')
  })

  it('shell ${crypto:...} expansion does not leak key material', () => {
    const resolver = new EnvironmentResolver({ name: 'agent-1' } as AgentConfig, ws)
    expect(resolver.resolve('crypto:signing:private_key')).toBe('')
  })

  it('shell expansion still resolves ordinary code-readable credentials', () => {
    ws.setIdentityFromCode('greeting', 'hi')
    const resolver = new EnvironmentResolver({ name: 'agent-1' } as AgentConfig, ws)
    expect(resolver.resolve('greeting')).toBe('hi')
  })
})
