// Moved to src/shared/daemon-client/sse.ts (design D8). Re-exported here so
// TUI imports stay as they were; values go through the cjs() shim (interop.ts).

import * as sseNs from '../../../shared/daemon-client/sse'
import { cjs } from '../interop'
import type { DaemonEventFrame } from '../../../shared/daemon-client/types'

export type { ConnectionInfo, ConnectionState, DedupeKey, EventStreamOptions, ResumeInfo, StreamFrame, StreamQuery } from '../../../shared/daemon-client/sse'

const shared = cjs(sseNs)

export const EventStream = shared.EventStream
export type EventStream<F extends sseNs.StreamFrame = DaemonEventFrame> = sseNs.EventStream<F>
export const dedupeKey = shared.dedupeKey
