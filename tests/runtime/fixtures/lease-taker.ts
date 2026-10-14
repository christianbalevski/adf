// One lease taker per process, for the stale-takeover race test.
// argv: <agent file>. stdin: `take <n> <epoch ms>` → stdout `TOOK <n> ok` or
// `TOOK <n> leased <why>` (every taker starts at that instant); `release <n>`
// → `RELEASED <n>` once a held lease is given back.

import { createInterface } from 'node:readline'
import { AgentLeaseRegistry } from '../../../src/main/runtime/agent-lease'

const filePath = process.argv[2]
if (!filePath) throw new Error('Expected an agent file')
const leases = new AgentLeaseRegistry({ kind: 'daemon', settingsPath: 'unused', controlUrl: 'http://127.0.0.1:1' })
console.warn = () => {}

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const [cmd, n, at] = line.trim().split(/\s+/)
  if (cmd === 'take') {
    const go = () => void leases.acquire(filePath).then((result) => {
      process.stdout.write(`TOOK ${n} ${result.ok ? 'ok' : `leased ${result.message.slice(0, 160)}`}\n`)
    })
    const wait = Number(at) - Date.now()
    if (!(wait > 2)) return go()
    setTimeout(() => {
      while (Date.now() < Number(at)) { /* spin to the shared instant */ }
      go()
    }, wait - 2)
  } else if (cmd === 'release') {
    // No probe lists the file, so reconcile gives a held lease back.
    void leases.reconcile().then(() => process.stdout.write(`RELEASED ${n}\n`))
  }
})
setInterval(() => {}, 60_000)
process.stdout.write('READY\n')
