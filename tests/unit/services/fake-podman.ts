/**
 * In-memory stand-in for the podman CLI, for PodmanService lifecycle tests.
 * Install it with `installFakePodman(service)`: it replaces the service's
 * process boundary (findPodman, exec0), so no test ever runs the real podman.
 * Only the subcommands the lifecycle paths use are answered; anything else
 * fails loudly so a new code path cannot silently reach for a real binary.
 */

import type { PodmanService } from '../../../src/main/services/podman.service'

export interface FakeContainer {
  name: string
  running: boolean
  /** `shared` = adf-mcp, `agent` = per-agent isolated, `legacy` = no ADF labels. */
  kind: 'shared' | 'agent' | 'legacy'
  agentId?: string
  agentName?: string
}

interface ExecResult { stdout: string; stderr: string; code: number; timedOut?: boolean }

const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', code: 0 })
const fail = (stderr: string): ExecResult => ({ stdout: '', stderr, code: 1 })

export class FakePodman {
  readonly containers = new Map<string, FakeContainer>()
  readonly calls: string[][] = []

  add(c: Partial<FakeContainer> & { name: string }): this {
    this.containers.set(c.name, {
      running: true,
      kind: c.name === 'adf-mcp' ? 'shared' : 'agent',
      ...c,
    })
    return this
  }

  /** Names passed to `podman stop`, in call order. */
  stopped(): string[] {
    return this.calls.filter((a) => a[0] === 'stop').map((a) => a[a.length - 1])
  }

  running(): string[] {
    return [...this.containers.values()].filter((c) => c.running).map((c) => c.name).sort()
  }

  private labels(c: FakeContainer): Record<string, string> {
    if (c.kind === 'legacy') return {}
    const labels: Record<string, string> = { 'io.adf.managed': 'true', 'io.adf.kind': c.kind }
    if (c.agentId) labels['io.adf.agent-id'] = c.agentId
    if (c.agentName) labels['io.adf.agent-name'] = c.agentName
    return labels
  }

  exec0 = async (_bin: string, args: string[]): Promise<ExecResult> => {
    this.calls.push(args)
    const [cmd, ...rest] = args
    if (cmd === 'ps') {
      return ok(JSON.stringify([...this.containers.values()].map((c) => ({
        Id: `${c.name}-id`,
        Names: [c.name],
        State: c.running ? 'running' : 'exited',
        Status: c.running ? 'Up 1 hour' : 'Exited (0)',
        Image: 'adf-test-image',
        Created: 1_753_084_800,
        Labels: this.labels(c),
      }))))
    }
    if (cmd === 'stop' || cmd === 'start') {
      const c = this.containers.get(rest[rest.length - 1])
      if (!c) return fail(`no such container ${rest[rest.length - 1]}`)
      c.running = cmd === 'start'
      return ok(c.name)
    }
    if (cmd === 'inspect' || (cmd === 'container' && rest[0] === 'inspect')) {
      const name = cmd === 'inspect' ? rest[0] : rest[1]
      const format = args[args.indexOf('--format') + 1] ?? ''
      const c = this.containers.get(name)
      if (!c) return fail(`no such container ${name}`)
      if (format.includes('State.Running')) return ok(String(c.running))
      if (format.includes('io.adf.managed')) return ok(this.labels(c)['io.adf.managed'] ?? '')
      if (format.includes('json .Config.Labels')) return ok(JSON.stringify(this.labels(c)))
      // Peer-isolation label probe: unlabeled → applyPeerFirewall skips.
      return ok('')
    }
    if (cmd === 'machine' && rest[0] === 'list') return ok('true')
    if (cmd === 'exec') return this.containers.get(rest[0])?.running ? ok('') : fail(`container state improper: ${rest[0]} is not running`)
    return fail(`fake podman: unsupported command: ${args.join(' ')}`)
  }
}

/** Point a PodmanService at a FakePodman (process boundary only). */
export function installFakePodman(service: PodmanService, fake: FakePodman = new FakePodman()): FakePodman {
  ;(service as unknown as { findPodman: () => Promise<string> }).findPodman = async () => '/fake/podman'
  ;(service as unknown as { exec0: FakePodman['exec0'] }).exec0 = fake.exec0
  return fake
}
