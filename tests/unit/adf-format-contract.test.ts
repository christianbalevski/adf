import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { afterAll, describe, expect, it } from 'vitest'

import { AdfDatabase, ADF_LATEST_SCHEMA_VERSION } from '../../src/main/adf/adf-database'
import { AgentConfigSchema } from '../../src/main/adf/adf-schema'
import type { Tool } from '../../src/main/tools/tool.interface'

// The ADF format is a public contract (AGENTS.md): built-in tables, the agent
// config schema, and every built-in tool's name and input schema. These
// snapshots make any change to it a reviewed diff. If one fails, the change
// needs the justification AGENTS.md asks for, not a routine snapshot update.

// Built-in tools, plus adf_shell, which lives beside its command parser.
const TOOL_DIRS = ['built-in', 'shell'].map((d) => join(__dirname, '../../src/main/tools', d))

// Tool constructors take bound callbacks and services; the schema never
// depends on them, so any argument works. compute_exec shapes its schema
// from the agent's compute targets: snapshot it with every built-in target.
const stub: unknown = new Proxy(() => undefined, { get: () => stub, apply: () => undefined })
const CTOR_ARGS: Record<string, unknown[]> = {
  ComputeExecTool: [null, { hasIsolated: true, hasShared: true, hasHost: true }, () => undefined],
  ShellTool: [stub, stub, {}],
}

async function builtInTools(): Promise<Tool[]> {
  const tools: Tool[] = []
  const files = TOOL_DIRS.flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith('.tool.ts')).map((f) => join(dir, f)))
  for (const file of files) {
    const mod = await import(file) as Record<string, unknown>
    for (const [exported, value] of Object.entries(mod)) {
      if (typeof value !== 'function' || !/^class\s/.test(Function.prototype.toString.call(value))) continue
      const Ctor = value as new (...args: unknown[]) => Partial<Tool>
      const tool = new Ctor(...(CTOR_ARGS[exported] ?? Array(Ctor.length).fill(stub)))
      if (typeof tool.name === 'string' && typeof tool.toProviderFormat === 'function') tools.push(tool as Tool)
    }
  }
  return tools.sort((a, b) => a.name.localeCompare(b.name))
}

describe('ADF format contract', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adf-format-contract-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('built-in tool names and input schemas', async () => {
    const tools = await builtInTools()
    expect(tools.length).toBeGreaterThan(40)
    const contract = Object.fromEntries(tools.map((t) => {
      const { name, input_schema } = t.toProviderFormat()
      return [name, input_schema]
    }))
    await expect(JSON.stringify(contract, null, 2)).toMatchFileSnapshot('__snapshots__/adf-tools.contract.json')
  })

  it('agent config schema', async () => {
    const schema = zodToJsonSchema(AgentConfigSchema, { $refStrategy: 'none' })
    await expect(JSON.stringify(schema, null, 2)).toMatchFileSnapshot('__snapshots__/adf-config.contract.json')
  })

  it('built-in tables of a new file', async () => {
    const filePath = join(dir, 'contract.adf')
    AdfDatabase.create(filePath, { name: 'contract' }).close()
    const db = new Database(filePath, { readonly: true })
    const rows = db.prepare(
      `SELECT type, name, sql FROM sqlite_master WHERE tbl_name LIKE 'adf\\_%' ESCAPE '\\' AND sql IS NOT NULL ORDER BY type, name`
    ).all() as { type: string; name: string; sql: string }[]
    db.close()
    const ddl = [`-- schema version ${ADF_LATEST_SCHEMA_VERSION}`, ...rows.map((r) => `${r.sql.replace(/\s+/g, ' ').trim()};`)].join('\n')
    await expect(ddl + '\n').toMatchFileSnapshot('__snapshots__/adf-tables.contract.sql')
  })
})
