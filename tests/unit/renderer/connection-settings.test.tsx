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
import { ConnectionRows, SimpleConnections, connectionDetail, emptyDiscoveryLine, nextLaunchLine, daemonDetails, daemonLine, defaultSwitchDetails, defaultSwitchLine, overrideLine } from '../../../src/renderer/components/settings/ConnectionSettings'
import { RUNTIME_NAV_ITEMS, STUDIO_NAV_ITEMS, settingsNavGroups, settingsTabFor } from '../../../src/renderer/components/settings/settings-nav'
import { remoteConnectionsSaved } from '../../../src/renderer/stores/connection.store'
import { DOCS } from '../../../src/shared/constants/docs-links'
import { CLIENT_SETTINGS_KEYS } from '../../../src/shared/constants/client-settings-keys'
import type { BackendDaemonStatus, BackendSettingsView } from '../../../src/shared/types/backend.types'
import type { ConnectionRow } from '../../../src/shared/types/connection.types'

// Vitest compiles JSX with the classic runtime (the renderer build uses the automatic one).
;(globalThis as { React?: typeof React }).React = React

const row = (over: Partial<ConnectionRow>): ConnectionRow => ({
  id: 'local', kind: 'local', name: 'host-0 (Local)', state: null, action: 'connect', url: null, address: null, fingerprint: null, encrypted: true, pairingOpen: false, removable: false, ...over,
})
const rows = (list: ConnectionRow[]) => renderToStaticMarkup(<ConnectionRows rows={list} busy={false} onConnect={() => {}} onAdd={() => {}} onRemove={() => {}} />)

describe('the Connection page rows', () => {
  it('each row: its state and at most one action; the row in use has none', () => {
    const html = rows([
      row({ state: 'connected', action: null }),
      // A saved connection is connected while saved (multi-runtime.md §6.5): its state, no action.
      row({ id: 'remote:rawl-hub', kind: 'saved', name: 'rawl-hub', state: 'retrying', action: null, url: 'http://100.101.102.103:7385', address: '100.101.102.103', fingerprint: 'ABCD-EFGH', removable: true }),
      row({ id: 'found:NEWW-2345@http://192.168.1.44:7385', kind: 'found', name: 'desk', state: 'not-paired', action: 'pair', url: 'http://192.168.1.44:7385', address: '192.168.1.44', fingerprint: 'NEWW-2345', encrypted: false, pairingOpen: true }),
    ])
    expect(html).toContain('>Connected<')
    expect(html).toContain('>Not connected, retrying<')
    expect(html).toContain('>Not paired<')
    expect(html).not.toContain('>Connect<')
    // A found computer: Add, never Pair (§6.5).
    expect(html.match(/>Add</g)).toHaveLength(1)
    expect(html).not.toContain('>Pair<')
    expect(html).toContain('100.101.102.103 · ABCD-EFGH')
    expect(html).toContain('192.168.1.44 · NEWW-2345 · Pairing open')
    expect(html).toContain('>Not encrypted<')
    // The More menu is on This computer (Inside Studio (legacy)) and the removable saved row.
    expect(html.match(/aria-label="More"/g)).toHaveLength(2)
  })

  it('an empty network search says what to do on the other computer; nothing while a computer is listed or the search has a problem', () => {
    const local = row({ state: 'connected', action: null })
    const searching = { browsing: true, problem: null }
    expect(emptyDiscoveryLine({ rows: [local], discovery: searching })).toBe('None found yet. On the other computer: Add, then Share.')
    expect(emptyDiscoveryLine({ rows: [local], discovery: null })).toBeNull()
    expect(emptyDiscoveryLine({ rows: [local], discovery: { browsing: false, problem: 'mDNS is blocked.' } })).toBeNull()
    expect(emptyDiscoveryLine({ rows: [local, row({ id: 'found:F@u', kind: 'found', name: 'desk', action: 'pair' })], discovery: searching })).toBeNull()
  })

  it('the local row is `<name> (Local)`; a saved row has the remote icon before its name, and no "(Remote)"', () => {
    const html = rows([row({ state: 'connected', action: null }), row({ id: 'remote:rawl-hub', kind: 'saved', name: 'rawl-hub', state: 'connected', action: null, removable: true })])
    const [local, saved] = html.split('data-connection="remote:rawl-hub"')
    expect(local).toContain('host-0 (Local)')
    expect(local).not.toContain('data-remote-mark')
    expect(saved).toContain('data-remote-mark')
    expect(html).not.toContain('(Remote)')
  })

  it('a saved row never shows Pair, Add or Connect', () => {
    const html = rows([row({ id: 'remote:rawl-hub', kind: 'saved', name: 'rawl-hub', state: 'connecting', action: null, fingerprint: 'ABCD-EFGH', address: '100.101.102.103', removable: true })])
    expect(html).not.toContain('>Pair<')
    expect(html).not.toContain('>Add<')
    expect(html).not.toContain('>Connect<')
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
    const html = rows([row({}), row({ id: 'remote:x', kind: 'saved', name: 'x', state: 'connected', action: null })])
    expect(html).not.toMatch(/\?/)
    const source = readFileSync(join(__dirname, '../../../src/renderer/components/settings/ConnectionSettings.tsx'), 'utf-8')
    expect(source).not.toContain('Use this daemon')
    expect(source).not.toContain('Switch to This Daemon')
    expect(source).not.toContain('Run agents in')
    // multi-runtime.md §7.1: no switch and no restart to connect (§1.4: never "additive").
    expect(source).not.toMatch(/Restart to connect|Switch and Restart|Finish switch now|Cancel switch|additive/i)
    // One sentence for a connection without a fingerprint (review item 13).
    expect(source).toContain('No fingerprint; identity not checked.')
    expect(source).not.toContain('Studio cannot check')
    // Every sentence added on the page is one sentence (review item 15).
    expect(source).toContain('Check that {pair.host.name} shows fingerprint {pair.host.fingerprint}.')
    const page = readFileSync(join(__dirname, '../../../src/renderer/components/settings/SettingsPage.tsx'), 'utf-8')
    expect(page).toContain('help="Off: Studio never contacts GitHub for updates; nothing downloads until you click the update badge."')
  })
})

describe('This computer and the next-launch notices', () => {
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
    expect(daemonLine(untrusted)).toBe('Connected · pid 4242 · started by the ADF CLI · daemon key not trusted')
    expect(daemonDetails(untrusted)).toContain('Daemon key: trust it with adf identity trust-daemon')
    const trusted = { ...daemon, trust: { state: 'trusted' as const, label: null, message: '' } }
    expect(daemonLine(trusted)).not.toMatch(/trusted/)
    expect(daemonDetails(trusted)).toContain('Daemon key: trusted by the owner')
  })

  it('puts a missing local proof under Details, not on the line', () => {
    const noProof = { ...daemon, localProof: { available: false, problem: 'icacls failed' } }
    expect(daemonLine(noProof)).not.toMatch(/proof/)
    expect(daemonDetails(noProof)).toContain('Local proof: unavailable (icacls failed)')
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

  it('a mode saved for the next launch says so in one line; nothing for a one-launch override (multi-runtime.md §7.2)', () => {
    const backend = (source: BackendSettingsView['active']['source']): BackendSettingsView => ({
      active: { mode: 'local', source, notices: [] }, remoteUrlProblem: null,
      configured: { mode: 'embedded', keepDaemonRunning: false, remoteUrl: null, remoteTokenSaved: false, allowInsecureHttp: false },
      encryptionAvailable: true, encryptionUnavailableReason: null,
    })
    const next = { id: 'embedded', name: 'Inside Studio (legacy)' }
    expect(nextLaunchLine(backend('file'), next)).toBe('Next launch: Inside Studio (legacy).')
    expect(nextLaunchLine(backend('file'), null)).toBeNull()
    expect(nextLaunchLine(backend('env'), next)).toBeNull()
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

describe('the sidebar: Studio and the runtime pages', () => {
  it('two groups, Studio first; the runtime pages are unheaded (the Runtime picker heads them with more than one runtime)', () => {
    expect(settingsNavGroups().map((g) => g.label)).toEqual(['Studio', ''])
  })

  it('Studio holds Appearance, Notifications, Updates, Privacy, About, then Connections; the runtime the rest', () => {
    expect(STUDIO_NAV_ITEMS.map((i) => i.label)).toEqual(['Appearance', 'Notifications', 'Updates', 'Privacy', 'About', 'Connections'])
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
    expect(page).toContain('<SettingsRow label="Network traffic" description={<>Every connection Studio and the runtime make.<DocsLink href={NETWORK_DOCS}')
    expect(page).not.toContain('docs/NETWORK.md lists')
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

describe('local only: Remotes is "None."', () => {
  const saved = row({ id: 'remote:rawl-hub', kind: 'saved', name: 'rawl-hub', state: 'connected', action: null, removable: true })
  const found = row({ id: 'found:F@u', kind: 'found', name: 'desk', state: 'not-paired', action: 'pair' })

  it('a remote counts as saved once it is in the list; a computer found on the network does not', () => {
    expect(remoteConnectionsSaved(null)).toBe(false)
    expect(remoteConnectionsSaved({ rows: [row({ state: 'connected', action: null })] })).toBe(false)
    expect(remoteConnectionsSaved({ rows: [row({ state: 'connected', action: null }), found] })).toBe(false)
    expect(remoteConnectionsSaved({ rows: [row({ state: 'connected', action: null }), saved] })).toBe(true)
  })

  it('Remotes, "None."; This computer and Inside Studio (legacy) under Details; Add is not in it', () => {
    const html = renderToStaticMarkup(<SimpleConnections busy={false} onLegacy={() => {}} details={<span>daemon-row</span>} />)
    // One word; "Runtimes this Studio uses." is its tooltip.
    expect(html).toContain('>Remotes<')
    expect(html).toContain('>None.<')
    expect(html).not.toContain('>Add<')
    expect(html).toContain('<details')
    expect(html).toContain('>Details</summary>')
    expect(html).toContain('daemon-row')
    expect(html).toContain('Inside Studio (legacy)')
    expect(html).not.toContain('Runtime ·')
  })
})

// F5 (review round 3): Studio's pairing asks before it replaces a saved connection, with the shared confirmation.
describe('pairing a computer already saved', () => {
  const asked = { step: 'failed', host: null, deviceName: 'agent-2', attemptsLeft: null, message: 'agent-1-pc is already saved; replace its address and token?', code: 'already_saved', savedUrl: null } as const
  const started = { ...asked, step: 'need_code', message: null, code: null } as const

  it('asks Replace with that one sentence; Cancel sends nothing more, Replace starts again with replace', async () => {
    const { startPairing } = await import('../../../src/renderer/components/settings/ConnectionSettings')
    for (const answer of [false, true]) {
      const starts: unknown[] = []
      const confirms: unknown[] = []
      const result = await startPairing(async (request) => { starts.push(request); return starts.length === 1 ? asked : started }, async (options) => { confirms.push(options); return answer }, { url: 'http://100.101.102.103:7385', allowInsecureHttp: false })
      expect(confirms).toEqual([{ title: 'Replace', body: 'agent-1-pc is already saved; replace its address and token?', confirmLabel: 'Replace', danger: true }])
      if (!answer) {
        expect(result).toBeNull()
        expect(starts).toEqual([{ url: 'http://100.101.102.103:7385', allowInsecureHttp: false }])
      } else {
        expect(result).toEqual(started)
        expect(starts).toEqual([{ url: 'http://100.101.102.103:7385', allowInsecureHttp: false }, { url: 'http://100.101.102.103:7385', allowInsecureHttp: false, replace: true }])
      }
    }
    // Not saved: no question.
    const confirms: unknown[] = []
    expect(await startPairing(async () => started, async (o) => { confirms.push(o); return true }, { url: 'http://100.101.102.103:7385' })).toEqual(started)
    expect(confirms).toEqual([])
  })

  it('the Add dialog uses the shared confirmation, never window.confirm', () => {
    const source = readFileSync(join(__dirname, '../../../src/renderer/components/settings/ConnectionSettings.tsx'), 'utf8')
    expect(source).toContain("useConfirm")
    expect(source).not.toMatch(/window\.confirm|\bconfirm\(['"`]/)
  })
})

// Owner decision 2026-10-21: one Add; it asks Connect or Share.
describe('Connections: one Add, two choices, two lists', () => {
  it('Add opens Connect ("Use a runtime on another computer.") and Share ("Let another computer use this runtime.")', async () => {
    const { AddChoice, AddBar, CONNECT_HELP, SHARE_HELP } = await import('../../../src/renderer/components/settings/ConnectionSettings')
    expect(CONNECT_HELP).toBe('Use a runtime on another computer.')
    expect(SHARE_HELP).toBe('Let another computer use this runtime.')
    const html = renderToStaticMarkup(<AddChoice share={{ available: true, reason: null }} onConnect={() => {}} onShare={() => {}} />)
    expect(html).toContain('>Connect<')
    expect(html).toContain(CONNECT_HELP)
    expect(html).toContain('>Share<')
    expect(html).toContain(SHARE_HELP)
    expect(html).not.toContain('disabled=""')
    // Inside Studio (legacy): Share needs this computer's daemon.
    expect(renderToStaticMarkup(<AddChoice share={{ available: false, reason: 'Remote access needs Local as the connection (Settings → Connections).' }} onConnect={() => {}} onShare={() => {}} />)).toContain('disabled=""')
    expect(renderToStaticMarkup(<AddBar busy={false} message={null} onAdd={() => {}} />).match(/>Add</g)).toHaveLength(1)
  })

  it('review A6: with more than one runtime, Share names the local runtime it shares ("<name> (Local)"), never "this runtime"', async () => {
    const { AddChoice, shareHelp } = await import('../../../src/renderer/components/settings/ConnectionSettings')
    expect(shareHelp('box-1 (Local)')).toBe('Let another computer use box-1 (Local).')
    expect(shareHelp(null)).toBe('Let another computer use this runtime.')
    const html = renderToStaticMarkup(<AddChoice share={{ available: true, reason: null }} runtime="box-1 (Local)" onConnect={() => {}} onShare={() => {}} />)
    expect(html).toContain('Let another computer use box-1 (Local).')
    expect(html).not.toContain('this runtime')
    const source = readFileSync(join(__dirname, '../../../src/renderer/components/settings/ConnectionSettings.tsx'), 'utf8')
    // The page computes it once and hands it to Add (help, Share) and Devices.
    expect(source).toContain('<DevicesGroup runtime={shared}')
    expect(source).toContain('<AddDialog runtime={shared}')
  })

  it('the page has one Add; the lists are Remotes and Devices; found computers are listed in Connect, not on the page', () => {
    const source = readFileSync(join(__dirname, '../../../src/renderer/components/settings/ConnectionSettings.tsx'), 'utf8')
    // The page's one Add is AddBar; the page body has no other.
    expect(source.slice(source.indexOf('export function ConnectionSettings()'))).not.toContain('>Add</Button>')
    expect(source).toContain('title="Remotes"')
    expect(source).toContain('<DevicesGroup')
    expect(source).toContain("view.rows.filter((r) => r.kind !== 'found')")
    // No phrase labels in the dialogs.
    for (const old of ['Use a token instead', 'Use a code instead', 'Add device', 'Create token']) expect(source, old).not.toContain(old)
  })

  it('Connect lists the computers found, each with its address and fingerprint; a token is under Details', async () => {
    const { FoundList, foundTargets } = await import('../../../src/renderer/components/settings/ConnectionSettings')
    const targets = foundTargets([
      row({ state: 'connected', action: null }),
      row({ id: 'found:NEWW-2345@http://192.168.1.44:7385', kind: 'found', name: 'desk', state: 'not-paired', action: 'pair', url: 'http://192.168.1.44:7385', address: '192.168.1.44', fingerprint: 'NEWW-2345', pairingOpen: true, encrypted: false }),
    ])
    expect(targets).toEqual([expect.objectContaining({ name: 'desk', url: 'http://192.168.1.44:7385', address: '192.168.1.44', fingerprint: 'NEWW-2345', pairingOpen: true })])
    const html = renderToStaticMarkup(<FoundList targets={targets} selected={null} disabled={false} onPick={() => {}} />)
    expect(html).toContain('desk')
    expect(html).toContain('192.168.1.44 · NEWW-2345 · Pairing open')
    expect(html).toContain('>Not encrypted<')
    expect(renderToStaticMarkup(<FoundList targets={[]} selected={null} disabled={false} onPick={() => {}} />)).toBe('')
  })
})
