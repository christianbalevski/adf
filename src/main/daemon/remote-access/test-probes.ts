/**
 * Test seam ADF_TEST_REMOTE_ACCESS_PROBES (docs/design/multi-runtime.md §16):
 * remote access on in a daemon of the parity harness, so a paired device
 * token is tested end to end (pairing, the device token, Studio connecting
 * with it).
 *
 * Remote access on runs probes that spawn programs and open sockets: the
 * Tailscale CLI, the firewall query, the gateway, Wi-Fi and network-category
 * readers, and mDNS. The harness's fence refuses them. This seam replaces
 * exactly those probes with "nothing found": no network interface, no
 * Tailscale, no announcement, the firewall not checked. The daemon then
 * listens on loopback only, as with remote access off; pairing, device
 * tokens, revocation and every request check are the real ones.
 *
 * Honoured only when all three hold: ADF_TEST_REMOTE_ACCESS_PROBES=1, the
 * test-seam gate (ADF_TEST_SEAMS=1 in an unpackaged build, test-seams.ts),
 * and the parity fence installed in this process (tests/parity/harness/
 * fence.cjs sets the global below). Otherwise the variable is ignored, with
 * a log line. It never opens a listener and never accepts a token the
 * daemon would not accept without it.
 */

import { testSeamsAllowed } from '../../utils/test-seams'
import { NO_ANNOUNCER } from './announcer'
import type { RemoteAccessServiceOptions, TailscaleLike } from './service'

export const REMOTE_ACCESS_PROBES_ENV = 'ADF_TEST_REMOTE_ACCESS_PROBES'

/** Set by the parity harness's fence (tests/parity/harness/fence.cjs) in every fenced process. */
export const PARITY_FENCE_MARK = Symbol.for('adf.parity.fence')

const NO_TAILSCALE: TailscaleLike = {
  self: async () => ({ state: 'absent', ips: [], dnsName: null }),
  serveStatus: async () => ({ serve: 'unknown', httpsUrl: null }),
  setServe: async () => { throw new Error('Tailscale is not available in this test daemon.') },
  serveCommand: () => [],
  whois: async () => null,
  command: null,
}

type Probes = Pick<RemoteAccessServiceOptions, 'interfaces' | 'gateways' | 'wifiNames' | 'osCategories' | 'tailscale' | 'announcer' | 'firewall'>

/** The probe replacements, or {} when the seam is not honoured. */
export function remoteAccessTestProbes(env: NodeJS.ProcessEnv = process.env, log: (line: string) => void = (line) => console.warn(line), fenced = (globalThis as Record<symbol, unknown>)[PARITY_FENCE_MARK] === true): Probes {
  if (env[REMOTE_ACCESS_PROBES_ENV] !== '1') return {}
  if (!testSeamsAllowed({ env }) || !fenced) {
    log(`[remote-access] Ignoring ${REMOTE_ACCESS_PROBES_ENV}: it needs ADF_TEST_SEAMS=1, an unpackaged build and the parity harness's fence`)
    return {}
  }
  log(`[remote-access] Test seam: no network interface, Tailscale, firewall check or announcement (${REMOTE_ACCESS_PROBES_ENV}=1, fenced)`)
  return {
    interfaces: () => ({}),
    gateways: async () => new Map(),
    wifiNames: async () => new Map(),
    osCategories: async () => new Map(),
    tailscale: NO_TAILSCALE,
    announcer: NO_ANNOUNCER,
    firewall: async () => ({ state: 'unknown', message: 'Not checked (test daemon).', commands: [] }),
  }
}
