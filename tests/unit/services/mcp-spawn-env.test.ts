// An MCP server is third-party code: the stdio spawn (probe, registration
// test, agents' servers) must not hand it the runtime's own secrets, i.e.
// the daemon access token or the owner passphrase (W1-D review). A real
// child process records the environment it received.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { probeMcpServer } from '../../../src/main/services/mcp-connect-tests'
import { inheritableEnv } from '../../../src/main/utils/child-env'

const saved: Record<string, string | undefined> = {}
const SET = { ADF_DAEMON_TOKEN: 'tok-SECRET-1', ADF_DAEMON_LOCAL_PROOF: 'proof-SECRET-2', ADF_OWNER_PASSPHRASE: 'pass-SECRET-3', ADF_W1D_VISIBLE: 'visible' }
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
})

describe('MCP child environment', () => {
  it('inheritableEnv drops ADF_DAEMON_* and the owner passphrase, keeps the rest', () => {
    const env = inheritableEnv({ ...SET, PATH: '/bin', ADF_OWNER_PASSPHRASE_FILE: '/x', ADF_USER_DATA_DIR: '/d' })
    expect(env).toEqual({ ADF_W1D_VISIBLE: 'visible', PATH: '/bin', ADF_USER_DATA_DIR: '/d' })
  })

  it('a probed stdio server does not receive the daemon token or the owner passphrase', async () => {
    for (const [k, v] of Object.entries(SET)) { saved[k] = process.env[k]; process.env[k] = v }
    const dir = mkdtempSync(join(tmpdir(), 'adf-mcp-env-'))
    const out = join(dir, 'env.json')
    try {
      const script = `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env))`
      const result = await probeMcpServer({ name: 'env-probe', command: process.execPath, args: ['-e', script], env: { MARKER: 'from-config' } }, {
        uvManager: { ensureUv: async () => 'uv' },
        onLog: () => {},
      })
      expect(result.success).toBe(false) // not an MCP server; it only recorded its env
      expect(existsSync(out)).toBe(true)
      const env = JSON.parse(readFileSync(out, 'utf-8')) as Record<string, string>
      expect(env.MARKER).toBe('from-config')
      expect(env.ADF_W1D_VISIBLE).toBe('visible')
      for (const key of ['ADF_DAEMON_TOKEN', 'ADF_DAEMON_LOCAL_PROOF', 'ADF_OWNER_PASSPHRASE']) expect(env[key]).toBeUndefined()
      expect(readFileSync(out, 'utf-8')).not.toMatch(/SECRET/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
