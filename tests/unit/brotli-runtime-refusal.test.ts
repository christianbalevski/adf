// CVE-2026-111497: the entrypoints refuse a vulnerable runtime before any
// work. Needs real vulnerable binaries, which CI does not install, so it runs
// only when they are given:
//   ADF_TEST_VULNERABLE_NODE=/path/to/node-v22.23.3/bin/node
//   ADF_TEST_VULNERABLE_ELECTRON=/path/to/electron-v41.10.7/electron
// Each child gets a throwaway HOME and data dir, which must stay untouched.
// The fixed side (this runtime) is covered by brotli-runtime-guard.test.ts.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..')
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const VULNERABLE_NODE = process.env.ADF_TEST_VULNERABLE_NODE
const VULNERABLE_ELECTRON = process.env.ADF_TEST_VULNERABLE_ELECTRON

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function refuse(command: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): void {
  const dir = mkdtempSync(join(tmpdir(), 'adf-brotli-refusal-'))
  dirs.push(dir)
  const data = join(dir, 'data')
  const child = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 60_000,
    windowsHide: true,
    env: { PATH: process.env.PATH, HOME: dir, ADF_USER_DATA_DIR: data, ADF_KEYCHAIN: '0', ...extraEnv },
  })
  expect(child.status, child.stderr).toBe(1)
  expect(child.stderr).toMatch(/^ADF refuses to run on .*CVE-2026-111497/)
  expect(child.stdout).toBe('')
  expect(existsSync(data)).toBe(false)
}

describe.skipIf(!VULNERABLE_NODE)('on a vulnerable Node.js', () => {
  it('the CLI from source refuses', () => {
    refuse(VULNERABLE_NODE!, [TSX, '--tsconfig', 'tsconfig.node.json', 'src/main/cli/bin.ts', '--version'])
  })
  it('the daemon from source refuses before it boots', () => {
    refuse(VULNERABLE_NODE!, [TSX, 'src/main/daemon/index.ts'])
  })
  it.skipIf(!existsSync(join(ROOT, 'dist', 'npm', 'dist', 'adf.mjs')))('the published npm entry (npm run build:npm) refuses, daemon included', () => {
    refuse(VULNERABLE_NODE!, ['dist/npm/dist/adf.mjs', '--version'])
    refuse(VULNERABLE_NODE!, ['dist/npm/dist/adf.mjs', 'daemon', '--port', '47393'])
  })
})

describe.skipIf(!VULNERABLE_ELECTRON || !existsSync(join(ROOT, 'out', 'main', 'daemon.js')))('on a vulnerable Electron', () => {
  it('Studio\'s daemon build (Electron-as-Node) refuses', () => {
    refuse(VULNERABLE_ELECTRON!, ['out/main/daemon.js'], { ELECTRON_RUN_AS_NODE: '1' })
  })
})
