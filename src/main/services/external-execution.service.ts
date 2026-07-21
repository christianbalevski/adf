import { execFile } from 'node:child_process'
import { accessSync, constants as fsConstants } from 'node:fs'
import { platform } from 'node:os'
import type {
  ContainerEngine,
  ExecutionTargetProbeResult,
  LocalContainerExecutionTarget,
} from '../../shared/types/compute.types'

interface ExecResult {
  stdout: string
  stderr: string
  code: number
}

const ENGINE_LOCATIONS: Record<ContainerEngine, Partial<Record<NodeJS.Platform, string[]>>> = {
  docker: {
    darwin: ['/usr/local/bin/docker', '/opt/homebrew/bin/docker'],
    linux: ['/usr/bin/docker', '/usr/local/bin/docker'],
    win32: ['C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe'],
  },
  podman: {
    darwin: ['/opt/homebrew/bin/podman', '/usr/local/bin/podman'],
    linux: ['/usr/bin/podman', '/usr/local/bin/podman'],
    win32: ['C:\\Program Files\\RedHat\\Podman\\podman.exe'],
  },
}

/** Read-only lifecycle adapter for user-owned local containers. */
export class ExternalExecutionService {
  private readonly binaryCache = new Map<ContainerEngine, string>()

  async probe(target: LocalContainerExecutionTarget): Promise<ExecutionTargetProbeResult> {
    try {
      validateTarget(target)
      const bin = await this.findEngineBinary(target.engine)
      const versionResult = await run(bin, ['version', '--format', '{{.Client.Version}}'], 10_000)
      const inspect = await this.inspect(bin, target)

      if (!inspect.running) {
        return {
          success: false,
          error: `Container "${target.containerRef}" is not running. ADF will not start external containers.`,
          engine: target.engine,
          engineVersion: versionResult.stdout,
          ...inspect,
        }
      }

      const ready = await run(bin, [
        'exec', '-w', target.workdir, target.containerRef,
        'sh', '-lc', 'printf adf-ready',
      ], 10_000)
      if (ready.code !== 0 || ready.stdout !== 'adf-ready') {
        throw new Error(ready.stderr || `Container must provide sh and a usable ${target.workdir} working directory.`)
      }

      return {
        success: true,
        engine: target.engine,
        engineVersion: versionResult.stdout,
        ...inspect,
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err), engine: target.engine }
    }
  }

  async execute(
    target: LocalContainerExecutionTarget,
    command: string,
    timeoutMs: number,
  ): Promise<ExecResult> {
    validateTarget(target)
    const bin = await this.findEngineBinary(target.engine)
    const inspect = await this.inspect(bin, target)
    if (!inspect.running) {
      throw new Error(`External container "${target.containerRef}" is not running. Start it outside ADF and retry.`)
    }

    return run(bin, [
      'exec', '-w', target.workdir, target.containerRef,
      'sh', '-lc', command,
    ], timeoutMs)
  }

  private async inspect(
    bin: string,
    target: LocalContainerExecutionTarget,
  ): Promise<{
    containerId: string
    containerName: string
    image: string
    running: boolean
  }> {
    const result = await run(bin, ['inspect', target.containerRef], 10_000)
    if (result.code !== 0) {
      throw new Error(result.stderr || `${target.engine} could not inspect container "${target.containerRef}".`)
    }

    let raw: any
    try {
      const parsed = JSON.parse(result.stdout)
      raw = Array.isArray(parsed) ? parsed[0] : parsed
    } catch {
      throw new Error(`${target.engine} returned invalid inspect data for "${target.containerRef}".`)
    }

    const containerId = String(raw?.Id ?? raw?.ID ?? '')
    if (!containerId) throw new Error(`Container "${target.containerRef}" has no stable ID.`)
    if (target.expectedContainerId && !sameContainerId(target.expectedContainerId, containerId)) {
      throw new Error(
        `Container reference "${target.containerRef}" now resolves to a different container. ` +
        'Update or re-test the execution target before using it.',
      )
    }

    return {
      containerId,
      containerName: String(raw?.Name ?? raw?.Config?.Hostname ?? target.containerRef).replace(/^\//, ''),
      image: String(raw?.Config?.Image ?? raw?.ImageName ?? raw?.Image ?? ''),
      running: raw?.State?.Running === true || raw?.State?.Status === 'running',
    }
  }

  private async findEngineBinary(engine: ContainerEngine): Promise<string> {
    const cached = this.binaryCache.get(engine)
    if (cached) return cached

    const which = await run(platform() === 'win32' ? 'where' : 'which', [engine], 5_000)
    const discovered = which.code === 0 ? which.stdout.split(/\r?\n/)[0]?.trim() : ''
    if (discovered) {
      this.binaryCache.set(engine, discovered)
      return discovered
    }

    for (const candidate of ENGINE_LOCATIONS[engine][platform()] ?? []) {
      try {
        accessSync(candidate, fsConstants.X_OK)
        this.binaryCache.set(engine, candidate)
        return candidate
      } catch { /* try the next known location */ }
    }

    throw new Error(`${engine === 'docker' ? 'Docker' : 'Podman'} CLI was not found.`)
  }
}

export function validateTarget(target: LocalContainerExecutionTarget): void {
  if (target.kind !== 'local-container') throw new Error('Unsupported execution target kind.')
  if (!target.id.trim()) throw new Error('Execution target ID is required.')
  if (!target.name.trim()) throw new Error('Execution target name is required.')
  if (!target.containerRef.trim() || target.containerRef.startsWith('-')) {
    throw new Error('Container name or ID is invalid.')
  }
  if (!target.workdir.startsWith('/') || target.workdir.includes('\0')) {
    throw new Error('Container working directory must be an absolute Unix path.')
  }
}

function sameContainerId(expected: string, actual: string): boolean {
  return expected === actual || expected.startsWith(actual) || actual.startsWith(expected)
}

function run(command: string, args: string[], timeout: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      const errorCode = (error as (NodeJS.ErrnoException & { code?: number }) | null)?.code
      const code = typeof errorCode === 'number' ? errorCode : error ? 1 : 0
      resolve({ stdout: stdout?.trim() ?? '', stderr: stderr?.trim() ?? '', code })
    })
  })
}
