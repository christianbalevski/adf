/**
 * Compaction Prompt
 *
 * System prompt and user message template for LLM-powered loop compaction.
 * Used by AgentExecutor when processing a loop_compact tool call.
 *
 * The default system prompt is now editable via settings (DEFAULT_COMPACTION_PROMPT).
 * This module re-exports it for backward compatibility and provides the helper functions.
 */

import { DEFAULT_COMPACTION_PROMPT } from '../../shared/constants/adf-defaults'
import { sliceWellFormed } from '../../shared/utils/well-formed'

const COMPACTION_TRANSCRIPT_GAP = '\n\n[Middle of transcript omitted to fit the compaction input; beginning and recent history retained.]\n\n'
const MIN_EXCERPT_CHARACTERS = COMPACTION_TRANSCRIPT_GAP.length + 10
const COMPACTION_MESSAGE_OVERHEAD = 16
const MAX_FITTING_PASSES = 8

/**
 * Keep the initial mandate/previous briefing available alongside recent
 * evidence. A tail-only cut can erase that context before summarization.
 * This is a bounded excerpt, not a guarantee that every instruction survives.
 */
export function boundCompactionTranscript(transcript: string, maxChars: number): string {
  if (!Number.isFinite(maxChars) || maxChars < 0) throw new Error('Invalid compaction transcript character budget')
  maxChars = Math.floor(maxChars)
  if (transcript.length <= maxChars) return transcript
  if (maxChars < MIN_EXCERPT_CHARACTERS) throw new Error('Compaction input budget cannot retain an excerpt and omission marker')
  const retainedBudget = maxChars - COMPACTION_TRANSCRIPT_GAP.length
  const head = sliceWellFormed(transcript, 0, Math.floor(retainedBudget * 0.2))
  const tailBudget = retainedBudget - head.length
  const tail = sliceWellFormed(transcript, transcript.length - tailBudget)
  return head + COMPACTION_TRANSCRIPT_GAP + tail
}

export interface CompactionTranscriptBudget {
  /** Input allowance chosen by the caller, not a claim about model capacity. */
  maxInputTokens: number
  system: string
  entryCount: number
  instructions?: string
  countTokens: (text: string) => number
}

export interface FittedCompactionTranscript {
  transcript: string
  inputTokens: number
  /** Source UTF-16 code units omitted; excludes the inserted omission marker. */
  omittedCharacters: number
}

/**
 * Count the actual rendered request text, including framing and guidance,
 * before dropping any history. A bounded ratio search avoids repeatedly
 * tokenizing a large transcript during binary search. Every returned excerpt
 * is checked against the caller's token allowance; a failure leaves the
 * caller free to preserve history rather than compact from an empty briefing.
 */
export function fitCompactionTranscript(
  transcript: string,
  options: CompactionTranscriptBudget,
): FittedCompactionTranscript {
  const { maxInputTokens, system, entryCount, instructions, countTokens } = options
  if (!Number.isFinite(maxInputTokens) || maxInputTokens <= 0) throw new Error('Invalid compaction input token budget')
  const count = (text: string): number => {
    const tokens = countTokens(text)
    if (!Number.isFinite(tokens) || tokens < 0) throw new Error('Invalid compaction token count')
    return tokens
  }
  const fixedSystemTokens = count(system) + COMPACTION_MESSAGE_OVERHEAD
  const measure = (text: string): number => fixedSystemTokens + count(buildCompactionUserMessage(text, entryCount, instructions))
  let inputTokens = measure(transcript)
  if (inputTokens <= maxInputTokens) return { transcript, inputTokens, omittedCharacters: 0 }

  const framingTokens = measure('')
  if (framingTokens >= maxInputTokens) {
    throw new Error(`Compaction input budget (${maxInputTokens} tokens) cannot fit the system prompt, instructions and message framing (${framingTokens} tokens)`)
  }
  // A short transcript cannot be reduced using the explicit omission marker.
  if (transcript.length <= MIN_EXCERPT_CHARACTERS) {
    throw new Error('Compaction input budget cannot fit a nonempty transcript excerpt and omission marker')
  }

  let maxChars = transcript.length
  for (let pass = 0; pass < MAX_FITTING_PASSES; pass++) {
    const ratio = Math.min(0.9, (maxInputTokens - framingTokens) / Math.max(1, inputTokens - framingTokens) * 0.9)
    // The final pass tests a minimal nonempty excerpt. This also handles
    // highly uneven token density without an unbounded search.
    maxChars = pass === MAX_FITTING_PASSES - 1
      ? MIN_EXCERPT_CHARACTERS
      : Math.max(MIN_EXCERPT_CHARACTERS, Math.floor(maxChars * ratio))
    const excerpt = boundCompactionTranscript(transcript, maxChars)
    inputTokens = measure(excerpt)
    if (inputTokens <= maxInputTokens) {
      return {
        transcript: excerpt,
        inputTokens,
        omittedCharacters: transcript.length - (excerpt.length - COMPACTION_TRANSCRIPT_GAP.length),
      }
    }
    if (maxChars === MIN_EXCERPT_CHARACTERS) break
  }
  throw new Error(`Compaction input budget (${maxInputTokens} tokens) cannot fit a nonempty transcript excerpt and omission marker`)
}

/** @deprecated Use DEFAULT_COMPACTION_PROMPT from adf-defaults instead. */
export const COMPACTION_SYSTEM_PROMPT = DEFAULT_COMPACTION_PROMPT

/**
 * Build the user message that wraps the conversation transcript.
 */
export function buildCompactionUserMessage(transcript: string, entryCount: number, instructions?: string): string {
  let msg = `Here is a conversation transcript with ${entryCount} entries. Produce a concise briefing that captures all important context so the agent can continue working effectively after the conversation history is cleared.`

  if (instructions) {
    msg += `\n\nThe agent provided the following instructions for this compaction — pay special attention to these:\n<compaction_instructions>\n${instructions}\n</compaction_instructions>`
  }

  msg += `\n\n<transcript>\n${transcript}\n</transcript>`
  return msg
}

/**
 * Footer appended after the LLM-generated summary.
 */
export const COMPACTION_FOOTER = `\n\n---\nYour loop was compacted. The briefing above is what survived — including any open questions; they are still yours. Continue. Reach out for help if needed.`
