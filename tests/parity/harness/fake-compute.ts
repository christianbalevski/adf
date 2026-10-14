import { EventEmitter } from 'node:events'

/**
 * Container compute for the parity harness: a machine without Podman.
 *
 * Safety, not convenience: the real PodmanService's shutdown path
 * (`stopAll`, reached from Studio's cleanupAllProcesses and the daemon's
 * stop) stops EVERY running adf-* container on the machine, including the
 * owner's. So the harness never constructs it: `FakePodmanService` replaces
 * the class. The second fence, refusing any podman/wsl spawn, is fence.cjs.
 *
 * Calls are recorded in `ComputeLog.calls` for the safety assertion only.
 * They are not part of the parity comparison: which internal compute calls a
 * backend makes is not visible to the user.
 */

export interface ComputeLog {
  calls: string[]
}

export function createComputeLog(): ComputeLog {
  return { calls: [] }
}

const NOT_INSTALLED = 'Podman not found on this system.'

/** The members Studio main and the background manager call, answered as a Podman-less machine does. */
export function createFakePodmanServiceClass(log: ComputeLog): new () => EventEmitter {
  return class FakePodmanService extends EventEmitter {
    constructor() {
      super()
      const own = new Set(Object.getOwnPropertyNames(FakePodmanService.prototype))
      return new Proxy(this, {
        get(target, prop, receiver) {
          if (typeof prop === 'symbol' || prop in target) {
            if (typeof prop === 'string' && own.has(prop)) log.calls.push(prop)
            return Reflect.get(target, prop, receiver)
          }
          // Anything else would need a real container: fail the way a missing Podman does.
          log.calls.push(`${prop} (unsupported)`)
          return async () => { throw new Error(NOT_INSTALLED) }
        },
      })
    }
    getStatus() { return { status: 'not_installed', containerName: 'adf-mcp', activeAgents: [], error: NOT_INSTALLED } }
    isRunning() { return false }
    setSettingsAccessor(_fn: unknown) {}
    async findPodman() { return null }
    async sharedContainerExists() { return false }
    async containerPhase(_name: string) { return { phase: 'absent' } }
    async listContainers() { return [] }
    async pendingStarts() {}
    beginShutdown() {}
    async registerAgent(_agentId: string) {}
    unregisterAgent(_agentId: string) {}
    async stop() {}
    async stopAll() {}
    async stopIsolated(_name: string, _id: string) {}
    async stopContainer(_name: string) { return false }
    async startContainer(_name: string) { return false }
    async destroyContainer(_name: string) { return false }
    async ensureRunning() { throw new Error(NOT_INSTALLED) }
    async ensureIsolatedRunning() { throw new Error(NOT_INSTALLED) }
    async ensureWorkspace() { throw new Error(NOT_INSTALLED) }
    async execInContainer() { throw new Error(NOT_INSTALLED) }
    getExecLog() { return [] }
  }
}
