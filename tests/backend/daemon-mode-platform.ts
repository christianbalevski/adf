// Direct handler tests use the same mocked Electron capabilities as desktop boot.
import * as electron from 'electron'
import { setDaemonDesktopPlatform } from '../../src/main/backend/daemon-mode/platform'
setDaemonDesktopPlatform(electron)
