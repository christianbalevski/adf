import type { ChannelAdapter } from '../../../shared/types/channel-adapter.types'
import { DiscordAdapter } from './discord-adapter'

/**
 * Factory function for the Discord channel adapter.
 * Conforms to the CreateAdapterFn interface.
 */
export function createAdapter(): ChannelAdapter {
  return new DiscordAdapter()
}
