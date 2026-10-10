import { describe, it, expect, afterAll } from 'vitest'
import { CodeSandboxService } from '../../../src/main/runtime/code-sandbox'

/**
 * Behaviours agent code relied on before the sandbox moved behind the
 * membrane: changing a host object's prototype or extensibility, old-style
 * inheritance from host classes, and errors thrown inside timer callbacks.
 */
describe('code sandbox membrane fidelity', () => {
  const sandbox = new CodeSandboxService()
  const agentId = '0d6f2a8c-1e4b-4c7a-9b3d-6e2f8a1c4b5d'
  afterAll(() => sandbox.destroy(agentId))

  const run = async (code: string) => {
    const result = await sandbox.execute(agentId, code, 5000)
    expect(result.error).toBeUndefined()
    return JSON.parse(result.result!)
  }

  it('supports util.inherits from a host class', async () => {
    expect(await run(`
      const util = __require('util')
      const EventEmitter = __require('events')
      function Bus() { EventEmitter.call(this) }
      util.inherits(Bus, EventEmitter)
      const bus = new Bus()
      let got
      bus.on('x', (v) => { got = v })
      bus.emit('x', 3)
      return { got, superOk: Bus.super_ === EventEmitter, isEm: bus instanceof EventEmitter }
    `)).toEqual({ got: 3, superOk: true, isEm: true })
  })

  it('freezes, seals and prevents extensions on host objects', async () => {
    expect(await run(`
      const EventEmitter = __require('events')
      const frozen = Object.freeze(new EventEmitter())
      const sealed = Object.seal(new EventEmitter())
      const closed = Object.preventExtensions(new EventEmitter())
      let threw = false
      try { 'use strict'; frozen.extra = 1 } catch (e) { threw = true }
      return {
        frozen: Object.isFrozen(frozen),
        sealed: Object.isSealed(sealed),
        closed: !Object.isExtensible(closed),
        noExtra: frozen.extra === undefined,
        keys: Object.keys(frozen).length > 0,
      }
    `)).toEqual({ frozen: true, sealed: true, closed: true, noExtra: true, keys: true })
  })

  it('sets the prototype of a host object', async () => {
    expect(await run(`
      const EventEmitter = __require('events')
      const em = new EventEmitter()
      const proto = { hello() { return 'hi' } }
      Object.setPrototypeOf(em, proto)
      return { hello: em.hello(), same: Object.getPrototypeOf(em) === proto }
    `)).toEqual({ hello: 'hi', same: true })
  })

  it('refuses to freeze a Buffer the way plain JS does', async () => {
    expect(await run(`try { Object.freeze(Buffer.from('a')); return 'froze' } catch (e) { return e instanceof TypeError }`)).toBe(true)
  })

  it('fails the execution when a timer callback throws', async () => {
    const result = await sandbox.execute(agentId, `
      await new Promise((resolve) => {
        setTimeout(() => { throw new Error('boom in timer') }, 1)
        setTimeout(resolve, 200)
      })
      return 'finished'
    `, 5000)
    expect(result.error).toMatch(/boom in timer/)
    // A timer set after an await belongs to the execution too.
    const late = await sandbox.execute(agentId, `
      await Promise.resolve()
      await new Promise((resolve) => {
        setTimeout(() => { throw new Error('late boom') }, 1)
        setTimeout(resolve, 200)
      })
    `, 5000)
    expect(late.error).toMatch(/late boom/)
    // The sandbox survives it.
    const next = await sandbox.execute(agentId, 'return 1 + 1', 5000)
    expect(next.result).toBe('2')
  })
})
