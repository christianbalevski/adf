/* global require, console */
// Real Electron, no Studio (tests/backend/adf-file-window-header.test.ts runs
// it): an `adf-file://` image request carries the webContents id of the
// window that asked, put on by session.webRequest.onBeforeSendHeaders.
// main/index.ts relies on this to serve each agent window's images from its
// own agent (docs/design/agent-windows.md §4). The scheme privileges, the
// filter and the hook are the ones main/index.ts registers.
const { app, BrowserWindow, protocol, session } = require('electron')
const { join } = require('node:path')
const { mkdtempSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')

const HEADER = 'X-ADF-Window'
const work = mkdtempSync(join(tmpdir(), 'adf-file-window-header-'))
app.setPath('userData', join(work, 'user-data'))
protocol.registerSchemesAsPrivileged([{ scheme: 'adf-file', privileges: { secure: true, supportFetchAPI: true, stream: true } }])

const fail = (message) => { console.log(`RESULT ${JSON.stringify({ ok: false, message })}`); app.exit(1) }
setTimeout(() => fail('timed out'), 20_000).unref()

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => {
    if (!details.url.startsWith('adf-file:')) { callback({}); return }
    callback({ requestHeaders: { ...details.requestHeaders, [HEADER]: String(details.webContentsId ?? '') } })
  })
  const seen = []
  protocol.handle('adf-file', (request) => {
    seen.push({ url: request.url, window: request.headers.get(HEADER) })
    return new Response('x', { headers: { 'Content-Type': 'image/png' } })
  })
  const page = join(work, 'page.html')
  writeFileSync(page, '<img src="adf-file://files/chart.png">')
  const ids = []
  for (const q of ['a', 'b']) {
    const win = new BrowserWindow({ show: false })
    ids.push(win.webContents.id)
    await win.loadFile(page, { query: { window: q } })
  }
  const deadline = Date.now() + 10_000
  while (seen.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
  console.log(`RESULT ${JSON.stringify({ ok: true, ids, seen })}`)
  app.exit(0)
}).catch((err) => fail(String(err && err.stack || err)))
