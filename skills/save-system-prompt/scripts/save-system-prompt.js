// Save the runtime-provided part of this agent's system prompt into its own
// files, and optionally make the agent use that saved copy instead of the
// host's. Reads only what the runtime already recorded in adf_loop.
//
//   save   -> prompts/runtime.md   (exact text, {{file}} placeholders restored)
//   apply  -> instructions = saved text + separator + current instructions
//   revert -> removes the saved text from instructions
//
// Neither changes the prompt mode (include_base_prompt / bare_prompt): that is
// the owner's setting. Both return `owner_action`, the switch to ask for.
//
// Entry points take one args object; see SKILL.md.

const SEP = '\n\n---\n\n'
const CONTEXT_PREFIX = '[Context: system_prompt] '
const INSTRUCTIONS_HEADING = '## Agent-Specific Instructions\n\n'
const IDENTITY_HEADING = '## Your Identity\n\n'
const DEFAULT_PATH = 'prompts/runtime.md'

function parsed(raw) {
  if (raw && typeof raw === 'object') return raw
  const text = String(raw)
  const cut = text.indexOf('\n\n--- TRUNCATED')
  if (cut !== -1) throw new Error('db_query result was truncated; the saved prompt would be incomplete')
  return JSON.parse(text)
}

function unescapeAttr(value) {
  return value.replace(/&quot;/g, '"').replace(/&amp;/g, '&')
}

/** Turn every rendered `<injected_file path="p">…</injected_file>` back into `{{p}}`. */
function restorePlaceholders(text) {
  const paths = []
  const re = /<injected_file path="([^"]*)"(?: missing="true"\/>|>\n[\s\S]*?\n<\/injected_file>)/g
  const out = text.replace(re, (_m, rawPath) => {
    const path = unescapeAttr(rawPath)
    if (!paths.includes(path)) paths.push(path)
    return `{{${path}}}`
  })
  return { text: out, placeholders: paths }
}

/**
 * The runtime layers come first. The agent's own instructions follow, then
 * the runtime blocks generated from its config, which always open with its
 * identity.
 */
function runtimePart(prompt) {
  for (const marker of [SEP + INSTRUCTIONS_HEADING, SEP + IDENTITY_HEADING]) {
    const at = prompt.indexOf(marker)
    if (at > 0) return prompt.slice(0, at)
  }
  return null
}

async function latestSystemPrompt(adf, loop) {
  const rows = parsed(await adf.db_query({
    sql: "SELECT seq, created_at, content_json FROM adf_loop WHERE loop = ? AND role = 'user' AND content_json LIKE ? ORDER BY seq DESC LIMIT 1",
    params: [loop, `%${CONTEXT_PREFIX}%`],
  }))
  const row = Array.isArray(rows) ? rows[0] : undefined
  if (!row) return null
  const blocks = typeof row.content_json === 'string' ? JSON.parse(row.content_json) : row.content_json
  const block = Array.isArray(blocks) ? blocks.find((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.startsWith(CONTEXT_PREFIX)) : null
  if (!block) return null
  return { seq: row.seq, created_at: row.created_at, prompt: block.text.slice(CONTEXT_PREFIX.length) }
}

async function readText(adf, path) {
  try {
    const file = await adf.fs_read({ path })
    return file && typeof file === 'object' && typeof file.content === 'string' ? file.content : null
  } catch {
    return null
  }
}

async function getConfig(adf) {
  return parsed(await adf.sys_get_config({}))
}

async function save(args = {}) {
  const loop = args.loop || 'main'
  const path = args.path || DEFAULT_PATH
  const found = await latestSystemPrompt(adf, loop)
  if (!found) return { ok: false, reason: 'no_recorded_prompt', detail: `adf_loop has no system_prompt entry for loop "${loop}". One is recorded on the turn after the prompt changes; run this again on a later turn.` }
  const part = runtimePart(found.prompt)
  if (!part || !part.trim()) return { ok: false, reason: 'no_runtime_part', detail: 'The recorded prompt has no runtime-provided part. include_base_prompt is off or bare_prompt is on, so there is nothing to save.' }
  const { text, placeholders } = restorePlaceholders(part)
  await adf.fs_write({ mode: 'write', path, content: text })
  return { ok: true, path, from_seq: found.seq, recorded_at: found.created_at, chars: text.length, placeholders }
}

async function apply(args = {}) {
  const path = args.path || DEFAULT_PATH
  const saved = await readText(adf, path)
  if (!saved || !saved.trim()) return { ok: false, reason: 'not_saved', detail: `${path} is missing or empty. Run save first.` }
  const config = await getConfig(adf)
  const instructions = typeof config.instructions === 'string' ? config.instructions : ''
  const owner_action = ownerAction(config, false)
  if (instructions.startsWith(saved)) {
    return { ok: true, changed: false, detail: 'instructions already start with the saved prompt', owner_action }
  }
  const next = instructions.trim() ? saved + SEP + instructions : saved
  await adf.sys_update_config({ path: 'instructions', value: next })
  return { ok: true, changed: true, path, instructions_chars: next.length, owner_action }
}

/**
 * The prompt mode is the owner's setting: the skill never changes it. Returns
 * what the owner must switch, or null when the mode already fits.
 */
function ownerAction(config, wantRuntimePrompt) {
  const mode = config.bare_prompt === true ? 'bare' : config.include_base_prompt === false ? 'no-base' : 'full'
  if (wantRuntimePrompt) {
    return mode === 'full' ? null : 'Set the prompt mode to "Full" (include_base_prompt on, bare_prompt off) so the runtime prompt is included again.'
  }
  if (mode === 'no-base') return null
  if (mode === 'bare') return 'The prompt mode is "Agent Instructions only" (bare_prompt), which also drops your name, model and loop blocks. Set it to "No base prompt" (include_base_prompt off, bare_prompt off).'
  return 'Set the prompt mode to "No base prompt" (include_base_prompt off). Until then the runtime prompt is included twice: once from the runtime, once from the saved copy.'
}

async function revert(args = {}) {
  const path = args.path || DEFAULT_PATH
  const saved = await readText(adf, path)
  if (!saved) return { ok: false, reason: 'not_saved', detail: `${path} is missing; cannot tell which part of instructions to remove.` }
  const config = await getConfig(adf)
  const instructions = typeof config.instructions === 'string' ? config.instructions : ''
  if (!instructions.startsWith(saved)) return { ok: false, reason: 'not_applied', detail: 'instructions do not start with the saved prompt; nothing was changed.' }
  let rest = instructions.slice(saved.length)
  if (rest.startsWith(SEP)) rest = rest.slice(SEP.length)
  await adf.sys_update_config({ path: 'instructions', value: rest })
  return { ok: true, changed: true, owner_action: ownerAction(config, true) }
}

export { save, apply, revert, restorePlaceholders, runtimePart }
