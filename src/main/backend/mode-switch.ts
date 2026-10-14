import { app, dialog, safeStorage, type BrowserWindow } from 'electron'
import { basename, join } from 'node:path'
import type { StudioBackendMode } from '../../shared/types/backend.types'
import { decryptCredential, encryptCredential } from '../utils/credential-cipher'
import { DaemonProcessController, type AttachDecision } from './daemon-process'
import type { DaemonVersionInfo } from '../daemon/routes/meta-routes'
import { openDaemonSecrets } from './daemon-secrets'
import { BACKEND_ENV_OVERRIDE } from './backend-config'
import type { VersionMismatchChoice } from './daemon-mode/connectors'
import {
  syncStudioRuntimeEntry,
  handoverNeedsKeychain,
  planHandover,
  runHandover,
  type HandoverDeps,
  type HandoverReport,
  type HandoverTarget,
  type SessionConflict,
  type StudioSecretCodec,
} from './handover'

/**
 * Studio main's side of a backend switch (design D9, §8.2, §11): the switch
 * dialog, the restart, the handover at the next boot and its summary, the
 * accounts-conflict dialog and the version-mismatch choice. The moves
 * themselves are handover.ts (Electron-free, tested there).
 *
 * Every step is logged, and shown where the user started it: the switch
 * dialog in Settings → Backend, the summary when the window opens after the
 * restart.
 */

const MODE_LABELS: Record<StudioBackendMode, string> = {
  embedded: 'Embedded',
  local: 'Local daemon',
  remote: 'Remote daemon',
}

/** argv flag of a restart into embedded for one session (§8.2 "Use embedded mode for this session"). */
export const SESSION_BACKEND_ARG = '--adf-session-backend=embedded'

/** How long a quit for a switch to embedded waits for the daemon Studio stops (its own bounded shutdown is 20 s). */
export const SWITCH_DAEMON_EXIT_WAIT_MS = 22_000

/** The settings-secret format SettingsService uses: safeStorage when available. */
export const studioSecretCodec: StudioSecretCodec = {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plain) => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS secure storage (safeStorage) is not available')
    return 'safe:' + safeStorage.encryptString(plain).toString('base64')
  },
  decrypt: (stored) => {
    if (!stored.startsWith('safe:') || !safeStorage.isEncryptionAvailable()) return null
    try {
      return safeStorage.decryptString(Buffer.from(stored.slice('safe:'.length), 'base64'))
    } catch {
      return null
    }
  },
}

export function handoverDeps(userDataDir: string, extra: Partial<HandoverDeps> = {}, opts: { keychain?: boolean } = {}): HandoverDeps {
  // The keychain is opened only when something goes through it (no probe on every boot).
  const secrets = opts.keychain === false
    ? { backend: null, unavailable: 'Studio holds no runtime identity, owner phrase or MCP sign-in to share' }
    : openDaemonSecrets(process.env, { packaged: app.isPackaged })
  return {
    userDataDir,
    settingsPath: join(userDataDir, 'adf-settings.json'),
    studioSecrets: studioSecretCodec,
    daemonCipher: { encrypt: encryptCredential, decrypt: (raw) => decryptCredential(raw, '[Handover]') },
    daemonSecrets: secrets.backend,
    daemonSecretsUnavailable: secrets.unavailable,
    chooseSession: chooseSessionDialog,
    ...extra,
  }
}

/** §11: both sides hold a session of one provider for different accounts; the user keeps one. */
async function chooseSessionDialog(conflict: SessionConflict): Promise<'studio' | 'daemon'> {
  const buttons = [`Keep ${conflict.studio.account} (Studio)`, `Keep ${conflict.daemon.account} (daemon)`]
  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: `${conflict.label}: two accounts`,
    message: `Studio and the ADF daemon are signed in to ${conflict.label.replace(/ session$/, '')} with different accounts.`,
    detail: `Studio: ${conflict.studio.account}\nDaemon: ${conflict.daemon.account}\n\nOnly one session can move with the backend: its refresh token is renewed on use, so a copy left behind stops working. The other account is signed out on this computer; you can sign in to it again later.`,
    buttons,
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  })
  const choice = response === 1 ? 'daemon' : 'studio'
  console.log(`[Handover] ${conflict.label}: the user kept the ${choice === 'studio' ? `Studio session (${conflict.studio.account})` : `daemon session (${conflict.daemon.account})`}`)
  return choice
}

/**
 * Boot: the handover into the mode this launch runs (handover.ts). Runs
 * before any backend handler exists and before the daemon is started or
 * attached. Never throws.
 */
export async function runBootHandover(mode: StudioBackendMode, userDataDir: string): Promise<HandoverReport | null> {
  try {
    const keychain = await handoverNeedsKeychain(mode as HandoverTarget, userDataDir)
    return await runHandover(mode as HandoverTarget, handoverDeps(userDataDir, {}, { keychain }))
  } catch (err) {
    console.error('[Handover] The handover at boot failed; every source is kept and the next start retries:', err)
    return null
  }
}

/** After a handover that moved something: one dialog with what moved, in the window the user switched in. */
export function showHandoverSummary(report: HandoverReport | null, mode: StudioBackendMode, window: BrowserWindow | null): void {
  if (!report || (!report.changed && !report.failed)) return
  const lines = report.items
    .filter((item) => item.outcome !== 'unchanged')
    .map((item) => `• ${item.label}: ${item.outcome} (${item.detail})`)
  const options = {
    type: (report.failed ? 'warning' : 'info') as 'warning' | 'info',
    title: `Backend: ${MODE_LABELS[mode]}`,
    message: report.failed ? `Studio runs ${MODE_LABELS[mode]}, but part of the handover failed.` : `Studio now runs ${MODE_LABELS[mode]}.`,
    detail: `${lines.join('\n')}${report.failed ? '\n\nWhat failed was left where it was; Studio retries at the next start. Details are in the main log.' : ''}`,
    buttons: ['OK'],
    noLink: true,
  }
  void (window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options)).catch(() => {})
}

export interface SwitchContext {
  activeMode: StudioBackendMode
  userDataDir: string
  /** Names of the agents running now (embedded: this process; daemon mode: the daemon). */
  runningAgents: () => string[]
  /** studio-backend.json `keepDaemonRunning` now. */
  keepDaemonRunning: () => boolean
  /** Local mode: who started the daemon Studio uses (GET /version). */
  daemonStartedBy: () => string | null
  window: () => BrowserWindow | null
}

/** The switch dialog (§11): what moves, what happens to running agents; true to switch and restart. */
export async function confirmModeSwitch(target: StudioBackendMode, ctx: SwitchContext): Promise<boolean> {
  const plan = await planHandover(target as HandoverTarget, handoverDeps(ctx.userDataDir, { chooseSession: undefined }))
    .catch((err) => [{ id: 'client-settings' as const, label: 'Handover', detail: `could not be planned: ${err instanceof Error ? err.message : String(err)}` }])
  const running = ctx.runningAgents()
  const agents = running.length > 0 ? running.join(', ') : null
  const lines: string[] = []
  if (target === 'embedded') {
    lines.push('Studio restarts and runs agents itself.')
  } else if (target === 'local') {
    lines.push('Studio restarts and runs agents in an ADF daemon on this computer, with the same settings and agent files.')
  } else {
    lines.push('Studio restarts and uses the ADF daemon at the remote URL.')
  }
  if (plan.length > 0) {
    lines.push('', target === 'embedded' ? 'Moves back to Studio at the restart:' : 'Moves at the restart:')
    for (const item of plan) lines.push(`• ${item.label}: ${item.detail}`)
  }
  lines.push('')
  if (ctx.activeMode === 'embedded') {
    lines.push(agents
      ? `Running agents (${agents}) stop now. The daemon starts the ones set to autostart.`
      : 'No agent runs now.')
  } else if (ctx.activeMode === 'local' && target === 'embedded') {
    const startedBy = ctx.daemonStartedBy()
    const stops = !ctx.keepDaemonRunning() && startedBy === 'studio'
    lines.push(stops
      ? `The ADF daemon stops when Studio quits${agents ? `, and its agents (${agents}) with it` : ''}, unless another client (the terminal app) is connected. Studio then starts the agents set to autostart.`
      : `The ADF daemon keeps running (${startedBy && startedBy !== 'studio' ? `started by ${startedBy}` : '"Keep the daemon running" is on'})${agents ? `, with its agents (${agents})` : ''}. Studio does not start an agent the daemon runs; stop it there first (adf daemon stop).`)
  }
  if (target === 'local' && process.platform === 'darwin') {
    lines.push('', 'macOS asks once whether the ADF daemon may read Studio\'s runtime key from the keychain. "Always Allow" grants that to the Electron binary that runs the daemon, and to any script it runs.')
  }
  if (process.env[BACKEND_ENV_OVERRIDE]) {
    lines.push('', `${BACKEND_ENV_OVERRIDE} is set in this environment and overrides this choice until it is removed.`)
  }
  const buttons = ['Switch and Restart', 'Cancel']
  const options = {
    type: 'question' as const,
    title: `Switch to ${MODE_LABELS[target]}`,
    message: `Switch the backend from ${MODE_LABELS[ctx.activeMode]} to ${MODE_LABELS[target]}?`,
    detail: lines.join('\n'),
    buttons,
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  }
  const win = ctx.window()
  const { response } = await (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options))
  const confirmed = response === 0
  console.log(`[Backend] Switch dialog ${MODE_LABELS[ctx.activeMode]} → ${MODE_LABELS[target]}: ${confirmed ? 'confirmed' : 'cancelled'} (${plan.map((p) => p.label).join(', ') || 'nothing to move'}${agents ? `; running: ${agents}` : ''})`)
  return confirmed
}

/** Restart Studio into the backend just saved. A session-only embedded override is not carried over. */
export function relaunchStudio(reason: string): void {
  console.log(`[Backend] Restarting Studio: ${reason}`)
  app.relaunch({ args: process.argv.slice(1).filter((arg) => arg !== SESSION_BACKEND_ARG) })
  app.quit()
}

/**
 * §8.2 step 3: a daemon of another client API version runs. The user picks
 * "Restart the daemon with Studio's version" or "Use embedded mode for this
 * session" (Studio restarts into embedded for this launch only). Studio never
 * restarts a daemon without that choice.
 */
export async function askVersionMismatch(decision: Extract<AttachDecision, { kind: 'version-mismatch' }>, running: DaemonVersionInfo, window: () => BrowserWindow | null): Promise<VersionMismatchChoice> {
  const buttons = ['Restart the Daemon with Studio\'s Version', 'Use Embedded Mode for This Session']
  const options = {
    type: 'warning' as const,
    title: 'ADF daemon version',
    message: `The running ADF daemon is version ${running.version}; this Studio is ${app.getVersion()}.`,
    detail: `${decision.message}\n\nRestarting stops the daemon (pid ${running.pid}, started by ${running.startedBy}) and its agents, then starts this Studio's daemon, which starts the agents set to autostart. Embedded mode leaves that daemon running for this session; Studio does not start an agent it runs.`,
    buttons,
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  }
  const win = window()
  const { response } = await (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options))
  if (response === 0) return 'restart'
  console.log('[Backend] Restarting Studio in embedded mode for this session (daemon version mismatch)')
  app.relaunch({ args: [...process.argv.slice(1).filter((arg) => arg !== SESSION_BACKEND_ARG), SESSION_BACKEND_ARG] })
  app.quit()
  return 'embedded'
}

/**
 * Embedded boot after a handover moved credentials back: a daemon that keeps
 * running on these settings (CLI-started, or "keep running" on) drops the
 * runtime identity it adopted and re-reads its stores. Logged; never throws.
 */
export async function notifyDaemonOfHandover(userDataDir: string): Promise<void> {
  const controller = new DaemonProcessController({
    settingsPath: join(userDataDir, 'adf-settings.json'),
    userDataDir,
    daemonEntry: '',
    execPath: process.execPath,
  }, { log: (line) => console.log(line) })
  console.log(`[Handover] ${await controller.notifyCredentialsMoved()}`)
}

/** Local mode, after an owner import: Studio's runtime entry with a delegation the new owner signs. */
export async function syncRuntimeEntryAfterImport(userDataDir: string, phrase: string): Promise<string> {
  const sync = await syncStudioRuntimeEntry(handoverDeps(userDataDir), { ownerPhrase: phrase })
  return `${sync.outcome} (${sync.detail})`
}

/** Agent names for the switch dialog, from agent file paths. */
export function agentNames(paths: readonly string[]): string[] {
  return paths.map((p) => basename(p).replace(/\.adf$/i, ''))
}
