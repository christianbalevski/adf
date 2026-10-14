/**
 * Settings key classes (docs/design/daemon-backend.md §4.1): every settings
 * key read or written in src/ is in exactly one of CLIENT_SETTINGS_KEYS and
 * BACKEND_SETTINGS_KEYS, so daemon mode can split SETTINGS_SET and route each
 * read to the file that owns it.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BACKEND_SETTINGS_KEYS,
  CLIENT_SETTINGS_KEYS,
  settingsKeyClass,
} from '../../src/shared/constants/client-settings-keys'
import { createSettingsDefaults } from '../../src/shared/constants/settings-defaults'

const ROOT = join(__dirname, '..', '..')

function sourceFiles(dir: string): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(p))
    else if (/\.tsx?$/.test(entry.name)) out.push({ path: p, text: readFileSync(p, 'utf8') })
  }
  return out
}

/**
 * Settings stores are reached as `settings`, `settingsStore`, `settingsRef`,
 * `store` or `identitySettings` (with any `this.` / `opts.` / `deps.` prefix):
 * SettingsService, FileSettingsStore and the narrow store interfaces handed
 * to services. `readAppSetting` / `writeAppSetting` are Studio main's helpers.
 */
const STORE_ACCESS = /(?:^|[^\w$])(?:settings|settingsStore|settingsRef|store|identitySettings)\??\.(?:get|set|delete)\(\s*['"]([A-Za-z][\w.-]*)['"]/g
const APP_SETTING_HELPER = /\b(?:readAppSetting|writeAppSetting)\(\s*['"]([A-Za-z][\w.-]*)['"]/g
/** Renderer writes: `setSettings({ key: … })`. */
const RENDERER_WRITE = /\bsetSettings\??\.?\(\s*\{\s*([A-Za-z]\w*)\s*[:,}]/g

function keysUsedInSource(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>()
  const add = (key: string, file: string) => {
    if (!found.has(key)) found.set(key, new Set())
    found.get(key)!.add(relative(ROOT, file))
  }
  for (const f of sourceFiles(join(ROOT, 'src'))) {
    for (const re of [STORE_ACCESS, APP_SETTING_HELPER, RENDERER_WRITE]) {
      for (const m of f.text.matchAll(re)) add(m[1], f.path)
    }
  }
  return found
}

describe('settings key classes', () => {
  it('puts no key in both classes', () => {
    const both = CLIENT_SETTINGS_KEYS.filter((k) => (BACKEND_SETTINGS_KEYS as readonly string[]).includes(k))
    expect(both).toEqual([])
    expect(new Set(CLIENT_SETTINGS_KEYS).size).toBe(CLIENT_SETTINGS_KEYS.length)
    expect(new Set(BACKEND_SETTINGS_KEYS).size).toBe(BACKEND_SETTINGS_KEYS.length)
  })

  it('classifies every settings key read or written in src/', () => {
    const used = keysUsedInSource()
    // The scan must see the known readers, or it is not looking at anything.
    expect(used.get('trackedDirectories')?.size ?? 0).toBeGreaterThan(1)
    expect(used.has('updateChecksEnabled')).toBe(true)
    expect(used.has('onboardingSharedAt')).toBe(true)

    const unclassified = [...used]
      .filter(([key]) => settingsKeyClass(key) === null)
      .map(([key, files]) => `${key} (${[...files].join(', ')})`)
    expect(unclassified).toEqual([])
  })

  it('classifies every default settings key', () => {
    const unclassified = Object.keys(createSettingsDefaults()).filter((key) => settingsKeyClass(key) === null)
    expect(unclassified).toEqual([])
  })

  it('keeps the client class to the keys of design §4.1', () => {
    expect([...CLIENT_SETTINGS_KEYS].sort()).toEqual([
      'agentAvatars', 'fleetGroups', 'fleetMapState', 'fleetStewards', 'menuBarEnabled',
      'nativeNotificationsEnabled', 'onboardingSharedAt', 'recentFiles', 'spellcheckDownloadsEnabled',
      'templatesMigrationSeen', 'theme', 'uiFont', 'uiFontCustom', 'uiScale', 'updateChecksEnabled',
    ])
    for (const key of ['trackedDirectories', 'agentsFolder', 'compute', 'remoteCatalogsEnabled', 'providerChecksEnabled', 'skillCatalogSources']) {
      expect(settingsKeyClass(key)).toBe('backend')
    }
  })

  it('has Studio-host modules read only client keys', () => {
    // These run in Studio main in every mode; a backend key read here would go
    // stale in daemon mode, where the daemon owns that key.
    const hostModules = ['src/main/index.ts', 'src/main/menu.ts', 'src/main/services/app-updater.service.ts', 'src/main/services/spellcheck-dictionaries.service.ts']
    const backendReads: string[] = []
    for (const rel of hostModules) {
      const text = readFileSync(join(ROOT, rel), 'utf8')
      for (const re of [STORE_ACCESS, APP_SETTING_HELPER]) {
        for (const m of text.matchAll(re)) if (settingsKeyClass(m[1]) !== 'client') backendReads.push(`${rel}: ${m[1]}`)
      }
    }
    expect(backendReads).toEqual([])
  })
})
