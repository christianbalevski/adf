import { describe, expect, it } from 'vitest'
import { GAP_ALLOWLIST } from './harness/gaps'
import type { ComparableRecording } from './harness/recording'

/**
 * `mode:help-menu` (harness/gaps.ts): the Help items daemon mode adds, and
 * the menu builds that are its own. CI run 39157150645 (windows,
 * template-create) dropped the client stream once: the status line while
 * reconnecting and the rebuild on reconnect came on top of the boot pair,
 * and the entry matched nothing. Those are the daemon mode's own too; any
 * other extra build still is not.
 */
const entry = GAP_ALLOWLIST.find((g) => g.id === 'mode:help-menu')!

const help = (status: string | null) => [{
  role: 'help',
  submenu: [
    { label: 'ADF Studio Documentation' },
    { type: 'separator' },
    { label: 'Open Daemon Log' },
    ...(status ? [{ label: `ADF daemon: ${status}`, enabled: false }, { label: 'Reconnect to the ADF Daemon' }] : []),
  ],
}]
const embeddedHelp = [{ role: 'help', submenu: [{ label: 'ADF Studio Documentation' }] }]
const menu = (items: unknown) => ({ api: 'Menu.setApplicationMenu', args: [items] })
const recording = (local: unknown[]) => ({ local }) as unknown as ComparableRecording

describe('mode:help-menu', () => {
  it('the boot pair, and a reconnect\'s status build and rebuild, are the daemon mode\'s own', () => {
    const embedded = recording([menu(embeddedHelp)])
    const boot = recording([menu(help('connecting')), menu(help(null))])
    expect(entry.apply(boot, embedded)).toBe(2)
    expect(boot.local).toEqual([menu(embeddedHelp)])

    const reconnected = recording([menu(help('connecting')), menu(help(null)), { api: 'other', args: [] }, menu(help('reconnecting')), menu(help(null))])
    expect(entry.apply(reconnected, embedded)).toBe(4)
    expect(reconnected.local).toEqual([menu(embeddedHelp), { api: 'other', args: [] }])
  })

  it('an extra build that follows no status line is still a difference', () => {
    const embedded = recording([menu(embeddedHelp)])
    const extra = recording([menu(help('connecting')), menu(help(null)), menu(help(null))])
    expect(entry.apply(extra, embedded)).toBe(0)
  })

  it('File\'s "Open in New Window" (agent windows) is the daemon mode\'s own; other File items stay', () => {
    const file = (extra: string[]) => ({ label: 'File', submenu: [{ label: 'New ADF Agent' }, ...extra.map((label) => ({ label })), { label: 'Save' }] })
    const embedded = recording([menu([file([]), ...embeddedHelp])])
    const daemon = recording([menu([file(['Open in New Window']), ...help(null)])])
    expect(entry.apply(daemon, embedded)).toBe(1)
    expect(daemon.local).toEqual([menu([file([]), ...embeddedHelp])])

    const other = recording([menu([file(['Something Else']), ...help(null)])])
    expect(entry.apply(other, embedded)).toBe(1)
    expect(other.local).toEqual([menu([file(['Something Else']), ...embeddedHelp])])
  })
})
