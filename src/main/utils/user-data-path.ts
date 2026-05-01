import { homedir } from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function getUserDataPath(): string {
  if (process.env.ADF_USER_DATA_DIR) return process.env.ADF_USER_DATA_DIR
  const electronApp = getElectronApp()
  if (electronApp?.getPath) return electronApp.getPath('userData')
  return defaultUserDataPath()
}

export function getTempPath(): string {
  if (process.env.ADF_TEMP_DIR) return process.env.ADF_TEMP_DIR
  const electronApp = getElectronApp()
  if (electronApp?.getPath) return electronApp.getPath('temp')
  return tmpdir()
}

export function defaultUserDataPath(): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'adf-studio')
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
    return join(appData, 'adf-studio')
  }
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  return join(configHome, 'adf-studio')
}

function getElectronApp(): { getPath?: (name: string) => string } | null {
  try {
    const electron = require('electron') as { app?: { getPath?: (name: string) => string } }
    return electron.app ?? null
  } catch {
    return null
  }
}
