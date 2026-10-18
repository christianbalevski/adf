/**
 * Secret files readable by the current OS user only (W3-B, W5-D1): the
 * daemon token, the daemon's runtime encryption key and its revocation list,
 * the local proof, and the credential key both Studio and the daemon use.
 *
 * POSIX: mode 0600. Windows: mode bits mean nothing there and the folder's
 * inherited ACL depends on where the settings live (ADF_USER_DATA_DIR or a
 * custom settings path need not be in the user profile), so the file gets its
 * own ACL: full control for the current user only, inheritance removed
 * (`icacls /inheritance:r /grant:r`). Administrators can still take
 * ownership, as of any file.
 */

import { execFileSync } from 'node:child_process'
import { chmodSync } from 'node:fs'
import { userInfo } from 'node:os'

/**
 * Windows: the file's own ACL, granting full control to the current user
 * only, with inheritance removed. Throws when icacls fails.
 */
export function restrictToCurrentUserWindows(path: string, run: (file: string, args: string[]) => void = (file, args) => {
  execFileSync(file, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
}): void {
  const user = process.env.USERDOMAIN && process.env.USERNAME
    ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
    : userInfo().username
  run('icacls', [path, '/inheritance:r', '/grant:r', `${user}:F`])
}

/**
 * Restrict a secret file just written (or about to be renamed into place:
 * an NTFS ACL moves with the file) to the current user. Never throws: the
 * file stays where the user's data lives; a failure is logged with the path
 * and the reason, and false returned.
 */
export function protectSecretFile(path: string, opts: { platform?: NodeJS.Platform; run?: (file: string, args: string[]) => void } = {}): boolean {
  try {
    if ((opts.platform ?? process.platform) === 'win32') restrictToCurrentUserWindows(path, opts.run)
    else chmodSync(path, 0o600)
    return true
  } catch (err) {
    console.warn(`[SecretFile] Could not restrict ${path} to the current user: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}
