import { IPC } from '../../../../shared/constants/ipc-channels'
import type { ClientFrame, PushTopic } from '../client-stream'

/**
 * MCP_INSTALL_PROGRESS, ADAPTER_INSTALL_PROGRESS and SANDBOX_INSTALL_PROGRESS
 * for installs Studio runs as daemon jobs.
 *
 * The daemon publishes every progress line and the end of each install on
 * the client stream's install topics (`mcp_install`, `adapter_install`,
 * `sandbox_install`, W2-B); the event bridge sends them, as embedded sends
 * them from its install handlers. The renderer's install UI waits for the
 * end push (the sandbox dialog finishes on it), so this relay covers the one
 * case where the stream cannot deliver it: frames were lost while the
 * install ran (`stream.gap`). Once the job has ended, an end push that has
 * not arrived within END_GRACE_MS is sent from the job's result, and logged.
 *
 * Otherwise it sends nothing: the stream's own pushes are the record. The
 * install's answer still waits for them (W4-B review): the job poll can see
 * the job end before the stream has delivered its last progress lines (a
 * remote daemon, a proxy), and embedded answers only after its last push.
 * Each package's end push is the stream's watermark for that install (the
 * daemon sends it after the install's progress lines, in order on one
 * connection); the answer waits for every end, up to END_WAIT_MS, then sends
 * a missing one from the result as after a gap.
 *
 * An end sent from the result is the install's end for the renderer: when
 * the stream's own end arrives later, it is dropped, and logged, so the
 * install never ends twice (W4-B follow-up). The next progress line of that
 * package ends the drop: it starts another install (another client's, the
 * CLI's), whose pushes must all reach the renderer, so only an end that
 * follows the relayed one directly is dropped.
 */

export type InstallChannel = typeof IPC.MCP_INSTALL_PROGRESS | typeof IPC.ADAPTER_INSTALL_PROGRESS | typeof IPC.SANDBOX_INSTALL_PROGRESS

export const INSTALL_TOPIC: Readonly<Record<InstallChannel, PushTopic>> = {
  [IPC.MCP_INSTALL_PROGRESS]: 'mcp_install',
  [IPC.ADAPTER_INSTALL_PROGRESS]: 'adapter_install',
  [IPC.SANDBOX_INSTALL_PROGRESS]: 'sandbox_install',
}

/** How long an end push may trail the job's end after a gap before the relay sends it. */
export const END_GRACE_MS = 1500
/** How long the answer waits for the stream to deliver an install's end push when no gap was seen. */
export const END_WAIT_MS = 15_000
/** How long a late stream push of an install whose end was sent from its result is still dropped. */
export const LATE_END_DROP_MS = 10 * 60_000

export interface InstallEnd {
  package: string
  status: 'installed' | 'error'
  error?: string
}

type Send = (channel: string, payload: unknown) => void

export class InstallProgressRelay {
  private readonly watches = new Set<InstallWatch>()
  /** Installs whose end was sent from the job result (`topic:package` → until when its late pushes are dropped). */
  private readonly relayedEnds = new Map<string, number>()

  constructor(private readonly send: Send, private readonly log: Pick<Console, 'log' | 'warn'> = console, private readonly graceMs = END_GRACE_MS, private readonly waitMs = END_WAIT_MS) {}

  /**
   * Every frame of the client stream, before the event bridge maps it.
   * False: the frame is a late push of an install whose end was already sent
   * from its result, and the bridge must not send it.
   */
  observe(frame: ClientFrame): boolean {
    if (frame.kind !== 'push') return true
    const payload = frame.payload as { package?: unknown; status?: unknown } | null
    if (!payload || typeof payload.package !== 'string' || !isInstallTopic(frame.topic)) return true
    const ended = payload.status === 'installed' || payload.status === 'error'
    const key = relayKey(frame.topic, payload.package)
    const until = this.relayedEnds.get(key)
    if (until !== undefined) {
      this.relayedEnds.delete(key)
      if (until >= Date.now() && ended) {
        this.log.log(`[Backend] The ${payload.package} install's own end (${String(payload.status)}) arrived on the client stream after Studio had sent it from the job result; not sent again`)
        return false
      }
      if (until >= Date.now()) this.log.log(`[Backend] A progress line of ${payload.package} after its relayed end: another install of it; its pushes are sent`)
    }
    if (ended) for (const watch of this.watches) watch.endArrived(frame.topic, payload.package)
    return true
  }

  /** The stream lost frames: an end push of an install now running may be among them. */
  onGap(): void {
    for (const watch of this.watches) watch.gapped = true
  }

  /** An install Studio is about to wait on. */
  begin(channel: InstallChannel, packages: readonly string[]): InstallWatch {
    // A new install of a package owns its pushes: an older install's late ones are no longer told apart.
    for (const pkg of packages) this.relayedEnds.delete(relayKey(INSTALL_TOPIC[channel], pkg))
    const watch = new InstallWatch(this, channel, packages)
    this.watches.add(watch)
    return watch
  }

  /** @internal An end sent from the job result: the stream's own pushes of that install are dropped from now on. */
  relayEnd(channel: InstallChannel, end: InstallEnd): void {
    this.relayedEnds.set(relayKey(INSTALL_TOPIC[channel], end.package), Date.now() + LATE_END_DROP_MS)
    this.send(channel, endPayload(end))
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
  get wait(): number {
    return this.waitMs
  }

  /** @internal */
  get logger(): Pick<Console, 'log' | 'warn'> {
    return this.log
  }
}

export class InstallWatch {
  /** Frames were lost while this install ran. */
  gapped = false
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

  /** The install ended (or Studio stopped waiting on it): each package's end push, where the stream cannot deliver it. */
  async finish(ends: readonly InstallEnd[]): Promise<void> {
    try {
      const missing = () => ends.filter((end) => !this.ended.has(end.package))
      // No gap: the stream delivers every end; wait for it, so the answer comes after the install's pushes.
      const gappedAtStart = this.gapped
      if (missing().length > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, gappedAtStart ? this.relay.grace : this.relay.wait)
          const wake = (): void => { if (missing().length === 0) done() }
          function done(): void { clearTimeout(timer); resolve() }
          this.waiters.add(wake)
          void Promise.resolve().then(wake)
        })
      }
      for (const end of missing()) {
        this.relay.logger.log(this.gapped
          ? `[Backend] The end of the ${end.package} install was lost in a client stream gap; sending it from the install's job result (${end.status})`
          : `[Backend] The end of the ${end.package} install did not arrive on the client stream within ${Math.round(this.relay.wait / 1000)} s of the job's end; sending it from the install's job result (${end.status})`)
        this.relay.relayEnd(this.channel, end)
      }
    } finally {
      this.waiters.clear()
      this.relay.done(this)
    }
  }
}

const INSTALL_TOPICS: ReadonlySet<string> = new Set(Object.values(INSTALL_TOPIC))

function isInstallTopic(topic: PushTopic): boolean {
  return INSTALL_TOPICS.has(topic)
}

function relayKey(topic: PushTopic, pkg: string): string {
  return `${topic}:${pkg}`
}

function endPayload(end: InstallEnd): Record<string, unknown> {
  return end.status === 'installed' ? { package: end.package, status: 'installed' } : { package: end.package, status: 'error', error: end.error }
}
