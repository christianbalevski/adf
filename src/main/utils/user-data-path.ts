import { homedir } from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

/**
 * productName from electron-builder.yml. Packaged Studio's
 * app.getPath('userData') resolves to this directory, NOT the package-name
 * directory ('adf-studio'). The daemon (electron-free) must read the same
 * settings file, so it prefers this directory when it holds settings.
 */
const PRODUCT_NAME = 'ADF Studio'
/** package.json name — dev-mode / legacy fallback directory. */
const PACKAGE_NAME = 'adf-studio'
const SETTINGS_FILE = 'adf-settings.json'

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

function platformConfigBase(): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support')
  }
  if (process.platform === 'win32') {
    return process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  }
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
}

let loggedDefaultPath: string | null = null

export function defaultUserDataPath(): string {
  if (process.env.ADF_USER_DATA_DIR) return process.env.ADF_USER_DATA_DIR
  const base = platformConfigBase()
  // Packaged Studio writes settings under the productName directory
  // (app.getPath('userData')). Prefer it when it holds a settings file so
  // the daemon reads the SAME config as the installed app instead of
  // booting empty from the package-name directory.
  const productDir = join(base, PRODUCT_NAME)
  const packageDir = join(base, PACKAGE_NAME)
  const chosen = existsSync(join(productDir, SETTINGS_FILE)) ? productDir : packageDir
  if (loggedDefaultPath !== chosen) {
    loggedDefaultPath = chosen
    console.log(`[UserDataPath] Using user data directory: ${chosen}`)
  }
  return chosen
}

function getElectronApp(): { getPath?: (name: string) => string } | null {
  try {
    const electron = require('electron') as { app?: { getPath?: (name: string) => string } }
    return electron.app ?? null
  } catch {
    return null
  }
}
