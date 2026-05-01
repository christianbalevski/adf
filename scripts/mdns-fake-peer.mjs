// Temporary diagnostic: publishes a fake _adf-runtime._tcp peer so we can
// verify the receive path end-to-end. Runs until Ctrl+C.
import { Bonjour } from 'bonjour-service'
import { networkInterfaces, hostname, platform } from 'os'

function pickIface() {
  if (process.env.ADF_MDNS_INTERFACE) return process.env.ADF_MDNS_INTERFACE
  if (platform() !== 'win32') return undefined
  const ifaces = networkInterfaces()
  const exclude = /vEthernet|Loopback|Bluetooth|VirtualBox|VMware|Tailscale|WSL|Docker|Hyper-V/i
  const out = []
  for (const [n, addrs] of Object.entries(ifaces)) {
    if (!addrs || exclude.test(n)) continue
    for (const a of addrs) {
      if (a.family !== 'IPv4' || a.internal) continue
      if (a.address.startsWith('169.254.')) continue
      if (/^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./.test(a.address)) continue
      out.push(a.address)
    }
  }
  return out.length === 1 ? out[0] : undefined
}

const iface = pickIface()
const runtimeId = `fake-${Math.random().toString(36).slice(2, 10)}`
const port = 19999
console.log(`[fake-peer] iface=${iface ?? '(default)'} runtime_id=${runtimeId} port=${port}`)

const bonjour = iface ? new Bonjour({ interface: iface }) : new Bonjour()
const host = `${hostname()}.local`
const svc = bonjour.publish({
  name: `adf-${runtimeId}`,
  type: 'adf-runtime',
  protocol: 'tcp',
  port,
  host,
  txt: {
    runtime_id: runtimeId,
    proto: 'alf/0.2',
    directory: '/mesh/directory'
  }
})
svc.on('up', () => console.log('[fake-peer] announced, Ctrl+C to stop'))

function shutdown() {
  console.log('[fake-peer] unpublishing...')
  bonjour.unpublishAll(() => {
    setTimeout(() => { bonjour.destroy(); process.exit(0) }, 150)
  })
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
