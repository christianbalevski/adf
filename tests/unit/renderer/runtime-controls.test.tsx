/**
 * The runtime's on/off controls: Kill in the status bar (its tooltip names
 * the runtime, and it says what it stopped), the one Mesh switch with
 * Autostart in Settings → Networking, and the container "Rebuild
 * available" badge (a destructive rebuild, not an update). Static checks.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { killResultLabel, killTooltip } from '../../../src/renderer/components/layout/StatusBar'
import { OUTDATED_CONTAINER_ADVISORY, setupLogTone } from '../../../src/renderer/components/settings/SettingsPage'
import { MESH_EFFECT, MESH_OFF_NOTE, NETWORK_EFFECT } from '../../../src/renderer/components/settings/NetworkingSettings'
import type { ConnectionCurrent } from '../../../src/shared/types/connection.types'

const current = (over: Partial<ConnectionCurrent> = {}): ConnectionCurrent => ({ id: 'local', kind: 'local', name: 'host-0 (Local)', url: null, state: 'connected', ...over })
const settingsPage = () => readFileSync(join(__dirname, '../../../src/renderer/components/settings/SettingsPage.tsx'), 'utf-8')
// Settings → Networking's controls live in NetworkingSettings.tsx.
const networkingPage = () => readFileSync(join(__dirname, '../../../src/renderer/components/settings/NetworkingSettings.tsx'), 'utf-8')

describe('Kill', () => {
  it('the tooltip names the runtime only once a remote connection is saved', () => {
    expect(killTooltip(current(), false)).toBe('Stops all agents and mesh')
    expect(killTooltip(null, false)).toBe('Stops all agents and mesh')
    expect(killTooltip(current(), true)).toBe('Stops all agents and mesh on host-0 (Local)')
    expect(killTooltip(current({ id: 'remote:box-1', kind: 'remote', name: 'box-1' }), true)).toBe('Stops all agents and mesh on box-1')
    expect(killTooltip(null, true)).toBe('Stops all agents and mesh on Local')
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
  it('one switch for the live state and an Autostart switch; no separate Disable or server Stop/Start', () => {
    const page = networkingPage()
    expect(page).toContain('<Switch label="Mesh"')
    expect(page).toContain('<Switch label="Autostart"')
    expect(page).not.toContain("{meshAutoStart ? 'Disable' : 'Enable'}")
    expect(page).not.toContain("{meshServerStatus.running ? 'Stop' : 'Start'}")
  })

  it('one effect sentence per switch; what off interrupts is the tooltip', () => {
    expect(MESH_OFF_NOTE.split(/[.!]\s/)).toHaveLength(1)
    expect(MESH_OFF_NOTE).toMatch(/agent messages/)
    expect(MESH_EFFECT).toBe('Agents on this server send messages to each other.')
    expect(NETWORK_EFFECT).toBe('Other computers on allowed networks can reach the agents that you share.')
    for (const s of [MESH_EFFECT, NETWORK_EFFECT]) expect(s.split(/[.!]\s/)).toHaveLength(1)
    expect(networkingPage()).toContain('description={MESH_EFFECT}')
    expect(networkingPage()).toContain('description={NETWORK_EFFECT}')
    expect(networkingPage()).toContain('<InfoHint tip={MESH_OFF_NOTE} />')
  })

  it('the LAN addresses hint no longer points "below" to a toggle above it', () => {
    expect(settingsPage()).not.toContain('Allow LAN access" below')
    expect(networkingPage()).not.toContain('Allow LAN access" below')
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
