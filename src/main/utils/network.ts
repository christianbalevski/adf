import { hostname, networkInterfaces } from 'node:os'

export interface LanAddress {
  iface: string
  address: string
  family: 'IPv4' | 'IPv6'
  mac: string
}

export interface LanAddressInfo {
  hostname: string
  addresses: LanAddress[]
}

export function getLanAddresses(): LanAddressInfo {
  const ifaces = networkInterfaces()
  const addresses: LanAddress[] = []

  for (const [iface, infos] of Object.entries(ifaces)) {
    if (!infos) continue
    for (const info of infos) {
      if (info.internal) continue
      // Skip IPv6 link-local (fe80::...) — not routable on the LAN.
      if (info.family === 'IPv6' && info.address.toLowerCase().startsWith('fe80')) continue
      addresses.push({
        iface,
        address: info.address,
        family: info.family === 'IPv4' ? 'IPv4' : 'IPv6',
        mac: info.mac,
      })
    }
  }

  // IPv4 first, then by interface name for stable ordering.
  addresses.sort((a, b) => {
    if (a.family !== b.family) return a.family === 'IPv4' ? -1 : 1
    return a.iface.localeCompare(b.iface)
  })

  return { hostname: hostname(), addresses }
}
