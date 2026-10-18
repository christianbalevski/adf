import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ParityEnv } from './env'

/**
 * The agent lease registry writes on its own chain (agent-lease.ts
 * ensureReady): Studio's client record is written at launch without the
 * daemon's URL and again, with it, once the connection is up; the daemon
 * rewrites and removes its records as agents start and stop. A state dump
 * taken while that chain still runs holds the client record without
 * `controlUrl` (or no record yet) in one run and the final one in the next
 * (CI run 39157150645, ubuntu emergency-stop: `mode:lease-roles` matched
 * nothing). The dump therefore waits for the real state, as for token usage
 * (usage-flush.ts): Studio's client record names the daemon it uses, and the
 * lease folder reads the same twice in a row.
 */
export async function waitForLeasesSettled(env: ParityEnv, controlUrl: string, timeoutMs = 15_000): Promise<void> {
  const clientFile = join(env.leaseDir, 'clients', `${process.pid}.json`)
  const deadline = Date.now() + timeoutMs
  let previous: string | null = null
  for (;;) {
    let client: { controlUrl?: unknown } | null = null
    try { client = JSON.parse(readFileSync(clientFile, 'utf-8')) as { controlUrl?: unknown } } catch { client = null }
    const now = snapshot(env.leaseDir)
    if (client?.controlUrl === controlUrl && now === previous) return
    if (Date.now() > deadline) {
      throw new Error(`parity harness: the lease folder did not settle within ${timeoutMs} ms (Studio's client record: ${client ? JSON.stringify(client.controlUrl ?? null) : 'missing'}, want ${controlUrl})`)
    }
    previous = now
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/** Every file under the lease folder with its content, in a stable order. */
function snapshot(root: string): string {
  const out: string[] = []
  const walk = (dir: string, rel: string): void => {
    let entries: import('node:fs').Dirent[]
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path, `${rel}${entry.name}/`)
      else {
        let body = ''
        try { body = readFileSync(path, 'utf-8') } catch { body = '<unreadable>' }
        out.push(`${rel}${entry.name}=${body}`)
      }
    }
  }
  walk(root, '')
  return out.join('\n')
}
