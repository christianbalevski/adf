import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'

const inputSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe('npm package name to remove (e.g. "lodash")')
})

/**
 * Tool that removes an npm package from this agent's available packages.
 * Does not delete the package from disk — other agents may reference it.
 * The package becomes unavailable to import starting next turn.
 */
export class NpmUninstallTool implements Tool {
  readonly name = 'npm_uninstall'
  readonly description =
    'Remove an npm package from this agent\'s available packages. ' +
    'The package becomes unavailable to import starting next turn. ' +
    'Does not delete the package from disk (other agents may use it).'
  readonly inputSchema = inputSchema
  readonly category = 'system' as const

  constructor(
    private onPackageRemoved?: (name: string) => void
  ) {}

  async execute(input: unknown, workspace: AdfWorkspace): Promise<ToolResult> {
    const { name } = input as z.infer<typeof inputSchema>

    const config = workspace.getAgentConfig()
    const packages = config.code_execution?.packages ?? []
    const idx = packages.findIndex((p) => p.name === name)

    if (idx === -1) {
      return {
        content: JSON.stringify({
          success: false,
          error: 'not_found',
          message: `Package "${name}" is not in this agent's installed packages.`
        }),
        isError: true
      }
    }

    // Remove from config
    const updated = packages.filter((p) => p.name !== name)
    workspace.setAgentConfig({
      ...config,
      code_execution: {
        ...config.code_execution,
        packages: updated
      }
    })

    // Notify IPC to refresh sandbox module set
    this.onPackageRemoved?.(name)

    return {
      content: JSON.stringify({ success: true, name }),
      isError: false
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
