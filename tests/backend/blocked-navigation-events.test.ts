/**
 * menu.ts stops sending menu actions to a page only when a new page commits
 * (did-navigate), never on did-start-navigation: that also fires for a
 * navigation main/index.ts then blocks in will-navigate (a chat link, a
 * dropped file), and the page would then wait for actions forever
 * (docs/design/agent-windows.md §4). This runs the real Electron
 * (tests/electron/blocked-navigation-events.cjs). Skipped where Electron
 * cannot open a window (Linux without a display).
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const electronPath = createRequire(import.meta.url)('electron') as unknown as string
const headless = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY

describe.skipIf(headless || typeof electronPath !== 'string')('navigation events (real Electron)', () => {
  it('a blocked navigation starts but never commits; an in-page one does not commit; a reload commits', () => {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const run = spawnSync(electronPath, [join(__dirname, '..', 'electron', 'blocked-navigation-events.cjs')], { env, encoding: 'utf8', timeout: 40_000, windowsHide: true })
    const line = `${run.stdout}`.split('\n').find((l) => l.startsWith('RESULT '))
    expect(line, `no result from Electron (exit ${run.status}): ${run.stderr}`).toBeTruthy()
    const result = JSON.parse(line!.slice('RESULT '.length)) as { ok: boolean; message?: string; events: Array<{ phase: string; event: string; isMainFrame?: boolean; isSameDocument?: boolean }> }
    expect(result.ok, result.message).toBe(true)
    const of = (phase: string) => result.events.filter((e) => e.phase === phase).map((e) => e.event)
    expect(of('blocked')).toContain('did-start-navigation')
    expect(result.events.find((e) => e.phase === 'blocked' && e.event === 'did-start-navigation')).toMatchObject({ isMainFrame: true, isSameDocument: false })
    expect(of('blocked')).not.toContain('did-navigate')
    expect(of('in-page')).not.toContain('did-navigate')
    expect(of('reload')).toContain('did-navigate')
  }, 60_000)
})
