import type { ChannelAdapter } from '../../../shared/types/channel-adapter.types'
import { EmailAdapter } from './email-adapter'

/**
 * Factory function for the Email channel adapter.
 * Conforms to the CreateAdapterFn interface.
 */
export function createAdapter(): ChannelAdapter {
  return new EmailAdapter()
}
