import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  LIFECYCLE_CHARACTERIZATION_LEDGER,
  LIFECYCLE_CHARACTERIZATION_TERMINAL_STATUSES,
} from '../../src/main/runtime/lifecycle-characterization'

const REPO_ROOT = join(__dirname, '..', '..')
const PRODUCTION_ROOT = join(REPO_ROOT, 'src', 'main')
const ASSEMBLER_PATH = 'src/main/runtime/assemble-agent.ts'
const EXECUTOR_INTERNAL_PATH = 'src/main/runtime/agent-executor.ts'

const TERMINAL_STATUSES = new Set<string>(LIFECYCLE_CHARACTERIZATION_TERMINAL_STATUSES)

// These independently reviewed totals make the final divergence findings
// visible in verbose CI output. Adding or resolving a finding requires an
// intentional update here and in the lifecycle contract.
const EXPECTED_LEDGER_COUNTS = {
  fixed: 6,
  declaredByProfile: 3,
  pending: 0,
  other: 0,
} as const

const TEMPORARY_BRIDGE_IDENTIFIERS = [
  'LegacyRuntimeView',
  'createLegacyRuntimeView',
  'legacyRuntimeView',
  'lifecycleOwnershipBridge',
  'adoptExistingAgent',
] as const

interface ProductionSource {
  readonly path: string
  readonly content: string
}

interface MatchSite {
  readonly path: string
  readonly line: number
  readonly match: string
}

function walkTypeScriptFiles(directory: string, output: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const absolutePath = join(directory, entry)
    const stat = statSync(absolutePath)
    if (stat.isDirectory()) {
      walkTypeScriptFiles(absolutePath, output)
    } else if (stat.isFile() && (absolutePath.endsWith('.ts') || absolutePath.endsWith('.tsx'))) {
      output.push(absolutePath)
    }
  }
  return output
}

function productionSources(): ProductionSource[] {
  return walkTypeScriptFiles(PRODUCTION_ROOT).map((absolutePath) => ({
    path: relative(REPO_ROOT, absolutePath).split(sep).join('/'),
    content: readFileSync(absolutePath, 'utf8'),
  }))
}

function findSites(sources: readonly ProductionSource[], pattern: RegExp): MatchSite[] {
  const sites: MatchSite[] = []
  for (const source of sources) {
    const expression = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
    let match: RegExpExecArray | null
    while ((match = expression.exec(source.content)) !== null) {
      sites.push({
        path: source.path,
        line: source.content.slice(0, match.index).split('\n').length,
        match: match[0],
      })
    }
  }
  return sites
}

function formatSites(sites: readonly MatchSite[]): string {
  return sites.map((site) => `${site.path}:${site.line} (${site.match})`).join('\n')
}

describe('lifecycle characterization ledger', () => {
  it('is closed: 6 fixed, 3 declaredByProfile, 0 pending', () => {
    const entries = LIFECYCLE_CHARACTERIZATION_LEDGER as ReadonlyArray<{
      status: string
      profiles: readonly string[]
      reason: string
      capabilities?: readonly string[]
    }>
    const counts = {
      fixed: 0,
      declaredByProfile: 0,
      pending: 0,
      other: 0,
    }

    expect(entries.length).toBeGreaterThan(0)
    for (const entry of entries) {
      if (entry.status === 'fixed') {
        counts.fixed += 1
      } else if (entry.status === 'declaredByProfile') {
        counts.declaredByProfile += 1
      } else if (entry.status === 'pending') {
        counts.pending += 1
      } else {
        counts.other += 1
      }

      expect(TERMINAL_STATUSES.has(entry.status)).toBe(true)
      expect(entry.profiles.length).toBeGreaterThan(0)
      expect(entry.reason.trim()).not.toBe('')
      if (entry.status === 'declaredByProfile') {
        expect(entry.capabilities?.length).toBeGreaterThan(0)
      }
    }

    expect(counts).toEqual(EXPECTED_LEDGER_COUNTS)
    expect(new Set(entries.map((entry) => entry.status))).toEqual(TERMINAL_STATUSES)
    expect(new Set(LIFECYCLE_CHARACTERIZATION_LEDGER.map((entry) => entry.id)).size).toBe(
      entries.length,
    )
  })
})

describe('assembled-agent architecture fence', () => {
  const sources = productionSources()

  it('has exactly one production AgentExecutor construction call site', () => {
    const sites = findSites(sources, /\bnew\s+AgentExecutor\s*\(/)
    expect(
      sites,
      `AgentExecutor construction must live only in ${ASSEMBLER_PATH}.\nCall sites:\n${formatSites(sites)}`,
    ).toHaveLength(1)
    expect(sites[0]?.path).toBe(ASSEMBLER_PATH)
  })

  it('has exactly one production TriggerEvaluator trigger-to-dispatch wiring', () => {
    const sites = findSites(
      sources,
      /\b(?:triggerEvaluator|newTriggerEvaluator)\s*\.\s*on\s*\(\s*['"]trigger['"]/,
    )
    expect(
      sites,
      `TriggerEvaluator trigger wiring must live only in ${ASSEMBLER_PATH}.\nCall sites:\n${formatSites(sites)}`,
    ).toHaveLength(1)
    expect(sites[0]?.path).toBe(ASSEMBLER_PATH)
  })

  it('prevents hosts from bypassing the assembled dispatch boundary', () => {
    const allowedPaths = new Set([ASSEMBLER_PATH, EXECUTOR_INTERNAL_PATH])
    const bypasses = findSites(
      sources.filter((source) => !allowedPaths.has(source.path)),
      /\.\s*executeTurn\s*\(/,
    )
    expect(
      bypasses,
      `Hosts must call assembledAgent.dispatch(dispatch), never executeTurn() directly.\nBypasses:\n${formatSites(bypasses)}`,
    ).toEqual([])
  })

  it('does not retain temporary ownership-bridge machinery', () => {
    const bridgePattern = new RegExp(
      `\\b(?:${TEMPORARY_BRIDGE_IDENTIFIERS.join('|')})\\b`,
    )
    const sites = findSites(sources, bridgePattern)
    expect(
      sites,
      `Temporary lifecycle ownership bridge identifiers must be removed after migration.\nSites:\n${formatSites(sites)}`,
    ).toEqual([])
  })
})
