import type { LockedCredential } from './locked-credential'

/**
 * Studio's question when a credential save meets a locked credentials
 * envelope (locked-credential.ts), in every mode: Replace or Cancel, the
 * same choices as the terminal app (src/main/tui/setup/LockedCredential.tsx).
 * `where` names the machine whose keys cannot open it: "this machine"
 * (embedded, local daemon) or "the daemon's machine" (remote daemon).
 * True when the owner chose Replace; the choice is logged.
 */
export async function askReplaceLockedCredentialWithDialog(
  locked: Pick<LockedCredential, 'purpose' | 'sealed'>,
  where: string,
  log: (line: string) => void,
  showMessageBox: (options: Electron.MessageBoxOptions) => Promise<Pick<Electron.MessageBoxReturnValue, 'response'>>,
): Promise<boolean> {
  const unlockHint = 'the share password on the Identity tab, or your owner identity'
  const { response } = await showMessageBox({
    type: 'warning',
    message: locked.sealed
      ? `The saved "${locked.purpose}" of this agent is sealed, and its credentials are locked on ${where}.`
      : `This agent's credentials are locked on ${where}.`,
    detail: locked.sealed
      ? `It cannot be read or overwritten until the credentials unlock (${unlockHint}). Replace it anyway? The old value is discarded unread.`
      : `Store "${locked.purpose}" unsealed anyway? It is sealed once the credentials unlock (${unlockHint}).`,
    buttons: ['Replace', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  })
  const replace = response === 0
  log(`${locked.purpose}: the agent's credentials are locked; the owner chose to ${replace ? 'replace' : 'cancel'}`)
  return replace
}
