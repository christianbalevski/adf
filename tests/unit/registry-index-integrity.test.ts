import { describe, it, expect } from 'vitest'
import { createHash } from 'crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { basename, dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { parseAgentRegistryIndex } from '../../src/shared/schemas/agent-registry.schema'

/**
 * registry/index.json is the only thing a gallery reads before it opens an
 * agent, and the sha256 in it is what a download is verified against. If the
 * committed index drifts from the committed .adf bytes — someone edits an
 * agent and forgets `npm run registry:index` — every remote install of that
 * agent fails the hash check. This suite is the CI guard for that drift.
 *
 * Pure Node: no better-sqlite3, no Electron. It reads bytes and hashes them.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const registryDir = join(repoRoot, 'registry')
const indexPath = join(registryDir, 'index.json')

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

describe('registry/index.json integrity', () => {
  it('exists and parses as a registry index with nothing dropped', () => {
    expect(existsSync(indexPath)).toBe(true)
    const parsed = parseAgentRegistryIndex(JSON.parse(readFileSync(indexPath, 'utf-8')))
    expect(parsed).not.toBeNull()
    expect(parsed!.dropped).toBe(0)
  })

  it('every entry matches the bytes of its file, and its id matches the file name', () => {
    const parsed = parseAgentRegistryIndex(JSON.parse(readFileSync(indexPath, 'utf-8')))!
    expect(parsed.index.agents.length).toBeGreaterThan(0)
    for (const entry of parsed.index.agents) {
      const filePath = join(registryDir, entry.file)
      expect(existsSync(filePath), `${entry.file} is listed but not committed`).toBe(true)
      const bytes = readFileSync(filePath)
      expect(entry.size, `${entry.file}: size`).toBe(bytes.length)
      expect(entry.size, `${entry.file}: size`).toBe(statSync(filePath).size)
      expect(entry.sha256, `${entry.file}: sha256 — run \`npm run registry:index\``).toBe(sha256(bytes))
      expect(entry.id, `${entry.file}: id must be the file name without .adf`).toBe(basename(entry.file, '.adf'))
    }
  })

  it('lists every .adf committed under registry/', () => {
    const parsed = parseAgentRegistryIndex(JSON.parse(readFileSync(indexPath, 'utf-8')))!
    const listed = new Set(parsed.index.agents.map((a) => a.file))
    const onDisk = readdirSync(registryDir).filter((f) => f.endsWith('.adf')).sort()
    expect([...onDisk].filter((f) => !listed.has(f))).toEqual([])
  })

  it('carries no WAL sidecars — they are per-connection scratch, never committed', () => {
    const sidecars = readdirSync(registryDir).filter((f) => f.endsWith('.adf-wal') || f.endsWith('.adf-shm'))
    expect(sidecars).toEqual([])
  })
})
