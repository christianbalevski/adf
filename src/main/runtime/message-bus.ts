import { EventEmitter } from 'events'
import type { AgentMessage } from '../../shared/types/message.types'

interface AgentRegistration {
  name: string
  channels: string[]
}

export interface MessageBusLogEntry {
  timestamp: number
  messageId: string
  from: string
  to: string[]
  channel: string
  type: string
  content: string
  delivered: boolean
  deliveredTo: string[]
  error?: string
}

export interface DeliveryInfo {
  agentName: string
  mentioned: boolean
}

/**
 * A channel-based message bus for inter-agent communication.
 * Lives in the main process. Each open agent registers itself.
 *
 * Routing rules:
 * - If `to` non-empty & `channel` empty → deliver only to agents named in `to` (DM)
 * - If `channel` non-empty → deliver to agents subscribed to any matching channel (+ wildcard `*`)
 * - If both empty → deliver to all (broadcast)
 * - `mentioned: true` on delivery if recipient is in `to` list
 */
export class MessageBus extends EventEmitter {
  private agents: Map<string, AgentRegistration> = new Map()
  private log: MessageBusLogEntry[] = []
  private maxLogEntries = 200

  // Performance: O(1) channel lookup index (channel -> Set of agent names)
  private channelIndex: Map<string, Set<string>> = new Map()

  registerAgent(name: string, channels: string[]): void {
    this.agents.set(name, { name, channels })

    // Build channel index for O(1) routing
    for (const channel of channels) {
      if (!this.channelIndex.has(channel)) {
        this.channelIndex.set(channel, new Set())
      }
      this.channelIndex.get(channel)!.add(name)
    }

    console.log(`[MessageBus] Registered agent: ${name} with channels: [${channels.join(', ')}]`)
  }

  unregisterAgent(name: string): void {
    const agent = this.agents.get(name)
    if (agent) {
      // Clean up channel index
      for (const channel of agent.channels) {
        const subscribers = this.channelIndex.get(channel)
        if (subscribers) {
          subscribers.delete(name)
          if (subscribers.size === 0) {
            this.channelIndex.delete(channel)
          }
        }
      }
    }

    this.agents.delete(name)
    console.log(`[MessageBus] Unregistered agent: ${name}`)
  }

  updateChannels(name: string, channels: string[]): void {
    const reg = this.agents.get(name)
    if (reg) {
      // Remove from old channels in index
      for (const oldChannel of reg.channels) {
        const subscribers = this.channelIndex.get(oldChannel)
        if (subscribers) {
          subscribers.delete(name)
          if (subscribers.size === 0) {
            this.channelIndex.delete(oldChannel)
          }
        }
      }

      // Update registration
      reg.channels = channels

      // Add to new channels in index
      for (const newChannel of channels) {
        if (!this.channelIndex.has(newChannel)) {
          this.channelIndex.set(newChannel, new Set())
        }
        this.channelIndex.get(newChannel)!.add(name)
      }

      console.log(`[MessageBus] Updated channels for ${name}: [${channels.join(', ')}]`)
    }
  }

  send(message: AgentMessage): void {
    const deliveries: DeliveryInfo[] = []
    let selfSendError: string | undefined

    const toSet = new Set(message.to)
    const channelSet = new Set(message.channel)
    const hasDmTargets = toSet.size > 0
    const hasChannels = channelSet.size > 0

    if (hasDmTargets && !hasChannels) {
      // DM mode: deliver only to agents named in `to`
      if (toSet.has(message.from)) {
        selfSendError = 'Cannot send a message to yourself.'
      }
      for (const [name] of this.agents) {
        if (name === message.from) continue
        if (toSet.has(name)) {
          deliveries.push({ agentName: name, mentioned: true })
        }
      }
    } else if (hasChannels) {
      // Channel mode: deliver to agents subscribed to any matching channel
      // Use O(1) index lookup instead of O(n) scan
      const recipients = new Set<string>()

      // Add agents subscribed to wildcard
      const wildcardSubscribers = this.channelIndex.get('*')
      if (wildcardSubscribers) {
        for (const name of wildcardSubscribers) {
          if (name !== message.from) {
            recipients.add(name)
          }
        }
      }

      // Add agents subscribed to specific channels
      for (const channel of message.channel) {
        const subscribers = this.channelIndex.get(channel)
        if (subscribers) {
          for (const name of subscribers) {
            if (name !== message.from) {
              recipients.add(name)
            }
          }
        }
      }

      // Convert to deliveries
      for (const name of recipients) {
        deliveries.push({ agentName: name, mentioned: toSet.has(name) })
      }
    } else {
      // Broadcast: deliver to all agents
      for (const [name] of this.agents) {
        if (name === message.from) continue
        deliveries.push({ agentName: name, mentioned: toSet.has(name) })
      }
    }

    // Deliver messages
    const deliveredTo: string[] = []
    for (const delivery of deliveries) {
      deliveredTo.push(delivery.agentName)
      try {
        this.emit(`message:${delivery.agentName}`, message, delivery.mentioned)
      } catch (err) {
        console.error(`[MessageBus] Error delivering to ${delivery.agentName}:`, err)
      }
    }

    const channelLabel = message.channel.length > 0 ? message.channel.join(',') : '(none)'
    const entry: MessageBusLogEntry = {
      timestamp: Date.now(),
      messageId: message.id,
      from: message.from,
      to: message.to,
      channel: channelLabel,
      type: message.type,
      content: typeof message.content === 'string' ? message.content.slice(0, 200) : String(message.content).slice(0, 200),
      delivered: deliveredTo.length > 0,
      deliveredTo
    }

    if (selfSendError) {
      entry.error = selfSendError
      console.warn(`[MessageBus] ${entry.error}`)
    } else if (deliveredTo.length === 0) {
      if (hasDmTargets) {
        entry.error = `Target(s) "${message.to.join(', ')}" not found in registered agents: [${Array.from(this.agents.keys()).join(', ')}]`
      } else if (hasChannels) {
        entry.error = `No agents matched channel(s) "${message.channel.join(', ')}". Registered: [${Array.from(this.agents.keys()).join(', ')}]`
      } else {
        entry.error = `No other agents registered. Registered: [${Array.from(this.agents.keys()).join(', ')}]`
      }
      console.warn(`[MessageBus] ${entry.error}`)
    }

    this.log.push(entry)
    if (this.log.length > this.maxLogEntries) {
      this.log.splice(0, this.log.length - this.maxLogEntries)
    }

    if (process.env.NODE_ENV !== 'production') {
      const toLabel = message.to.length > 0 ? message.to.join(',') : '*'
      console.log(
        `[MessageBus] ${message.from} -> ${toLabel} [${channelLabel}]: delivered=${deliveredTo.length > 0} (to: ${deliveredTo.join(', ') || 'nobody'})`
      )
    }
  }

  onMessage(
    agentName: string,
    callback: (message: AgentMessage, mentioned: boolean) => void
  ): () => void {
    const handler = (msg: AgentMessage, mentioned: boolean) => callback(msg, mentioned)
    this.on(`message:${agentName}`, handler)
    return () => this.off(`message:${agentName}`, handler)
  }

  getRegisteredAgents(): string[] {
    return Array.from(this.agents.keys())
  }

  getRegistrations(): { name: string; channels: string[] }[] {
    return Array.from(this.agents.values())
  }

  /** Append a pre-built log entry (used by MeshManager which handles its own routing). */
  logEntry(entry: MessageBusLogEntry): void {
    this.log.push(entry)
    if (this.log.length > this.maxLogEntries) {
      this.log.splice(0, this.log.length - this.maxLogEntries)
    }
  }

  getLog(): MessageBusLogEntry[] {
    return [...this.log]
  }

  clearLog(): void {
    this.log = []
  }
}
