/**
 * The `/` command palette in the Studio composer (design doc §5).
 *
 * Everything here is I/O-free: the composer owns the textarea, the IPC and the
 * send path, this module owns the decisions — what the palette lists, what a
 * typed line resolves to, and what text a skill command turns into.
 *
 * The split the design insists on is structural, not cosmetic:
 *
 *   BUILT-INS  run a Studio/runtime action directly. No model turn.
 *   SKILLS     never execute anything. They compose an ordinary user message
 *              and hand it to the normal send path; the agent then follows its
 *              standing read-the-SKILL.md instruction.
 *
 * Skill names, descriptions and `agents/openai.yaml` text are untrusted data
 * (they arrive from a remote catalog or from the agent's own filesystem). They
 * are parsed, sanitized and pasted into a *message* — never evaluated, never
 * turned into an action.
 */

import { sanitizeDisplayText, type RegistryEntry } from './skills-panel'

export type SlashCommandKind = 'builtin' | 'skill'

/**
 * One row in the palette.
 *
 * `key` is what the typed line has to start with (space-separated words, no
 * leading slash); `label` is what the row shows, which may carry an argument
 * placeholder the key does not have.
 */
export interface SlashCommand {
  key: string
  label: string
  kind: SlashCommandKind
  description: string
  /** Skill rows only: muted in skills-state.json, so it has no description. */
  muted?: boolean
  /** Skill rows only: the package name, which is also the first key word. */
  skill?: string
}

/** Every built-in action, in palette order. Descriptions are ours, not data. */
export const BUILTIN_COMMANDS: readonly SlashCommand[] = [
  {
    key: 'compact',
    label: '/compact',
    kind: 'builtin',
    description: 'Compact the conversation now — summarize history and free context.'
  },
  {
    key: 'clear',
    label: '/clear',
    kind: 'builtin',
    description: 'Clear the conversation loop and start fresh.'
  },
  {
    key: 'skills',
    label: '/skills',
    kind: 'builtin',
    description: 'Open the Skills panel.'
  },
  {
    key: 'skills disable',
    label: '/skills disable <name>',
    kind: 'builtin',
    description: 'Mute a skill — writes skills-state.json, no config change.'
  },
  {
    key: 'skills enable',
    label: '/skills enable <name>',
    kind: 'builtin',
    description: 'Unmute a skill — writes skills-state.json, no config change.'
  }
]

/** Cheap guard so a pasted document never runs through the palette. */
const MAX_COMMAND_LINE = 4096

/**
 * Is the composer holding a command line?
 *
 * Only a single line that starts with `/` counts. The moment a newline appears
 * the text is prose the human is writing, not a command being typed, and the
 * palette gets out of the way.
 */
export function isSlashInput(text: string): boolean {
  return text.startsWith('/') && !text.includes('\n') && text.length <= MAX_COMMAND_LINE
}

/** The words after the slash, collapsed — the palette's filter query. */
export function slashQuery(text: string): string {
  return text.slice(1).replace(/\s+/g, ' ').trimStart()
}

export interface SlashMatch {
  command: SlashCommand
  /** Everything the user typed after the command words. May be empty. */
  args: string
}

/**
 * Resolve a typed line against the command list.
 *
 * Longest key first, so `/skills disable foo` is the two-word built-in with
 * argument `foo` rather than `/skills` with a stray argument. Ties keep list
 * order, which puts built-ins ahead of a skill package that happens to share a
 * name with one.
 *
 * Returns null for anything that does not match — the composer then sends the
 * line as a literal message rather than swallowing it.
 */
export function matchSlashCommand(
  text: string,
  commands: readonly SlashCommand[]
): SlashMatch | null {
  if (!isSlashInput(text)) return null
  const typed = slashQuery(text)
  if (!typed) return null
  const words = typed.split(' ')
  const ranked = commands
    .map((command, index) => ({ command, index, words: command.key.split(' ') }))
    .sort((a, b) => b.words.length - a.words.length || a.index - b.index)
  for (const candidate of ranked) {
    if (candidate.words.length > words.length) continue
    if (candidate.words.some((word, i) => word !== words[i])) continue
    return { command: candidate.command, args: words.slice(candidate.words.length).join(' ').trim() }
  }
  return null
}

/**
 * The palette's rows for a given catalog: the built-ins, then one command per
 * indexed skill. Muted skills stay listed — invoking one only composes text,
 * and hiding them would make the palette disagree with the Skills panel.
 *
 * Names are sanitized before they become labels; a name that sanitizes to
 * something other than itself cannot be typed reliably and is dropped.
 */
export function buildSlashCommands(entries: readonly RegistryEntry[]): SlashCommand[] {
  const commands: SlashCommand[] = [...BUILTIN_COMMANDS]
  const seen = new Set(BUILTIN_COMMANDS.map((c) => c.key));
  [...entries]
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((entry) => {
      const name = sanitizeDisplayText(entry.name)
      if (!name || name !== entry.name || name.includes(' ') || seen.has(name)) return
      seen.add(name)
      commands.push({
        key: name,
        label: `/${name}`,
        kind: 'skill',
        description: entry.enabled
          ? sanitizeDisplayText(entry.description) || 'no description'
          : 'muted — no description in the catalog',
        muted: !entry.enabled,
        skill: name
      })
    })
  return commands
}

/**
 * Rank the palette against what has been typed so far.
 *
 * Four tiers, so the row the line actually resolves to is the row Enter acts
 * on: fully typed, then still being typed, then a key substring, then a
 * description substring. Only the command words are matched — a trailing
 * argument must not make the row it belongs to disappear.
 *
 * Inside the top tier the LONGEST key wins, which is the same rule
 * `matchSlashCommand` uses: with `/skills disable foo` typed, both `/skills`
 * and `/skills disable` are fully typed, and the palette must highlight the one
 * that will run. Every other tier keeps the list's own order, which puts
 * built-ins above skills and skills in alphabetical order.
 */
export function filterSlashCommands(
  commands: readonly SlashCommand[],
  query: string
): SlashCommand[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...commands]
  const scored: { command: SlashCommand; score: number; tie: number; index: number }[] = []
  commands.forEach((command, index) => {
    const key = command.key.toLowerCase()
    if (needle === key || needle.startsWith(key + ' ')) {
      scored.push({ command, score: 0, tie: -key.length, index })
    } else if (key.startsWith(needle)) {
      scored.push({ command, score: 1, tie: 0, index })
    } else if (key.includes(needle)) {
      scored.push({ command, score: 2, tie: 0, index })
    } else if (command.description.toLowerCase().includes(needle)) {
      scored.push({ command, score: 3, tie: 0, index })
    }
  })
  return scored
    .sort((a, b) => a.score - b.score || a.tie - b.tie || a.index - b.index)
    .map((row) => row.command)
}

/** Does this row still need an argument the user has not typed? */
export function needsArgument(command: SlashCommand, args: string): boolean {
  return command.label.includes('<') && args.trim().length === 0
}

/** The text that completing a row puts in the composer, ready for arguments. */
export function completionText(command: SlashCommand): string {
  return `/${command.key} `
}

// --- agents/openai.yaml -----------------------------------------------------

export interface SkillInterface {
  display_name?: string
  short_description?: string
  default_prompt?: string
}

/** No YAML dependency ships in this app, and one is not worth adding for this. */
const MAX_YAML_BYTES = 16 * 1024

/**
 * Read `interface:` out of a skill's `agents/openai.yaml`.
 *
 * A deliberately tiny subset — a two-level mapping of plain or quoted scalars —
 * because that is the whole of the convention (see
 * `skills/adf-skill-creator/agents/openai.yaml`). Anything richer, anything
 * this parser is not certain about (block scalars, nested structures, lists),
 * and anything oversized reads as absent, and the caller falls back to the
 * generic message. Guessing at a document we cannot parse would put text the
 * author never wrote into a message sent as the human.
 */
export function parseSkillInterface(text: string | null | undefined): SkillInterface | null {
  if (!text || text.length > MAX_YAML_BYTES) return null
  const result: SkillInterface = {}
  let inInterface = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\t/g, '  ')
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    if (indent === 0) {
      inInterface = /^interface\s*:\s*(#.*)?$/.test(line)
      continue
    }
    if (!inInterface) continue
    const entry = /^\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line)
    if (!entry) continue
    const [, key, rest] = entry
    if (key !== 'display_name' && key !== 'short_description' && key !== 'default_prompt') continue
    const value = parseScalar(rest)
    if (value !== null) result[key] = value
  }
  return Object.keys(result).length > 0 ? result : null
}

/** One scalar: `"quoted"`, `'quoted'`, or plain text up to a trailing comment. */
function parseScalar(rest: string): string | null {
  const value = rest.trim()
  if (!value || value === '|' || value === '>' || value.startsWith('|') || value.startsWith('>')) return null
  const quoted = /^"((?:[^"\\]|\\.)*)"|^'((?:[^']|'')*)'/.exec(value)
  if (quoted) {
    const text = quoted[1] !== undefined
      ? quoted[1].replace(/\\(["\\/nrt])/g, (_, ch: string) =>
          ch === 'n' ? '\n' : ch === 'r' ? '\r' : ch === 't' ? '\t' : ch)
      : (quoted[2] ?? '').replace(/''/g, "'")
    return sanitizeDisplayText(text) || null
  }
  if (value.startsWith('{') || value.startsWith('[') || value.startsWith('&') || value.startsWith('*')) return null
  return sanitizeDisplayText(value.replace(/\s+#.*$/, '')) || null
}

// --- message composition ----------------------------------------------------

/** Fallback wording when a package publishes no usable `default_prompt`. */
export function fallbackSkillMessage(name: string, args: string): string {
  const task = args.trim()
  return task ? `Use the ${name} skill for: ${task}` : `Use the ${name} skill.`
}

/**
 * The user message a skill command sends.
 *
 * `default_prompt` reads as an instruction to the model with a `$<skill-name>`
 * token standing for the package ("Use $adf-skill-creator to create a portable
 * skill for an ADF agent."). The token expands to a plain reference, and typed
 * arguments replace the template's trailing task clause — the text after the
 * first ` to ` that follows the token, which is the shape the convention uses.
 *
 * A template we cannot splice arguments into falls back to the generic wording
 * rather than emitting a sentence that contradicts what the human typed.
 */
export function composeSkillMessage(
  name: string,
  skillInterface: SkillInterface | null | undefined,
  args: string
): string {
  const task = args.trim()
  const template = sanitizeDisplayText(skillInterface?.default_prompt)
  if (!template) return fallbackSkillMessage(name, task)

  const token = `$${name}`
  const tokenAt = template.indexOf(token)
  const expanded = tokenAt >= 0
    ? template.split(token).join(`the ${name} skill`)
    : template
  if (!task) return expanded

  // Splice the typed task in place of the template's own.
  const from = tokenAt >= 0 ? tokenAt + `the ${name} skill`.length : 0
  const at = expanded.indexOf(' to ', from)
  if (at < 0) return fallbackSkillMessage(name, task)
  const head = expanded.slice(0, at)
  return /[.!?]$/.test(task) ? `${head} to ${task}` : `${head} to ${task}.`
}

/** Where a skill package publishes its optional Studio/OpenAI metadata. */
export function skillInterfacePath(name: string): string {
  return `skills/${name}/agents/openai.yaml`
}
