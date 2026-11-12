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

afterEach(() => { vi.unstubAllGlobals(); applied.length = 0 })

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

async function probed(servers: McpServerRegistration[]): Promise<unknown[]> {
  const calls: unknown[] = []
  vi.stubGlobal('window', { adfApi: { mcpOAuthStatus: async (args: unknown) => { calls.push(args); return {} } } })
  const { McpStatusDashboard } = await import('../../../src/renderer/components/mcp/McpStatusDashboard')
  renderToStaticMarkup(<McpStatusDashboard mcpServers={servers} onServersChanged={() => {}} flushSave={async () => { calls.push('flushSave') }} />)
  await flush()
  return calls
}

/** A flush that never settles: an ask made only after it never goes out. */
async function probedHanging(servers: McpServerRegistration[], answer: unknown = {}): Promise<unknown[]> {
  const calls: unknown[] = []
  vi.stubGlobal('window', { adfApi: { mcpOAuthStatus: async (args: unknown) => { calls.push(args); return answer } } })
  const { McpStatusDashboard } = await import('../../../src/renderer/components/mcp/McpStatusDashboard')
  renderToStaticMarkup(<McpStatusDashboard mcpServers={servers} onServersChanged={() => {}} flushSave={() => { calls.push('flushSave'); return new Promise<void>(() => {}) }} />)
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
