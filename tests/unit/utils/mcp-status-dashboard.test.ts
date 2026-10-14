import { describe, expect, it } from 'vitest'
import { MCP_SERVER_STATUSES } from '../../../src/shared/types/adf-v02.types'
import { STATUS_COLORS, STATUS_LABELS } from '../../../src/renderer/components/mcp/McpStatusDashboard'

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
