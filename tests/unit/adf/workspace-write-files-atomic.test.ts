import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { AdfWorkspace, AtomicBatchError, type AtomicFileWrite } from '../../../src/main/adf/adf-workspace'
import { FILE_BATCH_MAX_BYTES, FILE_BATCH_MAX_FILES } from '../../../src/shared/utils/file-batch'
import { fileRevision } from '../../../src/main/runtime/resource-revisions'
import { readAdfCompat } from '../../../src/shared/utils/skill-import'

const settle = () => new Promise((resolve) => setTimeout(resolve, 500))
const text = (path: string, content: string, expect: AtomicFileWrite['expect'] = { mustNotExist: true }): AtomicFileWrite => ({ path, content: Buffer.from(content), expect })

describe('AdfWorkspace.writeFilesAtomic (real temp .adf)', () => {
  const dirs: string[] = []
  const open: AdfWorkspace[] = []
  afterEach(() => {
    for (const ws of open.splice(0)) { try { ws.close() } catch { /* closed */ } }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  function workspace(): AdfWorkspace {
    const dir = mkdtempSync(join(tmpdir(), 'adf-batch-'))
    dirs.push(dir)
    const ws = AdfWorkspace.create(join(dir, 'agent.adf'), { name: 'batch' })
    open.push(ws)
    return ws
  }
  /** Every change event, with what the DB held at the moment it fired. */
  function watch(ws: AdfWorkspace, paths: string[]) {
    const seen: Array<{ path: string; op: string; allPresent: boolean }> = []
    ws.setOnFileChangeCallback((change) => {
      seen.push({ path: change.path, op: change.operation, allPresent: paths.every((p) => ws.fileExists(p)) })
    })
    return seen
  }

  it('writes every file, then notifies; each notification already sees the complete package; the index lists it with its adf label', async () => {
    const ws = workspace()
    const manifest = '---\nname: alpha\ndescription: Does alpha.\nadf: ">=0.2"\n---\n\n# Alpha\n'
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x00, 0x10])
    const files: AtomicFileWrite[] = [
      text('skills/alpha/ref.md', '# ref'),
      { path: 'skills/alpha/assets/logo.png', content: png, expect: { mustNotExist: true } },
      text('skills/alpha/SKILL.md', manifest),
    ]
    const seen = watch(ws, files.map((f) => f.path))
    ws.writeFilesAtomic(files)
    expect(seen.map((e) => [e.path, e.op, e.allPresent])).toEqual([
      ['skills/alpha/ref.md', 'created', true],
      ['skills/alpha/assets/logo.png', 'created', true],
      ['skills/alpha/SKILL.md', 'created', true],
    ])
    expect(ws.readFileBuffer('skills/alpha/assets/logo.png')!.equals(png)).toBe(true)
    await settle()
    const registry = JSON.parse(ws.readFile('skills-registry.json')!)
    expect(registry.skills.alpha).toMatchObject({ name: 'alpha', description: 'Does alpha.', enabled: true })
    expect(readAdfCompat(ws.readFile('skills/alpha/SKILL.md'))).toEqual({ native: true, range: '>=0.2' })
  })

  it('a path that exists refuses a create: nothing written, nothing notified', () => {
    const ws = workspace()
    ws.writeFile('skills/alpha/SKILL.md', 'old manifest')
    const seen = watch(ws, [])
    let error: unknown
    try {
      ws.writeFilesAtomic([text('skills/alpha/new.md', 'n'), text('skills/alpha/SKILL.md', 'new')])
    } catch (err) { error = err }
    expect(error).toBeInstanceOf(AtomicBatchError)
    expect((error as AtomicBatchError).code).toBe('stale_revision')
    expect((error as AtomicBatchError).path).toBe('skills/alpha/SKILL.md')
    expect(ws.fileExists('skills/alpha/new.md')).toBe(false)
    expect(ws.readFile('skills/alpha/SKILL.md')).toBe('old manifest')
    expect(seen).toEqual([])
  })

  it('reinstall over the revisions read: replaces only the listed files, keeps extra files and protections', () => {
    const ws = workspace()
    ws.writeFile('skills/alpha/SKILL.md', 'v1')
    ws.writeFile('skills/alpha/ref.md', 'r1')
    ws.writeFile('skills/alpha/notes-by-agent.md', 'mine')
    ws.setFileProtection('skills/alpha/ref.md', 'no_delete')
    const manifestRev = fileRevision(ws, 'skills/alpha/SKILL.md').revision
    const refRev = fileRevision(ws, 'skills/alpha/ref.md').revision
    ws.writeFilesAtomic([
      text('skills/alpha/ref.md', 'r2', { baseRevision: refRev }),
      text('skills/alpha/new.md', 'n'),
      text('skills/alpha/SKILL.md', 'v2', { baseRevision: manifestRev }),
    ])
    expect(ws.readFile('skills/alpha/SKILL.md')).toBe('v2')
    expect(ws.readFile('skills/alpha/ref.md')).toBe('r2')
    expect(ws.getFileProtection('skills/alpha/ref.md')).toBe('no_delete')
    expect(ws.readFile('skills/alpha/notes-by-agent.md')).toBe('mine')
  })

  it('a file changed after it was read refuses the whole batch; the old package stays byte-identical', () => {
    const ws = workspace()
    ws.writeFile('skills/alpha/SKILL.md', 'v1')
    ws.writeFile('skills/alpha/ref.md', 'r1')
    const manifestRev = fileRevision(ws, 'skills/alpha/SKILL.md').revision
    const refRev = fileRevision(ws, 'skills/alpha/ref.md').revision
    ws.writeFile('skills/alpha/ref.md', 'edited meanwhile')
    const seen = watch(ws, [])
    expect(() => ws.writeFilesAtomic([
      text('skills/alpha/ref.md', 'r2', { baseRevision: refRev }),
      text('skills/alpha/SKILL.md', 'v2', { baseRevision: manifestRev }),
    ])).toThrow(/changed/)
    expect(ws.readFile('skills/alpha/SKILL.md')).toBe('v1')
    expect(ws.readFile('skills/alpha/ref.md')).toBe('edited meanwhile')
    expect(seen).toEqual([])
  })

  it('a file deleted after it was read refuses a baseRevision update', () => {
    const ws = workspace()
    ws.writeFile('skills/alpha/ref.md', 'r1')
    const rev = fileRevision(ws, 'skills/alpha/ref.md').revision
    ws.deleteFile('skills/alpha/ref.md')
    expect(() => ws.writeFilesAtomic([text('skills/alpha/ref.md', 'r2', { baseRevision: rev })])).toThrow(AtomicBatchError)
    expect(ws.fileExists('skills/alpha/ref.md')).toBe(false)
  })

  it('a read-only file refuses the entire batch', () => {
    const ws = workspace()
    ws.writeFile('skills/alpha/ref.md', 'locked')
    ws.setFileProtection('skills/alpha/ref.md', 'read_only')
    const rev = fileRevision(ws, 'skills/alpha/ref.md').revision
    let error: unknown
    try {
      ws.writeFilesAtomic([text('skills/alpha/other.md', 'x'), text('skills/alpha/ref.md', 'new', { baseRevision: rev })])
    } catch (err) { error = err }
    expect((error as AtomicBatchError).code).toBe('protected')
    expect(ws.fileExists('skills/alpha/other.md')).toBe(false)
    expect(ws.readFile('skills/alpha/ref.md')).toBe('locked')
  })

  it('a throw in the middle of the writes rolls every row back and emits nothing', () => {
    const ws = workspace()
    ws.writeFile('skills/alpha/SKILL.md', 'v1')
    const rev = fileRevision(ws, 'skills/alpha/SKILL.md').revision
    const db = ws.getDatabase()
    const real = db.writeFile.bind(db)
    let calls = 0
    db.writeFile = ((...args: Parameters<typeof real>) => {
      if (++calls === 2) throw new Error('disk full')
      return real(...args)
    }) as typeof db.writeFile
    const seen = watch(ws, [])
    expect(() => ws.writeFilesAtomic([
      text('skills/alpha/a.md', 'a'),
      text('skills/alpha/b.md', 'b'),
      text('skills/alpha/SKILL.md', 'v2', { baseRevision: rev }),
    ])).toThrow('disk full')
    db.writeFile = real
    expect(ws.fileExists('skills/alpha/a.md')).toBe(false)
    expect(ws.fileExists('skills/alpha/b.md')).toBe(false)
    expect(ws.readFile('skills/alpha/SKILL.md')).toBe('v1')
    expect(seen).toEqual([])
  })

  it('a change listener that throws after the commit does not undo it, does not silence the next file, and the index still lists the package', async () => {
    const ws = workspace()
    const heard: string[] = []
    ws.setOnFileChangeCallback((change) => { heard.push(change.path); throw new Error('listener broke') })
    const manifest = '---\nname: alpha\ndescription: Does alpha.\n---\n'
    expect(() => ws.writeFilesAtomic([text('skills/alpha/a.md', 'a'), text('skills/alpha/SKILL.md', manifest)])).not.toThrow()
    expect(heard).toEqual(['skills/alpha/a.md', 'skills/alpha/SKILL.md'])
    expect(ws.readFile('skills/alpha/a.md')).toBe('a')
    await settle()
    expect(JSON.parse(ws.readFile('skills-registry.json')!).skills.alpha).toMatchObject({ name: 'alpha' })
  })

  it('refuses malformed batches before reading or writing anything', () => {
    const ws = workspace()
    const before = ws.listFiles().map((f) => f.path).sort()
    const refused = (files: AtomicFileWrite[]) => {
      try { ws.writeFilesAtomic(files) } catch (err) { return err instanceof AtomicBatchError ? err.code : String(err) }
      return 'written'
    }
    expect(refused([])).toBe('invalid_request')
    expect(refused([text('a/../b.md', 'x')])).toBe('invalid_request')
    expect(refused([text('/abs.md', 'x')])).toBe('invalid_request')
    expect(refused([text('a\\b.md', 'x')])).toBe('invalid_request')
    expect(refused([text('a//b.md', 'x')])).toBe('invalid_request')
    expect(refused([text('skills-registry.json', 'x')])).toBe('invalid_request')
    expect(refused([text('dup.md', 'x'), text('dup.md', 'y')])).toBe('invalid_request')
    expect(refused([{ path: 'none.md', content: Buffer.from('x'), expect: {} as AtomicFileWrite['expect'] }])).toBe('invalid_request')
    expect(refused([{ path: 'both.md', content: Buffer.from('x'), expect: { mustNotExist: true, baseRevision: 1 } as unknown as AtomicFileWrite['expect'] }])).toBe('invalid_request')
    expect(refused(Array.from({ length: FILE_BATCH_MAX_FILES + 1 }, (_, i) => text(`f/${i}.md`, 'x')))).toBe('payload_too_large')
    expect(refused([{ path: 'big.bin', content: Buffer.alloc(FILE_BATCH_MAX_BYTES + 1), expect: { mustNotExist: true } }])).toBe('payload_too_large')
    expect(ws.listFiles().map((f) => f.path).sort()).toEqual(before)
    // Exactly at the bounds is accepted.
    expect(refused(Array.from({ length: FILE_BATCH_MAX_FILES }, (_, i) => text(`g/${i}.md`, 'x')))).toBe('written')
    expect(refused([{ path: 'exact.bin', content: Buffer.alloc(FILE_BATCH_MAX_BYTES), expect: { mustNotExist: true } }])).toBe('written')
  })
})
