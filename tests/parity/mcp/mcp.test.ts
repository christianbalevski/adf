import { afterAll, beforeAll } from 'vitest'
import type { ParityBackend } from '../harness/backend'
import { parityCases } from '../harness/parity-cases'
import { completeFakeAuthorization, startFakeMcpServer, type FakeMcpServer } from './fake-mcp-server'
import { adapterTelegramScenario, connectTestScenario, installProgressScenario, mcpAttachCredentialsScenario, oauthConnectScenario } from './scenarios'

/**
 * Parity: MCP, channel adapters, sandbox packages (tracker W3-C). The
 * remote MCP server and its OAuth authorization server are one loopback
 * server (fake-mcp-server.ts), started once for the file. Each backend is
 * wrapped so that the run may reach it (the daemon child reads its fence
 * ports at spawn) and so that an authorization page of it that Studio opens
 * is signed in to, as a browser would (completeFakeAuthorization).
 */

let fake: FakeMcpServer
beforeAll(async () => { fake = await startFakeMcpServer() })
afterAll(async () => { await fake?.close() })

function withFakeServer(backend: ParityBackend): ParityBackend {
  return {
    name: backend.name,
    async boot(env, electron) {
      env.allowPort(fake.port)
      const shell = electron.module.shell as { openExternal(url: string): Promise<void> }
      const open = shell.openExternal.bind(shell)
      shell.openExternal = async (url: string) => {
        await open(url)
        void completeFakeAuthorization(url, fake.port, (p) => env.allowPort(p))
      }
      const booted = await backend.boot(env, electron)
      const own = booted.normalization?.bind(booted)
      return Object.assign(booted, {
        normalization: () => {
          const extra = own?.() ?? {}
          return { ...extra, ports: [...(extra.ports ?? []), { value: String(fake.port), name: 'FAKE_MCP_PORT' }] }
        },
      })
    },
  }
}

parityCases('mcp', [
  installProgressScenario,
  mcpAttachCredentialsScenario,
  adapterTelegramScenario,
  connectTestScenario(() => fake.url),
  oauthConnectScenario(() => fake.oauthUrl),
], [], { backend: withFakeServer })
