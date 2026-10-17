import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ParityEnv } from './env'

/**
 * Token usage reaches `user-data/token-usage.json` through a 5 s debounced
 * flush (TokenUsageService.scheduleSave), in both modes. A state dump taken
 * inside that window holds the file in one run and not in the next (CI run
 * 39050417848: embedded had it, the daemon not yet). The dump therefore waits
 * for the flush itself: until the backend's live usage view is what the file
 * holds. A run that recorded no usage has no file and an empty view.
 */
export async function waitForUsageOnDisk(env: ParityEnv, live: () => Promise<unknown> | unknown, what: string, timeoutMs = 15_000): Promise<void> {
  const file = join(env.userDataDir, 'token-usage.json')
  const onDisk = (): string => {
    try { return canon(JSON.parse(readFileSync(file, 'utf-8'))) } catch { return canon({}) }
  }
  const deadline = Date.now() + timeoutMs
  let last = ''
  for (;;) {
    last = canon(await live())
    if (last === onDisk()) return
    if (Date.now() > deadline) {
      throw new Error(`parity harness: ${what}: token usage not on disk within ${timeoutMs} ms (live ${last}, file ${onDisk()})`)
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** Key-sorted JSON, so the live view and the parsed file compare by content. */
function canon(value: unknown): string {
  return JSON.stringify(value ?? {}, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
    : v))
}
