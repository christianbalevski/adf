import { describe, expect, it } from 'vitest'
import { IPC } from '../../../src/shared/constants/ipc-channels'
import { GAP_ALLOWLIST } from '../harness/gaps'
import type { ComparableRecording, RawRecording } from '../harness/recording'

/**
 * The fleet-row instant entry of w3a:start-session-id rewrites a row's
 * `createdAt` token only when the daemon's raw value is that fixture file's
 * own creation stamp: a backend that reported "now" stays a difference.
 */
const entry = GAP_ALLOWLIST.find((e) => e.id === 'w3a:start-session-id')!
const STAMP = '2026-10-14T21:09:28.674Z'

function recordings(token: string, rawCreatedAt: string) {
  const step = (createdAt: string, filePath: string) => ({
    kind: 'invoke', channel: IPC.MESH_FLEET_STATUS, args: [], pushes: { before: 0, after: 0 },
    result: { running: true, agents: [{ filePath, createdAt }] },
  })
  const rec = (createdAt: string) => ({ steps: [step(createdAt, '<ROOT>/agents/agent-1.adf')] }) as unknown as ComparableRecording
  const raw = {
    steps: [step(rawCreatedAt, 'C:\\run\\agents\\agent-1.adf')],
    state: { adf: { 'agents/agent-1.adf': { tables: { adf_meta: { rows: [{ key: 'adf_created_at', value: STAMP }] } } } } },
  } as unknown as RawRecording
  return { d: rec(token), e: rec('<t:earlier>'), raw }
}

const createdAt = (r: ComparableRecording) => ((r.steps[0] as unknown as { result: { agents: Array<{ createdAt: string }> } }).result.agents[0].createdAt)

describe('gap w3a:start-session-id, fleet-row instants', () => {
  it('rewrites the token when the raw createdAt is the file\'s own creation stamp', () => {
    const { d, e, raw } = recordings('<t>', STAMP)
    expect(entry.apply(d, e, { daemon: raw })).toBe(1)
    expect(createdAt(d)).toBe('<t:earlier>')
  })

  it('leaves a createdAt that is not the file\'s stamp (e.g. "now") as a difference', () => {
    const { d, e, raw } = recordings('<t>', new Date().toISOString())
    expect(entry.apply(d, e, { daemon: raw })).toBe(0)
    expect(createdAt(d)).toBe('<t>')
  })
})
