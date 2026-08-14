import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync } from 'fs'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { AgentSession } from '../../../src/main/runtime/agent-session'
import { convertMessages } from '../../../src/main/providers/ai-sdk-provider'
import type { LLMMessage } from '../../../src/shared/types/provider.types'

let rootDir: string
let ws: AdfWorkspace
let session: AgentSession

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'adf-seq-markers-'))
  ws = AdfWorkspace.create(join(rootDir, 'agent.adf'), { name: 'seq-markers' })
  session = new AgentSession(ws)
})

afterEach(() => {
  ws.close()
  rmSync(rootDir, { recursive: true, force: true })
})

describe('session seq capture', () => {
  it('addMessage stamps msg.seq from the loop insert, without touching stored content', () => {
    const msg: LLMMessage = { role: 'user', content: [{ type: 'text', text: 'hello world' }] }
    session.addMessage(msg)

    expect(typeof msg.seq).toBe('number')
    const loop = ws.getLoop()
    expect(loop).toHaveLength(1)
    expect(loop[0].seq).toBe(msg.seq)
    // content_json stays unprefixed — the marker exists only at conversion time.
    expect(loop[0].content_json[0].text).toBe('hello world')
  })

  it('appendContextEntry loop rows keep the [Context: prefix parseable (no marker in storage)', () => {
    session.appendContextEntry('system_prompt', 'the system prompt body')
    const loop = ws.getLoop()
    expect(loop[0].content_json[0].text?.startsWith('[Context: system_prompt] ')).toBe(true)

    // Restore drops context entries exactly as before seq markers existed.
    const restored = new AgentSession(ws)
    restored.restoreMessages(loop.map(e => ({ role: e.role, content: e.content_json, created_at: e.created_at, seq: e.seq })))
    expect(restored.getMessages()).toHaveLength(0)
  })
})

describe('provider [S<seq>] marker injection', () => {
  it('user text gains the marker beside the timestamp; content without seq gets none', () => {
    const withSeq: LLMMessage = { role: 'user', content: [{ type: 'text', text: 'cite me' }], created_at: Date.UTC(2026, 0, 2, 3, 4, 5), seq: 137 }
    const withoutSeq: LLMMessage = { role: 'user', content: [{ type: 'text', text: 'no seq' }], created_at: Date.UTC(2026, 0, 2, 3, 4, 6) }
    const [a, b] = convertMessages([withSeq, withoutSeq]) as Array<{ role: string; content: string }>

    expect(a.content).toBe('[2026-01-02 03:04:05 UTC] [S137] cite me')
    expect(b.content).toBe('[2026-01-02 03:04:06 UTC] no seq')
  })

  it('marker without timestamp still prefixes cleanly', () => {
    const msg: LLMMessage = { role: 'user', content: 'plain string', seq: 9 }
    const [m] = convertMessages([msg]) as Array<{ content: string }>
    expect(m.content).toBe('[S9] plain string')
  })

  it('assistant messages get NO seq marker — the agent must not imitate its own [S<seq>] prefix', () => {
    const msg: LLMMessage = {
      role: 'assistant',
      seq: 42,
      content: [
        { type: 'text', text: 'first thought' },
        { type: 'tool_use', id: 'call-1', name: 'fs_read', input: { path: 'x' } },
        { type: 'text', text: 'second thought' }
      ]
    }
    const [m] = convertMessages([msg]) as Array<{ content: Array<Record<string, unknown>> }>
    expect(m.content[0]).toEqual({ type: 'text', text: 'first thought' })
    expect(m.content[1]).toMatchObject({ type: 'tool-call', toolCallId: 'call-1', toolName: 'fs_read' })
    expect(m.content[2]).toEqual({ type: 'text', text: 'second thought' })
  })

  it('assistant string content keeps the timestamp but drops the seq marker', () => {
    const [m] = convertMessages([
      { role: 'assistant', seq: 137, created_at: Date.UTC(2026, 0, 2, 3, 4, 5), content: 'my reply' }
    ]) as Array<{ content: string }>
    expect(m.content).toBe('[2026-01-02 03:04:05 UTC] my reply')
    expect(m.content).not.toContain('[S137]')
  })

  it('tool_result parts carry no marker', () => {
    const use: LLMMessage = {
      role: 'assistant', seq: 1,
      content: [{ type: 'tool_use', id: 'c1', name: 'fs_read', input: {} }]
    }
    const result: LLMMessage = {
      role: 'user', seq: 2,
      content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'file body' }]
    }
    const converted = convertMessages([use, result]) as Array<{ role: string; content: unknown }>
    const toolMsg = converted.find(m => m.role === 'tool') as { content: Array<{ output: { value: string } }> }
    expect(toolMsg.content[0].output.value).toBe('file body')
  })

  it('flush-retry stamps seq late and busts the conversion cache', () => {
    let fail = true
    const inserted: Array<{ role: string }> = []
    let nextSeq = 100
    const stubWorkspace = {
      appendToLoop: (role: string) => {
        if (fail) throw new Error('DB busy')
        inserted.push({ role })
        return nextSeq++
      },
      transaction: (fn: () => void) => fn()
    } as unknown as AdfWorkspace

    const s = new AgentSession(stubWorkspace)
    const msg: LLMMessage = { role: 'user', content: [{ type: 'text', text: 'retry me' }], created_at: Date.UTC(2026, 0, 1) }
    s.addMessage(msg)
    expect(msg.seq).toBeUndefined()

    // Conversion before the retry: cached, no marker.
    const firstRef = s.getMessages()
    const before = convertMessages(firstRef) as Array<{ content: string }>
    expect(before[0].content).not.toContain('[S')

    fail = false
    s.flushToLoop()
    expect(msg.seq).toBe(100)
    expect(inserted).toHaveLength(1)

    // flushToLoop replaced the messages array so the cache re-converts.
    const secondRef = s.getMessages()
    expect(secondRef).not.toBe(firstRef)
    const after = convertMessages(secondRef) as Array<{ content: string }>
    expect(after[0].content).toContain('[S100]')
  })
})
