/**
 * In-app updates via electron-updater, fed by the GitHub Releases that
 * `npm run release` already publishes (latest*.yml + blockmaps).
 *
 * Deliberately not "auto": nothing is downloaded until the user clicks the
 * status-bar badge. Once a download completes the app restarts into the new
 * version on its own — that's the one click the user gave us.
 *
 * Platform notes:
 * - macOS: Squirrel.Mac installs from the `zip` target and only accepts an
 *   app whose signature matches the running one, so this works because
 *   releases are Developer ID-signed (see RELEASING.md).
 * - Windows: the NSIS installer runs silently and relaunches the app.
 * - Linux: AppImage swaps itself in place; the .deb path runs `dpkg -i`
 *   behind a pkexec password prompt.
 *
 * Unpackaged (`npm run dev`) builds never contact GitHub: electron-updater
 * refuses to check outside a packed app, and we don't even register.
 */
import { app, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { ProgressInfo, UpdateInfo } from 'electron-updater'
import { IPC } from '../../shared/constants/ipc-channels'
import type { AppUpdateState } from '../../shared/types/ipc.types'

const FIRST_CHECK_DELAY_MS = 15_000
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
/** Lets the badge show "Restarting…" before the shutdown overlay takes over. */
const INSTALL_GRACE_MS = 1_500

export interface AppUpdaterHooks {
  /** Push a state transition to the renderer (no-op if the window is gone). */
  send: (state: AppUpdateState) => void
  /**
   * Run the normal shutdown teardown (children, containers, workspace) and
   * arrange for the next `app.quit()` to proceed unhindered. Called once,
   * right before electron-updater's quitAndInstall.
   */
  prepareQuitForUpdate: () => Promise<void>
}

let state: AppUpdateState = { status: 'idle' }
let hooks: AppUpdaterHooks | null = null
let installTimer: NodeJS.Timeout | null = null
/** Whether the user asked for the current download; guards the auto-install. */
let userInitiated = false

function setState(next: AppUpdateState): void {
  state = next
  hooks?.send(next)
}

export function getAppUpdateState(): AppUpdateState {
  return state
}

function versionOf(): string | undefined {
  return 'version' in state ? state.version : undefined
}

async function checkQuietly(): Promise<void> {
  // A failed check (offline, GitHub hiccup, rate limit) is not the user's
  // problem: log it and stay idle. Only download failures surface as errors.
  if (state.status !== 'idle' && state.status !== 'error') return
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    console.warn('[Updater] Check failed:', err instanceof Error ? err.message : err)
  }
}

async function download(): Promise<void> {
  const version = versionOf()
  if (state.status !== 'available' && state.status !== 'error') return
  if (!version) return
  userInitiated = true
  setState({ status: 'downloading', version, percent: 0 })
  try {
    await autoUpdater.downloadUpdate()
  } catch (err) {
    // The 'error' event already moved us to the error state; this catch
    // just keeps the rejected promise from reaching the IPC caller as noise.
    console.error('[Updater] Download failed:', err instanceof Error ? err.message : err)
  }
}

async function install(): Promise<void> {
  if (state.status !== 'ready' || !hooks) return
  const { version } = state
  setState({ status: 'installing', version })
  await hooks.prepareQuitForUpdate()
  // (isSilent, isForceRunAfter): silent NSIS install, relaunch afterwards.
  // Ignored on macOS where Squirrel always relaunches.
  autoUpdater.quitAndInstall(true, true)
}

function scheduleInstall(): void {
  if (installTimer) return
  installTimer = setTimeout(() => {
    installTimer = null
    void install()
  }, INSTALL_GRACE_MS)
}

export function initAppUpdater(h: AppUpdaterHooks): void {
  hooks = h

  ipcMain.handle(IPC.APP_UPDATE_GET_STATE, () => state)
  ipcMain.handle(IPC.APP_UPDATE_DOWNLOAD, () => download())
  ipcMain.handle(IPC.APP_UPDATE_INSTALL, () => install())

  if (!app.isPackaged) {
    console.log('[Updater] Unpackaged build — update checks disabled')
    return
  }

  // Test hook: an isolated instance (ADF_INSTANCE=N, see index.ts) may be
  // pointed at a local generic feed so the download → restart path can be
  // exercised against a throwaway build instead of a published release.
  // Ignored for the real single-instance app. Recipe in RELEASING.md.
  const feedOverride = process.env.ADF_INSTANCE ? process.env.ADF_UPDATE_FEED_URL : undefined
  if (feedOverride) {
    console.log(`[Updater] Using test feed ${feedOverride}`)
    autoUpdater.setFeedURL({ provider: 'generic', url: feedOverride })
  }

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowPrerelease = false
  autoUpdater.logger = {
    info: (m: unknown) => console.log('[Updater]', m),
    warn: (m: unknown) => console.warn('[Updater]', m),
    error: (m: unknown) => console.error('[Updater]', m),
    debug: () => {}
  }

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    if (state.status === 'idle' || state.status === 'error') {
      setState({ status: 'available', version: info.version })
    }
  })
  autoUpdater.on('update-not-available', () => {
    if (state.status === 'available') setState({ status: 'idle' })
  })
  autoUpdater.on('download-progress', (p: ProgressInfo) => {
    const version = versionOf()
    if (state.status === 'downloading' && version) {
      setState({ status: 'downloading', version, percent: Math.floor(p.percent) })
    }
  })
  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    setState({ status: 'ready', version: info.version })
    if (userInitiated) scheduleInstall()
  })
  autoUpdater.on('error', (err: Error) => {
    // Errors during a background check are logged by checkQuietly; only a
    // user-visible phase (download/install) turns the badge red.
    if (state.status === 'downloading' || state.status === 'installing') {
      setState({ status: 'error', message: err.message, version: versionOf() })
    }
  })

  setTimeout(() => void checkQuietly(), FIRST_CHECK_DELAY_MS).unref()
  setInterval(() => void checkQuietly(), CHECK_INTERVAL_MS).unref()
}
