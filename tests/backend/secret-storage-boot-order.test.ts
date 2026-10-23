/**
 * The secret-storage question (secret-storage-launch.ts) is asked on Studio's
 * real entry path before anything that can move or change Studio's secrets
 * or settings: the boot guard, the boot handover (moves Studio's phrase,
 * runtime keys and MCP sign-ins between its settings file and the daemon's
 * store), the first-launch and remote-mode migrations, and the settings
 * store, identity and daemon of either backend. A launch the boot guard
 * makes Inside Studio is asked again directly after the guard, before the
 * handover and migrations. Source order of src/main/index.ts, the code that
 * runs.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(__dirname, '../../src/main/index.ts'), 'utf-8')
const ready = source.slice(source.indexOf('app.whenReady().then(async () => {'))
const at = (call: string): number => {
  const i = ready.indexOf(call)
  expect(i, call).toBeGreaterThan(0)
  return i
}

describe('boot order: the secret-storage question comes first', () => {
  const firstAsk = at('await askSecretStorage(backend.mode === \'embedded\')')

  it('only the backend resolution precedes it', () => {
    expect(firstAsk).toBeGreaterThan(at('const backend = resolveBootBackend('))
    const before = ready.slice(0, firstAsk)
    for (const call of ['guardBoot(', 'runBootHandover(', 'settleDefaultBackend(', 'migratePairedSlot(', 'migrateRemoteModeInstall(', 'registerAllIpcHandlers(', 'registerDaemonModeHandlers(', 'new SettingsService(']) {
      expect(before.includes(call), call).toBe(false)
    }
  })

  for (const call of ['guardBoot(', 'runBootHandover(', 'settleDefaultBackend(', 'migratePairedSlot(', 'migrateRemoteModeInstall(', 'registerAllIpcHandlers(', 'registerDaemonModeHandlers(']) {
    it(`precedes ${call.slice(0, -1)}`, () => {
      expect(firstAsk).toBeLessThan(at(call))
    })
  }

  it('a launch that became Inside Studio at the guard is asked again right after it, before anything moves secrets or settings', () => {
    const guard = at('const bootGuard = await guardBoot(')
    const embeddedAsk = at("backend.mode === 'embedded' && await askSecretStorage(true)")
    expect(embeddedAsk).toBeGreaterThan(guard)
    // Nothing runs between the guard and the second question.
    expect(ready.slice(ready.indexOf('\n', guard) + 1, embeddedAsk).replace(/^\s*\/\/.*$/gm, '').trim()).toBe('if (')
    for (const call of ['runBootHandover(', 'settleDefaultBackend(', 'migratePairedSlot(', 'migrateRemoteModeInstall(', 'registerAllIpcHandlers(', 'registerDaemonModeHandlers(']) {
      expect(embeddedAsk, call).toBeLessThan(at(call))
    }
  })

  it('Quit at either question stops the launch', () => {
    expect(ready.match(/askSecretStorage\((?:backend\.mode === 'embedded'|true)\) === 'quit'\) \{\n\s+app\.quit\(\)\n\s+return\n/g) ?? []).toHaveLength(2)
  })

  it('asks about the settings file Studio and its Local daemon actually use (ADF_USER_DATA_DIR honoured)', () => {
    expect(source).toMatch(/settingsPath: join\(getUserDataPath\(\), 'adf-settings\.json'\)/)
    const userDataPath = readFileSync(join(__dirname, '../../src/main/utils/user-data-path.ts'), 'utf-8')
    expect(userDataPath).toMatch(/if \(process\.env\.ADF_USER_DATA_DIR\) return process\.env\.ADF_USER_DATA_DIR/)
  })
})
