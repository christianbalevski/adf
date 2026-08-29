/**
 * Side-loop config derivation.
 *
 * A loop inherits the whole agent and overrides a small delta; it never gets
 * its own identity, credentials or channels. `deriveLoopConfig` is the single
 * place that delta is computed, and — together with the loop-scoped workspace —
 * the place the security model is actually enforced:
 *
 *   - tools          absolute allow-list, intersected with the host's enabled
 *                    set, minus the never-grantable names and every tool the
 *                    host marked `restricted`
 *   - code_execution locked to the attenuated side-loop profile (§2.2): the
 *                    section the tool allow-list never touched, and the reason
 *                    a code-capable loop is not a skeleton key
 *   - triggers       only the parent targets that name this loop
 *   - loops          always empty — loops do not nest
 *
 * See docs/design/agent-loops-mvp.md §2, §5.1, §7.1.
 */

import {
  LOOP_PROHIBITED_TOOLS,
  type AgentConfig,
  type CodeExecutionConfig,
  type LoopConfig,
  type ToolDeclaration,
  type TriggerConfig,
  type TriggersConfigV3
} from '../../shared/types/adf-v02.types'

/** The implicit host loop. Never declared, never deletable, never a side loop. */
export const MAIN_LOOP = 'main'

/**
 * Interior-only machinery every loop gets regardless of host flags. Registered
 * by the runtime into each loop executor (they are absent from DEFAULT_TOOLS,
 * so a host config never declares them). Union-after-intersection is not an
 * attenuation violation: these act on interior streams and carry no worldly
 * authority.
 */
export const LOOP_ESSENTIAL_TOOLS = ['loop_send', 'loop_list'] as const

/**
 * On for a loop unless the host explicitly disabled them. History destruction
 * is owner intent, so an explicit `enabled: false` on the host declaration is
 * honoured; a loop without them still survives, because preflight
 * auto-compaction at `compact_threshold` is executor-driven, not tool-driven.
 *
 * NOTE: `loop_compact`/`loop_clear` ship `enabled: false` in DEFAULT_TOOLS and
 * that declaration is backfilled into every config, so in practice these are
 * on only once the owner enables them on the host.
 */
export const LOOP_DEFAULT_ON_TOOLS = ['loop_compact', 'loop_clear'] as const

/**
 * The one code_execution profile a side loop ever runs under.
 *
 * Allowed — process the body, invoke models, read envelope *state*, and signal
 * sibling loops (`emit_event` is the inter-loop bus).
 * Denied — `get_identity`/`set_identity` (credential exfil), `task_resolve`
 * (cross-loop task hijack), every `attestation_*` method (signing/holding
 * certs is an identity act), and `network` (egress; opt-in even for main).
 *
 * This lands side-loop code at the same trust level as the existing
 * compute_exec/MCP code-exec escape hatches: code without identity.
 */
export const SIDE_LOOP_CODE_EXECUTION: CodeExecutionConfig = {
  model_invoke: true,
  sys_lambda: true,
  identity_status: true,
  loop_inject: true,
  emit_event: true,
  get_identity: false,
  set_identity: false,
  task_resolve: false,
  attestation_list: false,
  attestation_add: false,
  attestation_issue: false,
  network: false,
  restricted_methods: ['attestation_issue']
}

/** AgentConfig is JSON by construction (it round-trips through config_json). */
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * MCP servers can mark every tool they expose as restricted, without that
 * showing up on the individual tool declaration. Mirrors
 * AgentExecutor.mcpServerIsRestricted.
 */
function mcpServerIsRestricted(host: Pick<AgentConfig, 'mcp'>, toolName: string): boolean {
  if (!toolName.startsWith('mcp_')) return false
  const parts = toolName.split('_')
  if (parts.length < 3) return false
  return host.mcp?.servers?.find(s => s.name === parts[1])?.restricted === true
}

/** Never grantable to a side loop: the hard names, plus anything HIL-gated. */
function isProhibitedForLoop(
  host: Pick<AgentConfig, 'tools' | 'mcp'>,
  decl: ToolDeclaration | undefined,
  toolName: string
): boolean {
  if ((LOOP_PROHIBITED_TOOLS as readonly string[]).includes(toolName)) return true
  // A restricted tool would park a HIL approval on a side-loop executor, whose
  // approval channel the filePath/singleton-keyed IPC cannot reach (MVP).
  if (decl?.restricted === true) return true
  return mcpServerIsRestricted(host, toolName)
}

/**
 * Host tools a side loop is allowed to ask for: enabled, not prohibited, not
 * restricted. This is the list `loop_manage` quotes back when a create names
 * something unavailable — discovery happens through the error path.
 */
export function listAvailableLoopTools(host: Pick<AgentConfig, 'tools' | 'mcp'>): string[] {
  return host.tools
    .filter(decl => decl.enabled && !isProhibitedForLoop(host, decl, decl.name))
    .map(decl => decl.name)
}

/**
 * Classify a requested tool list against the host config, for `loop_manage`'s
 * create/update error path.
 *
 * - `ok`         — granted as named
 * - `unknown`    — not available on this host: undeclared, or declared and
 *                  disabled. Report alongside listAvailableLoopTools().
 * - `prohibited` — declared and enabled, but never grantable to a side loop
 *                  (hard names, or restricted by declaration/MCP server)
 */
export function validateLoopToolList(
  hostConfig: Pick<AgentConfig, 'tools' | 'mcp'>,
  tools: string[]
): { ok: string[]; unknown: string[]; prohibited: string[] } {
  const ok: string[] = []
  const unknown: string[] = []
  const prohibited: string[] = []

  for (const name of tools) {
    const decl = hostConfig.tools.find(t => t.name === name)
    if ((LOOP_PROHIBITED_TOOLS as readonly string[]).includes(name)) {
      prohibited.push(name)
    } else if (!decl || !decl.enabled) {
      unknown.push(name)
    } else if (isProhibitedForLoop(hostConfig, decl, name)) {
      prohibited.push(name)
    } else {
      ok.push(name)
    }
  }

  return { ok, unknown, prohibited }
}

/**
 * Build this loop's `tools` as an explicit enabled-set.
 *
 * There is no per-loop visibility concept: in the set means in the schema, and
 * main's session visibility toggling never affects a side loop. Every other
 * host tool is carried through disabled+hidden so the derived config still
 * describes the full universe (and so a name that reappears later is not
 * silently granted).
 */
function deriveTools(parent: AgentConfig, loop: LoopConfig): ToolDeclaration[] {
  const { ok } = validateLoopToolList(parent, loop.tools ?? [])
  const granted = new Set<string>(ok)

  for (const name of LOOP_ESSENTIAL_TOOLS) granted.add(name)
  for (const name of LOOP_DEFAULT_ON_TOOLS) {
    const decl = parent.tools.find(t => t.name === name)
    if (decl?.enabled === false) continue   // explicit host disable wins
    granted.add(name)
  }

  const derived: ToolDeclaration[] = parent.tools.map(decl => ({
    name: decl.name,
    enabled: granted.has(decl.name),
    visible: granted.has(decl.name)
  }))

  // Essentials and default-on tools the host never declared.
  const declared = new Set(parent.tools.map(t => t.name))
  for (const name of granted) {
    if (!declared.has(name)) derived.push({ name, enabled: true, visible: true })
  }

  return derived
}

/** Keep only the parent targets that name this loop; absent `loop` means main. */
function deriveTriggers(parent: AgentConfig, loopName: string): TriggersConfigV3 {
  const derived: TriggersConfigV3 = {}
  for (const [type, config] of Object.entries(parent.triggers ?? {})) {
    const trigger = config as TriggerConfig | undefined
    if (!trigger) continue
    const targets = (trigger.targets ?? []).filter(t => (t.loop ?? MAIN_LOOP) === loopName)
    if (targets.length === 0) continue
    derived[type as keyof TriggersConfigV3] = {
      enabled: trigger.enabled,
      targets: cloneJson(targets)
    }
  }
  return derived
}

/**
 * The config a side loop's executor runs under. Pure: `parent` is never
 * mutated and the result shares no sub-object with it, so a later host-config
 * mutation cannot reach into a live loop.
 *
 * `main`'s derived config *is* the raw AgentConfig — do not call this for it.
 */
export function deriveLoopConfig(parent: AgentConfig, loop: LoopConfig): AgentConfig {
  if (loop.name === MAIN_LOOP) {
    throw new Error("deriveLoopConfig: 'main' is the host loop — use the raw agent config")
  }

  // id/handle/identity/credentials/mcp/adapters/serving all ride along from the
  // clone: sharing them is exactly what makes a loop a facet rather than a mount.
  const derived = cloneJson(parent)

  derived.instructions = loop.goal
  derived.model = cloneJson(loop.model ?? parent.model)
  derived.tools = deriveTools(parent, loop)
  derived.triggers = deriveTriggers(parent, loop.name)
  derived.code_execution = {
    ...cloneJson(SIDE_LOOP_CODE_EXECUTION),
    // Sandbox packages are host-installed and carry no authority of their own;
    // a loop that may run code needs the same modules available to it.
    packages: cloneJson(parent.code_execution?.packages ?? []),
    // Restrictions only ever accumulate.
    restricted_methods: Array.from(new Set([
      ...(SIDE_LOOP_CODE_EXECUTION.restricted_methods ?? []),
      ...(parent.code_execution?.restricted_methods ?? [])
    ]))
  }
  // Loops do not nest: loop_manage is main-only.
  derived.loops = []
  derived.metadata = { ...derived.metadata, loop_name: loop.name }

  return derived
}
