import { readFileSync, watch, type FSWatcher } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { cleanDisplayName } from '../daemon/remote-access/config'
import { localRuntimeName } from '../../shared/runtime-name'

/**
 * This computer's runtime name (docs/design/multi-runtime.md §1.3): the
 * runtime alias in `adf-settings.json` (Settings → Identity, or the computer
 * name of remote access), else the host name. One name everywhere (mDNS,
 * pairing, device lists, and the runtime set as `<name> (Local)`); the daemon
 * reads the same setting. Electron-free: the CLI reads it too.
 */

const SETTINGS_FILE = 'adf-settings.json'

function aliasOf(text: string): string | null {
  const alias = (JSON.parse(text) as { runtimeAlias?: unknown } | null)?.runtimeAlias
  return cleanDisplayName(alias, 64)
}

/** The alias in `settingsFile`, else `host()`; null when neither is known. */
export function machineNameFromFile(settingsFile: string | undefined, host: () => string = hostname): string | null {
  if (settingsFile) {
    try {
      const name = aliasOf(readFileSync(settingsFile, 'utf-8'))
      if (name) return name
    } catch { /* no settings file yet: the host name */ }
  }
  return host().trim() || null
}

/** The runtime name of the settings in `settingsDir`: the alias, else the host name. */
export function machineName(settingsDir: string | undefined, host: () => string = hostname): string {
  return machineNameFromFile(settingsDir ? join(settingsDir, SETTINGS_FILE) : undefined, host) ?? ''
}

/**
 * Studio main's copy of the local runtime's display name. Read once at
 * boot; afterwards `adf-settings.json` is watched and read again off the
 * main thread, so `display()` never touches the disk. `onChange` runs when
 * the name changes (the runtime list and menus are pushed again).
 */
export class LocalRuntimeName {
  private name: string | null
  private watcher: FSWatcher | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly settingsDir: string, private readonly host: () => string = hostname) {
    this.name = machineNameFromFile(join(settingsDir, SETTINGS_FILE), host)
  }

  /** `<name> (Local)`, or "Local". */
  display(): string {
    return localRuntimeName(this.name)
  }

  /** Read the settings again; true when the name changed. */
  async refresh(): Promise<boolean> {
    let next: string | null = null
    try {
      next = aliasOf(await readFile(join(this.settingsDir, SETTINGS_FILE), 'utf-8'))
    } catch { /* missing or mid-write: the host name */ }
    next = next ?? (this.host().trim() || null)
    if (next === this.name) return false
    this.name = next
    return true
  }

  /** Follow changes to the settings file (Studio, `adf`, the daemon); `onChange` after a change of name. */
  watch(onChange: () => void, log: Pick<Console, 'warn'> = console): void {
    if (this.watcher) return
    try {
      this.watcher = watch(this.settingsDir, { persistent: false }, (_event, file) => {
        if (file && String(file) !== SETTINGS_FILE) return
        if (this.timer) clearTimeout(this.timer)
        this.timer = setTimeout(() => {
          this.timer = null
          void this.refresh().then((changed) => { if (changed) onChange() })
        }, 250)
      })
      this.watcher.on('error', (err) => {
        log.warn(`[Runtime] The runtime name no longer follows ${SETTINGS_FILE}: ${err instanceof Error ? err.message : String(err)}`)
        this.dispose()
      })
    } catch (err) {
      log.warn(`[Runtime] The runtime name does not follow ${SETTINGS_FILE}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    try { this.watcher?.close() } catch { /* closed */ }
    this.watcher = null
  }
}
