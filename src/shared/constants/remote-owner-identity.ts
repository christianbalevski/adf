/**
 * What Studio says about owner identity actions with a remote ADF daemon
 * (design §5.4, §9.4). Main answers these; Settings → Identity shows them
 * next to the disabled buttons. Commands are the ADF CLI's (`adf identity
 * [status | new | restore | import | unlock | lock]`).
 */

/** Back up seed phrase: the CLI shows the phrase once, when it creates it. */
export const REMOTE_OWNER_BACKUP_SENTENCE =
  'A remote ADF daemon never sends its owner seed phrase to another machine. The ADF CLI shows the phrase once, when `adf identity new` creates it on the server, and has no command to show it again.'

/** Import or restore an owner, confirm a backup: run on the server. */
export const REMOTE_OWNER_IDENTITY_SENTENCE =
  'The owner identity of a remote ADF daemon is changed on its machine: run `adf identity restore` (the same owner) or `adf identity import` (another owner) there. Studio does not send a seed phrase to another machine.'
