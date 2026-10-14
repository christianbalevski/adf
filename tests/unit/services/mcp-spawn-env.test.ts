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
const SET = {
  ADF_DAEMON_TOKEN: 'tok-SECRET-1',
  ADF_OWNER_PASSPHRASE: 'pass-SECRET-3',
  ADF_OWNER_PASSPHRASE_FILE: '/run/secrets/adf-pass',
  ADF_DAEMON_PORT: '7499',
  ADF_DAEMON_URL: 'http://127.0.0.1:7499',
  ADF_DAEMON_SETTINGS: '/tmp/adf-settings.json',
  ADF_W1D_VISIBLE: 'visible',
}
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
})

describe('MCP child environment', () => {
  it('inheritableEnv drops the daemon token and the owner passphrase only', () => {
    const env = inheritableEnv({ ...SET, PATH: '/bin', ADF_USER_DATA_DIR: '/d' })
    expect(env).toEqual({
      ADF_DAEMON_PORT: '7499',
      ADF_DAEMON_URL: 'http://127.0.0.1:7499',
      ADF_DAEMON_SETTINGS: '/tmp/adf-settings.json',
      ADF_W1D_VISIBLE: 'visible',
      PATH: '/bin',
      ADF_USER_DATA_DIR: '/d',
    })
  })

  it('a probed stdio server gets the daemon location but not the token or the owner passphrase', async () => {
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
      // A server that shells out to `adf` still finds a daemon on a non-default port.
      expect(env.ADF_DAEMON_PORT).toBe('7499')
      expect(env.ADF_DAEMON_URL).toBe('http://127.0.0.1:7499')
      expect(env.ADF_DAEMON_SETTINGS).toBe('/tmp/adf-settings.json')
      for (const key of ['ADF_DAEMON_TOKEN', 'ADF_OWNER_PASSPHRASE', 'ADF_OWNER_PASSPHRASE_FILE']) expect(env[key]).toBeUndefined()
      expect(readFileSync(out, 'utf-8')).not.toMatch(/SECRET/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
