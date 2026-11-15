import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 20_000 })
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { parseSkillFrontmatter } from '../../../src/main/adf/skill-indexer'
import { atomicBatchFailure, decodeAgentFileBatch } from '../../../src/main/runtime/file-batch'
import { fileRevision } from '../../../src/main/runtime/resource-revisions'
import { createAdfApi } from '../../../src/shared/adf-api'
import { IPC } from '../../../src/shared/constants/ipc-channels'
import { importSkillManifest, readAdfCompat } from '../../../src/shared/utils/skill-import'
import { useDocumentStore } from '../../../src/renderer/stores/document.store'
import { useEditorTabsStore } from '../../../src/renderer/stores/editor-tabs.store'
import { captureAgentView } from '../../../src/renderer/utils/agent-view'
import type { AdfApi } from '../../../src/preload/api'

/**
 * The renderer's install flow (utils/skill-install.ts) against real
 * workspaces: the real preload adapter (createAdfApi), real AdfWorkspace
 * files, the real batch decoder and writeFilesAtomic, the real indexer. The
 * stand-in backend answers each runtime the way Studio main does: it writes
 * to ITS foreground file, and DOC_WRITE_INTERNAL_FILES compares the named
 * file with it in the same turn (ipc/index.ts). Both backends are also
 * recorded by the parity scenario tests/parity/file-batch.
 */

const runtimes = vi.hoisted(() => ({ apis: new Map<string, unknown>() }))
vi.mock('../../../src/renderer/utils/runtime-api', () => ({
  apiFor: (runtimeId?: string | null) => runtimes.apis.get(runtimeId || 'local'),
  openApi: () => runtimes.apis.get(useDocumentStore.getState().runtimeId || 'local'),
}))

import { commitSkillInstall, installFromCard, manifestName, prepareSkillInstall, toManifestState, type InstallRequest, type ManifestState } from '../../../src/renderer/utils/skill-install'
import { readSkillsPanel } from '../../../src/renderer/utils/skills-panel-refresh'
import { apiFor } from '../../../src/renderer/utils/runtime-api'

const FIX = join(__dirname, '../../fixtures/skills-sources/manifests')
const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

interface Backend {
  workspaces: Map<string, AdfWorkspace>
  foreground: string | null
  /** Called inside the batch handler before it commits (simulates a switch racing the IPC). */
  beforeBatch?: () => void
  writes: number
}

const remote: Record<string, { ok: true; contentBase64: string; size: number } | { ok: false; error: string }> = {}
const bytes = (url: string, data: Buffer) => { remote[url] = { ok: true, contentBase64: data.toString('base64'), size: data.length } }

function backendApi(runtimeId: string, backend: Backend): AdfApi {
  return createAdfApi({
    runtimeId,
    invoke: async (channel: string, ...args: unknown[]) => {
      const ws = backend.foreground ? backend.workspaces.get(backend.foreground)! : null
      const arg = (args[0] ?? {}) as Record<string, unknown>
      switch (channel) {
        case IPC.DOC_GET_FILES: return { files: ws ? ws.listFiles() : [] }
        case IPC.DOC_READ_INTERNAL_FILE: {
          const buf = ws?.readFileBuffer(String(arg.path))
          if (!ws || !buf) return { content: null, binary: false }
          return { content: buf.toString('utf8'), binary: !String(arg.path).endsWith('.md') && !String(arg.path).endsWith('.json'), revision: fileRevision(ws, String(arg.path)).revision }
        }
        case IPC.SKILLS_PACKAGE_GET: return remote[String(arg.url)] ?? { ok: false, error: 'HTTP 404' }
        case IPC.DOC_WRITE_INTERNAL_FILES: {
          backend.beforeBatch?.()
          const current = backend.foreground
          const workspace = current ? backend.workspaces.get(current) : null
          if (!workspace || arg.expectFilePath !== current) return { success: false, code: 'agent_changed', error: 'The open agent changed — nothing was written.' }
          try {
            const batch = decodeAgentFileBatch(arg.files)
            workspace.writeFilesAtomic(batch)
            backend.writes++
            return { success: true, revisions: Object.fromEntries(batch.map((f) => [f.path, fileRevision(workspace, f.path).revision])) }
          } catch (err) {
            const refused = atomicBatchFailure(err)
            if (refused) return { success: false, code: refused.code, error: refused.message, ...refused.details }
            throw err
          }
        }
        default: throw new Error(`unexpected channel ${channel}`)
      }
    },
    send: () => {}, on: () => {}, removeListener: () => {},
  } as never, { platform: 'linux', setZoomFactor: () => {} } as never) as unknown as AdfApi
}

const dirs: string[] = []
const open: AdfWorkspace[] = []
function agent(name: string): { path: string; ws: AdfWorkspace } {
  const dir = mkdtempSync(join(tmpdir(), 'adf-skill-install-'))
  dirs.push(dir)
  const path = join(dir, `${name}.adf`)
  const ws = AdfWorkspace.create(path, { name })
  open.push(ws)
  return { path, ws }
}

/** The renderer showing `path` on `runtimeId` (a new view generation, as FILE_OPEN does). */
function show(path: string, runtimeId = 'local'): void {
  useDocumentStore.getState().setFilePath(path, runtimeId as never)
}

function request(manifestText: string, files: Array<{ path: string; raw_url: string }> = [], key = 'card'): InstallRequest {
  // The view is captured when the request is made, as the click handler does before its first await.
  return { key, manifestUrl: 'https://raw.test/SKILL.md', manifest: { content: manifestText, import: importSkillManifest(manifestText, 'https://raw.test/SKILL.md', parseSkillFrontmatter) }, files, view: captureAgentView() }
}

const MANIFEST = '---\nname: alpha\ndescription: Does alpha.\n---\n\n# Alpha\n'
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe])
const refresh = async () => {}

let A: ReturnType<typeof agent>
let B: ReturnType<typeof agent>
let local: Backend
beforeEach(() => {
  A = agent('a')
  B = agent('b')
  local = { workspaces: new Map([[A.path, A.ws], [B.path, B.ws]]), foreground: A.path, writes: 0 }
  runtimes.apis.set('local', backendApi('local', local))
  useDocumentStore.getState().reset()
  useEditorTabsStore.getState().reset()
  show(A.path)
  for (const key of Object.keys(remote)) delete remote[key]
  bytes('https://raw.test/ref.md', Buffer.from('# ref'))
  bytes('https://raw.test/logo.png', PNG)
})
afterEach(() => {
  for (const ws of open.splice(0)) { try { ws.close() } catch { /* closed */ } }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Installs wait (really) for the debounced index; nothing here is faked. */
const run = <T,>(promise: Promise<T>): Promise<T> => promise

describe('install: one batch, exact bytes, the outcome says what was written', () => {
  it('a fresh install writes every file in one batch, binary exact, and says where it wrote', async () => {
    const files = [{ path: 'ref.md', raw_url: 'https://raw.test/ref.md' }, { path: 'assets/logo.png', raw_url: 'https://raw.test/logo.png' }]
    const outcome = await run(prepareSkillInstall(request(MANIFEST, files), refresh))
    expect(outcome).toEqual({ error: null, notice: 'Written to skills/alpha/ in a.adf.' })
    expect(local.writes).toBe(1)
    expect(A.ws.readFileBuffer('skills/alpha/assets/logo.png')!.equals(PNG)).toBe(true)
    expect(A.ws.readFile('skills/alpha/SKILL.md')).toBe(MANIFEST)
    expect(B.ws.fileExists('skills/alpha/SKILL.md')).toBe(false)
  })

  it('an adjusted manifest installs the adjusted bytes the preview held (no refetch)', async () => {
    const docx = readFileSync(join(FIX, 'anthropics-docx.SKILL.md'), 'utf8')
    const req = request(docx)
    expect(req.manifest.import.ok && req.manifest.import.changes.length).toBe(1)
    const outcome = await run(prepareSkillInstall(req, refresh))
    expect(outcome).toEqual({ error: null, notice: 'Written to skills/docx/ in a.adf.' })
    expect(A.ws.readFile('skills/docx/SKILL.md')).toBe(req.manifest.import.ok ? req.manifest.import.manifest : null)
    expect(readAdfCompat(A.ws.readFile('skills/docx/SKILL.md'))).toEqual({ native: false, reason: 'absent' })
  })

  it('a resource that fails to fetch writes nothing; a retry after it is back installs', async () => {
    remote['https://raw.test/logo.png'] = { ok: false, error: 'HTTP 503' }
    const files = [{ path: 'ref.md', raw_url: 'https://raw.test/ref.md' }, { path: 'assets/logo.png', raw_url: 'https://raw.test/logo.png' }]
    expect(await run(prepareSkillInstall(request(MANIFEST, files), refresh))).toEqual({ error: 'assets/logo.png: HTTP 503. Nothing was written.' })
    expect(A.ws.listFiles().some((f) => f.path.startsWith('skills/alpha/'))).toBe(false)
    bytes('https://raw.test/logo.png', PNG)
    expect(await run(prepareSkillInstall(request(MANIFEST, files), refresh))).toEqual({ error: null, notice: 'Written to skills/alpha/ in a.adf.' })
  })

})

describe('reinstall: explicit, CAS-guarded, extra files kept', () => {
  async function installed(): Promise<void> {
    A.ws.writeFile('skills/alpha/SKILL.md', MANIFEST)
    A.ws.writeFile('skills/alpha/ref.md', 'old ref')
    A.ws.writeFile('skills/alpha/agent-notes.md', 'kept')
    await settle()
  }

  it('asks first, naming what it replaces and what it keeps; declining writes nothing', async () => {
    await installed()
    const outcome = await run(prepareSkillInstall(request(MANIFEST.replace('# Alpha', '# Alpha v2'), [{ path: 'ref.md', raw_url: 'https://raw.test/ref.md' }]), refresh))
    expect(outcome.error).toBeNull()
    expect(outcome.confirm).toMatchObject({ name: 'alpha', replaces: ['skills/alpha/ref.md', 'skills/alpha/SKILL.md'], keeps: ['skills/alpha/agent-notes.md'] })
    // Declined: nothing happens.
    expect(local.writes).toBe(0)
    expect(A.ws.readFile('skills/alpha/ref.md')).toBe('old ref')
    // Confirmed: one batch, extra file untouched.
    expect(await run(commitSkillInstall(outcome.confirm!, refresh))).toEqual({ error: null, notice: 'Written to skills/alpha/ in a.adf.' })
    expect(A.ws.readFile('skills/alpha/ref.md')).toBe('# ref')
    expect(A.ws.readFile('skills/alpha/SKILL.md')).toContain('# Alpha v2')
    expect(A.ws.readFile('skills/alpha/agent-notes.md')).toBe('kept')
  })

  it('a folder holding only files the package does not ship still asks first, listing the kept files; nothing is written until confirmed', async () => {
    A.ws.writeFile('skills/alpha/scripts/run.py', 'print(1)')
    const outcome = await run(prepareSkillInstall(request(MANIFEST, [{ path: 'ref.md', raw_url: 'https://raw.test/ref.md' }]), refresh))
    expect(outcome.error).toBeNull()
    expect(outcome.confirm).toMatchObject({ name: 'alpha', replaces: [], keeps: ['skills/alpha/scripts/run.py'], occupied: true })
    expect(local.writes).toBe(0)
    expect(A.ws.fileExists('skills/alpha/SKILL.md')).toBe(false)
  })

  it('a change after the confirmation was shown refuses the whole reinstall; the old package stays byte-identical', async () => {
    await installed()
    const outcome = await run(prepareSkillInstall(request(MANIFEST.replace('# Alpha', '# v2'), [{ path: 'ref.md', raw_url: 'https://raw.test/ref.md' }]), refresh))
    A.ws.writeFile('skills/alpha/ref.md', 'edited by the agent while the dialog was open')
    const before = A.ws.readFileBuffer('skills/alpha/SKILL.md')!
    const committed = await run(commitSkillInstall(outcome.confirm!, refresh))
    expect(committed.error).toMatch(/changed .*Nothing was written; install again/)
    expect(A.ws.readFileBuffer('skills/alpha/SKILL.md')!.equals(before)).toBe(true)
    expect(A.ws.readFile('skills/alpha/ref.md')).toBe('edited by the agent while the dialog was open')
  })

  it('a read-only file refuses before anything is sent', async () => {
    await installed()
    A.ws.setFileProtection('skills/alpha/ref.md', 'read_only')
    const outcome = await run(prepareSkillInstall(request(MANIFEST, [{ path: 'ref.md', raw_url: 'https://raw.test/ref.md' }]), refresh))
    expect(outcome).toEqual({ error: 'skills/alpha/ref.md is read-only. Nothing was written.' })
    expect(local.writes).toBe(0)
  })

  it('an open, unsaved editor tab keeps its text; a clean one follows with the new revision', async () => {
    await installed()
    const tabs = useEditorTabsStore.getState()
    tabs.openTab('skills/alpha/ref.md', 'old ref', false, undefined, 1)
    tabs.openTab('skills/alpha/SKILL.md', MANIFEST, false, undefined, 1)
    tabs.updateTabContent('skills/alpha/SKILL.md', 'my unsaved edit')
    const outcome = await run(prepareSkillInstall(request(MANIFEST.replace('# Alpha', '# v2'), [{ path: 'ref.md', raw_url: 'https://raw.test/ref.md' }]), refresh))
    await run(commitSkillInstall(outcome.confirm!, refresh))
    const now = useEditorTabsStore.getState().tabs
    expect(now.find((t) => t.path === 'skills/alpha/ref.md')).toMatchObject({ content: '# ref', isDirty: false, revision: fileRevision(A.ws, 'skills/alpha/ref.md').revision })
    expect(now.find((t) => t.path === 'skills/alpha/SKILL.md')).toMatchObject({ content: 'my unsaved edit', isDirty: true })
  })
})

describe('identity: the agent the install started under, and only it', () => {
  it('A→B during the fetches: nothing is written to either', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const api = runtimes.apis.get('local') as AdfApi
    const real = api.getSkillPackageBytes
    ;(api as { getSkillPackageBytes: AdfApi['getSkillPackageBytes'] }).getSkillPackageBytes = async (url) => { await gate; return real(url) }
    const pending = run(prepareSkillInstall(request(MANIFEST, [{ path: 'ref.md', raw_url: 'https://raw.test/ref.md' }]), refresh))
    local.foreground = B.path
    show(B.path)
    release()
    expect(await pending).toEqual({ error: 'The open agent changed — nothing was written.' })
    ;(api as { getSkillPackageBytes: AdfApi['getSkillPackageBytes'] }).getSkillPackageBytes = real
    expect(local.writes).toBe(0)
    expect(A.ws.fileExists('skills/alpha/SKILL.md') || B.ws.fileExists('skills/alpha/SKILL.md')).toBe(false)
  })

  it('A→B→A before Replace: same file, new view generation — refused, nothing written', async () => {
    A.ws.writeFile('skills/alpha/SKILL.md', MANIFEST)
    const outcome = await run(prepareSkillInstall(request(MANIFEST.replace('# Alpha', '# v2')), refresh))
    show(B.path); show(A.path)
    expect(await run(commitSkillInstall(outcome.confirm!, refresh))).toEqual({ error: 'The open agent changed — nothing was written.' })
    expect(A.ws.readFile('skills/alpha/SKILL.md')).toBe(MANIFEST)
  })

  it('the same path on another runtime is another agent: refused, and the other runtime is never called', async () => {
    const other: Backend = { workspaces: new Map([[A.path, B.ws]]), foreground: A.path, writes: 0 }
    runtimes.apis.set('remote-1', backendApi('remote-1', other))
    A.ws.writeFile('skills/alpha/SKILL.md', MANIFEST)
    const outcome = await run(prepareSkillInstall(request(MANIFEST.replace('# Alpha', '# v2')), refresh))
    show(A.path, 'remote-1')
    expect(await run(commitSkillInstall(outcome.confirm!, refresh))).toEqual({ error: 'The open agent changed — nothing was written.' })
    expect(other.writes + local.writes).toBe(0)
  })

  it('the backend switching between the check and its commit refuses (it names the file it means)', async () => {
    local.beforeBatch = () => { local.foreground = B.path }
    expect(await run(prepareSkillInstall(request(MANIFEST), refresh))).toEqual({ error: 'The open agent changed — nothing was written. Nothing was written.' })
    expect(A.ws.fileExists('skills/alpha/SKILL.md') || B.ws.fileExists('skills/alpha/SKILL.md')).toBe(false)
  })

  it('a commit that succeeded is reported as written to its agent even if the human switched agents right after', async () => {
    local.beforeBatch = () => { local.beforeBatch = undefined; queueMicrotask(() => show(B.path)) }
    const outcome = await run(prepareSkillInstall(request(MANIFEST), refresh))
    expect(outcome).toEqual({ error: null, notice: 'Written to skills/alpha/ in a.adf.' })
    expect(A.ws.readFile('skills/alpha/SKILL.md')).toBe(MANIFEST)
    expect(B.ws.fileExists('skills/alpha/SKILL.md')).toBe(false)
  })
})

/*
 * The orchestration the Skills panel itself runs (SkillsPanel.refresh calls
 * readSkillsPanel; the catalog dialog's Install calls installFromCard with the
 * view it captured at the click), against the same real workspaces.
 */
describe('panel refresh: one view, one runtime, every displayed label', () => {
  const VIEW_DOC = '---\nname: zz-native\ndescription: d\nadf: ">=0.2"\n---\n'

  it('the same path on another runtime during a refresh: nothing from either is painted', async () => {
    const other: Backend = { workspaces: new Map([[A.path, B.ws]]), foreground: A.path, writes: 0 }
    runtimes.apis.set('remote-1', backendApi('remote-1', other))
    B.ws.writeFile('skills/other/SKILL.md', '---\nname: other\ndescription: d\n---\n')
    await new Promise((resolve) => setTimeout(resolve, 400))
    const view = captureAgentView()
    const api = runtimes.apis.get('local') as AdfApi
    const realList = api.getInternalFiles
    ;(api as { getInternalFiles: AdfApi['getInternalFiles'] }).getInternalFiles = async () => { const list = await realList(); show(A.path, 'remote-1'); return list }
    try {
      const snapshot = await readSkillsPanel(view, apiFor(view.runtimeId))
      expect(snapshot).toBeNull()
    } finally {
      ;(api as { getInternalFiles: AdfApi['getInternalFiles'] }).getInternalFiles = realList
    }
  })

  it('A→B→A during a refresh: B\'s registry is never painted under A\'s files', async () => {
    B.ws.writeFile('skills/b-only/SKILL.md', '---\nname: b-only\ndescription: d\n---\n')
    await new Promise((resolve) => setTimeout(resolve, 400))
    const view = captureAgentView()
    const api = runtimes.apis.get('local') as AdfApi
    const realRead = api.readInternalFile
    ;(api as { readInternalFile: AdfApi['readInternalFile'] }).readInternalFile = async (path, opts) => {
      if (path !== 'skills-registry.json') return realRead(path, opts)
      local.foreground = B.path; show(B.path)
      const read = await realRead(path, opts)
      local.foreground = A.path; show(A.path)
      return read
    }
    try {
      const snapshot = await readSkillsPanel(view, apiFor(view.runtimeId))
      expect(snapshot === null || !snapshot.registry?.entries.some((e) => e.name === 'b-only')).toBe(true)
      expect(snapshot).toBeNull()
    } finally {
      ;(api as { readInternalFile: AdfApi['readInternalFile'] }).readInternalFile = realRead
    }
  })

  it('every listed skill gets its label, however many other manifests sort before it (> 96)', async () => {
    for (let i = 0; i < 100; i++) A.ws.writeFile(`skills/a${String(i).padStart(3, '0')}/SKILL.md`, '# no frontmatter')
    A.ws.writeFile('skills/zz-native/SKILL.md', VIEW_DOC)
    await new Promise((resolve) => setTimeout(resolve, 500))
    const view = captureAgentView()
    const snapshot = await readSkillsPanel(view, apiFor(view.runtimeId))
    expect(snapshot?.registry?.entries.map((e) => e.name)).toEqual(['zz-native'])
    expect(snapshot?.compat['zz-native']).toEqual({ native: true, range: '>=0.2' })
  })
})

/*
 * F1 (r4): a valid `adf` declaration in frontmatter the index reads but strict
 * YAML does not (`description: Use when: …`) was labelled "Not ADF-native".
 */
describe('the adf label reads frontmatter the way the index does', () => {
  const USE_WHEN = '---\nname: use-when\ndescription: Use when: you need X\nadf: ">=0.2"\n---\nbody\n'

  it('is native on the card (the import decision) and in the installed list', async () => {
    expect(importSkillManifest(USE_WHEN, 'https://raw.test/SKILL.md', parseSkillFrontmatter)).toMatchObject({ ok: true, changes: [], compat: { native: true, range: '>=0.2' } })
    A.ws.writeFile('skills/use-when/SKILL.md', USE_WHEN)
    await new Promise((resolve) => setTimeout(resolve, 500))
    const view = captureAgentView()
    const snapshot = await readSkillsPanel(view, apiFor(view.runtimeId))
    expect(snapshot?.compat['use-when']).toEqual({ native: true, range: '>=0.2' })
  })

  it('two top-level adf lines are not native; none is "declares no adf version"', () => {
    expect(readAdfCompat('---\nname: a\ndescription: Use when: x\nadf: ">=0.2"\nadf: ">=0.3"\n---\n')).toMatchObject({ native: false, reason: 'unreadable' })
    expect(readAdfCompat('---\nname: a\ndescription: Use when: x\n---\n')).toEqual({ native: false, reason: 'absent' })
    expect(readAdfCompat('---\nname: a\ndescription: Use when: x\nadf: soon\n---\n')).toMatchObject({ native: false, reason: 'invalid' })
  })
})

/*
 * F2 (r4): every refresh reread every listed SKILL.md (up to 48, two daemon
 * requests each), and refresh now follows every file write.
 */
describe('panel refresh rereads only the manifests whose file-list entry changed', () => {
  it('an unchanged list rereads 0 manifests; one changed manifest rereads exactly 1', async () => {
    for (const name of ['one', 'two', 'three']) A.ws.writeFile(`skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: d\n---\n`)
    await new Promise((resolve) => setTimeout(resolve, 500))
    const api = apiFor('local') as AdfApi
    const realRead = api.readInternalFile
    const reads: string[] = []
    ;(api as { readInternalFile: AdfApi['readInternalFile'] }).readInternalFile = async (path, opts) => { if (path.endsWith('/SKILL.md')) reads.push(path); return realRead(path, opts) }
    try {
      const refresh = async () => { const view = captureAgentView(); return readSkillsPanel(view, apiFor(view.runtimeId)) }
      await refresh()
      reads.length = 0
      await refresh()
      expect(reads).toEqual([])
      A.ws.writeFile('skills/two/SKILL.md', '---\nname: two\ndescription: d\nadf: ">=0.2"\n---\n')
      await new Promise((resolve) => setTimeout(resolve, 500))
      const snapshot = await refresh()
      expect(reads).toEqual(['skills/two/SKILL.md'])
      expect(snapshot?.compat.two).toEqual({ native: true, range: '>=0.2' })
      expect(snapshot?.compat.one).toEqual({ native: false, reason: 'absent' })
    } finally {
      ;(api as { readInternalFile: AdfApi['readInternalFile'] }).readInternalFile = realRead
    }
  })
})

describe('catalog card install: the view of the click, not of whatever is open when the manifest arrives', () => {
  const card = (load: () => Promise<ManifestState>, active = () => true) => ({
    view: captureAgentView(),
    active,
    key: 'card',
    manifestUrl: 'https://raw.test/SKILL.md',
    files: [{ path: 'ref.md', raw_url: 'https://raw.test/ref.md' }],
    fromPreview: false,
    cached: undefined,
    load,
  })
  const ready = (): ManifestState => ({ status: 'ready', content: MANIFEST, import: importSkillManifest(MANIFEST, 'https://raw.test/SKILL.md', parseSkillFrontmatter) })

  it('A→B while the manifest loads: nothing is written to either', async () => {
    const result = await installFromCard(card(async () => { local.foreground = B.path; show(B.path); return ready() }), (request) => prepareSkillInstall(request, refresh))
    expect(result).toEqual({ kind: 'done', outcome: { error: 'The open agent changed — nothing was written.' } })
    expect(local.writes).toBe(0)
    expect(A.ws.fileExists('skills/alpha/SKILL.md') || B.ws.fileExists('skills/alpha/SKILL.md')).toBe(false)
  })

  it('the dialog closed while the manifest loads: nothing is written', async () => {
    let open = true
    const result = await installFromCard(card(async () => { open = false; return ready() }, () => open), (request) => prepareSkillInstall(request, refresh))
    expect(result).toEqual({ kind: 'done', outcome: { error: 'The open agent changed — nothing was written.' } })
    expect(local.writes).toBe(0)
  })

  it('unchanged view: installs into A', async () => {
    const result = await installFromCard(card(async () => ready()), (request) => prepareSkillInstall(request, refresh))
    expect(result).toEqual({ kind: 'done', outcome: { error: null, notice: 'Written to skills/alpha/ in a.adf.' } })
    expect(A.ws.readFile('skills/alpha/SKILL.md')).toBe(MANIFEST)
  })
})

describe('after a committed write, a failure is never "nothing was written"', () => {
  it('a refresh that throws after the commit still reports what was written', async () => {
    const outcome = await prepareSkillInstall(request(MANIFEST), async () => { throw new Error('panel refresh broke') })
    expect(outcome).toEqual({ error: null, notice: 'Written to skills/alpha/ in a.adf.' })
    expect(A.ws.readFile('skills/alpha/SKILL.md')).toBe(MANIFEST)
  })
})

describe('a runtime that predates import decisions', () => {
  it('its package answer ({ ok, content }, no import) becomes a refusal state, not a render crash or an unvalidated install', async () => {
    const state = toManifestState({ ok: true, content: MANIFEST })
    expect(state).toEqual({ status: 'error', error: 'This ADF runtime predates atomic skill installs; update it.' })
    expect(() => manifestName(state)).not.toThrow()
    expect(manifestName(state)).toBeNull()
    const result = await installFromCard({
      view: captureAgentView(), active: () => true, key: 'card', manifestUrl: 'https://raw.test/SKILL.md', files: [],
      fromPreview: true, cached: state, load: async () => toManifestState({ ok: true, content: MANIFEST }),
    }, (request) => prepareSkillInstall(request, refresh))
    expect(result).toEqual({ kind: 'done', outcome: { error: 'Could not read SKILL.md: This ADF runtime predates atomic skill installs; update it.' } })
    expect(local.writes).toBe(0)
  })
})

describe('an older daemon without the batch route', () => {
  it('its 404 is said as version skew, never as a generic refusal, and nothing is written another way', async () => {
    const api = runtimes.apis.get('local') as AdfApi
    const real = api.writeInternalFiles
    ;(api as { writeInternalFiles: AdfApi['writeInternalFiles'] }).writeInternalFiles = async () => ({ success: false, code: 'runtime_outdated', error: 'This ADF runtime predates atomic skill installs; update it.' })
    try {
      expect(await run(prepareSkillInstall(request(MANIFEST), refresh))).toEqual({ error: 'This ADF runtime predates atomic skill installs; update it.' })
    } finally {
      ;(api as { writeInternalFiles: AdfApi['writeInternalFiles'] }).writeInternalFiles = real
    }
    expect(A.ws.fileExists('skills/alpha/SKILL.md')).toBe(false)
  })
})

describe('closing the dialog cancels an install that has not written yet', () => {
  it('closed while a resource is being fetched: nothing is written', async () => {
    let open = true
    const api = runtimes.apis.get('local') as AdfApi
    const real = api.getSkillPackageBytes
    ;(api as { getSkillPackageBytes: AdfApi['getSkillPackageBytes'] }).getSkillPackageBytes = async (url) => { open = false; return real(url) }
    try {
      const ready: ManifestState = { status: 'ready', content: MANIFEST, import: importSkillManifest(MANIFEST, 'https://raw.test/SKILL.md', parseSkillFrontmatter) }
      const result = await installFromCard({
        view: captureAgentView(), active: () => open, key: 'card', manifestUrl: 'https://raw.test/SKILL.md',
        files: [{ path: 'ref.md', raw_url: 'https://raw.test/ref.md' }], fromPreview: false, cached: ready, load: async () => ready,
      }, (request) => prepareSkillInstall(request, refresh))
      expect(result).toEqual({ kind: 'done', outcome: { error: 'The open agent changed — nothing was written.' } })
    } finally {
      ;(api as { getSkillPackageBytes: AdfApi['getSkillPackageBytes'] }).getSkillPackageBytes = real
    }
    expect(local.writes).toBe(0)
  })
})
