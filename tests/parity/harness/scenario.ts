import type { ParityBackend } from './backend'
import { createFakeElectron, type DialogScript } from './electron-fake'
import { createParityEnv, writeSettingsFile, type ParityEnv } from './env'
import { baseSettings, createFixtureAgents, type FixtureAgent, type FixtureName, type FixtureSpec } from './fixtures'
import { defaultScript, recordedRequest, startMockLlm, type LlmScript, type MockLlm } from './mock-llm'
import { normalizeRecording, type NormalizationContext } from './normalize'
import { toComparable, type ComparableRecording, type RawRecording, type StepRecord } from './recording'
import { diffRendered, renderRecording } from './format'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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

const QUIET_MS = 750
const SETTLE_LIMIT_MS = 15_000

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Run one scenario against one backend in a fresh isolated environment and
 * return the raw and normalized recordings.
 */
export interface ScenarioResult {
  raw: RawRecording
  normalized: ComparableRecording
  /** `normalized` rendered for line diffs and golden files. */
  text: string
}

export async function runScenario(scenario: ParityScenario, backend: ParityBackend): Promise<ScenarioResult> {
  const env = await createParityEnv(scenario.name)
  const llm = await startMockLlm(scenario.llm ?? defaultScript)
  const electron = createFakeElectron(env)
  const steps: StepRecord[] = []
  let booted: Awaited<ReturnType<ParityBackend['boot']>> | null = null
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
        try {
          const result = await handler(electron.ipcEvent(), ...args)
          steps.push({ kind: 'invoke', channel, args, result: result === undefined ? result : structuredClone(result) })
          return result as T
        } catch (err) {
          steps.push({ kind: 'invoke-error', channel, args, error: err instanceof Error ? err.message : String(err) })
          throw err
        }
      },
      send(channel, ...args) {
        const fns = electron.listeners.get(channel)
        if (!fns?.length) throw new Error(`no listener registered for ${channel}`)
        steps.push({ kind: 'send', channel, args })
        for (const fn of fns) fn(electron.ipcEvent(), ...args)
      },
      async waitForPush(channel, description, match, timeoutMs = 15_000) {
        steps.push({ kind: 'wait', channel, description })
        const deadline = Date.now() + timeoutMs
        let index = waitCursor.get(channel) ?? 0
        for (;;) {
          for (; index < electron.pushes.length; index++) {
            const push = electron.pushes[index]
            if (push.channel === channel && match(push.args[0])) {
              waitCursor.set(channel, index + 1)
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
    await settle(electron.pushes, llm)

    const raw: RawRecording = {
      scenario: scenario.name,
      backend: backend.name,
      steps,
      pushes: [...electron.pushes],
      local: [...electron.localCalls],
      llm: llm.requests.map(recordedRequest),
    }
    const running = booted
    booted = null
    await running.shutdown()
    const violations = running.violations()
    if (violations.length > 0) throw new Error(`parity harness: safety fence hit: ${violations.join('; ')}`)
    env.assertRealStateUntouched()
    if (electron.missing.length > 0) {
      throw new Error(`parity harness: code under test used electron members the fake lacks: ${[...new Set(electron.missing)].join(', ')}`)
    }
    const normalized = normalizeRecording(toComparable(raw), normalizationContext(env, llm, agents))
    return { raw, normalized, text: renderRecording(normalized) }
  } finally {
    if (booted) await booted.shutdown().catch(() => {})
    await llm.close()
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

/** Wait until neither the window nor the mock LLM has seen anything for QUIET_MS. */
async function settle(pushes: readonly unknown[], llm: MockLlm): Promise<void> {
  const deadline = Date.now() + SETTLE_LIMIT_MS
  let seen = pushes.length + llm.requests.length
  let quietSince = Date.now()
  while (Date.now() - quietSince < QUIET_MS) {
    if (Date.now() > deadline) throw new Error('parity harness: backend never went quiet')
    await sleep(25)
    const now = pushes.length + llm.requests.length
    if (now !== seen) {
      seen = now
      quietSince = Date.now()
    }
  }
}

/** Values the normalizer replaces by name; read from the run's own files after the run. */
function normalizationContext(env: ParityEnv, llm: MockLlm, agents: Record<string, FixtureAgent>): NormalizationContext {
  let settings: Record<string, unknown> = {}
  try { settings = JSON.parse(readFileSync(join(env.userDataDir, 'adf-settings.json'), 'utf-8')) } catch { /* none */ }
  const str = (k: string) => (typeof settings[k] === 'string' ? (settings[k] as string) : undefined)
  return {
    roots: env.rootAliases,
    ports: [
      { value: new URL(llm.baseUrl).port, name: 'LLM_PORT' },
      { value: String(env.meshPort), name: 'MESH_PORT' },
    ],
    named: [
      { value: str('ownerDid'), name: 'did:owner' },
      { value: str('runtimeDid'), name: 'did:runtime' },
      { value: str('runtimeId'), name: 'runtime-id' },
    ],
    fixtureIds: Object.values(agents).map((a) => a.id),
  }
}
