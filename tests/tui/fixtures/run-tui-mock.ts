// `npm run tui:mock` — the TUI against the in-memory mock daemon, so the shell
// can be seen without a real daemon. Every feature fixture is layered in front
// of the mock as a fetch chain (auth → identity → loops → fleet → files →
// inspect → trigger → mock), so each view works end to end. The consolidator inner loop "wakes"
// on a fake timer every 20s to show inner-loop activity streaming in.

import { startMockDaemon, AGENT_1_ID } from './mock-daemon'
import { createLoopsMock } from './loops-daemon'
import { createFleetFetch } from './fleet-mock'
import { createFilesFetch } from './files-daemon'
import { createInspectFixture } from './inspect-daemon'
import { triggerFetch } from './chat-script'
import { createIdentityFetch, type MockIdentityState } from './identity-daemon'
import { createAuthFetch } from './auth-daemon'

async function main(): Promise<void> {
  const mock = await startMockDaemon({ stepMs: 120 })
  const network = globalThis.fetch.bind(globalThis)
  const trigger = triggerFetch([], network)
  const inspect = createInspectFixture(mock.url, trigger)
  const files = createFilesFetch(mock, inspect.fetch)
  const fleet = createFleetFetch(mock, { trackedDirectories: ['./agents'], unread: { 'agent-1': 1 } }, files.fetch)
  const loops = createLoopsMock(mock, fleet.fetch)
  // Owner identity + new agents. ADF_MOCK_IDENTITY=none|locked|restore-needed|ready
  // (default ready), ADF_MOCK_STORAGE=file (passphrase file, passphrase
  // "correct horse" once it exists), ADF_MOCK_FLEET=empty (first run).
  const identityStatus = process.env.ADF_MOCK_IDENTITY as MockIdentityState | undefined
  const identity = createIdentityFetch(mock, {
    status: identityStatus && ['none', 'locked', 'restore-needed', 'ready'].includes(identityStatus) ? identityStatus : 'ready',
    storage: process.env.ADF_MOCK_STORAGE === 'file' ? 'file' : 'keychain',
    emptyFleet: process.env.ADF_MOCK_FLEET === 'empty',
  }, loops.fetch)
  // Provider sign-in: agent-2 runs on the ChatGPT subscription (not signed in,
  // so Fleet and Chat show the hint); /login finishes after two status polls.
  // The mock never opens a real browser.
  const auth = createAuthFetch({ agentProviders: { 'agent-2': 'chatgpt-sub' }, autoApproveAfterPolls: 2 }, identity.fetch)
  const { setAuthFlowSeams } = await import('../../../src/main/tui/auth/flow')
  setAuthFlowSeams({ openBrowser: () => {} })

  const tick = setInterval(() => {
    const agent = mock.agents.get(AGENT_1_ID)
    const loop = agent?.loops.find(l => l.name === 'consolidator')
    if (!agent || !loop?.enabled) return
    mock.emit({ event_type: 'timer.fired', agent_id: AGENT_1_ID, loop: 'consolidator', payload: { timer_id: 1, scope: 'agent', run_count: 4 } })
    loop.status = 'running'
    mock.emit({ event_type: 'agent.state.changed', agent_id: AGENT_1_ID, loop: 'consolidator', payload: { state: 'thinking' } })
    setTimeout(() => {
      const text = 'Consolidated 2 new notes into mind.md.'
      ;(agent.history.consolidator ??= []).push({ seq: Date.now(), role: 'assistant', content_json: [{ type: 'text', text }], created_at: Date.now(), model: 'mock-model' })
      mock.emit({ event_type: 'turn.delta', agent_id: AGENT_1_ID, loop: 'consolidator', payload: { kind: 'text', text } })
      mock.emit({ event_type: 'turn.completed', agent_id: AGENT_1_ID, loop: 'consolidator', payload: { content: text } })
      loop.status = 'idle'
      mock.emit({ event_type: 'agent.state.changed', agent_id: AGENT_1_ID, loop: 'consolidator', payload: { state: 'idle' } })
    }, 1500)
  }, 20_000)

  // Event firehose for the event tail: ADF_MOCK_EVENTS=5000 streams that many
  // events 3s after start (in bursts), ADF_MOCK_EVENT_RATE=50 then keeps
  // this many per second coming. Payloads include a large tool result.
  const burst = Number(process.env.ADF_MOCK_EVENTS ?? 0)
  const rate = Number(process.env.ADF_MOCK_EVENT_RATE ?? 0)
  let flood = 0
  const floodEvent = () => {
    const n = flood++
    const type = ['turn.delta', 'tool.started', 'tool.completed', 'agent.state.changed', 'llm.completed'][n % 5]
    mock.emit({
      event_type: type,
      agent_id: n % 2 ? AGENT_1_ID : [...mock.agents.keys()][1] ?? AGENT_1_ID,
      loop: n % 3 === 0 ? 'consolidator' : undefined,
      payload: type === 'tool.completed' ? { name: 'fs_read', result: { content: 'x'.repeat(20_000), n } } : { kind: 'text', text: `event ${n}`, state: 'idle' },
    })
  }
  const floodTimers: Array<ReturnType<typeof setTimeout>> = []
  if (burst > 0) {
    for (let at = 0; at < burst; at += 250) floodTimers.push(setTimeout(() => { for (let i = 0; i < Math.min(250, burst - at); i++) floodEvent() }, 3000 + at / 5))
  }
  const rateTimer = rate > 0 ? setInterval(() => { for (let i = 0; i < Math.max(1, Math.round(rate / 10)); i++) floodEvent() }, 100) : null

  const { runTui } = await import('../../../src/main/tui/index')
  const code = await runTui(['--url', mock.url, ...process.argv.slice(2)], {
    stdout: process.stdout,
    stdin: process.stdin,
    stderr: process.stderr,
    env: process.env,
    fetch: auth.fetch,
  })
  clearInterval(tick)
  if (rateTimer) clearInterval(rateTimer)
  floodTimers.forEach(clearTimeout)
  await mock.close()
  process.exitCode = code
}

main().catch(err => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  process.exitCode = 1
})
