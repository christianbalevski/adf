import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BACKEND_CONFIG_FILE,
  applyBackendPatch,
  backendConfigPath,
  createBackendSettingsStore,
  defaultBackendConfig,
  normalizeBackendConfig,
  readRemoteToken,
  resolveBootBackend,
  type SecretCodec,
  type StudioBackendConfig,
} from '../../src/main/backend/backend-config'
import { checkRemoteDaemonUrl } from '../../src/shared/utils/remote-backend-url'
import type { StudioBackendMode } from '../../src/shared/types/backend.types'

const TOKEN = 'tok_3f9b2c7e1a5d4f60b8e2c9a7d1f3e5b7'

/** Stand-in for safeStorage: reversible, and never contains the plain token. */
function fakeCodec(available = true): SecretCodec {
  return {
    available: () => available,
    encrypt: (plain) => {
      if (!available) throw new Error('unavailable')
      return 'safe:' + Buffer.from([...plain].reverse().join('')).toString('base64')
    },
    decrypt: (stored) => [...Buffer.from(stored.slice(5), 'base64').toString()].reverse().join(''),
  }
}

function recordingLog() {
  const lines: string[] = []
  return {
    lines,
    log: {
      log: (...args: unknown[]) => { lines.push(args.map(String).join(' ')) },
      warn: (...args: unknown[]) => { lines.push(args.map(String).join(' ')) },
    },
  }
}

function tempConfigPath(): string {
  return backendConfigPath(mkdtempSync(join(tmpdir(), 'adf-backend-config-')))
}

describe('resolveBootBackend', () => {
  it('boots embedded, logs nothing and writes nothing when there is no file', () => {
    const path = tempConfigPath()
    const { lines, log } = recordingLog()
    const boot = resolveBootBackend(path, {}, log)
    expect(boot).toEqual({ mode: 'embedded', source: 'default', configPath: path, config: defaultBackendConfig(), writeBlocked: null })
    expect(lines).toEqual([])
    expect(existsSync(path)).toBe(false)
  })

  it('names the file studio-backend.json in the given directory', () => {
    expect(backendConfigPath(join('x', 'userData'))).toBe(join('x', 'userData', BACKEND_CONFIG_FILE))
    expect(BACKEND_CONFIG_FILE).toBe('studio-backend.json')
  })

  it('reads the mode from the file', () => {
    const path = tempConfigPath()
    writeFileSync(path, JSON.stringify({ v: 1, mode: 'local' }))
    const { log } = recordingLog()
    expect(resolveBootBackend(path, {}, log)).toMatchObject({ mode: 'local', source: 'file' })
  })

  it('ADF_STUDIO_BACKEND=embedded overrides the file for recovery', () => {
    const path = tempConfigPath()
    writeFileSync(path, JSON.stringify({ v: 1, mode: 'remote', remote: { url: 'https://adf.example.com' } }))
    const { lines, log } = recordingLog()
    const boot = resolveBootBackend(path, { ADF_STUDIO_BACKEND: 'embedded' }, log)
    expect(boot).toMatchObject({ mode: 'embedded', source: 'env' })
    expect(boot.config.mode).toBe('remote')
    expect(lines.join('\n')).toContain('ADF_STUDIO_BACKEND')
  })

  it('ignores an unknown override value with a warning', () => {
    const path = tempConfigPath()
    const { lines, log } = recordingLog()
    expect(resolveBootBackend(path, { ADF_STUDIO_BACKEND: 'daemon' }, log)).toMatchObject({ mode: 'embedded', source: 'default' })
    expect(lines.some((l) => l.includes('Ignoring ADF_STUDIO_BACKEND'))).toBe(true)
  })

  it('falls back to embedded and keeps a copy of a corrupt file', () => {
    const path = tempConfigPath()
    writeFileSync(path, '{ not json')
    const { lines, log } = recordingLog()
    expect(resolveBootBackend(path, {}, log)).toMatchObject({ mode: 'embedded', source: 'file' })
    expect(readdirSync(join(path, '..')).some((n) => n.startsWith(`${BACKEND_CONFIG_FILE}.corrupt-`))).toBe(true)
    expect(lines.some((l) => l.includes('could not be parsed'))).toBe(true)
  })

  it('falls back to embedded on an unknown mode', () => {
    const path = tempConfigPath()
    writeFileSync(path, JSON.stringify({ mode: 'hybrid' }))
    const { lines, log } = recordingLog()
    expect(resolveBootBackend(path, {}, log).mode).toBe('embedded')
    expect(lines.some((l) => l.includes('unknown mode'))).toBe(true)
  })
})

describe('normalizeBackendConfig', () => {
  it('drops a token that is not stored as safe:, without logging its value', () => {
    const { config, warnings } = normalizeBackendConfig({ mode: 'remote', remote: { url: 'https://adf.example.com', token: TOKEN } })
    expect(config.remote.token).toBeNull()
    expect(warnings.join('\n')).not.toContain(TOKEN)
  })

  it('defaults keepDaemonRunning to false', () => {
    expect(normalizeBackendConfig({ mode: 'local' }).config.keepDaemonRunning).toBe(false)
  })
})

describe('Settings → Backend store', () => {
  function store(opts: {
    allowModeChange?: boolean
    codec?: SecretCodec
    path?: string
    confirmModeSwitch?: (target: StudioBackendMode) => Promise<boolean>
    applyModeSwitch?: (target: StudioBackendMode) => void
  } = {}) {
    const path = opts.path ?? tempConfigPath()
    const rec = recordingLog()
    const boot = resolveBootBackend(path, {}, rec.log)
    const s = createBackendSettingsStore({ boot, codec: opts.codec ?? fakeCodec(), allowModeChange: opts.allowModeChange, log: rec.log, confirmModeSwitch: opts.confirmModeSwitch, applyModeSwitch: opts.applyModeSwitch })
    return { path, s, lines: rec.lines }
  }

  it('persists the mode so the next launch boots with it', async () => {
    const { path, s } = store({ allowModeChange: true })
    const result = await s.set({ mode: 'local' })
    expect(result.ok).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf-8')).mode).toBe('local')
    expect(resolveBootBackend(path, {}, recordingLog().log)).toMatchObject({ mode: 'local', source: 'file' })
  })

  it('refuses a mode switch while switching is unavailable and writes nothing', async () => {
    const { path, s } = store({ allowModeChange: false })
    const result = await s.set({ mode: 'local' })
    expect(result).toMatchObject({ ok: false, code: 'mode_switch_unavailable' })
    expect(existsSync(path)).toBe(false)
  })

  it('switching to local asks first (the switch dialog), then saves and restarts; cancel writes nothing (W4-A)', async () => {
    const asked: string[] = []
    const restarted: string[] = []
    let answer = false
    const { path, s } = store({ confirmModeSwitch: async (target) => { asked.push(target); return answer }, applyModeSwitch: (target) => { restarted.push(target) } })
    expect(s.get().modeSwitchAvailable).toBe(true)
    expect(await s.set({ mode: 'local' })).toMatchObject({ ok: false, code: 'switch_cancelled' })
    expect(existsSync(path)).toBe(false)
    expect(restarted).toEqual([])
    answer = true
    const result = await s.set({ mode: 'local' })
    expect(result.ok && result.view.configured.mode).toBe('local')
    expect(asked).toEqual(['local', 'local'])
    expect(restarted).toEqual(['local'])
    expect(resolveBootBackend(path, {}, recordingLog().log).mode).toBe('local')
  })

  it('refuses a switch to remote until remote mode ships (W4-B)', async () => {
    const { path, s } = store()
    expect(s.get().remoteSwitchAvailable).toBe(false)
    expect(await s.set({ mode: 'remote', remoteUrl: 'https://adf.example.com' })).toMatchObject({ ok: false, code: 'mode_switch_unavailable' })
    expect(existsSync(path)).toBe(false)
  })

  it('always allows going back to embedded', async () => {
    const path = tempConfigPath()
    writeFileSync(path, JSON.stringify({ v: 1, mode: 'local' }))
    const { s } = store({ path })
    const result = await s.set({ mode: 'embedded' })
    expect(result.ok && result.view.configured.mode).toBe('embedded')
    expect(resolveBootBackend(path, {}, recordingLog().log).mode).toBe('embedded')
  })

  it('persists keepDaemonRunning', async () => {
    const { path, s } = store()
    expect(s.get().configured.keepDaemonRunning).toBe(false)
    await s.set({ keepDaemonRunning: true })
    expect(JSON.parse(readFileSync(path, 'utf-8')).keepDaemonRunning).toBe(true)
    expect(resolveBootBackend(path, {}, recordingLog().log).config.keepDaemonRunning).toBe(true)
  })

  it('stores the token as safe: and never returns or logs it', async () => {
    const { path, s, lines } = store()
    const result = await s.set({ remoteUrl: 'https://adf.example.com/', remoteToken: TOKEN })
    expect(result.ok).toBe(true)
    const onDisk = readFileSync(path, 'utf-8')
    expect(onDisk).not.toContain(TOKEN)
    expect(JSON.parse(onDisk).remote.token).toMatch(/^safe:/)
    expect(JSON.stringify(result)).not.toContain(TOKEN)
    expect(JSON.stringify(s.get())).not.toContain(TOKEN)
    expect(JSON.stringify(s.get())).not.toContain(JSON.parse(onDisk).remote.token)
    expect(s.get().configured).toMatchObject({ remoteUrl: 'https://adf.example.com', remoteTokenSaved: true })
    expect(lines.join('\n')).not.toContain(TOKEN)
    expect(lines.join('\n')).toContain('remote token saved')
    expect(readRemoteToken(s.config(), fakeCodec())).toBe(TOKEN)
  })

  it('removes the token when the URL moves to another origin', async () => {
    const { s } = store()
    await s.set({ remoteUrl: 'https://adf.example.com', remoteToken: TOKEN })
    const samePath = await s.set({ remoteUrl: 'https://adf.example.com/adf' })
    expect(samePath.ok && samePath.view.configured.remoteTokenSaved).toBe(true)
    const moved = await s.set({ remoteUrl: 'https://other.example.com' })
    expect(moved.ok).toBe(true)
    if (!moved.ok) return
    expect(moved.view.configured.remoteTokenSaved).toBe(false)
    expect(moved.notices.join(' ')).toContain('token was removed')
  })

  it('refuses a token when encryption is unavailable', async () => {
    const { path, s } = store({ codec: fakeCodec(false) })
    const result = await s.set({ remoteUrl: 'https://adf.example.com', remoteToken: TOKEN })
    expect(result).toMatchObject({ ok: false, code: 'encryption_unavailable' })
    expect(existsSync(path)).toBe(false)
  })

  it('refuses a token without a URL and a token with spaces', async () => {
    const { s } = store()
    expect(await s.set({ remoteToken: TOKEN })).toMatchObject({ ok: false, code: 'token_without_url' })
    expect(await s.set({ remoteUrl: 'https://adf.example.com', remoteToken: 'a b' })).toMatchObject({ ok: false, code: 'invalid_token' })
  })

  it('clears URL and token together', async () => {
    const { s } = store()
    await s.set({ remoteUrl: 'https://adf.example.com', remoteToken: TOKEN })
    const result = await s.set({ remoteUrl: null })
    expect(result.ok && result.view.configured).toMatchObject({ remoteUrl: null, remoteTokenSaved: false })
  })
})

describe('remote URL rules (§9.2)', () => {
  const codec = fakeCodec()
  const apply = (remoteUrl: string, allowInsecureHttp?: boolean) =>
    applyBackendPatch(
      defaultBackendConfig(),
      { remoteUrl, allowInsecureHttp, insecureHttpOrigin: allowInsecureHttp ? new URL(remoteUrl).origin : undefined },
      { codec, allowModeChange: false },
    )

  it('accepts https, loopback and tailnet http', () => {
    expect(checkRemoteDaemonUrl('https://adf.example.com').kind).toBe('https')
    expect(checkRemoteDaemonUrl('http://127.0.0.1:7385').kind).toBe('loopback')
    expect(checkRemoteDaemonUrl('http://localhost:7385').kind).toBe('loopback')
    expect(checkRemoteDaemonUrl('http://[::1]:7385').kind).toBe('loopback')
    expect(checkRemoteDaemonUrl('http://100.101.102.103:7385').kind).toBe('tailnet')
    expect(checkRemoteDaemonUrl('http://[fd7a:115c:a1e0::1]:7385').kind).toBe('tailnet')
    expect(checkRemoteDaemonUrl('http://100.128.0.1').kind).toBe('insecure-http')
    expect(apply('http://100.64.0.1:7385').ok).toBe(true)
  })

  it('requires confirmation for other plain-http URLs', () => {
    expect(apply('http://192.168.1.20:7385')).toMatchObject({ ok: false, code: 'insecure_url_unconfirmed' })
    const confirmed = apply('http://192.168.1.20:7385', true)
    expect(confirmed.ok && confirmed.config.remote).toMatchObject({ url: 'http://192.168.1.20:7385', allowInsecureHttp: true })
  })

  it('rejects credentials, queries and other schemes', () => {
    expect(apply('https://user:pw@adf.example.com')).toMatchObject({ ok: false, code: 'invalid_url' })
    expect(apply('https://adf.example.com/?token=x')).toMatchObject({ ok: false, code: 'invalid_url' })
    expect(apply('ftp://adf.example.com')).toMatchObject({ ok: false, code: 'invalid_url' })
  })
})

describe('review fixes', () => {
  const codec = fakeCodec()
  const opts = { codec, allowModeChange: false }
  const confirmed = (url: string): StudioBackendConfig => ({ ...defaultBackendConfig(), remote: { url, token: null, allowInsecureHttp: true } })

  it('does not carry a plain-http confirmation over to a new origin', () => {
    const current = confirmed('http://192.168.1.5:7385')
    // The renderer used to send the stale `true` with the new URL.
    expect(applyBackendPatch(current, { remoteUrl: 'http://203.0.113.9:7385', allowInsecureHttp: true }, opts))
      .toMatchObject({ ok: false, code: 'insecure_url_unconfirmed' })
    expect(applyBackendPatch(current, { remoteUrl: 'http://203.0.113.9:7385', allowInsecureHttp: true, insecureHttpOrigin: 'http://192.168.1.5:7385' }, opts))
      .toMatchObject({ ok: false, code: 'insecure_url_unconfirmed' })
    const fresh = applyBackendPatch(current, { remoteUrl: 'http://203.0.113.9:7385', allowInsecureHttp: true, insecureHttpOrigin: 'http://203.0.113.9:7385' }, opts)
    expect(fresh.ok && fresh.config.remote).toMatchObject({ url: 'http://203.0.113.9:7385', allowInsecureHttp: true })
    // Same origin, new path: the earlier confirmation still holds.
    const samePath = applyBackendPatch(current, { remoteUrl: 'http://192.168.1.5:7385/adf', allowInsecureHttp: true }, opts)
    expect(samePath.ok && samePath.config.remote.allowInsecureHttp).toBe(true)
  })

  it('never boots or keeps a token for an unconfirmed plain-http URL from the file', () => {
    const path = tempConfigPath()
    writeFileSync(path, JSON.stringify({ v: 1, mode: 'remote', remote: { url: 'http://192.168.1.5:7385', token: 'safe:abc' } }))
    const { lines, log } = recordingLog()
    const boot = resolveBootBackend(path, {}, log)
    expect(boot.mode).toBe('embedded')
    expect(boot.config.remote).toEqual({ url: null, token: null, allowInsecureHttp: false })
    expect(lines.some((l) => l.includes('ignored with its token'))).toBe(true)
    expect(lines.some((l) => l.includes('mode is remote'))).toBe(true)
  })

  it('does not block unrelated saves on a stored unconfirmed URL', () => {
    const current: StudioBackendConfig = { ...defaultBackendConfig(), mode: 'local', remote: { url: 'http://192.168.1.5:7385', token: null, allowInsecureHttp: false } }
    expect(applyBackendPatch(current, { keepDaemonRunning: true }, opts).ok).toBe(true)
    expect(applyBackendPatch(current, { mode: 'embedded' }, opts).ok).toBe(true)
    expect(applyBackendPatch(current, { remoteUrl: 'http://192.168.1.5:7385' }, opts)).toMatchObject({ ok: false, code: 'insecure_url_unconfirmed' })
  })

  it('warns and refuses saves when the file cannot be read', async () => {
    const path = tempConfigPath()
    mkdirSync(path) // a directory where the file should be: readFileSync fails with EISDIR
    const { lines, log } = recordingLog()
    const boot = resolveBootBackend(path, {}, log)
    expect(boot).toMatchObject({ mode: 'embedded', source: 'file' })
    expect(boot.writeBlocked).toContain('could not be read')
    expect(lines.some((l) => l.includes('could not be read'))).toBe(true)
    const s = createBackendSettingsStore({ boot, codec, log })
    expect(await s.set({ keepDaemonRunning: true })).toMatchObject({ ok: false, code: 'file_unreadable' })
  })

  it('accepts the override in any case', () => {
    const path = tempConfigPath()
    writeFileSync(path, JSON.stringify({ mode: 'local' }))
    expect(resolveBootBackend(path, { ADF_STUDIO_BACKEND: ' EMBEDDED ' }, recordingLog().log)).toMatchObject({ mode: 'embedded', source: 'env' })
  })

  it('parses a file with a UTF-8 BOM', () => {
    const path = tempConfigPath()
    writeFileSync(path, '﻿' + JSON.stringify({ mode: 'local' }))
    expect(resolveBootBackend(path, {}, recordingLog().log)).toMatchObject({ mode: 'local', source: 'file' })
  })

  it('rejects wrongly typed patch fields instead of throwing', () => {
    const current = defaultBackendConfig()
    expect(applyBackendPatch(current, { remoteUrl: 5 } as never, opts)).toMatchObject({ ok: false, code: 'invalid_url' })
    expect(applyBackendPatch(current, { remoteToken: 5 } as never, opts)).toMatchObject({ ok: false, code: 'invalid_token' })
    expect(applyBackendPatch(current, { keepDaemonRunning: 'yes' } as never, opts)).toMatchObject({ ok: false, code: 'invalid_patch' })
    expect(applyBackendPatch(current, { mode: 1 } as never, opts)).toMatchObject({ ok: false, code: 'invalid_mode' })
  })

  it('reports why encryption is unavailable', async () => {
    const reason = 'No OS keyring is available'
    const noKeyring: SecretCodec = { ...fakeCodec(false), unavailableReason: () => reason }
    const path = tempConfigPath()
    const boot = resolveBootBackend(path, {}, recordingLog().log)
    const s = createBackendSettingsStore({ boot, codec: noKeyring, log: recordingLog().log })
    expect(s.get().encryptionUnavailableReason).toBe(reason)
    expect(await s.set({ remoteUrl: 'https://adf.example.com', remoteToken: TOKEN })).toMatchObject({ ok: false, code: 'encryption_unavailable', error: reason })
  })

  it('serializes concurrent saves so none is lost', async () => {
    const path = tempConfigPath()
    const boot = resolveBootBackend(path, {}, recordingLog().log)
    const s = createBackendSettingsStore({ boot, codec, log: recordingLog().log })
    const results = await Promise.all([
      s.set({ keepDaemonRunning: true }),
      s.set({ remoteUrl: 'https://adf.example.com' }),
      s.set({ remoteToken: TOKEN }),
    ])
    expect(results.every((r) => r.ok)).toBe(true)
    const onDisk = JSON.parse(readFileSync(path, 'utf-8'))
    expect(onDisk).toMatchObject({ keepDaemonRunning: true, remote: { url: 'https://adf.example.com' } })
    expect(onDisk.remote.token).toMatch(/^safe:/)
  })

  it('keeps the previous state when the write fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-backend-config-'))
    const blocker = join(dir, 'not-a-dir')
    writeFileSync(blocker, '')
    const boot = resolveBootBackend(backendConfigPath(blocker), {}, recordingLog().log)
    const rec = recordingLog()
    const s = createBackendSettingsStore({ boot, codec, log: rec.log })
    const result = await s.set({ remoteUrl: 'https://adf.example.com', remoteToken: TOKEN })
    expect(result).toMatchObject({ ok: false, code: 'write_failed' })
    expect(s.get().configured).toMatchObject({ remoteUrl: null, remoteTokenSaved: false })
    expect(rec.lines.join('\n')).not.toContain(TOKEN)
  })
})
