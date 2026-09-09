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
      // The old runtime is deliberately not presented as usable after partial cleanup.
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

  it('reports partial cleanup failure without deleting the valid candidate file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-file-create-cleanup-failure-'))
    dirs.push(dir)
    const oldPath = join(dir, 'old.adf')
    const candidatePath = join(dir, 'candidate.adf')
    const oldWorkspace = AdfWorkspace.create(oldPath, { name: 'old-agent' })
    const mainState: {
      currentWorkspace: AdfWorkspace | null
      currentFilePath: string | null
      currentHostAttachment: object | null
      currentAgentExecutor: object | null
    } = {
      currentWorkspace: oldWorkspace,
      currentFilePath: oldPath,
      currentHostAttachment: {},
      currentAgentExecutor: {},
    }
    let rendererFilePath = oldPath
    const recentFiles = [oldPath]
    const recoverAfterCleanupFailure = vi.fn(() => {
      // Model the production detached/no-file recovery callback.
      mainState.currentWorkspace = null
      mainState.currentFilePath = null
      rendererFilePath = ''
      return {
        foregroundDetached: true,
        retainedByBackground: false,
        workspaceCloseAttempted: true,
        workspaceCloseFailed: false,
        meshUnregistered: true,
      }
    })
    const handler = makeFileCreateHandler<AdfWorkspace>({
      showSaveDialog: async () => ({ canceled: false, filePath: candidatePath }),
      buildCreateOptions: (name) => ({ name }),
      createWorkspace: (filePath, options) => AdfWorkspace.create(filePath, options),
      closeWorkspace: (workspace) => workspace.close(),
      prepareWorkspace: () => {},
      // Model cleanupCurrentFile's no-transition partial failure: it detaches
      // runtime ownership before an awaited dispose rejects, but its final
      // currentWorkspace/currentFilePath nulling has not run yet.
      cleanupCurrentFile: async () => {
        mainState.currentHostAttachment = null
        mainState.currentAgentExecutor = null
        throw new Error('old assembled agent dispose failed')
      },
      recoverAfterCleanupFailure,
      installWorkspace: (workspace, filePath) => {
        mainState.currentWorkspace = workspace
        mainState.currentFilePath = filePath
        rendererFilePath = filePath
      },
      onInstalled: (_, filePath) => {
        recentFiles.unshift(filePath)
      },
    })

    try {
      const result = await handler(undefined, { name: 'candidate' })

      expect(result).toEqual({
        success: false,
        foregroundDetached: true,
        filePath: candidatePath,
        error: `old assembled agent dispose failed\n\nThe foreground was detached and no file is open. The newly created file was preserved at:\n${candidatePath}`,
      })
      expect(recoverAfterCleanupFailure).toHaveBeenCalledTimes(1)
      expect(mainState.currentWorkspace).toBeNull()
      expect(mainState.currentFilePath).toBeNull()
      expect(mainState.currentHostAttachment).toBeNull()
      expect(mainState.currentAgentExecutor).toBeNull()
      expect(rendererFilePath).toBe('')
      expect(recentFiles).toEqual([oldPath])
      // Successful candidate creation is closed to release SQLite, not deleted.
      // The valid file remains available for recovery/manual open.
      expect(existsSync(candidatePath)).toBe(true)
      const candidateDb = AdfDatabase.open(candidatePath)
      try {
        expect(candidateDb.getConfig().name).toBe('candidate')
      } finally {
        candidateDb.close()
      }
      expect(oldWorkspace.getAgentConfig().name).toBe('old-agent')
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
