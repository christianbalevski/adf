import { describe, it, expect, afterAll } from 'vitest'
import { CodeSandboxService } from '../../../src/main/runtime/code-sandbox'

/**
 * Probe: can sandboxed code reach the worker realm's Function constructor
 * (and from there `process` / fs) through a host-realm object injected into
 * the vm context? Each vector must fail to produce a real `process`.
 *
 * Every sandbox global is now built inside the vm realm, host values are only
 * reachable through a membrane that maps host intrinsics to their vm twins
 * (host Function -> vm Function, which cannot compile strings), and the worker
 * realm's own Function-family `.constructor` links are inert stand-ins. The
 * worker also runs in a separate process under Node's permission model — see
 * sandbox-host-permissions.test.ts for what escaped code would still face.
 */
describe('code sandbox realm escape', () => {
  const sandbox = new CodeSandboxService()
  const agentId = '5b4c9f0e-3d51-4b7e-9f55-0f3a6c2d8e11'
  afterAll(() => sandbox.destroy(agentId))

  const vectors: Record<string, string> = {
    'setTimeout.constructor': `setTimeout.constructor('return process')()`,
    'Buffer.constructor': `Buffer.constructor('return process')()`,
    '__require.constructor': `__require.constructor('return process')()`,
    'adf proxy fn constructor': `adf.fs_read.constructor('return process')()`,
    'adf proxy promise constructor': `(() => { const p = adf.nope(); p.catch(() => {}); return p.constructor.constructor('return process')() })()`,
    'host error constructor': `(() => { try { __require('fs') } catch (e) { return e.constructor.constructor('return process')() } })()`,
    'required module fn constructor': `(await __require('util')).inspect.constructor('return process')()`,
    'URL prototype chain': `Object.getPrototypeOf(URL).constructor('return process')()`,
    'TextEncoder method': `new TextEncoder().encode.constructor('return process')()`,
    'AsyncFunction via host async fn': `Object.getPrototypeOf(adf.fs_read).constructor('return process')()`,
    'process.hrtime': `process.hrtime.constructor('return process')()`,
    'dynamic import': `import('fs')`,
    // Additional vectors beyond the original 11.
    'globalThis constructor': `globalThis.constructor.constructor('return process')()`,
    'host buffer instance': `Buffer.from('x').constructor.constructor('return process')()`,
    'host buffer proto walk': `Object.getPrototypeOf(Object.getPrototypeOf(Buffer.from('x'))).constructor.constructor('return process')()`,
    'host promise': `(() => { const p = __require('util').promisify((cb) => cb(null, 1))(); return p.constructor.constructor('return process')() })()`,
    'host async fn constructor': `Object.getPrototypeOf(__require('util').promisify((cb) => cb())).constructor('return process')()`,
    'host fn descriptor': `Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Buffer), 'constructor').value('return process')()`,
    'host callback args': `new Promise((res) => __require('events').once(new (__require('events'))(), 'x').then(res) && 0 || res(__require('util').callbackify(async () => 1)))`,
    'callback receives host fn': `(() => { let leaked; [1].map.call(Buffer.from('a'), function () { leaked = arguments[2] }); return leaked && leaked.constructor.constructor('return process')() })()`,
    'host array from module': `Object.keys(__require('path')).constructor.constructor('return process')()`,
    'thenable handed to host': `await new Promise((resolve) => { __require('util').promisify((cb) => cb(null, { then(r) { resolve(r.constructor.constructor('return process')()) } }))() .then(() => {}, () => {}); setTimeout(() => resolve('none'), 50) })`,
    'prepareStackTrace hook': `(() => { try { Error.prepareStackTrace = (e, cs) => cs.map((c) => c.getThis()).find((t) => t && t.process) } catch (e) {} ; let out; __require('util').inspect({ get x() { out = new Error().stack; return 1 } }, { getters: true }); return out && out.process })()`,
    'global Error override': `(() => { try { globalThis.Error = { prepareStackTrace: (e, cs) => cs } } catch (e) {} ; return typeof Error.prepareStackTrace === 'function' ? 'ESCAPED' : undefined })()`,
    'host error via stack overflow': `(() => { const f = () => { try { return Buffer.from(f()) } catch (e) { return e } }; const e = f(); return e && e.constructor && e.constructor.constructor('return process')() })()`,
  }

  for (const [name, expr] of Object.entries(vectors)) {
    it(`blocks ${name}`, async () => {
      const code = `
        let p
        try { p = await (async () => ${expr})() } catch (e) { return 'blocked: ' + (e && e.message) }
        if (p === 'ESCAPED') return 'ESCAPED'
        if (p && typeof p === 'object' && (typeof p.getBuiltinModule === 'function' || typeof p.binding === 'function' || typeof p.readFileSync === 'function' || typeof p.pid === 'number')) return 'ESCAPED'
        return 'blocked: no process'
      `
      const result = await sandbox.execute(agentId, code, 5000)
      // A crashed or wedged sandbox would "pass" a bare not-ESCAPED check.
      expect(result.error).toBeUndefined()
      expect(result.result).toMatch(/^blocked/)
    })
  }

  it('keeps async-function detection by constructor name working', async () => {
    const result = await sandbox.execute(agentId, `
      const util = await __require('util')
      return [
        (async () => {}).constructor.name,
        adf.fs_read.constructor.name,
        util.types.isAsyncFunction(async () => {}),
      ].join(',')
    `, 5000)
    expect(result.error).toBeUndefined()
    expect(result.result).toBe('AsyncFunction,AsyncFunction,true')
  })

  it('keeps host values usable through the membrane', async () => {
    const result = await sandbox.execute(agentId, `
      const crypto = __require('crypto')
      const zlib = __require('zlib')
      const path = __require('path')
      const { EventEmitter } = __require('events')
      const buf = Buffer.from('hello world')
      const gz = zlib.gzipSync(buf)
      const back = zlib.gunzipSync(gz).toString()
      class Em extends EventEmitter {}
      const em = new Em()
      let got
      em.on('x', (v) => { got = v })
      em.emit('x', { n: 1 })
      const url = new URL('https://example.com/a?b=1')
      return {
        hash: crypto.createHash('sha256').update('abc').digest('hex').slice(0, 8),
        back,
        isBuf: Buffer.isBuffer(buf),
        u8: buf instanceof Uint8Array,
        arr: Array.isArray(path.resolve('/a', 'b').split(path.sep)),
        err: (() => { try { __require('nope') } catch (e) { return e instanceof Error } })(),
        got: got && got.n,
        sub: typeof em.emit,
        q: url.searchParams.get('b'),
        te: new TextDecoder().decode(new TextEncoder().encode('héllo')),
        concat: Buffer.concat([Buffer.from('a'), Buffer.from([98])]).toString(),
        json: JSON.stringify(Buffer.from('hi')),
        b64: btoa('hi') + atob('aGk='),
        clone: structuredClone({ a: [1, { b: 2 }] }).a[1].b,
        promise: await __require('util').promisify((cb) => setTimeout(() => cb(null, 7), 1))(),
      }
    `, 5000)
    expect(result.error).toBeUndefined()
    expect(JSON.parse(result.result!)).toEqual({
      hash: 'ba7816bf',
      back: 'hello world',
      isBuf: true,
      u8: true,
      arr: true,
      err: true,
      got: 1,
      sub: 'function',
      q: '1',
      te: 'héllo',
      concat: 'ab',
      json: '{"type":"Buffer","data":[104,105]}',
      b64: 'aGk=hi',
      clone: 2,
      promise: 7,
    })
  })
})
