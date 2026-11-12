import { describe, expect, it } from 'vitest'
import { MCP_SERVER_STATUSES } from '../../../src/shared/types/adf-v02.types'
import { STATUS_COLORS, STATUS_LABELS } from '../../../src/renderer/components/mcp/McpStatusDashboard'
import { builtInManagedServer } from '../../../src/renderer/components/mcp/runtime-mcp-servers'
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
