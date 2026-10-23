import { readFileSync } from 'node:fs'
import type { MessageBoxOptions } from 'electron'
import {
  chooseKeyringStorage,
  choosePlaintextStorage,
  launchChoice,
  type LaunchChoice,
  type PolicyChangeResult,
  type SecretCipher,
} from './secret-storage-policy'

/**
 * The secret-storage question at launch (secret-storage-policy.ts), asked
 * before any settings store, identity or daemon exists: declining or quitting
 * saves nothing. Native message boxes on the boot window, like the other boot
 * dialogs (showWindowlessMessageBox).
 *
 * Without a usable keychain the user either sets one up and retries, or
 * explicitly agrees, after a warning and a checkbox, to store every Studio
 * secret unencrypted. Secrets found stored unencrypted with no saved choice
 * get the same question, with Encrypt with Keychain when it works.
 */

export type LaunchOutcome = 'continue' | 'quit'

type Action = 'retry' | 'encrypt' | 'plaintext' | 'continue' | 'quit'

export interface SecretStorageLaunchDeps {
  settingsPath: string
  /** Studio itself saves secrets in this mode (Inside Studio). Local mode only asks about unencrypted ones. */
  writesSecrets: boolean
  platform: NodeJS.Platform
  keyring: () => boolean
  cipher: SecretCipher
  ask: (options: MessageBoxOptions) => Promise<{ response: number; checkboxChecked?: boolean }>
  log: (line: string) => void
  /** Seams for tests; default to secret-storage-policy.ts. */
  chooseKeyring?: (path: string, cipher: SecretCipher, keyring: boolean) => PolicyChangeResult
  choosePlaintext?: (path: string) => PolicyChangeResult
}

/** Short, per-platform setup steps. Not a promise that installing a package fixes every case. */
export function keyringGuidance(platform: NodeJS.Platform): string {
  if (platform === 'darwin') {
    return 'On macOS: unlock your login keychain in Keychain Access, and click Allow when macOS asks whether ADF Studio may use it. ' +
      'A rebuilt or unsigned copy of the app may be refused.'
  }
  if (platform === 'win32') {
    return 'On Windows: Studio encrypts with your Windows account (DPAPI). Sign in to your usual account; ' +
      'a temporary profile, or a password reset by an administrator, can make it fail.'
  }
  if (platform === 'linux') {
    return 'On Linux, a Secret Service keyring must be running and unlocked in this desktop session:\n' +
      '• GNOME, Debian, Ubuntu: install gnome-keyring (libpam-gnome-keyring unlocks it at login), then log out and back in.\n' +
      '• KDE: KWallet provides it from Frameworks 5.97; how it is enabled depends on your distribution and version. Open the wallet.\n' +
      'Installing a package is not always enough: the keyring must also be unlocked, on the same session as Studio.'
  }
  return 'Set up and unlock your system\'s keyring, then retry.'
}

const SECRETS = 'your owner seed phrase, runtime keys and app sign-ins'

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many
}

/** The first question: its options and which action each button is. */
export function choiceDialog(choice: LaunchChoice, platform: NodeJS.Platform): { options: MessageBoxOptions; actions: Action[] } {
  const guidance = keyringGuidance(platform)
  const canContinue = !choice.keyringAvailable && choice.keyringChosenBefore
  let message: string
  let detail: string
  const buttons: Array<[string, Action]> = []
  if (choice.reason === 'plaintext-found') {
    const n = choice.plaintextSecrets
    message = `${n} ADF Studio ${plural(n, 'secret is', 'secrets are')} stored unencrypted`
    const found = `${plural(n, 'One of the secrets', `${n} of the secrets`)} Studio keeps (${SECRETS}) ${plural(n, 'was', 'were')} saved as plain text in adf-settings.json, because no system keychain was available then.`
    if (choice.keyringAvailable) {
      detail = `${found} The keychain is available now.\n\n` +
        'Encrypt with Keychain encrypts each value, checks it, and saves them in one step. Your owner and runtime identity stay the same.\n\n' +
        'Or keep storing secrets unencrypted on this computer.'
      buttons.push(['Encrypt with Keychain', 'encrypt'], ['Keep Unencrypted…', 'plaintext'])
    } else {
      detail = `${found} The system keychain is not available now either.\n\n${guidance}\n\n` +
        'Retry once it works to encrypt them, or keep storing secrets unencrypted on this computer.'
      buttons.push(['Retry', 'retry'])
      if (canContinue) buttons.push(['Continue Without Keychain', 'continue'])
      buttons.push(['Keep Unencrypted…', 'plaintext'])
    }
  } else if (canContinue) {
    message = 'ADF Studio cannot use your system keychain'
    detail = `${SECRETS[0].toUpperCase()}${SECRETS.slice(1)} are encrypted with the system keychain, which Studio cannot use right now. ` +
      'They are kept as they are. Without the keychain, Studio cannot read them or save new secrets.\n\n' +
      `${guidance}\n\nOr store new secrets unencrypted on this computer.`
    buttons.push(['Retry', 'retry'], ['Continue Without Keychain', 'continue'], ['Store Unencrypted…', 'plaintext'])
  } else {
    message = 'ADF Studio cannot use your system keychain'
    detail = `Studio keeps ${SECRETS} encrypted with the system keychain. It cannot use the keychain right now, and nothing has been saved yet.\n\n` +
      `${guidance}\n\nOr store these secrets unencrypted on this computer.`
    buttons.push(['Retry', 'retry'], ['Store Unencrypted…', 'plaintext'])
  }
  buttons.push(['Quit', 'quit'])
  return {
    options: {
      type: 'warning',
      title: 'Secret storage',
      message,
      detail,
      buttons: buttons.map(([label]) => label),
      defaultId: 0,
      cancelId: buttons.length - 1,
      noLink: true,
    },
    actions: buttons.map(([, action]) => action),
  }
}

/** The warning before plain-text storage. The checkbox must be ticked. */
export function plaintextConfirmDialog(settingsPath: string): MessageBoxOptions {
  return {
    type: 'warning',
    title: 'Store secrets unencrypted',
    message: 'Store ADF Studio secrets unencrypted on this computer?',
    detail: `${SECRETS[0].toUpperCase()}${SECRETS.slice(1)} will be saved as plain text in:\n${settingsPath}\n\n` +
      'Anyone, and any program, that can read your files or a backup of them can copy these secrets and act as you. ' +
      'Secrets already encrypted with the keychain stay encrypted.\n\n' +
      'Studio remembers this choice and warns about it in Settings → Identity, where you can switch back to the keychain once it works.',
    checkboxLabel: 'I understand these secrets will not be encrypted',
    checkboxChecked: false,
    buttons: ['Store Unencrypted', 'Back'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  }
}

function readSettingsObject(path: string): Record<string, unknown> {
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    return data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {}
  } catch {
    // Missing or unreadable: SettingsService reports (and quarantines) it. Nothing is stored to ask about.
    return {}
  }
}

async function showError(deps: SecretStorageLaunchDeps, message: string, detail: string): Promise<void> {
  await deps.ask({ type: 'error', title: 'Secret storage', message, detail, buttons: ['OK'], defaultId: 0, cancelId: 0, noLink: true })
}

/**
 * Ask until the secret storage is settled. Returns 'quit' when the user
 * quits (or closes Studio while asked); nothing was written then.
 */
export async function settleSecretStorageAtLaunch(deps: SecretStorageLaunchDeps): Promise<LaunchOutcome> {
  const chooseKeyring = deps.chooseKeyring ?? chooseKeyringStorage
  const choosePlaintext = deps.choosePlaintext ?? ((path: string) => choosePlaintextStorage(path))
  for (;;) {
    const choice = launchChoice(readSettingsObject(deps.settingsPath), deps.keyring(), { writesSecrets: deps.writesSecrets })
    if (!choice) return 'continue'
    deps.log(`[SecretStorage] Asking how to store secrets (${choice.reason}, keychain ${choice.keyringAvailable ? 'available' : 'unavailable'}, ${choice.plaintextSecrets} stored unencrypted)`)
    const { options, actions } = choiceDialog(choice, deps.platform)
    const action = actions[(await deps.ask(options)).response] ?? 'quit'
    if (action === 'quit') {
      deps.log('[SecretStorage] Quit at the secret-storage question; nothing was changed')
      return 'quit'
    }
    if (action === 'continue') {
      deps.log('[SecretStorage] Continuing without the keychain: secrets are kept as they are and no new secret is saved')
      return 'continue'
    }
    if (action === 'retry') continue
    if (action === 'encrypt') {
      const result = chooseKeyring(deps.settingsPath, deps.cipher, deps.keyring())
      if (result.ok) deps.log(`[SecretStorage] Encrypted ${result.encrypted} secret(s) with the keychain; keychain storage saved`)
      else {
        deps.log(`[SecretStorage] Encrypting with the keychain failed: ${result.error}`)
        await showError(deps, 'The secrets could not be encrypted', result.error)
      }
      continue
    }
    // 'plaintext': only with the warning acknowledged; Back returns to the question.
    for (;;) {
      const answer = await deps.ask(plaintextConfirmDialog(deps.settingsPath))
      if (answer.response !== 0) break
      if (!answer.checkboxChecked) continue
      const result = choosePlaintext(deps.settingsPath)
      if (result.ok) {
        deps.log('[SecretStorage] The user chose to store secrets unencrypted on this computer; saved')
      } else {
        deps.log(`[SecretStorage] Saving the unencrypted-storage choice failed: ${result.error}`)
        await showError(deps, 'The choice could not be saved', result.error)
      }
      break
    }
  }
}
