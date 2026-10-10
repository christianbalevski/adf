import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const MOCK_USER_DATA = join(tmpdir(), `adf-sandbox-pkg-scripts-${process.pid}`)
const ORIGINAL_ADF_USER_DATA_DIR = process.env.ADF_USER_DATA_DIR
process.env.ADF_USER_DATA_DIR = MOCK_USER_DATA

vi.mock('electron', () => ({ app: { getPath: () => MOCK_USER_DATA } }))

/** Fake npm: records argv and lays out node_modules the way `install` would. */
type FakeTree = Record<string, {
  version?: string
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  files?: Record<string, string>
}>
const npmCalls: string[][] = []
let nextTree: FakeTree = {}
vi.mock('child_process', async (orig) => {
  const actual = await orig<typeof import('child_process')>()
  return {
    ...actual,
    execFile: (_file: string, args: string[], opts: { cwd: string }, cb: (err: Error | null, out?: { stdout: string; stderr: string }) => void) => {
      npmCalls.push(args)
      if (args[0] === 'install') {
        for (const [name, pkg] of Object.entries(nextTree)) {
          const dir = join(opts.cwd, 'node_modules', name)
          mkdirSync(dir, { recursive: true })
          const { files, ...manifest } = pkg
          writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: pkg.version ?? '1.0.0', ...manifest }))
          writeFileSync(join(dir, 'index.js'), 'module.exports = 1')
          for (const [file, body] of Object.entries(files ?? {})) writeFileSync(join(dir, file), body)
        }
      }
      if (args[0] === 'uninstall') {
        const name = args[args.length - 1].replace(/^"|"$/g, '')
        rmSync(join(opts.cwd, 'node_modules', name), { recursive: true, force: true })
      }
      cb(null, { stdout: '', stderr: '' })
    }
  }
})

import {
  SandboxPackagesService,
  InstallScriptError,
  InvalidPackageSpecError,
  NativeAddonError
} from '../../../src/main/services/sandbox-packages.service'

describe('sandbox npm install: scripts and spec validation', () => {
  let service: SandboxPackagesService

  beforeEach(() => {
    mkdirSync(MOCK_USER_DATA, { recursive: true })
    service = new SandboxPackagesService()
    npmCalls.length = 0
    nextTree = {}
  })

  afterEach(() => {
    try { rmSync(MOCK_USER_DATA, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  afterAll(() => {
    if (ORIGINAL_ADF_USER_DATA_DIR === undefined) delete process.env.ADF_USER_DATA_DIR
    else process.env.ADF_USER_DATA_DIR = ORIGINAL_ADF_USER_DATA_DIR
  })

  it('runs npm install with --ignore-scripts', async () => {
    nextTree = { 'pure-pkg': { version: '2.0.0' } }
    const result = await service.install('pure-pkg', '2.0.0')
    expect(result.version).toBe('2.0.0')
    const install = npmCalls.find((a) => a[0] === 'install')!
    expect(install).toContain('--ignore-scripts')
    expect(result.scripts_skipped).toBeUndefined()
  })

  it('rejects a package whose install script is a required build step, and rolls it back', async () => {
    nextTree = { 'needs-build': { scripts: { install: 'node ./download-binary.js' } } }
    await expect(service.install('needs-build', '1.0.0')).rejects.toBeInstanceOf(InstallScriptError)
    await expect(service.install('needs-build', '1.0.0')).rejects.toThrow(/install script/)
    expect(npmCalls.some((a) => a[0] === 'uninstall' && a.includes('--ignore-scripts'))).toBe(true)
    expect(service.isInstalled('needs-build')).toBe(false)
  })

  it('names the dependency when a transitive dependency needs a preinstall script', async () => {
    nextTree = {
      parent: { dependencies: { child: '1.0.0' } },
      child: { dependencies: { grandchild: '1.0.0' } },
      grandchild: { scripts: { preinstall: 'node setup.js' } }
    }
    await expect(service.install('parent', '1.0.0')).rejects.toThrow(/dependency "grandchild"/)
  })

  it('keeps a package whose only script is postinstall, and reports it skipped', async () => {
    nextTree = {
      banner: { dependencies: { 'core-js-like': '1.0.0' } },
      'core-js-like': { scripts: { postinstall: 'node -e "console.log(\'thanks\')"' } }
    }
    const result = await service.install('banner', '1.0.0')
    expect(result.scripts_skipped).toEqual([`core-js-like: postinstall "node -e \"console.log('thanks')\""`])
    expect(service.isInstalled('banner')).toBe(true)
  })

  it('rejects a native addon in a direct optional dependency', async () => {
    nextTree = {
      'sharp-like': { optionalDependencies: { 'sharp-like-darwin': '1.0.0' } },
      'sharp-like-darwin': { files: { 'sharp.node': 'bin' } }
    }
    await expect(service.install('sharp-like', '1.0.0')).rejects.toBeInstanceOf(NativeAddonError)
  })

  it('ignores native addons behind a dependency\'s own optional dependencies', async () => {
    nextTree = {
      'pdf-like': { optionalDependencies: { 'canvas-like': '1.0.0' } },
      'canvas-like': { optionalDependencies: { 'canvas-like-darwin': '1.0.0' } },
      'canvas-like-darwin': { files: { 'skia.node': 'bin' } }
    }
    const result = await service.install('pdf-like', '1.0.0')
    expect(result.name).toBe('pdf-like')
  })

  it('rejects shell metacharacters in the name before npm ever runs', async () => {
    for (const bad of ['lodash & calc', 'x;rm -rf /', '$(id)', '"q"', '%PATH%', 'a|b', '../evil']) {
      await expect(service.install(bad, '1.0.0')).rejects.toBeInstanceOf(InvalidPackageSpecError)
    }
    await expect(service.install('lodash', '1.0.0 & calc')).rejects.toBeInstanceOf(InvalidPackageSpecError)
    await expect(service.install('lodash', '"1"')).rejects.toBeInstanceOf(InvalidPackageSpecError)
    expect(npmCalls).toEqual([])
    expect(existsSync(join(MOCK_USER_DATA, 'sandbox-packages', 'node_modules'))).toBe(false)
  })

  it('accepts ordinary names, scopes, legacy uppercase names, versions, ranges and tags', async () => {
    for (const [n, v] of [
      ['lodash', '4.17.21'],
      ['@resvg/resvg-wasm', '^2.6.2'],
      ['vega-lite', '~5.21.0'],
      ['JSONStream', '1.x'],
      ['yaml', 'latest'],
    ]) {
      nextTree = { [n]: { version: '1.0.0' } }
      const result = await service.install(n, v)
      expect(result.name).toBe(n)
      expect(npmCalls.at(-1)).toContain(`${n}@${v}`)
    }
  })
})
