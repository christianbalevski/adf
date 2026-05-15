/**
 * TypeScript → JavaScript transpiler for lambda files.
 *
 * Type-strip only via esbuild transform mode — no bundling, no module
 * resolution, no type checking.  Cached by SHA-256 content hash.
 */

import { createHash } from 'crypto'
import { stop, transform } from 'esbuild'

const cache = new Map<string, string>()

function sha256(source: string): string {
  return createHash('sha256').update(source).digest('hex')
}

function isDeadServiceError(msg: string): boolean {
  return msg.includes('service is no longer running') || msg.includes('EPIPE')
}

async function runTransform(source: string): Promise<string> {
  const { code } = await transform(source, {
    loader: 'ts',
    target: 'node20',
  })
  return code
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
    let code: string
    try {
      code = await runTransform(source)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!isDeadServiceError(msg)) throw err
      // esbuild's shared service subprocess has died; reset the singleton and retry once.
      console.warn(`[ts-transpiler] esbuild service died, restarting and retrying: ${msg}`)
      try { await stop() } catch { /* ignore */ }
      code = await runTransform(source)
    }
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
