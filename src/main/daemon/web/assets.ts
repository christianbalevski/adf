import { existsSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

/** Locate built assets in source checkouts, Electron bundles and npm installs. */
export function findWebRoot(explicit?: string, moduleDirectory = __dirname, cwd = process.cwd()): string | null {
  if (explicit || process.env.ADF_WEB_ROOT) return resolve(explicit ?? process.env.ADF_WEB_ROOT!)
  const candidates: string[] = []
  let parent = moduleDirectory
  for (let i = 0; i < 6; i++) {
    // src/web/index.html is Vite's input, not a deployable build. In source
    // mode resolve this checkout's output, even when launched from another cwd.
    candidates.push(basename(parent) === 'src'
      ? resolve(parent, '../out/web')
      : resolve(parent, 'web'))
    parent = dirname(parent)
  }
  candidates.push(resolve(cwd, 'out/web'))
  return candidates.find(path => existsSync(resolve(path, 'index.html'))) ?? null
}
