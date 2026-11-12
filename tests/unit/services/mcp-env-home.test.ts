// The Google Calendar catalog server is told where its client file is, as an
// absolute path in its own home, without the user typing it
// (mcp-server-home.ts mcpClientFileEnv, google-oauth-client.ts). Every other
// env value reaches a server verbatim.
import { describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { McpServerConfig } from '../../../src/shared/types/adf-v02.types'

const userData = mkdtempSync(join(tmpdir(), 'adf-envhome-'))
vi.mock('../../../src/main/utils/user-data-path', () => ({ getUserDataPath: () => userData }))

const { runMcpAuthPreflight } = await import('../../../src/main/services/mcp-auth-preflight')
const { mcpClientFileEnv, mcpContainerHomeEnv, mcpHostHomeEnv, mcpOwnHostHome } = await import('../../../src/main/services/mcp-server-home')

const posixOnly = process.platform === 'win32' ? describe.skip : describe
const CALENDAR = '@cocal/google-calendar-mcp'
const CALENDAR_KEYS = '~/.config/google-calendar-mcp/gcp-oauth.keys.json'
const KEYS_UNDER = (home: string) => join(home, '.config', 'google-calendar-mcp', 'gcp-oauth.keys.json')
const calendarCfg = (env?: Record<string, string>): McpServerConfig => ({
  name: 'google-calendar', transport: 'stdio', npm_package: CALENDAR, ...(env ? { env } : {}),
  credential_files: [{ path: CALENDAR_KEYS, required: true }, { path: '~/.config/google-calendar-mcp/tokens.json' }],
})
const host = (home: string) => ({ kind: 'host' as const, home })
const container = (home: string) => ({ kind: 'container' as const, home })

describe('mcpClientFileEnv', () => {
  const gmail = { name: 'gmail', npm_package: '@gongrzhe/server-gmail-autoauth-mcp', credential_files: [{ path: '~/.gmail-mcp/gcp-oauth.keys.json' }] }

  it('Calendar gets the absolute path of its declared client file, on the host and in a container', () => {
    const home = mcpOwnHostHome('google-calendar', { kind: 'app' })
    expect(mcpClientFileEnv(calendarCfg(), host(home))).toEqual({ GOOGLE_OAUTH_CREDENTIALS: KEYS_UNDER(home) })
    expect(mcpHostHomeEnv(calendarCfg(), { kind: 'app' }).GOOGLE_OAUTH_CREDENTIALS).toBe(KEYS_UNDER(home))
    expect(mcpContainerHomeEnv(calendarCfg(), '/w/home').GOOGLE_OAUTH_CREDENTIALS)
      .toBe('/w/home/.mcp-home/google-calendar/.config/google-calendar-mcp/gcp-oauth.keys.json')
  })

  it('the server\'s own config env wins; a ~/ value there resolves against the same home; inherited env does not count', () => {
    expect(mcpClientFileEnv(calendarCfg({ GOOGLE_OAUTH_CREDENTIALS: '/own.json' }), container('/h'))).toEqual({})
    expect(mcpContainerHomeEnv(calendarCfg({ GOOGLE_OAUTH_CREDENTIALS: '/own.json' }), '/w/home')).not.toHaveProperty('GOOGLE_OAUTH_CREDENTIALS')
    expect(mcpClientFileEnv(calendarCfg({ GOOGLE_OAUTH_CREDENTIALS: '~/my/keys.json' }), container('/h'))).toEqual({ GOOGLE_OAUTH_CREDENTIALS: '/h/my/keys.json' })
    // An empty value is unset to the server, so the default still applies.
    expect(mcpClientFileEnv(calendarCfg({ GOOGLE_OAUTH_CREDENTIALS: '' }), container('/h'))).toEqual({ GOOGLE_OAUTH_CREDENTIALS: '/h/.config/google-calendar-mcp/gcp-oauth.keys.json' })
    // A configured path that escapes home on the host is left as configured.
    expect(mcpClientFileEnv(calendarCfg({ GOOGLE_OAUTH_CREDENTIALS: '~/../x.json' }), host('/h'))).toEqual({})
    const inherited = { GOOGLE_OAUTH_CREDENTIALS: '/inherited.json' }
    expect(mcpContainerHomeEnv(calendarCfg(), '/w/home', inherited).GOOGLE_OAUTH_CREDENTIALS).not.toBe('/inherited.json')
  })

  it('only a server with its own home that declares the client file; Gmail and other servers get nothing', () => {
    expect(mcpClientFileEnv({ npm_package: CALENDAR }, container('/h'))).toEqual({})
    expect(mcpClientFileEnv({ ...calendarCfg(), credential_files: [{ path: '~/gcal/client.json' }] }, container('/h'))).toEqual({})
    expect(mcpClientFileEnv(gmail, container('/h'))).toEqual({})
    expect(Object.keys(mcpHostHomeEnv(gmail, { kind: 'app' })).filter((k) => /OAUTH/.test(k))).toEqual([])
    const other = { name: 'drive', npm_package: '@piotr-agier/google-drive-mcp', credential_files: [{ path: '~/.config/google-drive-mcp/gcp-oauth.keys.json' }] }
    expect(mcpClientFileEnv(other, container('/h'))).toEqual({})
  })
})

posixOnly('container auth preflight', () => {
  const runCapturingEnvFile = async (cfg: McpServerConfig, home: string, resolvedEnv?: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-envhome-container-'))
    const copy = join(dir, 'env.txt')
    const fakePodman = join(dir, 'podman')
    writeFileSync(fakePodman, `#!/bin/sh\nprev=""\nfor a in "$@"; do if [ "$prev" = "--env-file" ]; then cp "$a" "${copy}"; fi; prev="$a"; done\nexit 0\n`)
    chmodSync(fakePodman, 0o755)
    await runMcpAuthPreflight(cfg, {
      authArgs: ['auth'],
      resolvedEnv,
      container: { podmanBin: fakePodman, containerName: 'adf-mcp', command: 'npx', args: ['-y', CALENDAR], home },
    }, { openUrl: () => {}, log: () => {}, startupGraceMs: 15_000 })
    return readFileSync(copy, 'utf-8').split('\n').filter(Boolean).sort()
  }
  const home = '/workspace/a1/home/.mcp-home/google-calendar'

  it('Calendar\'s client file is set as at spawn; other values are verbatim', async () => {
    expect(await runCapturingEnvFile(calendarCfg({ TILDE: '~/x', GOOGLE_OAUTH_CREDENTIALS: '' }), home)).toEqual([
      `GOOGLE_OAUTH_CREDENTIALS=${home}/.config/google-calendar-mcp/gcp-oauth.keys.json`,
      `HOME=${home}`,
      'TILDE=~/x',
    ])
  }, 30_000)

  it('an identity-resolved value wins over the default', async () => {
    expect(await runCapturingEnvFile(calendarCfg(), home, { GOOGLE_OAUTH_CREDENTIALS: '/stored.json' })).toEqual([
      'GOOGLE_OAUTH_CREDENTIALS=/stored.json',
      `HOME=${home}`,
    ])
  }, 30_000)

  it('no client-file default for a config without credential files (same gate as spawn)', async () => {
    const noFiles = { ...calendarCfg(), credential_files: undefined }
    expect(mcpContainerHomeEnv(noFiles, '/w/home')).toEqual({})
    expect(await runCapturingEnvFile(noFiles, '/w/home')).toEqual(['HOME=/w/home'])
  }, 30_000)
})
