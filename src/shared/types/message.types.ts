export interface AgentMessage {
  id: string
  from: string
  to: string[]
  channel: string[]
  type: 'broadcast' | 'request' | 'response'
  content: string
  timestamp: number
  replyTo?: string
}
