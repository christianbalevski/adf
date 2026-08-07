import { describe, expect, it } from 'vitest'
import { PodmanStdioTransport } from '../../../src/main/services/podman-stdio-transport'

const baseOpts = {
  podmanBin: '/usr/bin/podman',
  containerName: 'adf-agent-12345678',
  command: 'npx',
  args: ['-y', '@playwright/mcp', '--cdp-endpoint', 'http://127.0.0.1:9222'],
  cwd: '/workspace',
  env: { FOO: 'bar', ELECTRON_RUN_AS_NODE: '1' },
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

    const shIdx = args.indexOf('sh')
    expect(args[shIdx + 1]).toBe('-c')
    const wrapper = args[shIdx + 2]
    expect(wrapper).toContain('echo "__ADF_PID_$$__" >&2')
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
