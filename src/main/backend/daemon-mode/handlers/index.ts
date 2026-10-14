import type { DaemonHandlerTable, DaemonSendHandlerTable } from '../context'
import { DOCUMENT_HANDLERS, DOCUMENT_SEND_HANDLERS } from '../documents'
import { APP_HANDLERS } from './app'
import { CORE_HANDLERS } from './core'
import { SETTINGS_IDENTITY_HANDLERS } from './settings-identity'
import { FLEET_HANDLERS } from './fleet'
import { MCP_HANDLERS } from './mcp'
import { ADAPTER_HANDLERS } from './adapters'
import { REGISTRY_HANDLERS } from './registries'

/**
 * Every implemented daemon-mode invoke handler. Wave 3 workstreams add their
 * domain tables here (one spread line each); a channel with no entry gets the
 * visible "not available in daemon mode yet" handler from pending.ts.
 */
export const DAEMON_MODE_HANDLERS: DaemonHandlerTable = {
  ...APP_HANDLERS,
  ...CORE_HANDLERS,
  ...SETTINGS_IDENTITY_HANDLERS,
  ...FLEET_HANDLERS,
  ...MCP_HANDLERS, ...ADAPTER_HANDLERS, ...REGISTRY_HANDLERS,
  ...DOCUMENT_HANDLERS,
}

/** Every implemented daemon-mode `send` handler (renderer `ipcRenderer.send`); the rest log "not available yet". */
export const DAEMON_MODE_SEND_HANDLERS: DaemonSendHandlerTable = {
  ...DOCUMENT_SEND_HANDLERS,
}
