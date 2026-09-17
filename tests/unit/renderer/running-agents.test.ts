import { describe, it, expect } from 'vitest'
import { collectRunningAgents } from '../../../src/renderer/utils/running-agents'
import type { TrackedDirEntry } from '../../../src/shared/types/ipc.types'

const file = (filePath: string, agentName?: string): TrackedDirEntry => ({
  filePath,
  fileName: filePath.split('/').pop()!,
  agentName
})
const dir = (filePath: string, children: TrackedDirEntry[]): TrackedDirEntry => ({
  filePath,
  fileName: filePath.split('/').pop()!,
  isDirectory: true,
  children
})

describe('collectRunningAgents', () => {
  const directories = ['/w/b-root', '/w/a-root']
  const filesByDir = {
    '/w/b-root': [
      file('/w/b-root/zed.adf', 'zed'),
      dir('/w/b-root/team', [
        file('/w/b-root/team/researcher.adf', 'researcher'),
        dir('/w/b-root/team/deep', [file('/w/b-root/team/deep/alpha.adf', 'alpha')])
      ])
    ],
    '/w/a-root': [
      file('/w/a-root/researcher.adf', 'researcher'),
      file('/w/a-root/idle.adf', 'idle')
    ]
  }

  it('keeps only running agents, foreground included, and drops idle ones', () => {
    const rows = collectRunningAgents({
      directories,
      filesByDir,
      currentFilePath: '/w/a-root/idle.adf',
      foregroundRunning: false,
      isBackgroundRunning: (p) => p.endsWith('alpha.adf')
    })
    expect(rows.map((r) => r.file.filePath)).toEqual(['/w/b-root/team/deep/alpha.adf'])
  })

  it('counts the foreground agent when its state is not off', () => {
    const rows = collectRunningAgents({
      directories,
      filesByDir,
      currentFilePath: '/w/a-root/idle.adf',
      foregroundRunning: true,
      isBackgroundRunning: () => false
    })
    expect(rows.map((r) => r.file.filePath)).toEqual(['/w/a-root/idle.adf'])
    expect(rows[0].dirPath).toBe('/w/a-root')
  })

  it('orders by tracked root order, then by path, regardless of discovery order', () => {
    const rows = collectRunningAgents({
      directories,
      filesByDir,
      currentFilePath: null,
      foregroundRunning: false,
      isBackgroundRunning: () => true
    })
    expect(rows.map((r) => r.file.filePath)).toEqual([
      '/w/b-root/team/deep/alpha.adf',
      '/w/b-root/team/researcher.adf',
      '/w/b-root/zed.adf',
      '/w/a-root/idle.adf',
      '/w/a-root/researcher.adf'
    ])
  })

  it('adds a folder hint only to rows whose display name collides', () => {
    const rows = collectRunningAgents({
      directories,
      filesByDir,
      currentFilePath: null,
      foregroundRunning: false,
      isBackgroundRunning: () => true
    })
    const byPath = Object.fromEntries(rows.map((r) => [r.file.filePath, r.folderHint]))
    expect(byPath['/w/b-root/team/researcher.adf']).toBe('team')
    expect(byPath['/w/a-root/researcher.adf']).toBe('a-root')
    expect(byPath['/w/b-root/zed.adf']).toBeUndefined()
    expect(byPath['/w/b-root/team/deep/alpha.adf']).toBeUndefined()
  })

  it('returns nothing for an idle fleet', () => {
    expect(collectRunningAgents({
      directories,
      filesByDir,
      currentFilePath: null,
      foregroundRunning: false,
      isBackgroundRunning: () => false
    })).toEqual([])
  })
})
