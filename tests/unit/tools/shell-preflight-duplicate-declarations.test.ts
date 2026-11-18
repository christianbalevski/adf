import { describe, it, expect } from 'vitest'
import { evaluateToolNames, enforceToolGate } from '../../../src/main/tools/shell/executor/preflight'
import { EXIT } from '../../../src/main/tools/shell/commands/types'

/**
 * The shell gate must read a tool declared twice the way the turn does
 * (dedupeToolDeclarations: first wins, restricted/locked sticky).
 */
describe('shell preflight with duplicate tool declarations', () => {
  const dupConfig: any = {
    tools: [
      { name: 'fs_read', enabled: true },
      { name: 'fs_read', enabled: true, restricted: true },
    ],
    triggers: {},
  }

  it('treats a tool as restricted when a later duplicate marks it restricted', async () => {
    const evalr = evaluateToolNames(['fs_read'], dupConfig)
    expect(evalr.approvalRequired).toEqual(['fs_read'])
    const blocked = await enforceToolGate(evalr, { authorized: false } as any, dupConfig, 'cat foo')
    expect(blocked?.exit_code).toBe(EXIT.INTERCEPTED)
  })

  it('still lets a single unrestricted declaration through', async () => {
    const config: any = { tools: [{ name: 'fs_read', enabled: true }], triggers: {} }
    const evalr = evaluateToolNames(['fs_read'], config)
    expect(evalr.approvalRequired).toEqual([])
    expect(evalr.disabled).toEqual([])
    expect(await enforceToolGate(evalr, { authorized: false } as any, config, 'cat foo')).toBeNull()
  })
})
