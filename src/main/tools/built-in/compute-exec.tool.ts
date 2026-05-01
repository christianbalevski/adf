/**
 * compute_exec — Execute shell commands in the agent's compute environment.
 *
 * Supports three targets:
 *   - 'isolated' — agent's dedicated container (requires compute.enabled)
 *   - 'shared'   — shared MCP container (adf-mcp)
 *   - 'host'     — host machine directly (requires compute.host_access)
 *
 * Default target: least-privileged available (isolated → shared → host).
 */

import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'
import type { PodmanService } from '../../services/podman.service'
import { resolveTarget, type ComputeCapabilities, type ComputeTarget } from './compute-target'
import { hostExec, ensureHostWorkspace } from '../../services/host-exec.service'

const MAX_OUTPUT_BYTES = 512 * 1024 // 512 KB per stream
const MAX_TIMEOUT_MS = 120_000      // Hard ceiling: 2 minutes
const DEFAULT_TIMEOUT_MS = 30_000

const InputSchema = z.object({
  command: z.string().min(1).describe('Shell command to execute (passed to sh -c). Supports pipes, chaining, redirection.'),
  target: z.enum(['isolated', 'shared', 'host']).optional()
    .describe("Compute environment to run in. Defaults to the least-privileged available (isolated → shared → host)."),
  timeout_ms: z.number().int().positive().optional()
    .describe('Timeout in milliseconds (default 30000, max 120000).')
})

const BASE_DESCRIPTION =
  'Execute a shell command in a compute environment. ' +
  'Supports pipes, chaining (&&, ||), redirection, and all standard shell syntax. ' +
  "Optionally specify target: 'isolated' (dedicated container), 'shared' (shared container), or 'host' (host machine). " +
  'Defaults to the most isolated environment available. Returns stdout, stderr, and exit code.'

export class ComputeExecTool implements Tool {
  readonly name = 'compute_exec'
  readonly description: string
  readonly inputSchema = InputSchema
  readonly category = 'system' as const
  readonly requireApproval = true

  constructor(
    private podmanService: PodmanService | null,
    private capabilities: ComputeCapabilities,
    private agentTimeoutMs?: number,
  ) {
    this.description = capabilities.hostInfo
      ? `${BASE_DESCRIPTION} ${capabilities.hostInfo}`
      : BASE_DESCRIPTION
  }

  async execute(input: unknown, _workspace: AdfWorkspace): Promise<ToolResult> {
    const { command, target: requestedTarget, timeout_ms } = input as z.infer<typeof InputSchema>

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
        case 'host': {
          const cwd = ensureHostWorkspace(this.capabilities.agentId)
          result = await hostExec(cwd, command, effectiveTimeout)
          break
        }
      }

      return {
        content: JSON.stringify({
          target: effectiveTarget,
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
