import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'

import { AdfWorkspace } from '../../src/main/adf/adf-workspace'
import { AgentRuntimeBuilder } from '../../src/main/runtime/agent-runtime-builder'
import { MockLLMProvider } from '../../src/main/runtime/headless'

const CHECKPOINT_KEY = 'adf_runtime_turn_checkpoint'
const CHILD_READY_PREFIX = 'CHECKPOINT_READY '
const CHILD_TIMEOUT_MS = 15_000

function waitForCheckpoint(child: ChildProcess, stderr: () => string): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for crash fixture checkpoint. stderr:\n${stderr()}`))
    }, CHILD_TIMEOUT_MS)

    const onData = (chunk: Buffer) => {
      stdout += chunk.toString()
      if (!stdout.split('\n').some(line => line.startsWith(CHILD_READY_PREFIX))) return
      cleanup()
      resolve()
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup()
      reject(new Error(
        `Crash fixture exited before checkpoint readiness (code=${code}, signal=${signal}). stderr:\n${stderr()}`,
      ))
    }
    const cleanup = () => {
      clearTimeout(timeout)
      child.stdout?.off('data', onData)
      child.off('error', onError)
      child.off('exit', onExit)
    }

    child.stdout?.on('data', onData)
    child.once('error', onError)
    child.once('exit', onExit)
  })
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }
  return new Promise(resolve => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
}

describe('assembled-agent crash checkpoint recovery', () => {
  it('recovers a checkpoint left by a killed child process without replaying the turn', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'adf-lifecycle-crash-recovery-'))
    const filePath = join(tempDir, 'crashed-agent.adf')
    const fixturePath = fileURLToPath(new URL('./fixtures/checkpoint-crash-child.ts', import.meta.url))
    const childBundlePath = join(tempDir, 'checkpoint-crash-child.mjs')
    const nodeModulesPath = realpathSync(fileURLToPath(new URL('../../node_modules', import.meta.url)))
    let stderr = ''
    let child: ChildProcess | null = null

    try {
      // Bundle repo TypeScript while keeping third-party packages external. The
      // temporary node_modules link lets ordinary ESM resolution find those
      // packages from the isolated fixture directory.
      symlinkSync(nodeModulesPath, join(tempDir, 'node_modules'), 'dir')
      await build({
        entryPoints: [fixturePath],
        outfile: childBundlePath,
        bundle: true,
        format: 'esm',
        platform: 'node',
        packages: 'external',
        target: 'node22',
      })

      child = spawn(process.execPath, [childBundlePath, filePath], {
        cwd: fileURLToPath(new URL('../..', import.meta.url)),
        env: { ...process.env, NODE_ENV: 'test' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

      await waitForCheckpoint(child, () => stderr)
      const exited = waitForExit(child)
      expect(child.kill('SIGKILL')).toBe(true)
      await expect(exited).resolves.toMatchObject({ signal: 'SIGKILL' })
      child = null

      const workspace = AdfWorkspace.open(filePath)
      const provider = new MockLLMProvider()
      const agent = await new AgentRuntimeBuilder().build({
        workspace,
        filePath,
        config: workspace.getAgentConfig(),
        provider,
        restoreLoop: true,
      })

      try {
        const checkpoint = JSON.parse(workspace.getMeta(CHECKPOINT_KEY) ?? 'null')
        expect(checkpoint).toMatchObject({
          status: 'interrupted',
          event_type: 'chat',
          scope: 'agent',
          replay: 'not_replayed',
          reason: 'stale_checkpoint_recovered_on_load',
        })

        expect(provider.getCallCount()).toBe(0)
        expect(workspace.getLogs(20).filter(log => log.event === 'turn_checkpoint_recovered')).toHaveLength(1)
        expect(workspace.getLoop().filter(entry =>
          entry.role === 'user' && entry.content_json.some(block =>
            block.type === 'text' && block.text.includes('was interrupted before clean completion'),
          )
        )).toHaveLength(1)
      } finally {
        await agent.disposeAsync({ mode: 'immediate' })
      }
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await waitForExit(child)
      }
      rmSync(tempDir, { recursive: true, force: true })
    }
  }, 30_000)
})
