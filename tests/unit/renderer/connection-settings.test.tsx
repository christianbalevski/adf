/**
 * Studio → Connections and the two-scope sidebar
 * (docs/design/settings-scopes.md §4, §5; owner redesign 2026-10-21): the
 * page order (Add, Local server, Remote servers, Devices), the local server
 * never under Remote servers, the More menu in a portal, Keep running after
 * Studio quits (the one quit setting), the Add dialog (Connect and Share
 * side by side; Connect with Address, Code and Token all visible), the
 * "Default changed" copy (W5-I), the sidebar groups and older page ids, and
 * the guide anchors the page links to. Static markup, no jsdom.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  AddBar, AddChoice, CODE_DIGITS_HELP, ConnectForm, codeReady, helloRefusal, progressText, ConnectionRows, ConnectionsPage, CONNECT_FIELDS_HELP, CONNECT_HELP, LocalServerSection, REMOTES_HELP, RemoteServersSection, SHARE_HELP,
  connectMethod, connectionDetail, daemonDetails, daemonLine, defaultSwitchDetails, defaultSwitchLine, emptyDiscoveryLine, keepRunningText, nextLaunchLine, overrideLine, serverCount, shareHelp, splitRows,
} from '../../../src/renderer/components/settings/ConnectionSettings'
import { RUNTIME_NAV_ITEMS, STUDIO_NAV_ITEMS, settingsNavGroups, settingsTabFor } from '../../../src/renderer/components/settings/settings-nav'
import { remoteConnectionsSaved } from '../../../src/renderer/stores/connection.store'
import { DOCS } from '../../../src/shared/constants/docs-links'
import { CLIENT_SETTINGS_KEYS } from '../../../src/shared/constants/client-settings-keys'
import type { BackendDaemonStatus, BackendSettingsView } from '../../../src/shared/types/backend.types'
import type { ConnectionRow, ConnectionsView } from '../../../src/shared/types/connection.types'

// The More menu's portal: record where it renders instead of reaching a DOM.
const portals: unknown[] = []
vi.mock('react-dom', async (importOriginal) => {
  const r = await importOriginal<typeof import('react-dom')>()
  return { ...r, createPortal: (node: React.ReactNode, container: unknown) => { portals.push(container); return React.createElement('div', { 'data-portal': 'body' }, node) } }
})

// Vitest compiles JSX with the classic runtime (the renderer build uses the automatic one).
;(globalThis as { React?: typeof React }).React = React

const SOURCE = readFileSync(join(__dirname, '../../../src/renderer/components/settings/ConnectionSettings.tsx'), 'utf8')

const row = (over: Partial<ConnectionRow>): ConnectionRow => ({
  id: 'local', kind: 'local', name: 'host-0 (Local)', state: null, action: 'connect', url: null, address: null, fingerprint: null, encrypted: true, pairingOpen: false, removable: false, ...over,
})
const LOCAL = row({ state: 'connected', action: null })
const SAVED = row({ id: 'remote:box-1', kind: 'saved', name: 'box-1', state: 'retrying', action: null, url: 'http://100.101.102.103:7385', address: '100.101.102.103', fingerprint: 'ABCD-EFGH', removable: true })
const FOUND = row({ id: 'found:NEWW-2345@http://192.168.1.44:7385', kind: 'found', name: 'laptop-1', state: 'not-paired', action: 'pair', url: 'http://192.168.1.44:7385', address: '192.168.1.44', fingerprint: 'NEWW-2345', encrypted: false, pairingOpen: true })

const daemon: BackendDaemonStatus = {
  connection: 'connected', progress: null, message: null, url: 'http://127.0.0.1:7385', pid: 4242, version: '0.8.0',
  startedBy: 'studio', how: 'spawned', localProof: { available: true, problem: null }, trust: null, keychainProblem: null, logFile: null,
}
const backend = (over: Partial<BackendSettingsView> = {}, keep = false): BackendSettingsView => ({
  active: { mode: 'local', source: 'file', notices: [] }, remoteUrlProblem: null,
  configured: { mode: 'local', keepDaemonRunning: keep, remoteUrl: null, remoteTokenSaved: false, allowInsecureHttp: false },
  encryptionAvailable: true, encryptionUnavailableReason: null, daemon, ...over,
})
const noop = () => {}
const remoteRows = (list: ConnectionRow[]) => renderToStaticMarkup(<ConnectionRows rows={list} busy={false} onConnect={noop} onRemove={noop} />)
const localSection = (list: ConnectionRow[], b = backend()) => renderToStaticMarkup(<LocalServerSection rows={list} backend={b} busy={false} onConnect={noop} onKeepRunning={noop} />)
const page = (rows: ConnectionRow[], b = backend()) => {
  const view: ConnectionsView = { current: { id: 'local', kind: 'local', name: 'host-0 (Local)', url: null, state: 'connected' }, next: null, rows, discovery: null }
  return renderToStaticMarkup(<ConnectionsPage view={view} backend={b} busy={false} message={null} onAdd={noop} onConnect={noop} onRemove={noop} onKeepRunning={noop} onRestart={noop} devices={<section data-section="devices">devices</section>} />)
}

describe('the page: Add, Local server, Remote servers, Devices, in that order', () => {
  it('one Add at the top, then the three sections', () => {
    const html = page([LOCAL, SAVED])
    const order = ['>Add<', 'data-section="local"', 'data-section="remote"', 'data-section="devices"'].map((s) => html.indexOf(s))
    for (const at of order) expect(at).toBeGreaterThan(-1)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(html.match(/>Add</g)).toHaveLength(1)
    expect(html).toContain('>Local server<')
    expect(html).toContain('>Remote servers<')
    // The old blocks are gone: no "Remotes", no "Daemon" row, no "Background" or "On quit".
    for (const old of ['>Remotes<', '>Daemon<', '>Background<', '>On quit<']) expect(html, old).not.toContain(old)
  })

  it('the local server is never under Remote servers; a found server is on neither list', () => {
    const { local, remote } = splitRows([LOCAL, SAVED, FOUND, row({ id: 'embedded', kind: 'embedded', name: 'Inside Studio (legacy)', state: null })])
    expect(local.map((r) => r.id)).toEqual(['local', 'embedded'])
    expect(remote.map((r) => r.id)).toEqual(['remote:box-1'])
    const html = page([LOCAL, SAVED, FOUND])
    const remoteSection = html.slice(html.indexOf('data-section="remote"'), html.indexOf('data-section="devices"'))
    expect(remoteSection).toContain('data-connection="remote:box-1"')
    expect(remoteSection).not.toContain('data-connection="local"')
    expect(remoteSection).not.toContain('host-0 (Local)')
    expect(html).not.toContain('data-connection="found:')
    const localPart = html.slice(html.indexOf('data-section="local"'), html.indexOf('data-section="remote"'))
    expect(localPart).toContain('host-0 (Local)')
  })

  it('local only: Remote servers is collapsed to its heading, which says None; nothing is hidden outright', () => {
    const html = renderToStaticMarkup(<RemoteServersSection rows={[LOCAL]} busy={false} onConnect={noop} onRemove={noop} />)
    expect(html).toContain('<details class="group">')
    expect(html).not.toContain('<details class="group" open')
    expect(html).toContain('>None<')
    expect(html).toContain('None. To add a server, click Add, then Connect.')
    expect(html).toContain(REMOTES_HELP)
    // Saved servers: open, with the count.
    const open = renderToStaticMarkup(<RemoteServersSection rows={[LOCAL, SAVED]} busy={false} onConnect={noop} onRemove={noop} />)
    expect(open).toContain('<details class="group" open="">')
    expect(open).toContain('>1 server<')
    expect([serverCount(0), serverCount(1), serverCount(2)]).toEqual(['None', '1 server', '2 servers'])
  })
})

describe('Local server', () => {
  it('its state on the name line; pid, who started it, URL and version under Details', () => {
    expect(daemonLine(daemon)).toBe('Connected')
    expect(daemonDetails(daemon)).toEqual(['PID: 4242', 'Started by: this Studio', 'URL: http://127.0.0.1:7385', 'Version: 0.8.0'])
    expect(daemonLine({ ...daemon, connection: 'disconnected' })).toBe('Not connected, retrying')
    const html = localSection([LOCAL])
    expect(html).toMatch(/data-state="ok"[^>]*>.*Connected</)
    expect(html).toContain('>Details</summary>')
    expect(html).toContain('>PID<')
    expect(html).toContain('>4242<')
    expect(html).toContain('>this Studio<')
  })

  it('an untrusted server key stays on the line (it needs an action); a trusted one is under Details', () => {
    const untrusted = { ...daemon, how: 'attached' as const, startedBy: 'cli' as const, trust: { state: 'not-trusted' as const, label: null, message: '' } }
    expect(daemonLine(untrusted)).toBe('Connected · Key not trusted')
    expect(daemonDetails(untrusted)).toContain('Started by: the ADF CLI')
    expect(daemonDetails(untrusted)).toContain('Key: not trusted. To trust it, run adf identity trust-daemon.')
    const trusted = { ...daemon, trust: { state: 'trusted' as const, label: null, message: '' } }
    expect(daemonLine(trusted)).not.toMatch(/trusted/)
    expect(daemonDetails(trusted)).toContain('Key: trusted by the owner')
  })

  it('a missing local proof is under Details and named as an error', () => {
    const noProof = { ...daemon, localProof: { available: false, problem: 'icacls failed' } }
    expect(daemonLine(noProof)).not.toMatch(/proof/)
    expect(daemonDetails(noProof)).toContain('Local proof: not available (icacls failed)')
    expect(localSection([LOCAL], backend({ daemon: noProof }))).toContain('Studio cannot show stored values or import an identity. Fix the permissions of the server&#x27;s data folder. Then restart the server.')
  })

  it('the progress line while it connects', () => {
    // D2: in server words; the pid goes to Details.
    const waiting = { ...daemon, connection: 'connecting' as const, progress: 'Waiting for the ADF daemon (pid 7)…', pid: null, startedBy: null }
    expect(daemonLine(waiting)).toBe('Waiting for the server…')
    expect(daemonDetails(waiting)).toContain('PID: 7')
    expect(progressText('Starting the ADF daemon…')).toBe('Starting the server…')
    expect(progressText('Stopping the ADF daemon (pid 9)…')).toBe('Stopping the server…')
    expect(progressText('Something else.')).toBe('Something else.')
  })

  it('"On quit / Keep running" and "Background" were one setting (keepDaemonRunning): one switch, "Keep running after Studio quits", one exact sentence', () => {
    const html = localSection([LOCAL])
    expect(html.match(/role="switch"/g)).toHaveLength(1)
    expect(html).toContain('aria-label="Keep running after Studio quits"')
    expect(html).toContain('When you quit Studio, Studio stops the server and its agents.')
    expect(keepRunningText(true, daemon)).toBe('When you quit Studio, the server and its agents keep running.')
    expect(keepRunningText(false, { startedBy: 'cli', how: 'attached' })).toBe('The ADF CLI started this server. Studio does not stop it when you quit Studio.')
    expect(keepRunningText(false, { startedBy: 'service', how: 'attached' })).toBe('A service started this server. Studio does not stop it when you quit Studio.')
    for (const text of [keepRunningText(true, null), keepRunningText(false, null)]) expect(text.split(/[.!?]\s/)).toHaveLength(1)
    // The setting both old controls wrote; nothing else on the page writes it.
    expect(SOURCE).toContain('setBackendSettings({ keepDaemonRunning: next })')
    expect(SOURCE).not.toContain('keepDaemonRunning: true')
  })

  it('Inside Studio (legacy) is in the local row\'s More menu; with its own row there, no menu', () => {
    expect(localSection([LOCAL])).toContain('aria-label="More"')
    expect(localSection([LOCAL, row({ id: 'embedded', kind: 'embedded', name: 'Inside Studio (legacy)', state: 'connected', action: null })], backend({ active: { mode: 'embedded', source: 'file', notices: [] }, daemon: null }))).not.toContain('aria-label="More"')
  })

  it('"Default changed": the date and the version in one line; what moved and what was not done are separate', () => {
    const record = { at: 'not a date', version: '0.8.0', moved: ['Client settings', 'ChatGPT session'], notDone: ['MCP sign-ins: the daemon\'s secret store is locked.'] }
    expect(defaultSwitchLine(record)).toBe('On not a date, Studio 0.8.0 moved agents from inside Studio to the local server.')
    expect(defaultSwitchDetails(record)).toEqual({
      moved: 'Moved: Client settings, ChatGPT session.',
      notDone: 'Not done then, retried at each start: MCP sign-ins: the daemon\'s secret store is locked.',
    })
    expect(defaultSwitchDetails({ at: '2026-10-16T10:00:00.000Z', version: '', moved: [], notDone: [] })).toEqual({ moved: 'Moved: nothing.', notDone: null })
    expect(localSection([LOCAL], backend({ defaultSwitch: record }))).toContain('>Default changed<')
  })
})

describe('Remote servers: the rows', () => {
  it('each row: the remote icon, its name, its state, the address and fingerprint, the More menu', () => {
    const html = remoteRows([LOCAL, SAVED, FOUND])
    expect(html).toContain('Not connected, retrying')
    expect(html).toContain('data-remote-mark')
    expect(html).toContain('100.101.102.103 · ABCD-EFGH')
    expect(html).not.toContain('(Remote)')
    expect(html).not.toContain('host-0 (Local)')
    expect(html.match(/aria-label="More"/g)).toHaveLength(1)
    // A saved row never offers Pair, Add or Connect.
    for (const s of ['>Pair<', '>Add<', '>Connect<']) expect(html, s).not.toContain(s)
  })

  it('the detail line: address, fingerprint, and Pairing open only on a row that can be paired', () => {
    expect(connectionDetail(row({}))).toBeNull()
    expect(connectionDetail(row({ address: 'a', fingerprint: 'F', pairingOpen: true, action: 'connect' }))).toBe('a · F')
    expect(connectionDetail(row({ address: 'a', fingerprint: 'F', pairingOpen: true, action: 'pair' }))).toBe('a · F · Pairing open')
  })

  it('the More menu is a portal into document.body at a fixed position: no card clips it', async () => {
    const { RowMenuPopup } = await import('../../../src/renderer/components/settings/ConnectionSettings')
    const body = { tag: 'body' }
    vi.stubGlobal('document', { body })
    try {
      portals.length = 0
      const html = renderToStaticMarkup(<RowMenuPopup items={[{ label: 'Remove', onSelect: noop, danger: true }]} position={{ x: 300, y: 40 }} onClose={noop} />)
      expect(portals).toEqual([body])
      expect(html).toContain('data-portal="body"')
      expect(html).toContain('role="menu"')
      expect(html).toMatch(/class="fixed /)
      expect(html).toContain('>Remove<')
    } finally {
      vi.unstubAllGlobals()
    }
    // The row menu has no absolutely placed child inside the card.
    const menu = SOURCE.slice(SOURCE.indexOf('export function RowMenu('), SOURCE.indexOf('function NotEncryptedBadge'))
    expect(menu).toContain('<RowMenuPopup')
    expect(menu).not.toMatch(/absolute/)
  })
})

describe('the next-launch notices', () => {
  it('a launch that runs another connection than the saved one says why, once', () => {
    const view = (active: Partial<BackendSettingsView['active']>): BackendSettingsView => backend({ active: { mode: 'embedded', source: 'file', notices: [], ...active } })
    expect(overrideLine(view({ source: 'env' }))).toBe('Inside Studio (legacy) because ADF_STUDIO_BACKEND is set.')
    expect(overrideLine(view({ source: 'session', sessionReason: 'the daemon is older.' }))).toBe('Inside Studio (legacy) for this session only: the daemon is older.')
    expect(overrideLine(view({ source: 'file' }))).toBeNull()
  })

  it('a mode saved for the next launch says so in one line; nothing for a one-launch override (multi-runtime.md §7.2)', () => {
    const b = (source: BackendSettingsView['active']['source']) => backend({ active: { mode: 'local', source, notices: [] } })
    const next = { id: 'embedded', name: 'Inside Studio (legacy)' }
    expect(nextLaunchLine(b('file'), next)).toBe('Next launch: Inside Studio (legacy).')
    expect(nextLaunchLine(b('file'), null)).toBeNull()
    expect(nextLaunchLine(b('env'), next)).toBeNull()
  })
})

describe('the Add dialog', () => {
  it('two choice cards side by side, each with its icon: Connect ("Connect to a remote agent server.") and Share ("Share this server.")', () => {
    expect(CONNECT_HELP).toBe('Connect to a remote agent server.')
    expect(SHARE_HELP).toBe('Share this server.')
    const html = renderToStaticMarkup(<AddChoice share={{ available: true, reason: null }} onConnect={noop} onShare={noop} />)
    expect(html).toContain('grid-cols-2')
    expect(html.indexOf('data-choice="connect"')).toBeLessThan(html.indexOf('data-choice="share"'))
    expect(html).toContain('data-choice-icon="connect"')
    expect(html).toContain('data-choice-icon="share"')
    expect(html).toContain('>Connect<')
    expect(html).toContain(CONNECT_HELP)
    expect(html).toContain('>Share<')
    expect(html).toContain(SHARE_HELP)
    expect(html).not.toContain('disabled=""')
    // Inside Studio (legacy): Share needs the local server.
    expect(renderToStaticMarkup(<AddChoice share={{ available: false, reason: 'Remote access needs Local as the connection (Settings → Connections).' }} onConnect={noop} onShare={noop} />)).toContain('disabled=""')
    expect(renderToStaticMarkup(<AddBar busy={false} message={null} onAdd={noop} />).match(/>Add</g)).toHaveLength(1)
  })

  it('review A6: with more than one server, Share names the local server it shares ("<name> (Local)")', () => {
    expect(shareHelp('box-1 (Local)')).toBe('Share box-1 (Local).')
    expect(shareHelp(null)).toBe('Share this server.')
    const html = renderToStaticMarkup(<AddChoice share={{ available: true, reason: null }} runtime="box-1 (Local)" onConnect={noop} onShare={noop} />)
    expect(html).toContain('Share box-1 (Local).')
    // The page computes it once and hands it to Add (help, Share); Devices always names the local server.
    expect(SOURCE).toContain('<AddDialog runtime={shared}')
    expect(SOURCE).toContain('<DevicesGroup runtime={localName}')
  })

  it('Connect: the found servers as picks, then Address, Code and Token, all visible, and one sentence', async () => {
    const { foundTargets } = await import('../../../src/renderer/components/settings/ConnectionSettings')
    const targets = foundTargets([LOCAL, FOUND])
    expect(targets).toEqual([expect.objectContaining({ name: 'laptop-1', url: 'http://192.168.1.44:7385', address: '192.168.1.44', fingerprint: 'NEWW-2345', pairingOpen: true })])
    const html = renderToStaticMarkup(<ConnectForm targets={targets} found={null} url="" code="" token="" insecure={false} trusted={false} invalid={null} empty={null} problem={null} busy={false} onPick={noop} onUrl={noop} onCode={noop} onToken={noop} onTrusted={noop} />)
    expect(html).toContain('aria-label="Found"')
    expect(html).toContain('laptop-1')
    expect(html).toContain('192.168.1.44 · NEWW-2345 · Pairing open')
    expect(html).toContain('>Not encrypted<')
    for (const field of ['aria-label="Address"', 'aria-label="Code"', 'aria-label="Token"']) expect(html, field).toContain(field)
    expect(html.indexOf('aria-label="Address"')).toBeLessThan(html.indexOf('aria-label="Code"'))
    expect(html).not.toContain('<details')
    expect(html).not.toContain('>Details</summary>')
    expect(html).toContain(CONNECT_FIELDS_HELP)
    expect(CONNECT_FIELDS_HELP).toBe('Enter a code or a token. To get a code, click Add, then Share, on the other computer.')
    // D9: a code is 6 digits; anything else says so, and Connect stays disabled for it.
    expect([codeReady('123 456'), codeReady('12345'), codeReady('12a456'), codeReady('1234567')]).toEqual([true, false, false, false])
    const short = renderToStaticMarkup(<ConnectForm targets={[]} found={null} url="http://100.101.102.103:7385" code="123" token="" insecure={false} trusted={false} invalid={null} empty={null} problem={null} busy={false} onPick={noop} onUrl={noop} onCode={noop} onToken={noop} onTrusted={noop} />)
    expect(short).toContain(CODE_DIGITS_HELP)
    expect(CODE_DIGITS_HELP).toBe('Enter the 6-digit code.')
    expect(SOURCE).toContain("method === 'code' ? !codeOk : method !== 'token'")
    // D11: the plain-http checkbox is one word; the sentence stays below it.
    const http = renderToStaticMarkup(<ConnectForm targets={[]} found={null} url="http://192.168.1.44:7385" code="" token="" insecure trusted={false} invalid={null} empty={null} problem={null} busy={false} onPick={noop} onUrl={noop} onCode={noop} onToken={noop} onTrusted={noop} />)
    expect(http).toContain('aria-label="Unencrypted"')
    expect(http).toContain('This address uses http. Anyone on this network can read the code and the token.')
    for (const sentence of CONNECT_FIELDS_HELP.split(/(?<=\.)\s/)) expect(sentence.split(' ').length, sentence).toBeLessThanOrEqual(20)
  })

  it('Connect sends a code or a token, never both', () => {
    expect(connectMethod('123 456', '')).toBe('code')
    expect(connectMethod('', 'adfd_x')).toBe('token')
    expect(connectMethod('123456', 'adfd_x')).toBe('both')
    expect(connectMethod(' ', ' ')).toBeNull()
  })

  it('an empty network search says what to do on the other computer; nothing while a server is listed or the search has a problem', () => {
    const searching = { browsing: true, problem: null }
    expect(emptyDiscoveryLine({ rows: [LOCAL], discovery: searching })).toBe('No server found yet. On the other computer, click Add, then Share.')
    expect(emptyDiscoveryLine({ rows: [LOCAL], discovery: null })).toBeNull()
    expect(emptyDiscoveryLine({ rows: [LOCAL], discovery: { browsing: false, problem: 'mDNS is blocked.' } })).toBeNull()
    expect(emptyDiscoveryLine({ rows: [LOCAL, FOUND], discovery: searching })).toBeNull()
  })

  it('the fingerprint is checked before the code is sent; a server without one takes a token only', () => {
    expect(SOURCE).toContain('Check that {pair.host.name} shows fingerprint {pair.host.fingerprint}.')
    // D1: main's sentence for remote access off or an older ADF; a token is offered only without a fingerprint.
    expect(helloRefusal({ message: 'box-1 turned remote access off.', host: { name: 'box-1', fingerprint: 'ABCD-EFGH', url: 'http://100.101.102.103:7385', encrypted: true } })).toBe('box-1 turned remote access off.')
    expect(helloRefusal({ message: 'http://100.101.102.103:7385 has remote access off. Turn it on there: Settings → Connections → Add → Share.', host: null })).toBe('http://100.101.102.103:7385 has remote access off. Turn it on there: Settings → Connections → Add → Share. To connect without a fingerprint, enter a token.')
    expect(SOURCE).not.toContain('This server has no fingerprint, so it cannot pair with a code.')
    expect(SOURCE).toContain('helloRefusal(state)')
    // Pair (the code) is only on the check step, after the hello.
    expect(SOURCE).toMatch(/step === 'check' && <Button variant="primary"[^\n]*>Pair<\/Button>/)
  })
})

describe('copy', () => {
  it('no question marks, no old phrasing, no "additive"', () => {
    const html = page([LOCAL, SAVED])
    expect(html).not.toMatch(/\?/)
    for (const old of ['Use this daemon', 'Switch to This Daemon', 'Run agents in', 'Devices lose the connection', 'Use a token instead', 'Use a code instead', 'Add device', 'Create token']) expect(SOURCE, old).not.toContain(old)
    expect(SOURCE).not.toMatch(/Restart to connect|Switch and Restart|Finish switch now|Cancel switch|additive|alongside/i)
    const settings = readFileSync(join(__dirname, '../../../src/renderer/components/settings/SettingsPage.tsx'), 'utf-8')
    expect(settings).toContain('help="Off: Studio never contacts GitHub for updates; nothing downloads until you click the update badge."')
  })

  it('server naming: the page says "server", never "runtime" or "daemon", in what it renders', () => {
    const html = page([LOCAL, SAVED]) + renderToStaticMarkup(<AddChoice share={{ available: true, reason: null }} onConnect={noop} onShare={noop} />)
    const text = html.replace(/<[^>]+>/g, ' ')
    expect(text).not.toMatch(/\bruntimes?\b/i)
    expect(text).not.toMatch(/\bdaemon\b/i)
    expect(text).toMatch(/Local server/)
    expect(text).toMatch(/Remote servers/)
  })
})

describe('the sidebar: Studio and the runtime pages', () => {
  it('two groups, Studio first; the runtime pages are unheaded (the Server picker heads them with more than one server)', () => {
    expect(settingsNavGroups().map((g) => g.label)).toEqual(['Studio', ''])
  })

  it('Studio holds Appearance, Notifications, Updates, Privacy, About, then Connections; the runtime the rest', () => {
    expect(STUDIO_NAV_ITEMS.map((i) => i.label)).toEqual(['Appearance', 'Notifications', 'Updates', 'Privacy', 'About', 'Connections'])
    expect(RUNTIME_NAV_ITEMS.map((i) => i.label)).toEqual(['Prompts', 'Agent templates', 'Providers', 'Packages', 'MCP servers', 'Skills', 'Channels', 'Files', 'Identity', 'Networking', 'Compute', 'Usage'])
    expect(STUDIO_NAV_ITEMS.find((i) => i.id === 'connection')?.description).toBe('Servers and devices.')
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
    expect(page).toContain('<SettingsRow label="Network traffic" description={<>Every connection that Studio and the server make.<DocsLink href={NETWORK_DOCS}')
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
    expect(links.map(([key]) => key)).toEqual(expect.arrayContaining(['backendConnection', 'backendAddConnection', 'backendStatus', 'backendQuit']))
    for (const [key, url] of links) {
      expect(url, key).toMatch(/\/docs\/guides\/studio-backend\.md#/)
      expect(anchors.has(url.split('#')[1]), `${key}: ${url}`).toBe(true)
    }
  })
})

describe('local only', () => {
  it('a remote counts as saved once it is in the list; a server found on the network does not', () => {
    expect(remoteConnectionsSaved(null)).toBe(false)
    expect(remoteConnectionsSaved({ rows: [LOCAL] })).toBe(false)
    expect(remoteConnectionsSaved({ rows: [LOCAL, FOUND] })).toBe(false)
    expect(remoteConnectionsSaved({ rows: [LOCAL, SAVED] })).toBe(true)
  })
})

// F5 (review round 3): Studio's pairing asks before it replaces a saved connection, with the shared confirmation.
describe('pairing a server already saved', () => {
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
    expect(SOURCE).toContain('useConfirm')
    expect(SOURCE).not.toMatch(/window\.confirm|\bconfirm\(['"`]/)
  })
})
