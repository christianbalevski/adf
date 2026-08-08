import type { ChannelAdapter } from '../../../shared/types/channel-adapter.types'
import { WhatsAppAdapter } from './whatsapp-adapter'

/**
 * Factory function for the WhatsApp channel adapter.
 * Conforms to the CreateAdapterFn interface.
 */
export function createAdapter(): ChannelAdapter {
  return new WhatsAppAdapter()
}
