/**
 * TypeScript → JavaScript transpiler for lambda files.
 *
 * In-process type-strip only — no bundling, no module resolution, no type
 * checking. Cached by SHA-256 content hash.
 *
 * Primary: Node's built-in `module.stripTypeScriptTypes` (Node ≥ 22.6).
 *   - Sub-millisecond, native, zero dependencies.
 *   - `mode: 'transform'` so TS-specific runtime features (enums, namespaces,
 *     parameter properties) are compiled, not rejected.
 *
 * Fallback: sucrase `transform` with `transforms: ['typescript']`.
 *   - Used if the built-in is unavailable (older runtime) or throws on
 *     syntax it can't handle. Pure JS, in-process, no native binary.
 *
 * Both run on the current thread; per-call work is microseconds-to-low-ms,
 * far cheaper than the IPC hop of esbuild's subprocess transform (which is
 * also why the previous subprocess-based implementation was vulnerable to
 * "service is no longer running: write EPIPE" after sleep/resume).
 */

import { createHash } from 'crypto'
import { stripTypeScriptTypes } from 'node:module'
import { transform as sucraseTransform } from 'sucrase'

const cache = new Map<string, string>()

const hasNodeStrip = typeof stripTypeScriptTypes === 'function'

// Note: Node emits a one-shot `ExperimentalWarning: stripTypeScriptTypes ...`
// to stderr on first use. Harmless and not visible to packaged-app users.

function sha256(source: string): string {
  return createHash('sha256').update(source).digest('hex')
}

function runNodeStrip(source: string, filePath: string): string {
  // `transform` mode compiles enums/namespaces/parameter-properties instead of
  // rejecting them (which `strip` mode would do).
  return stripTypeScriptTypes(source, {
    mode: 'transform',
    sourceMap: false,
    sourceUrl: filePath,
  })
}

function runSucrase(source: string, filePath: string): string {
  const { code } = sucraseTransform(source, {
    transforms: ['typescript'],
    filePath,
    // Lambdas are loaded via __require in the worker; keep ESM→CJS off so we
    // emit modern JS unchanged and match the previous esbuild output shape.
    disableESTransforms: true,
    keepUnusedImports: false,
  })
  return code
}

/**
 * Transpile a `.ts` source string to JavaScript.
 * Throws on syntax errors with file path context.
 */
export async function transpileTs(source: string, filePath: string): Promise<string> {
  const hash = sha256(source)
  const cached = cache.get(hash)
  if (cached !== undefined) return cached

  let code: string
  try {
    if (hasNodeStrip) {
      try {
        code = runNodeStrip(source, filePath)
      } catch (err: unknown) {
        // Node's strip is strict about a few edge cases sucrase tolerates
        // (e.g. some decorator/legacy-syntax combos). Fall back transparently.
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[ts-transpiler] node strip failed for "${filePath}", falling back to sucrase: ${msg}`)
        code = runSucrase(source, filePath)
      }
    } else {
      code = runSucrase(source, filePath)
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Transpilation failed for "${filePath}": ${msg}`)
  }

  cache.set(hash, code)
  return code
}

/**
 * Load a lambda file from the workspace, transpiling .ts files automatically.
 * Returns null if the file does not exist.
 */
export async function loadLambdaSource(
  readFile: (path: string) => string | null,
  filePath: string
): Promise<string | null> {
  const content = readFile(filePath)
  if (content === null) return null
  if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) {
    return transpileTs(content, filePath)
  }
  return content
}
