import { describe, expect, it } from 'vitest'
import { MCP_SERVER_STATUSES } from '../../../src/shared/types/adf-v02.types'
import { STATUS_COLORS, STATUS_LABELS, serverRowStatus, signedInAnswer } from '../../../src/renderer/components/mcp/McpStatusDashboard'
import { builtInManagedServer } from '../../../src/renderer/components/mcp/runtime-mcp-servers'
import { oauthNeedsSignIn } from '../../../src/renderer/components/mcp/McpAddServerModal'
import type { McpServerRegistration } from '../../../src/shared/types/ipc.types'

// E3 (690e0046): `needs_sign_in` (an http+oauth server waiting for its
// sign-in, W1-B) showed its raw value and a grey dot in Settings → MCP.
describe('McpStatusDashboard status chips', () => {
  it('every MCP server status has a label and a colour', () => {
    for (const status of MCP_SERVER_STATUSES) {
      expect(STATUS_LABELS[status], status).toEqual(expect.any(String))
      expect(STATUS_COLORS[status], status).toEqual(expect.any(String))
    }
    expect(STATUS_LABELS.needs_sign_in).toBe('Sign in needed')
    expect(STATUS_COLORS.needs_sign_in).toBe('bg-amber-500')
  })
})

// D#2: a new managed registration downloads nothing only when it launches the
// bundled server (catalog shape, on the host); any other shape installs as before.
describe('McpStatusDashboard managed install of a bundled server', () => {
  const GMAIL = '@gongrzhe/server-gmail-autoauth-mcp'
  const bundled = [{ npmPackage: GMAIL, version: '1.1.11' }]
  const gmail: McpServerRegistration = { id: 'g', name: 'gmail', type: 'npm', npmPackage: GMAIL, runLocation: 'host', managed: true }

  it('the catalog shape on the host is built in: no npm install', () => {
    expect(builtInManagedServer(gmail, bundled, true, false)).toEqual(bundled[0])
    expect(builtInManagedServer({ ...gmail, runLocation: undefined }, bundled, true, true)).toEqual(bundled[0])
  })

  it('edited args or command, the container, no bundle, or an unmanaged registration: the npm install as before', () => {
    expect(builtInManagedServer({ ...gmail, args: ['--x'] }, bundled, true, false)).toBeUndefined()
    expect(builtInManagedServer({ ...gmail, command: 'npx' }, bundled, true, false)).toBeUndefined()
    expect(builtInManagedServer(gmail, bundled, false, false)).toBeUndefined()
    expect(builtInManagedServer({ ...gmail, runLocation: 'shared' }, bundled, true, true)).toBeUndefined()
    expect(builtInManagedServer(gmail, undefined, true, false)).toBeUndefined()
    expect(builtInManagedServer({ ...gmail, managed: false }, bundled, true, false)).toBeUndefined()
  })
})

// A server that signs in with its own auth command (Gmail) and has not: it may
// start and list tools that all fail, so its row needs a sign-in rather than
// showing "Connected · N tools".
describe('McpStatusDashboard row status for a server that signs in', () => {
  const gmail: McpServerRegistration = { id: 'g', name: 'gmail', type: 'npm', npmPackage: '@gongrzhe/server-gmail-autoauth-mcp', auth: true, runLocation: 'host', lastVerifiedAt: 1 }
  const remote: McpServerRegistration = { id: 'r', name: 'remote', type: 'http', url: 'https://mcp.example.test/mcp', oauth: true }

  it('signed out of its auth command: Sign in needed instead of the process status, and no second sign-in chip', () => {
    expect(serverRowStatus(gmail, 'connected', false, false)).toBe('needs_sign_in')
    expect(oauthNeedsSignIn(gmail, undefined, false)).toBe(false)
  })

  it('signed in, unknown, installing, an http OAuth row, or no auth command: the status as before', () => {
    expect(serverRowStatus(gmail, 'connected', false, true)).toBe('connected')
    expect(serverRowStatus(gmail, 'connected', false, undefined)).toBe('connected')
    expect(serverRowStatus(gmail, undefined, false, undefined)).toBe('stopped')
    expect(serverRowStatus(gmail, 'connected', true, false)).toBe('installing')
    expect(serverRowStatus(remote, 'connected', false, false)).toBe('connected')
    expect(serverRowStatus({ ...gmail, auth: false }, 'connected', false, false)).toBe('connected')
  })

  it('a name-only answer counts only when marked byName: an older daemon answers false for every name, which is unknown', () => {
    expect(signedInAnswer(false, { signedIn: false })).toBeUndefined()
    expect(signedInAnswer(false, { signedIn: false, byName: true })).toBe(false)
    expect(signedInAnswer(false, { signedIn: true, byName: true })).toBe(true)
    expect(signedInAnswer(true, { signedIn: false })).toBe(false)
  })
})
