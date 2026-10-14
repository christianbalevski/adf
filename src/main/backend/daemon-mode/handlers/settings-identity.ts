import type { DaemonHandlerTable } from '../context'
import { IDENTITY_HANDLERS } from './identity'
import { PROVIDER_HANDLERS } from './providers'

/** W3-B's channels: providers, models, subscription sign-in (providers.ts) and identity (identity.ts). */
export const SETTINGS_IDENTITY_HANDLERS: DaemonHandlerTable = {
  ...PROVIDER_HANDLERS,
  ...IDENTITY_HANDLERS,
}
