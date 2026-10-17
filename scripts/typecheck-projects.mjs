import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url))
const tsc = join(root, '..', 'node_modules', 'typescript', 'bin', 'tsc')

/** Run every production TypeScript project and report failure if any project fails. */
export function runTypecheckProjects(run = spawnSync) {
  let failed = false
  for (const project of ['tsconfig.node.json', 'tsconfig.web.json']) {
    console.log(`[typecheck] ${project}`)
    const result = run(process.execPath, [tsc, '--noEmit', '-p', project], {
      cwd: join(root, '..'),
      stdio: 'inherit',
      windowsHide: true,
    })
    if (result.error) {
      console.error(`Could not run TypeScript check for ${project}:`, result.error)
      failed = true
    } else if (result.status !== 0) {
      failed = true
    }
  }
  return failed ? 1 : 0
}
