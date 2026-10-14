import { existsSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { embeddedBackend, type ParityBackend } from '../harness/backend'
import { DAEMON_BUNDLE, daemonBackend } from '../harness/daemon-backend'
import { diffRendered } from '../harness/format'
import { runScenario, type ParityScenario } from '../harness/scenario'
import { renderView, W3C_GAPS, w3cView } from './compare'
import { completeFakeAuthorization, startFakeMcpServer, type FakeMcpServer } from './fake-mcp-server'
import { adapterTelegramScenario, connectTestScenario, installProgressScenario, mcpAttachCredentialsScenario, oauthConnectScenario } from './scenarios'

/**
 * W3-C parity (tracker W3-C): each scenario runs against embedded Studio and
 * against Studio in daemon mode on the built daemon in a child process, and
 * the W3-C view of the two recordings (compare.ts) must be the same, apart
 * from the by-design entries of W3C_GAPS. Each entry must match in every
 * scenario it applies to. The embedded view is also held to its committed
 * recording (recordings/), so an embedded change shows up here first.
 *
 * Needs out/main/daemon.js (`npx electron-vite build`); without it only the
 * embedded side runs, as in daemon.test.ts.
 */

const BUNDLE = existsSync(DAEMON_BUNDLE)
let fake: FakeMcpServer

/**
 * A backend whose run may also reach the fake MCP server (the daemon child
 * reads its fence ports at spawn), with a browser: an authorization page of
 * the fake that Studio opens is signed in to (completeFakeAuthorization).
 */
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

const connectTest = connectTestScenario(() => fake.url)
const oauthConnect = oauthConnectScenario(() => fake.oauthUrl)
const SCENARIOS: Array<{ scenario: ParityScenario; gaps: readonly string[] }> = [
  { scenario: installProgressScenario, gaps: [] },
  { scenario: mcpAttachCredentialsScenario, gaps: ['mode:mcp-credential-values'] },
  { scenario: adapterTelegramScenario, gaps: ['mode:adapter-credential-values'] },
  { scenario: connectTest, gaps: [] },
  { scenario: oauthConnect, gaps: [] },
]

beforeAll(async () => { fake = await startFakeMcpServer() })
afterAll(async () => { await fake?.close() })

describe('parity W3-C: MCP, adapters, sandbox packages', () => {
  for (const { scenario, gaps } of SCENARIOS) {
    it(`${scenario.name}: embedded matches its recording${BUNDLE ? '; daemon mode matches embedded apart from the named gaps' : ''}`, async () => {
      const embedded = w3cView((await runScenario(scenario, withFakeServer(embeddedBackend))).normalized)
      await expect(renderView(embedded)).toMatchFileSnapshot(`recordings/${scenario.name}.embedded.txt`)
      if (!BUNDLE) return
      const daemon = w3cView((await runScenario(scenario, withFakeServer(daemonBackend()), { tolerant: true })).normalized)
      for (const gap of W3C_GAPS) {
        const n = gap.apply(daemon, embedded)
        if (gaps.includes(gap.id)) expect(n, `${gap.id} matched nothing in ${scenario.name} (fixed? drop it from the scenario's list)`).toBeGreaterThan(0)
        else expect(n, `${gap.id} matched in ${scenario.name}, which does not list it`).toBe(0)
      }
      expect(diffRendered(renderView(embedded), renderView(daemon), { expected: 'embedded', actual: 'daemon (after W3-C gaps)' })).toBe('')
    }, 240_000)
  }
})
