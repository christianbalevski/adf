/**
 * GET /fs/browse roots with ADF_DAEMON_BROWSE_ROOTS unset (the default): the
 * home folder, and the tracked folders and the agents folder as their own
 * roots even though they sit inside it, so the remote upload picker (which
 * offers only `tracked` and `agents` roots) has somewhere to upload into.
 * The home folder is a temp folder here (HOME / USERPROFILE), and the OS temp
 * folder is moved inside it, so the agents folder setting is not refused as
 * a temp location and the real Documents folder is never looked up.
 * On Linux `/tmp` is always a temp location, so there the setting is refused
 * and the default, <home>/Documents/adf-agents, is the same folder: the
 * Documents lookup is reset per test so it names this test's home.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { browse, browseRoots, BROWSE_ROOTS_ENV, resetDocumentsDirCache } from '../src/main/daemon/file-ops'

const ENV_KEYS = [BROWSE_ROOTS_ENV, 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR', 'XDG_CONFIG_HOME'] as const
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
let home: string

const restore = (key: string, value: string | undefined) => { if (value === undefined) delete process.env[key]; else process.env[key] = value }

beforeEach(() => {
  home = realpathSync.native(mkdtempSync(join(tmpdir(), 'adf-browse-home-')))
  delete process.env[BROWSE_ROOTS_ENV]
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.XDG_CONFIG_HOME = join(home, '.config')
  const temp = join(home, '.tmp')
  mkdirSync(temp)
  process.env.TEMP = process.env.TMP = process.env.TMPDIR = temp
  resetDocumentsDirCache()
})
afterEach(() => {
  for (const k of ENV_KEYS) restore(k, saved[k])
  resetDocumentsDirCache()
  rmSync(home, { recursive: true, force: true })
})

function settings(values: Record<string, unknown>) {
  return { get: (key: string) => values[key] }
}

describe('browse roots by default (ADF_DAEMON_BROWSE_ROOTS unset)', () => {
  it('lists home, and the tracked folders and the agents folder inside it as their own roots, so an upload has a target', async () => {
    const tracked = join(home, 'work')
    const nested = join(tracked, 'team')
    const agents = join(home, 'Documents', 'adf-agents')
    for (const d of [nested, agents]) mkdirSync(d, { recursive: true })
    const roots = await browseRoots(settings({ trackedDirectories: [tracked, nested], agentsFolder: agents }))
    expect(roots).toEqual([
      { path: home, kind: 'home' },
      { path: tracked, kind: 'tracked' },
      { path: agents, kind: 'agents' },
    ])
    // What the upload picker offers (RemotePickerDialog: kind tracked or agents).
    expect(roots.filter((r) => r.kind === 'tracked' || r.kind === 'agents').map((r) => r.path)).toEqual([tracked, agents])
  })

  it('a folder that is both home and tracked keeps the upload kind', async () => {
    const roots = await browseRoots(settings({ trackedDirectories: [home], agentsFolder: join(home, 'missing') }))
    expect(roots).toEqual([{ path: home, kind: 'tracked' }])
  })

  it('the agents folder inside home has its home folder as parent; home itself has none', async () => {
    const agents = join(home, 'Documents', 'adf-agents')
    mkdirSync(agents, { recursive: true })
    const s = settings({ agentsFolder: agents })
    expect((await browse(s, agents)).parent).toBe(join(home, 'Documents'))
    expect((await browse(s, home)).parent).toBeNull()
    expect((await browse(s, undefined)).roots.map((r) => r.kind)).toEqual(['home', 'agents'])
  })
})
