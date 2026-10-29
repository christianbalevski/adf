import { describe, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

// Opt in on a host with Chromium's display prerequisites (xvfb on Linux).
// bench:studio runs this same harness directly. It asserts real DOM identity,
// selection, sanitized/canonical output, CSS and cache performance; Node-only
// tests cannot establish rendering FPS by timing adjacent clock reads.
describe('Studio browser performance', () => {
  it.skipIf(process.env.RUN_STUDIO_BROWSER_TEST !== '1')('passes the real Chromium regression harness', async () => {
    await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../../scripts/bench-studio.mjs', import.meta.url))], { timeout: 120_000 })
  }, 125_000)
})
