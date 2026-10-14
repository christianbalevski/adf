import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { canonicalizePath, containsPath } from './tracked-paths'

/**
 * Founding an agent from the fleet map (MESH_FOUND_AGENT): the checks and the
 * file name, shared by Studio's handler (ipc/index.ts) and the daemon's
 * `POST /fleet/found` so the two cannot drift (design §3.2, rule E1).
 */

/** The typed name slugged into a file name; `agent` when nothing is left. */
export function foundAgentFileName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '') || 'agent'
}

export type FoundAgentPlan =
  | { ok: true; name: string; dir: string; fileName: string; filePath: string }
  | { ok: false; error: string }

/**
 * Validate a found request and prepare its folder. The destination must be
 * inside a tracked folder or, with `newRoot`, a sibling of a tracked root
 * (its parent is some tracked root's parent), never an arbitrary disk
 * location. The folder is created; an existing file of the slugged name is
 * refused. Errors from the file system throw.
 */
export function prepareFoundAgent(
  args: { dir: string; name: string; newRoot?: boolean } | null | undefined,
  trackedDirs: readonly string[],
): FoundAgentPlan {
  const name = (args?.name ?? '').trim()
  const dir = args?.dir ?? ''
  if (!name) return { ok: false, error: 'Agent name required' }

  const canonDir = canonicalizePath(dir)
  const inTracked = trackedDirs.some((d) => containsPath(canonicalizePath(d), canonDir))
  const allowedAsNewRoot = args?.newRoot === true && trackedDirs.some((d) =>
    containsPath(dirname(canonicalizePath(d)), canonDir)
  )
  if (!inTracked && !allowedAsNewRoot) return { ok: false, error: 'Destination is outside tracked directories' }

  mkdirSync(dir, { recursive: true })
  const fileName = foundAgentFileName(name)
  const filePath = join(dir, `${fileName}.adf`)
  if (existsSync(filePath)) return { ok: false, error: `${fileName}.adf already exists here` }
  return { ok: true, name, dir, fileName, filePath }
}
