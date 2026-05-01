/**
 * TypeScript → JavaScript transpiler for lambda files.
 *
 * Type-strip only via esbuild transform mode — no bundling, no module
 * resolution, no type checking.  Cached by SHA-256 content hash.
 */

import { createHash } from 'crypto'
import { transform } from 'esbuild'

const cache = new Map<string, string>()

function sha256(source: string): string {
  return createHash('sha256').update(source).digest('hex')
}

/**
 * Transpile a `.ts` source string to JavaScript.
 * Returns the original source unchanged for non-TS content.
 * Throws on syntax errors with file path context.
 */
export async function transpileTs(source: string, filePath: string): Promise<string> {
  const hash = sha256(source)
  const cached = cache.get(hash)
  if (cached !== undefined) return cached

  try {
    const { code } = await transform(source, {
      loader: 'ts',
      target: 'node20',
    })
    cache.set(hash, code)
    return code
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Transpilation failed for "${filePath}": ${msg}`)
  }
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
