import { describe, expect, it } from 'vitest'
import { dirname, join, resolve } from 'path'
import { tmpdir } from 'os'
import { recentFileSweepDirs } from '../../../src/main/utils/boot-wal-sweep'

// Embedded Studio's boot WAL sweep visits the directories of last session's
// recent files (ipc/index.ts scheduleBootWalSweep). Characterization of the
// extraction (E1): one entry per directory, in order, non-strings ignored.

const dirA = join(tmpdir(), 'adf-sweep-a')
const dirB = join(tmpdir(), 'adf-sweep-b')

describe('recentFileSweepDirs (characterization)', () => {
  it('lists each recent file\'s directory once, in order', () => {
    expect(recentFileSweepDirs([join(dirA, 'agent-1.adf'), join(dirB, 'agent-2.adf'), join(dirA, 'agent-3.adf')]))
      .toEqual([resolve(dirA), resolve(dirB)])
  })

  it('ignores a missing or malformed setting and non-string entries', () => {
    expect(recentFileSweepDirs(undefined)).toEqual([])
    expect(recentFileSweepDirs('not-a-list')).toEqual([])
    expect(recentFileSweepDirs([42, null, '', join(dirA, 'agent-1.adf')])).toEqual([resolve(dirA)])
  })

  it.runIf(process.platform === 'win32')('keeps a network path (UNC) as it is today', () => {
    expect(recentFileSweepDirs(['\\\\evil\\share\\agent-1.adf'])).toEqual([resolve(dirname('\\\\evil\\share\\agent-1.adf'))])
  })
})
