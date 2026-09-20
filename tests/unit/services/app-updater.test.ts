import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '../../../src/shared/constants/ipc-channels'
import type { AppUpdateCheckResult, AppUpdateState } from '../../../src/shared/types/ipc.types'

const mocks = vi.hoisted(() => ({
  isPackaged: true,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => void>(),
  checkForUpdates: vi.fn<() => Promise<unknown>>(),
  downloadUpdate: vi.fn<() => Promise<unknown>>()
}))

vi.mock('electron', () => ({
  app: {
    get isPackaged() { return mocks.isPackaged },
    getVersion: () => '1.0.0'
  },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => { mocks.handlers.set(channel, fn) }
  }
}))

vi.mock('electron-updater', () => ({
  autoUpdater: {
    checkForUpdates: mocks.checkForUpdates,
    downloadUpdate: mocks.downloadUpdate,
    quitAndInstall: vi.fn(),
    setFeedURL: vi.fn(),
    on: (event: string, fn: (...args: unknown[]) => void) => { mocks.listeners.set(event, fn) }
  }
}))

/** The service keeps module-level state, so every test gets a fresh copy. */
async function startUpdater(): Promise<{ sent: AppUpdateState[]; check: () => Promise<AppUpdateCheckResult> }> {
  vi.resetModules()
  const sent: AppUpdateState[] = []
  const { initAppUpdater } = await import('../../../src/main/services/app-updater.service')
  initAppUpdater({ send: (s) => sent.push(s), prepareQuitForUpdate: async () => {} })
  const check = () => mocks.handlers.get(IPC.APP_UPDATE_CHECK)!() as Promise<AppUpdateCheckResult>
  return { sent, check }
}

/** What electron-updater does when the feed has a newer / no newer version. */
const feedHasUpdate = (version: string) => async () => { mocks.listeners.get('update-available')?.({ version }) }
const feedHasNothing = async () => { mocks.listeners.get('update-not-available')?.() }

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  mocks.isPackaged = true
  mocks.handlers.clear()
  mocks.listeners.clear()
  mocks.checkForUpdates.mockReset().mockImplementation(feedHasNothing)
  mocks.downloadUpdate.mockReset().mockImplementation(() => new Promise(() => {}))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('app updater: manual check', () => {
  it('says so plainly in an unpackaged build, and never contacts the feed', async () => {
    mocks.isPackaged = false
    const { check } = await startUpdater()
    expect(await check()).toEqual({ outcome: 'unsupported' })
    expect(mocks.checkForUpdates).not.toHaveBeenCalled()
  })

  it('reports the running version when there is nothing newer', async () => {
    const { check, sent } = await startUpdater()
    expect(await check()).toEqual({ outcome: 'up-to-date', version: '1.0.0' })
    expect(sent).toEqual([])
  })

  it('reports an available update, raises the badge, and does not download', async () => {
    mocks.checkForUpdates.mockImplementation(feedHasUpdate('1.1.0'))
    const { check, sent } = await startUpdater()
    expect(await check()).toEqual({ outcome: 'available', version: '1.1.0' })
    expect(sent).toEqual([{ status: 'available', version: '1.1.0' }])
    expect(mocks.downloadUpdate).not.toHaveBeenCalled()
  })

  it('reports a failed check to the person who asked, without turning the badge red', async () => {
    mocks.checkForUpdates.mockRejectedValue(new Error('net::ERR_INTERNET_DISCONNECTED'))
    const { check, sent } = await startUpdater()
    expect(await check()).toEqual({ outcome: 'failed', message: 'net::ERR_INTERNET_DISCONNECTED' })
    expect(sent).toEqual([])
  })

  it('shares one request between two clicks in a row', async () => {
    const { check } = await startUpdater()
    const [a, b] = await Promise.all([check(), check()])
    expect(a).toEqual(b)
    expect(mocks.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('does not start a second check while a download is under way', async () => {
    mocks.checkForUpdates.mockImplementation(feedHasUpdate('1.1.0'))
    const { check } = await startUpdater()
    await check()
    void mocks.handlers.get(IPC.APP_UPDATE_DOWNLOAD)!()
    expect(await check()).toEqual({ outcome: 'in-progress', version: '1.1.0' })
    expect(mocks.checkForUpdates).toHaveBeenCalledTimes(1)
  })
})

describe('app updater: background schedule', () => {
  it('checks shortly after launch, then once an hour', async () => {
    await startUpdater()
    expect(mocks.checkForUpdates).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(15_000)
    expect(mocks.checkForUpdates).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(59 * 60 * 1000)
    expect(mocks.checkForUpdates).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(60 * 1000)
    expect(mocks.checkForUpdates).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(mocks.checkForUpdates).toHaveBeenCalledTimes(3)
  })

  it('never schedules anything in an unpackaged build', async () => {
    mocks.isPackaged = false
    await startUpdater()
    await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000)
    expect(mocks.checkForUpdates).not.toHaveBeenCalled()
  })
})
