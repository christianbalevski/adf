#!/usr/bin/env node
// Active-query probe using multicast-dns directly (lower-level than bonjour).
// Sends PTR queries for _adf-runtime._tcp.local and _services._dns-sd._udp.local
// once per second for 10 seconds, logs every response.
import mdns from 'multicast-dns'

const m = mdns({ loopback: true, reuseAddr: true })

m.on('response', (r) => {
  const relevant = (r.answers || []).concat(r.additionals || []).filter((a) =>
    /adf-runtime/i.test(a.name ?? '') || /adf-runtime/i.test(JSON.stringify(a.data ?? ''))
  )
  if (relevant.length === 0) return
  console.log('[response] from=%s answers=%s',
    r.remoteAddress ?? '?',
    JSON.stringify(relevant.map(a => ({ name: a.name, type: a.type, data: a.data })), null, 2))
})

let n = 0
const send = () => {
  n++
  console.log(`[query] ${n}/10 → PTR _adf-runtime._tcp.local`)
  m.query([
    { name: '_adf-runtime._tcp.local', type: 'PTR' },
    { name: '_services._dns-sd._udp.local', type: 'PTR' }
  ])
  if (n >= 10) {
    setTimeout(() => {
      console.log('[probe] done')
      m.destroy()
      process.exit(0)
    }, 2000)
  } else {
    setTimeout(send, 1000)
  }
}
send()
