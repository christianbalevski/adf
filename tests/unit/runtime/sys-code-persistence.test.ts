import { describe, it, expect, afterAll } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { CodeSandboxService } from '../../../src/main/runtime/code-sandbox'
import { shutdownSandboxHosts } from '../../../src/main/runtime/sandbox-host'
import { PRELUDE_GLOBALS, transformCode } from '../../../src/main/runtime/code-transform'
import { SysCodeTool } from '../../../src/main/tools/built-in/sys-code.tool'
import type { AdfWorkspace } from '../../../src/main/adf/adf-workspace'

const service = new CodeSandboxService()
afterAll(async () => {
  service.destroyAll()
  await shutdownSandboxHosts()
})

let n = 0
/** Run blocks in order on one fresh sandbox, as sys_code with clear_state: false. */
async function session(...blocks: string[]) {
  const id = `persist-${++n}`
  const results = []
  for (const code of blocks) results.push(await service.execute(id, code, 10_000, undefined, undefined, { persist: true }))
  service.destroy(id)
  return results
}
const last = async (...blocks: string[]) => (await session(...blocks)).at(-1)!

describe('sys_code clear_state: false keeps top-level declarations', () => {
  it.each([
    ['const', 'const a = 1', 'a', '1'],
    ['let', 'let a = 2', 'a', '2'],
    ['var', 'var a = 3', 'a', '3'],
    ['function', 'function f() { return 4 }', 'f()', '4'],
    ['async function', 'async function f() { return 5 }', 'await f()', '5'],
    ['class', 'class C { v() { return 6 } }', 'new C().v()', '6'],
    ['awaited const', 'const g = await Promise.resolve(7)', 'g', '7'],
    ['destructuring', 'const { p, q: [r = 8] } = { p: 1, q: [] }', 'p + r', '9'],
    ['var in a block', 'if (true) { var d = 10 }', 'd', '10'],
    ['use strict', '"use strict"; const s = 11', 's', '11'],
    ['use strict without a semicolon', "'use strict'\nconst s = 11", 's', '11'],
    ['using elsewhere in the block', 'import { join } from "path"; using res = { [Symbol.dispose]() {} }', 'typeof join', 'function'],
    ['export', 'export const e = 12', 'e', '12'],
  ])('%s', async (_kind, first, second, expected) => {
    const [a, b] = await session(first, second)
    expect(a.error).toBeUndefined()
    expect(b).toMatchObject({ result: expected })
  })

  it('keeps imports, including aliases and default plus named', async () => {
    expect(await last('import { randomUUID as uuid } from "crypto"', 'typeof uuid')).toMatchObject({ result: 'function' })
    expect(await last('import path, { join } from "path"', 'typeof path.join + typeof join')).toMatchObject({ result: 'functionfunction' })
    expect(await last('import * as util from "util"', 'typeof util.format')).toMatchObject({ result: 'function' })
  })

  it('re-running a block reassigns instead of failing', async () => {
    expect(await last('const x = 1', 'const x = 2', 'x')).toMatchObject({ result: '2' })
  })

  it('keeps block- and loop-scoped declarations local', async () => {
    expect(await last('for (let i = 0; i < 2; i++) {} { const inner = 1 }', 'typeof i + typeof inner')).toMatchObject({ result: 'undefinedundefined' })
  })

  it('a saved function sees later values and prints into the running call', async () => {
    const r = await last('let count = 0; function bump() { count++; console.log("bumped", count) }', 'bump(); bump(); return count')
    expect(r).toMatchObject({ result: '2', stdout: 'bumped 1\nbumped 2' })
  })

  it('never persists names every object inherits', async () => {
    expect(await last('let valueOf = 3', 'typeof valueOf')).toMatchObject({ result: 'function' })
    expect(await last('const __proto__ = { foo: 1 }', 'typeof foo')).toMatchObject({ result: 'undefined' })
  })

  it('never overwrites a sandbox global: the declaration stays local', async () => {
    const [a, b] = await session('const URL = "https://example.com"; return URL', 'typeof URL')
    expect(a).toMatchObject({ result: 'https://example.com' })
    expect(b).toMatchObject({ result: 'function' })
    expect((await session('const adf = 1'))[0].error).toMatch(/already been declared/)
  })

  it('a single expression still returns its value', async () => {
    expect(await last('1 + 1')).toMatchObject({ result: '2' })
  })

  it('without persist, declarations stay local to the call', async () => {
    const id = `local-${++n}`
    await service.execute(id, 'const a = 1', 10_000)
    expect(await service.execute(id, 'typeof a', 10_000)).toMatchObject({ result: 'undefined' })
    service.destroy(id)
  })
})

describe('import rewrite (every caller)', () => {
  it('leaves import-like text in strings alone', () => {
    const code = 'const s = "import x from \'y\'"'
    expect(transformCode(code)).toBe(code)
  })

  it('rewrites side-effect and default plus named imports', () => {
    expect(transformCode('import "m"')).toBe('await __require("m");')
    expect(transformCode('import a, { b as c } from "m"')).toBe('const __adf_import_0 = await __require("m"), a = __adf_import_0, { b: c } = __adf_import_0;')
  })
})

describe('sys_code tool', () => {
  const workspace = { insertLog: () => {} } as unknown as AdfWorkspace

  it('keeps what a default call declared for the clear_state: false call after it', async () => {
    const tool = new SysCodeTool(service, `tool-${++n}`)
    await tool.execute({ code: 'const data = [1, 2, 3]' }, workspace)
    expect((await tool.execute({ code: 'data.length', clear_state: false }, workspace)).content).toBe('Result: 3')
  })

  it('says when a clear_state: false call lands on a new sandbox', async () => {
    const tool = new SysCodeTool(service, `tool-${++n}`)
    const first = await tool.execute({ code: 'const a = 1', clear_state: false }, workspace)
    expect(first.content).toMatch(/^Note: this call ran in a new sandbox/)
    const second = await tool.execute({ code: 'a', clear_state: false }, workspace)
    expect(second.content).toBe('Result: 1')
  })

  it("the shell's node (isolated) neither sees nor clears saved state", async () => {
    const id = `tool-${++n}`
    const tool = new SysCodeTool(service, id)
    await tool.execute({ code: 'const kept = 1', clear_state: false }, workspace)
    const shell = await tool.execute({ code: 'const kept2 = 2; return typeof kept' }, workspace, { isolated: true })
    expect(shell.content).toBe('Result: undefined')
    expect((await tool.execute({ code: 'typeof kept + typeof kept2', clear_state: false }, workspace)).content).toBe('Result: numberundefined')
  })

  it('clear_state: true while another call is running gets a fresh sandbox and leaves the old one to finish', async () => {
    const id = `tool-${++n}`
    const tool = new SysCodeTool(service, id)
    await tool.execute({ code: 'globalThis.keep = 1', clear_state: false }, workspace)
    const slow = tool.execute({ code: 'await new Promise(r => setTimeout(r, 300)); return keep', clear_state: false }, workspace)
    await new Promise(r => setTimeout(r, 50))
    const fresh = await tool.execute({ code: 'typeof keep', clear_state: true }, workspace)
    expect(fresh.content).toBe('Result: undefined')
    expect((await slow).content).toBe('Result: 1')
    expect(service.has(id)).toBe(true)
  })
})

it('PRELUDE_GLOBALS lists every global the prelude defines', () => {
  const prelude = readFileSync(join(__dirname, '../../../src/main/runtime/sandbox-prelude.ts'), 'utf8')
  const defined = [...prelude.matchAll(/defineGlobal\('(\w+)'/g)].map(m => m[1])
  const hostList = prelude.match(/var hostGlobals = \[([^\]]+)\]/)![1]
  defined.push(...[...hostList.matchAll(/'(\w+)'/g)].map(m => m[1]))
  for (const name of defined) expect(PRELUDE_GLOBALS).toContain(name)
})

describe('output of saved functions and finished executions', () => {
  const sleep = 'const sleep = ms => new Promise(r => setTimeout(r, ms));'

  it("a timed-out execution's late output never lands in the next result", async () => {
    const id = `out-${++n}`
    const x = await service.execute(id, `${sleep} for (let i = 0; i < 6; i++) { await sleep(300); console.log('tick', i) }`, 1000, undefined, undefined, { persist: true })
    expect(x.errorCode).toBe('TIMEOUT')
    const y = await service.execute(id, `await sleep(1200); return 'Y'`, 5000, undefined, undefined, { persist: true })
    expect(y).toMatchObject({ result: 'Y', stdout: '' })
    service.destroy(id)
  })

  it('a saved function never prints into another running execution', async () => {
    const id = `out-${++n}`
    await service.execute(id, `${sleep} function f() { console.log('from f') }`, 5000, undefined, undefined, { persist: true })
    const b = service.execute(id, 'await sleep(300); return "B"', 5000, undefined, undefined, { persist: true })
    const a = await service.execute(id, 'await sleep(50); f(); return "A"', 5000, undefined, undefined, { persist: true })
    expect((await b).stdout).not.toContain('from f')
    expect(a.result).toBe('A')
    service.destroy(id)
  })

  it("a finished execution's failing timer does not silence its saved functions", async () => {
    const id = `out-${++n}`
    await service.execute(id, `function f() { console.log('from f') }; setTimeout(() => { throw new Error('boom') }, 100); return 1`, 5000, undefined, undefined, { persist: true })
    await new Promise(r => setTimeout(r, 300))
    expect(await service.execute(id, 'f(); return 2', 5000, undefined, undefined, { persist: true })).toMatchObject({ result: '2', stdout: 'from f' })
    service.destroy(id)
  })
})

it('destroyAll() also stops a worker destroy() detached mid-execution', async () => {
  const id = `detached-${++n}`
  const running = service.execute(id, 'await new Promise(r => setTimeout(r, 3000)); return "still ran"', 10_000)
  await new Promise(r => setTimeout(r, 300))
  service.destroy(id)
  service.destroyAll()
  expect(await running).toMatchObject({ errorCode: 'SANDBOX_TERMINATED' })
})
