/**
 * `_adf-daemon._tcp` announcement (docs/design/remote-access.md §5.1), while
 * remote access is on and a LAN address listens. TXT: `v`, `fp`
 * (fingerprint), `pair` (window open), `api`. Never a token, a code, a DID,
 * a path or a user name. Separate from the mesh's `_adf-runtime._tcp`.
 *
 * bonjour-service cannot change a published TXT record, so a change of the
 * pairing flag re-publishes. mDNS is best effort: a failure is reported in
 * the status and the log, and remote access works by address.
 */

import { hostname } from 'node:os'
import { Bonjour, type Service } from 'bonjour-service'
import { ensureLocalSuffix } from '../../services/mdns-service'

export const DAEMON_SERVICE_TYPE = 'adf-daemon'

export interface Announcement {
  name: string
  port: number
  /** The LAN address to announce on (multicast interface). */
  iface: string
  txt: { v: string; fp: string; pair: '0' | '1'; api: string }
}

export interface Announcer {
  announce(a: Announcement): Promise<void>
  stop(): Promise<void>
  readonly announcing: boolean
  readonly problem: string | null
}

const GOODBYE_FLUSH_MS = 100

export class BonjourAnnouncer implements Announcer {
  private bonjour: Bonjour | null = null
  private service: Service | null = null
  private current: string | null = null
  problem: string | null = null

  get announcing(): boolean {
    return this.service !== null
  }

  async announce(a: Announcement): Promise<void> {
    const key = JSON.stringify(a)
    if (key === this.current && this.service) return
    await this.stop()
    try {
      this.bonjour = new Bonjour({ interface: a.iface, bind: '0.0.0.0' } as never, (err: unknown) => {
        this.problem = `mDNS failed: ${err instanceof Error ? err.message : String(err)}`
        console.error(`[remote-access] ${this.problem}`)
      })
      this.service = this.bonjour.publish({
        name: a.name,
        type: DAEMON_SERVICE_TYPE,
        protocol: 'tcp',
        port: a.port,
        host: ensureLocalSuffix(hostname()),
        txt: a.txt,
        // Our own announcement from before a restart may still be cached by peers; a probe would refuse the name.
        probe: false,
      })
      this.current = key
      this.problem = null
      console.log(`[remote-access] announcing _${DAEMON_SERVICE_TYPE}._tcp "${a.name}" on ${a.iface}:${a.port} (fp ${a.txt.fp}, pairing ${a.txt.pair === '1' ? 'open' : 'closed'})`)
    } catch (err) {
      this.problem = `mDNS announcement failed: ${err instanceof Error ? err.message : String(err)}`
      console.error(`[remote-access] ${this.problem}`)
      await this.stop()
    }
  }

  async stop(): Promise<void> {
    const b = this.bonjour
    this.bonjour = null
    this.service = null
    this.current = null
    if (!b) return
    await new Promise<void>(resolve => { try { b.unpublishAll(() => resolve()) } catch { resolve() } })
    await new Promise<void>(resolve => setTimeout(resolve, GOODBYE_FLUSH_MS))
    try { b.destroy() } catch { /* best effort */ }
  }
}
