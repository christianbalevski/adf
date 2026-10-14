import { EventEmitter } from 'node:events'
import { promisify } from 'node:util'

/**
 * Container compute for the parity harness: a machine without Podman.
 *
 * Safety, not convenience: the real PodmanService's shutdown path
 * (`stopAll`, reached from Studio's cleanupAllProcesses and the daemon's
 * stop) stops EVERY running adf-* container on the machine, including the
 * owner's. So the harness never constructs it. `FakePodmanService` replaces
 * the class; and as a second fence, `guardChildProcess` refuses to spawn
 * `podman` or `wsl` at all, whoever asks.
 *
 * Calls are recorded in `ComputeLog.calls` for the safety assertion only.
 * They are not part of the parity comparison: which internal compute calls a
 * backend makes is not visible to the user.
 */

export interface ComputeLog {
  calls: string[]
  /** podman/wsl spawn attempts that were refused. */
  refusedSpawns: string[]
}

export function createComputeLog(): ComputeLog {
  return { calls: [], refusedSpawns: [] }
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

const FORBIDDEN_BINARIES = /^(podman|wsl)(\.exe|\.cmd)?$/i

type AnyFn = (...args: unknown[]) => unknown

/**
 * `child_process` with podman/wsl refused. Everything else passes through
 * (the sandbox host and MCP servers spawn other binaries legitimately).
 */
export function guardChildProcess<T extends Record<string, unknown>>(actual: T, log: ComputeLog): T {
  const wrap = (name: string, original: AnyFn): AnyFn => function guarded(this: unknown, ...args: unknown[]) {
    const command = typeof args[0] === 'string' ? args[0] : ''
    // exec/execSync take a shell line (first token, maybe quoted); the others take the file itself.
    const shellLine = name === 'exec' || name === 'execSync'
    const m = shellLine ? /^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(command) : null
    const first = shellLine ? (m?.[1] ?? m?.[2] ?? m?.[3] ?? '') : command
    if (FORBIDDEN_BINARIES.test(first.split(/[\\/]/).pop() ?? '')) {
      log.refusedSpawns.push(`${name} ${command}`)
      throw new Error(`parity harness: spawning ${first} is forbidden`)
    }
    return original.apply(this, args)
  }
  const guard = (name: string) => {
    const original = actual[name] as (AnyFn & { [promisify.custom]?: AnyFn }) | undefined
    if (typeof original !== 'function') return original
    const guarded = wrap(name, original) as AnyFn & { [promisify.custom]?: AnyFn }
    // exec/execFile resolve `{ stdout, stderr }` under promisify only through this symbol.
    const custom = original[promisify.custom]
    if (typeof custom === 'function') guarded[promisify.custom] = wrap(name, custom)
    return guarded
  }
  const out: Record<string, unknown> = { ...actual }
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) out[name] = guard(name)
  out.default = out
  return out as T
}
