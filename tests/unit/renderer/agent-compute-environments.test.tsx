import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentComputeEnvironments, environmentStatus, withAllowedEnvironments } from '../../../src/renderer/components/agent/AgentComputeEnvironments'
import { DEFAULT_AGENT_CONFIG } from '../../../src/shared/constants/adf-defaults'
import type { ContainerSummary, PodmanAvailability } from '../../../src/shared/types/compute.types'

;(globalThis as { React?: typeof React }).React = React

const availability: PodmanAvailability = { available: true, machineRequired: true, machineRunning: true, machineExists: true, platform: 'darwin', installMethods: [], prerequisites: [] }
const shared: ContainerSummary = { id: 'shared-id', name: 'adf-mcp', scope: 'shared', managed: true, running: true, status: 'Up', state: 'running', image: 'test' }
const snapshot = { availability, containers: [shared], hostAllowed: false }

describe('Compute environment status', () => {
  it('shows runtime status and blockers independently of the permission checkbox', () => {
    expect(environmentStatus('shared', false, 'agent', snapshot)).toEqual({ text: 'Running' })
    expect(environmentStatus('shared', true, 'agent', snapshot)).toEqual({ text: 'Running' })
    expect(environmentStatus('host', true, 'agent', snapshot)).toMatchObject({ text: 'Blocked by runtime settings', action: 'host' })
    expect(environmentStatus('host', false, 'agent', snapshot)).toMatchObject({ text: 'Blocked by runtime settings', action: 'host' })
    expect(environmentStatus('host', true, 'agent', { ...snapshot, hostAllowed: true })).toEqual({ text: 'Available' })
    expect(environmentStatus('isolated', false, 'agent', snapshot, undefined, { enabled: false })).toMatchObject({ text: 'Not created' })
    expect(environmentStatus('host', true, 'agent', { ...snapshot, hostAllowed: true }, undefined, { enabled: true, host_access: false })).toMatchObject({ text: 'Disabled in agent config', action: 'agent' })
  })

  it('distinguishes unavailable Podman, a stopped VM, and a stopped container', () => {
    expect(environmentStatus('shared', true, 'agent', null).text).toBe('Status unavailable')
    expect(environmentStatus('shared', true, 'agent', { ...snapshot, availability: { ...availability, available: false } })).toMatchObject({ text: 'Podman unavailable', action: 'settings' })
    expect(environmentStatus('shared', true, 'agent', { ...snapshot, availability: { ...availability, machineRunning: false } })).toMatchObject({ text: 'Podman machine stopped', action: 'settings' })
    expect(environmentStatus('shared', true, 'agent', { ...snapshot, containers: [{ ...shared, running: false, state: 'exited' }] })).toMatchObject({ text: 'Stopped', action: 'start', container: 'adf-mcp' })
  })

  it('never starts another agent’s dedicated container or a registered external target', () => {
    const dedicated = { ...shared, scope: 'dedicated' as const, agentId: 'another-agent', name: 'other', running: false, state: 'stopped' }
    expect(environmentStatus('isolated', true, 'agent', { ...snapshot, containers: [dedicated] })).toMatchObject({ text: 'Not created', action: 'settings' })
    expect(environmentStatus('external-python', true, 'agent', snapshot)).toMatchObject({ text: 'User-managed', action: 'settings' })
  })

  it('shows provisioning and failure instead of treating a running container as ready', () => {
    expect(environmentStatus('shared', true, 'agent', snapshot, { containerName: 'adf-mcp', phase: 'provisioning', detail: 'Installing packages', timestamp: 1 })).toEqual({ text: 'Setting up', detail: 'Installing packages' })
    expect(environmentStatus('shared', true, 'agent', snapshot, { containerName: 'adf-mcp', phase: 'failed', detail: 'Image pull failed', timestamp: 2 })).toMatchObject({ text: 'Setup failed', detail: 'Image pull failed', action: 'settings' })
  })
})

describe('Existing compute form', () => {
  it('preserves existing compute options and chooses a permitted default when one is removed', () => {
    const original = { enabled: true, host_access: false, browser: false, packages: { pip: ['numpy'] }, allowed_targets: ['isolated', 'shared'], default_target: 'isolated' }
    expect(withAllowedEnvironments(original, ['shared', 'host'], 'isolated')).toEqual({ ...original, enabled: false, host_access: true, allowed_targets: ['shared', 'host'], default_target: 'shared' })
    expect(original.default_target).toBe('isolated')
    expect(withAllowedEnvironments({ enabled: false, target: 'external-python' }, ['external-python', 'host'], 'external-python')).toEqual({ enabled: false, host_access: true, allowed_targets: ['external-python', 'host'], default_target: 'external-python' })
  })

  it.each([false, true])('shows Advanced only for registered external containers (registered: %s)', (registered) => {
    const targets = registered ? [{ id: 'python', name: 'Python', kind: 'local-container' as const, engine: 'docker' as const, containerRef: 'python-tools', workdir: '/workspace' }] : []
    const html = renderToStaticMarkup(<AgentComputeEnvironments config={DEFAULT_AGENT_CONFIG} targets={targets} machine="Home server" template onChange={() => {}} onHostPermission={() => {}} onEnableCommands={() => {}} onSettings={() => {}} />)
    if (registered) {
      expect(html.indexOf('Host machine')).toBeLessThan(html.indexOf('<details'))
      expect(html).toContain('Advanced · External containers')
    } else {
      expect(html).not.toContain('<details')
      expect(html).not.toContain('Advanced · External containers')
    }
    expect(html).toContain('Direct access to Home server')
    expect(html).toContain('Default environment')
    expect(html).not.toContain('Refresh status')
    expect(html).not.toContain('Status unavailable')
    expect(html).not.toContain('Restart a running agent')
  })
})
