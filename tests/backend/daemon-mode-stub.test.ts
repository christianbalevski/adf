import { describe, expect, it } from 'vitest'
import { IPC } from '../../src/shared/constants/ipc-channels'
import { STUB_LOCAL_CHANNELS, registerDaemonModeHandlers } from '../../src/main/backend/daemon-mode'

describe('daemon-mode stub', () => {
  it('registers only its local channels and says how to recover', () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const warnings: string[] = []
    let badge = -1
    const { registered } = registerDaemonModeHandlers({
      mode: 'local',
      ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn) } } as never,
      app: { getVersion: () => '9.9.9', setBadgeCount: (n: number) => { badge = n; return true } },
      log: { warn: (msg: string) => { warnings.push(msg) } },
    })

    expect([...handlers.keys()].sort()).toEqual([...STUB_LOCAL_CHANNELS].sort())
    expect(registered).toEqual([...STUB_LOCAL_CHANNELS])
    const known = new Set<string>(Object.values(IPC))
    for (const channel of registered) expect(known.has(channel)).toBe(true)
    expect(handlers.has(IPC.BACKEND_SETTINGS_GET)).toBe(false)

    expect(handlers.get(IPC.APP_GET_VERSION)!()).toBe('9.9.9')
    handlers.get(IPC.APP_SET_BADGE_COUNT)!({}, 3)
    expect(badge).toBe(3)
    handlers.get(IPC.APP_SET_BADGE_COUNT)!({}, -2)
    expect(badge).toBe(0)

    expect(warnings.join('\n')).toContain('ADF_STUDIO_BACKEND=embedded')
  })
})
