// Studio main's bundle entry (out/main/index.js). The check runs here, alone:
// the bundle requires every external module at the top of the file, so a
// static import of the app would load electron-updater, better-sqlite3 and
// the rest before the check. The app loads only after the check passed.
import './utils/brotli-runtime-check'

import('./index').catch((err) => {
  console.error(err)
  process.exit(1)
})
