import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Mock electron's app.getPath before importing the module
const MOCK_USER_DATA = join(tmpdir(), `adf-sandbox-pkg-test-${process.pid}`)
const ORIGINAL_ADF_USER_DATA_DIR = process.env.ADF_USER_DATA_DIR
process.env.ADF_USER_DATA_DIR = MOCK_USER_DATA

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return MOCK_USER_DATA
      throw new Error(`Unexpected getPath call: ${name}`)
    }
  }
}))

import { SandboxPackagesService, NativeAddonError, SizeLimitError } from '../../../src/main/services/sandbox-packages.service'

describe('SandboxPackagesService', () => {
  let service: SandboxPackagesService
  const baseDir = join(MOCK_USER_DATA, 'sandbox-packages')
  const manifestPath = join(baseDir, 'sandbox-packages-manifest.json')

  beforeEach(() => {
    mkdirSync(MOCK_USER_DATA, { recursive: true })
    service = new SandboxPackagesService()
  })

  afterEach(() => {
    try { rmSync(MOCK_USER_DATA, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  afterAll(() => {
    if (ORIGINAL_ADF_USER_DATA_DIR === undefined) delete process.env.ADF_USER_DATA_DIR
    else process.env.ADF_USER_DATA_DIR = ORIGINAL_ADF_USER_DATA_DIR
  })

  describe('manifest operations', () => {
    it('should return empty arrays when no packages installed', () => {
      expect(service.getInstalledModules()).toEqual([])
      expect(service.getInstalledPackages()).toEqual([])
    })

    it('should return empty missing list when no packages requested', () => {
      expect(service.checkMissing([])).toEqual([])
    })

    it('should report all packages as missing when nothing installed', () => {
      const packages = [
        { name: 'lodash', version: '4.17.21' },
        { name: 'vega', version: '5.30.0' }
      ]
      const missing = service.checkMissing(packages)
      expect(missing).toEqual(packages)
    })

    it('should survive corrupted manifest', () => {
      mkdirSync(baseDir, { recursive: true })
      writeFileSync(manifestPath, 'not-json!!!', 'utf-8')
      expect(service.getInstalledModules()).toEqual([])
    })

    it('should report isInstalled false for unknown packages', () => {
      expect(service.isInstalled('nonexistent')).toBe(false)
    })

    it('should return false when uninstalling unknown package', () => {
      expect(service.uninstall('nonexistent')).toBe(false)
    })
  })

  describe('manifest with pre-populated data', () => {
    beforeEach(() => {
      mkdirSync(baseDir, { recursive: true })
      const manifest = {
        packages: {
          'lodash': { name: 'lodash', version: '4.17.21', installedAt: Date.now(), size_mb: 1.5 },
          'vega': { name: 'vega', version: '5.30.0', installedAt: Date.now(), size_mb: 3.4, installedBy: 'TestAgent' }
        }
      }
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')
    })

    it('should list installed modules from manifest', () => {
      const modules = service.getInstalledModules()
      expect(modules).toContain('lodash')
      expect(modules).toContain('vega')
      expect(modules).toHaveLength(2)
    })

    it('should return full package entries', () => {
      const packages = service.getInstalledPackages()
      expect(packages).toHaveLength(2)
      const vega = packages.find(p => p.name === 'vega')
      expect(vega).toBeDefined()
      expect(vega!.version).toBe('5.30.0')
      expect(vega!.size_mb).toBe(3.4)
      expect(vega!.installedBy).toBe('TestAgent')
    })

    it('should report isInstalled correctly', () => {
      expect(service.isInstalled('lodash')).toBe(true)
      expect(service.isInstalled('lodash', '4.17.21')).toBe(true)
      expect(service.isInstalled('lodash', '3.0.0')).toBe(false)
      expect(service.isInstalled('nonexistent')).toBe(false)
    })

    it('should identify missing packages', () => {
      const missing = service.checkMissing([
        { name: 'lodash', version: '4.17.21' },
        { name: 'vega', version: '5.30.0' },
        { name: 'chart.js', version: '4.0.0' }
      ])
      expect(missing).toEqual([{ name: 'chart.js', version: '4.0.0' }])
    })

    it('should report packages with a mismatched version as missing', () => {
      const missing = service.checkMissing([
        { name: 'lodash', version: '3.0.0' }
      ])
      expect(missing).toEqual([{ name: 'lodash', version: '3.0.0' }])
    })

    it('should remove package from manifest on uninstall', () => {
      expect(service.uninstall('lodash')).toBe(true)
      expect(service.isInstalled('lodash')).toBe(false)
      expect(service.isInstalled('vega')).toBe(true)

      // Verify persisted
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
      expect(manifest.packages['lodash']).toBeUndefined()
      expect(manifest.packages['vega']).toBeDefined()
    })

    it('should return correct basePath', () => {
      expect(service.getBasePath()).toBe(baseDir)
    })
  })

  describe('manifest reconciliation', () => {
    it('should recover an installed package that is missing from the manifest', () => {
      const lodashDir = join(baseDir, 'node_modules', 'lodash')
      mkdirSync(lodashDir, { recursive: true })
      writeFileSync(join(lodashDir, 'package.json'), JSON.stringify({
        name: 'lodash',
        version: '4.17.21'
      }))
      writeFileSync(join(lodashDir, 'index.js'), 'module.exports = {}')

      const missing = service.checkMissing([{ name: 'lodash', version: '4.17.21' }])

      expect(missing).toEqual([])
      expect(service.isInstalled('lodash', '4.17.21')).toBe(true)

      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
      expect(manifest.packages.lodash.version).toBe('4.17.21')
    })

    it('should still report a disk-installed package as missing when the version differs', () => {
      const lodashDir = join(baseDir, 'node_modules', 'lodash')
      mkdirSync(lodashDir, { recursive: true })
      writeFileSync(join(lodashDir, 'package.json'), JSON.stringify({
        name: 'lodash',
        version: '4.17.21'
      }))

      const missing = service.checkMissing([{ name: 'lodash', version: '3.0.0' }])

      expect(missing).toEqual([{ name: 'lodash', version: '3.0.0' }])
    })
  })

  describe('native addon detection', () => {
    // We test the detection logic by simulating a post-install node_modules structure.
    // The actual npm install is too slow for unit tests, but we can test the scan logic
    // by creating fake package directories with native addon indicators.

    it('should detect binding.gyp in package', async () => {
      // Create a fake installed package with binding.gyp
      const fakeModDir = join(baseDir, 'node_modules', 'fake-native')
      mkdirSync(fakeModDir, { recursive: true })
      writeFileSync(join(fakeModDir, 'package.json'), JSON.stringify({ name: 'fake-native', version: '1.0.0' }))
      writeFileSync(join(fakeModDir, 'binding.gyp'), '{}')
      writeFileSync(join(baseDir, 'package.json'), JSON.stringify({ name: 'sandbox-packages', private: true }))

      // Access private method via any cast for testing
      const result = (service as any).checkNativeAddons(join(baseDir, 'node_modules'), 'fake-native')
      expect(result).toMatch(/binding\.gyp/)
    })

    it('should detect node-gyp in install scripts', async () => {
      const fakeModDir = join(baseDir, 'node_modules', 'fake-gyp')
      mkdirSync(fakeModDir, { recursive: true })
      writeFileSync(join(fakeModDir, 'package.json'), JSON.stringify({
        name: 'fake-gyp',
        version: '1.0.0',
        scripts: { install: 'node-gyp rebuild' }
      }))
      writeFileSync(join(baseDir, 'package.json'), JSON.stringify({ name: 'sandbox-packages', private: true }))

      const result = (service as any).checkNativeAddons(join(baseDir, 'node_modules'), 'fake-gyp')
      expect(result).toMatch(/node-gyp/)
    })

    it('should detect prebuild-install in scripts', async () => {
      const fakeModDir = join(baseDir, 'node_modules', 'fake-prebuild')
      mkdirSync(fakeModDir, { recursive: true })
      writeFileSync(join(fakeModDir, 'package.json'), JSON.stringify({
        name: 'fake-prebuild',
        version: '1.0.0',
        scripts: { install: 'prebuild-install || node-gyp rebuild' }
      }))

      const result = (service as any).checkNativeAddons(join(baseDir, 'node_modules'), 'fake-prebuild')
      expect(result).toMatch(/prebuild-install/)
    })

    it('should detect gypfile flag', async () => {
      const fakeModDir = join(baseDir, 'node_modules', 'fake-gypfile')
      mkdirSync(fakeModDir, { recursive: true })
      writeFileSync(join(fakeModDir, 'package.json'), JSON.stringify({
        name: 'fake-gypfile',
        version: '1.0.0',
        gypfile: true
      }))

      const result = (service as any).checkNativeAddons(join(baseDir, 'node_modules'), 'fake-gypfile')
      expect(result).toMatch(/gypfile/)
    })

    it('should detect native addons in dependencies', async () => {
      // Parent package is clean
      const parentDir = join(baseDir, 'node_modules', 'clean-parent')
      mkdirSync(parentDir, { recursive: true })
      writeFileSync(join(parentDir, 'package.json'), JSON.stringify({
        name: 'clean-parent',
        version: '1.0.0',
        dependencies: { 'native-dep': '1.0.0' }
      }))

      // Dependency has binding.gyp
      const depDir = join(baseDir, 'node_modules', 'native-dep')
      mkdirSync(depDir, { recursive: true })
      writeFileSync(join(depDir, 'package.json'), JSON.stringify({ name: 'native-dep', version: '1.0.0' }))
      writeFileSync(join(depDir, 'binding.gyp'), '{}')

      const result = (service as any).checkNativeAddons(join(baseDir, 'node_modules'), 'clean-parent')
      expect(result).toMatch(/native-dep/)
      expect(result).toMatch(/binding\.gyp/)
    })

    it('should return null for clean packages', async () => {
      const fakeModDir = join(baseDir, 'node_modules', 'clean-pkg')
      mkdirSync(fakeModDir, { recursive: true })
      writeFileSync(join(fakeModDir, 'package.json'), JSON.stringify({
        name: 'clean-pkg',
        version: '1.0.0',
        scripts: { test: 'vitest run' }
      }))

      const result = (service as any).checkNativeAddons(join(baseDir, 'node_modules'), 'clean-pkg')
      expect(result).toBeNull()
    })
  })

  describe('size calculation', () => {
    it('should calculate package size', () => {
      const fakeDir = join(baseDir, 'node_modules', 'sized-pkg')
      mkdirSync(fakeDir, { recursive: true })
      // Write a 1KB file
      writeFileSync(join(fakeDir, 'index.js'), 'x'.repeat(1024))
      writeFileSync(join(fakeDir, 'package.json'), JSON.stringify({ name: 'sized-pkg' }))

      const sizeMb = (service as any).getPackageSizeMb(fakeDir)
      expect(sizeMb).toBeGreaterThan(0)
      expect(sizeMb).toBeLessThan(0.01) // ~1KB = ~0.001 MB
    })
  })
})
