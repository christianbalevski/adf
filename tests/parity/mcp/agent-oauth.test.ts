import { existsSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { IPC } from '../../../src/shared/constants/ipc-channels'
import { embeddedBackend } from '../harness/backend'
import { DAEMON_BUNDLE, daemonBackend } from '../harness/daemon-backend'
import type { RawRecording } from '../harness/recording'
import { runScenario } from '../harness/scenario'
import { startFakeMcpServer, type FakeMcpServer } from './fake-mcp-server'
import { agentOAuthSignInScenario } from './scenarios'
import { withFakeServer } from './with-fake-server'

/**
 * An agent's own MCP OAuth sign-in (tracker W2-C2), embedded and daemon mode:
 * the owner approves `mcp_oauth_signin`, the authorization page opens in the
 * browser once and without a click (daemon mode: from the
 * `mcp_oauth_authorize` request on the client session's approvals,
 * mcp/oauth-authorize.ts), the server connects and the turn ends with the
 * tool's success. The outcome of both backends must be the same. (The full
 * recordings are not compared: the approvals hub's coalesced snapshot lands
 * at a different point of the turn from run to run, in either mode.)
 */

let fake: FakeMcpServer
beforeAll(async () => { fake = await startFakeMcpServer() })
afterAll(async () => { await fake?.close() })

type Event = { type?: string; payload?: { name?: string; result?: { content?: unknown; isError?: boolean } } }

/** What the owner sees: pages opened, the restart's result, what is still pending, the answer. */
function outcome(raw: RawRecording, port: number) {
  const opened = raw.local.filter((c) => c.api === 'shell.openExternal').map((c) => String(c.args[0]))
  const events = raw.pushes.filter((p) => p.channel === IPC.AGENT_EVENT).map((p) => p.args[0] as Event)
  const restart = events.find((e) => e.type === 'tool_call_result' && e.payload?.name === 'mcp_restart')
  const content = JSON.parse(String(restart?.payload?.result?.content ?? '{}')) as { success?: boolean; tools_discovered?: number }
  const snapshots = raw.pushes.filter((p) => p.channel === IPC.APPROVALS_CHANGED).map((p) => p.args[0] as { pending?: unknown[] })
  const invoke = raw.steps.find((s) => s.kind === 'invoke' && s.channel === IPC.AGENT_INVOKE)
  return {
    opened: opened.map((url) => new URL(url).origin + new URL(url).pathname),
    restart: { isError: restart?.payload?.result?.isError, success: content.success, toolsDiscovered: content.tools_discovered },
    pendingAtEnd: snapshots.at(-1)?.pending?.length,
    answer: invoke?.kind === 'invoke' ? invoke.result : undefined,
    authorizePage: `https://127.0.0.1:${port}/authorize`,
  }
}

describe('MCP OAuth sign-in from an agent\'s loop (mcp_oauth_signin)', () => {
  it('embedded: the page opens once without a click, the server connects', async () => {
    const result = await runScenario(agentOAuthSignInScenario(() => fake.oauthUrl), withFakeServer(() => fake)(embeddedBackend))
    expect(outcome(result.raw, fake.port)).toEqual({
      opened: [`https://127.0.0.1:${fake.port}/authorize`],
      restart: { isError: false, success: true, toolsDiscovered: 1 },
      pendingAtEnd: 0,
      answer: { success: true },
      authorizePage: `https://127.0.0.1:${fake.port}/authorize`,
    })
  }, 120_000)

  it.skipIf(!existsSync(DAEMON_BUNDLE))('daemon mode: the same outcome, the page opened from the client session\'s approvals', async () => {
    const scenario = agentOAuthSignInScenario(() => fake.oauthUrl)
    const embedded = await runScenario(scenario, withFakeServer(() => fake)(embeddedBackend))
    const daemon = await runScenario(scenario, withFakeServer(() => fake)(daemonBackend()), { tolerant: true })
    expect(outcome(daemon.raw, fake.port)).toEqual(outcome(embedded.raw, fake.port))
    // The daemon raised the page as its own request, and settled it.
    const snapshots = daemon.raw.pushes.filter((p) => p.channel === IPC.APPROVALS_CHANGED).map((p) => p.args[0] as { pending?: Array<{ toolName?: string }> })
    expect(snapshots.some((s) => s.pending?.some((e) => e.toolName === 'mcp_oauth_authorize'))).toBe(true)
  }, 240_000)

  it.skipIf(!existsSync(DAEMON_BUNDLE))('remote mode: the same outcome; the page opens after a question naming both hosts, and its callback goes through the relay (W4-B)', async () => {
    const scenario = agentOAuthSignInScenario(() => fake.oauthUrl)
    const embedded = await runScenario(scenario, withFakeServer(() => fake)(embeddedBackend))
    const remote = await runScenario(scenario, withFakeServer(() => fake)(daemonBackend({ remote: true })), { tolerant: true })
    expect(outcome(remote.raw, fake.port)).toEqual(outcome(embedded.raw, fake.port))
    // Asked first (remote mode opens no page without a click), naming the page's host.
    const asked = remote.raw.local.filter((c) => c.api === 'dialog.showMessageBox').map((c) => c.args[0] as { message?: string })
    expect(asked.some((m) => m.message === `Open a sign-in page on 127.0.0.1:${fake.port}?`)).toBe(true)
  }, 240_000)
})
