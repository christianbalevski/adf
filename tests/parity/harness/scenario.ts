import { createHash } from 'node:crypto'
import { IPC } from '../../../src/shared/constants/ipc-channels'
import type { BootedBackend, ParityBackend } from './backend'
import { createFakeElectron, type DialogScript, type PushRecord } from './electron-fake'
import { createParityEnv, writeSettingsFile, type ParityEnv } from './env'
import { baseSettings, createFixtureAgents, IDENTITY, type FixtureAgent, type FixtureName, type FixtureSpec } from './fixtures'
import { diffRendered, renderRecording } from './format'
import { defaultScript, recordedRequest, startMockLlm, type LlmRequestView, type LlmScript, type MockLlm, type StreamTiming } from './mock-llm'
import { normalizeRecording, type NormalizationContext } from './normalize'
import { toComparable, type ComparableRecording, type RawRecording, type StepRecord } from './recording'
import { verifySignatures } from './signatures'
import { dumpPersistedState, type PersistedState } from './state-dump'
import { leaseKeyForCanonicalPath } from '../../../src/main/runtime/agent-lease'

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
  /** Merged over `baseSettings`; a function gets the run's environment (paths such as `agentsDir`). */
  settings?: Record<string, unknown> | ((env: ParityEnv) => Record<string, unknown>)
  llm?: LlmScript
  /**
   * After `run` returns the scenario is done: the backend must then stay
   * silent (no push, no LLM request) for this long, or the run fails. A
   * scenario waits explicitly for every push it expects.
   */
  quietMs: number
  /**
   * The model's replies stream to an agent that is not the open file's: the
   * window gets no text deltas for them (in either mode), so the streaming
   * check has nothing to measure and is skipped.
   */
  backgroundStreamsOnly?: boolean
  /**
   * Which streamed replies go to the open file's agent, by their request;
   * default every one. Replies to a background agent push no text deltas
   * (in either mode), so the streaming check measures only these.
   */
  shownStream?: (request: LlmRequestView) => boolean
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

export interface RunOptions {
  /**
   * Record instead of throwing what a strict run fails on: a rejected
   * invoke (the scenario continues with `undefined`), a push that never
   * comes (`wait-timeout` step), pushes or model calls after the scenario
   * was done, and the streaming check (both in `problems`). Used only to
   * list a candidate backend's remaining differences (diffBackends); the
   * fences, the real-state check and leaks still throw.
   */
  tolerant?: boolean
  /** waitForPush budget; default 15 s. */
  waitTimeoutMs?: number
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
export async function runScenario(scenario: ParityScenario, backend: ParityBackend, opts: RunOptions = {}): Promise<ScenarioResult> {
  const env = await createParityEnv(scenario.name)
  const handlesBefore = new Set(activeHandles())
  const llm = await startMockLlm(scenario.llm ?? defaultScript, { now: () => Date.now() - env.startedAt })
  env.allowPort(Number(new URL(llm.baseUrl).port))
  let llmOpen = true
  const electron = createFakeElectron(env)
  const steps: StepRecord[] = []
  const problems: string[] = []
  /** Tolerant runs: what a strict run throws on, recorded instead. */
  const behaviour: string[] = []
  let booted: BootedBackend | null = null
  try {
    const agents = createFixtureAgents(env, scenario.fixtures)
    writeSettingsFile(env, baseSettings(env, llm, agents, typeof scenario.settings === 'function' ? scenario.settings(env) : scenario.settings))
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
          if (opts.tolerant) return undefined as T
          throw err
        }
      },
      send(channel, ...args) {
        const fns = electron.listeners.get(channel)
        if (!fns?.length) throw new Error(`no listener registered for ${channel}`)
        steps.push({ kind: 'send', channel, args, pushes: { before: electron.pushes.length } })
        for (const fn of fns) fn(electron.ipcEvent(), ...args)
      },
      async waitForPush(channel, description, match, timeoutMs = opts.waitTimeoutMs ?? 15_000) {
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
          if (Date.now() > deadline) {
            if (opts.tolerant) {
              steps.push({ kind: 'wait-timeout', channel, description, pushes: { at: electron.pushes.length } })
              return undefined
            }
            throw new Error(`timed out waiting for ${channel}: ${description}`)
          }
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
      if (opts.tolerant) {
        behaviour.push(`kept going after done: ${late.length} push(es) (${late.map((l) => l.split(' ')[0]).join(', ')}), ${llm.requests.length - requestsAtDone} LLM request(s)`)
      } else throw new Error([
        `parity harness: ${scenario.name} was done but the backend kept going within ${scenario.quietMs} ms:`,
        ...late,
        ...(llm.requests.length > requestsAtDone ? [`${llm.requests.length - requestsAtDone} LLM request(s)`] : []),
      ].join('\n'))
    }

    // State while the backend still runs: what the user has at this point in
    // either mode. Shutdown differs by mode (daemon-mode agents can outlive
    // Studio), so the state after shutdown is kept raw and not compared.
    const fixtureFiles = Object.values(agents).map((a) => a.filePath)
    const state = dumpPersistedState(env, fixtureFiles)

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
    const shown = scenario.shownStream
    const report = streamingReport(electron.pushes, shown ? llm.streams.filter((st) => shown(llm.requests[st.request])) : llm.streams)
    // Tolerant runs record the category and counts only: a golden must hold no timing.
    if (scenario.backgroundStreamsOnly) { /* no foreground stream to measure */ }
    else if (opts.tolerant) behaviour.push(...streamingSummary(report))
    else problems.push(...streamingProblems(report))

    const stateAfterShutdown = dumpPersistedState(env, fixtureFiles)
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
      stateAfterShutdown,
      timing: { streams: [...llm.streams] },
      ...(behaviour.length ? { problems: behaviour } : {}),
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
        { value: (IDENTITY.runtimeDelegation as { signature?: string } | undefined)?.signature, name: 'sig:runtime-delegation' },
        // Scratch dirs: `<temp>/adf-scratch-<pid>/<name>-<md5(filePath)[0..6]>` (utils/scratch-dir.ts).
        // A backend in another process names its own pid through normalization().
        { value: `adf-scratch-${process.pid}`, name: 'scratch-root:this-process' },
        ...Object.values(agents).map((a) => ({
          value: `${a.name}-${createHash('md5').update(a.filePath).digest('hex').slice(0, 6)}`,
          name: `scratch:${a.name}`,
        })),
        // Lease file names: sha256 of the canonical path (agent-lease.ts).
        ...Object.values(agents).map((a) => ({ value: leaseKeyForCanonicalPath(a.filePath), name: `lease:${a.name}` })),
        ...registryRoles(state),
        ...(extra.named ?? []),
      ],
      fixtureIds: Object.values(agents).map((a) => a.id),
      pids: [{ value: process.pid, name: 'pid:this-process' }, ...(extra.pids ?? [])],
      window: { from: env.startedAt, to: Date.now() },
      signatures: verifySignatures(raw),
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
export async function diffBackends(
  scenario: ParityScenario,
  baseline: ParityBackend,
  candidate: ParityBackend,
  candidateOptions: RunOptions = {},
): Promise<string> {
  const a = await runScenario(scenario, baseline)
  const b = await runScenario(scenario, candidate, candidateOptions)
  return diffRendered(a.text, b.text, { expected: baseline.name, actual: candidate.name })
}

/**
 * Streaming check, run inside every `runScenario` (so `diffBackends` checks
 * both sides). The mock LLM writes text slices 200 ms apart, past the
 * executor's 50 ms batch window, so each slice must arrive as its own
 * `text_delta_batch` on AGENT_EVENT, and each within SLICE_DELTA_BOUND_MS of
 * its write. Timing data; never part of a recording.
 *
 * `PARITY_SLICE_BOUND_MS` overrides the bound for a loaded CI machine; it
 * only widens what counts as on time, never what is compared.
 */
export const SLICE_DELTA_BOUND_MS = Number(process.env.PARITY_SLICE_BOUND_MS) > 0 ? Number(process.env.PARITY_SLICE_BOUND_MS) : 50 + 250

export interface StreamingReport {
  /** Text slices written by the mock LLM, all replies. */
  slices: number
  /** text_delta_batch pushes on AGENT_EVENT. */
  batches: number
  /** Per slice, in write order: ms from its write to the batch that carried it. */
  sliceLatencyMs: number[]
}

export function streamingReport(pushes: readonly PushRecord[], streams: readonly StreamTiming[]): StreamingReport {
  const batches = pushes.filter((p) =>
    p.channel === IPC.AGENT_EVENT && (p.args[0] as { type?: string })?.type === 'text_delta_batch')
  const writes = streams.flatMap((s) => s.textWrites).sort((a, b) => a - b)
  // The k-th slice written is carried by the k-th batch pushed.
  const sliceLatencyMs = writes.map((w, k) => (batches[k] ? batches[k].t - w : Number.POSITIVE_INFINITY))
  return { slices: writes.length, batches: batches.length, sliceLatencyMs }
}

/** The streaming problems of one run ([] = streamed as a real model streams). */
export function streamingProblems(report: StreamingReport): string[] {
  const out: string[] = []
  if (report.batches !== report.slices) {
    out.push(`streaming: ${report.slices} text slice(s) arrived as ${report.batches} text_delta_batch push(es)`)
  }
  report.sliceLatencyMs.forEach((ms, k) => {
    if (!(ms >= 0 && ms <= SLICE_DELTA_BOUND_MS)) out.push(`streaming: slice ${k + 1} reached the window after ${ms} ms (bound ${SLICE_DELTA_BOUND_MS} ms)`)
  })
  return out
}

/** streamingProblems without timing: the category and the slice counts (tolerant runs). */
export function streamingSummary(report: StreamingReport): string[] {
  const out: string[] = []
  if (report.batches !== report.slices) out.push(`streaming: ${report.slices} text slice(s) arrived as ${report.batches} text_delta_batch push(es)`)
  const late = report.sliceLatencyMs.filter((ms) => !(ms >= 0 && ms <= SLICE_DELTA_BOUND_MS)).length
  if (late > 0 && report.batches === report.slices) out.push(`streaming: ${late} of ${report.slices} slice(s) late`)
  return out
}

/**
 * Per-process values in the runtime host registry, named by the record's
 * kind (`studio-embedded`, `daemon`, `studio-client`): its random
 * runtimeId and the endpoint derived from it, plus the machine id and
 * hostname every record carries. Read from the run's own registry files.
 */
function registryRoles(state: PersistedState): { value: string | undefined; name: string }[] {
  const out: { value: string | undefined; name: string }[] = []
  for (const [file, record] of Object.entries(state.leases)) {
    if (!/^(hosts|clients)\//.test(file) || !record || typeof record !== 'object') continue
    const r = record as { kind?: string; runtimeId?: string; endpoint?: string | null; machineId?: string | null; hostname?: string }
    const kind = r.kind ?? 'unknown'
    out.push(
      { value: r.endpoint ?? undefined, name: `lease-endpoint:${kind}` },
      { value: r.runtimeId, name: `lease-runtime-id:${kind}` },
      { value: r.machineId ?? undefined, name: 'machine-id' },
      { value: r.hostname, name: 'hostname' },
    )
  }
  return out
}
