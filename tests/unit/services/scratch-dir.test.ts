import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Mock electron's app.getPath before importing the module
const MOCK_TEMP = join(tmpdir(), `adf-scratch-test-${process.pid}`)
const ORIGINAL_ADF_TEMP_DIR = process.env.ADF_TEMP_DIR
process.env.ADF_TEMP_DIR = MOCK_TEMP

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'temp') return MOCK_TEMP
      throw new Error(`Unexpected getPath call: ${name}`)
    }
  }
}))

import {
  scratchRootPath,
  scratchDirForAgent,
  createScratchDir,
  removeScratchDir,
  purgeAllScratchDirs,
  purgeStaleProcessDirs
} from '../../../src/main/utils/scratch-dir'

describe('scratch-dir', () => {
  beforeEach(() => {
    mkdirSync(MOCK_TEMP, { recursive: true })
  })

  afterEach(() => {
    rmSync(MOCK_TEMP, { recursive: true, force: true })
  })

  afterAll(() => {
    if (ORIGINAL_ADF_TEMP_DIR === undefined) delete process.env.ADF_TEMP_DIR
    else process.env.ADF_TEMP_DIR = ORIGINAL_ADF_TEMP_DIR
  })

  describe('scratchRootPath', () => {
    it('returns temp/adf-scratch-{pid}', () => {
      expect(scratchRootPath()).toBe(join(MOCK_TEMP, `adf-scratch-${process.pid}`))
    })
  })

  describe('scratchDirForAgent', () => {
    it('uses basename without .adf extension plus hash', () => {
      const dir = scratchDirForAgent('/path/to/my-agent.adf')
      expect(dir).toMatch(/adf-scratch-\d+[\\/]my-agent-[0-9a-f]{6}$/)
    })

    it('produces stable output for the same path', () => {
      const a = scratchDirForAgent('/some/path.adf')
      const b = scratchDirForAgent('/some/path.adf')
      expect(a).toBe(b)
    })

    it('disambiguates same basename in different directories', () => {
      const a = scratchDirForAgent('/dir1/agent.adf')
      const b = scratchDirForAgent('/dir2/agent.adf')
      expect(a).not.toBe(b)
      // Both start with agent- but have different hashes
      expect(a).toContain('agent-')
      expect(b).toContain('agent-')
    })
  })

  describe('createScratchDir', () => {
    it('creates the directory on disk and returns its path', () => {
      const dir = createScratchDir('/path/to/test.adf')
      expect(existsSync(dir)).toBe(true)
    })

    it('is idempotent — calling twice does not throw', () => {
      const dir1 = createScratchDir('/path/to/test.adf')
      const dir2 = createScratchDir('/path/to/test.adf')
      expect(dir1).toBe(dir2)
      expect(existsSync(dir1)).toBe(true)
    })
  })

  describe('removeScratchDir', () => {
    it('deletes the directory and its contents', () => {
      const dir = createScratchDir('/path/to/rm-test.adf')
      writeFileSync(join(dir, 'screenshot.png'), 'fake-image-data')
      expect(existsSync(dir)).toBe(true)

      removeScratchDir(dir)
      expect(existsSync(dir)).toBe(false)
    })

    it('is a no-op for null', () => {
      removeScratchDir(null)
    })

    it('is a no-op for a non-existent path', () => {
      removeScratchDir('/nonexistent/path/that/does/not/exist')
    })
  })

  describe('purgeAllScratchDirs', () => {
    it('removes the entire scratch tree for the current process', () => {
      const dir1 = createScratchDir('/path/to/agent1.adf')
      const dir2 = createScratchDir('/path/to/agent2.adf')
      writeFileSync(join(dir1, 'file1.txt'), 'data')
      writeFileSync(join(dir2, 'file2.txt'), 'data')

      purgeAllScratchDirs()

      expect(existsSync(dir1)).toBe(false)
      expect(existsSync(dir2)).toBe(false)
      expect(existsSync(scratchRootPath())).toBe(false)
    })

    it('is a no-op when scratch root does not exist', () => {
      rmSync(scratchRootPath(), { recursive: true, force: true })
      purgeAllScratchDirs()
    })
  })

  describe('purgeStaleProcessDirs', () => {
    it('removes dirs for dead PIDs and leaves current process dir alone', () => {
      // Create a dir for the current (live) process — should survive
      const liveDir = scratchRootPath()
      mkdirSync(liveDir, { recursive: true })
      writeFileSync(join(liveDir, 'live.txt'), 'data')

      // Create a dir for a PID that almost certainly doesn't exist
      const deadDir = join(MOCK_TEMP, 'adf-scratch-999999999')
      mkdirSync(deadDir, { recursive: true })
      writeFileSync(join(deadDir, 'stale.txt'), 'data')

      purgeStaleProcessDirs()

      // Current process dir untouched
      expect(existsSync(liveDir)).toBe(true)
      // Dead PID dir removed
      expect(existsSync(deadDir)).toBe(false)
    })

    it('ignores non-scratch entries in temp dir', () => {
      // Create something that looks like it could be confused
      const unrelatedDir = join(MOCK_TEMP, 'adf-instance-test')
      mkdirSync(unrelatedDir, { recursive: true })

      purgeStaleProcessDirs()

      expect(existsSync(unrelatedDir)).toBe(true)
    })
  })
})
