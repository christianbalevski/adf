import type { ChannelAdapter } from '../../../shared/types/channel-adapter.types'
import { SlackAdapter } from './slack-adapter'

/**
 * Factory function for the Slack channel adapter.
 * Conforms to the CreateAdapterFn interface.
 */
export function createAdapter(): ChannelAdapter {
  return new SlackAdapter()
}
