// One lease taker per process, for the stale-takeover race tests.
// argv: <agent file>. stdin:
//   `take <n> <epoch ms>` → `TOOK <n> ok` or `TOOK <n> leased <why>` (every
//     taker starts at that instant);
//   `block-next <ms>` → the next takeover, after reading the stale lease under
//     its lock, blocks this process's event loop for <ms> (prints `BLOCKING`
//     synchronously first);
//   `release <n>` → `RELEASED <n>` once a held lease is given back.
// stdout `READY <runtimeId>` once listening.

import { writeSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { AgentLeaseRegistry } from '../../../src/main/runtime/agent-lease'

const filePath = process.argv[2]
if (!filePath) throw new Error('Expected an agent file')
let blockMs = 0
const leases = new AgentLeaseRegistry({
  kind: 'daemon',
  settingsPath: 'unused',
  controlUrl: 'http://127.0.0.1:1',
  beforeTakeoverReplace: async () => {
    if (!blockMs) return
    const until = Date.now() + blockMs
    blockMs = 0
    writeSync(1, 'BLOCKING\n')
    while (Date.now() < until) { /* a truly blocked event loop, not an await */ }
  },
})
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
  } else if (cmd === 'block-next') {
    blockMs = Number(n)
  } else if (cmd === 'release') {
    // No probe lists the file, so reconcile gives a held lease back.
    void leases.reconcile().then(() => process.stdout.write(`RELEASED ${n}\n`))
  }
})
setInterval(() => {}, 60_000)
process.stdout.write(`READY ${leases.runtimeId}\n`)
