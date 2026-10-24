/**
 * The ask form in the loop: text, single-choice and multi-choice questions,
 * "Other…" text on every choice question, blank = skipped, and the answered
 * card read back from the stored tool result. The ask_request event carries
 * the form into the store; it leaves when the executor stops awaiting it.
 *
 * No jsdom here: drafts are tested through draftAnswer, components as static markup.
 */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import { AskAnswers, AskCard, AskForm, draftAnswer, type AskDraft } from '../../../src/renderer/components/agent/AskForm'
import { useAgentStore } from '../../../src/renderer/stores/agent.store'
import { createAgentEventHandler } from '../../../src/renderer/hooks/useAgent'
import { formatAskAnswers, parseAskResult, type AskQuestion } from '../../../src/shared/utils/ask-form'
import type { AgentExecutionEvent } from '../../../src/shared/types/ipc.types'

// Vitest compiles JSX with the classic runtime (the renderer build uses the automatic one).
;(globalThis as { React?: typeof React }).React = React

const TEXT: AskQuestion = { question: 'Anything else?' }
const ONE: AskQuestion = { question: 'Which folder?', options: [{ label: 'docs', description: 'The docs tree' }, { label: 'src' }] }
const MANY: AskQuestion = { question: 'Which checks?', options: [{ label: 'lint' }, { label: 'test' }, { label: 'build' }], multiple: true }

const draft = (d: Partial<AskDraft>): AskDraft => ({ picks: [], other: '', otherPicked: false, ...d })

describe('ask form drafts', () => {
  it('a text question sends its trimmed text, blank is skipped', () => {
    expect(draftAnswer(TEXT, draft({ other: '  more  ' }))).toBe('more')
    expect(draftAnswer(TEXT, draft({ other: '   ' }))).toBeNull()
    expect(draftAnswer(TEXT, draft({}))).toBeNull()
  })

  it('single choice: the pick, or the Other text when Other is picked', () => {
    expect(draftAnswer(ONE, draft({ picks: ['src'] }))).toBe('src')
    expect(draftAnswer(ONE, draft({ other: 'scripts', otherPicked: true }))).toBe('scripts')
    // Other text without Other picked is not sent; Other picked but blank is nothing entered.
    expect(draftAnswer(ONE, draft({ picks: ['docs'], other: 'scripts' }))).toBe('docs')
    expect(draftAnswer(ONE, draft({ otherPicked: true }))).toBeNull()
    expect(draftAnswer(ONE, draft({}))).toBeNull()
  })

  it('multiple choice: the picks, plus the Other text while Other is ticked', () => {
    expect(draftAnswer(MANY, draft({ picks: ['build'], other: 'e2e', otherPicked: true }))).toEqual(['build', 'e2e'])
    expect(draftAnswer(MANY, draft({ picks: ['build'], other: 'e2e' }))).toEqual(['build'])
    expect(draftAnswer(MANY, draft({}))).toBeNull()
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

  it('the free-text box is named by its question heading', () => {
    const id = /<textarea[^>]*aria-labelledby="([^"]+)"/.exec(html)?.[1]
    expect(id).toBeTruthy()
    expect(html).toContain(`id="${id}"`)
  })

  it('Submit and Skip all, no required fields', () => {
    expect(html).toContain('>Submit<')
    expect(html).toContain('>Skip all<')
    expect(html).not.toContain('required')
  })

  it('a single question is not numbered', () => {
    expect(renderToStaticMarkup(<AskForm questions={[TEXT]} onSubmit={() => null} />)).not.toContain('>1.<')
  })

  it('kept drafts come back: picks checked, text filled', () => {
    const kept = renderToStaticMarkup(
      <AskForm
        questions={[ONE, TEXT]}
        drafts={[draft({ picks: ['src'] }), draft({ other: 'half typed' })]}
        onSubmit={() => null}
      />
    )
    expect((kept.match(/checked=""/g) ?? []).length).toBe(1)
    expect(kept).toContain('half typed')
  })
})

describe('answered ask', () => {
  it('reads the stored result back, skipped questions show Skipped', () => {
    const qs = [ONE, MANY, TEXT]
    const result = formatAskAnswers(qs, ['other place', ['lint', 'e2e'], null])
    const html = renderToStaticMarkup(<AskAnswers questions={qs} answers={parseAskResult(qs, result)} />)
    expect(html).toContain('Other: other place')
    expect(html).toContain('lint, Other: e2e')
    expect(html).toContain('Skipped')
  })

  it('the card shows the form while answerable and the answers once answered', () => {
    const pending = renderToStaticMarkup(<AskCard questions={[ONE]} onSubmit={() => null} />)
    expect(pending).toContain('>Submit<')
    const answered = renderToStaticMarkup(<AskCard questions={[ONE]} result={formatAskAnswers([ONE], ['src'])} />)
    expect(answered).not.toContain('>Submit<')
    expect(answered).toContain('src')
  })
})

describe('ask events', () => {
  beforeEach(() => useAgentStore.getState().reset())
  const ev = (type: string, payload: Record<string, unknown>, loop?: string): AgentExecutionEvent =>
    ({ type, payload, timestamp: 1, ...(loop ? { loop } : {}) } as AgentExecutionEvent)

  it('ask_request stores the form; ask_response stores the result on the row', () => {
    const handle = createAgentEventHandler()
    const questions = [ONE, TEXT]
    handle(ev('tool_call_start', { name: 'ask', id: 'toolu_1', input: { questions } }))
    handle(ev('state_changed', { state: 'awaiting_ask' }))
    handle(ev('ask_request', { requestId: 'ask_1', question: 'Which folder? (+1 more)', questions }))
    const pending = [...useAgentStore.getState().pendingAsks.values()][0]
    expect(pending).toEqual({ requestId: 'ask_1', questions })
    // The executor leaves awaiting_ask before it reports the answer.
    handle(ev('state_changed', { state: 'tool_use' }))
    const result = formatAskAnswers(questions, ['docs', null])
    handle(ev('ask_response', { requestId: 'ask_1', questions, answers: ['docs', null], result }))
    expect(useAgentStore.getState().pendingAsks.size).toBe(0)
    const row = useAgentStore.getState().log.find((e) => e.metadata?.name === 'ask')
    expect(row?.metadata?.askAnswer).toBe(result)
  })

  it('entered answers are kept in the store with the pending ask', () => {
    const handle = createAgentEventHandler()
    handle(ev('ask_request', { requestId: 'ask_1', questions: [TEXT] }))
    const [rowId] = [...useAgentStore.getState().pendingAsks.keys()]
    useAgentStore.getState().setAskDrafts(rowId, [draft({ other: 'half typed' })])
    expect(useAgentStore.getState().pendingAsks.get(rowId)?.drafts).toEqual([draft({ other: 'half typed' })])
  })

  it('a drained ask (stop, interrupt) sends no ask_response: leaving awaiting_ask unlocks the loop', () => {
    const handle = createAgentEventHandler()
    handle(ev('state_changed', { state: 'awaiting_ask' }, 'critic'))
    handle(ev('ask_request', { requestId: 'ask_1', questions: [TEXT] }, 'critic'))
    handle(ev('state_changed', { state: 'awaiting_ask' }))
    handle(ev('ask_request', { requestId: 'ask_2', questions: [TEXT] }))
    handle(ev('state_changed', { state: 'stopped' }, 'critic'))
    expect(useAgentStore.getState().sideLoops.critic.pendingAsks.size).toBe(0)
    // Another loop's ask is untouched.
    expect(useAgentStore.getState().pendingAsks.size).toBe(1)
    handle(ev('state_changed', { state: 'idle' }))
    expect(useAgentStore.getState().pendingAsks.size).toBe(0)
  })
})
