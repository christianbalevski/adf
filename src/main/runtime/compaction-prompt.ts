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
export const COMPACTION_FOOTER = `\n\n---\nYour loop was compacted. Continue operating according to your instructions. Reach out for help if needed.`
