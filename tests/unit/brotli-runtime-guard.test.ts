// CVE-2026-111497: the runtime floor (brotli-runtime-guard.ts), the engines
// ranges that state it, the entrypoints that enforce it first, and the fixed
// decoder's behaviour on the upstream regression input.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from 'node:zlib'
import semver from 'semver'
import { describe, expect, it } from 'vitest'
import { brotliRuntimeVerdict, evaluateBrotliRuntime, SAFE_NODE_RANGE } from '../../src/main/utils/brotli-runtime-guard'

const ROOT = join(__dirname, '..', '..')
const FIXED = -17 // BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH

/** `null`: the constant is absent from zlib.constants. */
const node = (version: string, blockSwitchErrno: number | null = FIXED) =>
  evaluateBrotliRuntime({ versions: { node: version }, blockSwitchErrno: blockSwitchErrno ?? undefined })
const electron = (version: string, chrome: string, nodeVersion = '24.22.0') =>
  evaluateBrotliRuntime({ versions: { node: nodeVersion, electron: version, chrome }, blockSwitchErrno: undefined })

describe('Node.js floor', () => {
  it.each([
    // The release line boundaries.
    ['22.23.3', false], ['22.23.4', true], ['22.24.0', true],
    ['24.22.0', false], ['24.22.1', true], ['24.23.0', true],
    ['26.12.0', false], ['26.12.1', true], ['26.13.0', true],
    // Old minors of fixed lines; the previous engines floor (>=22.13) admitted these.
    ['22.13.0', false], ['24.0.0', false], ['26.0.0', false],
    // End-of-life and odd lines never got the fix.
    ['18.20.8', false], ['20.20.2', false], ['21.7.3', false], ['23.11.1', false], ['25.9.0', false],
    // Later majors have the fix but are refused until ADF is tested on them.
    ['27.0.0', false], ['28.1.0', false],
    // Prereleases and nightlies are refused (the engines range excludes them too).
    ['24.22.1-pre', false], ['26.12.1-rc.1', false], ['24.22.2-pre', false], ['27.0.0-nightly20261020abcdef', false],
    // Unreadable.
    ['', false], ['24', false], ['banana', false],
  ])('%s → safe=%s', (version, safe) => {
    expect(node(version).safe).toBe(safe)
  })

  it('also requires the fixed decoder\'s error code, not only the version', () => {
    expect(node('24.22.1', null)).toMatchObject({ safe: false, reason: expect.stringMatching(/BLOCK_SWITCH/) })
    expect(node('26.12.1', -9)).toMatchObject({ safe: false })
  })

  it('agrees with the engines range on every boundary', () => {
    for (const v of ['24.22.2-pre', '27.0.0-nightly20261020abcdef', '20.20.2', '22.13.0', '22.23.3', '22.23.4', '23.11.1', '24.0.0', '24.22.0', '24.22.1', '25.9.0', '26.12.0', '26.12.1', '27.0.0']) {
      expect(semver.satisfies(v, SAFE_NODE_RANGE), v).toBe(node(v).safe)
    }
  })

  it('refuses with an actionable message', () => {
    const verdict = node('24.18.0')
    expect(verdict.safe).toBe(false)
    if (verdict.safe) return
    expect(verdict.runtime).toBe('Node.js 24.18.0')
    expect(verdict.reason).toMatch(/CVE-2026-111497.*24\.22\.1/)
    expect(verdict.remedy).toMatch(/22\.23\.4\+, 24\.22\.1\+ or 26\.12\.1\+/)
  })

  it('refuses a major newer than the last tested one as untested, not vulnerable', () => {
    expect(node('27.0.0')).toMatchObject({ safe: false, reason: 'ADF is not tested on Node.js 27.x yet' })
  })

  it('refuses Bun and Deno (unverified decoders) whatever node version they report', () => {
    expect(evaluateBrotliRuntime({ versions: { node: '24.22.1', bun: '1.3.0' }, blockSwitchErrno: FIXED }).safe).toBe(false)
    expect(evaluateBrotliRuntime({ versions: { node: '24.22.1', deno: '2.5.0' }, blockSwitchErrno: FIXED }).safe).toBe(false)
  })
})

describe('Electron floor (judged by its Chromium decoder, not its Node)', () => {
  it.each([
    ['41.10.7', '146.0.7680.216', false], // the previous lock: Chromium M146 decoder
    ['42.0.0-alpha.1', '147.0.7700.0', false],
    // Early M148 builds still had the old decoder; these prereleases pass a
    // plain "Electron >= 42, Chromium >= 148" test.
    ['43.0.0-nightly.20260326', '148.0.7741.0', false],
    ['42.0.0-alpha.5', '148.0.7741.0', false],
    ['43.0.0-alpha.1', '149.0.7827.0', false], // any prerelease is refused
    ['42.0.0', '148.0.7741.0', false], // inconsistent pair below the build floor
    ['42.0.0', '148.0.7751.0', true], // first fixed Chromium build
    ['42.0.0', '148.0.7778.96', true], // first release on M148
    ['43.8.3', '150.0.7871.250', true], // the lock
    ['44.9.3', '152.0.7977.167', true],
    ['45.0.0', '156.0.8078.48', true],
    ['43.8.3', '146.0.7680.216', false], // inconsistent pair: both must pass
    ['garbage', '150.0.7871.250', false],
    ['43.8.3', '', false],
  ])('Electron %s / Chromium %s → safe=%s', (version, chrome, safe) => {
    expect(electron(version, chrome).safe).toBe(safe)
  })

  it('accepts Electron 43 although its Node (24.22.0) is below the Node.js floor and lacks the constant', () => {
    expect(node('24.22.0', null).safe).toBe(false)
    expect(electron('43.8.3', '150.0.7871.250', '24.22.0').safe).toBe(true)
  })

  it('refuses Electron 41 although its process.versions look like Node 24', () => {
    expect(electron('41.10.7', '146.0.7680.216', '24.18.0')).toMatchObject({
      safe: false,
      // The floor the code enforces, not the Electron the lock happens to pin.
      reason: expect.stringContaining('needs a stable Electron 42.0.0+ on Chromium 148.0.7751.0+'),
      remedy: expect.stringMatching(/^Update ADF Studio to the latest release; from source, run `npm ci`/),
    })
  })
})

describe('the runtime running this suite', () => {
  it('passes (a vulnerable runtime cannot run ADF tests that decode Brotli)', () => {
    expect(brotliRuntimeVerdict()).toMatchObject({ safe: true })
  })

  it('reports the upstream malformed block switch as a permanent format error (isolated subprocess)', () => {
    // Node's own regression input for CVE-2026-111497 (nodejs/node b5f41529,
    // test-zlib-invalid-input.js): one literal block type, then a block
    // switch. A fixed decoder fails with FORMAT_BLOCK_SWITCH (-17); the old
    // one answered "needs more input". Run in a child with a timeout so a
    // regression can never corrupt this process.
    const script = `
      const zlib = require('zlib')
      const input = Buffer.from('200010414141fcffff07002228f00b60f7f41f000000', 'hex')
      let sync = null
      try { zlib.brotliDecompressSync(input) } catch (e) { sync = e.errno }
      const d = zlib.createBrotliDecompress()
      d.resume()
      d.on('end', () => { console.log(JSON.stringify({ sync, stream: 'end' })) })
      d.on('error', (e) => { console.log(JSON.stringify({ sync, stream: e.errno })) })
      for (let i = 0; i < input.length; i++) d.write(input.subarray(i, i + 1))
      d.end()
    `
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH }
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
    const child = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf-8', timeout: 15_000, windowsHide: true })
    expect(child.status, child.stderr).toBe(0)
    expect(JSON.parse(child.stdout.trim())).toEqual({ sync: FIXED, stream: FIXED })
  })

  it('still decodes valid Brotli', () => {
    const json = JSON.stringify({ hello: 'world', n: [1, 2, 3] })
    const q5 = brotliCompressSync(Buffer.from(json), { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } })
    expect(brotliDecompressSync(q5).toString()).toBe(json)
  })
})

describe('where the floor is stated and enforced', () => {
  it('the engines ranges are the guard\'s range', () => {
    for (const file of ['package.json', 'packages/cli/package.json']) {
      const pkg = JSON.parse(readFileSync(join(ROOT, file), 'utf-8')) as { engines: { node: string } }
      expect(pkg.engines.node, file).toBe(SAFE_NODE_RANGE)
    }
  })

  it('Studio pins an Electron the guard accepts', () => {
    const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf-8')) as { packages: Record<string, { version: string }> }
    const version = lock.packages['node_modules/electron'].version
    expect(semver.gte(version, '43.0.0')).toBe(true)
  })

  const CHECK = /^import '\.\.?\/(utils|\.\.\/utils)\/brotli-runtime-check'$/
  const staticImports = (file: string) => [...readFileSync(join(ROOT, file), 'utf-8').matchAll(/^import\s.*$/gm)].map((m) => m[0])

  // A bundle requires every external module at the top of its file, before
  // the check: an entry's only static import is the check, and the rest
  // loads with a dynamic import after it.
  it.each([
    'src/main/entry.ts',
    'src/main/daemon/entry.ts',
    'src/main/cli/bin.ts',
  ])('the bundle entry %s statically imports only the check', (file) => {
    expect(staticImports(file)).toEqual([expect.stringMatching(CHECK)])
  })

  it('Studio main and the daemon are built from those entries', () => {
    const config = readFileSync(join(ROOT, 'electron.vite.config.ts'), 'utf-8')
    expect(config).toContain("resolve(__dirname, 'src/main/entry.ts')")
    expect(config).toContain("resolve(__dirname, 'src/main/daemon/entry.ts')")
  })

  it.each([
    'src/main/index.ts',
    'src/main/daemon/index.ts',
  ])('%s still imports the check first when run from source', (file) => {
    expect(staticImports(file)[0]).toMatch(CHECK)
  })
})
