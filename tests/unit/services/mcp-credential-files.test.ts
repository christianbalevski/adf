import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  CREDENTIAL_FILE_MAX_BYTES,
  captureCredentialFile,
  credentialFilePurposes,
  expandCredentialPath,
  materializeCredentialFiles,
  writeBackCredentialFiles,
  type CredentialContainerTarget,
  type CredentialStore,
} from '../../../src/main/services/mcp-credential-files'
import type { McpServerConfig } from '../../../src/shared/types/adf-v02.types'

const NOW = '2026-08-24T12:00:00.000Z'

function server(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    name: 'gdrive',
    transport: 'stdio',
    npm_package: '@example/gdrive-mcp',
    credential_files: [{ path: '~/.config/gdrive/keys.json', required: true }],
    ...overrides,
  }
}

function record(content: string): string {
  return JSON.stringify({ encoding: 'base64', data: Buffer.from(content).toString('base64'), mode: 0o600, captured_at: NOW })
}

function memStore(rows: Record<string, string | null> = {}): CredentialStore {
  return {
    getDecrypted: (p) => rows[p] ?? null,
    hasRow: (p) => p in rows,
  }
}

/** Container target backed by the local filesystem (no podman). */
function fsContainerTarget(root: string): CredentialContainerTarget & { copies: string[] } {
  const copies: string[] = []
  return {
    kind: 'container',
    containerName: 'adf-mcp',
    home: `${root}/home`,
    copies,
    copyToContainer: async (hostPath, containerPath) => {
      copies.push(containerPath)
      mkdirSync(join(containerPath, '..'), { recursive: true })
      writeFileSync(containerPath, readFileSync(hostPath))
    },
    copyFromContainer: async (containerPath, hostPath) => {
      if (!existsSync(containerPath)) throw new Error('no such file')
      writeFileSync(hostPath, readFileSync(containerPath))
    },
    fileExists: async (_name, containerPath) => existsSync(containerPath),
  }
}

describe('credentialFilePurposes', () => {
  it('reads package namespace first, then server name', () => {
    expect(credentialFilePurposes(server(), '~/.config/gdrive/keys.json')).toEqual([
      'mcp:@example/gdrive-mcp:file:~/.config/gdrive/keys.json',
      'mcp:gdrive:file:~/.config/gdrive/keys.json',
    ])
  })

  it('collapses to a single purpose when the name is the namespace', () => {
    expect(credentialFilePurposes(server({ npm_package: undefined }), 'x')).toEqual(['mcp:gdrive:file:x'])
  })
})

describe('expandCredentialPath', () => {
  it('expands ~ against the container home', () => {
    const target = fsContainerTarget('/ctr')
    expect(expandCredentialPath('~/.config/a.json', target)).toBe('/ctr/home/.config/a.json')
  })

  it('expands ~ against an explicit host home', () => {
    expect(expandCredentialPath('~/x.json', { kind: 'host', home: '/custom' })).toBe('/custom/x.json')
    expect(expandCredentialPath('~/.config/ok.json', { kind: 'host', home: '/custom' })).toBe('/custom/.config/ok.json')
  })

  it('confines host paths to ~: rejects absolute paths', () => {
    expect(() => expandCredentialPath('/etc/keys.json', { kind: 'host', home: '/custom' }))
      .toThrow(/Host credential files must live under ~ — declare a ~-relative path/)
  })

  it('confines host paths to ~: rejects .. escapes', () => {
    expect(() => expandCredentialPath('~/../../etc/x', { kind: 'host', home: '/custom/home' }))
      .toThrow(/escapes the home directory/)
  })

  it('keeps absolute paths for container targets (contained by the container)', () => {
    const target = fsContainerTarget('/ctr')
    expect(expandCredentialPath('/root/.config/keys.json', target)).toBe('/root/.config/keys.json')
  })
})

describe('captureCredentialFile', () => {
  it('seals a base64 JSON record under the package-namespace purpose', () => {
    const writes: Array<[string, string]> = []
    captureCredentialFile({ setIdentitySealed: (p, v) => writes.push([p, v]) }, server(), '~/.config/gdrive/keys.json', Buffer.from('{"k":1}'), NOW)
    expect(writes).toHaveLength(1)
    expect(writes[0][0]).toBe('mcp:@example/gdrive-mcp:file:~/.config/gdrive/keys.json')
    const rec = JSON.parse(writes[0][1])
    expect(rec).toMatchObject({ encoding: 'base64', mode: 0o600, captured_at: NOW })
    expect(Buffer.from(rec.data, 'base64').toString()).toBe('{"k":1}')
  })

  it('enforces the size cap with a plain error', () => {
    const big = Buffer.alloc(CREDENTIAL_FILE_MAX_BYTES + 1)
    expect(() => captureCredentialFile({ setIdentitySealed: () => {} }, server(), 'x', big, NOW))
      .toThrow(/keystore cap is 262144 bytes/)
  })

  it('propagates sealed-or-fail errors from the store (locked envelope)', () => {
    const store = { setIdentitySealed: () => { throw new Error('credentials envelope is locked in this runtime') } }
    expect(() => captureCredentialFile(store, server(), 'x', Buffer.from('v'), NOW))
      .toThrow(/envelope is locked/)
  })
})

describe('materializeCredentialFiles', () => {
  it('writes a keystore-held file into the container via copy (content never on argv) and verifies it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adf-credfiles-'))
    const target = fsContainerTarget(root)
    const store = memStore({ 'mcp:@example/gdrive-mcp:file:~/.config/gdrive/keys.json': record('{"client":"id"}') })
    await materializeCredentialFiles(store, server(), target)
    const dest = `${root}/home/.config/gdrive/keys.json`
    expect(target.copies).toEqual([dest])
    expect(readFileSync(dest, 'utf8')).toBe('{"client":"id"}')
  })

  it('fails plainly when the container write did not land', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adf-credfiles-'))
    const target = { ...fsContainerTarget(root), copyToContainer: async () => {}, fileExists: async () => false }
    const store = memStore({ 'mcp:@example/gdrive-mcp:file:~/.config/gdrive/keys.json': record('x') })
    await expect(materializeCredentialFiles(store, server(), target))
      .rejects.toThrow(/podman cp did not produce the file/)
  })

  it('falls back to the server-name namespace on read', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adf-credfiles-'))
    const target = fsContainerTarget(root)
    const store = memStore({ 'mcp:gdrive:file:~/.config/gdrive/keys.json': record('legacy') })
    await materializeCredentialFiles(store, server(), target)
    expect(readFileSync(`${root}/home/.config/gdrive/keys.json`, 'utf8')).toBe('legacy')
  })

  it('writes host files with 0600 and ~ expansion against the host home', async () => {
    const home = mkdtempSync(join(tmpdir(), 'adf-credhome-'))
    const store = memStore({ 'mcp:@example/gdrive-mcp:file:~/.config/gdrive/keys.json': record('host-copy') })
    await materializeCredentialFiles(store, server(), { kind: 'host', home })
    const dest = join(home, '.config/gdrive/keys.json')
    expect(readFileSync(dest, 'utf8')).toBe('host-copy')
    expect(statSync(dest).mode & 0o777).toBe(0o600)
  })

  it('fails plainly for a required file missing from the keystore, naming purpose, path, and routes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adf-credfiles-'))
    await expect(materializeCredentialFiles(memStore(), server(), fsContainerTarget(root)))
      .rejects.toThrow(/Required credential file "~\/.config\/gdrive\/keys.json".*"mcp:@example\/gdrive-mcp:file:~\/.config\/gdrive\/keys.json".*mcp_install credential_files.*fs_transfer/s)
  })

  it('does not name the unbuilt Studio credential panel as an ingestion route', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adf-credfiles-'))
    const err = await materializeCredentialFiles(memStore(), server(), fsContainerTarget(root)).catch((e) => e as Error)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).not.toContain('credential panel')
  })

  it('required file already present in the runtime FS is bootstrap state, not an error', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adf-credfiles-'))
    const target = fsContainerTarget(root)
    // No keystore row, but the file exists in the container (fs_transfer / pre-existing install).
    const dest = `${root}/home/.config/gdrive/keys.json`
    mkdirSync(join(dest, '..'), { recursive: true })
    writeFileSync(dest, '{"pre":"existing"}')
    await materializeCredentialFiles(memStore(), server(), target)
    expect(target.copies).toEqual([])                       // nothing overwritten
    expect(readFileSync(dest, 'utf8')).toBe('{"pre":"existing"}')
  })

  it('required + locked keystore row + file present in runtime FS also proceeds (bootstrap)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adf-credfiles-'))
    const target = fsContainerTarget(root)
    const dest = `${root}/home/.config/gdrive/keys.json`
    mkdirSync(join(dest, '..'), { recursive: true })
    writeFileSync(dest, 'x')
    const store = memStore({ 'mcp:@example/gdrive-mcp:file:~/.config/gdrive/keys.json': null })
    await expect(materializeCredentialFiles(store, server(), target)).resolves.toBeUndefined()
  })

  it('names the locked envelope when the row exists but cannot decrypt (daemon case)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adf-credfiles-'))
    const store = memStore({ 'mcp:@example/gdrive-mcp:file:~/.config/gdrive/keys.json': null })
    await expect(materializeCredentialFiles(store, server(), fsContainerTarget(root)))
      .rejects.toThrow(/credentials envelope is locked in this runtime.*ADF Studio once.*daemon runtime key/s)
  })

  it('skips missing optional files (bootstrap mode)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adf-credfiles-'))
    const cfg = server({ credential_files: [{ path: '~/.config/gdrive/tokens.json' }] })
    const target = fsContainerTarget(root)
    await materializeCredentialFiles(memStore(), cfg, target)
    expect(target.copies).toEqual([])
  })

  it('optional + locked keystore row fails plainly instead of silently materializing nothing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adf-credfiles-'))
    const cfg = server({ credential_files: [{ path: '~/.config/gdrive/tokens.json' }] })
    // Row exists but decrypts to null: locked envelope, NOT bootstrap.
    const store = memStore({ 'mcp:@example/gdrive-mcp:file:~/.config/gdrive/tokens.json': null })
    await expect(materializeCredentialFiles(store, cfg, fsContainerTarget(root)))
      .rejects.toThrow(/credentials envelope is locked in this runtime.*ADF Studio once.*daemon runtime key/s)
  })

  it('optional + locked appends the runtime-specific envelopeLockedHint', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adf-credfiles-'))
    const cfg = server({ credential_files: [{ path: '~/.config/gdrive/tokens.json' }] })
    const store = {
      ...memStore({ 'mcp:@example/gdrive-mcp:file:~/.config/gdrive/tokens.json': null }),
      envelopeLockedHint: 'Daemon: trust runtime-enc-key.pub in Studio.',
    }
    await expect(materializeCredentialFiles(store, cfg, fsContainerTarget(root)))
      .rejects.toThrow(/Daemon: trust runtime-enc-key\.pub in Studio\./)
  })

  it('optional + locked + file present in runtime FS proceeds (bootstrap parity with required)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adf-credfiles-'))
    const cfg = server({ credential_files: [{ path: '~/.config/gdrive/tokens.json' }] })
    const target = fsContainerTarget(root)
    const dest = `${root}/home/.config/gdrive/tokens.json`
    mkdirSync(join(dest, '..'), { recursive: true })
    writeFileSync(dest, '{"tok":"runtime"}')
    const store = memStore({ 'mcp:@example/gdrive-mcp:file:~/.config/gdrive/tokens.json': null })
    await expect(materializeCredentialFiles(store, cfg, target)).resolves.toBeUndefined()
    expect(target.copies).toEqual([])                       // runtime copy kept, nothing overwritten
    expect(readFileSync(dest, 'utf8')).toBe('{"tok":"runtime"}')
  })
})

describe('writeBackCredentialFiles', () => {
  it('captures present files, skips absent ones and write_back:false ones', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adf-credfiles-'))
    const target = fsContainerTarget(root)
    const cfg = server({
      credential_files: [
        { path: '~/.config/gdrive/tokens.json' },              // present → captured
        { path: '~/.config/gdrive/absent.json' },              // absent → skipped
        { path: '~/.config/gdrive/keys.json', write_back: false }, // excluded
      ],
    })
    mkdirSync(`${root}/home/.config/gdrive`, { recursive: true })
    writeFileSync(`${root}/home/.config/gdrive/tokens.json`, '{"refresh":"tok"}')
    writeFileSync(`${root}/home/.config/gdrive/keys.json`, '{"client":"id"}')

    const writes: string[] = []
    const sealer = { setIdentitySealed: vi.fn((p: string) => { writes.push(p) }) }
    await writeBackCredentialFiles(sealer, cfg, target, NOW)
    expect(writes).toEqual(['mcp:@example/gdrive-mcp:file:~/.config/gdrive/tokens.json'])
    const rec = JSON.parse(sealer.setIdentitySealed.mock.calls[0][1])
    expect(Buffer.from(rec.data, 'base64').toString()).toBe('{"refresh":"tok"}')
  })

  it('captures from the host filesystem', async () => {
    const home = mkdtempSync(join(tmpdir(), 'adf-credhome-'))
    mkdirSync(join(home, '.config/gdrive'), { recursive: true })
    writeFileSync(join(home, '.config/gdrive/tokens.json'), 'host-tok')
    const cfg = server({ credential_files: [{ path: '~/.config/gdrive/tokens.json' }] })
    const writes: Array<[string, string]> = []
    await writeBackCredentialFiles({ setIdentitySealed: (p, v) => writes.push([p, v]) }, cfg, { kind: 'host', home }, NOW)
    expect(writes).toHaveLength(1)
    expect(Buffer.from(JSON.parse(writes[0][1]).data, 'base64').toString()).toBe('host-tok')
  })

  it('refuses an oversized server-written file before reading it (host)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'adf-credhome-'))
    mkdirSync(join(home, '.config/gdrive'), { recursive: true })
    writeFileSync(join(home, '.config/gdrive/tokens.json'), Buffer.alloc(CREDENTIAL_FILE_MAX_BYTES + 1))
    const cfg = server({ credential_files: [{ path: '~/.config/gdrive/tokens.json' }] })
    const logs: string[] = []
    const sealer = vi.fn()
    await expect(writeBackCredentialFiles({ setIdentitySealed: sealer }, cfg, { kind: 'host', home }, NOW, (m) => logs.push(m)))
      .rejects.toThrow(/262144 bytes \(256 KiB\); write-back refused/)
    expect(sealer).not.toHaveBeenCalled()
    expect(logs.some((l) => l.includes('write-back refused'))).toBe(true)
  })

  it('refuses an oversized server-written file before reading it (container)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adf-credfiles-'))
    const target = fsContainerTarget(root)
    const cfg = server({ credential_files: [{ path: '~/.config/gdrive/tokens.json' }] })
    mkdirSync(`${root}/home/.config/gdrive`, { recursive: true })
    writeFileSync(`${root}/home/.config/gdrive/tokens.json`, Buffer.alloc(CREDENTIAL_FILE_MAX_BYTES + 1))
    const sealer = vi.fn()
    await expect(writeBackCredentialFiles({ setIdentitySealed: sealer }, cfg, target, NOW))
      .rejects.toThrow(/write-back refused/)
    expect(sealer).not.toHaveBeenCalled()
  })

  it('logs the reason when the container copy fails (transient podman error)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adf-credfiles-'))
    const target = { ...fsContainerTarget(root), copyFromContainer: async () => { throw new Error('podman machine unreachable') } }
    const cfg = server({ credential_files: [{ path: '~/.config/gdrive/tokens.json' }] })
    const logs: string[] = []
    const sealer = vi.fn()
    await writeBackCredentialFiles({ setIdentitySealed: sealer }, cfg, target, NOW, (m) => logs.push(m))
    expect(sealer).not.toHaveBeenCalled()
    expect(logs.some((l) => l.includes('Write-back skipped') && l.includes('podman machine unreachable'))).toBe(true)
  })
})

// Schema parity: the declaration round-trips through config validation.
import { AgentConfigSchema } from '../../../src/main/adf/adf-schema'

describe('credential_files schema parity', () => {
  it('round-trips through AgentConfigSchema and never carries content', () => {
    const parsed = AgentConfigSchema.safeParse({
      adf_version: '0.2',
      id: '00000000-0000-0000-0000-000000000001',
      name: 'A',
      model: { provider: 'anthropic', model_id: 'm' },
      instructions: 'test',
      context: {},
      tools: [],
      triggers: {},
      messaging: { send: true, receive: true },
      security: { allow_unsigned: true },
      limits: {},
      metadata: { author: 'test', created_at: '2026-01-01', updated_at: '2026-01-01', version: '1' },
      mcp: {
        servers: [{
          name: 'gdrive',
          transport: 'stdio',
          npm_package: '@example/gdrive-mcp',
          credential_files: [
            { path: '~/.config/gdrive/keys.json', required: true, write_back: false, content: 'SHOULD-BE-STRIPPED' },
          ],
        }],
      },
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      const files = parsed.data.mcp!.servers[0].credential_files!
      expect(files).toEqual([{ path: '~/.config/gdrive/keys.json', required: true, write_back: false }])
      expect(JSON.stringify(parsed.data)).not.toContain('SHOULD-BE-STRIPPED')
    }
  })
})
