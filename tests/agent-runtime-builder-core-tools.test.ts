import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { AdfWorkspace } from '../src/main/adf/adf-workspace'
import { AgentRuntimeBuilder } from '../src/main/runtime/agent-runtime-builder'
import { createHeadlessAgent, MockLLMProvider } from '../src/main/runtime/headless'
import type { AgentConfig } from '../src/shared/types/adf-v02.types'

// Characterization of the builder's core-tool declarations (design §6 row
// "Core tool declarations"). Written against the builder's private copy and
// kept passing after the builder switched to the shared
// runtime/core-tool-declarations.ts helper the Studio hosts use.

function makeAgentFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'adf-builder-core-tools-'))
  const filePath = join(dir, `${name}.adf`)
  createHeadlessAgent({ filePath, name, provider: new MockLLMProvider() }).dispose()
  return filePath
}

function decl(config: AgentConfig, name: string) {
  return config.tools.find(t => t.name === name)
}

describe('AgentRuntimeBuilder core tool declarations', () => {
  it('adds the inbox and stream-binding declarations to the running config and the file', async () => {
    const filePath = makeAgentFile('agent-1')
    const workspace = AdfWorkspace.open(filePath)
    workspace.setAgentConfig({
      ...workspace.getAgentConfig(),
      tools: [
        { name: 'fs_read', enabled: true, visible: true },
        { name: 'msg_read', enabled: false, visible: false },
        { name: 'container_exec', enabled: true, visible: true },
      ],
    })
    const config = workspace.getAgentConfig()

    const agent = await new AgentRuntimeBuilder().build({ workspace, filePath, config, provider: new MockLLMProvider() })
    try {
      // Running config.
      expect(decl(config, 'msg_list')).toEqual({ name: 'msg_list', enabled: true, visible: true })
      expect(decl(config, 'msg_update')).toEqual({ name: 'msg_update', enabled: true, visible: true })
      for (const name of ['stream_bind', 'stream_unbind', 'stream_bindings']) {
        expect(decl(config, name)).toMatchObject({ name, enabled: false })
        expect(decl(config, name)?.visible).not.toBe(true)
      }
      // An owner's existing declaration is never touched.
      expect(decl(config, 'msg_read')).toEqual({ name: 'msg_read', enabled: false, visible: false })
      // Legacy compute declaration renamed for the running agent.
      expect(decl(config, 'container_exec')).toBeUndefined()
      expect(decl(config, 'compute_exec')).toMatchObject({ enabled: true, visible: true })

      // File.
      const onDisk = workspace.getAgentConfig()
      expect(decl(onDisk, 'msg_list')).toEqual({ name: 'msg_list', enabled: true, visible: true })
      expect(decl(onDisk, 'stream_bind')).toMatchObject({ name: 'stream_bind', enabled: false })
      expect(decl(onDisk, 'msg_read')).toEqual({ name: 'msg_read', enabled: false, visible: false })
      expect(decl(onDisk, 'fs_read')).toEqual({ name: 'fs_read', enabled: true, visible: true })
    } finally {
      await agent.disposeAsync()
    }
  })

  it('leaves the file alone when every core declaration exists', async () => {
    const filePath = makeAgentFile('agent-2')
    const workspace = AdfWorkspace.open(filePath)
    const tools = [
      { name: 'msg_list', enabled: false, visible: false },
      { name: 'msg_read', enabled: true, visible: true },
      { name: 'msg_update', enabled: true, visible: true },
      { name: 'stream_bind', enabled: true, visible: true },
      { name: 'stream_unbind', enabled: false, visible: false },
      { name: 'stream_bindings', enabled: false, visible: false },
    ]
    workspace.setAgentConfig({ ...workspace.getAgentConfig(), tools })
    const before = workspace.getAgentConfig().metadata?.updated_at

    const config = workspace.getAgentConfig()
    const agent = await new AgentRuntimeBuilder().build({ workspace, filePath, config, provider: new MockLLMProvider() })
    try {
      expect(workspace.getAgentConfig().tools.slice(0, tools.length)).toEqual(tools)
      expect(decl(config, 'msg_list')).toEqual({ name: 'msg_list', enabled: false, visible: false })
      expect(workspace.getAgentConfig().metadata?.updated_at).toBe(before)
    } finally {
      await agent.disposeAsync()
    }
  })

  // Shared-helper behaviour the private copy lacked: it wrote the whole
  // start-time config back, reverting any field changed on disk since it was read.
  it('persists the declarations onto a fresh read of the file', async () => {
    const filePath = makeAgentFile('agent-3')
    const workspace = AdfWorkspace.open(filePath)
    // Reads fill in every built-in declaration, so a start config missing the
    // core tools is one a host built itself (as a create path does).
    const config = { ...workspace.getAgentConfig(), tools: [{ name: 'fs_read', enabled: true, visible: true }] }
    workspace.setAgentConfig({ ...workspace.getAgentConfig(), description: 'edited after the start read' })

    const agent = await new AgentRuntimeBuilder().build({ workspace, filePath, config, provider: new MockLLMProvider() })
    try {
      const onDisk = workspace.getAgentConfig()
      expect(onDisk.description).toBe('edited after the start read')
      expect(decl(onDisk, 'msg_list')).toEqual({ name: 'msg_list', enabled: true, visible: true })
      expect(decl(onDisk, 'fs_write')).toBeTruthy()
      expect(decl(config, 'msg_list')).toEqual({ name: 'msg_list', enabled: true, visible: true })
    } finally {
      await agent.disposeAsync()
    }
  })
})
