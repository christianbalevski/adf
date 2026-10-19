/* global require, console */
// Real Electron, no Studio (tests/backend/blocked-navigation-events.test.ts
// runs it): which navigation events a page sees when main blocks the
// navigation in will-navigate, as main/index.ts does for every page
// navigation, and when the page really reloads. menu.ts decides from these
// when a page stops taking menu actions (docs/design/agent-windows.md §4).
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdtempSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')

const work = mkdtempSync(join(tmpdir(), 'adf-blocked-navigation-'))
app.setPath('userData', join(work, 'user-data'))
const fail = (message) => { console.log(`RESULT ${JSON.stringify({ ok: false, message })}`); app.exit(1) }
setTimeout(() => fail('timed out'), 20_000).unref()

app.whenReady().then(async () => {
  const page = join(work, 'page.html')
  writeFileSync(page, '<a id="out" href="https://example.invalid/">out</a><a id="in" href="#here">in</a>')
  const win = new BrowserWindow({ show: false })
  const wc = win.webContents
  const events = []
  let phase = 'load'
  wc.on('will-navigate', (event, url) => {
    events.push({ phase, event: 'will-navigate', url })
    if (phase !== 'reload') event.preventDefault()
  })
  wc.on('did-start-navigation', (details) => events.push({ phase, event: 'did-start-navigation', isMainFrame: details.isMainFrame, isSameDocument: details.isSameDocument }))
  wc.on('did-navigate', () => events.push({ phase, event: 'did-navigate' }))
  wc.on('did-navigate-in-page', () => events.push({ phase, event: 'did-navigate-in-page' }))
  await win.loadFile(page)
  const settle = () => new Promise((r) => setTimeout(r, 800))
  phase = 'blocked'
  await wc.executeJavaScript('document.getElementById("out").click()')
  await settle()
  phase = 'in-page'
  await wc.executeJavaScript('document.getElementById("in").click()')
  await settle()
  phase = 'reload'
  wc.reload()
  await settle()
  console.log(`RESULT ${JSON.stringify({ ok: true, events: events.filter((e) => e.phase !== 'load') })}`)
  app.exit(0)
}).catch((err) => fail(String((err && err.stack) || err)))
