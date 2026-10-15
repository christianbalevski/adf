/**
 * POST /fs/folders: New folder in the daemon-side picker (W4-B review).
 * Same bounds as GET /fs/browse: inside a browse root, one path segment.
 */
import Fastify from 'fastify'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { registerFsFolderRoutes, folderNameProblem } from '../src/main/daemon/routes/fs-folder-routes'

const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'adf-fs-folders-')))
const inside = join(root, 'agents')
const outside = realpathSync.native(mkdtempSync(join(tmpdir(), 'adf-fs-folders-out-')))
const app = Fastify()
const saved = process.env.ADF_DAEMON_BROWSE_ROOTS

beforeAll(async () => {
  mkdirSync(inside)
  process.env.ADF_DAEMON_BROWSE_ROOTS = root
  registerFsFolderRoutes(app, { options: { settingsStore: { get: () => undefined } } } as never)
  await app.ready()
})
afterAll(async () => {
  await app.close()
  if (saved === undefined) delete process.env.ADF_DAEMON_BROWSE_ROOTS
  else process.env.ADF_DAEMON_BROWSE_ROOTS = saved
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

const post = (payload: unknown) => app.inject({ method: 'POST', url: '/fs/folders', payload: payload as object })

describe('POST /fs/folders', () => {
  it('creates one folder inside a browse root', async () => {
    const res = await post({ parent: inside, name: 'research' })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual({ path: join(inside, 'research') })
    expect(existsSync(join(inside, 'research'))).toBe(true)
    expect((await post({ parent: inside, name: 'research' })).json()).toMatchObject({ code: 'exists' })
  })

  it('refuses a parent outside the roots, a missing parent and names that are not one segment', async () => {
    expect((await post({ parent: outside, name: 'x' })).statusCode).toBe(403)
    expect((await post({ parent: join(root, 'missing'), name: 'x' })).statusCode).toBe(404)
    expect((await post({ parent: 'relative', name: 'x' })).statusCode).toBe(400)
    for (const name of ['..', '.', 'a/b', 'a\\b', 'CON', 'x.', '', 'a\u0001b']) {
      expect((await post({ parent: inside, name })).statusCode, JSON.stringify(name)).toBe(400)
    }
    expect(folderNameProblem('ok-name')).toBeNull()
    expect(existsSync(join(outside, 'x'))).toBe(false)
  })
})
