/**
 * Settings → MCP Servers asks main whether a row is signed in (mcpOAuthStatus)
 * for http OAuth rows by URL, exactly as before, and for rows with their own
 * auth command by name, after pending Settings edits are saved (main answers
 * from saved settings). The effects of a static render run inline (as in
 * multi-runtime-effects.test.tsx), so the status calls can be recorded.
 */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { McpServerRegistration } from '../../../src/shared/types/ipc.types'

;(globalThis as { React?: typeof React }).React = React

vi.mock('zustand', async (importOriginal) => {
  const z = await importOriginal<typeof import('zustand')>()
  const create = ((init: Parameters<typeof z.createStore>[0]) => {
    const api = z.createStore(init)
    api.getInitialState = api.getState
    const hook = (selector?: (s: unknown) => unknown) => z.useStore(api, selector as never)
    return Object.assign(hook, api)
  }) as unknown as typeof z.create
  return { ...z, create }
})

/** Each state update applied after the render, as its result from an empty state. */
const applied: unknown[] = []

// Only the sign-in status effect runs, after the render; state setters record what they apply.
vi.mock('react', async (importOriginal) => {
  const r = await importOriginal<typeof import('react')>()
  const inline = ((fn: () => unknown) => {
    if (/refreshOAuthStatus/.test(String(fn))) queueMicrotask(() => { fn() })
  }) as typeof r.useEffect
  const useState = ((init: unknown) => {
    const [value, set] = r.useState(init)
    return [value, (u: unknown) => { applied.push(typeof u === 'function' ? u({}) : u); set(u as never) }]
  }) as typeof r.useState
  return { ...r, default: { ...r, useEffect: inline, useLayoutEffect: inline, useState }, useEffect: inline, useLayoutEffect: inline, useState }
})

const actions = vi.hoisted(() => new Map<string, (event: { stopPropagation: () => void }) => void>())
const computeSheet = vi.hoisted(() => ({ acceptMcpOnHost: undefined as (() => Promise<boolean>) | undefined }))
vi.mock('../../../src/renderer/components/mcp/ComputeNeededSheet', () => ({
  ComputeNeededSheet: (props: { acceptMcpOnHost?: () => Promise<boolean> }) => {
    computeSheet.acceptMcpOnHost = props.acceptMcpOnHost
    return null
  },
}))
vi.mock('../../../src/renderer/components/common/Tooltip', () => ({
  Tooltip: ({ tip, children }: { tip: string; children: React.ReactElement<{ onClick?: (event: { stopPropagation: () => void }) => void; children?: unknown }> }) => {
    if (children.props.onClick) actions.set(children.props.children === 'Allow' ? 'Allow' : tip, children.props.onClick)
    return children
  },
}))

afterEach(() => { vi.unstubAllGlobals(); applied.length = 0; actions.clear() })

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

async function probed(servers: McpServerRegistration[]): Promise<unknown[]> {
  const calls: unknown[] = []
  vi.stubGlobal('window', { adfApi: { mcpOAuthStatus: async (args: unknown) => { calls.push(args); return {} } } })
  const { McpStatusDashboard } = await import('../../../src/renderer/components/mcp/McpStatusDashboard')
  renderToStaticMarkup(<McpStatusDashboard mcpServers={servers} onServersChanged={() => {}} flushSave={async () => { calls.push('flushSave'); return true }} />)
  await flush()
  return calls
}

/** A flush that never settles: an ask made only after it never goes out. */
async function probedHanging(servers: McpServerRegistration[], answer: unknown = {}): Promise<unknown[]> {
  const calls: unknown[] = []
  vi.stubGlobal('window', { adfApi: { mcpOAuthStatus: async (args: unknown) => { calls.push(args); return answer } } })
  const { McpStatusDashboard } = await import('../../../src/renderer/components/mcp/McpStatusDashboard')
  renderToStaticMarkup(<McpStatusDashboard mcpServers={servers} onServersChanged={() => {}} flushSave={() => { calls.push('flushSave'); return new Promise<boolean>(() => {}) }} />)
  await flush()
  return calls
}

describe('rows asked whether they are signed in', () => {
  it('http OAuth rows by URL and auth-command rows by name; a url+oauth row without type http is not asked, as before', async () => {
    const calls = await probed([
      { id: 'r', name: 'remote', type: 'http', url: 'https://mcp.example.test/mcp', oauth: true },
      { id: 'u', name: 'untyped', url: 'https://other.example.test/mcp', oauth: true },
      { id: 'g', name: 'gmail', type: 'npm', npmPackage: '@gongrzhe/server-gmail-autoauth-mcp', auth: true },
      { id: 'p', name: 'plain', type: 'npm', npmPackage: 'plain-mcp' },
    ])
    expect(calls).toEqual(['flushSave', { name: 'remote', url: 'https://mcp.example.test/mcp' }, { name: 'gmail' }])
  })

  it('with only an http OAuth row, nothing is flushed and the URL ask goes out at once', async () => {
    const calls = await probedHanging([
      { id: 'r', name: 'remote', type: 'http', url: 'https://mcp.example.test/mcp', oauth: true },
    ])
    expect(calls).toEqual([{ name: 'remote', url: 'https://mcp.example.test/mcp' }])
  })

  it('a URL ask does not wait for the flush; a by-name ask does', async () => {
    const calls = await probedHanging([
      { id: 'r', name: 'remote', type: 'http', url: 'https://mcp.example.test/mcp', oauth: true },
      { id: 'g', name: 'gmail', type: 'npm', npmPackage: '@gongrzhe/server-gmail-autoauth-mcp', auth: true },
    ])
    expect(calls).toEqual(['flushSave', { name: 'remote', url: 'https://mcp.example.test/mcp' }])
  })

  it('a URL answer is applied while the flush is still pending', async () => {
    await probedHanging([
      { id: 'r', name: 'remote', type: 'http', url: 'https://mcp.example.test/mcp', oauth: true },
      { id: 'g', name: 'gmail', type: 'npm', npmPackage: '@gongrzhe/server-gmail-autoauth-mcp', auth: true },
    ], { signedIn: true })
    expect(applied).toEqual([{ r: true }])
  })

  it('an auth row that also has a url (written outside the form) is asked by name', async () => {
    const calls = await probed([
      { id: 's', name: 'stale', type: 'npm', npmPackage: 'stale-mcp', url: 'https://stale.example.test/mcp', auth: true },
    ])
    expect(calls).toEqual(['flushSave', { name: 'stale' }])
  })
})

const authRow: McpServerRegistration = {
  id: 'g', name: 'gmail', type: 'npm', npmPackage: '@gongrzhe/server-gmail-autoauth-mcp',
  auth: true, runLocation: 'host', credentialStorage: 'app',
}

describe('sign-in refresh after Settings actions', () => {
  it.each(['refused', 'rejected'])('drops by-name answers after a %s save, without blocking URL answers', async (failure) => {
    const calls: unknown[] = []
    vi.stubGlobal('window', { adfApi: { mcpOAuthStatus: async (args: unknown) => {
      calls.push(args)
      return { byName: true, signedIn: false }
    } } })
    const { McpStatusDashboard } = await import('../../../src/renderer/components/mcp/McpStatusDashboard')
    renderToStaticMarkup(<McpStatusDashboard
      mcpServers={[{ ...authRow, credentialStorage: 'agent' }, { id: 'r', name: 'remote', type: 'http', url: 'https://mcp.example.test/mcp', oauth: true }]}
      onServersChanged={() => {}}
      flushSave={async () => { if (failure === 'rejected') throw new Error('not saved'); return false }}
    />)
    await flush()
    expect(calls).toEqual([{ name: 'remote', url: 'https://mcp.example.test/mcp' }])
    expect(applied).toContainEqual({}) // Removes a prior by-name answer instead of reusing it.
    expect(applied.some((value) => Object.hasOwn(value as object, 'g'))).toBe(false)
  })

  it('waits for inline Allow to finish saving compute, then asks again without a registration edit', async () => {
    let saved = false
    let finish!: () => void
    const commit = new Promise<void>((resolve) => { finish = () => { saved = true; resolve() } })
    const reads: boolean[] = []
    vi.stubGlobal('window', { adfApi: { mcpOAuthStatus: async () => {
      reads.push(saved)
      return saved ? { byName: true, signedIn: false } : { byName: true }
    } } })
    const { McpStatusDashboard } = await import('../../../src/renderer/components/mcp/McpStatusDashboard')
    renderToStaticMarkup(<McpStatusDashboard mcpServers={[authRow]} onServersChanged={() => {}}
      flushSave={async () => true} hostAccessEnabled={false} onAllowHost={() => commit} />)
    await flush()
    expect(reads).toEqual([false])
    expect(actions.has('Allow')).toBe(true)
    actions.get('Allow')!({ stopPropagation() {} })
    await flush()
    expect(reads).toEqual([false])
    finish()
    await flush()
    expect(reads).toEqual([false, true])
    expect(applied).toContainEqual({ g: false })
  })

  it('refreshes when Re-authorize writes credentials but the MCP connection fails', async () => {
    let signedIn = false
    const reads: boolean[] = []
    vi.stubGlobal('window', { adfApi: {
      mcpOAuthStatus: async () => { reads.push(signedIn); return { byName: true, signedIn } },
      testMcpRegistration: async () => { signedIn = true; return { success: false, authRan: true, error: 'tools/list failed' } },
    } })
    const { McpStatusDashboard } = await import('../../../src/renderer/components/mcp/McpStatusDashboard')
    renderToStaticMarkup(<McpStatusDashboard mcpServers={[authRow]} onServersChanged={() => {}} flushSave={async () => true} />)
    await flush()
    actions.get('Re-authorize')!({ stopPropagation() {} })
    await flush()
    expect(reads).toEqual([false, true])
    expect(applied).toContainEqual({ g: true })
  })
})

it('returns a completed host write without waiting for an unrelated hanging sign-in probe', async () => {
  let saved = false
  let finish!: () => void
  const commit = new Promise<boolean>((resolve) => { finish = () => { saved = true; resolve(true) } })
  const reads: boolean[] = []
  vi.stubGlobal('window', { adfApi: { mcpOAuthStatus: () => {
    reads.push(saved)
    return new Promise(() => {})
  } } })
  const { McpStatusDashboard } = await import('../../../src/renderer/components/mcp/McpStatusDashboard')
  renderToStaticMarkup(<McpStatusDashboard mcpServers={[authRow]} onServersChanged={() => {}}
    flushSave={async () => true} onAcceptMcpOnHost={() => commit} />)
  await flush()
  let result: boolean | undefined
  void computeSheet.acceptMcpOnHost!().then((value) => { result = value })
  await flush()
  expect(result).toBeUndefined()
  expect(reads).toEqual([false])
  finish()
  await flush()
  expect(result).toBe(true)
  expect(reads).toEqual([false, true])
})
