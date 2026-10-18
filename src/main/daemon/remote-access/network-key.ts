/**
 * Which network a LAN interface is on, for remote access and the mesh's LAN
 * mode (docs/design/remote-access.md §3.3.1, security review item 2): a
 * network category holds only for the interface's addresses and default
 * gateway (IP and MAC) at the read. Pure.
 */

/**
 * The gateway identity (`<gateway IP>|<gateway MAC>`) read now, merged with
 * the last one (re-review 1): a MAC that is missing for a moment (ARP aging,
 * a stale table) or a gateway not read at all is unknown, not a change, so
 * the last identity stays. Only a known gateway IP that differs, or a known
 * MAC that differs, is another network.
 */
export function mergeGatewayIdentity(previous: string | undefined, read: string): string {
  const [ip = '', mac = ''] = read.split('|')
  const [prevIp = '', prevMac = ''] = (previous ?? '').split('|')
  if (!ip) return previous ?? ''
  if (ip !== prevIp) return `${ip}|${mac}`
  if (!mac) return `${ip}|${prevMac}`
  return `${ip}|${mac}`
}
