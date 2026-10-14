import { IPC } from '../../../../shared/constants/ipc-channels'
import type { ClientFrame, PushTopic } from '../client-stream'
import type { DaemonJobView } from './jobs'

/**
 * MCP_INSTALL_PROGRESS, ADAPTER_INSTALL_PROGRESS and SANDBOX_INSTALL_PROGRESS
 * for installs Studio runs as daemon jobs.
 *
 * The daemon publishes every progress line and the end of each install on
 * the client stream's install topics (`mcp_install`, `adapter_install`,
 * `sandbox_install`, W2-B); the event bridge sends them, as embedded sends
 * them from its install handlers. The renderer's install UI waits for the
 * end push (the sandbox dialog finishes on it), so this relay covers the two
 * cases where the stream cannot deliver it:
 *
 * - the client stream carries no push topics (the interim GET /events
 *   adapter): the relay sends each progress line from the job's
 *   `progressLog` as it polls, and the end from the job's result;
 * - frames were lost while the install ran (`stream.gap`): once the job has
 *   ended, an end push that has not arrived within END_GRACE_MS is sent from
 *   the job's result, and logged.
 *
 * Otherwise it sends nothing: the stream's own pushes are the record.
 */

export type InstallChannel = typeof IPC.MCP_INSTALL_PROGRESS | typeof IPC.ADAPTER_INSTALL_PROGRESS | typeof IPC.SANDBOX_INSTALL_PROGRESS

export const INSTALL_TOPIC: Readonly<Record<InstallChannel, PushTopic>> = {
  [IPC.MCP_INSTALL_PROGRESS]: 'mcp_install',
  [IPC.ADAPTER_INSTALL_PROGRESS]: 'adapter_install',
  [IPC.SANDBOX_INSTALL_PROGRESS]: 'sandbox_install',
}

/** How long an end push may trail the job's end after a gap before the relay sends it. */
export const END_GRACE_MS = 1500

export interface InstallEnd {
  package: string
  status: 'installed' | 'error'
  error?: string
}

type Send = (channel: string, payload: unknown) => void

export class InstallProgressRelay {
  private carriesPushes = false
  private readonly watches = new Set<InstallWatch>()

  constructor(private readonly send: Send, private readonly log: Pick<Console, 'log' | 'warn'> = console, private readonly graceMs = END_GRACE_MS) {}

  /** Whether the client stream delivers push topics (a real client session does; the interim adapter does not). */
  setStreamCarriesPushes(carries: boolean): void {
    this.carriesPushes = carries
  }

  get streamCarriesPushes(): boolean {
    return this.carriesPushes
  }

  /** Every frame of the client stream, before the event bridge maps it. */
  observe(frame: ClientFrame): void {
    if (frame.kind !== 'push') return
    const payload = frame.payload as { package?: unknown; status?: unknown } | null
    if (!payload || typeof payload.package !== 'string' || (payload.status !== 'installed' && payload.status !== 'error')) return
    for (const watch of this.watches) watch.endArrived(frame.topic, payload.package)
  }

  /** The stream lost frames: an end push of an install now running may be among them. */
  onGap(): void {
    for (const watch of this.watches) watch.gapped = true
  }

  /** An install Studio is about to wait on. */
  begin(channel: InstallChannel, packages: readonly string[]): InstallWatch {
    const watch = new InstallWatch(this, channel, packages)
    this.watches.add(watch)
    return watch
  }

  /** @internal */
  relay(channel: InstallChannel, payload: unknown): void {
    this.send(channel, payload)
  }

  /** @internal */
  done(watch: InstallWatch): void {
    this.watches.delete(watch)
  }

  /** @internal */
  get grace(): number {
    return this.graceMs
  }

  /** @internal */
  get logger(): Pick<Console, 'log' | 'warn'> {
    return this.log
  }
}

export class InstallWatch {
  /** Frames were lost while this install ran. */
  gapped = false
  private lastSeq = 0
  private readonly ended = new Set<string>()
  private readonly waiters = new Set<() => void>()
  private readonly topic: PushTopic

  constructor(private readonly relay: InstallProgressRelay, private readonly channel: InstallChannel, private readonly packages: readonly string[]) {
    this.topic = INSTALL_TOPIC[channel]
  }

  /** @internal */
  endArrived(topic: PushTopic, pkg: string): void {
    if (topic !== this.topic || !this.packages.includes(pkg)) return
    this.ended.add(pkg)
    for (const wake of this.waiters) wake()
  }

  /** A poll of the install's job: progress lines the stream cannot deliver are sent from it. */
  progress(job: DaemonJobView): void {
    if (this.relay.streamCarriesPushes) return
    for (const entry of job.progressLog ?? []) {
      if (entry.seq <= this.lastSeq) continue
      this.lastSeq = entry.seq
      const pkg = typeof entry.detail?.package === 'string' ? entry.detail.package : this.packages[0]
      if (pkg === undefined) continue
      this.relay.relay(this.channel, { package: pkg, status: 'installing', progress: entry.text })
    }
  }

  /** The install ended (or Studio stopped waiting on it): each package's end push, where the stream cannot deliver it. */
  async finish(ends: readonly InstallEnd[]): Promise<void> {
    try {
      if (!this.relay.streamCarriesPushes) {
        for (const end of ends) this.relay.relay(this.channel, endPayload(end))
        return
      }
      if (!this.gapped) return
      const missing = () => ends.filter((end) => !this.ended.has(end.package))
      if (missing().length > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, this.relay.grace)
          const wake = (): void => { if (missing().length === 0) done() }
          function done(): void { clearTimeout(timer); resolve() }
          this.waiters.add(wake)
          void Promise.resolve().then(wake)
        })
      }
      for (const end of missing()) {
        this.relay.logger.log(`[Backend] The end of the ${end.package} install was lost in a client stream gap; sending it from the install's job result (${end.status})`)
        this.relay.relay(this.channel, endPayload(end))
      }
    } finally {
      this.waiters.clear()
      this.relay.done(this)
    }
  }
}

function endPayload(end: InstallEnd): Record<string, unknown> {
  return end.status === 'installed' ? { package: end.package, status: 'installed' } : { package: end.package, status: 'error', error: end.error }
}
