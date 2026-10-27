// The daemon's bundle entry (out/main/daemon.js): the check, then the daemon.
// See ../entry.ts for why the daemon is not imported statically.
import '../utils/brotli-runtime-check'

import('./index').catch((err) => {
  console.error(err)
  process.exit(1)
})
