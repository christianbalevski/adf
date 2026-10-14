import { IPC } from '../../../src/shared/constants/ipc-channels'
import type { BootedBackend, ParityBackend } from './backend'
import { createFakeElectron, type DialogScript, type PushRecord } from './electron-fake'
import { createParityEnv, writeSettingsFile, type ParityEnv } from './env'
import { baseSettings, createFixtureAgents, IDENTITY, type FixtureAgent, type FixtureName, type FixtureSpec } from './fixtures'
import { diffRendered, renderRecording } from './format'
import { defaultScript, recordedRequest, startMockLlm, type LlmScript, type MockLlm } from './mock-llm'
import { normalizeRecording, type NormalizationContext } from './normalize'
import { toComparable, type ComparableRecording, type RawRecording, type StepRecord } from './recording'
import { dumpPersistedState } from './state-dump'

/**
 * A parity scenario: a renderer-side call sequence written once and run
 * against any backend. `run` only uses the context; it never reaches into a
 * backend, so the same definition is the embedded baseline and the daemon
 * check.
 */
export interface ParityScenario {
  name: string
  description: string
  fixtures: readonly FixtureSpec[]
  /** Merged over `baseSettings`. */
  settings?: Record<string, unknown>
  llm?: LlmScript
  /**
   * After `run` returns the scenario is done: the backend must then stay
   * silent (no push, no LLM request) for this long, or the run fails. A
   * scenario waits explicitly for every push it expects.
   */
  quietMs: number
  run(ctx: ScenarioContext): Promise<void>
}

export interface ScenarioContext {
  readonly env: ParityEnv
  readonly llm: MockLlm
  agent(name: FixtureName): FixtureAgent
  /** `ipcRenderer.invoke`. A rejected handler is recorded and rethrown. */
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>
  /** `ipcRenderer.send`. */
  send(channel: string, ...args: unknown[]): void
  /**
   * Wait for a push on `channel` whose first argument satisfies `match`,
   * counting only pushes after the previous wait on the same channel.
   */
  waitForPush(channel: string, description: string, match: (payload: unknown) => boolean, timeoutMs?: number): Promise<unknown>
  /** Answer native dialogs from now on. */
  setDialogs(script: DialogScript): void
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

export interface ScenarioResult {
  raw: RawRecording
  normalized: ComparableRecording
  /** `normalized` rendered for line diffs and golden files. */
  text: string
}

type HandleList = () => object[]
const activeHandles: HandleList = () => (process as unknown as { _getActiveHandles(): object[] })._getActiveHandles()

function describeHandle(h: object): string {
  const name = h.constructor?.name ?? 'handle'
  const sock = h as { remoteAddress?: string; remotePort?: number; localPort?: number; address?: () => unknown }
  if (sock.remotePort) return `${name} → ${sock.remoteAddress}:${sock.remotePort}`
  if (typeof sock.address === 'function') {
    try { return `${name} listening ${JSON.stringify(sock.address())}` } catch { /* closed */ }
  }
  return name
}

/** Handles opened during the run that are still open: give closing sockets a moment, then report. */
async function leakedHandles(before: Set<object>): Promise<string[]> {
  let left: object[] = []
  for (let i = 0; i < 20; i++) {
    left = activeHandles().filter((h) => !before.has(h))
    if (left.length === 0) return []
    await sleep(25)
  }
  return left.map((h) => `active handle after shutdown: ${describeHandle(h)}`)
}

/**
 * Run one scenario against one backend in a fresh isolated environment and
 * return the raw and normalized recordings.
 */
export async function runScenario(scenario: ParityScenario, backend: ParityBackend): Promise<ScenarioResult> {
  const env = await createParityEnv(scenario.name)
  const handlesBefore = new Set(activeHandles())
  const llm = await startMockLlm(scenario.llm ?? defaultScript, { now: () => Date.now() - env.startedAt })
  env.allowPort(Number(new URL(llm.baseUrl).port))
  let llmOpen = true
  const electron = createFakeElectron(env)
  const steps: StepRecord[] = []
  const problems: string[] = []
  let booted: BootedBackend | null = null
  try {
    const agents = createFixtureAgents(env, scenario.fixtures)
    writeSettingsFile(env, baseSettings(env, llm, agents, scenario.settings))
    booted = await backend.boot(env, electron)

    const waitCursor = new Map<string, number>()
    const ctx: ScenarioContext = {
      env,
      llm,
      agent(name) {
        const found = agents[name]
        if (!found) throw new Error(`scenario ${scenario.name} has no fixture ${name}`)
        return found
      },
      async invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
        const handler = electron.handlers.get(channel)
        if (!handler) throw new Error(`no handler registered for ${channel}`)
        const before = electron.pushes.length
        try {
          const result = await handler(electron.ipcEvent(), ...args)
          steps.push({
            kind: 'invoke', channel, args,
            result: result === undefined ? result : structuredClone(result),
            pushes: { before, after: electron.pushes.length },
          })
          return result as T
        } catch (err) {
          const e = err as { name?: unknown; message?: unknown; code?: unknown }
          steps.push({
            kind: 'invoke-error', channel, args,
            error: { name: String(e?.name ?? 'Error'), message: String(e?.message ?? err), ...(e?.code !== undefined ? { code: e.code } : {}) },
            pushes: { before, after: electron.pushes.length },
          })
          throw err
        }
      },
      send(channel, ...args) {
        const fns = electron.listeners.get(channel)
        if (!fns?.length) throw new Error(`no listener registered for ${channel}`)
        steps.push({ kind: 'send', channel, args, pushes: { before: electron.pushes.length } })
        for (const fn of fns) fn(electron.ipcEvent(), ...args)
      },
      async waitForPush(channel, description, match, timeoutMs = 15_000) {
        const deadline = Date.now() + timeoutMs
        let index = waitCursor.get(channel) ?? 0
        for (;;) {
          for (; index < electron.pushes.length; index++) {
            const push = electron.pushes[index]
            if (push.channel === channel && match(push.args[0])) {
              waitCursor.set(channel, index + 1)
              steps.push({ kind: 'wait', channel, description, pushes: { matched: push.seq } })
              return push.args[0]
            }
          }
          if (Date.now() > deadline) throw new Error(`timed out waiting for ${channel}: ${description}`)
          await sleep(10)
        }
      },
      setDialogs(script) { electron.dialogs = script },
    }

    await scenario.run(ctx)

    // Declared done: anything that arrives now was not waited for.
    const pushesAtDone = electron.pushes.length
    const requestsAtDone = llm.requests.length
    await sleep(scenario.quietMs)
    if (electron.pushes.length > pushesAtDone || llm.requests.length > requestsAtDone) {
      const late = electron.pushes.slice(pushesAtDone).map((p) => `${p.channel} ${JSON.stringify(p.args[0])?.slice(0, 120)}`)
      throw new Error([
        `parity harness: ${scenario.name} was done but the backend kept going within ${scenario.quietMs} ms:`,
        ...late,
        ...(llm.requests.length > requestsAtDone ? [`${llm.requests.length - requestsAtDone} LLM request(s)`] : []),
      ].join('\n'))
    }

    // Teardown with the window open, as on quit: its pushes are part of the recording.
    const before = electron.pushes.length
    const running: BootedBackend = booted
    booted = null
    await running.shutdown()
    steps.push({ kind: 'shutdown', pushes: { before, after: electron.pushes.length } })
    electron.closeWindow()
    problems.push(...running.leaks())
    if (electron.missing.length > 0) {
      problems.push(`electron members the fake lacks were used: ${[...new Set(electron.missing)].join(', ')}`)
    }
    await llm.close()
    llmOpen = false
    problems.push(...(await leakedHandles(handlesBefore)))

    const state = dumpPersistedState(env, Object.values(agents).map((a) => a.filePath))
    env.assertRealStateUntouched()
    if (problems.length) throw new Error(`parity harness: ${scenario.name}:\n${problems.join('\n')}`)

    const raw: RawRecording = {
      scenario: scenario.name,
      backend: backend.name,
      steps,
      pushes: [...electron.pushes],
      local: [...electron.localCalls],
      llm: llm.requests.map(recordedRequest),
      state,
      timing: { streams: [...llm.streams] },
    }
    const extra = running.normalization?.() ?? {}
    const nctx: NormalizationContext = {
      rootSpellings: env.rootSpellings,
      ports: [
        { value: new URL(llm.baseUrl).port, name: 'LLM_PORT' },
        { value: String(env.meshPort), name: 'MESH_PORT' },
        ...(extra.ports ?? []),
      ],
      named: [
        { value: IDENTITY.ownerDid, name: 'did:owner' },
        { value: IDENTITY.runtimeDid, name: 'did:runtime' },
        ...(extra.named ?? []),
      ],
      fixtureIds: Object.values(agents).map((a) => a.id),
      window: { from: env.startedAt, to: Date.now() },
    }
    const normalized = normalizeRecording(toComparable(raw), nctx)
    return { raw, normalized, text: renderRecording(normalized) }
  } finally {
    if (booted) await booted.shutdown().catch(() => {})
    if (llmOpen) await llm.close().catch(() => {})
    env.dispose()
  }
}

/**
 * Run one scenario against two backends and return the line diff of their
 * normalized recordings ('' = indistinguishable). This is the daemon-mode
 * parity check: `diffBackends(s, embeddedBackend, daemonBackend)`.
 */
export async function diffBackends(scenario: ParityScenario, baseline: ParityBackend, candidate: ParityBackend): Promise<string> {
  const a = await runScenario(scenario, baseline)
  const b = await runScenario(scenario, candidate)
  return diffRendered(a.text, b.text, { expected: baseline.name, actual: candidate.name })
}

/**
 * Streaming check data: how the mock LLM's text slices (written 200 ms
 * apart, past the executor's 50 ms batch window) arrived as
 * `text_delta_batch` pushes. Timing data; never part of a golden file.
 */
export interface StreamingReport {
  /** Text slices written by the mock LLM. */
  slices: number
  /** text_delta_batch pushes on AGENT_EVENT. */
  batches: number
  /** Per streamed reply: ms from its first slice write to the first batch push after it. */
  firstDeltaLatencyMs: number[]
}

export function streamingReport(raw: RawRecording): StreamingReport {
  const batches = raw.pushes.filter((p: PushRecord) =>
    p.channel === IPC.AGENT_EVENT && (p.args[0] as { type?: string })?.type === 'text_delta_batch')
  const firstDeltaLatencyMs: number[] = []
  for (const stream of raw.timing.streams) {
    const first = stream.textWrites[0]
    if (first === undefined) continue
    const batch = batches.find((b) => b.t >= first)
    firstDeltaLatencyMs.push(batch ? batch.t - first : Number.POSITIVE_INFINITY)
  }
  return {
    slices: raw.timing.streams.reduce((n, s) => n + s.textWrites.length, 0),
    batches: batches.length,
    firstDeltaLatencyMs,
  }
}
