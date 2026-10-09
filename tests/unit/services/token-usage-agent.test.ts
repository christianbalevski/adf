/**
 * Per-agent usage ledger: agent-tagged calls also land in
 * token-usage-agents.json (date → agent id → model), which the agent vitals
 * card sums for its 7-day cost. The main ledger keeps its shape.
 */

import { existsSync, mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { TokenUsageService } from '../../../src/main/services/token-usage.service'
import { localDateKey } from '../../../src/shared/utils/date-key'

const originalDir = process.env.ADF_USER_DATA_DIR
const AGENT_ID = '0b6a2f4e-91c3-4d7a-8e5f-3c2d1a0b9e87'

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'adf-token-usage-agent-'))
  process.env.ADF_USER_DATA_DIR = dir
  return dir
}

afterEach(() => {
  if (originalDir === undefined) delete process.env.ADF_USER_DATA_DIR
  else process.env.ADF_USER_DATA_DIR = originalDir
})

describe('per-agent usage ledger', () => {
  it('records agent-tagged calls per agent and model; main ledger unchanged', () => {
    makeDir()
    const service = new TokenUsageService()
    service.recordUsage('anthropic', 'model-a', 100, 50, { cost_usd: 0.5, agent: AGENT_ID })
    service.recordUsage('anthropic', 'model-a', 10, 5, { cost_usd: 0.25, agent: AGENT_ID })
    service.recordUsage('anthropic', 'model-a', 1, 1, { cost_usd: 9 })
    const today = localDateKey()
    expect(service.getUsageData()[today].anthropic['model-a']).toEqual({ input: 111, output: 56, cost_usd: 9.75 })
    expect(service.getAgentLedger().getUsageData()[today][AGENT_ID]['model-a']).toEqual({ input: 110, output: 55, cost_usd: 0.75 })
    expect(service.getAgentCost(AGENT_ID)).toEqual({ usd: 0.75, partial: false })
  })

  it('null for unknown agents; partial when a call had no price; 7-day window', () => {
    makeDir()
    const service = new TokenUsageService()
    expect(service.getAgentCost(AGENT_ID)).toBeNull()
    service.recordUsage('p', 'm', 10, 5, { agent: AGENT_ID })
    expect(service.getAgentCost(AGENT_ID)).toEqual({ usd: 0, partial: true })
    const eightDaysOn = new Date()
    eightDaysOn.setDate(eightDaysOn.getDate() + 8)
    expect(service.getAgentCost(AGENT_ID, 7, eightDaysOn)).toBeNull()
  })

  it('per-day cost: only the asked days, absent when no rows, partial per day', () => {
    makeDir()
    const service = new TokenUsageService()
    service.recordUsage('anthropic', 'model-a', 10, 5, { cost_usd: 0.5, agent: AGENT_ID })
    service.recordUsage('anthropic', 'model-b', 10, 5, { agent: AGENT_ID })
    const today = localDateKey()
    expect(service.getAgentDailyCost(AGENT_ID, ['2000-01-01', today])).toEqual({ [today]: { usd: 0.5, partial: true } })
    expect(service.getAgentDailyCost('agent-unknown', [today])).toEqual({})
  })

  it('flush writes both ledgers', () => {
    const dir = makeDir()
    const service = new TokenUsageService()
    service.recordUsage('p', 'm', 10, 5, { cost_usd: 1, agent: AGENT_ID })
    service.flush()
    expect(existsSync(join(dir, 'token-usage.json'))).toBe(true)
    const agents = JSON.parse(readFileSync(join(dir, 'token-usage-agents.json'), 'utf-8'))
    expect(agents[localDateKey()][AGENT_ID].m).toEqual({ input: 10, output: 5, cost_usd: 1 })
  })
})
