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

const files = sourceFiles(join(ROOT, 'src'))

/** String constants (`const UI_FONT_SYSTEM_MIGRATION_KEY = 'uiFontSystemDefaultApplied'`) by name. */
const constants = new Map<string, string>()
for (const f of files) {
  for (const m of f.text.matchAll(/\bconst ([A-Z][A-Z0-9_]*)\s*=\s*['"]([A-Za-z][\w.-]*)['"]/g)) constants.set(m[1], m[2])
}

/** A string literal or the name of a string constant. */
const KEY_ARG = String.raw`(?:['"]([A-Za-z][\w.-]*)['"]|([A-Z][A-Z0-9_]*)\b)`
/**
 * Settings stores are reached as `settings`, `settingsStore`, `settingsRef`,
 * `store` or `identitySettings` (with any `this.` / `opts.` / `deps.` prefix):
 * SettingsService, FileSettingsStore and the narrow store interfaces handed
 * to services. `readAppSetting` / `writeAppSetting` are Studio main's helpers.
 */
const STORE_ACCESS = new RegExp(String.raw`(?:^|[^\w$])(?:settings|settingsStore|settingsRef|store|identitySettings)\??\.(?:get|set|delete)\(\s*` + KEY_ARG, 'g')
const APP_SETTING_HELPER = new RegExp(String.raw`\b(?:readAppSetting|writeAppSetting)\(\s*` + KEY_ARG, 'g')
/** The raw settings record in settings-migrations.ts: `data[KEY]`, `data.key`. */
const MIGRATION_DATA = new RegExp(String.raw`\bdata(?:\[\s*` + KEY_ARG + String.raw`\s*\]|\.([A-Za-z]\w*))`, 'g')

function keyOf(m: RegExpMatchArray): string | null {
  const literal = m[1] ?? m[3]
  if (literal) return literal
  const name = m[2]
  // A constant that is not a string (e.g. the RUNTIME_KEY_MAP record) is not a key.
  return name ? constants.get(name) ?? null : null
}

/** Top-level keys of the object literal starting at `text[open]` (`{`): plain, quoted, shorthand and `[CONST]`. */
function objectLiteralKeys(text: string, open: number): string[] {
  const keys: string[] = []
  let depth = 0
  let expectKey = true
  for (let i = open; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{' || ch === '(' || ch === '[') {
      if (ch === '[' && depth === 1 && expectKey) {
        const close = text.indexOf(']', i)
        const name = text.slice(i + 1, close).trim()
        keys.push(constants.get(name) ?? `<unresolved ${name}>`)
        i = close
        expectKey = false
        continue
      }
      depth++
      continue
    }
    if (ch === '}' || ch === ')' || ch === ']') {
      depth--
      if (depth === 0) break
      continue
    }
    if (depth !== 1) continue
    if (ch === ',') { expectKey = true; continue }
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = text.indexOf(ch, i + 1)
      if (expectKey && ch !== '`') keys.push(text.slice(i + 1, end))
      expectKey = false
      i = end
      continue
    }
    if (expectKey && /[A-Za-z_$]/.test(ch)) {
      const id = /^[A-Za-z_$][\w$]*/.exec(text.slice(i))![0]
      if (!text.slice(i - 3, i).endsWith('...')) keys.push(id)
      i += id.length - 1
      expectKey = false
    }
  }
  return keys
}

/** Renderer writes: `setSettings({ … })` and SettingsPage's `writeSetting({ … })`. */
function rendererWriteKeys(text: string): string[] {
  const keys: string[] = []
  for (const m of text.matchAll(/\b(?:setSettings|writeSetting)\??\.?\(\s*\{/g)) {
    keys.push(...objectLiteralKeys(text, m.index! + m[0].length - 1))
  }
  return keys
}

function keysUsedInSource(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>()
  const add = (key: string | null, file: string) => {
    if (!key) return
    if (!found.has(key)) found.set(key, new Set())
    found.get(key)!.add(relative(ROOT, file))
  }
  for (const f of files) {
    for (const re of [STORE_ACCESS, APP_SETTING_HELPER]) for (const m of f.text.matchAll(re)) add(keyOf(m), f.path)
    if (f.path.endsWith('settings-migrations.ts')) for (const m of f.text.matchAll(MIGRATION_DATA)) add(keyOf(m), f.path)
    for (const key of rendererWriteKeys(f.text)) add(key, f.path)
  }
  return found
}

/** Body of `function name(` in text, by brace matching. */
function functionBody(text: string, name: string): string {
  const start = text.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`function ${name} not found`)
  const open = text.indexOf('{', text.indexOf(')', start))
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return text.slice(open, i + 1)
  }
  throw new Error(`function ${name} not closed`)
}

function settingsReads(text: string): string[] {
  const keys: string[] = []
  for (const re of [STORE_ACCESS, APP_SETTING_HELPER]) for (const m of text.matchAll(re)) { const k = keyOf(m); if (k) keys.push(k) }
  return keys
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
    // The scan must see each kind of access, or it is not looking at anything.
    expect(used.get('trackedDirectories')?.size ?? 0).toBeGreaterThan(1) // store access
    expect(used.has('updateChecksEnabled')).toBe(true) // readAppSetting
    expect(used.has('uiFontSystemDefaultApplied')).toBe(true) // data[CONST] in migrations
    expect(used.has('autoApplyPromptUpdates')).toBe(true) // writeSetting({ [CONST]: … })
    expect(used.has('defaultProviderId')).toBe(true) // second key of setSettings({ a, b })
    expect(used.has('onboardingSharedAt')).toBe(true) // renderer-only key

    const unclassified = [...used]
      .filter(([key]) => settingsKeyClass(key) === null)
      .map(([key, where]) => `${key} (${[...where].join(', ')})`)
    expect(unclassified).toEqual([])
  })

  it('daemon mode can write every key the renderer writes: client keys to the client file, the rest through PATCH /settings, none refused', () => {
    // In daemon mode SETTINGS_SET sends every non-client key to PATCH /settings
    // (daemon-mode/settings.ts splitSettingsPatch); the daemon refuses its
    // write-denied keys (daemon/http-api.ts SETTINGS_WRITE_DENY_KEYS and the
    // secret keys), which would fail the renderer's whole write.
    const api = readFileSync(join(ROOT, 'src', 'main', 'daemon', 'http-api.ts'), 'utf8')
    const listOf = (name: string): string[] => {
      const start = api.indexOf(`const ${name} = [`)
      expect(start, name).toBeGreaterThanOrEqual(0)
      const body = api.slice(start, api.indexOf(']', start))
      return [...body.matchAll(/'([A-Za-z][\w:.-]*)'/g)].map((m) => m[1])
    }
    const denied = new Set([...listOf('SETTINGS_SECRET_KEYS'), ...listOf('SETTINGS_WRITE_DENY_KEYS')])
    expect(denied.has('trustedDaemonEncKeys')).toBe(true)
    const rendererKeys = new Set<string>()
    for (const f of files) if (relative(ROOT, f.path).startsWith(join('src', 'renderer'))) for (const key of rendererWriteKeys(f.text)) rendererKeys.add(key)
    expect(rendererKeys.has('providers')).toBe(true)
    expect(rendererKeys.has('theme')).toBe(true)
    const refused = [...rendererKeys].filter((key) => settingsKeyClass(key) !== 'client' && (denied.has(key) || key.startsWith('ownerMnemonicSuperseded:')))
    expect(refused).toEqual([])
  })

  it('reads every key of a multi-key setSettings literal', () => {
    const keys = objectLiteralKeys("({ providers: rest, defaultProviderId: next ?? '', [UI_FONT_SYSTEM_MIGRATION_KEY]: true, compute, ...other })", 1)
    expect(keys).toEqual(['providers', 'defaultProviderId', 'uiFontSystemDefaultApplied', 'compute'])
  })

  it('classifies every default settings key', () => {
    const unclassified = Object.keys(createSettingsDefaults()).filter((key) => settingsKeyClass(key) === null)
    expect(unclassified).toEqual([])
  })

  it('keeps the client class to the keys of design §4.1', () => {
    expect([...CLIENT_SETTINGS_KEYS].sort()).toEqual([
      'agentAvatars', 'agentWindows', 'fleetGroups', 'fleetMapState', 'fleetStewards', 'menuBarEnabled',
      'nativeNotificationsEnabled', 'onboardingSharedAt', 'recentFiles', 'remoteRecentFiles', 'spellcheckDownloadsEnabled',
      'templatesMigrationSeen', 'theme', 'uiFont', 'uiFontCustom', 'uiFontSystemDefaultApplied', 'uiScale',
      'updateChecksEnabled',
    ])
    for (const key of ['trackedDirectories', 'agentsFolder', 'compute', 'remoteCatalogsEnabled', 'providerChecksEnabled', 'skillCatalogSources']) {
      expect(settingsKeyClass(key)).toBe('backend')
    }
  })

  it('has Studio-host code read only client keys', () => {
    // These run in Studio main in every mode; a backend key read here would go
    // stale in daemon mode, where the daemon owns that key.
    const hostModules = ['src/main/index.ts', 'src/main/menu.ts', 'src/main/services/app-updater.service.ts', 'src/main/services/spellcheck-dictionaries.service.ts']
    const backendReads: string[] = []
    for (const rel of hostModules) {
      for (const key of settingsReads(readFileSync(join(ROOT, rel), 'utf8'))) {
        if (settingsKeyClass(key) !== 'client') backendReads.push(`${rel}: ${key}`)
      }
    }
    // The Studio-host parts of ipc/index.ts: OS notifications, the menu bar and
    // notification reveal.
    const ipc = readFileSync(join(ROOT, 'src', 'main', 'ipc', 'index.ts'), 'utf8')
    const hostParts = ['createNativeNotifierPlatform', 'getMenuBarSnapshot', 'handleMenuBarAction', 'sendReveal', 'focusMainWindow']
      .map((name) => functionBody(ipc, name))
    hostParts.push(...ipc.split('\n').filter((line) => /menuBar|nativeNotifier/.test(line)))
    for (const part of hostParts) {
      for (const key of settingsReads(part)) if (settingsKeyClass(key) !== 'client') backendReads.push(`src/main/ipc/index.ts: ${key}`)
    }
    expect(backendReads).toEqual([])
    expect(settingsReads(hostParts.join('\n'))).toEqual(expect.arrayContaining(['nativeNotificationsEnabled', 'menuBarEnabled']))
  })
})
