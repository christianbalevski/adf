import { existsSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { IPC } from '../../../src/shared/constants/ipc-channels'
import { embeddedBackend, type ParityBackend } from '../harness/backend'
import { DAEMON_BUNDLE, daemonBackend } from '../harness/daemon-backend'
import type { FakeElectron } from '../harness/electron-fake'
import { parityCases } from '../harness/parity-cases'
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
 * tool's success.
 *
 * The full recordings are compared (parityCases). The approvals hub pushes
 * its snapshot 50 ms after a change (approval-hub.ts NOTIFY_COALESCE_MS),
 * on its own timer, so where a snapshot lands among the turn's events
 * depended on how fast the sign-in ran. The fake server pins it, on every
 * backend alike (withApprovalGates): it holds the client registration until
 * the window got the snapshot without the `mcp_oauth_signin` request (the
 * resolve's snapshot), and the authorized `initialize` until the window's
 * latest snapshot has nothing pending (daemon mode: the settled
 * `mcp_oauth_authorize`). Each snapshot then lands at one point of the flow.
 */

let fake: FakeMcpServer
beforeAll(async () => { fake = await startFakeMcpServer() })
afterAll(async () => { await fake?.close() })

type Snapshot = { pending?: Array<{ toolName?: string }> }
/** How long a gate waits for its snapshot; past it the request goes on (the recording shows the difference). */
const GATE_TIMEOUT_MS = 10_000

/** Resolves once the window's latest APPROVALS_CHANGED snapshot satisfies `ready`. */
function latestApprovals(electron: FakeElectron, ready: (snapshot: Snapshot) => boolean): Promise<void> {
  const latest = (): Snapshot | null => {
    for (let i = electron.pushes.length - 1; i >= 0; i--) {
      if (electron.pushes[i].channel === IPC.APPROVALS_CHANGED) return electron.pushes[i].args[0] as Snapshot
    }
    return null
  }
  return new Promise<void>((resolve) => {
    let done = false
    const check = () => {
      const snapshot = latest()
      if (done || !snapshot || !ready(snapshot)) return
      done = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => { done = true; resolve() }, GATE_TIMEOUT_MS)
    electron.onPush(check)
    check()
  })
}

/** The fake server's gates for one run, on the window of the backend being booted. */
function withApprovalGates(backend: ParityBackend): ParityBackend {
  return {
    name: backend.name,
    async boot(env, electron) {
      fake.gates = {
        register: () => latestApprovals(electron, (s) => !s.pending?.some((e) => e.toolName === 'mcp_oauth_signin')),
        connect: () => latestApprovals(electron, (s) => (s.pending?.length ?? 0) === 0),
      }
      return backend.boot(env, electron)
    },
  }
}

const scenario = agentOAuthSignInScenario(() => fake.oauthUrl)
parityCases('mcp, an agent\'s own OAuth sign-in', [scenario], [], { backend: (b) => withApprovalGates(withFakeServer(() => fake)(b)) })

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
  }
}

const SIGNED_IN = () => ({
  opened: [`https://127.0.0.1:${fake.port}/authorize`],
  restart: { isError: false, success: true, toolsDiscovered: 1 },
  pendingAtEnd: 0,
  answer: { success: true },
})

describe('MCP OAuth sign-in from an agent\'s loop (mcp_oauth_signin), without the gates', () => {
  it('embedded: the page opens once without a click, the server connects', async () => {
    fake.gates = null
    const result = await runScenario(scenario, withFakeServer(() => fake)(embeddedBackend))
    expect(outcome(result.raw, fake.port)).toEqual(SIGNED_IN())
  }, 120_000)

  it.skipIf(!existsSync(DAEMON_BUNDLE))('daemon mode: the same outcome, the page opened from the client session\'s approvals', async () => {
    fake.gates = null
    const daemon = await runScenario(scenario, withFakeServer(() => fake)(daemonBackend()), { tolerant: true })
    expect(outcome(daemon.raw, fake.port)).toEqual(SIGNED_IN())
    // The daemon raised the page as its own request, and settled it.
    const snapshots = daemon.raw.pushes.filter((p) => p.channel === IPC.APPROVALS_CHANGED).map((p) => p.args[0] as Snapshot)
    expect(snapshots.some((s) => s.pending?.some((e) => e.toolName === 'mcp_oauth_authorize'))).toBe(true)
  }, 240_000)

  it.skipIf(!existsSync(DAEMON_BUNDLE))('remote mode: the same outcome; the page opens after a question naming both hosts, and its callback goes through the relay (W4-B)', async () => {
    fake.gates = null
    const remote = await runScenario(scenario, withFakeServer(() => fake)(daemonBackend({ remote: true })), { tolerant: true })
    expect(outcome(remote.raw, fake.port)).toEqual(SIGNED_IN())
    // Asked first (remote mode opens no page without a click), naming the page's host.
    const asked = remote.raw.local.filter((c) => c.api === 'dialog.showMessageBox').map((c) => c.args[0] as { message?: string })
    expect(asked.some((m) => m.message === `Open a sign-in page on 127.0.0.1:${fake.port}?`)).toBe(true)
  }, 240_000)
})
