#!/usr/bin/env node
/* global console, process, setTimeout, clearTimeout, WebSocket */
// Smoke test for the packaged macOS app: the Electron runtime paths the unit
// suite can't reach. Launches the real .app (so app.isPackaged is true and the
// login-shell PATH fix runs) with Finder's minimal environment and throwaway
// user data, then drives the main process over the Node inspector:
//
//   1. cold start: one window, shown, renderer mounted;
//   2. PATH: the main process picked up the login shell's PATH (#111) even
//      though an rc file prints noise to stdout;
//   3. close the window, launch a second instance: the app outlives its last
//      window and the second launch recreates it (#109 — it used to throw
//      "Object has been destroyed");
//   4. close the window, Dock-click ('activate'): recreated again;
//   5. quit: cleanup runs and the process exits 0 within the budget.
//
// Any uncaught exception, unhandled rejection or renderer crash in the app's
// output fails the run.
//
// Package first (unsigned, host arch), then run:
//   npm run build
//   npx electron-builder --mac dir --publish never -c.mac.identity=null -c.mac.notarize=false
//   npm run test:electron-smoke  (or: node scripts/electron-smoke.mjs [path/to/ADF Studio.app])

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

if (process.platform !== 'darwin') {
  console.error('electron smoke: macOS only (the window lifecycle and PATH checks are darwin behavior)')
  process.exit(1)
}

// Read by fail(), which can run before the app is launched.
let output = ''
let exitInfo = null
let work

const appPath = resolve(process.argv[2] ?? findPackagedApp())
const binary = join(appPath, 'Contents', 'MacOS', 'ADF Studio')
if (!existsSync(binary)) fail(`no app binary at ${binary}`)

// realpath: on macOS tmpdir() is a /var symlink into /private/var.
work = realpathSync(mkdtempSync(join(tmpdir(), 'adf-electron-smoke-')))
const userData = join(work, 'user-data')
const zdotdir = join(work, 'zdotdir')
const sentinelDir = join(work, 'login-shell-bin')
mkdirSync(zdotdir)
mkdirSync(sentinelDir)
// .zprofile is only read by a login shell, so the sentinel proves the app
// asked a *login* shell. The .zshrc banner (interactive shells only) is the
// stdout noise the resolver must ignore — including a decoy PATH= line.
writeFileSync(join(zdotdir, '.zprofile'), `export PATH="${sentinelDir}:$PATH"\n`)
writeFileSync(join(zdotdir, '.zshrc'), 'echo "smoke banner: PATH=/decoy/from/zshrc"\n')

// What launchd hands an app opened from Finder: no Homebrew, no nvm.
const FINDER_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
const env = {
  HOME: process.env.HOME,
  USER: process.env.USER,
  TMPDIR: process.env.TMPDIR,
  LANG: 'en_US.UTF-8',
  SHELL: '/bin/zsh',
  ZDOTDIR: zdotdir,
  PATH: FINDER_PATH,
  // Settings, credentials and scratch dirs stay in the throwaway dir too.
  ADF_USER_DATA_DIR: userData,
  ADF_TEMP_DIR: join(work, 'tmp'),
  // Never the developer's keychain: a fresh install mints an owner identity
  // and mirrors it into the shared ADF/owner-mnemonic entry the CLI reads.
  ADF_KEYCHAIN: '0',
}
// --use-mock-keychain: Electron's safeStorage key too.
const args = [`--user-data-dir=${userData}`, '--use-mock-keychain']

const FATAL = [
  /\[App\] Uncaught exception/,
  /\[App\] Unhandled rejection/,
  /\[App\] Renderer gone/,
  /Object has been destroyed/,
]

let app
function launch() {
  output = ''
  exitInfo = null
  app = spawn(binary, [...args, '--inspect=0'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  app.stdout.on('data', (d) => { output += d })
  app.stderr.on('data', (d) => { output += d })
  app.on('exit', (code, signal) => { exitInfo = { code, signal } })
}
process.on('exit', () => {
  if (app && !exitInfo) app.kill('SIGKILL')
  if (!process.exitCode) rmSync(work, { recursive: true, force: true })
})

/** Run `body` in the main process with app/BrowserWindow in scope; returns its value. */
const inMain = (body) => evalMain(`(async () => { const { app, BrowserWindow } = process.mainModule.require('electron'); ${body} })()`)
let inspector

try {
  // The inspector is up before the entry module has loaded, and evaluating
  // during bootstrap is unreliable: connect once the app logs its start line.
  // Rarely (seen once locally), a fresh launch dies with exit 1 before the
  // entry module runs a line — empty user data, nothing logged. Retry that
  // one case once; a real startup crash fails both attempts.
  let wsUrl
  for (let attempt = 1; ; attempt++) {
    launch()
    try {
      wsUrl = await waitFor('main-process inspector', 30_000, () => output.match(/Debugger listening on (ws:\/\/\S+)/)?.[1])
      await waitFor('the app start line', 30_000, () => output.includes('[App] ADF Studio '))
      break
    } catch (err) {
      if (attempt > 1 || !exitInfo || output.includes('[App] ')) throw err
      console.log(`electron smoke: app exited ${JSON.stringify(exitInfo)} before its entry module ran — retrying the launch once`)
    }
  }
  inspector = await connect(wsUrl)

  step('cold start')
  await waitForMountedWindow(90_000)

  step('login-shell PATH')
  const path = await evalMain('process.env.PATH')
  const entries = path.split(':')
  check(entries.includes(sentinelDir), `PATH lacks the login shell's ${sentinelDir}: ${path}`)
  check(entries.every((e) => e.startsWith('/')), `PATH has a non-absolute entry (rc-file noise?): ${path}`)
  check(!path.includes('/decoy/'), `PATH took the decoy line from .zshrc: ${path}`)
  check(!output.includes('Login-shell PATH unavailable'), 'the app fell back instead of reading the login shell')

  step('close the last window: the app keeps running')
  await closeAllWindows()

  step('second launch recreates the window')
  const second = spawn(binary, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let secondOutput = ''
  second.stdout.on('data', (d) => { secondOutput += d })
  second.stderr.on('data', (d) => { secondOutput += d })
  const secondCode = await new Promise((res, rej) => {
    const timer = setTimeout(() => { second.kill('SIGKILL'); rej(new Error('second instance did not exit within 30s')) }, 30_000)
    second.on('exit', (code) => { clearTimeout(timer); res(code) })
  })
  check(secondCode === 0, `second instance exited ${secondCode}:\n${secondOutput}`)
  check(secondOutput.includes('Another instance is already running'), `second instance didn't defer to the first:\n${secondOutput}`)
  await waitForMountedWindow(60_000)

  step("close again, then 'activate' (Dock click) recreates it")
  await closeAllWindows()
  await inMain("app.emit('activate', {}, false)")
  await waitForMountedWindow(60_000)

  step('quit')
  await inMain('setTimeout(() => app.quit(), 0)')
  // Cleanup budget is 8s. Node then holds the process open until the
  // inspector disconnects, so let go once the exit is logged.
  await waitFor('the exit log line', 20_000, () => output.includes('[App] Process exiting with code'))
  inspector.close()
  await waitFor('app exit', 10_000, () => exitInfo)
  check(exitInfo.code === 0, `app exited ${JSON.stringify(exitInfo)}`)
  check(output.includes('before-quit — starting shutdown cleanup'), 'quit skipped the shutdown cleanup')

  assertNoFatal()
  console.log('electron smoke: OK')
} catch (err) {
  fail(err instanceof Error ? err.message : String(err))
} finally {
  inspector?.close()
}

// --- helpers ---------------------------------------------------------------

function findPackagedApp() {
  for (const dir of ['dist/mac-arm64', 'dist/mac', 'dist/mac-universal']) {
    if (!existsSync(dir)) continue
    const found = readdirSync(dir).find((f) => f.endsWith('.app'))
    if (found) return join(dir, found)
  }
  fail('no packaged app under dist/ — see the usage comment at the top of this script')
}

function step(name) {
  assertNoFatal()
  console.log(`electron smoke: ${name}`)
}

function check(ok, message) {
  if (!ok) throw new Error(message)
}

function assertNoFatal() {
  const hit = output.split('\n').find((line) => FATAL.some((re) => re.test(line)))
  check(!hit, `the app logged: ${hit}`)
}

async function waitFor(label, timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    assertNoFatal()
    if (exitInfo && label !== 'app exit') throw new Error(`app exited early ${JSON.stringify(exitInfo)} while waiting for ${label}`)
    last = await probe()
    if (last) return last
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${label}`)
}

/** One window, shown, loaded, and the React root has rendered into #root. */
async function waitForMountedWindow(timeoutMs) {
  await waitFor('a shown, mounted main window', timeoutMs, () => inMain(`
    const wins = BrowserWindow.getAllWindows()
    if (wins.length !== 1) return false
    const w = wins[0]
    if (w.isDestroyed() || !w.isVisible() || w.webContents.isLoading()) return false
    // A renderer still settling can leave this promise pending forever.
    const children = await Promise.race([
      w.webContents.executeJavaScript("document.getElementById('root')?.childElementCount ?? 0"),
      new Promise((r) => setTimeout(() => r(0), 2000)),
    ])
    return children > 0
  `).catch(() => false))
}

async function closeAllWindows() {
  await inMain('BrowserWindow.getAllWindows().forEach((w) => w.close())')
  await waitFor('all windows closed', 15_000, () => inMain('return BrowserWindow.getAllWindows().length === 0'))
  // Past window-all-closed: on macOS the app must still be up.
  await new Promise((r) => setTimeout(r, 1_000))
  check(!exitInfo, `the app quit when its last window closed ${JSON.stringify(exitInfo)}`)
}

async function evalMain(expression) {
  const { result, exceptionDetails } = await inspector.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (exceptionDetails) throw new Error(`main-process eval threw: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`)
  return result.value
}

async function connect(url) {
  const ws = new WebSocket(url)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = () => rej(new Error(`cannot connect to the inspector at ${url}`))
  })
  let nextId = 1
  const pending = new Map()
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.error) p.rej(new Error(msg.error.message))
    else p.res(msg.result)
  }
  ws.onclose = () => {
    for (const p of pending.values()) p.rej(new Error('inspector connection closed'))
    pending.clear()
  }
  return {
    send(method, params) {
      const id = nextId++
      ws.send(JSON.stringify({ id, method, params }))
      return new Promise((res, rej) => pending.set(id, { res, rej }))
    },
    close: () => ws.close(),
  }
}

function fail(message) {
  console.error(`electron smoke FAILED: ${message}`)
  if (output) console.error(`--- app output (last 80 lines) ---\n${output.split('\n').slice(-80).join('\n')}`)
  console.error(`(user data kept at ${work ?? '-'})`)
  process.exitCode = 1
  process.exit(1)
}
