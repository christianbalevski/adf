/**
 * Embedded Studio's Open Recent (7c564457, design §3.2): a network path in
 * recentFiles is dropped before any file-system call (Windows would send the
 * user's NTLM credentials to that host); local files that still exist stay.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./daemon-mode-electron')).electronStub.module)

import { electronStub } from './daemon-mode-electron'
import { initApplicationMenu } from '../../src/main/menu'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function openRecentLabels(): string[] {
  const last = [...electronStub.calls].reverse().find((c) => c.api === 'Menu.setApplicationMenu')
  const items = (last?.args[0] ?? []) as Array<{ label?: string; submenu?: Array<{ label?: string; type?: string; toolTip?: string; submenu?: Array<{ label?: string; type?: string; toolTip?: string }> }> }>
  const file = items.find((i) => i.label === 'File')
  const recent = file?.submenu?.find((i) => i.label === 'Open Recent')
  return (recent?.submenu ?? []).map((i) => i.toolTip ?? i.label ?? `<${i.type}>`)
}

describe('embedded Open Recent', () => {
  it('lists existing local files and hides UNC, \\\\?\\, \\\\.\\ and // paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-menu-recent-'))
    dirs.push(dir)
    const local = join(dir, 'agent-1.adf')
    writeFileSync(local, '')
    const recentFiles = [
      '\\\\fileserver\\share\\agent-2.adf',
      '\\\\?\\UNC\\fileserver\\share\\agent-2.adf',
      '\\\\.\\pipe\\agent-2.adf',
      '//fileserver/share/agent-2.adf',
      local,
      join(dir, 'gone.adf'),
    ]
    initApplicationMenu({ get: (key: string) => (key === 'recentFiles' ? recentFiles : undefined), set: () => {} })
    expect(openRecentLabels()).toEqual([local, '<separator>', 'Clear Menu'])
  })
})
