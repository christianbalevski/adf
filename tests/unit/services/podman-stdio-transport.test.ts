import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { describe, expect, it, vi } from 'vitest'
import { spawn } from 'child_process'
import { PodmanStdioTransport } from '../../../src/main/services/podman-stdio-transport'

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

const baseOpts = {
  podmanBin: '/usr/bin/podman',
  containerName: 'adf-agent-12345678',
  command: 'npx',
  args: ['-y', '@playwright/mcp', '--cdp-endpoint', 'http://127.0.0.1:9222'],
  cwd: '/workspace',
  env: { HOME: '/workspace/agent-1/home', FOO: 'bar', ELECTRON_RUN_AS_NODE: '1' },
}

describe('PodmanStdioTransport exec args', () => {
  it('wraps the command in an sh PID-capture wrapper preserving argv', () => {
    const transport = new PodmanStdioTransport({ ...baseOpts })
    const args = (transport as any).buildExecArgs() as string[]

    expect(args.slice(0, 3)).toEqual(['exec', '-i', '-w'])
    expect(args).toContain('adf-agent-12345678')
    // Blocked env not forwarded
    expect(args.join(' ')).not.toContain('ELECTRON_RUN_AS_NODE')
    expect(args).toContain('FOO=bar')
    expect(args).toContain('HOME=/workspace/agent-1/home')

    const shIdx = args.indexOf('sh')
    expect(args[shIdx + 1]).toBe('-c')
    const wrapper = args[shIdx + 2]
    expect(wrapper).toContain('echo "__ADF_PID_$$__" >&2')
    // Agent-scoped HOME: created on demand by the wrapper, guarded on HOME being set
    expect(wrapper).toContain('[ -n "$HOME" ] && mkdir -p "$HOME"')
    expect(wrapper).toContain('exec "$@"')
    expect(wrapper).toContain('npm_config_cache=/var/cache/adf-npm')
    // $0 placeholder, then the original command + args verbatim
    expect(args.slice(shIdx + 3)).toEqual([
      'sh', 'npx', '-y', '@playwright/mcp', '--cdp-endpoint', 'http://127.0.0.1:9222',
    ])
  })
})

describe('PodmanStdioTransport PID sentinel parsing', () => {
  it('captures the in-container PID and strips the sentinel from stderr', () => {
    const transport = new PodmanStdioTransport({ ...baseOpts })
    const out = (transport as any).filterStderrChunk('__ADF_PID_4242__\nserver warming up\n')
    expect(out).toBe('server warming up\n')
    expect(transport.containerPid).toBe(4242)
    // Later chunks pass through untouched
    expect((transport as any).filterStderrChunk('more output')).toBe('more output')
  })

  it('handles a sentinel split across chunks', () => {
    const transport = new PodmanStdioTransport({ ...baseOpts })
    expect((transport as any).filterStderrChunk('__ADF_PID_7')).toBe('')
    expect((transport as any).filterStderrChunk('7__\nrest')).toBe('rest')
    expect(transport.containerPid).toBe(77)
  })

  it('captures the PID even when podman prints warnings first', () => {
    const transport = new PodmanStdioTransport({ ...baseOpts })
    const out = (transport as any).filterStderrChunk('WARN some podman notice\n__ADF_PID_9__\n')
    expect(out).toBe('WARN some podman notice\n')
    expect(transport.containerPid).toBe(9)
  })

  it('gives up scanning and flushes after the scan limit', () => {
    const transport = new PodmanStdioTransport({ ...baseOpts })
    const noise = 'x'.repeat(9000)
    const out = (transport as any).filterStderrChunk(noise)
    expect(out).toBe(noise)
    expect(transport.containerPid).toBeNull()
    // Subsequent chunks flow directly
    expect((transport as any).filterStderrChunk('tail')).toBe('tail')
  })
})

describe('PodmanStdioTransport distroless sh fallback', () => {
  it('recognizes OCI runtime shell-missing errors', () => {
    expect(PodmanStdioTransport.isShellMissingError(
      'Error: crun: executable file `sh` not found in $PATH: No such file or directory: OCI runtime attempted to invoke a command that was not found'
    )).toBe(true)
    expect(PodmanStdioTransport.isShellMissingError(
      'exec container process `/bin/sh`: No such file or directory'
    )).toBe(true)
    expect(PodmanStdioTransport.isShellMissingError(
      'exec: "sh": executable file not found in $PATH'
    )).toBe(true)
    expect(PodmanStdioTransport.isShellMissingError('server crashed: connection refused')).toBe(false)
  })

  it('builds direct exec args (no wrapper) once fallback is active', () => {
    const transport = new PodmanStdioTransport({ ...baseOpts })
    ;(transport as any)._useWrapper = false
    const args = (transport as any).buildExecArgs() as string[]
    expect(args).not.toContain('sh')
    expect(args).not.toContain('-c')
    const containerIdx = args.indexOf('adf-agent-12345678')
    expect(args.slice(containerIdx + 1)).toEqual([
      'npx', '-y', '@playwright/mcp', '--cdp-endpoint', 'http://127.0.0.1:9222',
    ])
  })

  it('respawns directly and replays buffered messages when the container has no sh', async () => {
    const spawnMock = vi.mocked(spawn)
    const procs: any[] = []
    spawnMock.mockImplementation((() => {
      const proc: any = new EventEmitter()
      proc.pid = 100 + procs.length
      proc.exitCode = null
      proc.stdin = new PassThrough()
      proc.stdout = new PassThrough()
      proc.stderr = new PassThrough()
      proc.kill = vi.fn()
      procs.push(proc)
      setImmediate(() => proc.emit('spawn'))
      return proc
    }) as any)
    try {
      const transport = new PodmanStdioTransport({ ...baseOpts })
      const onclose = vi.fn()
      transport.onclose = onclose
      await transport.start()
      await transport.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } as any)

      const first = procs[0]
      first.stderr.emit('data', Buffer.from(
        'Error: crun: executable file `sh` not found in $PATH: No such file or directory'
      ))
      first.emit('close', 127)

      // Respawned without the wrapper, transport still open
      expect(procs).toHaveLength(2)
      expect(onclose).not.toHaveBeenCalled()
      const fallbackArgs = spawnMock.mock.calls[1][1] as string[]
      expect(fallbackArgs).not.toContain('-c')
      expect(fallbackArgs).toContain('npx')

      // The initialize request was replayed into the new process
      const replayed = procs[1].stdin.read()?.toString() ?? ''
      expect(replayed).toContain('"initialize"')

      // A real close of the fallback process still reaches onclose
      procs[1].emit('close', 0)
      expect(onclose).toHaveBeenCalledTimes(1)
    } finally {
      spawnMock.mockReset()
    }
  })
})
