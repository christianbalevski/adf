/**
 * Gate for env-controlled test seams (ADF_TEST_SEAMS=1). A seam is honoured
 * only when the variable is set AND this is not a packaged build, judged two
 * ways: the code does not run from inside `app.asar` or an installed npm
 * package (`node_modules`), and the process is not a packaged Electron app.
 *
 * Shared by the daemon keychain seam (daemon-identity.ts) and the compute
 * seam (compute-service-factory.ts).
 */

import { basename } from 'path'
import { fileURLToPath } from 'url'

export const TEST_SEAMS_ENV = 'ADF_TEST_SEAMS'

/**
 * True for a module path inside app.asar, a node_modules tree, or Deno's npm
 * cache (`<DENO_DIR>/npm/<registry host>/…`, e.g. `~/.cache/deno/npm/registry.npmjs.org`).
 */
export function isPackagedModulePath(modulePath: string): boolean {
  if (modulePath.includes('app.asar')) return true
  const segments = modulePath.split(/[\\/]/).map((s) => s.toLowerCase())
  if (segments.includes('node_modules') || segments.includes('registry.npmjs.org')) return true
  return segments.some((s, i) => s === 'deno' && segments[i + 1] === 'npm')
}

/**
 * A packaged Electron process (Studio, or its Electron-as-Node daemon child):
 * an Electron binary that is not the development `electron` package. Plain
 * Node is never packaged by this test (the module path test covers npm).
 */
export function isPackagedRuntime(
  proc: { versions: NodeJS.ProcessVersions; execPath: string; argv: string[] } = process,
): boolean {
  if (proc.versions.electron && !/[\\/]node_modules[\\/]electron[\\/]/.test(proc.execPath)) return true
  return isPackagedExecutable(proc.execPath, proc.argv[1] ?? '')
}

/**
 * An executable that is not a bare `node`/`electron` binary (a packaged
 * Studio runs the daemon as `ADF Studio.exe` with ELECTRON_RUN_AS_NODE=1),
 * or an entry script inside `app.asar`.
 */
export function isPackagedExecutable(execPath: string, entry: string): boolean {
  const exe = basename(execPath).toLowerCase().replace(/\.exe$/, '')
  if (exe !== 'node' && exe !== 'electron') return true
  return /[\\/]app\.asar([\\/]|$)/i.test(entry)
}

function currentModulePath(): string | null {
  try {
    return fileURLToPath(import.meta.url)
  } catch {
    return null
  }
}

export interface TestSeamGateInput {
  env?: NodeJS.ProcessEnv
  /** Path of the running module; null (unknown) fails closed. */
  modulePath?: string | null
  isPackagedRuntime?: () => boolean
}

export function testSeamsAllowed(input: TestSeamGateInput = {}): boolean {
  const env = input.env ?? process.env
  if (env[TEST_SEAMS_ENV] !== '1') return false
  const modulePath = input.modulePath === undefined ? currentModulePath() : input.modulePath
  if (!modulePath || isPackagedModulePath(modulePath)) return false
  return !(input.isPackagedRuntime ?? isPackagedRuntime)()
}
