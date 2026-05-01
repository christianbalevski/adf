/**
 * ADF Unified Event System
 *
 * CloudEvents-inspired envelope with typed data payloads.
 * Event data reuses existing row types — same shape agents get from read tools.
 *
 * Key separation: AdfEvent (what happened) vs AdfEventDispatch (what to do about it).
 * One occurrence produces one event. Each matching trigger target produces one dispatch.
 */

import type {
  InboxMessage, OutboxMessage, Timer, TaskEntry, AdfLogEntry,
  LoopEntry, FileProtectionLevel, TriggerScopeV3, TriggerTypeV3, LogLevel,
} from './adf-v02.types'

// =============================================================================
// Event Types
// =============================================================================

export const ADF_EVENT_TYPES = [
  'inbox', 'outbox', 'file_change', 'chat', 'timer',
  'tool_call', 'task_create', 'task_complete', 'log_entry', 'startup',
  'llm_call',
] as const

export type AdfEventType = (typeof ADF_EVENT_TYPES)[number]

/** Map config trigger names (on_inbox) to event types (inbox). */
export const TRIGGER_TO_EVENT_TYPE: Record<TriggerTypeV3, AdfEventType> = {
  on_startup: 'startup',
  on_inbox: 'inbox',
  on_outbox: 'outbox',
  on_file_change: 'file_change',
  on_chat: 'chat',
  on_timer: 'timer',
  on_tool_call: 'tool_call',
  on_task_create: 'task_create',
  on_task_complete: 'task_complete',
  on_logs: 'log_entry',
  on_llm_call: 'llm_call',
}

// =============================================================================
// Per-Event Data Interfaces
// =============================================================================

// inbox: same shape as msg_read returns
export interface InboxEventData {
  message: InboxMessage
}

// outbox: same shape as outbox row
export interface OutboxEventData {
  message: OutboxMessage
}

// file_change: FileEntry metadata (minus content Buffer) + operation + diff
export interface FileChangeEventData {
  path: string
  mime_type: string | null
  size: number
  protection: FileProtectionLevel
  authorized: boolean
  created_at: string
  updated_at: string
  operation: 'created' | 'modified' | 'deleted'
  diff: string | null
}

// chat: same shape as loop row
export interface ChatEventData {
  message: LoopEntry
}

// timer: same shape as sys_list_timers returns
export interface TimerEventData {
  timer: Timer
}

// tool_call: ephemeral runtime event, no row
export interface ToolCallEventData {
  toolName: string
  args: Record<string, unknown>
  origin: string
}

// task_create: same shape as task row
export interface TaskCreateEventData {
  task: TaskEntry
}

// task_complete: same shape as task row
export interface TaskCompleteEventData {
  task: TaskEntry
}

// log_entry: same shape as log row
export interface LogEntryEventData {
  entry: AdfLogEntry
}

export interface LlmCallMetadata {
  provider: string
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens?: number
  cache_write_tokens?: number
  reasoning_tokens?: number
  duration_ms: number
  stop_reason: string
}

export interface LlmCallEventData extends LlmCallMetadata {
  source: 'turn' | 'compaction' | 'model_invoke' | string
  cost_usd?: number
  turn_id?: string
}

// startup: no data — event.type === 'startup' is the information

// =============================================================================
// Event Data Map (discriminant → data type)
// =============================================================================

export interface AdfEventDataMap {
  inbox: InboxEventData
  outbox: OutboxEventData
  file_change: FileChangeEventData
  chat: ChatEventData
  timer: TimerEventData
  tool_call: ToolCallEventData
  task_create: TaskCreateEventData
  task_complete: TaskCompleteEventData
  log_entry: LogEntryEventData
  startup: undefined
  llm_call: LlmCallEventData
}

// =============================================================================
// Event Envelope (immutable, one per occurrence)
// =============================================================================

export interface AdfEvent<T extends AdfEventType = AdfEventType> {
  /** Unique event ID (nanoid). */
  id: string
  /** Event type discriminant. */
  type: T
  /** Origin identifier. Format: "agent:<agentId>" | "system" | "adapter:<name>" */
  source: string
  /** ISO 8601 timestamp of when the event was created. */
  time: string
  /** Event-specific payload, typed by the discriminant. */
  data: AdfEventDataMap[T]
  /** Correlation ID for tracing event chains across agents. */
  correlationId?: string
}

/** Full discriminated union of all concrete event types. */
export type AnyAdfEvent =
  | AdfEvent<'inbox'>
  | AdfEvent<'outbox'>
  | AdfEvent<'file_change'>
  | AdfEvent<'chat'>
  | AdfEvent<'timer'>
  | AdfEvent<'tool_call'>
  | AdfEvent<'task_create'>
  | AdfEvent<'task_complete'>
  | AdfEvent<'log_entry'>
  | AdfEvent<'startup'>
  | AdfEvent<'llm_call'>

// =============================================================================
// Event Dispatch (one per matching trigger target)
// =============================================================================

export interface AdfEventDispatch<T extends AdfEventType = AdfEventType> {
  event: AdfEvent<T>
  scope: TriggerScopeV3
  /** System scope: lambda entry point ("path/file.ts:functionName"). */
  lambda?: string
  /** System scope: shell command (alternative to lambda). */
  command?: string
  /** System scope: keep sandbox worker alive between invocations. */
  warm?: boolean
}

/** Full discriminated union of all dispatch types. */
export type AnyAdfEventDispatch =
  | AdfEventDispatch<'inbox'>
  | AdfEventDispatch<'outbox'>
  | AdfEventDispatch<'file_change'>
  | AdfEventDispatch<'chat'>
  | AdfEventDispatch<'timer'>
  | AdfEventDispatch<'tool_call'>
  | AdfEventDispatch<'task_create'>
  | AdfEventDispatch<'task_complete'>
  | AdfEventDispatch<'log_entry'>
  | AdfEventDispatch<'startup'>
  | AdfEventDispatch<'llm_call'>

// =============================================================================
// Batch Dispatch
// =============================================================================

export interface AdfBatchDispatch<T extends AdfEventType = AdfEventType> {
  events: AdfEvent<T>[]
  count: number
  scope: TriggerScopeV3
  lambda?: string
  command?: string
  warm?: boolean
}

// =============================================================================
// Per-Trigger Filters (replace flat TriggerFilter)
// =============================================================================

export interface InboxFilter {
  source?: string
  sender?: string
}

export interface OutboxFilter {
  to?: string
}

export interface FileChangeFilter {
  watch: string     // glob pattern (required for file_change)
}

export interface ToolCallFilter {
  tools: string[]   // tool name glob patterns (required)
}

export interface TaskCreateFilter {
  tools?: string[]
}

export interface TaskCompleteFilter {
  tools?: string[]
  status?: string
}

export interface LogEntryFilter {
  level?: LogLevel[]
  origin?: string[]   // glob patterns
  event?: string[]    // glob patterns
}

export interface LlmCallFilter {
  source?: string[]
  provider?: string[]
}

// Chat, Timer, Startup: no meaningful filters
export type ChatFilter = Record<string, never>
export type TimerFilter = Record<string, never>
export type StartupFilter = Record<string, never>

/** Maps event type to its filter interface. */
export interface AdfFilterMap {
  inbox: InboxFilter
  outbox: OutboxFilter
  file_change: FileChangeFilter
  chat: ChatFilter
  timer: TimerFilter
  tool_call: ToolCallFilter
  task_create: TaskCreateFilter
  task_complete: TaskCompleteFilter
  log_entry: LogEntryFilter
  startup: StartupFilter
  llm_call: LlmCallFilter
}

// =============================================================================
// Factories
// =============================================================================

import { randomUUID } from 'crypto'

/** Create an AdfEvent with auto-generated id and timestamp. */
export function createEvent<T extends AdfEventType>(params: {
  type: T
  source: string
  data: AdfEventDataMap[T]
  correlationId?: string
}): AdfEvent<T> {
  return {
    id: randomUUID(),
    type: params.type,
    source: params.source,
    time: new Date().toISOString(),
    data: params.data,
    correlationId: params.correlationId,
  }
}

/** Wrap an event with dispatch routing for a specific target. */
export function createDispatch<T extends AdfEventType>(
  event: AdfEvent<T>,
  target: {
    scope: TriggerScopeV3
    lambda?: string
    command?: string
    warm?: boolean
  },
): AdfEventDispatch<T> {
  return {
    event,
    scope: target.scope,
    lambda: target.lambda,
    command: target.command,
    warm: target.warm,
  }
}
