// Characterization of Studio's TOOLS_DESCRIPTIONS body (ipc/index.ts),
// written against it before it moved into services/tool-descriptions.ts (rule
// E1): every built-in tool in provider format, then the open agent's tools
// that are not built in, then stub instances of the runtime tools that need
// per-agent dependencies, then the code-execution-only method schemas. A name
// already present is never overwritten.
import { describe, expect, it } from 'vitest'
import { AdfCallHandler } from '../../../src/main/runtime/adf-call-handler'
import { CodeSandboxService } from '../../../src/main/runtime/code-sandbox'
import { SandboxPackagesService } from '../../../src/main/services/sandbox-packages.service'
import { buildToolDescriptions, RUNTIME_STUB_TOOL_NAMES } from '../../../src/main/services/tool-descriptions'
import { registerBuiltInTools } from '../../../src/main/tools/built-in/register-built-in-tools'
import { ToolRegistry } from '../../../src/main/tools/tool-registry'

function builtIns(): ToolRegistry {
  const registry = new ToolRegistry()
  registerBuiltInTools(registry)
  return registry
}

describe('buildToolDescriptions', () => {
  const deps = { codeSandboxService: new CodeSandboxService(), sandboxPackagesService: new SandboxPackagesService() }

  it('covers the built-ins, the runtime stubs and the code-execution schemas', () => {
    const base = builtIns()
    const out = buildToolDescriptions([base], deps)
    for (const tool of base.getAll()) expect(out[tool.name]).toEqual(tool.toProviderFormat())
    for (const name of RUNTIME_STUB_TOOL_NAMES) expect(out[name]).toBeTruthy()
    for (const name of Object.keys(AdfCallHandler.getCodeExecutionSchemas())) expect(out[name]).toBeTruthy()
    expect(RUNTIME_STUB_TOOL_NAMES).toEqual([
      'sys_code', 'sys_lambda', 'msg_send', 'agent_discover', 'npm_install', 'npm_uninstall', 'fs_transfer',
      'mcp_install', 'mcp_uninstall', 'mcp_restart', 'compute_exec', 'ws_connect', 'ws_disconnect', 'ws_connections', 'ws_send',
    ])
  })

  it('an agent registry adds its own tools without overwriting a built-in', () => {
    const base = builtIns()
    const first = base.getAll()[0]
    const agent = {
      getAll: () => [
        { name: 'mcp_acme_search', toProviderFormat: () => ({ name: 'mcp_acme_search', description: 'Search' }) },
        { name: first.name, toProviderFormat: () => ({ name: first.name, description: 'shadow' }) },
      ],
    }
    const out = buildToolDescriptions([base, agent, null], deps)
    expect(out.mcp_acme_search).toEqual({ name: 'mcp_acme_search', description: 'Search' })
    expect(out[first.name]).toEqual(first.toProviderFormat())
  })
})
