/**
 * The ask form in the loop: text, single-choice and multi-choice questions,
 * "Other…" text on every choice question, blank = skipped, and the answered
 * card read back from the stored tool result. The ask_request event carries
 * the form into the store; the composer no longer answers asks.
 *
 * No jsdom here: draft logic is tested as functions, components as static markup.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  AskAnswers,
  AskCard,
  AskForm,
  EMPTY_DRAFT,
  askDisplayAnswers,
  draftAnswer,
  pickOption,
  toggleOther,
  typeOther,
} from '../../../src/renderer/components/agent/AskForm'
import { useAgentStore } from '../../../src/renderer/stores/agent.store'
import { createAgentEventHandler } from '../../../src/renderer/hooks/useAgent'
import { formatAskAnswers, type AskQuestion } from '../../../src/shared/utils/ask-form'
import type { AgentExecutionEvent } from '../../../src/shared/types/ipc.types'

// Vitest compiles JSX with the classic runtime (the renderer build uses the automatic one).
;(globalThis as { React?: typeof React }).React = React

const TEXT: AskQuestion = { question: 'Anything else?' }
const ONE: AskQuestion = { question: 'Which folder?', options: [{ label: 'docs', description: 'The docs tree' }, { label: 'src' }] }
const MANY: AskQuestion = { question: 'Which checks?', options: [{ label: 'lint' }, { label: 'test' }, { label: 'build' }], multiple: true }

describe('ask form drafts', () => {
  it('a text question sends its trimmed text, blank is skipped', () => {
    expect(draftAnswer(TEXT, typeOther(TEXT, EMPTY_DRAFT, '  more  '))).toBe('more')
    expect(draftAnswer(TEXT, typeOther(TEXT, EMPTY_DRAFT, '   '))).toBeNull()
    expect(draftAnswer(TEXT, EMPTY_DRAFT)).toBeNull()
  })

  it('single choice: one pick; Other replaces the pick and a pick replaces Other', () => {
    let d = pickOption(ONE, EMPTY_DRAFT, 'docs')
    d = pickOption(ONE, d, 'src')
    expect(draftAnswer(ONE, d)).toBe('src')
    d = typeOther(ONE, d, 'scripts')
    expect(d.otherPicked).toBe(true)
    expect(draftAnswer(ONE, d)).toBe('scripts')
    d = pickOption(ONE, d, 'docs')
    expect(draftAnswer(ONE, d)).toBe('docs')
    // Re-picking Other brings its text back; Other picked but blank is nothing entered.
    expect(draftAnswer(ONE, toggleOther(ONE, d))).toBe('scripts')
    expect(draftAnswer(ONE, toggleOther(ONE, pickOption(ONE, EMPTY_DRAFT, 'docs')))).toBeNull()
  })

  it('multiple choice: picks toggle, typing Other adds it, unticking Other drops it', () => {
    let d = pickOption(MANY, EMPTY_DRAFT, 'lint')
    d = pickOption(MANY, d, 'build')
    d = pickOption(MANY, d, 'lint')
    expect(draftAnswer(MANY, d)).toEqual(['build'])
    d = typeOther(MANY, d, 'e2e')
    expect(draftAnswer(MANY, d)).toEqual(['build', 'e2e'])
    expect(draftAnswer(MANY, toggleOther(MANY, d))).toEqual(['build'])
    expect(draftAnswer(MANY, EMPTY_DRAFT)).toBeNull()
  })
})

describe('AskForm markup', () => {
  const html = renderToStaticMarkup(<AskForm questions={[ONE, MANY, TEXT]} onSubmit={() => null} />)

  it('numbers questions, uses radios for one pick and checkboxes for several', () => {
    expect(html).toContain('>1.<')
    expect(html).toContain('>3.<')
    expect((html.match(/type="radio"/g) ?? []).length).toBe(3) // docs, src, Other
    expect((html.match(/type="checkbox"/g) ?? []).length).toBe(4) // lint, test, build, Other
    expect(html).toContain('The docs tree')
    expect(html).toContain('<textarea')
  })

  it('every choice question offers Other… with a labelled text box', () => {
    expect((html.match(/placeholder="Other…"/g) ?? []).length).toBe(2)
    expect(html).toContain('aria-label="Other answer 1"')
    expect(html).toContain('aria-label="Other answer 2"')
    expect(html).toContain('<fieldset')
  })

  it('Submit and Skip all, no required fields', () => {
    expect(html).toContain('>Submit<')
    expect(html).toContain('>Skip all<')
    expect(html).not.toContain('required')
  })

  it('a single question is not numbered', () => {
    expect(renderToStaticMarkup(<AskForm questions={[TEXT]} onSubmit={() => null} />)).not.toContain('>1.<')
  })
})

describe('answered ask', () => {
  it('reads the stored result back, skipped questions show Skipped', () => {
    const qs = [ONE, MANY, TEXT]
    const result = formatAskAnswers(qs, ['other place', ['lint', 'e2e'], null])
    expect(askDisplayAnswers(qs, result)).toEqual(['Other: other place', 'lint, Other: e2e', null])
    const html = renderToStaticMarkup(<AskAnswers questions={qs} answers={askDisplayAnswers(qs, result)} />)
    expect(html).toContain('Other: other place')
    expect(html).toContain('Skipped')
  })

  it('reads the old results: Human answered, and a raw kept answer', () => {
    expect(askDisplayAnswers([TEXT], 'Human answered: yes')).toEqual(['yes'])
    expect(askDisplayAnswers([TEXT], 'Human answered: [skipped]')).toEqual([null])
    expect(askDisplayAnswers([TEXT], 'yes')).toEqual(['yes'])
  })

  it('the card shows the form while pending and the answers once answered', () => {
    const pending = renderToStaticMarkup(<AskCard questions={[ONE]} pending onSubmit={() => null} />)
    expect(pending).toContain('>Submit<')
    const answered = renderToStaticMarkup(<AskCard questions={[ONE]} pending={false} result={formatAskAnswers([ONE], ['src'])} />)
    expect(answered).not.toContain('>Submit<')
    expect(answered).toContain('src')
  })
})

describe('ask events', () => {
  beforeEach(() => useAgentStore.getState().reset())
  const ev = (type: string, payload: Record<string, unknown>): AgentExecutionEvent => ({ type, payload, timestamp: 1 } as AgentExecutionEvent)

  it('ask_request stores the form; ask_response stores the result on the row', () => {
    const handle = createAgentEventHandler()
    const questions = [ONE, TEXT]
    handle(ev('tool_call_start', { name: 'ask', id: 'toolu_1', input: { questions } }))
    handle(ev('ask_request', { requestId: 'ask_1', question: 'Which folder? (+1 more)', questions }))
    const pending = [...useAgentStore.getState().pendingAsks.values()][0]
    expect(pending).toEqual({ requestId: 'ask_1', question: 'Which folder? (+1 more)', questions })
    const result = formatAskAnswers(questions, ['docs', null])
    handle(ev('ask_response', { requestId: 'ask_1', questions, answers: ['docs', null], result }))
    expect(useAgentStore.getState().pendingAsks.size).toBe(0)
    const row = useAgentStore.getState().log.find((e) => e.metadata?.name === 'ask')
    expect(row?.metadata?.askAnswer).toBe(result)
  })

  it('an ask_request from an older runtime (question only) is one text question', () => {
    const handle = createAgentEventHandler()
    handle(ev('ask_request', { requestId: 'ask_1', question: 'Proceed?' }))
    const pending = [...useAgentStore.getState().pendingAsks.values()][0]
    expect(pending.questions).toEqual([{ question: 'Proceed?' }])
  })
})

describe('composer', () => {
  it('no longer answers asks: it is locked while one is pending', () => {
    const src = readFileSync(join(__dirname, '../../../src/renderer/components/agent/AgentLoop.tsx'), 'utf-8')
    expect(src).not.toContain('activeAsk')
    expect(src).not.toContain("'[skipped]'")
    expect(src).toContain("'Answer the questions above'")
  })
})
