// A runtime host in its own process, for the cross-process lease tests.
// It autostarts the agents in one tracked directory the way the daemon does
// at boot, prints the report, and stays up (holding what it started) until it
// is told to exit or is killed.
//
// argv: <tracked dir> [--no-lease]
// stdin commands, one per line: `go` (run autostart), `block <ms>` (busy-wait
// the event loop), `exit` (unload and leave).
// stdout: `READY <pid>`, `REPORT <json>`, `BLOCKED`, `BYE`.

import { createInterface } from 'node:readline'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { RuntimeService } from '../../../src/main/runtime/runtime-service'
import { MockLLMProvider } from '../../../src/main/runtime/headless'
import { markConfigReviewed } from '../../../src/main/services/agent-review'
import { AgentLeaseRegistry } from '../../../src/main/runtime/agent-lease'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2]
if (!dir) throw new Error('Expected a tracked directory')
const noLease = process.argv.includes('--no-lease')

// Every agent in the directory counts as reviewed on this host.
let reviewed: unknown = undefined
for (const name of readdirSync(dir).filter((n) => n.endsWith('.adf'))) {
  const ws = AdfWorkspace.open(join(dir, name))
  try { reviewed = markConfigReviewed(reviewed, ws.getAgentConfig()) } finally { ws.dispose() }
}

const settings = {
  get: (key: string) => (key === 'reviewedAgents' ? reviewed : undefined),
}

const leases = noLease ? null : new AgentLeaseRegistry({ kind: 'daemon', settingsPath: join(dir, 'adf-settings.json'), controlUrl: 'http://127.0.0.1:1' })
const runtime = new RuntimeService({
  settings,
  providerFactory: () => new MockLLMProvider({ tokensPerResponse: 10 }),
  agentLeases: leases,
})

const keepAlive = setInterval(() => {}, 60_000)
process.stdout.write(`READY ${process.pid}\n`)

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const [cmd, arg] = line.trim().split(/\s+/)
  if (cmd === 'go') {
    runtime.autostartFromDirectories([dir]).then(
      (report) => process.stdout.write(`REPORT ${JSON.stringify(report)}\n`),
      (err) => process.stdout.write(`REPORT ${JSON.stringify({ error: String(err) })}\n`),
    )
  } else if (cmd === 'block') {
    process.stdout.write('BLOCKED\n')
    const until = Date.now() + Number(arg)
    while (Date.now() < until) { /* event loop blocked on purpose */ }
  } else if (cmd === 'exit') {
    void (async () => {
      for (const agent of runtime.listAgents()) await runtime.unloadAgent(agent.id, { mode: 'immediate' })
      clearInterval(keepAlive)
      rl.close()
      process.stdout.write('BYE\n')
      process.exit(0)
    })()
  }
})
