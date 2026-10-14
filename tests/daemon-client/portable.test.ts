// src/shared/daemon-client runs in the terminal app (ESM, Node), in Studio
// main (CJS bundle, Electron) and later elsewhere: it MUST NOT import Node
// modules, and its value imports MUST stay inside the folder (type imports of
// the daemon's real shapes are erased).

import { readdirSync, readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const DIR = resolve(__dirname, '../../src/shared/daemon-client')
const FILES = readdirSync(DIR).filter(f => f.endsWith('.ts'))
const NODE = new Set([...builtinModules, ...builtinModules.map(m => `node:${m}`)])

/** Every module specifier in `source`, and whether it is erased at runtime (type-only). */
function specifiers(file: string, source: string): Array<{ spec: string; typeOnly: boolean }> {
  const out: Array<{ spec: string; typeOnly: boolean }> = []
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const typeOnly = ts.isImportDeclaration(node)
        ? !!node.importClause?.isTypeOnly ||
          (!!node.importClause && !node.importClause.name && !!node.importClause.namedBindings && ts.isNamedImports(node.importClause.namedBindings) &&
            node.importClause.namedBindings.elements.every(e => e.isTypeOnly))
        : node.isTypeOnly
      out.push({ spec: node.moduleSpecifier.text, typeOnly })
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      out.push({ spec: node.argument.literal.text, typeOnly: true })
    } else if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      out.push({ spec: node.arguments[0].text, typeOnly: false })
    }
    ts.forEachChild(node, visit)
  }
  visit(ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS))
  return out
}

const NODE_GLOBALS = new Set(['process', 'Buffer', 'NodeJS', 'require', '__dirname', '__filename', 'global'])

/** Node-only globals referenced in code (comments and property names do not count). */
function nodeGlobals(file: string, source: string): string[] {
  const out: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && NODE_GLOBALS.has(node.text) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) out.push(node.text)
    ts.forEachChild(node, visit)
  }
  visit(ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS))
  return out
}

describe('shared daemon client portability', () => {
  it('has the client, stream, types and normalizer', () => {
    expect(FILES.sort()).toEqual(['client.ts', 'index.ts', 'normalize.ts', 'sse.ts', 'types.ts'])
  })

  it('the scanner sees value imports, requires and dynamic imports', () => {
    const found = specifiers('x.ts', [
      "import { readFileSync } from 'node:fs'",
      "import type { A } from '../a'",
      "import { type B } from '../b'",
      "export { C } from '../c'",
      "const d = require('fs')",
      "type E = import('../e').E",
      "void import('os')",
    ].join('\n'))
    expect(found).toEqual([
      { spec: 'node:fs', typeOnly: false },
      { spec: '../a', typeOnly: true },
      { spec: '../b', typeOnly: true },
      { spec: '../c', typeOnly: false },
      { spec: 'fs', typeOnly: false },
      { spec: '../e', typeOnly: true },
      { spec: 'os', typeOnly: false },
    ])
  })

  it.each(FILES)('%s imports no Node module and loads values only from this folder', file => {
    const source = readFileSync(join(DIR, file), 'utf-8')
    const found = specifiers(file, source)
    expect(found.length).toBeGreaterThan(0)
    for (const { spec, typeOnly } of found) {
      expect(NODE.has(spec), `${file} imports ${spec}`).toBe(false)
      expect(spec === 'fs' || spec.startsWith('fs/'), `${file} imports ${spec}`).toBe(false)
      if (!typeOnly) expect(spec.startsWith('./'), `${file} loads code from ${spec}`).toBe(true)
    }
    expect(nodeGlobals(file, source), `${file} uses Node globals`).toEqual([])
  })

  it('bundles for a neutral platform and runs as CommonJS (Electron main) without Node globals', async () => {
    const result = await build({
      entryPoints: [join(DIR, 'index.ts')],
      bundle: true,
      write: false,
      format: 'cjs',
      platform: 'neutral',
      logLevel: 'silent',
    })
    expect(result.errors).toEqual([])
    const code = result.outputFiles[0].text
    const module = { exports: {} as Record<string, unknown> }
    // Only what a browser-like or Node runtime both give: no require, process or Buffer.
    runInNewContext(code, { module, exports: module.exports, URL, URLSearchParams, AbortController, TextDecoder, setTimeout, clearTimeout, fetch: async () => { throw new Error('no network') } })
    expect(Object.keys(module.exports)).toEqual(expect.arrayContaining(['DaemonClient', 'EventStream', 'DaemonError', 'MAIN_LOOP', 'normalizeRuntime', 'staticCredentials', 'dedupeKey']))
  })

  it('bundles as ESM too (terminal app)', async () => {
    const result = await build({ entryPoints: [join(DIR, 'index.ts')], bundle: true, write: false, format: 'esm', platform: 'neutral', logLevel: 'silent' })
    expect(result.errors).toEqual([])
    expect(result.outputFiles[0].text).toMatch(/export\s*\{[^}]*DaemonClient/)
  })
})
