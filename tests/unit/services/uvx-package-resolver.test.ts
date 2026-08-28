import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { UvxPackageResolver } from '../../../src/main/services/uvx-package-resolver'
import type { UvManager } from '../../../src/main/services/uv-manager'

const MANIFEST = 'mcp-servers-python-manifest.json'

function stubUvManager(overrides: Partial<UvManager> = {}): UvManager {
  return {
    ensureUv: async () => '/fake/uv',
    resolveEntryPoint: async () => { throw new Error('not resolvable') },
    listTools: async () => [],
    ...overrides,
  } as unknown as UvManager
}

describe('UvxPackageResolver entry-point validation', () => {
  let dataDir: string
  let previousDataDir: string | undefined

  const writeManifest = (command: string) => {
    writeFileSync(join(dataDir, MANIFEST), JSON.stringify({
      packages: {
        'arxiv-mcp-server': {
          package: 'arxiv-mcp-server',
          version: '0.7.2',
          command,
          installPath: '',
          installedAt: 1,
          runtime: 'uvx',
        },
      },
    }), 'utf-8')
  }

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'adf-uvx-'))
    previousDataDir = process.env.ADF_USER_DATA_DIR
    process.env.ADF_USER_DATA_DIR = dataDir
  })

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.ADF_USER_DATA_DIR
    else process.env.ADF_USER_DATA_DIR = previousDataDir
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('returns the entry when the recorded command is a real executable file', () => {
    const bin = join(dataDir, 'arxiv-mcp-server')
    writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 })
    writeManifest(bin)

    const resolver = new UvxPackageResolver(stubUvManager())
    expect(resolver.getInstalled('arxiv-mcp-server')?.command).toBe(bin)
  })

  it('rejects a recorded command that is a directory (uv tool venv root, spawns EACCES)', () => {
    const venvDir = join(dataDir, 'tools', 'arxiv-mcp-server')
    mkdirSync(venvDir, { recursive: true })
    writeManifest(venvDir)

    const resolver = new UvxPackageResolver(stubUvManager())
    // Falls back to `uv tool run` at the spawn site rather than spawning a directory.
    expect(resolver.getInstalled('arxiv-mcp-server')).toBeUndefined()
  })

  it('rejects a recorded "uv tool run" command line, which is not a spawnable path', () => {
    writeManifest('/fake/uv tool run arxiv-mcp-server')

    const resolver = new UvxPackageResolver(stubUvManager())
    expect(resolver.getInstalled('arxiv-mcp-server')).toBeUndefined()
  })

  it('repairManifest rewrites a broken entry to the resolved executable', async () => {
    const venvDir = join(dataDir, 'tools', 'arxiv-mcp-server')
    mkdirSync(venvDir, { recursive: true })
    writeManifest(venvDir)

    const bin = join(dataDir, 'bin', 'arxiv-mcp-server')
    mkdirSync(join(dataDir, 'bin'), { recursive: true })
    writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 })

    const resolver = new UvxPackageResolver(stubUvManager({ resolveEntryPoint: async () => bin }))
    await resolver.repairManifest()

    expect(resolver.getInstalled('arxiv-mcp-server')?.command).toBe(bin)
    const onDisk = JSON.parse(readFileSync(join(dataDir, MANIFEST), 'utf-8'))
    expect(onDisk.packages['arxiv-mcp-server'].command).toBe(bin)
  })

  it('repairManifest leaves a still-unresolvable entry alone', async () => {
    const venvDir = join(dataDir, 'tools', 'arxiv-mcp-server')
    mkdirSync(venvDir, { recursive: true })
    writeManifest(venvDir)

    const resolver = new UvxPackageResolver(stubUvManager())
    await resolver.repairManifest()

    expect(resolver.getInstalled('arxiv-mcp-server')).toBeUndefined()
    const onDisk = JSON.parse(readFileSync(join(dataDir, MANIFEST), 'utf-8'))
    expect(onDisk.packages['arxiv-mcp-server'].command).toBe(venvDir)
  })
})
