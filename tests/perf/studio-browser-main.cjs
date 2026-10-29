const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { writeFileSync } = require('node:fs')
const work = process.env.STUDIO_BENCH_DIR
if (!work) throw new Error('Run through scripts/bench-studio.mjs')
app.setPath('userData', join(work, 'user-data'))
app.commandLine.appendSwitch('disable-background-networking')
app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { backgroundThrottling: false, nodeIntegration: false, contextIsolation: true } })
    await win.loadFile(join(work, 'index.html'))
    const profile = process.env.STUDIO_BENCH_PROFILE === '1'
    if (profile) {
      win.webContents.debugger.attach('1.3')
      await win.webContents.debugger.sendCommand('Profiler.enable')
      await win.webContents.debugger.sendCommand('Profiler.start')
    }
    const results = await win.webContents.executeJavaScript('window.runStudioBench()')
    if (profile) {
      const { profile: data } = await win.webContents.debugger.sendCommand('Profiler.stop')
      writeFileSync(join(work, 'studio.cpuprofile'), JSON.stringify(data))
    }
    results.runtime = process.versions
    writeFileSync(join(work, 'results.json'), JSON.stringify(results, null, 2))
    win.destroy()
    app.quit()
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
})
