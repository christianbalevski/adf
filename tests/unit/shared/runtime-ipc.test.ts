/**
 * The runtime tag and the preload factory's IPC (docs/design/multi-runtime.md
 * §4.1): `local` sends no tag and receives untagged pushes; a surface bound
 * to another runtime tags its calls and receives its own pushes plus every
 * Studio and aggregate push.
 */
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { IPC } from '../../../src/shared/constants/ipc-channels'
import { RUNTIME_PUSH_CHANNELS } from '../../../src/shared/constants/runtime-push-channels'
import { createRuntimeIpc, onAnyRuntime, type IpcListener, type IpcRendererLike } from '../../../src/shared/runtime-ipc'
import { isRuntimeTag, noticeKey, runtimeTag, splitRuntimeTag } from '../../../src/shared/runtime-tag'

const HOST_1 = 'remote:host-1'
const HOST_2 = 'remote:host-2'

function fakeIpc() {
  const emitter = new EventEmitter()
  const invokes: Array<{ channel: string; args: unknown[] }> = []
  const sends: Array<{ channel: string; args: unknown[] }> = []
  const ipc: IpcRendererLike = {
    invoke: async (channel, ...args) => { invokes.push({ channel, args }); return null },
    send: (channel, ...args) => { sends.push({ channel, args }) },
    on: (channel, listener) => emitter.on(channel, listener as (...a: unknown[]) => void),
    removeListener: (channel, listener) => emitter.removeListener(channel, listener as (...a: unknown[]) => void),
  }
  const push = (channel: string, ...args: unknown[]) => emitter.emit(channel, { sender: null }, ...args)
  return { ipc, invokes, sends, push, count: (channel: string) => emitter.listenerCount(channel) }
}

const scoped = new Set(RUNTIME_PUSH_CHANNELS)

describe('runtime tag', () => {
  it('is a plain object with exactly the key $runtime and a string value', () => {
    expect(isRuntimeTag({ $runtime: HOST_1 })).toBe(true)
    expect(isRuntimeTag({ $runtime: 1 })).toBe(false)
    expect(isRuntimeTag({ $runtime: HOST_1, filePath: 'x' })).toBe(false)
    expect(isRuntimeTag([HOST_1])).toBe(false)
    expect(isRuntimeTag(null)).toBe(false)
    expect(isRuntimeTag('remote:host-1')).toBe(false)
    expect(isRuntimeTag(new (class { $runtime = HOST_1 })())).toBe(false)
  })

  it('is never made for local', () => {
    expect(runtimeTag('local')).toBeNull()
    expect(runtimeTag(null)).toBeNull()
    expect(runtimeTag(HOST_1)).toEqual({ $runtime: HOST_1 })
  })

  it('split: the arguments without the tag; untagged arguments are the same array', () => {
    const args = [{ filePath: 'a.adf' }]
    expect(splitRuntimeTag(args)).toEqual({ runtimeId: null, args })
    expect(splitRuntimeTag(args).args).toBe(args)
    expect(splitRuntimeTag([{ $runtime: HOST_1 }, { filePath: 'a.adf' }])).toEqual({ runtimeId: HOST_1, args: [{ filePath: 'a.adf' }] })
  })

  it('notice keys of equal ids on two runtimes stay distinct; the primary\'s is the plain id', () => {
    expect(noticeKey(undefined, 'n1')).toBe('n1')
    expect(noticeKey('local', 'n1')).toBe('n1')
    expect(noticeKey(HOST_1, 'n1')).not.toBe(noticeKey(HOST_2, 'n1'))
    expect(noticeKey(HOST_1, 'n1')).not.toBe('n1')
  })
})

describe('preload factory IPC', () => {
  it('local sends exactly the arguments it is given: no tag', async () => {
    const f = fakeIpc()
    const local = createRuntimeIpc(f.ipc, 'local', scoped)
    await local.invoke(IPC.FILE_OPEN, { filePath: 'a.adf' })
    await local.invoke(IPC.FILE_SAVE)
    local.send(IPC.DOC_SET_DOCUMENT, 'x')
    expect(f.invokes).toEqual([{ channel: IPC.FILE_OPEN, args: [{ filePath: 'a.adf' }] }, { channel: IPC.FILE_SAVE, args: [] }])
    expect(f.sends).toEqual([{ channel: IPC.DOC_SET_DOCUMENT, args: ['x'] }])
  })

  it('a bound surface puts its tag first on every call and send', async () => {
    const f = fakeIpc()
    const host = createRuntimeIpc(f.ipc, HOST_1, scoped)
    await host.invoke(IPC.FILE_OPEN, { filePath: '/srv/a.adf' })
    host.send(IPC.DOC_SET_DOCUMENT, 'x')
    expect(f.invokes).toEqual([{ channel: IPC.FILE_OPEN, args: [{ $runtime: HOST_1 }, { filePath: '/srv/a.adf' }] }])
    expect(f.sends).toEqual([{ channel: IPC.DOC_SET_DOCUMENT, args: [{ $runtime: HOST_1 }, 'x'] }])
  })

  it('pushes: local gets untagged ones only; a bound surface its own, untagged of it', () => {
    const f = fakeIpc()
    const local = createRuntimeIpc(f.ipc, 'local', scoped)
    const host1 = createRuntimeIpc(f.ipc, HOST_1, scoped)
    const host2 = createRuntimeIpc(f.ipc, HOST_2, scoped)
    const got: Record<string, unknown[][]> = { local: [], host1: [], host2: [] }
    local.on(IPC.AGENT_EVENT, (_e, ...args) => got.local.push(args))
    host1.on(IPC.AGENT_EVENT, (_e, ...args) => got.host1.push(args))
    host2.on(IPC.AGENT_EVENT, (_e, ...args) => got.host2.push(args))
    f.push(IPC.AGENT_EVENT, { type: 'a' })
    f.push(IPC.AGENT_EVENT, { $runtime: HOST_1 }, { type: 'b' })
    expect(got.local).toEqual([[{ type: 'a' }]])
    expect(got.host1).toEqual([[{ type: 'b' }]])
    expect(got.host2).toEqual([])
  })

  it('Studio and aggregate pushes reach every surface; they are never tagged', () => {
    const f = fakeIpc()
    const host1 = createRuntimeIpc(f.ipc, HOST_1, scoped)
    const seen: unknown[] = []
    host1.on(IPC.APPROVALS_CHANGED, (_e, snapshot) => seen.push(snapshot))
    host1.on(IPC.MENU_ACTION, (_e, action) => seen.push(action))
    f.push(IPC.APPROVALS_CHANGED, { pending: [], history: [] })
    f.push(IPC.MENU_ACTION, 'open-settings')
    expect(seen).toEqual([{ pending: [], history: [] }, 'open-settings'])
  })

  it('removeListener removes the wrapper it registered', () => {
    const f = fakeIpc()
    const host1 = createRuntimeIpc(f.ipc, HOST_1, scoped)
    const listener: IpcListener = () => {}
    host1.on(IPC.AGENT_EVENT, listener)
    expect(f.count(IPC.AGENT_EVENT)).toBe(1)
    host1.removeListener(IPC.AGENT_EVENT, listener)
    expect(f.count(IPC.AGENT_EVENT)).toBe(0)
  })

  it('onAnyRuntime delivers every push with its runtime id', () => {
    const f = fakeIpc()
    const seen: unknown[][] = []
    const off = onAnyRuntime(f.ipc, IPC.AGENT_EVENT, (id, ...args) => seen.push([id, ...args]))
    f.push(IPC.AGENT_EVENT, { type: 'a' })
    f.push(IPC.AGENT_EVENT, { $runtime: HOST_2 }, { type: 'c' })
    off()
    f.push(IPC.AGENT_EVENT, { type: 'gone' })
    expect(seen).toEqual([['local', { type: 'a' }], [HOST_2, { type: 'c' }]])
  })
})
