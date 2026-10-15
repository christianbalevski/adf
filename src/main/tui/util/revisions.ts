// W3-F: saving over the revision the terminal app read. A config, document
// or file write carries `baseRevision`; the daemon refuses it with
// `409 stale_revision` when someone else (the agent, Studio, the CLI) wrote
// since, and the caller asks the user: reload theirs, or overwrite with the
// current revision as the base.

import { DaemonError } from '../api/types'
import * as revisionTypesNs from '../../../shared/types/resource-revision.types'
import type { ResourceWriter } from '../../../shared/types/resource-revision.types'
import { cjs } from '../interop'

const { describeWriter } = cjs(revisionTypesNs)

/** A refused write: the revision there now and who made it. */
export interface StaleRevision {
  revision: number
  writer: ResourceWriter | null
}

/** The revision a read or write answer carries, if any. */
export function revisionOf(result: unknown): number | undefined {
  const revision = (result as { revision?: unknown } | null | undefined)?.revision
  return typeof revision === 'number' ? revision : undefined
}

/** The details of a `409 stale_revision`, or null for any other error. */
export function staleRevisionOf(err: unknown): StaleRevision | null {
  if (!(err instanceof DaemonError) || err.status !== 409) return null
  const body = err.body as { code?: unknown; revision?: unknown; writer?: unknown } | null
  if (body?.code !== 'stale_revision' || typeof body.revision !== 'number') return null
  return { revision: body.revision, writer: (body.writer as ResourceWriter | null | undefined) ?? null }
}

/** "changed by the agent" for a confirm dialog. */
export function changedBy(stale: StaleRevision): string {
  return `changed by ${describeWriter(stale.writer)}`
}

/** Run a write; a stale revision comes back as `{ stale }` instead of throwing. */
export async function writeOver<T>(write: () => Promise<T>): Promise<{ ok: T } | { stale: StaleRevision }> {
  try {
    return { ok: await write() }
  } catch (err) {
    const stale = staleRevisionOf(err)
    if (stale) return { stale }
    throw err
  }
}
