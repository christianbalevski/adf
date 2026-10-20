import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  PERMISSION_LABELS, PERMISSION_TIPS, approvalRemoved, approvalRemovedMessage, mcpStatusView, restoreApproval,
  saveFailureReason, saveStatusText, tableProtectionLabel, timersBlocked, toolRowGate, toolMatchesFilter, ASK_AUTONOMOUS_TIP,
} from '../../../src/renderer/components/agent/config-panel-model'
import {
  LockBadge, McpStatusChip, PermissionLegend, SaveStatusLine, TimersBlockedNotice, UndoToast, RowWarning, TIMERS_BLOCKED_TIP,
} from '../../../src/renderer/components/agent/config-panel-parts'
import { AgentConfig } from '../../../src/renderer/components/agent/AgentConfig'
import { DEFAULT_AGENT_CONFIG } from '../../../src/shared/constants/adf-defaults'
import type { AgentConfig as AgentConfigType, ToolDeclaration } from '../../../src/shared/types/adf-v02.types'

/**
 * The agent Config panel: one permission vocabulary, a refused save that
 * keeps the draft, live MCP status, the approval-removal undo, the tool
 * filter and the Timers notice. No jsdom: pieces render to static markup.
 */

// Vitest compiles JSX with the classic runtime (the renderer build uses the automatic one).
;(globalThis as { React?: typeof React }).React = React

function config(patch: Partial<AgentConfigType> = {}): AgentConfigType {
  const base = JSON.parse(JSON.stringify(DEFAULT_AGENT_CONFIG)) as AgentConfigType
  return { ...base, id: '6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f', name: 'agent-1', handle: 'agent-1', ...patch } as AgentConfigType
}

const tools = (...decls: Array<Partial<ToolDeclaration> & { name: string }>): ToolDeclaration[] =>
  decls.map((d) => ({ enabled: true, visible: true, ...d }))

describe('permission vocabulary', () => {
  it('uses one-to-two-word labels, never "Agent can\'t change"', () => {
    expect(PERMISSION_LABELS).toMatchObject({ approval: 'Needs approval', locked: 'Locked', restricted: 'Restricted' })
    for (const text of [...Object.values(PERMISSION_LABELS), ...Object.values(PERMISSION_TIPS)]) {
      expect(text).not.toMatch(/agent can'?t change|HIL/i)
    }
    for (const label of Object.values(PERMISSION_LABELS)) expect(label.split(' ').length).toBeLessThanOrEqual(2)
  })

  it('reads the stored table level `authorized` as Restricted (the key does not change)', () => {
    expect(tableProtectionLabel('authorized')).toBe('Restricted')
    expect(tableProtectionLabel('append_only')).toBe('Append-only')
    expect(tableProtectionLabel('none')).toBe('No protection')
  })

  it('the legend names each icon with its tooltip', () => {
    const html = renderToStaticMarkup(<PermissionLegend kinds={['approval', 'locked', 'visible']} />)
    expect(html).toContain('Needs approval')
    expect(html).toContain('>Locked<')
    expect(html).toContain('Visible')
    expect(html).toContain(`title="${PERMISSION_TIPS.approval}"`)
  })

  it('a lock is a "Locked" badge the owner can click, never a disabled control', () => {
    const locked = renderToStaticMarkup(<LockBadge locked onClick={() => {}} />)
    expect(locked).toContain('Locked')
    expect(locked).not.toContain('disabled')
    const open = renderToStaticMarkup(<LockBadge locked={false} onClick={() => {}} />)
    expect(open).toContain('aria-label="Lock"')
  })
})

describe('tool rows set from another section', () => {
  const messaging = (patch: Record<string, unknown>) => ({ receive: true, mode: 'respond_only', inbox_mode: true, ...patch }) as AgentConfigType['messaging']

  it('Messaging is never gated by the On inbox message trigger (owner decision)', () => {
    const off = config({ triggers: { on_inbox: { enabled: false, targets: [] } } as AgentConfigType['triggers'], messaging: messaging({}) })
    expect(toolRowGate('msg_send', 'Messaging', off)).toBeNull()
    expect(toolRowGate('agent_discover', 'Messaging', off)).toBeNull()
  })

  it('Receive messages off: the msg_* tools say why, in one short phrase, and jump to Messaging', () => {
    const c = config({ messaging: messaging({ receive: false }) })
    for (const name of ['msg_send', 'agent_discover', 'msg_list', 'msg_read', 'msg_update']) {
      expect(toolRowGate(name, name.startsWith('msg_l') || name === 'msg_read' || name === 'msg_update' ? 'Inbox' : 'Messaging', c))
        .toEqual({ tip: 'Off: Receive messages is off', section: 'Messaging' })
    }
    expect(toolRowGate('fs_read', 'Filesystem', c)).toBeNull()
  })

  it('Inbox follows Inbox mode', () => {
    expect(toolRowGate('msg_delete', 'Inbox', config({ messaging: messaging({ inbox_mode: false }) }))).toEqual({ tip: 'Set by Inbox mode', section: 'Messaging' })
    expect(toolRowGate('msg_delete', 'Inbox', config({ messaging: messaging({}) }))).toBeNull()
  })

  it('one row-warning component: an icon with the reason as its tooltip, a button when it can jump', () => {
    const jump = renderToStaticMarkup(<RowWarning tip="Off: Receive messages is off" onJump={() => {}} />)
    expect(jump).toContain('<button')
    expect(jump).toContain('title="Off: Receive messages is off"')
    const plain = renderToStaticMarkup(<RowWarning tip={ASK_AUTONOMOUS_TIP} />)
    expect(plain).not.toContain('<button')
    expect(plain).toContain(`title="${ASK_AUTONOMOUS_TIP}"`)
  })

  it('filters by tool name or group label, case-insensitive', () => {
    expect(toolMatchesFilter('fs_read', 'Filesystem', '')).toBe(true)
    expect(toolMatchesFilter('fs_read', 'Filesystem', 'READ')).toBe(true)
    expect(toolMatchesFilter('fs_read', 'Filesystem', 'files')).toBe(true)
    expect(toolMatchesFilter('fs_read', 'Filesystem', 'msg')).toBe(false)
  })
})

describe('approval-removal undo', () => {
  const before = tools({ name: 'fs_write', restricted: true }, { name: 'fs_delete', restricted: true }, { name: 'fs_read' })

  it('counts only tools that lost their approval gate', () => {
    const after = before.map((t) => ({ ...t, restricted: undefined }))
    expect(approvalRemoved(before, after)).toEqual(['fs_write', 'fs_delete'])
    expect(approvalRemovedMessage(2)).toBe('Approval removed from 2 tools')
    expect(approvalRemovedMessage(1)).toBe('Approval removed from 1 tool')
    expect(approvalRemoved(after, before)).toEqual([])
  })

  it('Undo puts the gate back and leaves every other field as it is now', () => {
    const after = before.map((t) => ({ ...t, restricted: undefined, enabled: t.name !== 'fs_delete' }))
    const restored = restoreApproval(after, ['fs_write', 'fs_delete'])
    expect(restored.map((t) => [t.name, !!t.restricted, t.enabled])).toEqual([
      ['fs_write', true, true], ['fs_delete', true, false], ['fs_read', false, true],
    ])
  })

  it('the toast names the count and offers Undo', () => {
    const html = renderToStaticMarkup(<UndoToast message={approvalRemovedMessage(3)} onUndo={() => {}} onDismiss={() => {}} />)
    expect(html).toContain('Approval removed from 3 tools')
    expect(html).toContain('>Undo<')
  })
})

describe('save status', () => {
  it('Saving…, Saved, and Not saved: <reason> with Retry', () => {
    expect(saveStatusText({ kind: 'saving' })).toBe('Saving…')
    expect(saveStatusText({ kind: 'saved' })).toBe('Saved')
    const html = renderToStaticMarkup(<SaveStatusLine status={{ kind: 'error', error: 'No workspace open' }} onRetry={() => {}} onDiscard={() => {}} />)
    expect(html).toContain('Not saved: No workspace open')
    expect(html).toContain('role="alert"')
    expect(html).toContain('>Retry<')
    expect(renderToStaticMarkup(<SaveStatusLine status={{ kind: 'idle' }} onRetry={() => {}} onDiscard={() => {}} />)).toBe('')
  })

  it('takes the reason from the refusal or the error', () => {
    expect(saveFailureReason({ success: false, error: 'No workspace open' })).toBe('No workspace open')
    expect(saveFailureReason(new Error('IPC timed out'))).toBe('IPC timed out')
    expect(saveFailureReason({ success: false })).toBe('The save was refused')
  })
})

describe('MCP status', () => {
  it('labels connected, connecting and failed', () => {
    expect(mcpStatusView('connected')).toEqual({ label: 'Connected', tone: 'ok' })
    expect(mcpStatusView('connecting')).toEqual({ label: 'Connecting', tone: 'pending' })
    expect(mcpStatusView('error')).toEqual({ label: 'Failed', tone: 'failed' })
    expect(mcpStatusView(undefined)).toBeNull()
    expect(renderToStaticMarkup(<McpStatusChip status="error" />)).toContain('Failed')
    expect(renderToStaticMarkup(<McpStatusChip status={undefined} />)).toBe('')
  })
})

describe('Timers notice', () => {
  it('shows when the On timer trigger is off, with a jump to Triggers', () => {
    expect(timersBlocked(config({ triggers: { on_timer: { enabled: false, targets: [] } } as AgentConfigType['triggers'] }))).toBe(true)
    expect(timersBlocked(config({ triggers: {} as AgentConfigType['triggers'] }))).toBe(true)
    expect(timersBlocked(config({ triggers: { on_timer: { enabled: true, targets: [] } } as AgentConfigType['triggers'] }))).toBe(false)
    expect(timersBlocked(null)).toBe(false)
    const html = renderToStaticMarkup(<TimersBlockedNotice onJump={() => {}} />)
    expect(html).toContain(`title="${TIMERS_BLOCKED_TIP}"`)
    expect(html).toContain('>Off<')
    expect(html).toContain('Triggers ›')
  })
})

describe('the Config panel (template mode render)', () => {
  const render = (c: AgentConfigType) => renderToStaticMarkup(<AgentConfig template={{ value: c, onChange: () => {} }} />)
  const checkboxFor = (html: string, toolName: string): string => {
    const at = html.indexOf(`>${toolName}</span>`)
    expect(at).toBeGreaterThan(-1)
    const box = html.slice(at).match(/<input type="checkbox"[^>]*>/)
    return box?.[0] ?? ''
  }

  const withMsgSend = (c: AgentConfigType) => {
    c.tools = [...c.tools.filter((t) => t.name !== 'msg_send'), { name: 'msg_send', enabled: true, visible: true }]
    return c
  }

  it('Messaging tools stay editable and show the stored value with On inbox message off', () => {
    const html = render(withMsgSend(config({
      triggers: { on_inbox: { enabled: false, targets: [] } } as AgentConfigType['triggers'],
      messaging: { receive: true, mode: 'respond_only' } as AgentConfigType['messaging'],
    })))
    const box = checkboxFor(html, 'msg_send')
    expect(box).toContain('checked')
    expect(box).not.toContain('disabled')
    expect(html).not.toContain('Requires messaging')
  })

  it('Receive messages off: msg_send stays listed, shown as stored, not editable, with the reason on an icon', () => {
    const html = render(withMsgSend(config({ messaging: { receive: false, mode: 'respond_only' } as AgentConfigType['messaging'] })))
    const box = checkboxFor(html, 'msg_send')
    expect(box).toContain('checked')
    expect(box).toContain('disabled')
    expect(html).toContain('title="Off: Receive messages is off"')
  })

  it('ask in autonomous mode: an icon with a tooltip, no paragraph', () => {
    const c = config({ autonomous: true })
    c.tools = [...c.tools.filter((t) => t.name !== 'ask'), { name: 'ask', enabled: true, visible: true }]
    const html = render(c)
    expect(html).toContain(`title="${ASK_AUTONOMOUS_TIP}"`)
    expect(html).not.toContain('Enabling ask in autonomous mode')
  })

  it('shows the Tools legend and filter, and no old vocabulary', () => {
    const html = render(config())
    expect(html).toContain('Needs approval')
    expect(html).toContain('placeholder="Filter"')
    expect(html).not.toMatch(/HIL gate|>restricted</)
  })
})
