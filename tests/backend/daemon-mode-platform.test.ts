import { describe, expect, it, vi } from 'vitest'

// The shared tables must load in the npm daemon, where Electron is absent.
vi.mock('electron', () => { throw new Error('Electron must not load in the headless handler graph') })

import { DAEMON_MODE_HANDLERS } from '../../src/main/backend/daemon-mode/handlers'
import { REMOTE_MODE_HANDLERS } from '../../src/main/backend/daemon-mode/remote/handlers'
import { app, dialog, DesktopCapabilityUnavailableError, setDaemonDesktopPlatform } from '../../src/main/backend/daemon-mode/platform'
import { IPC } from '../../src/shared/constants/ipc-channels'
import type { DaemonModeContext } from '../../src/main/backend/daemon-mode/context'

describe('headless Studio handler platform', () => {
  it('loads the shared desktop and remote handler tables without Electron', () => {
    expect(DAEMON_MODE_HANDLERS[IPC.AGENT_INVOKE]).toBeTypeOf('function')
    expect(REMOTE_MODE_HANDLERS[IPC.FILE_OPEN]).toBeTypeOf('function')
  })

  it('forwards appearance changes through the host hook without native windows', async () => {
    const appearanceChanged = vi.fn()
    const patch = vi.fn()
    const ctx = {
      hooks: { appearanceChanged }, clientSettings: { patch }, log: { warn: vi.fn() },
    } as unknown as DaemonModeContext
    const result = await DAEMON_MODE_HANDLERS[IPC.SETTINGS_SET]!(ctx, {} as never, { theme: 'dark', uiScale: 1.25, recentFiles: ['/agent.adf'] })
    expect(result).toEqual({ success: true })
    expect(patch).toHaveBeenCalledWith({ theme: 'dark', uiScale: 1.25, recentFiles: ['/agent.adf'] })
    expect(appearanceChanged).toHaveBeenCalledWith({ theme: 'dark', uiScale: 1.25 })
  })

  it('refuses native capabilities until the desktop explicitly installs them', async () => {
    expect(() => app.getVersion()).toThrow(DesktopCapabilityUnavailableError)
    expect(() => dialog.showOpenDialog({})).toThrow('dialog.showOpenDialog requires the desktop Studio app.')
    const nativeDialog = {
      marker: 'native',
      async showOpenDialog() { return { canceled: this.marker === 'native', filePaths: [] } },
    }
    setDaemonDesktopPlatform({ app: { getVersion: () => '1.2.3' }, dialog: nativeDialog } as never)
    expect(app.getVersion()).toBe('1.2.3')
    expect(await dialog.showOpenDialog({})).toEqual({ canceled: true, filePaths: [] })
  })
})
