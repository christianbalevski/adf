import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'
import type { SandboxPackagesService } from '../../services/sandbox-packages.service'
import { NativeAddonError, SizeLimitError } from '../../services/sandbox-packages.service'

const inputSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe('npm package name (e.g. "lodash", "vega-lite", "@resvg/resvg-wasm")'),
  version: z
    .string()
    .optional()
    .describe('Semver version or range (e.g. "^5.30.0", "4.17.21"). Defaults to "latest".')
})

const MAX_PACKAGES = 50

/**
 * Tool that installs an npm package for use in the code execution sandbox.
 * Pure JavaScript packages only — native addons are detected and rejected.
 * The package becomes importable in sys_code and sys_lambda on the next turn.
 */
export class NpmInstallTool implements Tool {
  readonly name = 'npm_install'
  readonly description =
    'Install an npm package for use in code execution (sys_code / sys_lambda). ' +
    'Pure JavaScript packages only — native addons are blocked. ' +
    'The package becomes available to import starting next turn. ' +
    'Example: npm_install({ name: "vega-lite", version: "^5.21.0" })'
  readonly inputSchema = inputSchema
  readonly category = 'system' as const

  constructor(
    private packagesService: SandboxPackagesService,
    private onPackageInstalled?: (name: string, version: string) => void
  ) {}

  async execute(input: unknown, workspace: AdfWorkspace): Promise<ToolResult> {
    const { name, version } = input as z.infer<typeof inputSchema>

    // Check package count limit
    const config = workspace.getAgentConfig()
    const currentPackages = config.code_execution?.packages ?? []
    if (currentPackages.length >= MAX_PACKAGES) {
      return {
        content: JSON.stringify({
          success: false,
          error: 'package_limit',
          message: `Maximum ${MAX_PACKAGES} packages allowed. Remove unused packages with npm_uninstall first.`
        }),
        isError: true
      }
    }

    // Check if already in agent config at same version
    const existing = currentPackages.find((p) => p.name === name)
    if (existing && version && existing.version === version) {
      return {
        content: JSON.stringify({
          success: true,
          name,
          version: existing.version,
          already_installed: true
        }),
        isError: false
      }
    }

    try {
      const agentName = workspace.getAgentConfig().name
      const result = await this.packagesService.install(name, version, undefined, agentName)

      // Persist to agent config
      const freshConfig = workspace.getAgentConfig()
      const packages = (freshConfig.code_execution?.packages ?? []).filter((p) => p.name !== name)
      packages.push({ name, version: result.version })
      workspace.setAgentConfig({
        ...freshConfig,
        code_execution: {
          ...freshConfig.code_execution,
          packages
        }
      })

      // Notify IPC to refresh sandbox module set
      this.onPackageInstalled?.(name, result.version)

      return {
        content: JSON.stringify({
          success: true,
          name,
          version: result.version,
          size_mb: result.size_mb,
          already_installed: result.already_installed
        }),
        isError: false
      }
    } catch (error) {
      if (error instanceof NativeAddonError) {
        return {
          content: JSON.stringify({
            success: false,
            error: 'native_addon',
            message: 'Package requires native code and cannot run in the sandbox.'
          }),
          isError: true
        }
      }
      if (error instanceof SizeLimitError) {
        return {
          content: JSON.stringify({
            success: false,
            error: 'size_limit',
            message: error.message
          }),
          isError: true
        }
      }
      return {
        content: JSON.stringify({
          success: false,
          error: 'npm_error',
          message: String(error instanceof Error ? error.message : error)
        }),
        isError: true
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
