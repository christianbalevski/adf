import { afterAll, beforeAll } from 'vitest'
import { parityCases } from '../harness/parity-cases'
import { startFakeMcpServer, type FakeMcpServer } from './fake-mcp-server'
import { withFakeServer } from './with-fake-server'
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

parityCases('mcp', [
  installProgressScenario,
  mcpAttachCredentialsScenario,
  adapterTelegramScenario,
  connectTestScenario(() => fake.url),
  oauthConnectScenario(() => fake.oauthUrl),
], [], { backend: withFakeServer(() => fake) })
