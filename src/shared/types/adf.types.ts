import type { AgentConfig } from './adf-v02.types'
import type { LLMMessage } from './provider.types'

/** A single entry in the chat UI log (mirrors AgentLogEntry shape) */
export interface ChatHistoryEntry {
  id: string
  type: 'text' | 'user' | 'tool_call' | 'tool_result' | 'error' | 'system' | 'inter_agent'
  content: string
  timestamp: number
  metadata?: Record<string, unknown>
}

/** Persisted chat history stored as chat.json inside the .adf ZIP */
export interface ChatHistory {
  version: 1
  uiLog: ChatHistoryEntry[]
  llmMessages: LLMMessage[]
}

export interface InboxMessage {
  id: string
  from: string
  to?: string
  reply_to?: string
  network?: string
  thread_id?: string
  parent_id?: string
  subject?: string
  content: string
  content_type?: string
  attachments?: Array<{ filename: string; content_type: string; transfer: string; path?: string; size_bytes?: number; skipped?: boolean; reason?: string }>
  meta?: Record<string, unknown>
  sender_alias?: string
  recipient_alias?: string
  message_id?: string
  owner?: string
  card?: string
  return_path?: string
  source?: string
  source_context?: Record<string, unknown>
  sent_at?: number
  received_at: number
  status: 'unread' | 'read' | 'archived'
  original_message?: string
}

export interface Inbox {
  version: 1
  messages: InboxMessage[]
}

export interface RendererOutboxMessage {
  id: string
  from: string
  to: string
  reply_to?: string
  thread_id?: string
  parent_id?: string
  subject?: string
  content: string
  sender_alias?: string
  recipient_alias?: string
  status: 'pending' | 'sent' | 'delivered' | 'failed'
  status_code?: number
  created_at: number
  delivered_at?: number
}

export interface AdfArchiveContents {
  agentConfig: AgentConfig
  documentMd: string
  mindMd: string
  additionalFiles: Map<string, Buffer>
  chatHistory?: ChatHistory
  inbox?: Inbox
}
