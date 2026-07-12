import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', on: () => {}, getName: () => 't', getVersion: () => '0' },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
  shell: { openExternal: async () => {} },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
  BrowserWindow: class {},
  dialog: {}
}))

import { buildAgentCard } from '../../../src/main/services/mesh-server'
import { ServingApiRouteSchema } from '../../../src/main/adf/adf-schema'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import type { ServableAgent } from '../../../src/main/runtime/mesh-manager'
import type { ServingApiRoute } from '../../../src/shared/types/adf-v02.types'

let dir: string
let workspace: AdfWorkspace

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'adf-endpoint-ns-'))
  workspace = AdfWorkspace.create(join(dir, 'agent.adf'), { name: 'flat-ns-test' })
  workspace.generateIdentityKeys(null)
})

afterAll(() => {
  workspace.dispose()
  rmSync(dir, { recursive: true, force: true })
})

function makeAgent(api?: ServingApiRoute[]): ServableAgent {
  const config = workspace.getAgentConfig()
  if (api) config.serving = { ...(config.serving ?? {}), api }
  return {
    handle: 'flat-ns-test',
    filePath: workspace.getFilePath(),
    config,
    workspace,
    triggerEvaluator: null,
    adfCallHandler: null,
    codeSandboxService: null,
    getSigningKey: () => workspace.getSigningKeys(null)?.privateKey ?? null
  }
}

describe('buildAgentCard endpoint namespace (flat /:handle/*, no /mesh)', () => {
  it('derives protocol mailboxes directly under the handle', () => {
    const card = buildAgentCard(makeAgent(), '127.0.0.1', 7295)
    expect(card.endpoints.inbox).toBe('http://127.0.0.1:7295/flat-ns-test/inbox')
    expect(card.endpoints.card).toBe('http://127.0.0.1:7295/flat-ns-test/card')
    expect(card.endpoints.health).toBe('http://127.0.0.1:7295/flat-ns-test/health')
    // No endpoint carries the retired /mesh/ segment.
    for (const url of Object.values(card.endpoints)) {
      expect(url).not.toContain('/mesh/')
    }
  })

  it('has no ws endpoint when the agent declares no WS route', () => {
    const card = buildAgentCard(makeAgent([]), '127.0.0.1', 7295)
    expect(card.endpoints.ws).toBeUndefined()
  })

  it('derives the ws endpoint from the WS route\'s own path, not a fixed /mesh/ws', () => {
    const card = buildAgentCard(
      makeAgent([{ method: 'WS', path: 'live', lambda: 'ws.ts:handler' }]),
      '127.0.0.1',
      7295
    )
    expect(card.endpoints.ws).toBe('ws://127.0.0.1:7295/flat-ns-test/live')
  })

  it('normalizes a leading slash on the WS route path', () => {
    const card = buildAgentCard(
      makeAgent([{ method: 'WS', path: '/stream/v1', lambda: 'ws.ts:handler' }]),
      '127.0.0.1',
      7295
    )
    expect(card.endpoints.ws).toBe('ws://127.0.0.1:7295/flat-ns-test/stream/v1')
  })
})

describe('ServingApiRouteSchema reserved-segment rejection', () => {
  for (const reserved of ['inbox', 'card', 'health']) {
    it(`rejects a route claiming the reserved segment "${reserved}"`, () => {
      const bare = ServingApiRouteSchema.safeParse({ method: 'GET', path: reserved, lambda: 'x.ts:f' })
      expect(bare.success).toBe(false)
      // Leading slash and nested paths under a reserved first segment are also rejected.
      const slashed = ServingApiRouteSchema.safeParse({ method: 'GET', path: `/${reserved}`, lambda: 'x.ts:f' })
      expect(slashed.success).toBe(false)
      const nested = ServingApiRouteSchema.safeParse({ method: 'POST', path: `${reserved}/sub`, lambda: 'x.ts:f' })
      expect(nested.success).toBe(false)
    })
  }

  it('allows non-reserved paths, including WS at an agent-chosen path', () => {
    expect(ServingApiRouteSchema.safeParse({ method: 'GET', path: 'dashboard', lambda: 'x.ts:f' }).success).toBe(true)
    expect(ServingApiRouteSchema.safeParse({ method: 'WS', path: 'live', lambda: 'ws.ts:f' }).success).toBe(true)
    // A segment that merely starts with a reserved word is not itself reserved.
    expect(ServingApiRouteSchema.safeParse({ method: 'GET', path: 'inboxes', lambda: 'x.ts:f' }).success).toBe(true)
  })
})
