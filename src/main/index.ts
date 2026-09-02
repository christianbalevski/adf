import { app, BrowserWindow, crashReporter, ipcMain, nativeTheme, protocol, session, shell } from 'electron'
import { execSync } from 'child_process'
import { join } from 'path'
import { registerAllIpcHandlers, cleanupAllProcesses, fastSessionEndCleanup, getCurrentWorkspace } from './ipc'
import { purgeStaleProcessDirs } from './utils/scratch-dir'
import { withDeadline } from './utils/concurrency'
import { IPC } from '../shared/constants/ipc-channels'
import { initAppUpdater } from './services/app-updater.service'

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
if (app.isPackaged && (process.platform === 'darwin' || process.platform === 'linux')) {
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    const shellPath = execSync(`${shell} -ilc 'echo -n $PATH'`, {
      encoding: 'utf-8',
      timeout: 5000
    }).trim()
    if (shellPath) {
      process.env.PATH = shellPath
    }
  } catch {
    // Silently fail — PATH remains as-is
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

let mainWindow: BrowserWindow | null = null
let fileToOpen: string | null = null

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
      const { timedOut } = await withDeadline(cleanupAllProcesses(cleanupOpts), budget, () => {
        console.error(`[App] Cleanup exceeded ${budget}ms budget — forcing exit`)
      })
      if (timedOut) console.error('[App] Shutdown proceeded past incomplete cleanup')
    } catch (error) {
      console.error('[App] Cleanup error:', error)
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
      await withDeadline(fastSessionEndCleanup(2_000), FAST_SHUTDOWN_BUDGET_MS, () => {
        console.error('[App] Session-end cleanup exceeded budget — exiting')
      })
    } catch (error) {
      console.error('[App] Session-end cleanup error:', error)
    }
  })()
  void shutdownCleanup.finally(() => app.exit(0))
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
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.focus()
      }
      const secondAdfArg = argv.find((arg) => arg.endsWith('.adf') && !arg.startsWith('-'))
      if (!secondAdfArg) return
      if (canPushOpenFile()) {
        mainWindow!.webContents.send(IPC.OPEN_FILE_REQUEST, { filePath: secondAdfArg })
      } else {
        fileToOpen = secondAdfArg
      }
    })
  }
}

/**
 * A pushed OPEN_FILE_REQUEST only lands once the renderer has finished
 * loading (and even then its listener registers in a React effect — the
 * OPEN_FILE_GET_PENDING pull covers that gap). Anything earlier queues.
 */
function canPushOpenFile(): boolean {
  const wc = mainWindow?.webContents
  return !!wc && !wc.isDestroyed() && !wc.isLoading()
}

// macOS: fired when user double-clicks .adf or uses Open With
app.on('open-file', (event, filePath) => {
  event.preventDefault()
  if (!filePath.endsWith('.adf')) return
  if (canPushOpenFile()) {
    mainWindow!.webContents.send(IPC.OPEN_FILE_REQUEST, { filePath })
  } else {
    fileToOpen = filePath
  }
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
if (adfArg) fileToOpen = adfArg

function getOverlayColors(): { color: string; symbolColor: string } {
  return nativeTheme.shouldUseDarkColors
    ? { color: '#262626', symbolColor: '#e5e5e5' }
    : { color: '#f5f5f5', symbolColor: '#404040' }
}

async function createWindow(): Promise<void> {
  const isMac = process.platform === 'darwin'

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    // Paint only once the renderer is ready — avoids the white flash.
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#fafafa',
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
  })

  // Windows logoff/shutdown fires 'session-end' on each BrowserWindow (there
  // is no app-level equivalent). Any future window must register this too.
  mainWindow.on('session-end', handleSessionEnd)

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

  // Log renderer console messages to main process stdout
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
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

app.whenReady().then(() => {
  registerAllIpcHandlers()
  ipcMain.handle(IPC.APP_GET_FULLSCREEN, () => mainWindow?.isFullScreen() ?? false)
  ipcMain.handle(IPC.APP_SET_FULLSCREEN, (_event, fullscreen: boolean) => {
    mainWindow?.setFullScreen(!!fullscreen)
  })

  // Serve files from the current workspace's adf_files table via adf-file:// URLs
  protocol.handle('adf-file', (request) => {
    const workspace = getCurrentWorkspace()
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

    return new Response(entry.content, {
      headers: {
        'Content-Type': contentType,
        'X-Content-Type-Options': 'nosniff'
      }
    })
  })

  createWindow()

  initAppUpdater({
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
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
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
  void runShutdownCleanup().finally(() => app.exit(0))
})
