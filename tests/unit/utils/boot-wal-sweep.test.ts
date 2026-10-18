import { describe, expect, it } from 'vitest'
import { join, resolve } from 'path'
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

})

// E3 (W5-D3): a remote daemon's paths could reach `recentFiles` (a switch
// from remote to embedded moved them into adf-settings.json), and a readdir
// on \\host\share sends the user's NTLM credentials to that host.
describe('recentFileSweepDirs skips network and device paths', () => {
  it('never lists a UNC, \\\\?\\ or \\\\.\\ path, or a relative one, and says so', () => {
    const warnings: string[] = []
    const log = { warn: (m: string) => { warnings.push(m) } }
    const local = join(dirA, 'agent-1.adf')
    const unsafe = ['\\\\evil\\share\\agent-1.adf', '//evil/share/agent-2.adf', '\\\\?\\UNC\\evil\\share\\agent-3.adf', '\\\\.\\pipe\\agent-4.adf', 'relative/agent-5.adf']
    expect(recentFileSweepDirs([...unsafe, local], log)).toEqual([resolve(dirA)])
    expect(warnings).toHaveLength(unsafe.length)
    expect(warnings[0]).toMatch(/WAL sweep skips the recent file .*evil.*network or device path/)
  })
})
