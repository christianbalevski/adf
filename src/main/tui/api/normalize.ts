// Moved to src/shared/daemon-client/normalize.ts (design D8). Re-exported here
// so TUI imports stay as they were; values go through the cjs() shim (interop.ts).

import * as normalizeNs from '../../../shared/daemon-client/normalize'
import { cjs } from '../interop'

export const normalizeRuntime = cjs(normalizeNs).normalizeRuntime
