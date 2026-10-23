import { describe, expect, it } from 'vitest'
import {
  ASK_ALL_SKIPPED,
  AskAnswerError,
  askQuestions,
  formatAskAnswers,
  normalizeAskAnswers,
  parseAskResult,
  summarizeAsk,
  type AskQuestion,
} from '../../src/shared/utils/ask-form'
import { AskInputSchema } from '../../src/main/tools/built-in/ask.tool'

const free: AskQuestion = { question: 'Anything I should avoid?' }
const single: AskQuestion = { question: 'Which database?', options: [{ label: 'Postgres', description: 'Needs a server' }, { label: 'SQLite' }] }
const multi: AskQuestion = { question: 'Which regions?', options: [{ label: 'eu-west' }, { label: 'us-east' }], multiple: true }

describe('AskInputSchema', () => {
  it('takes questions only: the pre-form { question } input is refused', () => {
    expect(AskInputSchema.safeParse({ questions: [free, single, multi] }).success).toBe(true)
    expect(AskInputSchema.safeParse({ question: 'Proceed?' }).success).toBe(false)
    expect(AskInputSchema.safeParse({ questions: [] }).success).toBe(false)
    expect(AskInputSchema.safeParse({ questions: [{ question: 'Q', options: [] }] }).success).toBe(false)
  })
})

describe('askQuestions', () => {
  it('reads a form, dropping empty options and a stray `multiple`', () => {
    expect(askQuestions({
      questions: [
        { question: 'A?', options: [] , multiple: true },
        { question: 'B?', options: ['x', '', { label: 'y', description: '' }, { label: 'z', description: 'zed' }, 7], multiple: true },
        { nope: true },
        'junk',
      ],
    })).toEqual([
      { question: 'A?' },
      { question: 'B?', options: [{ label: 'x' }, { label: 'y' }, { label: 'z', description: 'zed' }], multiple: true },
    ])
  })

  it('reads the pre-form { question } input so stored history keeps rendering', () => {
    expect(askQuestions({ question: 'Ship it?' })).toEqual([{ question: 'Ship it?' }])
    expect(askQuestions(null)).toEqual([])
    expect(askQuestions({})).toEqual([])
  })
})

describe('summarizeAsk', () => {
  it('is the first question, plus how many more', () => {
    expect(summarizeAsk([])).toBe('')
    expect(summarizeAsk([free])).toBe('Anything I should avoid?')
    expect(summarizeAsk([free, single, multi])).toBe('Anything I should avoid? (+2 more)')
  })
})

describe('normalizeAskAnswers', () => {
  it('needs an array with one entry per question', () => {
    expect(() => normalizeAskAnswers([free], 'yes')).toThrow(AskAnswerError)
    expect(() => normalizeAskAnswers([free, single], ['yes'])).toThrow('answers has 1 entries but the ask has 2 questions')
    expect(() => normalizeAskAnswers([free], [])).toThrow('the ask has 1 question')
  })

  it('trims text and turns empty answers into null (skipped)', () => {
    expect(normalizeAskAnswers([free, single, multi], ['  keep it small ', '   ', []])).toEqual(['keep it small', null, null])
    expect(normalizeAskAnswers([free, multi], [undefined, ['  ', '']])).toEqual([null, null])
  })

  it('single-pick questions take one value; multi-pick keep the array', () => {
    expect(normalizeAskAnswers([single], [['SQLite']])).toEqual(['SQLite'])
    expect(() => normalizeAskAnswers([single], [['Postgres', 'SQLite']])).toThrow('question 1 takes one pick, got 2')
    expect(normalizeAskAnswers([multi], [[' eu-west', 'us-east ']])).toEqual([['eu-west', 'us-east']])
    expect(normalizeAskAnswers([multi], ['eu-west'])).toEqual(['eu-west'])
  })

  it('free-text questions take one string, also when it comes wrapped in an array', () => {
    expect(normalizeAskAnswers([free], [['no secrets']])).toEqual(['no secrets'])
    expect(() => normalizeAskAnswers([free], [['a', 'b']])).toThrow('question 1 takes free text, not several picks')
  })

  it('refuses values that are not strings', () => {
    expect(() => normalizeAskAnswers([free], [42])).toThrow('answer 1 must be a string, an array of strings, or null')
    expect(() => normalizeAskAnswers([multi], [['eu-west', 3]])).toThrow(AskAnswerError)
    expect(() => normalizeAskAnswers([free], [{ text: 'x' }])).toThrow(AskAnswerError)
  })
})

describe('formatAskAnswers', () => {
  it('pairs questions and answers; free text beside options reads Other', () => {
    expect(formatAskAnswers([free, single, multi], ['keep it small', 'MySQL', ['eu-west', 'ap-south']])).toBe(
      'Q: Anything I should avoid?\nA: keep it small\n\n' +
      'Q: Which database?\nA: Other: MySQL\n\n' +
      'Q: Which regions?\nA: eu-west, Other: ap-south',
    )
  })

  it('marks skipped questions, and says so plainly when everything was skipped', () => {
    expect(formatAskAnswers([free, single], [null, 'SQLite'])).toBe('Q: Anything I should avoid?\nA: (skipped)\n\nQ: Which database?\nA: SQLite')
    expect(formatAskAnswers([free, single], [null, null])).toBe(ASK_ALL_SKIPPED)
  })
})

describe('parseAskResult', () => {
  it('round-trips formatAskAnswers, including answers that span lines', () => {
    const questions = [free, single, multi]
    const result = formatAskAnswers(questions, ['line one\n\nline two\nQ: not a question', null, ['eu-west', 'us-east']])
    expect(parseAskResult(questions, result)).toEqual(['line one\n\nline two\nQ: not a question', null, 'eu-west, us-east'])
  })

  it('reads the all-skipped sentence as every question skipped', () => {
    expect(parseAskResult([free, single], ASK_ALL_SKIPPED)).toEqual([null, null])
  })

  it('reads the pre-form `Human answered: X` result', () => {
    expect(parseAskResult([{ question: 'Ship it?' }], 'Human answered: yes, after lunch')).toEqual(['yes, after lunch'])
    expect(parseAskResult([{ question: 'Ship it?' }], 'Human answered: ')).toEqual([null])
    expect(parseAskResult([{ question: 'Ship it?' }], 'Human answered: [skipped]')).toEqual([null])
  })

  it('a question missing from the result reads as skipped', () => {
    expect(parseAskResult([free, single], 'Q: Which database?\nA: SQLite')).toEqual([null, 'SQLite'])
  })
})
