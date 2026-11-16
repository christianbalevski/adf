import { describe, it, expect, afterAll } from 'vitest'
import { AsyncLocalStorage } from 'node:async_hooks'
import { CodeSandboxService } from '../../../src/main/runtime/code-sandbox'
import { shutdownSandboxHosts } from '../../../src/main/runtime/sandbox-host'

/**
 * adf.* calls run in the async context of the execution that made them. The
 * sandbox host's message listener lives in the context the host was spawned
 * in, so without binding, a task's context (its signal and task id) would
 * leak into every later call on that host.
 */
describe('CodeSandboxService adf.* call context', () => {
  const sandbox = new CodeSandboxService()
  afterAll(() => sandbox.destroyAll())

  it("a call sees its own execution's context, never the one the host was spawned under", async () => {
    shutdownSandboxHosts() // the next execution spawns the host, inside 'task-A'
    const als = new AsyncLocalStorage<string>()
    const probe = async () => ({ result: JSON.stringify(als.getStore() ?? 'none') })
    const code = 'return await adf.probe({})'

    const inTask = await als.run('task-A', () => sandbox.execute('ctx-task', code, 5000, probe))
    expect(inTask.result).toBe('task-A')

    const outside = await sandbox.execute('ctx-plain', code, 5000, probe)
    expect(outside.result).toBe('none')

    const otherTask = await als.run('task-B', () => sandbox.execute('ctx-plain', code, 5000, probe))
    expect(otherTask.result).toBe('task-B')
  })
})
