/**
 * Pre-flight permission scanner.
 *
 * Before executing a pipeline, scans all resolved tool calls:
 * - If any tool is disabled → exit 126
 * - If any tool requires approval → approval_required list (HIL)
 * - If any tool matches on_tool_call → observer notification AFTER it runs
 *
 * on_tool_call is OBSERVATIONAL, not a permission (see docs/guides/triggers.md:
 * "observational, post-execution"). The direct tool-call path in the executor
 * runs the tool and then notifies; the shell used to do the opposite — refuse
 * the command with exit 130 and insert a task saying the operator would resolve
 * it. Nothing ever did: TriggerEvaluator.onToolCall doesn't take the task
 * anywhere, so a `msg send` under an on_tool_call trigger silently never sent
 * and left a pending task forever. Blocking on a tool call is what
 * `restricted: true` (HIL approval) is for, and the shell still honors that.
 */

import type { AgentConfig, ToolDeclaration } from '@shared/types/adf-v02.types'
import type { AdfWorkspace } from '../../../adf/adf-workspace'
import type { ShellNode, PipelineNode, CommandNode } from '../parser/ast'
import type { CommandResult, ShellGate } from '../commands/types'
import { EXIT } from '../commands/types'
import { getCommand } from '../commands/index'

export interface PreflightResult {
  allowed: boolean
  /** Non-zero exit code if not allowed */
  exit_code?: number
  /** Error message */
  stderr?: string
  /** Tool names that will notify on_tool_call observers when they run.
   *  Informational — matching does NOT block the pipeline. */
  intercepted_tools?: string[]
  /** Tool names that require HIL approval before execution */
  approval_required?: string[]
  /** All resolved tool names in the pipeline */
  resolved_tools?: string[]
}

/**
 * Collect all resolved tool names from an AST node.
 * Walks the entire tree to find every tool that would be invoked.
 */
export function collectResolvedTools(node: ShellNode): string[] {
  const tools: string[] = []

  function walkNode(n: ShellNode): void {
    if (n.kind === 'pipeline') {
      walkPipeline(n)
    } else if (n.kind === 'chain') {
      walkPipeline(n.left)
      walkNode(n.right)
    }
  }

  function walkPipeline(p: PipelineNode): void {
    for (const cmd of p.stages) {
      walkCommand(cmd)
    }
  }

  function walkCommand(cmd: CommandNode): void {
    const handler = getCommand(cmd.name)
    if (handler) {
      tools.push(...handler.resolvedTools)
      // Resolve dynamic tools from args (e.g. MCP tool names)
      if (handler.resolveToolsFromArgs) {
        tools.push(...handler.resolveToolsFromArgs(cmd.args))
      }
    }
    // Also check for redirects — > and >> use fs_write, < uses fs_read
    for (const r of cmd.redirects) {
      if (r.type === 'out' || r.type === 'append') tools.push('fs_write')
      if (r.type === 'in') tools.push('fs_read')
    }
  }

  walkNode(node)
  return [...new Set(tools)] // deduplicate
}

/** Resolve the tools a single command node would invoke (incl. redirects). */
export function resolveCommandTools(cmd: CommandNode): string[] {
  const tools: string[] = []
  const handler = getCommand(cmd.name)
  if (handler) {
    tools.push(...handler.resolvedTools)
    if (handler.resolveToolsFromArgs) tools.push(...handler.resolveToolsFromArgs(cmd.args))
  }
  for (const r of cmd.redirects) {
    if (r.type === 'out' || r.type === 'append') tools.push('fs_write')
    if (r.type === 'in') tools.push('fs_read')
  }
  return [...new Set(tools)]
}

export interface CommandGateEval {
  disabled: string[]
  approvalRequired: string[]
  intercepted: string[]
  resolvedTools: string[]
}

/**
 * Evaluate explicit tool names against config: disabled / approval-required /
 * on_tool_call-intercepted. Used both per-command (below) and by dynamic-tool
 * commands (mcp) that only know their real tool name AFTER arg resolution.
 */
export function evaluateToolNames(toolNames: string[], config: AgentConfig): CommandGateEval {
  const disabled: string[] = []
  const approvalRequired: string[] = []
  const intercepted: string[] = []
  for (const toolName of toolNames) {
    const decl = findDeclaration(toolName, config)
    // Server-level MCP restriction applies REGARDLESS of a per-tool
    // declaration: synced MCP tools get enabled declarations, so checking this
    // only when `!decl` (as before) let a restricted server's tools run
    // ungated once discovered.
    const serverRestricted = mcpServerIsRestricted(toolName, config)
    // Observation is independent of the permission outcome: the direct
    // tool-call path notifies on_tool_call observers for restricted tools too
    // (after approval) and on denial. Only tools that never run go unreported,
    // which falls out of notifying post-execution.
    if (matchesToolCallTrigger(toolName, config)) intercepted.push(toolName)
    if (!decl) {
      if (serverRestricted) approvalRequired.push(toolName)
      continue
    }
    if (!decl.enabled) { disabled.push(toolName); continue }
    if (decl.restricted || serverRestricted) approvalRequired.push(toolName)
  }
  return {
    disabled: [...new Set(disabled)],
    approvalRequired: [...new Set(approvalRequired)],
    intercepted: [...new Set(intercepted)],
    resolvedTools: toolNames,
  }
}

/**
 * Evaluate a single command's tools against config — the per-command core the
 * executor gate uses so every execution path (not just ShellTool) is checked.
 * Pure: no task creation or side effects.
 */
export function evaluateCommand(cmd: CommandNode, config: AgentConfig): CommandGateEval {
  return evaluateToolNames(resolveCommandTools(cmd), config)
}

/**
 * Enforce a gate evaluation: returns a blocking CommandResult (disabled 126 /
 * approval-denied 130) or null to proceed. Shared by the per-command executor
 * gate AND dynamic-tool commands (mcp) that must gate on a tool name known only
 * after arg resolution. Authorized scripts bypass disabled+approval.
 *
 * on_tool_call is NOT enforced here — it is an observer, fired by
 * notifyToolCallObservers after the command runs.
 */
export async function enforceToolGate(
  evalr: CommandGateEval,
  gate: ShellGate,
  config: AgentConfig,
  command: string,
): Promise<CommandResult | null> {
  if (!gate.authorized) {
    if (evalr.disabled.length > 0) {
      const tools = evalr.disabled.join(', ')
      return { exit_code: EXIT.DISABLED, stdout: '', stderr: `${tools} is disabled — this command needs the ${tools} tool${evalr.disabled.length > 1 ? 's' : ''} enabled in the agent's tool config` }
    }
    if (evalr.approvalRequired.length > 0) {
      if (!gate.onApprovalRequired) {
        return { exit_code: EXIT.INTERCEPTED, stdout: '', stderr: `Tools [${evalr.approvalRequired.join(', ')}] require approval but no approval handler is configured.` }
      }
      for (const tool of evalr.approvalRequired) {
        const approved = await gate.onApprovalRequired(tool, command)
        if (!approved) return { exit_code: EXIT.INTERCEPTED, stdout: '', stderr: `Tool "${tool}" was rejected by the user.` }
      }
    }
  }
  return null
}

/**
 * Fire on_tool_call observers for the tools a command actually ran. Called
 * AFTER execution (the direct tool-call path in agent-executor does the same),
 * never blocking and never creating a task: the trigger's targets are the
 * lambda/command/agent wake-ups configured for the event.
 *
 * The task id is empty for the same reason it is on the executor's non-HIL
 * path — there is no task to reference. Args stay `{command, intercepted_by}`
 * so lambdas written against the old payload keep working.
 */
export function notifyToolCallObservers(
  intercepted: string[],
  gate: ShellGate,
  config: AgentConfig,
  command: string,
): void {
  if (intercepted.length === 0 || !gate.onToolCallIntercepted) return
  const argsStr = JSON.stringify({ command, intercepted_by: intercepted })
  const origin = config.id ? `agent:${config.name}:${config.id}` : `agent:${config.name}`
  for (const tool of intercepted) {
    // An observer must never break the command that triggered it.
    try { gate.onToolCallIntercepted(tool, argsStr, '', origin) } catch { /* non-fatal */ }
  }
}

/** Find a tool declaration by name */
function findDeclaration(name: string, config: AgentConfig): ToolDeclaration | undefined {
  return config.tools.find(t => t.name === name)
}

/** Check if an MCP tool's server is restricted. Match by the `mcp_<server>_`
 *  PREFIX against each configured server name — a plain split('_')[1] mis-parses
 *  server names that themselves contain underscores (e.g. `git_hub`), letting a
 *  restricted server slip through. */
function mcpServerIsRestricted(toolName: string, config: AgentConfig): boolean {
  if (!toolName.startsWith('mcp_')) return false
  // A tool name can prefix-match more than one server (`mcp_git_hub_x` matches
  // both `git` and `git_hub`). The real owner is the LONGEST matching name, so
  // pick that and use its restricted flag — avoids mis-attributing a sibling
  // server's restriction (over- or under-restricting).
  let owner: { name: string; restricted?: boolean } | undefined
  for (const server of config.mcp?.servers ?? []) {
    if (toolName.startsWith(`mcp_${server.name}_`) && (!owner || server.name.length > owner.name.length)) {
      owner = server
    }
  }
  return owner?.restricted === true
}

/** Check if a tool name matches any on_tool_call trigger filter */
function matchesToolCallTrigger(toolName: string, config: AgentConfig): boolean {
  const cfg = config.triggers?.on_tool_call
  if (!cfg?.enabled) return false
  const targets = cfg.targets ?? []
  for (const target of targets) {
    if (!target.filter?.tools) continue
    for (const pattern of target.filter.tools) {
      const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$')
      if (regex.test(toolName)) return true
    }
  }
  return false
}

/**
 * Run pre-flight checks on a parsed AST.
 * Returns PreflightResult with allowed=true if execution can proceed.
 */
export function preflight(
  node: ShellNode,
  config: AgentConfig,
  _workspace?: AdfWorkspace,
  _originalCommand?: string
): PreflightResult {
  const resolvedTools = collectResolvedTools(node)

  // Delegate the per-tool decision to the shared evaluator so this legacy
  // whole-AST entry point can never diverge from the live gate (it previously
  // carried an out-of-date MCP-restriction check).
  const ev = evaluateToolNames(resolvedTools, config)

  if (ev.disabled.length > 0) {
    return { allowed: false, exit_code: 126, stderr: `${ev.disabled.join(', ')} is disabled` }
  }

  const approvalRequired = ev.approvalRequired
  const intercepted = ev.intercepted

  // Tools requiring HIL approval — return list for shell to handle via approval callback
  if (approvalRequired.length > 0) {
    return {
      allowed: false,
      exit_code: 130,
      approval_required: [...new Set(approvalRequired)],
      intercepted_tools: intercepted.length > 0 ? [...new Set(intercepted)] : undefined,
      resolved_tools: resolvedTools,
    }
  }

  // on_tool_call matches are REPORTED, never blocking: they are observers
  // fired after execution (notifyToolCallObservers), so a pre-flight scan can
  // only say which tools will be observed.
  if (intercepted.length > 0) {
    return {
      allowed: true,
      intercepted_tools: [...new Set(intercepted)],
      resolved_tools: resolvedTools,
    }
  }

  return { allowed: true }
}
