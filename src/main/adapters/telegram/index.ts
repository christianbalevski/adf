import type { ChannelAdapter } from '../../../shared/types/channel-adapter.types'
import { TelegramAdapter } from './telegram-adapter'

/**
 * Factory function for the Telegram channel adapter.
 * Conforms to the CreateAdapterFn interface.
 */
export function createAdapter(): ChannelAdapter {
  return new TelegramAdapter()
}
