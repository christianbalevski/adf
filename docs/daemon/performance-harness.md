# Headless Performance Harness

The headless performance harness measures runtime behavior without Studio. It spins up mock-provider agents, drives synthetic turns, records latency and resource metrics, and tears the agents down.

The harness is useful for daemon work because it exercises the same headless runtime foundations without requiring real providers or manual UI interaction.

## Entry Points

Run through npm:

```bash
npm run stress:runtime
```

Run the script directly:

```bash
node scripts/stress-runtime.mjs --scenario=smoke
```

Run the benchmark test directly:

```bash
RUN_BENCH=1 NODE_ENV=production npx vitest run tests/perf/stress-harness.test.ts --reporter=verbose
```

The script runs `scripts/rebuild-for-node.mjs` first so native SQLite bindings match Node.

## Scenarios

`scripts/stress-runtime.mjs` supports:

| Scenario | Purpose |
|----------|---------|
| `smoke` | Short one-agent overhead run |
| `overhead` | Zero-latency mock provider to measure runtime overhead |
| `idle` | Many low-traffic agents |
| `mixed` | Moderate load with mock tool-call probability |
| `burst` | Short aggressive burst traffic |
| `all` | Runs all script-supported scenarios |

Example:

```bash
node scripts/stress-runtime.mjs --scenario=mixed --out=/tmp/adf-mixed.json
```

## Output

The harness prints compact reports:

```text
[mixed] agents=20 dur=15000ms turns=10/10 (err=0)
  turn p50/p95/p99/max: 1200/1300/1300/1300 ms
  evloop lag p50/p95/p99/max: 10/12/14/20 ms
  rss peak/avg: 180.5/170.2 MB  heap peak/avg: 64.1/60.8 MB
  timer handles peak: 24  provider calls: 10
```

When `--out` is provided, reports are also written as JSON:

```json
{
  "reports": []
}
```

## Metrics

The harness records:

| Metric | Description |
|--------|-------------|
| Turn counts | Total, completed, and errored turns |
| Turn latency | p50, p95, p99, and max successful turn duration |
| Event loop lag | p50, p95, p99, max, and mean event loop delay |
| Memory | Peak and average RSS and heap used |
| Handles | Peak active timeout handle count |
| Provider calls | Total mock provider calls across all agents |

## How It Works

The harness uses:

- `RuntimeService` with review disabled
- `createHeadlessAgent`
- `MockLLMProvider`
- `LoadDriver` for scheduled synthetic chat dispatches
- `MetricsCollector` for turn timing, memory sampling, and event loop delay

It creates multiple agents in memory, wraps each target's `executeTurn`, drives turns for the scenario duration, stops the load driver, collects metrics, and unloads all agents.

## When to Use It

Use the harness when changing:

- `RuntimeService`
- `AgentExecutor`
- Headless agent creation
- Trigger dispatch behavior
- Loop persistence or session restore
- Runtime scheduling
- Provider call flow
- Daemon code paths that affect many agents

For narrow API changes, normal unit tests are usually enough. For lifecycle, concurrency, memory, or latency questions, run the relevant harness scenario.

## Test Gating

`tests/perf/stress-harness.test.ts` is gated by `RUN_BENCH=1`, so normal `npm test` does not run the benchmark scenarios. This keeps regular tests fast while preserving a repeatable benchmark path.

