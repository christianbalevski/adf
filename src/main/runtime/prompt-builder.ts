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

  /**
   * A section whose configured text is blank is a section the owner deleted in
   * Settings. Trimming here (rather than testing truthiness) means whitespace
   * left behind by that edit does not survive as an empty `---` block.
   */
  const push = (text: string | undefined): void => {
    if (text?.trim()) parts.push(text)
  }

  // 1. Base prompt (always)
  push(ctx.basePrompt)

  // 2. Tool guidance — suppressed when the shell is enabled: the shell's own
  // guide travels in the adf_shell tool description (rides with the schema,
  // so a hidden shell costs zero context).
  if (!ctx.shellEnabled) {
    push(ctx.toolPrompts['tool_best_practices'])
  }

  // 3. Code execution — when sys_code or sys_lambda is enabled
  if (ctx.enabledTools.has('sys_code') || ctx.enabledTools.has('sys_lambda')) {
    push(ctx.toolPrompts['code_execution'])
  }

  // 4. Messaging collaboration — when messaging.receive is enabled
  if (ctx.config.messaging?.receive) {
    push(ctx.toolPrompts['_messaging'])
  }

  // 5. Database schema — when db_query or db_execute is enabled
  if (ctx.enabledTools.has('db_query') || ctx.enabledTools.has('db_execute')) {
    push(ctx.toolPrompts['database'])
  }

  // 6. HTTP serving — full guide when any serving feature is configured;
  // otherwise a short stub so the agent knows the capability exists.
  const serving = ctx.config.serving
  const servingConfigured = !!(serving?.public?.enabled || serving?.shared?.enabled || (serving?.api && serving.api.length > 0))
  push(ctx.toolPrompts[servingConfigured ? '_serving' : '_serving_stub'])

  // 7. Skills — always. The runtime indexes `skills/` for every agent and
  // materializes `skills-registry.json` at workspace open, so the section's
  // {{skills-registry.json}} placeholder always resolves, empty catalog or not.
  push(ctx.toolPrompts['_skills'])

  // 8. WebSocket connections — when one or more connections are configured
  if (ctx.config.ws_connections && ctx.config.ws_connections.length > 0) {
    push(ctx.toolPrompts['_websocket'])
  }

  // 9. State management — when sys_set_state is enabled. Lives inside the base
  // prompt so disabling include_base_prompt also drops this guidance.
  if (ctx.enabledTools.has('sys_set_state')) {
    push(ctx.toolPrompts['state_management'])
  }

  // 10. Visible browser lifecycle + authentication handoff. The handoff is an
  // agent behavior, not a bespoke Studio auth flow.
  if (ctx.config.compute?.enabled && ctx.config.compute.browser !== false) {
    push(ctx.toolPrompts['_browser'])
  }

  return parts.join('\n\n---\n\n')
}
