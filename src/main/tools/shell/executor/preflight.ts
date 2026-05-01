/**
 * Pre-flight permission scanner.
 *
 * Before executing a pipeline, scans all resolved tool calls:
 * - If any tool is disabled → exit 126
 * - If any tool requires approval → approval_required list (HIL)
 * - If any tool matches on_tool_call → intercepted_tools list (task creation)
 */

import type { AgentConfig, ToolDeclaration } from '@shared/types/adf-v02.types'
import type { AdfWorkspace } from '../../../adf/adf-workspace'
import type { ShellNode, PipelineNode, CommandNode } from '../parser/ast'
import { getCommand } from '../commands/index'

export interface PreflightResult {
  allowed: boolean
  /** Non-zero exit code if not allowed */
  exit_code?: number
  /** Error message */
  stderr?: string
  /** Task ID if pipeline was intercepted by on_tool_call */
  task_id?: string
  /** Status if intercepted */
  status?: string
  /** Tool names intercepted by on_tool_call trigger */
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

/** Find a tool declaration by name */
function findDeclaration(name: string, config: AgentConfig): ToolDeclaration | undefined {
  return config.tools.find(t => t.name === name)
}

/** Check if an MCP tool's server is restricted */
function mcpServerIsRestricted(toolName: string, config: AgentConfig): boolean {
  if (!toolName.startsWith('mcp_')) return false
  // Tool name format: mcp_<server>_<tool> — extract server name
  const parts = toolName.split('_')
  if (parts.length < 3) return false
  const serverName = parts[1]
  const server = config.mcp?.servers?.find(s => s.name === serverName)
  return server?.restricted === true
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
  workspace: AdfWorkspace,
  originalCommand: string
): PreflightResult {
  const resolvedTools = collectResolvedTools(node)

  // Check each resolved tool — separate approval-required from trigger-intercepted
  const approvalRequired: string[] = []
  const intercepted: string[] = []
  for (const toolName of resolvedTools) {
    const decl = findDeclaration(toolName, config)

    if (!decl) {
      // No per-tool declaration — check MCP server-level restricted
      if (mcpServerIsRestricted(toolName, config)) {
        approvalRequired.push(toolName)
      }
      // Also check on_tool_call trigger for undeclared tools
      if (matchesToolCallTrigger(toolName, config)) {
        intercepted.push(toolName)
      }
      continue
    }

    // Check if tool is disabled
    if (!decl.enabled) {
      return {
        allowed: false,
        exit_code: 126,
        stderr: `${toolName} is disabled`
      }
    }

    // Check if tool is restricted (enabled + restricted = HIL from loop)
    if (decl.enabled && decl.restricted) {
      approvalRequired.push(toolName)
      continue
    }

    // Check if tool matches on_tool_call trigger
    if (matchesToolCallTrigger(toolName, config)) {
      intercepted.push(toolName)
    }
  }

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

  // Tools intercepted by on_tool_call trigger — create task
  if (intercepted.length > 0) {
    const interceptedTools = [...new Set(intercepted)]
    const taskId = 'task_' + Math.random().toString(36).slice(2, 8)
    try {
      workspace.insertTask(
        taskId,
        'adf_shell',
        JSON.stringify({
          command: originalCommand,
          resolved: resolvedTools,
          intercepted_by: interceptedTools
        })
      )
    } catch {
      // Task creation failed — still return intercepted status
    }

    return {
      allowed: false,
      exit_code: 130,
      task_id: taskId,
      status: 'pending',
      intercepted_tools: interceptedTools,
      resolved_tools: resolvedTools,
      stderr: ''
    }
  }

  return { allowed: true }
}
