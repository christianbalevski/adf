/**
 * Write a secret file that is never readable by anyone else, not even for a
 * moment (security review item 9): the content goes into a temp file that is
 * already restricted to the current user, then the temp file is renamed over
 * the target (an NTFS ACL and POSIX mode bits move with the file).
 *
 * - POSIX: the temp file is created exclusively with mode 0600.
 * - Windows: the temp file is created empty, given its own ACL (full control
 *   for the current user, inheritance removed), and only then filled.
 *
 * Restricting is not best effort here: when it fails nothing is written and
 * the error says why, so a caller never reports "readable by you only" for a
 * file that is not.
 */

import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { restrictToCurrentUserWindows } from './secret-file'

export class SecretFileError extends Error {
  constructor(readonly path: string, reason: string) {
    super(`Could not write ${path} readable by the current user only: ${reason}`)
    this.name = 'SecretFileError'
  }
}

export function writeSecretFileAtomic(path: string, content: string, platform: NodeJS.Platform = process.platform): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  const drop = () => { try { unlinkSync(tmp) } catch { /* never created or gone */ } }
  try {
    if (platform === 'win32') {
      writeFileSync(tmp, '', { flag: 'wx' })
      restrictToCurrentUserWindows(tmp)
      writeFileSync(tmp, content)
    } else {
      writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' })
      chmodSync(tmp, 0o600)
    }
  } catch (err) {
    drop()
    throw new SecretFileError(path, err instanceof Error ? err.message : String(err))
  }
  try {
    renameSync(tmp, path)
  } catch (err) {
    drop()
    throw err
  }
}
