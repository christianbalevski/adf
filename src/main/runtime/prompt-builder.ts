/**
 * Dynamic system prompt assembly.
 *
 * Combines a base prompt with conditional tool/feature sections
 * based on the agent's enabled tools and configuration.
 */

import type { AgentConfig } from '@shared/types/adf-v02.types'

export interface PromptContext {
  config: AgentConfig
  basePrompt: string
  toolPrompts: Record<string, string>
  enabledTools: Set<string>
  shellEnabled: boolean
}

/**
 * Assemble the global system prompt from base + conditional sections.
 * Pure function — deterministic given the same inputs.
 */
export function assemblePrompt(ctx: PromptContext): string {
  const parts: string[] = []

  // 1. Base prompt (always)
  if (ctx.basePrompt) {
    parts.push(ctx.basePrompt)
  }

  // 2. Tool guidance — shell guide OR individual tool best practices
  if (ctx.shellEnabled) {
    const shellPrompt = ctx.toolPrompts['adf_shell']
    if (shellPrompt) parts.push(shellPrompt)
  } else {
    const bestPractices = ctx.toolPrompts['tool_best_practices']
    if (bestPractices) parts.push(bestPractices)
  }

  // 3. Code execution — when sys_code or sys_lambda is enabled
  if (ctx.enabledTools.has('sys_code') || ctx.enabledTools.has('sys_lambda')) {
    const codePrompt = ctx.toolPrompts['code_execution']
    if (codePrompt) parts.push(codePrompt)
  }

  // 4. Messaging collaboration — when messaging.receive is enabled
  if (ctx.config.messaging?.receive) {
    const msgPrompt = ctx.toolPrompts['_messaging']
    if (msgPrompt) parts.push(msgPrompt)
  }

  // 5. Database schema — when db_query or db_execute is enabled
  if (ctx.enabledTools.has('db_query') || ctx.enabledTools.has('db_execute')) {
    const dbPrompt = ctx.toolPrompts['database']
    if (dbPrompt) parts.push(dbPrompt)
  }

  // 6. HTTP serving — when any serving feature is configured
  const serving = ctx.config.serving
  if (serving && (serving.public || serving.shared || (serving.api && serving.api.length > 0))) {
    const servingPrompt = ctx.toolPrompts['_serving']
    if (servingPrompt) parts.push(servingPrompt)
  }

  return parts.join('\n\n---\n\n')
}
