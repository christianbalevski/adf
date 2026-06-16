import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runImport } from '../../../src/main/import'
import { parseYaml, parseFrontmatter, get, asString } from '../../../src/main/import/yaml-lite'
import { parseModelRef, normalizeProvider } from '../../../src/main/import/model-map'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'adf-import-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('yaml-lite', () => {
  it('parses front-matter and body', () => {
    const { data, body } = parseFrontmatter(
      '---\nname: Atlas\ndescription: "A helper"\nmodel: anthropic/claude-opus-4-8\n---\nYou are Atlas.\n',
    )
    expect(asString(data.name)).toBe('Atlas')
    expect(asString(data.description)).toBe('A helper')
    expect(asString(data.model)).toBe('anthropic/claude-opus-4-8')
    expect(body.trim()).toBe('You are Atlas.')
  })

  it('parses nested maps, lists and inline flows', () => {
    const doc = parseYaml(
      [
        'model:',
        '  default: openai/gpt-5.4   # comment',
        '  max_tokens: 8192',
        'mcp_servers:',
        '  - name: fs',
        '    command: npx',
        '    args: [-y, server-filesystem]',
        '  - name: web',
        '    url: https://example.com/mcp',
      ].join('\n'),
    )
    expect(asString(get(doc, 'model', 'default'))).toBe('openai/gpt-5.4')
    expect(get(doc, 'model', 'max_tokens')).toBe(8192)
    const servers = get(doc, 'mcp_servers')
    expect(Array.isArray(servers)).toBe(true)
    expect(asString(get((servers as never[])[0], 'name'))).toBe('fs')
    expect(get((servers as never[])[0], 'args')).toEqual(['-y', 'server-filesystem'])
    expect(asString(get((servers as never[])[1], 'url'))).toBe('https://example.com/mcp')
  })
})

describe('model-map', () => {
  it('splits provider/model and normalizes provider', () => {
    expect(parseModelRef('anthropic/claude-opus-4-8')).toEqual({ provider: 'anthropic', model_id: 'claude-opus-4-8' })
    expect(parseModelRef('gpt-5.4')).toEqual({ model_id: 'gpt-5.4' })
    expect(normalizeProvider('openrouter')).toBe('openai-compatible')
    expect(normalizeProvider('Anthropic')).toBe('anthropic')
    expect(normalizeProvider('openai')).toBe('openai')
  })
})

describe('import openclaw', () => {
  it('converts a workspace into a .adf', () => {
    const ws = join(root, 'atlas')
    mkdirSync(ws)
    writeFileSync(
      join(ws, 'SOUL.md'),
      '---\nname: Atlas\ndescription: A research helper\nmodel: anthropic/claude-opus-4-8\n---\nYou are Atlas, a meticulous researcher.\n',
    )
    writeFileSync(join(ws, 'AGENTS.md'), 'Always cite sources.')
    writeFileSync(join(ws, 'MEMORY.md'), 'User prefers concise answers.')
    mkdirSync(join(ws, 'skills'))
    writeFileSync(join(ws, 'skills', 'search.md'), '# Search skill')

    const out = join(root, 'atlas.adf')
    const outcome = runImport({ from: 'openclaw', srcPath: ws, outPath: out })

    expect(outcome.name).toBe('Atlas')
    expect(outcome.files).toBeGreaterThanOrEqual(1)

    const adf = AdfWorkspace.open(out)
    try {
      const cfg = adf.getAgentConfig()
      expect(cfg.name).toBe('Atlas')
      expect(cfg.description).toBe('A research helper')
      expect(cfg.instructions).toContain('meticulous researcher')
      expect(cfg.instructions).toContain('Operating rules')
      expect(cfg.instructions).toContain('cite sources')
      expect(cfg.model.provider).toBe('anthropic')
      expect(cfg.model.model_id).toBe('claude-opus-4-8')
      expect(adf.readMind()).toContain('concise answers')
      expect(adf.getDatabase().readFile('imported/skills/search.md')).toBeTruthy()
      expect(adf.getDatabase().getMeta('adf_import_source')).toBe('openclaw')
    } finally {
      adf.close()
    }
  })

  it('throws without SOUL.md', () => {
    const ws = join(root, 'empty')
    mkdirSync(ws)
    expect(() => runImport({ from: 'openclaw', srcPath: ws, outPath: join(root, 'x.adf') })).toThrow(/SOUL\.md/)
  })
})

describe('import hermes', () => {
  it('converts an exported profile into a .adf with mcp servers', () => {
    const prof = join(root, 'work')
    mkdirSync(prof)
    writeFileSync(
      join(prof, 'config.yaml'),
      [
        'model:',
        '  default: anthropic/claude-sonnet-4-6',
        '  max_tokens: 8192',
        'mcp_servers:',
        '  - name: filesystem',
        '    command: npx',
        '    args: [-y, "@modelcontextprotocol/server-filesystem"]',
        '  - name: remote',
        '    url: https://mcp.example.com',
      ].join('\n'),
    )
    writeFileSync(join(prof, 'SOUL.md'), 'You are a diligent work assistant.')
    mkdirSync(join(prof, 'memories'))
    writeFileSync(join(prof, 'memories', 'MEMORY.md'), 'Project deadline is Friday.')
    writeFileSync(join(prof, 'memories', 'USER.md'), 'User is an engineer.')
    writeFileSync(join(prof, '.env'), 'ANTHROPIC_API_KEY=secret')
    mkdirSync(join(prof, 'sessions'))

    const out = join(root, 'work.adf')
    const outcome = runImport({ from: 'hermes', srcPath: prof, outPath: out })

    expect(outcome.name).toBe('work')
    expect(outcome.warnings.some(w => w.includes('.env'))).toBe(true)
    expect(outcome.warnings.some(w => w.toLowerCase().includes('session'))).toBe(true)

    const adf = AdfWorkspace.open(out)
    try {
      const cfg = adf.getAgentConfig()
      expect(cfg.instructions).toContain('diligent work assistant')
      expect(cfg.model.provider).toBe('anthropic')
      expect(cfg.model.model_id).toBe('claude-sonnet-4-6')
      expect(cfg.model.max_tokens).toBe(8192)
      expect(cfg.mcp?.servers).toHaveLength(2)
      expect(cfg.mcp?.servers[0]).toMatchObject({ name: 'filesystem', transport: 'stdio', command: 'npx' })
      expect(cfg.mcp?.servers[1]).toMatchObject({ name: 'remote', transport: 'http', url: 'https://mcp.example.com' })
      expect(adf.readMind()).toContain('Friday')
      expect(adf.getDatabase().readFile('imported/USER.md')).toBeTruthy()
    } finally {
      adf.close()
    }
  })

  it('refuses to overwrite without --force', () => {
    const prof = join(root, 'p')
    mkdirSync(prof)
    writeFileSync(join(prof, 'SOUL.md'), 'persona')
    const out = join(root, 'p.adf')
    runImport({ from: 'hermes', srcPath: prof, outPath: out })
    expect(() => runImport({ from: 'hermes', srcPath: prof, outPath: out })).toThrow(/overwrite/)
    expect(() => runImport({ from: 'hermes', srcPath: prof, outPath: out, force: true })).not.toThrow()
  })
})
