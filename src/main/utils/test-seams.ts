/**
 * Gate for env-controlled test seams (ADF_TEST_SEAMS=1). A seam is honoured
 * only when the variable is set AND this is not a packaged build, judged two
 * ways: the code does not run from inside `app.asar` or an installed npm
 * package (`node_modules`), and the process is not a packaged Electron app.
 *
 * Shared by the daemon keychain seam (daemon-identity.ts) and, at merge, the
 * compute seam (W1-G `isPackagedRuntime` in compute-service-factory.ts): the
 * lead unifies the runtime check with that one.
 */

import { fileURLToPath } from 'url'

export const TEST_SEAMS_ENV = 'ADF_TEST_SEAMS'

/** True for a module path inside app.asar or a node_modules tree. */
export function isPackagedModulePath(modulePath: string): boolean {
  return modulePath.includes('app.asar') || modulePath.split(/[\\/]/).includes('node_modules')
}

/**
 * A packaged Electron process (Studio, or its Electron-as-Node daemon child):
 * an Electron binary that is not the development `electron` package. Plain
 * Node is never packaged by this test (the module path test covers npm).
 */
export function isPackagedRuntime(proc: { versions: NodeJS.ProcessVersions; execPath: string } = process): boolean {
  if (!proc.versions.electron) return false
  return !/[\\/]node_modules[\\/]electron[\\/]/.test(proc.execPath)
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
