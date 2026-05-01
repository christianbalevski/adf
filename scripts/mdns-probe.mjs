#!/usr/bin/env node
// Passive mDNS probe for _adf-runtime._tcp.local.
// Uses the same bonjour-service library ADF uses so results match what the
// app would see. Queries three times at 1s intervals, logs every hit.
import { Bonjour } from 'bonjour-service'

const b = new Bonjour()
const browser = b.find({ type: 'adf-runtime', protocol: 'tcp' })

const seen = new Set()
browser.on('up', (s) => {
  const key = `${s.host}:${s.port}`
  if (seen.has(key)) return
  seen.add(key)
  console.log(`[up] ${s.name} host=${s.host} port=${s.port} addrs=${JSON.stringify(s.addresses)} txt=${JSON.stringify(s.txt)}`)
})
browser.on('down', (s) => console.log(`[down] ${s.name}`))

let n = 0
const timer = setInterval(() => {
  n++
  console.log(`[probe] scan ${n}/3`)
  try { browser.update() } catch { /* not every version exposes this */ }
  if (n >= 3) {
    clearInterval(timer)
    setTimeout(() => {
      console.log(`[probe] done, ${seen.size} unique peer(s) seen`)
      b.destroy()
      process.exit(0)
    }, 2000)
  }
}, 1000)
