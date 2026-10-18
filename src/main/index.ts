import { app, BrowserWindow, crashReporter, dialog, ipcMain, nativeTheme, powerMonitor, protocol, session, shell } from 'electron'
import { join } from 'path'
// The embedded IPC layer (./ipc) is imported only in embedded mode, at boot:
// loading it constructs embedded services (a PodmanService, the uvx manifest
// repair) that must never exist in a daemon-mode Studio.
type EmbeddedIpc = typeof import('./ipc')
import { registerOrbitalCacheHandlers } from './ipc/orbital-cache'
import { registerEditRecoveryHandlers } from './backend/edit-recovery'
import { purgeStaleProcessDirs } from './utils/scratch-dir'
import { withDeadline } from './utils/concurrency'
import { installMainLogFile } from './utils/main-log-file'
import { startStallMonitor, stopStallMonitor } from './utils/stall-monitor'
import { resolveLoginShellPath } from './utils/login-shell-path'
import { showOrCreateMainWindow } from './utils/main-window'
import { closeBootWindow, dismissBootDialogs, noteMainWindowClosed } from './utils/boot-window'
import { IPC } from '../shared/constants/ipc-channels'
import { initAppUpdater } from './services/app-updater.service'
import { initSpellcheckDictionaries } from './services/spellcheck-dictionaries.service'
import { shutdownSandboxHosts } from './runtime/sandbox-host'
import { getUserDataPath } from './utils/user-data-path'
import { backendConfigPath, resolveBootBackend, type BackendSettingsStore } from './backend/backend-config'
import { registerBackendSettingsHandlers, safeStorageCodec } from './backend/backend-settings-ipc'
import { grantLocalOpen } from './backend/local-open-grants'
import { registerDaemonModeHandlers, type DaemonModeHandle } from './backend/daemon-mode'
import { registerRemoteAccessHandlers, type RemoteAccessIpc } from './backend/remote-access-ipc'
import { localDaemonConnector, remoteDaemonConnector } from './backend/daemon-mode/connectors'
import {
  askVersionMismatch,
  createModeSwitcher,
  isRelaunching,
  notifyDaemonOfHandover,
  relaunchStudio,
  restartingMessage,
  resumeSwitchedAgents,
  runBootHandover,
  sessionBackendEnv,
  SWITCH_DAEMON_EXIT_WAIT_MS,
  syncRuntimeEntryAfterImport,
} from './backend/mode-switch'
import { guardBoot, settleDefaultBackend, showBootNotices } from './backend/first-launch'
import { processAgentLeases } from './runtime/agent-lease'
import type { StudioBackendMode } from '../shared/types/backend.types'

// A console.log after the parent's stdout pipe is gone (app quitting, or the
// dev harness restarting the main process underneath us) emits EIO/EPIPE on
// the stream; with no 'error' listener that becomes an uncaught exception and
// Electron throws its error dialog over a harmless shutdown write. No-op
// listeners absorb dead-pipe writes; real errors keep their default handling.
process.stdout?.on('error', () => {})
process.stderr?.on('error', () => {})

// A3: widen the libuv thread pool (default 4) before any async fs/zlib work.
// The pool backs fsp.*, brotli*Async, and crypto; at fleet scale (50 agents
// compacting/backing-up) 4 threads starve the foreground turn's own I/O. Read
// lazily by libuv on first pool use, so setting it here — before any async fs
// or zlib call — is early enough. Respect an operator override if already set.
process.env.UV_THREADPOOL_SIZE ||= '8'

// Register adf-file:// as a privileged scheme so it can be used in <img src>
// Must be called before app.whenReady()
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'adf-file',
    // Intentionally NOT a `standard` scheme. Standard schemes put the URL
    // authority through Chromium's host canonicalization, which lowercases it
    // and appends a trailing "/". The workspace file path is encoded as the
    // URL host (adf-file://Screenshot.png), so that would irreversibly mangle
    // any filename with uppercase letters ("...PM.png" -> "...pm.png") and
    // 404 on the case-sensitive adf_files lookup. As a non-standard scheme
    // the host is an opaque string preserved verbatim. Nothing fetch()es this
    // scheme (only <img>/<video> via img-src/media-src), so `standard` and
    // `corsEnabled` aren't needed.
    privileges: {
      secure: true,
      supportFetchAPI: true,
      stream: true
    }
  }
])

// Fix PATH for packaged macOS/Linux apps launched from Finder/desktop.
// GUI apps inherit a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin) that
// doesn't include Node.js, Homebrew, nvm, etc.
// Logged after the main log file is installed so the reason reaches main.log.
let loginShellPathNote: string | null = null
if (app.isPackaged && (process.platform === 'darwin' || process.platform === 'linux')) {
  const resolved = resolveLoginShellPath({
    shell: process.env.SHELL || '/bin/zsh',
    currentPath: process.env.PATH ?? '',
    platform: process.platform
  })
  process.env.PATH = resolved.path
  if (resolved.source === 'fallback') {
    loginShellPathNote = `[App] Login-shell PATH unavailable (${resolved.reason}); using fallback PATH`
  }
}

// Support custom user data directory for running multiple instances
// Usage: ADF_INSTANCE=2 npm run dev
// Or pass --instance=2 as command line arg
const instanceArg = process.argv.find(arg => arg.startsWith('--instance='))
const instanceFromArg = instanceArg ? instanceArg.split('=')[1] : null
const instanceId = process.env.ADF_INSTANCE || instanceFromArg

if (instanceId) {
  const customUserDataPath = join(app.getPath('temp'), `adf-instance-${instanceId}`)
  app.setPath('userData', customUserDataPath)
  console.log(`[App] Running instance ${instanceId} with userData: ${customUserDataPath}`)
}

// Mirror every main-process console line to <userData>/logs/main.log. Must
// follow the ADF_INSTANCE userData override so each instance gets its own
// file, and precede everything else so startup and quit reasons are captured.
const mainLogPath = installMainLogFile(join(app.getPath('userData'), 'logs'))
console.log(
  `[App] ADF Studio ${app.getVersion()} starting — pid=${process.pid} packaged=${app.isPackaged} ` +
  `electron=${process.versions.electron} log=${mainLogPath ?? '(unavailable)'}`
)
if (loginShellPathNote) console.warn(loginShellPathNote)

let mainWindow: BrowserWindow | null = null
let fileToOpen: string | null = null
// Set at boot when studio-backend.json selects a daemon backend (design D9).
// Every branch on it below keeps the embedded path exactly as it was.
let daemonMode: DaemonModeHandle | null = null
// Set at boot in embedded mode only.
let embeddedIpc: EmbeddedIpc | null = null
// Set when Settings → Backend confirmed a switch: the quit that follows is a restart into it.
let switchingTo: StudioBackendMode | null = null
// Settings → Backend → This computer, discovery, pairing and the quit question (remote-access.md).
let remoteAccess: RemoteAccessIpc | null = null
// A quit from a signal is not held for the question about connected computers.
let quitUnasked = false
/**
 * Owner decision 5 (remote-access.md §3.6): a quit while other computers are
 * connected to the daemon Studio would stop asks first. Not for a signal, an
 * update, a switch or a restart (they have their own dialogs, or none can be
 * shown). True: go on now; false: held, `resume` runs after the answer.
 */
function remoteQuitHold(resume: () => void): boolean {
  if (!remoteAccess || quitUnasked || quittingForUpdate || switchingTo !== null || isRelaunching()) return true
  return remoteAccess.quitGate.hold(resume)
}
// Set at the end of the whenReady continuation, once IPC handlers and the
// adf-file protocol exist. app.isReady() flips earlier, on the 'ready' event.
let startupComplete = false

// --- Shutdown plumbing ---------------------------------------------------
// Total wall-clock budget for cleanup before the process force-exits.
// Menu/Cmd+Q quits get the full budget; on Windows a console close, logoff,
// or shutdown grants only ~5s of OS grace, so signal- and session-initiated
// shutdowns shrink to a fast budget that still leaves room for app.exit.
const SHUTDOWN_BUDGET_MS = 8_000
const FAST_SHUTDOWN_BUDGET_MS = 3_000
let shutdownBudgetMs = SHUTDOWN_BUDGET_MS

// Re-entrant-safe cleanup: the first caller starts cleanup and stores the
// promise; every later caller (repeat before-quit, second signal, fatal
// error handler) awaits the same promise instead of re-running teardown.
let shutdownCleanup: Promise<void> | null = null
// Set by the in-app updater once cleanup has run: the quit that follows is
// electron-updater's and must not be intercepted (see before-quit below).
let quittingForUpdate = false

function runShutdownCleanup(): Promise<void> {
  if (shutdownCleanup) return shutdownCleanup
  const budget = shutdownBudgetMs
  shutdownCleanup = (async () => {
    try {
      // Notify the renderer so it can show a shutdown overlay
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send(IPC.APP_SHUTTING_DOWN)
      }
      // On the fast path, shrink the inner phase-2 teardown too so the
      // synchronous workspace-close/WAL-sweep phase still gets to run.
      const cleanupOpts = budget < SHUTDOWN_BUDGET_MS ? { teardownBudgetMs: 1_500 } : undefined
      // Daemon mode runs no agents here: quitting ends the client session and,
      // per keepDaemonRunning, stops the daemon Studio started (§8.3). A switch
      // to embedded waits for that daemon, so embedded Studio can start its agents.
      remoteAccess?.dispose()
      const cleanup = daemonMode
        ? daemonMode.shutdown({
          ...(switchingTo === 'embedded' && budget === SHUTDOWN_BUDGET_MS ? { waitForDaemonExitMs: SWITCH_DAEMON_EXIT_WAIT_MS } : {}),
          // "Keep Running" in the question about connected computers: this quit only.
          ...(remoteAccess?.quitGate.keepDaemonForThisQuit ? { keepDaemonRunning: true } : {}),
        })
        : embeddedIpc ? embeddedIpc.cleanupAllProcesses(cleanupOpts) : Promise.resolve()
      const { timedOut } = await withDeadline(cleanup, daemonMode && switchingTo === 'embedded' && budget === SHUTDOWN_BUDGET_MS ? SWITCH_DAEMON_EXIT_WAIT_MS + 3_000 : budget, () => {
        console.error(`[App] Cleanup exceeded ${budget}ms budget — forcing exit`)
      })
      if (timedOut) console.error('[App] Shutdown proceeded past incomplete cleanup')
    } catch (error) {
      console.error('[App] Cleanup error:', error)
    } finally {
      // Sandbox hosts also exit when their IPC channel closes; don't rely on it.
      shutdownSandboxHosts()
    }
  })()
  return shutdownCleanup
}

// Ctrl+C / taskkill / logoff must run the same cleanup as a normal quit —
// without these, every child process and container is orphaned.
// SIGBREAK is Windows Ctrl+Break; registering it elsewhere is harmless.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as NodeJS.Signals[]) {
  process.on(sig, () => {
    // Escape hatch: a second Ctrl+C while shutdown is already in flight
    // means "get out NOW" — exit immediately, cleanup be damned.
    if (shutdownCleanup && sig === 'SIGINT') {
      console.error('[App] Second SIGINT during shutdown — exiting immediately')
      app.exit(1)
      return
    }
    console.log(`[App] Received ${sig} — quitting`)
    quitUnasked = true
    // Windows grants ~5s on console close/logoff before killing the process.
    if (process.platform === 'win32') shutdownBudgetMs = FAST_SHUTDOWN_BUDGET_MS
    app.quit()
  })
}

// Windows session shutdown/restart: 'session-end' is a BrowserWindow event
// (NOT an app event — an app-level listener never fires). Registered per
// window in createWindow(); this is the shared fast-path handler. The OS
// grants ~5s, so skip full teardown: flush durability-critical state, reap
// children, exit.
function handleSessionEnd(): void {
  if (shutdownCleanup) return
  console.log('[App] Windows session ending — fast shutdown')
  shutdownBudgetMs = FAST_SHUTDOWN_BUDGET_MS
  shutdownCleanup = (async () => {
    try {
      await withDeadline(daemonMode ? daemonMode.shutdown() : embeddedIpc ? embeddedIpc.fastSessionEndCleanup(2_000) : Promise.resolve(), FAST_SHUTDOWN_BUDGET_MS, () => {
        console.error('[App] Session-end cleanup exceeded budget — exiting')
      })
    } catch (error) {
      console.error('[App] Session-end cleanup error:', error)
    }
  })()
  void shutdownCleanup.finally(() => app.exit(0))
}

/**
 * Electron's own dialog for a main script that throws while it loads
 * ("A JavaScript error occurred in the main process"), then exit: embedded
 * Studio cannot run without its IPC layer.
 */
function failedMainLoad(err: unknown): void {
  const detail = err instanceof Error ? err.stack ?? err.message : String(err)
  console.error('[App] The embedded IPC layer failed to load:', detail)
  dialog.showErrorBox('A JavaScript error occurred in the main process', `Uncaught Exception:\n${detail}`)
  app.exit(1)
}

process.on('unhandledRejection', (reason) => {
  // Log only — an unhandled rejection is not fatal to the main process.
  console.error('[App] Unhandled rejection:', reason instanceof Error ? reason.stack : reason)
})
process.on('uncaughtException', (err) => {
  // Log only — never exit. This process hosts agent runtimes; an escaped
  // exception from one agent's config (a wedged WebSocket, a misbehaving
  // dependency timer) must not take down every other agent. Anything that
  // needs teardown-on-failure must handle its own errors; the global handler
  // is a backstop, not a kill switch.
  console.error('[App] Uncaught exception:', err?.stack ?? err)
})

// Windows attributes every toast to an AppUserModelID and refuses to show one
// whose ID it cannot map to a Start Menu shortcut. This must match
// electron-builder.yml's `appId` so a packaged install's shortcut (created by
// the installer) is the registration OS notifications resolve against.
// Harmless no-op on macOS/Linux. Called before whenReady, per Electron's docs.
app.setAppUserModelId('com.adf.app')

// Crash diagnostics. Without a started crash reporter, a native fault in the
// main process (better-sqlite3, node-pty, sharp, tree-sitter, Chromium) kills
// Electron silently: no stack, no event-log entry, no dump. Starting the
// reporter with uploads off makes Crashpad write a local minidump instead.
// Must run before app 'ready'.
const crashDumpDir = join(app.getPath('userData'), 'crashes')
app.setPath('crashDumps', crashDumpDir)
crashReporter.start({ submitURL: '', uploadToServer: false, compress: false })
console.log(`[App] Crash dumps: ${crashDumpDir}`)

// Sibling-process deaths (GPU, utility, renderer) are survivable but worth a
// line — they are the usual prelude when the whole app later disappears.
app.on('child-process-gone', (_event, details) => {
  console.error(`[App] Child process gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode} name=${details.name ?? ''}`)
})
app.on('render-process-gone', (_event, contents, details) => {
  console.error(`[App] Renderer gone: id=${contents.id} reason=${details.reason} exitCode=${details.exitCode}`)
})

// Fires for every JS-initiated exit (app.exit/app.quit/process.exit) but never
// for a native crash — so its absence on the next silent death is itself the
// diagnosis.
process.on('exit', (code) => {
  console.error(`[App] Process exiting with code ${code}`)
})

// Single-instance lock: a second launch focuses the existing window and
// forwards any .adf argv path through the open-file flow. Skipped when a
// deliberate multi-instance run is requested via ADF_INSTANCE / --instance=.
if (!instanceId) {
  if (!app.requestSingleInstanceLock()) {
    console.log('[App] Another instance is already running — exiting')
    // Exit without cleanup: teardown here would stop containers and sweep
    // WAL files owned by the primary instance.
    app.exit(0)
  } else {
    app.on('second-instance', (_event, argv) => {
      const secondAdfArg = argv.find((arg) => arg.endsWith('.adf') && !arg.startsWith('-'))
      // The OS handed this path: remote mode may read and upload it (local-open-grants.ts).
      if (secondAdfArg) { grantLocalOpen(secondAdfArg); requestOpenFile(secondAdfArg) }
      else showMainWindow()
    })
  }
}

/**
 * A pushed OPEN_FILE_REQUEST only lands once the renderer has finished
 * loading (and even then its listener registers in a React effect — the
 * OPEN_FILE_GET_PENDING pull covers that gap). Anything earlier queues.
 */
function canPushOpenFile(): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  const wc = mainWindow.webContents
  return !wc.isDestroyed() && !wc.isLoading()
}

/**
 * Bring the main window forward, creating it if there is none (macOS keeps
 * the app alive with no window). A no-op until startup completes — startup
 * creates the window itself — and once shutdown has begun. Rules and tests:
 * utils/main-window.ts.
 */
function showMainWindow(): BrowserWindow | null {
  return showOrCreateMainWindow({
    current: () => mainWindow,
    create: createWindow,
    canShow: () => startupComplete && !shutdownCleanup && !quittingForUpdate,
  })
}

/**
 * Open an .adf in the main window. Pushes straight to a loaded renderer;
 * otherwise queues it for the renderer's OPEN_FILE_GET_PENDING pull, making
 * sure a window exists to do the pulling.
 */
function requestOpenFile(filePath: string): void {
  if (canPushOpenFile()) {
    showMainWindow()
    mainWindow!.webContents.send(IPC.OPEN_FILE_REQUEST, { filePath })
    return
  }
  fileToOpen = filePath
  showMainWindow()
}

// macOS: fired when user double-clicks .adf or uses Open With
app.on('open-file', (event, filePath) => {
  event.preventDefault()
  if (!filePath.endsWith('.adf')) return
  grantLocalOpen(filePath)
  requestOpenFile(filePath)
})

// Cold-start pull: the renderer calls this once its OPEN_FILE_REQUEST
// listener is registered. The queue is cleared here, not by the
// did-finish-load push — that push races the listener registration and may
// be dropped; pull + push are idempotent (re-opening the same path is safe).
ipcMain.handle(IPC.OPEN_FILE_GET_PENDING, () => {
  const filePath = fileToOpen
  fileToOpen = null
  return { filePath }
})

// Windows/Linux: .adf file path passed as CLI argument
const adfArg = process.argv.find(
  (arg) => arg.endsWith('.adf') && !arg.startsWith('-')
)
if (adfArg) {
  grantLocalOpen(adfArg)
  fileToOpen = adfArg
}

function getOverlayColors(): { color: string; symbolColor: string } {
  return nativeTheme.shouldUseDarkColors
    ? { color: '#0c0e13', symbolColor: '#b0b5c2' } // brand dark --paper / --ink-muted (title bar, BRAND §10)
    : { color: '#ffffff', symbolColor: '#474b54' } // brand light --paper / --ink-muted
}

function createWindow(): BrowserWindow {
  const isMac = process.platform === 'darwin'

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    // Paint only once the renderer is ready — avoids the white flash.
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0c0e13' : '#ffffff', // brand --paper
    icon: join(__dirname, '../../resources/icon.png'),
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    // Windows/Linux: keep the menu bar out of the custom titlebar UI while
    // still registering its accelerators (Alt reveals it temporarily)
    autoHideMenuBar: true,
    ...(isMac
      ? { trafficLightPosition: { x: 15, y: 15 } }
      : { titleBarOverlay: { ...getOverlayColors(), height: 40 } }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Agent browser viewer tabs embed noVNC pages via <webview>
      webviewTag: true
    }
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    // The boot window (a dialog or keychain wait before this window existed) is done.
    closeBootWindow()
  })

  // Windows logoff/shutdown fires 'session-end' on each BrowserWindow (there
  // is no app-level equivalent). Any future window must register this too.
  mainWindow.on('session-end', handleSessionEnd)

  // Every orderly exit starts with the window closing. Log the request so the
  // main log can distinguish a user/OS close (this line, then cleanup) from a
  // hard kill (log simply stops).
  // Drop the reference so later requests recreate the window instead of
  // calling into a destroyed one (macOS keeps the app alive with no window).
  const createdWindow = mainWindow
  mainWindow.on('close', (event) => {
    console.log('[App] Main window close requested (user, OS, or WM_CLOSE from another process)')
    // Windows and Linux: closing the window quits, so computers connected to the daemon are asked about first.
    if (process.platform !== 'darwin' && !shutdownCleanup && !remoteQuitHold(() => { if (!createdWindow.isDestroyed()) createdWindow.close() })) {
      event.preventDefault()
      console.log('[App] Main window close held: asking about the computers connected to the ADF daemon')
    }
  })
  mainWindow.on('closed', () => {
    console.log('[App] Main window closed')
    if (mainWindow === createdWindow) mainWindow = null
    // Windows/Linux: closing it quits (window-all-closed), so a boot dialog
    // still open must not keep Studio alive, nor be answered later. macOS: it stays.
    noteMainWindowClosed()
  })

  // Webview guests may only load the local agent-browser (noVNC) pages, with
  // no preload and no node access.
  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete (webPreferences as { preload?: string }).preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(params.src ?? '')) {
      event.preventDefault()
    }
  })

  const notifyFullscreenChanged = (): void => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return
    mainWindow.webContents.send(IPC.APP_FULLSCREEN_CHANGED, mainWindow.isFullScreen())
  }
  mainWindow.on('enter-full-screen', notifyFullscreenChanged)
  mainWindow.on('leave-full-screen', notifyFullscreenChanged)

  if (!isMac) {
    const applyOverlay = () => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      try {
        mainWindow.setTitleBarOverlay(getOverlayColors())
      } catch {
        // Linux WMs that don't support setTitleBarOverlay throw — ignore.
      }
    }
    nativeTheme.on('updated', applyOverlay)
    mainWindow.on('closed', () => nativeTheme.off('updated', applyOverlay))
  }

  // --- Content Security Policy ---
  const isDev = !!process.env.ELECTRON_RENDERER_URL
  const cspDirectives = [
    "default-src 'self'",
    isDev ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' adf-file: data: blob:",
    "font-src 'self' data:",
    isDev
      ? "connect-src 'self' ws: wss: http://localhost:* http://127.0.0.1:*"
      : "connect-src 'self' ws://localhost:* wss://localhost:* http://localhost:* http://127.0.0.1:*",
    "media-src 'self' adf-file: blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'"
  ]
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [cspDirectives.join('; ')]
      }
    })
  })

  // External links open in default browser (safe protocols only)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'mailto:') {
        shell.openExternal(url)
      } else {
        console.warn(`[App] Blocked openExternal for disallowed protocol: ${parsed.protocol}`)
      }
    } catch {
      console.warn(`[App] Blocked openExternal for invalid URL: ${url}`)
    }
    return { action: 'deny' }
  })

  // Block renderer navigation to external pages — prevents XSS from hijacking adfApi surface
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const rendererUrl = process.env.ELECTRON_RENDERER_URL
    if (rendererUrl && url.startsWith(rendererUrl)) return
    event.preventDefault()
    console.warn(`[App] Blocked navigation to: ${url}`)
  })

  // Log renderer console messages to main process stdout. Every renderer log
  // line otherwise crosses the bridge and is re-formatted into the main log —
  // in a packaged run that is pure overhead, so only warnings and errors get
  // through. Dev keeps everything, and ADF_RENDERER_LOG=1 forces it back on.
  const verboseRendererLog = isDev || process.env.ADF_RENDERER_LOG === '1'
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    // Chromium levels: 0 verbose, 1 info, 2 warning, 3 error
    if (!verboseRendererLog && level < 2) return
    const levelStr = ['VERBOSE', 'INFO', 'WARNING', 'ERROR'][level] ?? 'LOG'
    console.log(`[Renderer ${levelStr}] ${message} (${sourceId}:${line})`)
  })

  // Belt-and-braces push once the renderer is ready. Deliberately does NOT
  // clear the queue: the renderer's listener registers in a React effect and
  // may miss this push — the OPEN_FILE_GET_PENDING pull clears instead.
  mainWindow.webContents.on('did-finish-load', () => {
    if (fileToOpen && mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send(IPC.OPEN_FILE_REQUEST, { filePath: fileToOpen })
    }
  })

  // Load the renderer
  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) {
    mainWindow.loadURL(rendererUrl)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return mainWindow
}

// Harden webview guests (agent-browser noVNC pages): no popups, no navigation
// off host loopback.
app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event, url) => {
    if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) {
      event.preventDefault()
      console.warn(`[App] Blocked webview navigation to: ${url}`)
    }
  })
})

app.whenReady().then(async () => {
  // Dev/diagnostic only: logs one line per multi-hundred-ms main-thread freeze.
  // Creates nothing in a packaged build unless ADF_STALL_MONITOR=1.
  const stallMonitor = startStallMonitor({ packaged: app.isPackaged })
  if (stallMonitor) {
    console.log(`[App] Stall monitor active (threshold ${stallMonitor.thresholdMs} ms)`)
    app.once('before-quit', () => stopStallMonitor())
  }

  // Backend selection (design D9): decided once, before any handler exists.
  // No studio-backend.json and no ADF_STUDIO_BACKEND means Local daemon (W5-I, first-launch.ts).
  // SESSION_BACKEND_ARG: the user chose embedded for one launch (§8.2 version mismatch).
  const sessionBackend = sessionBackendEnv(process.argv, process.env)
  const backend = resolveBootBackend(backendConfigPath(getUserDataPath()), sessionBackend.env)
  if (sessionBackend.session) backend.source = 'session'
  // W5-I: an unusable studio-backend.json is asked about first; an older daemon on the port makes a first launch Embedded for one session.
  const bootGuard = await guardBoot(backend, getUserDataPath())
  // A mode this launch overrides for one session (ADF_STUDIO_BACKEND, or the
  // version-mismatch choice) moves client keys only: credentials stay where
  // the configured mode keeps them (§8.2).
  const sessionOnly = backend.source === 'env' || backend.source === 'session'
  // Mode-switch handover (§11): move what belongs to this mode's side before
  // any backend handler, store or daemon exists. Idempotent; a no-op when
  // everything is already where it belongs.
  const handover = bootGuard.skipHandover ? null : await runBootHandover(backend.mode, getUserDataPath(), { sessionOnly })
  // First launch without studio-backend.json: save the default, and on an install that ran Embedded prepare the one notice.
  const firstLaunch = await settleDefaultBackend(backend, getUserDataPath(), handover, { version: app.getVersion() })
  let backendStore: BackendSettingsStore | null = null
  if (backend.mode === 'embedded') {
    try {
      embeddedIpc = await import('./ipc')
    } catch (err) {
      // A static import that threw here would have failed the main script:
      // Electron's error dialog, then no app. Same for the lazy one.
      failedMainLoad(err)
      return
    }
    embeddedIpc.registerAllIpcHandlers({ showMainWindow, openFile: requestOpenFile, ...(bootGuard.skipAutostart ? { skipBootAutostart: bootGuard.skipAutostart } : {}) })
    // A daemon that keeps running on these settings re-reads the stores the handover emptied.
    if (handover?.changed && !sessionOnly) void notifyDaemonOfHandover(getUserDataPath())
    // The agents that ran before a switch run again here (§11.1), once the
    // mesh is up, as autostart waits for it (a null wsConnectionManager otherwise).
    const embedded = embeddedIpc
    void resumeSwitchedAgents('embedded', getUserDataPath(), async (filePath) =>
      embedded.hostActions?.startBackgroundAgent?.(filePath) ?? { success: false, error: "the embedded backend is not ready" }, { ready: embedded.hostActions?.ready })
  } else {
    const userDataDir = getUserDataPath()
    daemonMode = registerDaemonModeHandlers({
      mode: backend.mode,
      userDataDir,
      connect: backend.mode === 'local'
        ? localDaemonConnector({
          userDataDir,
          execPath: process.execPath,
          daemonEntry: join(__dirname, 'daemon.js'),
          onVersionMismatch: (decision, running, clients) => askVersionMismatch(decision, running, clients, () => mainWindow),
        })
        : remoteDaemonConnector(backend.config, safeStorageCodec),
      hooks: { showMainWindow, openFile: requestOpenFile },
      // Sleep and wake: the daemon is checked and the client stream re-dialed on resume.
      powerMonitor,
      // Read at quit: a change in Settings → Backend applies to the next quit.
      keepDaemonRunning: () => backendStore?.config().keepDaemonRunning ?? backend.config.keepDaemonRunning,
      reloadCredentials: handover?.changed === true && !sessionOnly,
      onRemoteAccessEvent: (payload) => remoteAccess?.onDaemonEvent(payload),
      ...(backend.mode === 'local' ? { afterOwnerImport: (phrase: string) => syncRuntimeEntryAfterImport(userDataDir, phrase) } : {}),
    })
    const handle = daemonMode
    void handle.ready.then(async (ok) => { if (ok) await resumeSwitchedAgents(backend.mode, userDataDir, (filePath) => handle.startBackgroundAgent(filePath)) })
  }
  // Client keys (updater, spellcheck) come from studio-client-settings.json in daemon mode (§4.1).
  const readClientSetting = (key: string): unknown => daemonMode ? daemonMode.clientSettings.get(key) : embeddedIpc?.readAppSetting(key)
  const writeClientSetting = (key: string, value: unknown): void => {
    if (daemonMode) daemonMode.clientSettings.set(key, value)
    else embeddedIpc?.writeAppSetting(key, value)
  }
  const switcher = createModeSwitcher({
    activeMode: backend.mode,
    userDataDir: getUserDataPath(),
    agentActivity: () => daemonMode
      ? daemonMode.agentActivity()
      : embeddedIpc?.hostActions?.agentActivity?.() ?? processAgentLeases().heldPaths().map((filePath) => ({ filePath, busy: false })),
    keepDaemonRunning: () => backendStore?.config().keepDaemonRunning ?? false,
    daemonStartedBy: () => daemonMode?.status().startedBy ?? null,
    window: () => mainWindow,
    remoteUrl: () => backendStore?.config().remote.url ?? backend.config.remote.url,
    relaunch: (target) => {
      switchingTo = target
      relaunchStudio(`the backend was switched to ${target} in Settings → Backend`)
    },
  })
  backendStore = registerBackendSettingsHandlers(backend, {
    daemonStatus: () => daemonMode?.status() ?? null,
    confirmModeSwitch: switcher.confirm,
    applyModeSwitch: switcher.apply,
    pendingSwitch: switcher.pendingSwitch,
    finishSwitchNow: switcher.finishNow,
    cancelSwitch: switcher.cancel,
    restarting: () => { const target = switcher.restartingInto(); return target ? restartingMessage(target) : null },
    onKeepDaemonRunningChange: (keep) => { void daemonMode?.setKeepDaemonRunning(keep) },
  })
  remoteAccess = registerRemoteAccessHandlers({
    mode: backend.mode,
    daemon: () => daemonMode,
    backend: backendStore,
    codec: safeStorageCodec,
    window: () => mainWindow,
    keepDaemonRunning: () => backendStore?.config().keepDaemonRunning ?? false,
    settingsDir: getUserDataPath(),
    meshLan: () => embeddedIpc?.meshLanState() ?? null,
  })
  registerOrbitalCacheHandlers(app.getPath('userData'))
  registerEditRecoveryHandlers(join(app.getPath('userData'), 'recovered'))
  ipcMain.handle(IPC.APP_GET_FULLSCREEN, () => mainWindow?.isFullScreen() ?? false)
  ipcMain.handle(IPC.APP_SET_FULLSCREEN, (_event, fullscreen: boolean) => {
    mainWindow?.setFullScreen(!!fullscreen)
  })

  // Serve files from the current workspace's adf_files table via adf-file:// URLs
  // (daemon mode: from the daemon's raw file route, daemon-mode/adf-file.ts).
  if (daemonMode) protocol.handle('adf-file', daemonMode.adfFile)
  else protocol.handle('adf-file', (request) => {
    const workspace = embeddedIpc?.getCurrentWorkspace()
    if (!workspace) {
      return new Response('No workspace open', { status: 404 })
    }

    // Extract path: adf-file://img1.png → img1.png, adf-file://files/chart.png → files/chart.png
    // Avoid URL constructor since Chromium adds trailing slashes to standard scheme hostnames.
    const filePath = decodeURIComponent(
      request.url.replace('adf-file://', '').split('?')[0].split('#')[0].replace(/\/+$/, '')
    )

    // Reject path traversal attempts (defense-in-depth; WHERE path=? already prevents FS traversal)
    if (filePath.includes('..') || filePath.startsWith('/')) {
      return new Response('Invalid path', { status: 400 })
    }

    const entry = workspace.getDatabase().readFile(filePath)
    if (!entry) {
      return new Response('File not found', { status: 404 })
    }

    // Validate MIME type against safe prefixes to prevent content-type confusion
    const SAFE_MIME_PREFIXES = ['image/', 'text/', 'audio/', 'video/', 'application/pdf', 'application/json', 'application/octet-stream', 'font/']
    const rawType = entry.mime_type ?? 'application/octet-stream'
    const contentType = SAFE_MIME_PREFIXES.some(p => rawType.startsWith(p)) ? rawType : 'application/octet-stream'

    return new Response(new Uint8Array(entry.content), {
      headers: {
        'Content-Type': contentType,
        'X-Content-Type-Options': 'nosniff'
      }
    })
  })

  initSpellcheckDictionaries({
    isAllowed: () => readClientSetting('spellcheckDownloadsEnabled') === true,
    allow: () => writeClientSetting('spellcheckDownloadsEnabled', true)
  })

  createWindow()
  // Over the main window once it is ready: the boot guard's dialog, the first-launch notice (once the daemon connected) or the handover summary.
  const bootWindow = mainWindow
  if (bootWindow) bootWindow.once('ready-to-show', () => void showBootNotices({ report: handover, mode: backend.mode, notice: firstLaunch, guard: bootGuard.notice, window: bootWindow, ready: daemonMode?.ready, userDataDir: getUserDataPath() }))

  initAppUpdater({
    // Read per check, not cached: turning it off in Settings stops the next one.
    isCheckEnabled: () => readClientSetting('updateChecksEnabled') !== false,
    send: (state) => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send(IPC.APP_UPDATE_STATE, state)
      }
    },
    prepareQuitForUpdate: async () => {
      // Same teardown as a normal quit (also raises the renderer's shutdown
      // overlay), then let the updater's own app.quit() run to completion —
      // on macOS Squirrel's ShipIt must see the process exit on its terms.
      await runShutdownCleanup()
      quittingForUpdate = true
    }
  })

  // Clean up scratch dirs left by previous instances that exited uncleanly.
  // Deferred so the synchronous temp-dir scan never delays first paint.
  setImmediate(() => purgeStaleProcessDirs())

  app.on('activate', () => {
    // Through the same gate, so a Dock click during quit cleanup can't boot a
    // window that app.exit is about to tear down.
    if (BrowserWindow.getAllWindows().length === 0) showMainWindow()
  })

  startupComplete = true
})

app.on('window-all-closed', () => {
  console.log('[App] All windows closed')
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Gracefully kill all child processes (MCP servers, background agents) on quit.
// Re-entrant: the first before-quit starts cleanup and exits when done (or when
// the budget expires); later before-quit events just preventDefault and return.
app.on('before-quit', (event) => {
  if (quittingForUpdate) return
  event.preventDefault()
  if (shutdownCleanup) return
  if (!remoteQuitHold(() => app.quit())) {
    console.log('[App] before-quit held: asking about the computers connected to the ADF daemon')
    return
  }
  console.log('[App] before-quit — starting shutdown cleanup')
  // A boot dialog still open (macOS keeps one after its window closed) is no answer: nothing restarts from it.
  dismissBootDialogs('Studio is quitting')
  void runShutdownCleanup().finally(() => app.exit(0))
})
