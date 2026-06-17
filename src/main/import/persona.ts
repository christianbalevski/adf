import type { ImportSeedFile } from './types'

export interface PersonaInput {
  /** Agent name, used only for the empty-persona fallback. */
  name: string
  /** SOUL.md body with front-matter already stripped. */
  soulBody: string
  /** Optional secondary rules block (e.g. OpenClaw AGENTS.md). */
  rules?: { label: string; body: string }
  /**
   * When true, flatten persona text straight into `instructions` (self-contained).
   * When false (default), write the persona as editable `imported/*.md` files and
   * reference them with `{{path}}` injection — faithful to runtimes (like
   * OpenClaw) that treat SOUL.md as a live file injected every session.
   */
  inline: boolean
}

export interface PersonaOutput {
  instructions: string
  files: ImportSeedFile[]
  warnings: string[]
}

/**
 * Build the agent's `instructions` (and any backing persona files) from a
 * SOUL.md body plus optional rules block.
 */
export function buildPersona(input: PersonaInput): PersonaOutput {
  const files: ImportSeedFile[] = []
  const soul = input.soulBody.trim()
  const rules = input.rules && input.rules.body.trim() !== ''
    ? { label: input.rules.label, body: input.rules.body.trim() }
    : undefined

  if (soul === '') {
    return {
      instructions: `You are ${input.name}, an imported agent.`,
      files,
      warnings: ['No persona body found; generated a placeholder system prompt.'],
    }
  }

  if (input.inline) {
    let instructions = soul
    if (rules) instructions += `\n\n## ${rules.label}\n\n${rules.body}`
    return { instructions, files, warnings: [] }
  }

  // File-injection mode: persona stays an editable artifact referenced via {{path}}.
  files.push({ path: 'imported/SOUL.md', content: soul })
  let instructions = '{{imported/SOUL.md}}'
  if (rules) {
    files.push({ path: 'imported/AGENTS.md', content: rules.body })
    instructions += `\n\n## ${rules.label}\n\n{{imported/AGENTS.md}}`
  }
  return { instructions, files, warnings: [] }
}
