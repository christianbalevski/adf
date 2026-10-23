import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp' },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' },
}))

import { MOCK_SAFE_STORAGE_ENV, mockSafeStorageControlFile } from '../../../src/main/utils/studio-safe-storage'

/**
 * The fixed-key mock safeStorage is a test seam: it must never be active in a
 * packaged app, a packaged module or runtime, or without ADF_TEST_SEAMS=1.
 */
const dev = { modulePath: '/work/adf/src/main/utils/studio-safe-storage.ts', isPackagedRuntime: () => false }
const env = (extra: Record<string, string> = {}) => ({ [MOCK_SAFE_STORAGE_ENV]: '/tmp/control', ...extra }) as NodeJS.ProcessEnv

describe('mock safeStorage gate', () => {
  it('is on only with ADF_TEST_SEAMS=1 in an unpackaged dev build', () => {
    expect(mockSafeStorageControlFile({ env: env({ ADF_TEST_SEAMS: '1' }), appPackaged: false, seams: dev })).toBe('/tmp/control')
  })

  it('is off without ADF_TEST_SEAMS=1, even unpackaged', () => {
    expect(mockSafeStorageControlFile({ env: env(), appPackaged: false, seams: dev })).toBeNull()
    expect(mockSafeStorageControlFile({ env: env({ ADF_TEST_SEAMS: 'true' }), appPackaged: false, seams: dev })).toBeNull()
  })

  it('is off in a packaged app, module or runtime, whatever the environment says', () => {
    const on = env({ ADF_TEST_SEAMS: '1' })
    expect(mockSafeStorageControlFile({ env: on, appPackaged: true, seams: dev })).toBeNull()
    expect(mockSafeStorageControlFile({ env: on, appPackaged: false, seams: { ...dev, modulePath: '/Applications/ADF Studio.app/Contents/Resources/app.asar/out/main/index.js' } })).toBeNull()
    expect(mockSafeStorageControlFile({ env: on, appPackaged: false, seams: { ...dev, modulePath: '/usr/lib/node_modules/adf-studio/out/main/index.js' } })).toBeNull()
    expect(mockSafeStorageControlFile({ env: on, appPackaged: false, seams: { ...dev, isPackagedRuntime: () => true } })).toBeNull()
    expect(mockSafeStorageControlFile({ env: on, appPackaged: false, seams: { ...dev, modulePath: null } })).toBeNull()
  })

  it('is off when the variable is not set', () => {
    expect(mockSafeStorageControlFile({ env: { ADF_TEST_SEAMS: '1' } as NodeJS.ProcessEnv, appPackaged: false, seams: dev })).toBeNull()
  })
})
