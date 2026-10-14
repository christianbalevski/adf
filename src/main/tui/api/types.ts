// Moved to src/shared/daemon-client/types.ts (design D8). Re-exported here so
// TUI imports stay as they were; values go through the cjs() shim (interop.ts).

import * as typesNs from '../../../shared/daemon-client/types'
import { cjs } from '../interop'

export type * from '../../../shared/daemon-client/types'

const shared = cjs(typesNs)

export const MAIN_LOOP = shared.MAIN_LOOP
export const DaemonError = shared.DaemonError
export type DaemonError = typesNs.DaemonError
export const isCredentialsLocked = shared.isCredentialsLocked
export const SUPPORTED_CLIENT_API_VERSION = shared.SUPPORTED_CLIENT_API_VERSION
