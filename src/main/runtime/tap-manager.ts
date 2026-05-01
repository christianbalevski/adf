/**
 * TapManager — per-agent subscription to the UmbilicalBus.
 *
 * On agent start, instantiates each tap's warm sandbox and subscribes it to
 * the bus with event-type + when-expression filtering, rate limiting, and
 * exclude_own_origin enforcement. On agent stop, tears down.
 *
 * Loop protection layers:
 *   1. exclude_own_origin — suppress dispatch when event.source matches
 *      "lambda:<tap.lambda>". Catches direct self-trigger.
 *   2. max_rate_per_sec token bucket — backstop for multi-hop loops and
 *      filter mistakes. Overruns are dropped and logged.
 *   3. allow_wildcard gate — validated at config load (adf-schema).
 *
 * Dispatch: minimum viable single-event path. Phase 8 measures throughput
 * and decides whether batching or a dedicated worker is needed.
 */

import type { AdfWorkspace } from '../adf/adf-workspace'
import type { CodeSandboxService } from './code-sandbox'
import type { AdfCallHandler } from './adf-call-handler'
import type { UmbilicalTapConfig } from '../../shared/types/adf-v02.types'
import type { UmbilicalBus, UmbilicalEvent } from './umbilical-bus'
import { withSource } from './execution-context'
import { loadLambdaSource } from './ts-transpiler'
import { emitUmbilicalEvent } from './emit-umbilical'
import { Script } from 'node:vm'

interface ActiveTap {
  config: UmbilicalTapConfig
  filePath: string
  fnName: string
  code: string
  /** Token bucket counters. */
  tokens: number
  lastRefillAt: number
  /** Pre-compiled `when` predicate, or null if none. */
  whenFn: ((event: UmbilicalEvent) => boolean) | null
  /** Event-type prefix matchers. */
  matchExact: Set<string>
  matchPrefixes: string[]  // e.g. "tool." for "tool.*"
  matchAny: boolean
  unsubscribe: () => void
}

function compileWhenExpression(expression: string, tapName: string): (event: UmbilicalEvent) => boolean {
  let script: Script
  try {
    script = new Script(`Boolean(${expression})`, {
      filename: `umbilical-tap:${tapName}:when`,
    })
  } catch (err) {
    throw new Error(`Invalid when expression for tap "${tapName}": ${err}`)
  }

  return (event: UmbilicalEvent) => {
    try {
      const clonedEvent = JSON.parse(JSON.stringify(event)) as UmbilicalEvent
      return Boolean(script.runInNewContext(
        { event: clonedEvent },
        {
          timeout: 10,
          contextCodeGeneration: { strings: false, wasm: false },
        },
      ))
    } catch {
      return false
    }
  }
}

export class TapManager {
  private taps: ActiveTap[] = []
  private disposed = false

  constructor(
    private readonly agentId: string,
    private readonly workspace: AdfWorkspace,
    private readonly bus: UmbilicalBus,
    private readonly codeSandboxService: CodeSandboxService,
    private readonly adfCallHandler: AdfCallHandler,
  ) {}

  /**
   * Defensive log — tap dispatches are async and can resolve after the
   * agent's workspace has been closed. Any raw insertLog against a dead db
   * throws "database connection is not open", which surfaces as an unhandled
   * rejection. Always go through this helper.
   */
  private safeLog(level: 'debug' | 'info' | 'warn' | 'error', event: string, target: string | null, message: string): void {
    if (this.disposed) return
    try {
      this.workspace.insertLog(level, 'umbilical_tap', event, target, message)
    } catch { /* workspace closed mid-flight */ }
  }

  async register(configs: UmbilicalTapConfig[]): Promise<void> {
    for (const cfg of configs) {
      // Skip drafts — the UI allows saving a tap before its lambda ref is
      // filled in. Emitting register_failed on every agent load for these
      // spams adf_logs; a single info line is enough.
      if (!cfg.lambda || cfg.lambda.trim().length === 0) {
        this.safeLog('info', 'skipped_draft', cfg.name,
          `Tap "${cfg.name}" has no lambda configured — skipping registration.`)
        continue
      }
      try {
        await this.registerOne(cfg)
      } catch (err) {
        this.safeLog('error', 'register_failed', cfg.name,
          `Failed to register tap ${cfg.name}: ${err}`)
      }
    }
  }

  private async registerOne(cfg: UmbilicalTapConfig): Promise<void> {
    const colon = cfg.lambda.lastIndexOf(':')
    if (colon <= 0) throw new Error(`Invalid lambda ref: "${cfg.lambda}" (expected "file:fn")`)
    const filePath = cfg.lambda.slice(0, colon)
    const fnName = cfg.lambda.slice(colon + 1)

    const code = await loadLambdaSource(
      (p) => this.workspace.readFile(p),
      filePath
    )
    if (code === null) throw new Error(`Tap lambda file not found: ${filePath}`)

    // Pre-compile filter matchers
    const matchExact = new Set<string>()
    const matchPrefixes: string[] = []
    let matchAny = false
    for (const t of cfg.filter.event_types) {
      if (t === '*') matchAny = true
      else if (t.endsWith('.*')) matchPrefixes.push(t.slice(0, -1))  // keep trailing dot
      else matchExact.add(t)
    }

    // Pre-compile when expression. It runs in a restricted VM context with
    // `event` as the only useful binding, not in Electron's main-process global.
    let whenFn: ((event: UmbilicalEvent) => boolean) | null = null
    if (cfg.filter.when) {
      whenFn = compileWhenExpression(cfg.filter.when, cfg.name)
    }

    const tap: ActiveTap = {
      config: cfg,
      filePath,
      fnName,
      code,
      tokens: cfg.max_rate_per_sec,
      lastRefillAt: Date.now(),
      whenFn,
      matchExact,
      matchPrefixes,
      matchAny,
      unsubscribe: () => {},
    }

    tap.unsubscribe = this.bus.subscribe((event) => {
      if (this.disposed) return
      const matches = this.shouldDispatch(tap, event)
      if (process.env.ADF_UMBILICAL_TRACE === '1') {
        console.log(`[Umbilical:tap] agent=${this.agentId} tap=${tap.config.name} type=${event.event_type} matched=${matches}`)
      }
      if (!matches) return
      this.dispatch(tap, event).catch(err => {
        this.safeLog('warn', 'dispatch_error', tap.config.name,
          `Tap ${tap.config.name} handler threw: ${err}`)
      })
    })

    this.taps.push(tap)
    this.safeLog('info', 'registered', cfg.name,
      `Tap ${cfg.name} subscribed (lambda=${cfg.lambda}, event_types=${cfg.filter.event_types.join(',')})`)
    console.log(`[Umbilical] Tap registered: agent=${this.agentId} name=${cfg.name} lambda=${cfg.lambda} types=${cfg.filter.event_types.join(',')}`)
  }

  private shouldDispatch(tap: ActiveTap, event: UmbilicalEvent): boolean {
    // 1. exclude_own_origin
    if (tap.config.exclude_own_origin && event.source === `lambda:${tap.config.lambda}`) {
      return false
    }

    // 2. event_types match
    const matchesType = tap.matchAny
      || tap.matchExact.has(event.event_type)
      || tap.matchPrefixes.some(p => event.event_type.startsWith(p))
    if (!matchesType) return false

    // 3. when expression
    if (tap.whenFn && !tap.whenFn(event)) return false

    // 4. rate limit (token bucket)
    const now = Date.now()
    const elapsedSec = (now - tap.lastRefillAt) / 1000
    tap.tokens = Math.min(tap.config.max_rate_per_sec, tap.tokens + elapsedSec * tap.config.max_rate_per_sec)
    tap.lastRefillAt = now
    if (tap.tokens < 1) {
      this.safeLog('warn', 'rate_limited', tap.config.name,
        `Tap ${tap.config.name} throttled: ${tap.config.max_rate_per_sec} events/sec exceeded`)
      return false
    }
    tap.tokens -= 1

    return true
  }

  private async dispatch(tap: ActiveTap, event: UmbilicalEvent): Promise<void> {
    if (this.disposed) return
    const sandboxId = `${this.agentId}:tap:${tap.config.name}`
    const lambdaSource = `lambda:${tap.config.lambda}`
    const wrappedCode = `${tap.code}

if (typeof ${tap.fnName} === "function") {
  return await ${tap.fnName}(${JSON.stringify(event)});
} else {
  throw new Error("Tap lambda function ${tap.fnName} not found in ${tap.filePath}");
}`
    const onAdfCall = (method: string, args: unknown) => this.adfCallHandler.handleCall(method, args)
    const toolConfig = {
      enabledTools: this.adfCallHandler.getEnabledToolNames(),
      hilTools: this.adfCallHandler.getHilToolNames(),
      isAuthorized: this.adfCallHandler.getAuthorizationContext()
    }

    const timeout = this.workspace.getAgentConfig().limits?.execution_timeout_ms

    const start = performance.now()
    emitTapLifecycle('lambda.started', this.agentId, lambdaSource, tap)
    const result = await withSource(lambdaSource, this.agentId, () =>
      this.codeSandboxService.execute(sandboxId, wrappedCode, timeout, onAdfCall, toolConfig)
    )
    const durationMs = +(performance.now() - start).toFixed(2)
    if (result.error) {
      emitTapLifecycle('lambda.failed', this.agentId, lambdaSource, tap, durationMs, result.error)
      throw new Error(result.error)
    }
    emitTapLifecycle('lambda.completed', this.agentId, lambdaSource, tap, durationMs)
    // Do NOT destroy sandbox — warm by default (module-level state persists).
  }

  dispose(): void {
    this.disposed = true
    for (const tap of this.taps) {
      try { tap.unsubscribe() } catch { /* best-effort */ }
    }
    this.taps = []
  }
}

function emitTapLifecycle(
  eventType: 'lambda.started' | 'lambda.completed' | 'lambda.failed',
  agentId: string,
  source: string,
  tap: ActiveTap,
  durationMs?: number,
  error?: string,
): void {
  emitUmbilicalEvent({
    event_type: eventType,
    agentId,
    source,
    payload: {
      lambda_path: tap.filePath,
      function_name: tap.fnName,
      kind: 'tap',
      tap: tap.config.name,
      ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
      ...(error ? { error } : {}),
    },
  })
}
