import type { DaemonHandlerTable } from '../context'
import { COMPUTE_HANDLERS } from './compute'
import { MESH_HANDLERS } from './mesh'
import { USAGE_HANDLERS } from './usage'

/**
 * W3-D's daemon-mode handlers: mesh, fleet map, overview card, token usage,
 * context breakdown, home dashboard, compute, LAN firewall, emergency stop.
 */
export const FLEET_HANDLERS: DaemonHandlerTable = {
  ...MESH_HANDLERS,
  ...USAGE_HANDLERS,
  ...COMPUTE_HANDLERS,
}
