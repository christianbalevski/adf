// New folder for the daemon-side picker (design §9.4, tracker W4-B review):
//
//   POST /fs/folders   { parent, name } → 201 { path }
//
// The picker of a remote Studio lists GET /fs/browse; this creates one
// folder in a listed folder, with the same bounds: the parent (after
// resolving links) must be inside a browse root (home folder, tracked
// folders, agents folder, ADF_DAEMON_BROWSE_ROOTS), and the name is one
// path segment. An existing name is refused (409 exists), never reused.

import type { FastifyInstance } from 'fastify'
import { mkdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { browseRoots } from '../file-ops'
import { containsPath } from '../../utils/tracked-paths'
import type { DaemonRouteContext } from './index'

const INVALID_NAME = /[<>:"/\\|?*\u0000-\u001f\u007f]/
const DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/** Why `name` is not a folder name, or null. */
export function folderNameProblem(name: unknown): string | null {
  if (typeof name !== 'string' || !name.trim()) return 'name must be a folder name'
  const n = name.trim()
  if (n === '.' || n === '..' || n.length > 255) return 'name must be a folder name'
  if (INVALID_NAME.test(n) || n.endsWith('.') || DEVICE_NAME.test(n)) return 'name contains characters not allowed in folder names'
  return null
}

export function registerFsFolderRoutes(server: FastifyInstance, ctx: DaemonRouteContext): void {
  server.post<{ Body: { parent?: unknown; name?: unknown } | undefined }>('/fs/folders', async (request, reply) => {
    const body = request.body ?? {}
    const bad = (error: string, code = 'bad_request', status = 400) => reply.code(status).send({ error, code })
    if (typeof body.parent !== 'string' || body.parent.includes('\0') || !isAbsolute(body.parent.trim())) return bad('parent must be an absolute path')
    const nameProblem = folderNameProblem(body.name)
    if (nameProblem) return bad(nameProblem, 'invalid_name')
    const roots = await browseRoots(ctx.options.settingsStore)
    let parent: string
    try {
      parent = await realpath(body.parent.trim())
      if (!(await stat(parent)).isDirectory()) return bad(`Not a folder: ${parent}`, 'not_a_directory')
    } catch {
      return bad(`No such folder: ${body.parent.trim()}`, 'not_found', 404)
    }
    if (!roots.some((r) => containsPath(r.path, parent))) {
      return bad(`Outside the folders this daemon lists (home, tracked folders, agents folder, ADF_DAEMON_BROWSE_ROOTS): ${parent}`, 'outside_roots', 403)
    }
    const target = join(parent, (body.name as string).trim())
    try {
      await mkdir(target)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') return bad(`${target} already exists`, 'exists', 409)
      return reply.code(500).send({ error: `Could not create ${target}: ${err instanceof Error ? err.message : String(err)}` })
    }
    console.log(`[FileRoutes] Created folder ${target} (daemon-side picker)`)
    return reply.code(201).send({ path: target })
  })
}
