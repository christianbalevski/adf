import { describe, expect, it, vi } from 'vitest'
import { ComputeExecTool } from '../../../src/main/tools/built-in/compute-exec.tool'
import type { ExternalExecutionService } from '../../../src/main/services/external-execution.service'

describe('compute_exec external target', () => {
  it('routes through the single configured target and reports only its class to the agent', async () => {
    const execute = vi.fn().mockResolvedValue({ stdout: 'ok', stderr: '', code: 0 })
    const service = { execute } as unknown as ExternalExecutionService
    const target = {
      id: 'target-python',
      name: 'Python tools',
      kind: 'local-container' as const,
      engine: 'docker' as const,
      containerRef: 'python-tools',
      workdir: '/workspace',
    }
    const tool = new ComputeExecTool(null, {
      hasIsolated: false,
      hasShared: false,
      hasHost: false,
      externalTargets: { 'docker-python-tools': target },
      allowedTargets: ['docker-python-tools'],
      defaultTarget: 'docker-python-tools',
      agentId: 'agent-1',
    }, undefined, service)

    const result = await tool.execute({ command: 'python --version' }, {} as any)

    expect(execute).toHaveBeenCalledWith(target, 'python --version', 30_000)
    expect(result.isError).toBe(false)
    expect(JSON.parse(result.content)).toMatchObject({
      target: 'docker-python-tools',
      kind: 'external-container',
      engine: 'docker',
      target_name: 'Python tools',
      exit_code: 0,
      stdout: 'ok',
    })
    const schema = tool.toProviderFormat().input_schema as any
    expect(schema.properties.target).toBeUndefined()
    expect(tool.description).toContain('Commands run in docker-python-tools')
    expect(tool.description).not.toContain('host')
  })

  it('exposes an optional target only when multiple environments are allowed', () => {
    const tool = new ComputeExecTool(null, {
      hasIsolated: false,
      hasShared: true,
      hasHost: false,
      externalTargets: {
        'docker-python-tools': {
          id: 'target-python', name: 'Python tools', kind: 'local-container', engine: 'docker',
          containerRef: 'python-tools', workdir: '/workspace',
        },
      },
      allowedTargets: ['shared', 'docker-python-tools'],
      defaultTarget: 'shared',
      agentId: 'agent-1',
    })

    const schema = tool.toProviderFormat().input_schema as any
    expect(schema.properties.target.enum).toEqual(['shared', 'docker-python-tools'])
    expect(schema.required).not.toContain('target')
    expect(tool.description).toContain('Default target: shared')
  })
})
