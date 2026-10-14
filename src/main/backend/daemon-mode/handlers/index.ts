import type { DaemonHandlerTable } from '../context'
import { APP_HANDLERS } from './app'
import { CORE_HANDLERS } from './core'
import { FLEET_HANDLERS } from './fleet'

/**
 * Every implemented daemon-mode invoke handler. Wave 3 workstreams add their
 * domain tables here (one spread line each); a channel with no entry gets the
 * visible "not available in daemon mode yet" handler from pending.ts.
 */
export const DAEMON_MODE_HANDLERS: DaemonHandlerTable = {
  ...APP_HANDLERS,
  ...CORE_HANDLERS,
  ...FLEET_HANDLERS,
}
