#!/usr/bin/env node
import { spawnSync } from 'node:child_process'

const args = new Map()
for (const arg of process.argv.slice(2)) {
  if (arg === '--help' || arg === '-h') {
    printHelp()
    process.exit(0)
  }
  const m = arg.match(/^--([^=]+)=(.*)$/)
  if (m) args.set(m[1], m[2])
}

const scenario = args.get('scenario') ?? 'all'
const out = args.get('out')
const timeout = args.get('timeout') ?? '90000'

const scenarioFilters = {
  all: null,
  smoke: 'smoke',
  overhead: 'overhead scenario',
  idle: 'scenario: idle',
  mixed: 'scenario: mixed',
  burst: 'scenario: burst',
}

if (!(scenario in scenarioFilters)) {
  console.error(`Unknown scenario "${scenario}". Expected one of: ${Object.keys(scenarioFilters).join(', ')}`)
  process.exit(2)
}

run('node', ['scripts/rebuild-for-node.mjs'], process.env)

const vitestArgs = [
  'vitest',
  'run',
  'tests/perf/stress-harness.test.ts',
  '--reporter=verbose',
  `--testTimeout=${timeout}`,
]
const filter = scenarioFilters[scenario]
if (filter) vitestArgs.push('-t', filter)

run('npx', vitestArgs, {
  ...process.env,
  RUN_BENCH: '1',
  NODE_ENV: 'production',
  ...(out ? { BENCH_OUT: out } : {}),
})

function run(cmd, commandArgs, env) {
  const result = spawnSync(cmd, commandArgs, {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
  })
  if (result.error) {
    console.error(result.error.message)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function printHelp() {
  console.log(`Usage: node scripts/stress-runtime.mjs [--scenario=all|smoke|overhead|idle|mixed|burst] [--out=path] [--timeout=90000]

Runs the headless runtime stress harness with the mock LLM provider.

Examples:
  node scripts/stress-runtime.mjs --scenario=smoke
  node scripts/stress-runtime.mjs --scenario=mixed --out=/tmp/adf-mixed.json
`)
}
