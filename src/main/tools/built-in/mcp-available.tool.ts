/**
 * mcp_available — List MCP servers registered in ADF Studio Settings that
 * this agent may attach (agentVisible) but has not attached yet.
 *
 * Read-only discovery counterpart to mcp_install's attach mode: a server the
 * user already configured (env credentials, auth, run location) is a better
 * artifact than a fresh install, so agents should check here first.
 */

import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'
import type { McpServerRegistration } from '../../../shared/types/ipc.types'
import { isRegistrationAgentVisible, registrationSourceIdentity } from '../../../shared/utils/mcp-config'
import { findRegistryEntry, findRegistryEntryByPypiPackage } from '../../../shared/constants/mcp-registry'

const InputSchema = z.object({})

function locationLabel(reg: McpServerRegistration): string {
  if (reg.type === 'http' || reg.url) return 'remote http'
  return reg.runLocation === 'host' ? 'host' : 'shared container'
}

export class McpAvailableTool implements Tool {
  readonly name = 'mcp_available'
  readonly description =
    'List MCP servers already configured in ADF Studio Settings that you can attach with mcp_install ' +
    '(pass the listed name or package). Attaching reuses the user\'s configuration, credentials, and ' +
    'authorization — always prefer it over installing a fresh copy of the same server.'
  readonly inputSchema = InputSchema
  readonly category = 'system' as const

  constructor(
    /** Settings registrations; absent = no registry access in this runtime. */
    private getRegistrations?: () => McpServerRegistration[],
  ) {}

  async execute(_input: unknown, workspace: AdfWorkspace): Promise<ToolResult> {
    if (!this.getRegistrations) {
      return {
        content: JSON.stringify({
          servers: [],
          message: 'No Settings registry is reachable in this runtime — use mcp_install to install servers directly.',
        }),
        isError: false,
      }
    }

    const config = workspace.getAgentConfig()
    const attachedNames = new Set((config.mcp?.servers ?? []).map((s) => s.name))
    const attachedSources = new Set((config.mcp?.servers ?? []).map((s) => s.source).filter(Boolean))

    const servers = (this.getRegistrations() ?? [])
      .filter((reg) => reg.name && isRegistrationAgentVisible(reg))
      .filter((reg) => !attachedNames.has(reg.name) && !attachedSources.has(registrationSourceIdentity(reg)))
      .map((reg) => {
        const registryEntry = reg.npmPackage
          ? findRegistryEntry(reg.npmPackage)
          : reg.pypiPackage ? findRegistryEntryByPypiPackage(reg.pypiPackage) : undefined
        return {
          name: reg.name,
          ...(reg.npmPackage ? { package: reg.npmPackage } : {}),
          ...(reg.pypiPackage ? { package: reg.pypiPackage } : {}),
          ...(reg.url ? { url: reg.url } : {}),
          location: locationLabel(reg),
          ...(reg.description || registryEntry?.description
            ? { description: reg.description ?? registryEntry?.description }
            : {}),
          ...(reg.auth ? { auth: true } : {}),
          ...(reg.lastVerifiedAt ? { verified: true } : {}),
        }
      })

    return {
      content: JSON.stringify({
        servers,
        message: servers.length
          ? `${servers.length} server(s) available to attach. Call mcp_install with the listed name or package to attach one — configuration and credentials come along.`
          : 'No unattached Settings servers are available to this agent.',
      }),
      isError: false,
    }
  }

  toProviderFormat(): ToolProviderFormat {
    return {
      name: this.name,
      description: this.description,
      input_schema: zodToJsonSchema(this.inputSchema) as Record<string, unknown>,
    }
  }
}
