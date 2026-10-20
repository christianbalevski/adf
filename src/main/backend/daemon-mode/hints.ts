import { BACKEND_ENV_OVERRIDE } from '../backend-config'
import { REMOTE_WAITING_PREFIX } from './remote/connector'

export const RECOVERY_HINT = `To run agents in Studio instead, choose Inside Studio (legacy) in Settings → Connections (Studio restarts), or start Studio with ${BACKEND_ENV_OVERRIDE}=embedded for one session (sign-ins and the runtime identity then stay with the daemon).`

/**
 * The one notification while Studio waits for an unreachable remote daemon,
 * from the connector's progress line "Waiting for the remote ADF daemon at
 * <url> (attempt n; …): <reason>". The URL holds colons, so the line is cut
 * at " (attempt ".
 */
export function remoteWaitingNotice(progress: string): string {
  const at = progress.indexOf(' (attempt ')
  return `${at > 0 ? progress.slice(0, at) : REMOTE_WAITING_PREFIX}. Studio keeps trying.`
}

/** Remote mode: Settings → Connections works without a daemon, so the URL, the token or the mode can be fixed there. */
export const REMOTE_RECOVERY_HINT = `Settings → Connections works without the daemon: add the connection again, or choose another one. ${RECOVERY_HINT}`
