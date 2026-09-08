import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AdfDatabase } from '../../../src/main/adf/adf-database'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { makeFileCreateHandler } from '../../../src/main/ipc/file-create-handler'

describe('FILE_CREATE transaction boundary', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('keeps the existing foreground workspace usable and does not record a collision', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-file-create-ipc-'))
    dirs.push(dir)
    const oldPath = join(dir, 'old.adf')
    const collisionPath = join(dir, 'same-name.adf')
    const oldWorkspace = AdfWorkspace.create(oldPath, { name: 'old-agent' })
    AdfDatabase.create(collisionPath, { name: 'original-agent' }).close()
    const originalBytes = readFileSync(collisionPath)
    const wal = Buffer.from('original-wal')
    const shm = Buffer.from('original-shm')
    writeFileSync(`${collisionPath}-wal`, wal)
    writeFileSync(`${collisionPath}-shm`, shm)

    const recentFiles = [oldPath]
    const cleanupCurrentFile = vi.fn(async () => {
      throw new Error('must not close old workspace after candidate collision')
    })
    const installWorkspace = vi.fn()
    const onInstalled = vi.fn((_, filePath: string) => recentFiles.unshift(filePath))
    const handler = makeFileCreateHandler<AdfWorkspace>({
      showSaveDialog: async () => ({ canceled: false, filePath: collisionPath }),
      buildCreateOptions: (name) => ({ name }),
      createWorkspace: (filePath, options) => AdfWorkspace.create(filePath, options),
      closeWorkspace: (workspace) => workspace.close(),
      cleanupCurrentFile,
      prepareWorkspace: () => {},
      installWorkspace,
      onInstalled,
    })

    try {
      const result = await handler(undefined, { name: 'same-name' })

      expect(result).toEqual({
        success: false,
        error: `ADF file already exists: ${collisionPath}`,
      })
      expect(cleanupCurrentFile).not.toHaveBeenCalled()
      expect(installWorkspace).not.toHaveBeenCalled()
      expect(onInstalled).not.toHaveBeenCalled()
      expect(recentFiles).toEqual([oldPath])
      // The old foreground is still a live, readable workspace after failure.
      expect(oldWorkspace.getAgentConfig().name).toBe('old-agent')
      expect(oldWorkspace.readFile('README.md')?.toString()).toContain('old-agent')
      expect(readFileSync(collisionPath)).toEqual(originalBytes)
      expect(readFileSync(`${collisionPath}-wal`)).toEqual(wal)
      expect(readFileSync(`${collisionPath}-shm`)).toEqual(shm)
      expect(existsSync(collisionPath)).toBe(true)
    } finally {
      oldWorkspace.close()
    }
  }, 30_000)

  it('keeps the old foreground when candidate callback preparation fails', async () => {
    const candidate = { closed: false }
    const oldWorkspace = { usable: true }
    const cleanupCurrentFile = vi.fn(async () => { oldWorkspace.usable = false })
    const installWorkspace = vi.fn()
    const onInstalled = vi.fn()
    const closeWorkspace = vi.fn((workspace: typeof candidate) => { workspace.closed = true })
    const handler = makeFileCreateHandler<typeof candidate>({
      showSaveDialog: async () => ({ canceled: false, filePath: '/tmp/preparation-fails.adf' }),
      buildCreateOptions: (name) => ({ name }),
      createWorkspace: () => candidate,
      closeWorkspace,
      cleanupCurrentFile,
      prepareWorkspace: () => { throw new Error('callback attachment failed') },
      installWorkspace,
      onInstalled,
    })

    const result = await handler(undefined, { name: 'preparation-fails' })
    expect(result).toEqual({ success: false, error: 'callback attachment failed' })
    expect(oldWorkspace.usable).toBe(true)
    expect(cleanupCurrentFile).not.toHaveBeenCalled()
    expect(installWorkspace).not.toHaveBeenCalled()
    expect(onInstalled).not.toHaveBeenCalled()
    expect(closeWorkspace).toHaveBeenCalledWith(candidate)
    expect(candidate.closed).toBe(true)
  })

  it('commits installation before bookkeeping errors and keeps the candidate live', async () => {
    const candidate = { closed: false }
    const installed: unknown[] = []
    const postInstallErrors: unknown[] = []
    const handler = makeFileCreateHandler<typeof candidate>({
      showSaveDialog: async () => ({ canceled: false, filePath: '/tmp/new-agent.adf' }),
      buildCreateOptions: (name) => ({ name }),
      createWorkspace: () => candidate,
      closeWorkspace: (workspace) => { workspace.closed = true },
      cleanupCurrentFile: async () => {},
      prepareWorkspace: () => {},
      installWorkspace: (workspace) => { installed.push(workspace) },
      onInstalled: () => { throw new Error('recent-file settings unavailable') },
      onPostInstallError: (error) => { postInstallErrors.push(error) },
    })

    const result = await handler(undefined, { name: 'new-agent' })
    expect(result).toEqual({ success: true, filePath: '/tmp/new-agent.adf' })
    expect(installed).toEqual([candidate])
    expect(candidate.closed).toBe(false)
    expect(postInstallErrors).toHaveLength(1)
  })
})
