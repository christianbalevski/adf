/**
 * The runtime's on/off controls: Kill in the status bar (its tooltip names
 * the runtime, and it says what it stopped), the one Mesh switch with "Start
 * with the runtime" in Settings → Networking, and the container "Rebuild
 * available" badge (a destructive rebuild, not an update). Static checks.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { killResultLabel, killTooltip } from '../../../src/renderer/components/layout/StatusBar'
import { MESH_OFF_NOTE, OUTDATED_CONTAINER_ADVISORY, setupLogTone } from '../../../src/renderer/components/settings/SettingsPage'
import type { ConnectionCurrent } from '../../../src/shared/types/connection.types'

const current = (over: Partial<ConnectionCurrent> = {}): ConnectionCurrent => ({ id: 'local', kind: 'local', name: 'This computer', url: null, state: 'connected', ...over })
const settingsPage = () => readFileSync(join(__dirname, '../../../src/renderer/components/settings/SettingsPage.tsx'), 'utf-8')

describe('Kill', () => {
  it('the tooltip names the runtime the indicator shows', () => {
    expect(killTooltip(current())).toBe('Stops all agents and mesh on This computer')
    expect(killTooltip(current({ id: 'remote:rawl-hub', kind: 'remote', name: 'rawl-hub' }))).toBe('Stops all agents and mesh on rawl-hub')
    expect(killTooltip(null)).toBe('Stops all agents and mesh on This computer')
  })

  it('says what it stopped, so the stop is never silent', () => {
    expect(killResultLabel({ success: true, stoppedAgents: 3 })).toBe('Stopped 3 agents · Mesh off')
    expect(killResultLabel({ success: true, stoppedAgents: 1 })).toBe('Stopped 1 agent · Mesh off')
    expect(killResultLabel({ success: true, stoppedAgents: 0 })).toBe('Stopped 0 agents · Mesh off')
    // An older runtime does not count: still a visible line.
    expect(killResultLabel({ success: true })).toBe('Stopped all agents · Mesh off')
    // A partial stop: main also shows a warning dialog with what is left running.
    expect(killResultLabel({ success: false, stoppedAgents: 1 })).toBe('Partial stop')
  })
})

describe('the Mesh controls', () => {
  it('one switch for the live state and a Start with the runtime checkbox; no separate Disable or server Stop/Start', () => {
    const page = settingsPage()
    expect(page).toContain('aria-label="Mesh"')
    expect(page).toContain('label="Start with the runtime"')
    expect(page).not.toContain("{meshAutoStart ? 'Disable' : 'Enable'}")
    expect(page).not.toContain("{meshServerStatus.running ? 'Stop' : 'Start'}")
  })

  it('one description sentence and one note on what off interrupts', () => {
    expect(MESH_OFF_NOTE.split(/[.!]\s/)).toHaveLength(1)
    expect(MESH_OFF_NOTE).toMatch(/messaging/)
    expect(settingsPage()).toContain('description="Agents on this runtime message each other and peer runtimes, and serve their cards and APIs."')
  })

  it('the LAN addresses hint no longer points "below" to a toggle above it', () => {
    expect(settingsPage()).not.toContain('Allow LAN access" below')
  })
})

describe('the container rebuild badge', () => {
  it('reads Rebuild available, neutral, and names what a rebuild erases', () => {
    const page = settingsPage()
    expect(page).not.toContain('Update available')
    expect(page).toContain('Rebuild available')
    expect(OUTDATED_CONTAINER_ADVISORY).toMatch(/erases this container's workspace files, installed packages and saved browser session/)
  })

  it('a finished container or setup step shows in the success color; progress stays muted', () => {
    expect(setupLogTone('Container rebuilt.')).toBe('text-[var(--adf-ui-success)]')
    expect(setupLogTone('Install completed')).toBe('text-[var(--adf-ui-success)]')
    expect(setupLogTone('Rebuilding adf-agent-1...')).toBe('text-[var(--adf-ui-text-muted)]')
  })
})
