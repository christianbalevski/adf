/**
 * The former hand-built Settings pages (Identity, Packages, Networking,
 * Compute) use SettingsGroup and SettingsRow, sentence case, one Switch for
 * every on/off setting, and no text under 11px. Static source checks plus the
 * Switch's markup.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Switch } from '../../../src/renderer/components/ui/Switch'

// Vitest compiles JSX with the classic runtime (the renderer build uses the automatic one).
;(globalThis as { React?: typeof React }).React = React

const read = (file: string) => readFileSync(join(__dirname, '../../../src/renderer/components/settings', file), 'utf-8')

describe('the Switch', () => {
  it('a switch role with its state, named by the row', () => {
    const on = renderToStaticMarkup(<Switch label="Mesh" checked onChange={() => {}} />)
    expect(on).toContain('role="switch"')
    expect(on).toContain('aria-checked="true"')
    expect(on).toContain('aria-label="Mesh"')
    expect(on).toContain('>On<')
    expect(renderToStaticMarkup(<Switch label="Mesh" checked={false} onChange={() => {}} />)).toContain('>Off<')
  })
})

describe('the Settings pages', () => {
  const files = ['SettingsPage.tsx', 'ConnectionSettings.tsx', 'RemoteAccessSettings.tsx', 'AgentTemplatesTab.tsx', 'ContainerDestroyDialog.tsx']

  it('no text under 11px', () => {
    for (const file of files) expect(read(file), file).not.toMatch(/text-\[(\d|10)(\.\d+)?px\]/)
  })

  it('every on/off setting is a Switch; checkboxes only in forms (a trust tick, Pin this container ID)', () => {
    const page = read('SettingsPage.tsx')
    expect(page.match(/type="checkbox"/g) ?? []).toHaveLength(1)
    expect(page).toContain('checked={targetDraft.pinId}')
    for (const label of ['Mesh', 'Autostart', 'LAN', 'Tailscale', 'Sharing', 'Host access', 'Auto-update', 'System notifications', 'Automatic checks', 'Models', 'Live catalogs']) {
      expect(page, label).toMatch(new RegExp(`<Switch\\s+label="${label}"`))
    }
  })

  it('sentence case titles on the former hand-built pages', () => {
    const page = read('SettingsPage.tsx')
    for (const title of ['title="Owner identity"', 'title="Runtime key"', 'title="Agent identities"', 'title="Back up seed phrase"', 'title="Packages"', 'title="Installed by agents"', 'title="Server"', 'title="Discovery"', 'title="Agent endpoints"', 'title="Containers"', 'title="Default container"', 'title="Host"', 'title="Custom containers"']) {
      expect(page, title).toContain(title)
    }
    for (const old of ['Owner Identity', 'Agent Identities', 'Back Up Seed Phrase', 'Runtime Packages', 'Agent-Installed Packages', 'Agent Endpoints', 'Approved Host Servers', 'Setup Required', 'Enable host access</span>']) {
      expect(page, old).not.toContain(old)
    }
  })
})
