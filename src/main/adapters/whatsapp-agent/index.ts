import type { ChannelAdapter } from '../../../shared/types/channel-adapter.types'
import { WhatsAppAgentAdapter } from './whatsapp-agent-adapter'

/**
 * Factory function for the official WhatsApp agent channel adapter.
 * Conforms to the CreateAdapterFn interface.
 */
export function createAdapter(): ChannelAdapter {
  return new WhatsAppAgentAdapter()
}
