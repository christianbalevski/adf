import { describe, it, expect } from 'vitest'
import { detectTriggerType, formatTurnErrorRow, parseLoopToDisplay, parseLoopWithToolPairs, parseTurnErrorRow, providerContextCategory } from '../../../src/shared/utils/loop-parser'
import { persistedErrorDetails } from '../../../src/main/runtime/agent-executor'
import type { LoopEntry } from '../../../src/shared/types/adf-v02.types'

const IMG_URL = 'data:image/png;base64,aGVsbG8='

function userEntry(blocks: LoopEntry['content_json'], seq = 1): LoopEntry {
  return { seq, role: 'user', content_json: blocks, created_at: 1000 }
}

describe('loop-parser file references', () => {
  const ref = (path: string, deleted?: true) => ({ type: 'file_ref' as const, file_ref: { path, mime_type: 'image/png', size: 4, ...(deleted ? { deleted } : {}) } })

  it('shows references as attachments (chips), a deleted one marked deleted', () => {
    for (const parse of [parseLoopToDisplay, parseLoopWithToolPairs]) {
      const [entry] = parse([userEntry([{ type: 'text', text: 'two files' }, ref('pics/a b.png'), ref('pics/gone.png', true)])])
      expect(entry.content).toBe('two files')
      expect(entry.metadata?.imagePreviewUrls).toBeUndefined()
      expect(entry.metadata?.attachments).toEqual([
        { path: 'pics/a b.png', name: 'a b.png', mime_type: 'image/png', kind: 'image' },
        { path: 'pics/gone.png', name: 'gone.png', mime_type: 'image/png', kind: 'image', deleted: true },
      ])
    }
  })

  it('a message of attachments alone is still a user entry', () => {
    const display = parseLoopToDisplay([userEntry([ref('a.png')])])
    expect(display).toEqual([expect.objectContaining({ type: 'user', content: '', metadata: expect.objectContaining({ attachments: [expect.objectContaining({ path: 'a.png' })] }) })])
  })

  it('a tool result whose image was deleted has no preview, and says so', () => {
    const entries: LoopEntry[] = [
      { seq: 1, role: 'assistant', content_json: [{ type: 'tool_use', id: 't1', name: 'fs_read', input: { path: 'a.png' } }], created_at: 1 },
      userEntry([{ type: 'tool_result', tool_use_id: 't1', content: '{"path":"a.png","content":"[image: a.png (image/png)]"}' }, ref('a.png', true)], 2),
    ]
    const result = parseLoopToDisplay(entries).find(e => e.type === 'tool_result')!
    expect(result.metadata?.imageUrl).toBeUndefined()
    expect(result.metadata?.attachments).toEqual([expect.objectContaining({ path: 'a.png', deleted: true })])
  })
})

describe('loop-parser media restore', () => {
  it('carries image_url blocks through to user entry metadata', () => {
    const entries = [
      userEntry([
        { type: 'text', text: 'Please review the attached media.' },
        { type: 'image_url', image_url: { url: IMG_URL } }
      ])
    ]

    for (const parse of [parseLoopToDisplay, parseLoopWithToolPairs]) {
      const display = parse(entries)
      expect(display).toHaveLength(1)
      expect(display[0].type).toBe('user')
      expect(display[0].content).toBe('Please review the attached media.')
      expect(display[0].metadata?.imagePreviewUrls).toEqual([IMG_URL])
    }
  })

  it('collects multiple images alongside a typed message', () => {
    const entries = [
      userEntry([
        { type: 'text', text: 'compare these' },
        { type: 'image_url', image_url: { url: IMG_URL } },
        { type: 'image_url', image_url: { url: `${IMG_URL}2` } }
      ])
    ]
    const display = parseLoopToDisplay(entries)
    expect(display[0].metadata?.imagePreviewUrls).toEqual([IMG_URL, `${IMG_URL}2`])
  })

  it('omits imagePreviewUrls when there are no media blocks', () => {
    const display = parseLoopToDisplay([userEntry([{ type: 'text', text: 'hi' }])])
    expect(display[0].metadata).not.toHaveProperty('imagePreviewUrls')
  })

  it('does not attach media metadata to trigger entries', () => {
    const display = parseLoopToDisplay([
      userEntry([
        { type: 'text', text: 'Go.' },
        { type: 'image_url', image_url: { url: IMG_URL } }
      ])
    ])
    expect(display[0].type).toBe('trigger')
    expect(display[0].metadata).not.toHaveProperty('imagePreviewUrls')
  })
})

describe('loop-parser turn error marker', () => {
  it('reads a persisted turn error back as an error display entry in both parsers', () => {
    const entries = [userEntry([{ type: 'text', text: '[Turn error] 400 Bad Request: model not supported' }], 7)]
    for (const parse of [parseLoopToDisplay, parseLoopWithToolPairs]) {
      const out = parse(entries)
      expect(out).toHaveLength(1)
      expect(out[0].type).toBe('error')
      expect(out[0].content).toBe('400 Bad Request: model not supported')
      expect(out[0].metadata?.seq).toBe(7)
    }
  })

  it('does not treat ordinary user text as a turn error', () => {
    const out = parseLoopToDisplay([userEntry([{ type: 'text', text: 'Turn error handling looks fine' }])])
    expect(out[0].type).toBe('user')
  })

  it('keeps the error details across a reload', () => {
    const details = JSON.stringify({ statusCode: 400, responseBody: '{"error":"bad"}' }, null, 2)
    const text = formatTurnErrorRow('400 Bad Request', details)
    for (const parse of [parseLoopToDisplay, parseLoopWithToolPairs]) {
      const out = parse([userEntry([{ type: 'text', text }], 9)])
      expect(out[0].type).toBe('error')
      expect(out[0].content).toBe('400 Bad Request')
      expect(out[0].metadata?.details).toBe(details)
    }
    expect(parseTurnErrorRow(formatTurnErrorRow('no details'))).toEqual({ message: 'no details' })
    expect(parseTurnErrorRow('plain text')).toBeNull()
  })
})

describe('persisted error details', () => {
  it('keeps status, code and a bounded body, and nothing else', () => {
    const error = Object.assign(new Error('boom'), { statusCode: 529, code: 'overloaded', responseBody: 'x'.repeat(5000), responseHeaders: { a: 'b' } })
    const parsed = JSON.parse(persistedErrorDetails(error)!)
    expect(parsed.statusCode).toBe(529)
    expect(parsed.code).toBe('overloaded')
    expect(parsed.responseBody.length).toBeLessThanOrEqual(1501)
    expect(parsed.responseHeaders).toBeUndefined()
    expect(parsed.stack).toBeUndefined()
    expect(persistedErrorDetails(new Error('plain'))).toBeUndefined()
    expect(persistedErrorDetails('string error')).toBeUndefined()
  })
})

describe('loop-parser runtime notices', () => {
  // Every user-role row the runtime writes reaches the model, so every one is
  // shown — as a runtime notice, not as the owner's words.
  it.each([
    '[Continue working autonomously according to your instructions. Control your state with sys_set_state().]',
    '[You have responded 2 times in a row without calling any tools. Do not reply with another status update.]',
    'Context is about to be compacted. Before that happens: write any durable learnings…',
    '[System] You ended the turn without replying to your principal.',
    '[System notice: the previous agent turn t1 (timer) was interrupted before clean completion.]',
    '[Provider error ("503") — auto-recovery retry 1/3, ~1m since the first failure.]',
    '[Provider unavailable ("503"). Gave up.]',
    '[Turn error ("bad") — structural recovery retry 1/3.]',
  ])('shows %s as a runtime notice', (text) => {
    for (const parse of [parseLoopToDisplay, parseLoopWithToolPairs]) {
      const display = parse([userEntry([{ type: 'text', text }], 7)])
      expect(display).toHaveLength(1)
      expect(display[0]).toMatchObject({ type: 'context', content: text, metadata: { seq: 7, category: 'runtime' } })
    }
  })

  it('leaves an owner message alone', () => {
    const display = parseLoopToDisplay([userEntry([{ type: 'text', text: 'What is the System status?' }])])
    expect(display[0].type).toBe('user')
  })
})

describe('loop-parser injected context', () => {
  const parseOne = (text: string) => {
    const results = [parseLoopToDisplay, parseLoopWithToolPairs].map(parse => parse([userEntry([{ type: 'text', text }], 3)]))
    expect(results[0]).toEqual(results[1])
    return results[0][0]
  }

  it('reads an owner-only notice as status, old marker and new', () => {
    for (const marker of ['[Context: status]', '[Context: System]']) {
      expect(parseOne(`${marker} [System] Not sent to this model: 1 image.`)).toMatchObject({
        type: 'context', content: '[System] Not sent to this model: 1 image.', metadata: { category: 'status' },
      })
    }
  })

  it('names the provider that added context, when the row says', () => {
    expect(parseOne(`[Context: ${providerContextCategory('Claude Code')}] Today is Tuesday.`)).toMatchObject({
      content: 'Today is Tuesday.', metadata: { category: 'provider_context', addedBy: 'Claude Code' },
    })
    expect(parseOne('[Context: provider_context] Today is Tuesday.').metadata).toEqual({ seq: 3, category: 'provider_context' })
  })

  it('reads loop_inject rows with their category and origin', () => {
    expect(parseOne('[Context: notes | loop_inject=v2 | origin=lambda:watch.ts | key=k1] remember this')).toMatchObject({
      content: 'remember this', metadata: { category: 'injected', injectCategory: 'notes', origin: 'lambda:watch.ts' },
    })
  })

  it('keeps the instruction categories', () => {
    expect(parseOne('[Context: system_prompt] You are an agent.').metadata?.category).toBe('system_prompt')
    expect(parseOne('[Context: dynamic_instructions] 2 unread.').metadata?.category).toBe('dynamic_instructions')
  })
})

describe('loop-parser wake reasons', () => {
  it.each([
    ['Agent started. Review your mind for context and take any startup actions.', 'startup'],
    ['A tool call has been intercepted.\nTool: fs_write', 'tool_call'],
    ['A tool call was intercepted.\nTool: fs_write', 'tool_call'],
    ['A task has been created.\nTask ID: t1', 'task_create'],
    ['A log entry has been recorded.\nLevel: warn', 'log_entry'],
    ['An LLM call completed.\nProvider: x', 'llm_call'],
    ['A batch of 3 events fired: timer, inbox. Check your inbox/tasks for details.', 'batch'],
    ['A scheduled timer has fired.\nPayload: tick', 'timer'],
    ['[Inbox notification] New messages.', 'inbox'],
  ])('reads %j as a %s wake', (text, triggerType) => {
    expect(detectTriggerType(text)).toBe(triggerType)
    expect(parseLoopToDisplay([userEntry([{ type: 'text', text }])])[0]).toMatchObject({ type: 'trigger', metadata: { triggerType } })
  })
})
