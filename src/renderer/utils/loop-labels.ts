import type { AgentLogEntry } from '../stores/agent.store'

/**
 * Labels for loop rows that are not the owner's words: what woke the agent,
 * and the context the model received besides the conversation.
 */

const WAKE_TAGS: Record<string, string> = {
  timer: 'Timer',
  schedule: 'Timer',
  inbox: 'Inbox',
  inbox_notification: 'Inbox',
  message_received: 'Message',
  file_change: 'File change',
  document_edit: 'File change',
  startup: 'Startup',
  autonomous_start: 'Autonomous start',
  outbox: 'Outbox',
  tool_call: 'Tool call',
  task_create: 'Task created',
  task_complete: 'Task done',
  log_entry: 'Log entry',
  llm_call: 'LLM call',
  batch: 'Batch',
}

function lineValue(content: string, key: string): string | undefined {
  const line = content.split('\n').find((l) => l.startsWith(`${key}: `))
  return line?.slice(key.length + 2).trim() || undefined
}

/** The tag and a one-line detail for the row that opens a woken turn. */
export function describeWake(entry: AgentLogEntry): { tag: string; detail?: string } {
  const type = (entry.metadata?.triggerType as string | undefined) ?? 'unknown'
  const tag = WAKE_TAGS[type] ?? 'Wake'
  const text = entry.content
  const firstLine = text.split('\n')[0]
  let detail: string | undefined
  switch (type) {
    case 'timer':
    case 'schedule':
      detail = lineValue(text, 'Payload')
      break
    case 'inbox':
    case 'inbox_notification': {
      const unread = text.match(/"unread":\s*(\d+)/)
      if (unread) detail = `${unread[1]} unread`
      break
    }
    case 'message_received':
      detail = text.match(/^You received a message from agent "([^"]+)"/)?.[1]
      break
    case 'file_change':
      detail = firstLine.replace(/^A file has been /, '')
      break
    case 'outbox':
      detail = text.match(/^An outbound message was sent to "([^"]+)"/)?.[1]
      break
    case 'tool_call':
    case 'task_create':
    case 'task_complete': {
      const tool = lineValue(text, 'Tool')
      const status = type === 'task_complete' ? lineValue(text, 'Status') : undefined
      detail = [tool, status].filter(Boolean).join(' · ') || undefined
      break
    }
    case 'log_entry':
      detail = lineValue(text, 'Message')
      break
    case 'llm_call':
      detail = lineValue(text, 'Model')
      break
    case 'batch':
      detail = text.match(/events fired: ([^.]+)\./)?.[1]
      break
  }
  return detail ? { tag, detail } : { tag }
}

/** The label of a context row folded into a step block. */
export function contextLabel(entry: AgentLogEntry): string {
  const meta = entry.metadata ?? {}
  switch (meta.category) {
    case 'instructions':
      return 'Instructions updated'
    case 'system_prompt':
      return 'Instructions updated · system prompt'
    case 'dynamic_instructions':
      return 'Instructions updated · dynamic instructions'
    case 'provider_context':
      return `Added by ${typeof meta.addedBy === 'string' ? meta.addedBy : 'provider'}`
    case 'injected': {
      const name = String(meta.injectCategory ?? 'context')
      // The runtime's own injections (the skills index) carry a system: origin.
      return String(meta.origin ?? '').startsWith('system:') ? `Added by runtime · ${name}` : `Agent added context · ${name}`
    }
    default:
      return typeof meta.category === 'string' ? `Context · ${meta.category}` : 'Context'
  }
}

/**
 * The system prompt and dynamic instructions recorded together (the executor
 * writes them back to back) as one row, so a changed turn shows one
 * "Instructions updated" step. Anything else passes through.
 */
export function mergeInstructionRows(entries: AgentLogEntry[]): AgentLogEntry[] {
  const out: AgentLogEntry[] = []
  for (const entry of entries) {
    const prev = out[out.length - 1]
    if (
      entry.type === 'context' && entry.metadata?.category === 'dynamic_instructions'
      && prev?.type === 'context' && prev.metadata?.category === 'system_prompt'
    ) {
      out[out.length - 1] = {
        ...prev,
        content: `System prompt\n\n${prev.content}\n\nDynamic instructions\n\n${entry.content}`,
        metadata: { ...prev.metadata, category: 'instructions' },
      }
      continue
    }
    out.push(entry)
  }
  return out
}
