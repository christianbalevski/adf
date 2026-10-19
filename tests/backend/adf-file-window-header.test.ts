/**
 * Agent windows (docs/design/agent-windows.md §4): an `adf-file://` request
 * names its window. protocol.handle has no window, so main/index.ts adds the
 * webContents id as a header in session.webRequest.onBeforeSendHeaders.
 * This runs the real Electron (tests/electron/adf-file-window-header.cjs):
 * two windows load the same image and each request carries its own id.
 * Skipped where Electron cannot open a window (Linux without a display).
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// A CI job that installs without the Electron binary (verify) has no path: skipped there.
const electronPath = ((): string | null => { try { return createRequire(import.meta.url)('electron') as unknown as string } catch { return null } })()
const headless = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY

describe.skipIf(headless || typeof electronPath !== 'string')('adf-file:// window header (real Electron)', () => {
  it('each window\'s image request carries that window\'s webContents id', () => {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const run = spawnSync(electronPath!, [join(__dirname, '..', 'electron', 'adf-file-window-header.cjs')], { env, encoding: 'utf8', timeout: 40_000, windowsHide: true })
    const line = `${run.stdout}`.split('\n').find((l) => l.startsWith('RESULT '))
    expect(line, `no result from Electron (exit ${run.status}): ${run.stderr}`).toBeTruthy()
    const result = JSON.parse(line!.slice('RESULT '.length)) as { ok: boolean; message?: string; ids: number[]; seen: Array<{ url: string; window: string | null }> }
    expect(result.ok, result.message).toBe(true)
    expect(result.seen.map((s) => s.url)).toEqual(['adf-file://files/chart.png', 'adf-file://files/chart.png'])
    expect(result.seen.map((s) => Number(s.window)).sort()).toEqual([...result.ids].sort())
  }, 60_000)
})
