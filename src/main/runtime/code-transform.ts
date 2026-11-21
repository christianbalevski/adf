import { parse } from 'acorn'
import { runInNewContext } from 'vm'

/**
 * Source rewrite applied before code reaches a sandbox worker. The worker runs
 * every execution as the body of `async function (adf, console) { ... }`, so
 * module syntax has to become plain statements:
 *
 * - `import` becomes `await __require(...)` (await, so ESM-only packages work;
 *   a default import binds the whole module, as it always has).
 * - `export` keywords are dropped so the declarations stay callable.
 *
 * With `persist` (sys_code with clear_state: false) top-level declarations also
 * become globals of the sandbox, so the next execution on the same sandbox can
 * use them: `const x = 1` becomes `void (x = 1)`, a function or class is copied
 * to `globalThis`, and an import assigns its bindings. A later `const x = 2`
 * simply reassigns. Declarations inside blocks and functions stay local, except
 * `var`, which is function-scoped and so belongs to the execution's top level.
 *
 * A name that is already a sandbox global (a built-in such as `URL` or `JSON`,
 * or a prelude global such as `setTimeout` or `adf`) is never overwritten: its
 * declaration stays local to the execution, exactly as before.
 *
 * The code is parsed as the async function body V8 compiles it as, so
 * anything valid there (top-level await, return, `using`) parses here too.
 * Code acorn cannot parse is returned unchanged; V8 then reports the error.
 */

/** Mirrors the worker's wrapper (sandbox-worker-source.ts), with a newline so
 *  the code starts on a line of its own. */
const WRAP_START = '(async function (adf, console) {\n'
const WRAP_END = '\n})'

/** Globals the sandbox prelude defines (sandbox-prelude.ts `defineGlobal`).
 *  tests/unit/runtime/code-transform.test.ts keeps this in step with the prelude. */
export const PRELUDE_GLOBALS = [
  'Error', 'console', 'process', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'queueMicrotask', 'structuredClone', 'atob', 'btoa', 'Buffer', 'TextEncoder', 'TextDecoder',
  'URL', 'URLSearchParams', '__require', 'require', '__stdlibPath', 'module', 'exports', 'adf',
]

let reserved: Set<string> | undefined
function isReserved(name: string): boolean {
  reserved ??= new Set([
    ...(runInNewContext('Object.getOwnPropertyNames(globalThis)') as string[]),
    // Every object, the global one included, inherits these: `let valueOf`
    // would read back the inherited method, `const __proto__` would replace
    // the global object's prototype.
    ...Object.getOwnPropertyNames(Object.prototype),
    'globalThis',
    ...PRELUDE_GLOBALS,
  ])
  return reserved.has(name)
}

interface Node {
  type: string
  start: number
  end: number
  [key: string]: unknown
}

interface Edit {
  start: number
  end: number
  text: string
}

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'StaticBlock'])

function patternNames(node: Node | null, out: string[] = []): string[] {
  if (!node) return out
  switch (node.type) {
    case 'Identifier': out.push(node.name as string); break
    case 'ObjectPattern':
      for (const p of node.properties as Node[]) patternNames(p.type === 'RestElement' ? p.argument as Node : p.value as Node, out)
      break
    case 'ArrayPattern': for (const e of node.elements as (Node | null)[]) patternNames(e, out); break
    case 'AssignmentPattern': patternNames(node.left as Node, out); break
    case 'RestElement': patternNames(node.argument as Node, out); break
  }
  return out
}

export function transformCode(input: string, persist = false): string {
  // Offsets below are into `code`, the wrapped text; the result is unwrapped.
  const code = WRAP_START + input + WRAP_END
  let body: Node[]
  try {
    const program = parse(code, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowImportExportEverywhere: true,
    }) as unknown as Node
    const fn = ((program.body as Node[])[0].expression as Node).body as Node
    body = fn.body as Node[]
  } catch {
    return input
  }

  const src = (n: Node): string => code.slice(n.start, n.end)
  const edits: Edit[] = []
  const predeclare = new Set<string>()
  const copyToGlobal: string[] = []
  let tmp = 0

  const importText = (node: Node, topLevel: boolean): string => {
    const from = `await __require(${JSON.stringify((node.source as Node).value)})`
    const specs = node.specifiers as Node[]
    if (specs.length === 0) return `${from};`
    const locals = specs.map(s => (s.local as Node).name as string)
    const whole = specs.filter(s => s.type !== 'ImportSpecifier').map(s => (s.local as Node).name as string)
    const named = specs.filter(s => s.type === 'ImportSpecifier').map(s => {
      const imported = s.imported as Node
      const key = imported.type === 'Identifier' ? imported.name as string : JSON.stringify(imported.value)
      return `${key}: ${(s.local as Node).name as string}`
    })
    const m = `__adf_import_${tmp++}`
    const targets = [...whole, ...(named.length ? [`{ ${named.join(', ')} }`] : [])]
    if (persist && topLevel && !locals.some(isReserved)) {
      for (const l of locals) predeclare.add(l)
      return `{ const ${m} = ${from}; ${targets.map(t => `(${t} = ${m});`).join(' ')} }`
    }
    return `const ${m} = ${from}, ${targets.map(t => `${t} = ${m}`).join(', ')};`
  }

  /** Persisted form of a declaration in `context`, or null to leave it as is. */
  const declarationText = (node: Node, context: 'statement' | 'for-init' | 'for-left'): string | null => {
    const decls = node.declarations as Node[]
    const names = decls.flatMap(d => patternNames(d.id as Node))
    if (names.some(isReserved)) return null
    for (const n of names) predeclare.add(n)
    if (context === 'for-left') return src(decls[0].id as Node)
    const parts = decls
      .filter(d => d.init || node.kind !== 'var')
      .map(d => `${src(d.id as Node)} = ${d.init ? src(d.init as Node) : 'undefined'}`)
    if (context === 'for-init') return parts.join(', ')
    return parts.length ? `${parts.map(p => `void (${p})`).join(', ')};` : ';'
  }

  const visit = (node: Node, parent: Node | null, topLevel: boolean, inFunction: boolean): void => {
    switch (node.type) {
      case 'ImportDeclaration':
        edits.push({ start: node.start, end: node.end, text: importText(node, topLevel) })
        return
      case 'ExportAllDeclaration':
        edits.push({ start: node.start, end: node.end, text: '' })
        return
      case 'ExportNamedDeclaration':
      case 'ExportDefaultDeclaration': {
        const decl = node.declaration as Node | null
        if (!decl) {
          edits.push({ start: node.start, end: node.end, text: '' })
          return
        }
        const anonymous = (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') && !decl.id
        edits.push({ start: node.start, end: decl.start, text: anonymous ? '(' : '' })
        if (anonymous) edits.push({ start: decl.end, end: decl.end, text: ');' })
        visit(decl, node, topLevel, inFunction)
        return
      }
      case 'VariableDeclaration': {
        if (!persist || !(topLevel || (node.kind === 'var' && !inFunction))) break
        const context = parent && /^For(In|Of)Statement$/.test(parent.type) && parent.left === node ? 'for-left'
          : parent?.type === 'ForStatement' && parent.init === node ? 'for-init'
          : 'statement'
        const text = declarationText(node, context)
        if (text === null) break
        edits.push({ start: node.start, end: node.end, text })
        return
      }
      case 'FunctionDeclaration':
      case 'ClassDeclaration': {
        const id = node.id as Node | null
        if (persist && topLevel && id && !isReserved(id.name as string)) {
          if (node.type === 'FunctionDeclaration') copyToGlobal.push(id.name as string)
          else edits.push({ start: node.end, end: node.end, text: ` globalThis.${id.name} = ${id.name};` })
        }
        break
      }
    }
    const nested = inFunction || FUNCTION_TYPES.has(node.type)
    for (const [key, value] of Object.entries(node)) {
      if (key === 'type' || key === 'start' || key === 'end') continue
      for (const child of Array.isArray(value) ? value : [value]) {
        if (child && typeof child === 'object' && typeof (child as Node).type === 'string') {
          visit(child as Node, node, false, nested)
        }
      }
    }
  }

  for (const stmt of body) visit(stmt, null, true, false)

  // Runs before anything else in the execution (after a 'use strict' prologue,
  // which must stay first): names exist on globalThis so assignments to them
  // work in strict mode too, and function declarations (hoisted) are copied.
  const prologue = [
    ...(predeclare.size ? [`for (const __adf_name of ${JSON.stringify([...predeclare])}) if (!(__adf_name in globalThis)) globalThis[__adf_name] = undefined;`] : []),
    ...copyToGlobal.map(n => `globalThis.${n} = ${n};`),
  ].join(' ')
  if (prologue) {
    let at = WRAP_START.length
    for (const stmt of body) {
      if (typeof stmt.directive !== 'string') break
      at = stmt.end
    }
    // After a directive the `;` ends it even when the agent left it off.
    edits.push({ start: at, end: at, text: at === WRAP_START.length ? `${prologue} ` : `;${prologue}` })
  }

  if (edits.length === 0) return input
  // Apply back to front so earlier offsets stay valid. Edits never overlap: a
  // replaced node's children are not visited.
  edits.sort((a, b) => b.start - a.start || b.end - a.end)
  let out = code
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  return out.slice(WRAP_START.length, out.length - WRAP_END.length)
}
