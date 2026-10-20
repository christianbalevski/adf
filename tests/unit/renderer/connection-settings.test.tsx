/**
 * Studio → Connection and the two-scope sidebar
 * (docs/design/settings-scopes.md §4, §5): the rows (state and one action;
 * a paired computer never offers Pair), the This computer lines, the "Default
 * changed" copy (W5-I), the sidebar groups and older page ids, and the
 * guide anchors the page links to. Static markup, no jsdom.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ConnectionRows, connectionDetail, emptyDiscoveryLine, pendingRestartLine, daemonDetails, daemonLine, defaultSwitchDetails, defaultSwitchLine, overrideLine } from '../../../src/renderer/components/settings/ConnectionSettings'
import { RUNTIME_NAV_ITEMS, STUDIO_NAV_ITEMS, settingsNavGroups, settingsTabFor } from '../../../src/renderer/components/settings/settings-nav'
import { runtimeGroupLabel } from '../../../src/renderer/stores/connection.store'
import { DOCS } from '../../../src/shared/constants/docs-links'
import { CLIENT_SETTINGS_KEYS } from '../../../src/shared/constants/client-settings-keys'
import type { BackendDaemonStatus, BackendSettingsView } from '../../../src/shared/types/backend.types'
import type { ConnectionCurrent, ConnectionRow } from '../../../src/shared/types/connection.types'

// Vitest compiles JSX with the classic runtime (the renderer build uses the automatic one).
;(globalThis as { React?: typeof React }).React = React

const row = (over: Partial<ConnectionRow>): ConnectionRow => ({
  id: 'local', kind: 'local', name: 'This computer', state: null, action: 'connect', url: null, address: null, fingerprint: null, encrypted: true, pairingOpen: false, removable: false, ...over,
})
const rows = (list: ConnectionRow[]) => renderToStaticMarkup(<ConnectionRows rows={list} busy={false} onConnect={() => {}} onPair={() => {}} onRemove={() => {}} />)
const current = (over: Partial<ConnectionCurrent> = {}): ConnectionCurrent => ({ id: 'local', kind: 'local', name: 'This computer', url: null, state: 'connected', ...over })

describe('the Connection page rows', () => {
  it('each row: its state and at most one action; the row in use has none', () => {
    const html = rows([
      row({ state: 'connected', action: null }),
      row({ id: 'remote:rawl-hub', kind: 'saved', name: 'rawl-hub', state: 'paired', action: 'connect', url: 'http://100.101.102.103:7385', address: '100.101.102.103', fingerprint: 'ABCD-EFGH', removable: true }),
      row({ id: 'found:NEWW-2345@http://192.168.1.44:7385', kind: 'found', name: 'desk', state: 'not-paired', action: 'pair', url: 'http://192.168.1.44:7385', address: '192.168.1.44', fingerprint: 'NEWW-2345', encrypted: false, pairingOpen: true }),
    ])
    expect(html).toContain('>Connected<')
    expect(html).toContain('>Paired<')
    expect(html).toContain('>Not paired<')
    expect(html.match(/>Connect</g)).toHaveLength(1)
    expect(html.match(/>Pair</g)).toHaveLength(1)
    expect(html).toContain('100.101.102.103 · ABCD-EFGH')
    expect(html).toContain('192.168.1.44 · NEWW-2345 · Pairing open')
    expect(html).toContain('>Not encrypted<')
    // The More menu is on This computer (Inside Studio (legacy)) and the removable saved row.
    expect(html.match(/aria-label="More"/g)).toHaveLength(2)
  })

  it('an empty network search says what to do on the other computer; nothing while a computer is listed or the search has a problem', () => {
    const local = row({ state: 'connected', action: null })
    const searching = { browsing: true, problem: null }
    expect(emptyDiscoveryLine({ rows: [local], discovery: searching })).toBe('None found yet; turn on Remote access on the other computer.')
    expect(emptyDiscoveryLine({ rows: [local], discovery: null })).toBeNull()
    expect(emptyDiscoveryLine({ rows: [local], discovery: { browsing: false, problem: 'mDNS is blocked.' } })).toBeNull()
    expect(emptyDiscoveryLine({ rows: [local, row({ id: 'found:F@u', kind: 'found', name: 'desk', action: 'pair' })], discovery: searching })).toBeNull()
  })

  it('a Paired row never shows Pair', () => {
    const html = rows([row({ id: 'remote:rawl-hub', kind: 'saved', name: 'rawl-hub', state: 'paired', action: 'connect', fingerprint: 'ABCD-EFGH', address: '100.101.102.103' })])
    expect(html).not.toContain('>Pair<')
    expect(html).not.toContain('fingerprint at')
  })

  it('the detail line: address, fingerprint, and Pairing open only on a row that can be paired', () => {
    expect(connectionDetail(row({}))).toBeNull()
    expect(connectionDetail(row({ address: 'a', fingerprint: 'F', pairingOpen: true, action: 'connect' }))).toBe('a · F')
    expect(connectionDetail(row({ address: 'a', fingerprint: 'F', pairingOpen: true, action: 'pair' }))).toBe('a · F · Pairing open')
  })

  it('with an Inside Studio row, This computer has no More menu', () => {
    const html = rows([row({}), row({ id: 'embedded', kind: 'embedded', name: 'Inside Studio (legacy)', state: 'connected', action: null })])
    expect(html).not.toContain('aria-label="More"')
  })

  it('no question marks, no "Use this daemon", no "Switch to This Daemon"', () => {
    const html = rows([row({}), row({ id: 'remote:x', kind: 'saved', name: 'x', state: 'paired' })])
    expect(html).not.toMatch(/\?/)
    const source = readFileSync(join(__dirname, '../../../src/renderer/components/settings/ConnectionSettings.tsx'), 'utf-8')
    expect(source).not.toContain('Use this daemon')
    expect(source).not.toContain('Switch to This Daemon')
    expect(source).not.toContain('Run agents in')
    // One sentence for a connection without a fingerprint (review item 13).
    expect(source).toContain('No fingerprint; identity not checked.')
    expect(source).not.toContain('Studio cannot check')
    // Every sentence added on the page is one sentence (review item 15).
    expect(source).toContain('Check that {pair.host.name} shows fingerprint {pair.host.fingerprint}.')
    const page = readFileSync(join(__dirname, '../../../src/renderer/components/settings/SettingsPage.tsx'), 'utf-8')
    expect(page).toContain('help="Off: Studio never contacts GitHub for updates; nothing downloads until you click the update badge."')
  })
})

describe('This computer and the switch notices', () => {
  const daemon: BackendDaemonStatus = {
    connection: 'connected', progress: null, message: null, url: 'http://127.0.0.1:7385', pid: 4242, version: '0.8.0',
    startedBy: 'studio', how: 'spawned', localProof: { available: true, problem: null }, trust: null, keychainProblem: null, logFile: null,
  }

  it('the daemon line: connection, pid and who started it; URL and version under Details', () => {
    expect(daemonLine(daemon)).toBe('Connected · pid 4242 · started by this Studio')
    expect(daemonDetails(daemon)).toEqual(['URL: http://127.0.0.1:7385', 'Version: 0.8.0'])
    expect(daemonLine({ ...daemon, connection: 'disconnected' })).toBe('Not connected, retrying · pid 4242 · started by this Studio')
  })

  it('keeps an untrusted daemon key on the line (it needs an action) and puts a trusted one under Details', () => {
    const untrusted = { ...daemon, how: 'attached' as const, startedBy: 'cli' as const, trust: { state: 'not-trusted' as const, label: null, message: '' } }
    expect(daemonLine(untrusted)).toBe('Connected · pid 4242 · started by the ADF CLI · daemon key not trusted (adf identity trust-daemon)')
    const trusted = { ...daemon, trust: { state: 'trusted' as const, label: null, message: '' } }
    expect(daemonLine(trusted)).not.toMatch(/trusted/)
    expect(daemonDetails(trusted)).toContain('Daemon key: trusted by the owner')
  })

  it('shows the progress line while connecting', () => {
    expect(daemonLine({ ...daemon, connection: 'connecting', progress: 'Waiting for the ADF daemon (pid 7)…', pid: null, startedBy: null })).toBe('Waiting for the ADF daemon (pid 7)…')
  })

  it('a launch that runs another connection than the saved one says why, once', () => {
    const view = (active: Partial<BackendSettingsView['active']>): BackendSettingsView => ({
      active: { mode: 'embedded', source: 'file', notices: [], ...active }, remoteUrlProblem: null,
      configured: { mode: 'local', keepDaemonRunning: false, remoteUrl: null, remoteTokenSaved: false, allowInsecureHttp: false },
      encryptionAvailable: true, encryptionUnavailableReason: null,
    })
    expect(overrideLine(view({ source: 'env' }))).toBe('Inside Studio (legacy) because ADF_STUDIO_BACKEND is set.')
    expect(overrideLine(view({ source: 'session', sessionReason: 'the daemon is older.' }))).toBe('Inside Studio (legacy) for this session only: the daemon is older.')
    expect(overrideLine(view({ source: 'file' }))).toBeNull()
  })

  it('a saved connection that differs from the running one: "Restart to connect to <name>.", remote to remote too (review item 7)', () => {
    const backend = (source: BackendSettingsView['active']['source'], pendingSwitch: BackendSettingsView['pendingSwitch'] = null): BackendSettingsView => ({
      active: { mode: 'remote', source, notices: [] }, remoteUrlProblem: null, pendingSwitch,
      configured: { mode: 'remote', keepDaemonRunning: false, remoteUrl: null, remoteTokenSaved: false, allowInsecureHttp: false, remoteName: 'desk' },
      encryptionAvailable: true, encryptionUnavailableReason: null,
    })
    const next = { id: 'remote:desk', name: 'desk' }
    expect(pendingRestartLine(backend('file'), next)).toBe('Restart to connect to desk.')
    expect(pendingRestartLine(backend('file'), null)).toBeNull()
    expect(pendingRestartLine(backend('env'), next)).toBeNull()
    expect(pendingRestartLine(backend('file', { target: 'remote', waitingFor: [], gaveUp: false }), next)).toBeNull()
  })

  it('"Default changed": the date and the version in one line; what moved and what was not done are separate', () => {
    const record = { at: 'not a date', version: '0.8.0', moved: ['Client settings', 'ChatGPT session'], notDone: ['MCP sign-ins: the daemon\'s secret store is locked.'] }
    expect(defaultSwitchLine(record)).toBe('On not a date, Studio 0.8.0 moved agents from inside Studio to this computer.')
    expect(defaultSwitchDetails(record)).toEqual({
      moved: 'Moved: Client settings, ChatGPT session.',
      notDone: 'Not done then, retried at each start: MCP sign-ins: the daemon\'s secret store is locked.',
    })
    expect(defaultSwitchDetails({ at: '2026-10-16T10:00:00.000Z', version: '', moved: [], notDone: [] })).toEqual({ moved: 'Moved: nothing.', notDone: null })
  })
})

describe('the sidebar: Studio and Runtime · <name>', () => {
  it('two groups, Studio first; the runtime group is named after the connection, with its state while not connected', () => {
    expect(settingsNavGroups(runtimeGroupLabel(current())).map((g) => g.label)).toEqual(['Studio', 'Runtime · This computer'])
    expect(runtimeGroupLabel(current({ id: 'remote:rawl-hub', kind: 'remote', name: 'rawl-hub' }))).toBe('Runtime · rawl-hub')
    expect(runtimeGroupLabel(current({ kind: 'remote', name: 'rawl-hub', state: 'retrying' }))).toBe('Runtime · rawl-hub · Not connected, retrying')
    expect(runtimeGroupLabel(null)).toBe('Runtime')
  })

  it('Studio holds Connection, Appearance, Notifications, Updates, Privacy, About; the runtime the rest', () => {
    expect(STUDIO_NAV_ITEMS.map((i) => i.label)).toEqual(['Appearance', 'Connection', 'Notifications', 'Updates', 'Privacy', 'About'])
    expect(RUNTIME_NAV_ITEMS.map((i) => i.label)).toEqual(['Prompts', 'Agent templates', 'Providers', 'Packages', 'MCP servers', 'Skills', 'Channels', 'Files', 'Identity', 'Networking', 'Compute', 'Usage'])
    // Plain nouns: no question, at most one short sentence under a title.
    for (const item of [...STUDIO_NAV_ITEMS, ...RUNTIME_NAV_ITEMS]) {
      expect(item.label, item.id).not.toMatch(/\?/)
      expect(item.description, item.id).not.toMatch(/\?/)
      expect(item.description.split(/[.!]\s/).length, item.id).toBe(1)
    }
  })

  it('the Privacy row is named for what it lists, not like the Connection page (review item 14)', () => {
    const page = readFileSync(join(__dirname, '../../../src/renderer/components/settings/SettingsPage.tsx'), 'utf-8')
    expect(page).not.toContain('label="Connections"')
    expect(page).toContain('<SettingsRow label="Network traffic" description="docs/NETWORK.md lists every connection Studio and the runtime make." />')
  })

  it('older ids open their new page: Backend → Connection, General → Appearance, General\'s usage → Usage', () => {
    expect(settingsTabFor('backend')).toBe('connection')
    expect(settingsTabFor('general')).toBe('appearance')
    expect(settingsTabFor('general', 'usage')).toBe('usage')
    expect(settingsTabFor('providers')).toBe('providers')
  })

  it('client keys are what the Studio group edits (settings-scopes.md §3)', () => {
    for (const key of ['theme', 'uiFont', 'uiScale', 'agentAvatars', 'nativeNotificationsEnabled', 'menuBarEnabled', 'updateChecksEnabled', 'spellcheckDownloadsEnabled']) {
      expect(CLIENT_SETTINGS_KEYS as readonly string[], key).toContain(key)
    }
    for (const key of ['providerChecksEnabled', 'remoteCatalogsEnabled', 'agentsFolder']) {
      expect(CLIENT_SETTINGS_KEYS as readonly string[], key).not.toContain(key)
    }
  })
})

describe('Connection page docs links', () => {
  /** GitHub's heading slug: lowercased, punctuation dropped, spaces to dashes. */
  const slug = (heading: string) => heading.toLowerCase().replace(/[^\p{L}\p{N} -]/gu, '').replace(/ /g, '-')

  it('every backend anchor is a heading of docs/guides/studio-backend.md', () => {
    const guide = readFileSync(join(__dirname, '../../../docs/guides/studio-backend.md'), 'utf-8')
    const anchors = new Set(guide.split(/\r?\n/).filter((line) => /^#{2,3} /.test(line)).map((line) => slug(line.replace(/^#+ /, ''))))
    const links = Object.entries(DOCS).filter(([key]) => key.startsWith('backend'))
    expect(links.map(([key]) => key)).toEqual(expect.arrayContaining(['backendConnection', 'backendAddConnection']))
    for (const [key, url] of links) {
      expect(url, key).toMatch(/\/docs\/guides\/studio-backend\.md#/)
      expect(anchors.has(url.split('#')[1]), `${key}: ${url}`).toBe(true)
    }
  })
})
