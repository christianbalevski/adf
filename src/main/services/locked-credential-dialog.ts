import { dialog } from 'electron'
import type { LockedCredential } from './locked-credential'
import { askReplaceLockedCredentialWithDialog } from './locked-credential-prompt'

export function askReplaceLockedCredential(
  locked: Pick<LockedCredential, 'purpose' | 'sealed'>,
  where: string,
  log: (line: string) => void,
): Promise<boolean> {
  return askReplaceLockedCredentialWithDialog(locked, where, log, (options) => dialog.showMessageBox(options))
}
