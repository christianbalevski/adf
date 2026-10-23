// Per-agent owner-identity routes and identity drafts (W1-D). Shape parity:
// each route returns what Studio's IDENTITY_* handler returns, i.e. the
// shared action (services/envelope-actions.ts) on the agent's workspace with
// the owner identity service. The daemon identity is a stand-in exposing the
// public surface the routes use (isReady, service). No response carries a
// key, a password or a private key.
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ userDataDir: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => h.userDataDir, on: () => {}, getName: () => 't', getVersion: () => '0' },
  // A usable (fake) keychain: Studio stores no secret without one unless the user chose plain text.
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
  shell: { openExternal: async () => {} },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
  BrowserWindow: class {},
  dialog: {},
}))

import { AdfWorkspace } from '../src/main/adf/adf-workspace'
import { createDaemonHttpApi } from '../src/main/daemon/http-api'
import { setWorkspaceIdentityHooks, unlockWorkspaceEnvelopes } from '../src/main/runtime/identity-provisioner'
import { MockLLMProvider } from '../src/main/runtime/headless'
import { RuntimeService } from '../src/main/runtime/runtime-service'
import { readAttestations, readEnvelopeStatus } from '../src/main/services/envelope-actions'
import { identityDrafts } from '../src/main/services/identity-drafts'
import { SettingsService } from '../src/main/services/settings.service'

let root: string
let settings: SettingsService
const cleanups: Array<() => Promise<unknown> | unknown> = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'adf-daemon-owner-env-'))
  h.userDataDir = join(root, 'userData')
  mkdirSync(h.userDataDir, { recursive: true })
  settings = new SettingsService()
  settings.getOwnerIdentity().ensureIdentity()
  const svc = settings.getOwnerIdentity()
  setWorkspaceIdentityHooks({ ensureIdentity: (ws) => { svc.ensureWorkspaceIdentity(ws) }, unlockEnvelopes: (ws) => svc.unlockWorkspaceEnvelopes(ws) })
})

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
  setWorkspaceIdentityHooks({ ensureIdentity: () => {}, unlockEnvelopes: () => {} })
  identityDrafts.clear()
  rmSync(root, { recursive: true, force: true })
})

function setup(ready = true) {
  const runtime = new RuntimeService({ enforceReviewGate: false, providerFactory: () => new MockLLMProvider() })
  const identity = { isReady: () => ready, service: settings.getOwnerIdentity() }
  const server = createDaemonHttpApi(runtime, { identity: identity as never })
  cleanups.push(async () => { for (const a of runtime.listAgents()) await runtime.unloadAgent(a.id) })
  cleanups.push(() => server.close())
  return { runtime, server }
}

async function loadAgent(runtime: RuntimeService, handle: string, provision = true): Promise<{ id: string; workspace: AdfWorkspace }> {
  const filePath = join(root, `${handle}.adf`)
  const ws = AdfWorkspace.create(filePath, { name: handle })
  try {
    ws.setAgentConfig({ ...ws.getAgentConfig(), id: randomUUID(), handle })
    if (provision) settings.getOwnerIdentity().ensureWorkspaceIdentity(ws)
  } finally {
    ws.close()
  }
  const ref = await runtime.loadAgent(filePath)
  return { id: ref.id, workspace: runtime.listLiveAgents().find((a) => a.agentId === ref.id)!.workspace }
}

describe('attestations and envelope routes', () => {
  it('return the shared actions on the loaded workspace', async () => {
    const { runtime, server } = setup()
    const { id, workspace } = await loadAgent(runtime, 'agent-1')
    const svc = settings.getOwnerIdentity()

    const atts = await server.inject({ method: 'GET', url: `/agents/${id}/attestations` })
    expect(atts.json()).toEqual(JSON.parse(JSON.stringify(readAttestations(workspace))))
    expect(atts.json().attestations.length).toBeGreaterThan(0)

    const reissue = await server.inject({ method: 'POST', url: '/agents/agent-1/attestations/reissue' })
    expect(reissue.json()).toMatchObject({ success: true })

    const status = await server.inject({ method: 'GET', url: `/agents/${id}/envelope` })
    expect(status.json()).toEqual(readEnvelopeStatus(workspace, svc, unlockWorkspaceEnvelopes))
    expect(status.json()).toEqual({ success: true, identity: 'unlocked', credentials: 'unlocked', sharePasswordSet: false })

    const short = await server.inject({ method: 'PUT', url: `/agents/${id}/envelope/share-password`, payload: { password: 'short' } })
    expect(short.json()).toEqual({ success: false, error: 'Share password must be at least 8 characters' })
    const set = await server.inject({ method: 'PUT', url: `/agents/${id}/envelope/share-password`, payload: { password: 'correct horse battery' } })
    expect(set.json()).toEqual({ success: true })
    expect((await server.inject({ method: 'GET', url: `/agents/${id}/envelope` })).json().sharePasswordSet).toBe(true)

    // An envelope this runtime already unlocked accepts any password (the
    // cached DEK); the wrong-password path is covered on a locked file in
    // tests/unit/services/envelope-actions.test.ts.
    const right = await server.inject({ method: 'POST', url: `/agents/${id}/envelope/unlock-password`, payload: { password: 'correct horse battery', adopt: false } })
    expect(right.json()).toEqual({ success: true, adopted: false, credentials: 'unlocked' })
    expect(right.body).not.toContain('correct horse battery')

    expect((await server.inject({ method: 'DELETE', url: `/agents/${id}/envelope/share-password` })).json()).toEqual({ success: true })
    expect((await server.inject({ method: 'GET', url: `/agents/${id}/envelope` })).json().sharePasswordSet).toBe(false)

    expect((await server.inject({ method: 'GET', url: '/agents/agent-9/envelope' })).statusCode).toBe(404)
  })

  it('without a ready owner, reissue and claim refuse with the owner message', async () => {
    const { runtime, server } = setup(false)
    const { id } = await loadAgent(runtime, 'agent-2', false)
    expect((await server.inject({ method: 'POST', url: `/agents/${id}/attestations/reissue` })).json())
      .toEqual({ success: false, error: 'No owner identity on this host — create or restore it first (`adf identity`).' })
    expect((await server.inject({ method: 'POST', url: `/agents/${id}/claim` })).json())
      .toEqual({ success: false, error: 'Error: No owner identity on this host — create or restore it first (`adf identity`).' })
  })
})

describe('POST /agents/:id/claim', () => {
  it('claims an identity-less file under the local owner', async () => {
    const { runtime, server } = setup()
    const { id, workspace } = await loadAgent(runtime, 'agent-3', false)
    expect(workspace.getDid()).toBeNull()
    const res = await server.inject({ method: 'POST', url: `/agents/${id}/claim` })
    expect(res.json()).toEqual({ success: true, did: workspace.getDid() })
    expect(workspace.getMeta('adf_owner_did')).toBe(settings.getOwnerIdentity().getOwnerDid())
    expect(res.body).not.toMatch(/private/i)
  })

  it('a claim that removes the whole-file password drops the file key: a later write survives a restart', async () => {
    const { runtime, server } = setup()
    const filePath = join(root, 'agent-5.adf')
    const ws = AdfWorkspace.create(filePath, { name: 'agent-5' })
    try {
      ws.setAgentConfig({ ...ws.getAgentConfig(), id: randomUUID(), handle: 'agent-5' })
      ws.setIdentity('app:old', 'old-value')
      ws.setPassword('legacy-pw')
    } finally {
      ws.close()
    }
    const { id } = await runtime.loadAgent(filePath)
    expect((await server.inject({ method: 'POST', url: `/agents/${id}/identity/password/unlock`, payload: { password: 'legacy-pw' } })).statusCode).toBe(200)
    expect((await server.inject({ method: 'POST', url: `/agents/${id}/claim` })).json()).toMatchObject({ success: true })
    expect((await server.inject({ method: 'GET', url: `/agents/${id}/identity/password` })).json()).toMatchObject({ needsPassword: false, unlocked: false })
    expect((await server.inject({ method: 'PUT', url: `/agents/${id}/identity/app:new`, payload: { value: 'new-value' } })).statusCode).toBe(200)
    await runtime.unloadAgent(id)

    // A fresh process opens the file with this owner's keys and no file key.
    const reopened = AdfWorkspace.open(filePath)
    try {
      unlockWorkspaceEnvelopes(reopened)
      expect(reopened.isPasswordProtected()).toBe(false)
      expect(reopened.getIdentityDecrypted('app:new', null)).toBe('new-value')
      expect(reopened.getIdentityDecrypted('app:old', null)).toBe('old-value')
    } finally {
      reopened.close()
    }
  })
})

describe('POST /agents/:id/identity/password/unlock: legacy conversion', () => {
  function legacyFile(handle: string, ownerDid?: string): string {
    const filePath = join(root, `${handle}.adf`)
    const ws = AdfWorkspace.create(filePath, { name: handle })
    try {
      ws.setAgentConfig({ ...ws.getAgentConfig(), id: randomUUID(), handle })
      if (ownerDid) ws.setMeta('adf_owner_did', ownerDid, 'readonly')
      ws.setIdentity('app:token', 'legacy-secret')
      ws.setPassword('legacy-pw')
    } finally {
      ws.close()
    }
    return filePath
  }

  it('converts the owner\'s own file as Studio does: no password, envelopes, the password kept as the share password', async () => {
    const { runtime, server } = setup()
    const filePath = legacyFile('agent-6')
    const { id } = await runtime.loadAgent(filePath)
    const res = await server.inject({ method: 'POST', url: `/agents/${id}/identity/password/unlock`, payload: { password: 'legacy-pw' } })
    expect(res.json()).toMatchObject({ success: true, converted: true })
    expect((await server.inject({ method: 'GET', url: `/agents/${id}/identity/password` })).json()).toMatchObject({ needsPassword: false, unlocked: false })
    expect((await server.inject({ method: 'GET', url: `/agents/${id}/envelope` })).json()).toEqual({ success: true, identity: 'unlocked', credentials: 'unlocked', sharePasswordSet: true })
    await runtime.unloadAgent(id)
    const reopened = AdfWorkspace.open(filePath)
    try {
      unlockWorkspaceEnvelopes(reopened)
      expect(reopened.isPasswordProtected()).toBe(false)
      expect(reopened.getIdentityDecrypted('app:token', null)).toBe('legacy-secret')
      expect(reopened.getDid()).toBeTruthy()
    } finally {
      reopened.close()
    }
  })

  it('leaves another owner\'s file as it is (the claim converts it)', async () => {
    const { runtime, server } = setup()
    const { id } = await runtime.loadAgent(legacyFile('agent-7', 'did:key:z6MkSomeoneElse'))
    expect((await server.inject({ method: 'POST', url: `/agents/${id}/identity/password/unlock`, payload: { password: 'legacy-pw' } })).json())
      .toMatchObject({ success: true, converted: false })
    expect((await server.inject({ method: 'GET', url: `/agents/${id}/identity/password` })).json()).toMatchObject({ needsPassword: true, unlocked: true })
  })
})

describe('identity drafts', () => {
  it('mint returns only { draftId, did }; discard is once', async () => {
    const { server } = setup()
    const minted = await server.inject({ method: 'POST', url: '/identity/drafts' })
    const body = minted.json() as { draftId: string; did: string }
    expect(Object.keys(body).sort()).toEqual(['did', 'draftId'])
    expect(body.did).toMatch(/^did:key:z/)
    expect(identityDrafts.size).toBe(1)
    expect((await server.inject({ method: 'DELETE', url: `/identity/drafts/${body.draftId}` })).json()).toEqual({ discarded: true })
    expect((await server.inject({ method: 'DELETE', url: `/identity/drafts/${body.draftId}` })).json()).toEqual({ discarded: false })
  })
})
