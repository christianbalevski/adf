/**
 * Resource revisions (W3-F, design D5.2): a monotonic revision per agent and
 * resource (`config`, and `file:<path>` for the document and every internal
 * file), so a client saves over what it last saw and is refused with
 * `stale_revision` when someone else wrote in between.
 *
 * Revisions are derived from content, not hooked into every write path. Each
 * resource remembers the revision it last handed out and the hash of the
 * content that revision names. An observation (a read, a write, a change
 * event) hashes the current content: the same hash keeps the revision, a
 * different one takes the next revision. So a write nobody announced (shell
 * redirection, sys_code, a lambda, a mesh delivery) still moves the revision
 * at the next look, and a revision always names exactly one content: a write
 * whose base revision is current was made over the current content.
 *
 * Kept in memory, per workspace (the open document and the agent started on
 * it share one). Revisions are drawn from one process-wide counter that
 * starts at the wall clock in microseconds, so a restarted daemon never hands
 * out a revision an earlier run used: a client holding an old revision is
 * refused once and, when the content is what it last saw, saves again over
 * the new revision (the clients compare before they show a conflict).
 *
 * Writer: who made the change a new revision records. A write that knows its
 * origin runs inside runAsWriter (daemon routes: the client session or the
 * CLI; embedded Studio: its own window); a change detected without one is the
 * agent's.
 */
import { createHash } from 'node:crypto'
import type { ResourceWriter } from '../../shared/types/resource-revision.types'

export type { ResourceWriter } from '../../shared/types/resource-revision.types'

export interface ResourceRevision {
  revision: number
  /** Who made the change this revision names; null when it was the content first seen. */
  writer: ResourceWriter | null
  /** sha1 of the content (`absent` for a missing file). */
  hash: string
}

/** The workspace surface revisions are read from. */
export interface RevisionedWorkspace {
  getRoot?(): object
  getAgentConfig(): unknown
  readDocument(): string
  getDocumentPath(): string
  readFileBuffer(path: string): Buffer | null
}

export const AGENT_WRITER: ResourceWriter = Object.freeze({ kind: 'agent' }) as ResourceWriter

let lastRevision = 0

/** The next revision: strictly above every earlier one, and above the clock (µs) so a restart starts past them. */
function nextRevision(): number {
  lastRevision = Math.max(lastRevision + 1, Date.now() * 1000)
  return lastRevision
}

let currentWriter: ResourceWriter | null = null

/**
 * Run `fn` (synchronously) as a write by `writer`: a revision taken inside it
 * records that writer. Nothing `fn` queues inherits it (no async context), as
 * runAsClientWrite.
 */
export function runAsWriter<T>(writer: ResourceWriter, fn: () => T): T {
  const previous = currentWriter
  currentWriter = writer
  try {
    return fn()
  } finally {
    currentWriter = previous
  }
}

/** The writer of the write running now; the agent when none announced itself. */
export function currentResourceWriter(): ResourceWriter {
  return currentWriter ?? AGENT_WRITER
}

interface Entry { revision: number; hash: string; writer: ResourceWriter | null }

const tables = new WeakMap<object, Map<string, Entry>>()

function hashOf(content: string | Buffer | null): string {
  if (content === null) return 'absent'
  return createHash('sha1').update(content).digest('hex')
}

function ownerOf(workspace: RevisionedWorkspace | object): object {
  const ws = workspace as RevisionedWorkspace
  return typeof ws.getRoot === 'function' ? ws.getRoot() : workspace
}

/**
 * The revision of `key`'s content as it is now. A different content than the
 * last observation takes the next revision, recorded with `writer`: the one
 * passed (an observation right after a known write), else the agent, or
 * nobody for the first observation of a resource.
 */
export function observeRevision(workspace: object, key: string, content: string | Buffer | null, writer?: ResourceWriter): ResourceRevision {
  const owner = ownerOf(workspace)
  let table = tables.get(owner)
  if (!table) {
    table = new Map()
    tables.set(owner, table)
  }
  const hash = hashOf(content)
  const entry = table.get(key)
  if (entry && entry.hash === hash) return { revision: entry.revision, writer: entry.writer, hash }
  const next: Entry = { revision: nextRevision(), hash, writer: writer ?? (entry ? AGENT_WRITER : null) }
  table.set(key, next)
  return { revision: next.revision, writer: next.writer, hash }
}

/** The key of an internal file. The document is the file at its document path. */
export function fileRevisionKey(path: string): string {
  return `file:${path}`
}

/** Canonical text of a config for hashing (the stored JSON, parsed and re-serialized). */
function configText(config: unknown): string {
  return JSON.stringify(config ?? null)
}

/** Current revision of the agent config. Pass `writer` only for the observation right after a write. */
export function configRevision(workspace: RevisionedWorkspace, writer?: ResourceWriter): ResourceRevision {
  return observeRevision(workspace, 'config', configText(workspace.getAgentConfig()), writer)
}

/** Current revision of the document (the file at the document path). */
export function documentRevision(workspace: RevisionedWorkspace, writer?: ResourceWriter): ResourceRevision {
  return observeRevision(workspace, fileRevisionKey(workspace.getDocumentPath()), workspace.readDocument(), writer)
}

/** Current revision of an internal file (`absent` content when it does not exist). */
export function fileRevision(workspace: RevisionedWorkspace, path: string, writer?: ResourceWriter): ResourceRevision {
  return observeRevision(workspace, fileRevisionKey(path), workspace.readFileBuffer(path), writer)
}

/**
 * A base revision from a request: an integer, or a string of digits (an
 * `If-Match` header, optionally quoted, or a query parameter). `undefined`
 * when none was sent, and for `*` (any current version: no base); `null`
 * when one was sent but is not a revision.
 */
export function parseBaseRevision(value: unknown): number | undefined | null {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'string' && value.trim() === '*') return undefined
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null
  if (typeof value !== 'string') return null
  const text = value.trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1')
  if (!/^\d{1,16}$/.test(text)) return null
  return Number(text)
}

/** The details of a refused write, as the 409 body and Studio's conflict carry them. */
export interface StaleRevisionDetails {
  resource: string
  revision: number
  baseRevision: number
  writer: ResourceWriter | null
  size: number | null
  hash: string
}

/** Null when `base` is absent (last write wins) or current; the refusal details otherwise. */
export function staleRevision(resource: string, current: ResourceRevision, base: number | undefined, size: number | null): StaleRevisionDetails | null {
  if (base === undefined || base === current.revision) return null
  return { resource, revision: current.revision, baseRevision: base, writer: current.writer, size, hash: current.hash }
}

/**
 * A create that must not replace anything (`If-None-Match: *`, or
 * `mustNotExist`): null while the file is absent; the refusal details,
 * as for a stale base, once it exists.
 */
export function existsAlready(resource: string, current: ResourceRevision, size: number | null): StaleRevisionDetails | null {
  if (current.hash === 'absent') return null
  return { resource, revision: current.revision, baseRevision: -1, writer: current.writer, size, hash: current.hash }
}

/** The refusal sentence: what changed, by whom. */
export function staleRevisionMessage(details: StaleRevisionDetails): string {
  const what = details.resource === 'config' ? 'The config' : details.resource === 'document' ? 'The document' : `"${details.resource}"`
  const by = details.writer?.kind === 'agent' ? ' by the agent'
    : details.writer?.kind === 'cli' ? ' by the CLI or another API client'
      : details.writer?.kind === 'client' ? ` by a ${details.writer.client} client`
        : ''
  if (details.baseRevision < 0) return `${what} already exists (created${by}, revision ${details.revision}). Read it, or save with baseRevision ${details.revision} to overwrite.`
  return `${what} changed${by} since revision ${details.baseRevision} (now ${details.revision}). Reload it, or save again with baseRevision ${details.revision} to overwrite.`
}
