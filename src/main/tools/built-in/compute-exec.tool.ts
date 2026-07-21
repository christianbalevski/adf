/**
 * compute_exec — Execute shell commands in the agent's compute environment.
 *
 * Supports multiple authorized execution targets through one tool:
 *   - 'isolated' — agent's dedicated container (requires compute.enabled)
 *   - 'shared'   — shared MCP container (adf-mcp)
 *   - safe aliases — user-approved Docker/Podman targets configured for this agent
 *   - 'host'     — host machine directly (requires compute.host_access)
 *
 * The target field is exposed only when the agent is authorized for more than
 * one environment. Omitting it always uses the configured default.
 */

import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'
import type { PodmanService } from '../../services/podman.service'
import { availableTargets, resolveTarget, type ComputeCapabilities, type ComputeTarget } from './compute-target'
import { hostExec, ensureHostWorkspace } from '../../services/host-exec.service'
import { ExternalExecutionService } from '../../services/external-execution.service'

const MAX_OUTPUT_BYTES = 512 * 1024 // 512 KB per stream
const MAX_TIMEOUT_MS = 120_000      // Hard ceiling: 2 minutes
const DEFAULT_TIMEOUT_MS = 30_000

const BASE_DESCRIPTION =
  'Execute a shell command in a compute environment. ' +
  'Supports pipes, chaining (&&, ||), redirection, and all standard shell syntax. ' +
  'Returns stdout, stderr, and exit code.'

export class ComputeExecTool implements Tool {
  readonly name = 'compute_exec'
  readonly description: string
  readonly inputSchema: z.ZodObject<any>
  readonly category = 'system' as const
  readonly requireApproval = true

  constructor(
    private podmanService: PodmanService | null,
    private capabilities: ComputeCapabilities,
    private agentTimeoutMs?: number,
    private externalExecutionService = new ExternalExecutionService(),
  ) {
    const targets = availableTargets(capabilities)
    const schemaTargets = (targets.length > 0 ? targets : ['shared']) as [string, ...string[]]
    const shape: Record<string, z.ZodTypeAny> = {
      command: z.string().min(1).describe('Shell command to execute. Supports pipes, chaining, and redirection.'),
      timeout_ms: z.number().int().positive().optional().describe('Timeout in milliseconds (default 30000, max 120000).'),
    }
    if (targets.length > 1) {
      shape.target = z.enum(schemaTargets).optional().describe('Optional execution environment. Omit to use the default.')
    }
    this.inputSchema = z.object(shape)
    const defaultNote = capabilities.defaultTarget ? ` Default target: ${capabilities.defaultTarget}.` : ''
    const targetNote = targets.length > 1
      ? ` Available targets: ${targets.join(', ')}.${defaultNote}`
      : targets.length === 1
        ? ` Commands run in ${targets[0]}.`
        : ''
    this.description = `${BASE_DESCRIPTION}${targetNote}${capabilities.hostInfo ? ` ${capabilities.hostInfo}` : ''}`
  }

  async execute(input: unknown, _workspace: AdfWorkspace): Promise<ToolResult> {
    const { command, target: requestedTarget, timeout_ms } = input as {
      command: string
      target?: ComputeTarget
      timeout_ms?: number
    }

    let effectiveTarget: ComputeTarget
    try {
      effectiveTarget = resolveTarget(requestedTarget, this.capabilities)
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true }
    }

    // Resolve effective timeout: per-call < agent limit < hard ceiling
    const ceiling = Math.min(this.agentTimeoutMs ?? MAX_TIMEOUT_MS, MAX_TIMEOUT_MS)
    const effectiveTimeout = timeout_ms
      ? Math.min(timeout_ms, ceiling)
      : Math.min(DEFAULT_TIMEOUT_MS, ceiling)

    try {
      let result: { stdout: string; stderr: string; code: number }

      switch (effectiveTarget) {
        case 'isolated': {
          if (!this.podmanService || !this.capabilities.isolatedContainerName) {
            return { content: 'Isolated container not available.', isError: true }
          }
          await this.podmanService.ensureWorkspace(this.capabilities.isolatedContainerName, '/workspace').catch(() => {})
          result = await this.podmanService.execInContainer(
            this.capabilities.isolatedContainerName, '/workspace', command, effectiveTimeout
          )
          break
        }
        case 'shared': {
          if (!this.podmanService) {
            return { content: 'Podman not available for shared container.', isError: true }
          }
          const cwd = `/workspace/${this.capabilities.agentId}`
          await this.podmanService.ensureWorkspace('adf-mcp', cwd).catch(() => {})
          result = await this.podmanService.execInContainer(
            'adf-mcp', cwd, command, effectiveTimeout
          )
          break
        }
        default: {
          const externalTarget = this.capabilities.externalTargets?.[effectiveTarget]
          if (!externalTarget) return { content: `Execution target '${effectiveTarget}' is not configured.`, isError: true }
          result = await this.externalExecutionService.execute(
            externalTarget,
            command,
            effectiveTimeout,
          )
          break
        }
        case 'host': {
          const cwd = ensureHostWorkspace(this.capabilities.agentId)
          result = await hostExec(cwd, command, effectiveTimeout)
          break
        }
      }

      return {
        content: JSON.stringify({
          target: effectiveTarget,
          ...(this.capabilities.externalTargets?.[effectiveTarget]
            ? {
                kind: 'external-container',
                engine: this.capabilities.externalTargets[effectiveTarget].engine,
                target_name: this.capabilities.externalTargets[effectiveTarget].name,
              }
            : {}),
          exit_code: result.code,
          stdout: truncate(result.stdout, MAX_OUTPUT_BYTES),
          stderr: truncate(result.stderr, MAX_OUTPUT_BYTES),
        }),
        isError: false,
      }
    } catch (err) {
      return {
        content: `compute_exec error: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      }
    }
  }

  toProviderFormat(): ToolProviderFormat {
    return {
      name: this.name,
      description: this.description,
      input_schema: zodToJsonSchema(this.inputSchema) as Record<string, unknown>
    }
  }
}

function truncate(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text
  const truncated = Buffer.from(text).subarray(0, maxBytes).toString('utf-8')
  return truncated + `\n[truncated: output exceeded ${maxBytes} bytes]`
}
