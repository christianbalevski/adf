import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AdfWorkspace } from '../../src/main/adf/adf-workspace'
import { createFixtureAgents, FIXTURE_CREATED_DATE } from './harness/fixtures'
import type { ParityEnv } from './harness/env'

/**
 * Fixture agents have a stable README date whatever day the suite runs; a
 * scenario can also pin config metadata when it compares timestamp ordering,
 * so the committed recordings do not all break at 00:00 UTC. The README
 * hash is the one every recording's state dump shows (`80b2a1365798bf33`).
 */

const dirs: string[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

it.each(['2026-10-14T23:59:00Z', '2026-10-15T00:01:00Z', '2027-03-01T12:00:00Z'])('a fixture made at %s has the recordings\' README', (now) => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(now))
  const dir = mkdtempSync(join(tmpdir(), 'adf-parity-fixture-date-'))
  dirs.push(dir)
  const createdAt = `${FIXTURE_CREATED_DATE}T00:00:00.000Z`
  const { 'agent-1': agent } = createFixtureAgents({ agentsDir: dir } as ParityEnv, [{ name: 'agent-1', createdAt }])
  const workspace = AdfWorkspace.open(agent.filePath)
  try {
    const readme = workspace.readFileBuffer('README.md')!
    expect(readme.toString('utf-8')).toBe(`# agent-1\n\nCreated: ${FIXTURE_CREATED_DATE}\nStatus: New agent, self-configuring.\n`)
    expect(workspace.getAgentConfig().metadata.created_at).toBe(createdAt)
    expect(createHash('sha256').update(readme).digest('hex').slice(0, 16)).toBe('80b2a1365798bf33')
  } finally {
    workspace.close()
  }
})
