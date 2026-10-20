import { app, BrowserWindow, dialog, safeStorage } from 'electron'
import { join } from 'node:path'
import type { StudioRunMode } from '../../shared/types/backend.types'
import { decryptCredential, encryptCredential } from '../utils/credential-cipher'
import { showWindowlessMessageBox } from '../utils/windowless-dialog'
import { BootDialogDismissedError, showBootWindow } from '../utils/boot-window'
import { flushMainLogSync } from '../utils/main-log-file'
import { DaemonProcessController, decideAttach, type AttachDecision } from './daemon-process'
import type { DaemonVersionInfo } from '../daemon/routes/meta-routes'
import { awaitKeychainAccess, openDaemonSecrets } from './daemon-secrets'
import { BACKEND_ENV_OVERRIDE } from './backend-config'
import type { VersionMismatchChoice } from './daemon-mode/connectors'
import {
  syncStudioRuntimeEntry,
  handoverNeedsKeychain,
  runHandover,
  DAEMON_TOKEN_FILE,
  REPLACED_TOKEN_MAX_AGE_DAYS,
  type HandoverDeps,
  type HandoverReport,
  type HandoverTarget,
  type SessionConflict,
  type StudioSecretCodec,
} from './handover'

/**
 * What the boot and the embedded backend keep of the backend switch (design
 * D9, §8.2, §11; docs/design/multi-runtime.md §7.1): the handover at boot and
 * its summary, the accounts-conflict dialog, the version-mismatch choice and
 * Studio's restarts. The switch-and-restart flow is gone: choosing This
 * computer or Inside Studio (legacy) in Settings → Connections saves the mode
 * for the next launch. The moves themselves are handover.ts (Electron-free,
 * tested there).
 */

/** The modes as Settings → Connections names them (owner decision 2026-10-17); internal ids stay embedded/local. */
const MODE_LABELS: Record<StudioRunMode, string> = {
  embedded: 'Inside Studio (legacy)',
  local: 'This computer',
}

/** Where agents run in each mode, for sentences ("Agents now run on this computer."). */
const MODE_PLACES: Record<StudioRunMode, string> = {
  embedded: 'inside Studio',
  local: 'on this computer',
}

/** argv flag of a restart into embedded for one session (§8.2 "Use embedded mode for this session"). */
export const SESSION_BACKEND_ARG = '--adf-session-backend=embedded'

/**
 * Linux without a Secret Service keyring: safeStorage falls back to
 * 'basic_text', a fixed key that only obfuscates. Not good enough for the
 * remote daemon token or a moved-back session.
 */
export function isObfuscationOnly(): boolean {
  if (process.platform !== 'linux') return false
  const backend = (safeStorage as { getSelectedStorageBackend?: () => string }).getSelectedStorageBackend?.()
  return backend === 'basic_text'
}

/**
 * The settings-secret format SettingsService uses: safeStorage when
 * available. Under `basic_text` (obfuscationOnly) the handover writes
 * moved-back sessions with the key-file cipher and moves MCP sign-ins back
 * as SettingsService stores them, with a note in the report.
 */
export const studioSecretCodec: StudioSecretCodec = {
  available: () => safeStorage.isEncryptionAvailable(),
  obfuscationOnly: () => isObfuscationOnly()
    ? 'No OS keyring is available, so safeStorage only obfuscates. Install and unlock a Secret Service keyring such as GNOME Keyring or KWallet, then restart Studio.'
    : null,
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

/**
 * This launch's backend override: `SESSION_BACKEND_ARG` (the user chose
 * embedded for one session) acts as ADF_STUDIO_BACKEND=embedded and is
 * reported as source `session`.
 */
export function sessionBackendEnv(argv: readonly string[], env: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; session: boolean } {
  return argv.includes(SESSION_BACKEND_ARG) ? { env: { ...env, [BACKEND_ENV_OVERRIDE]: 'embedded' }, session: true } : { env, session: false }
}

function localController(userDataDir: string): DaemonProcessController {
  return new DaemonProcessController({
    settingsPath: join(userDataDir, 'adf-settings.json'),
    userDataDir,
    daemonEntry: '',
    execPath: process.execPath,
  }, { log: (line) => console.log(line) })
}

/** A daemon running (or starting/stopping) on Studio's settings, as a sentence; null when none. */
export async function runningDaemonOnSettings(userDataDir: string): Promise<string | null> {
  const controller = localController(userDataDir)
  const found = await controller.detect()
  if (found.state === 'starting') return `the ADF daemon pid ${found.pid} is still starting or stopping`
  if (found.state !== 'running') return null
  if (decideAttach(found.info, { settingsPath: join(userDataDir, 'adf-settings.json') }).kind === 'settings-mismatch') return null
  return `the ADF daemon pid ${found.info.pid} (started by ${found.info.startedBy}) still runs on these settings`
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
    daemonRunning: () => runningDaemonOnSettings(userDataDir),
    chooseSession: chooseSessionDialog,
    ...extra,
  }
}

/** §11: both sides hold a session of one provider for different accounts; the user keeps one. */
async function chooseSessionDialog(conflict: SessionConflict): Promise<'studio' | 'daemon'> {
  const buttons = [`Keep ${conflict.studio.account} (Studio)`, `Keep ${conflict.daemon.account} (daemon)`]
  const { response } = await showWindowlessMessageBox(`${conflict.label}: choose which account to keep (Studio: ${conflict.studio.account}; daemon: ${conflict.daemon.account})`, {
    type: 'question',
    title: `${conflict.label}: two accounts`,
    message: `Studio and the ADF daemon are signed in to ${conflict.label.replace(/ session$/, '')} with different accounts.`,
    detail: `Studio: ${conflict.studio.account}\nDaemon: ${conflict.daemon.account}\n\nOnly one session can move with the backend. The other account is signed out here and kept, encrypted, in ${conflict.replacedDir} for up to ${REPLACED_TOKEN_MAX_AGE_DAYS} days (the summary names the file). To use it in the daemon, stop the daemon and replace ${DAEMON_TOKEN_FILE} with that file.`,
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
 * attached. A session-only override moves client keys only. Never throws.
 */
export async function runBootHandover(mode: StudioRunMode, userDataDir: string, opts: { sessionOnly?: boolean } = {}): Promise<HandoverReport | null> {
  try {
    const keychain = await handoverNeedsKeychain(mode as HandoverTarget, userDataDir, opts)
    // The handover's keychain reads are sync: read it async first, so a macOS
    // access prompt waits with Studio responsive, logged and on screen.
    if (keychain) {
      await awaitKeychainAccess(process.env, {
        log: (line) => console.log(line),
        onSlow: () => {
          flushMainLogSync()
          try {
            showBootWindow(`Waiting for the OS keychain. macOS may be asking whether ${app.isPackaged ? 'ADF Studio' : 'Electron (npm run dev)'} may use its "ADF" keychain items: answer that prompt. It can open behind other windows.`)
          } catch { /* the log line stands */ }
        },
      })
    }
    return await runHandover(mode as HandoverTarget, handoverDeps(userDataDir, {}, { keychain }), opts)
  } catch (err) {
    console.error('[Handover] The handover at boot failed; every source is kept and the next start retries:', err)
    return null
  }
}

/** After a handover that moved something or needs attention: one dialog, over the main window. */
export function showHandoverSummary(report: HandoverReport | null, mode: StudioRunMode, window: BrowserWindow | null): void {
  if (!report || (!report.changed && !report.failed)) return
  const lines = report.items
    .filter((item) => item.outcome !== 'unchanged')
    .map((item) => `• ${item.label}: ${item.outcome}${item.pending ? ', retried at the next start' : ''} (${item.detail})`)
  const options = {
    type: (report.failed ? 'warning' : 'info') as 'warning' | 'info',
    title: `Backend: ${MODE_LABELS[mode]}`,
    message: report.failed ? `Agents now run ${MODE_PLACES[mode]}, but part of the handover is not done.` : `Agents now run ${MODE_PLACES[mode]}.`,
    detail: `${lines.join('\n')}${report.failed ? '\n\nWhat is not done was left where it was; Studio retries at the next start. Details are in the main log.' : ''}`,
    buttons: ['OK'],
    noLink: true,
  }
  void (window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options)).catch(() => {})
}

/**
 * §8.2 step 3: a daemon of another client API version runs. The user picks
 * "Restart the daemon with Studio's version" or "Use embedded mode for this
 * session" (Studio restarts into embedded for this launch only; the daemon,
 * its agents and its sign-ins stay as they are). A restart of a daemon
 * Studio did not start, or one other clients use, is named as such.
 */
export async function askVersionMismatch(
  decision: Extract<AttachDecision, { kind: 'version-mismatch' }>,
  running: DaemonVersionInfo,
  clients: Array<{ client: string; version: string }> | null,
  window: () => BrowserWindow | null,
): Promise<VersionMismatchChoice> {
  const others = (clients ?? []).filter((c) => c.client !== 'studio' || c.version !== app.getVersion())
  const warnings: string[] = []
  if (running.startedBy !== 'studio') warnings.push(`This daemon was started by ${running.startedBy === 'cli' ? 'the ADF CLI (adf daemon start)' : 'a service manager'}, not Studio; its replacement keeps that, so quitting Studio does not stop it.`)
  if (others.length > 0) warnings.push(`Connected to it now: ${others.map((c) => `${c.client} ${c.version}`).join(', ')}. A restart disconnects them.`)
  if (clients === null) warnings.push('Studio cannot tell which other clients use it (an older daemon).')
  const risky = warnings.length > 0
  const buttons = [risky ? 'Restart It Anyway' : 'Restart the Daemon with Studio\'s Version', 'Run Inside Studio for This Session']
  const options = {
    type: 'warning' as const,
    title: 'ADF daemon version',
    message: `The running ADF daemon is version ${running.version}; this Studio is ${app.getVersion()}.`,
    detail: `${decision.message}\n\nRestart stops that daemon (pid ${running.pid}) and its agents, then starts this Studio's daemon and its autostart agents.${risky ? `\n\n${warnings.join('\n')}` : ''}\n\nRunning inside Studio for this session leaves that daemon, its agents and its sign-ins as they are.`,
    buttons,
    defaultId: risky ? 1 : 0,
    cancelId: 1,
    noLink: true,
  }
  // The main window stays hidden until ready-to-show: a sheet on it would not be seen.
  const shown = window()
  const win = shown && !shown.isDestroyed() && shown.isVisible() ? shown : null
  let response: number
  try {
    ({ response } = await (win ? dialog.showMessageBox(win, options) : showWindowlessMessageBox(`daemon version ${running.version} (pid ${running.pid}) differs from Studio ${app.getVersion()}: restart it or use embedded mode`, options)))
  } catch (err) {
    // The user closed Studio while the question was open: no answer, so no restart of either kind.
    if (!(err instanceof BootDialogDismissedError)) throw err
    console.log(`[Backend] The daemon version question was dismissed (${err.message}); Studio does not restart`)
    return 'dismissed'
  }
  if (response === 0) return 'restart'
  relaunchEmbeddedForSession('daemon version mismatch')
  return 'embedded'
}

let relaunching = false

/** A restart has started (app.relaunch is set): its quit is not held by another question. */
export function isRelaunching(): boolean {
  return relaunching
}

/**
 * One restart per process: each app.relaunch() starts one more instance at
 * quit, so a second request (the window's answer and main's fallback, or
 * two clicks) is logged and dropped.
 */
function relaunchStarted(reason: string): boolean {
  if (relaunching) {
    console.log(`[Backend] Studio is already restarting; not restarting again for: ${reason}`)
    return true
  }
  relaunching = true
  return false
}

/**
 * Under electron-vite (npm run dev) app.relaunch() brings nothing back: the
 * dev server and its renderer URL go with this process. Said once, in the
 * log and in a dialog when a window has focus, instead of Studio vanishing.
 */
function noteDevRelaunch(into: string): void {
  if (app.isPackaged !== false || !process.env.ELECTRON_RENDERER_URL) return
  const line = `Development build: Studio quits now and does not start again by itself. Run npm run dev again to start it in ${into}.`
  console.warn(`[Backend] ${line}`)
  const win = BrowserWindow?.getFocusedWindow?.()
  if (win) dialog.showMessageBoxSync(win, { type: 'info', message: 'Run npm run dev again', detail: line, buttons: ['OK'], noLink: true })
}

/**
 * Restart Studio in embedded mode for this launch only (SESSION_BACKEND_ARG):
 * after a daemon version mismatch, or a launch whose daemon could not be
 * reached. The saved mode, the daemon, its agents and its sign-ins stay as
 * they are; credentials do not move (session-only handover).
 */
export function relaunchEmbeddedForSession(reason: string): void {
  if (relaunchStarted(reason)) return
  console.log(`[Backend] Restarting Studio in embedded mode for this session (${reason}); credentials stay where the saved mode keeps them`)
  noteDevRelaunch(`embedded mode for one session (${BACKEND_ENV_OVERRIDE}=embedded npm run dev)`)
  app.relaunch({ args: [...process.argv.slice(1).filter((arg) => arg !== SESSION_BACKEND_ARG), SESSION_BACKEND_ARG] })
  app.quit()
}

/**
 * Embedded boot after a handover moved credentials back: a daemon that keeps
 * running on these settings drops the runtime identity it adopted and
 * re-reads its stores. Logged; never throws.
 */
export async function notifyDaemonOfHandover(userDataDir: string): Promise<void> {
  console.log(`[Handover] ${await localController(userDataDir).notifyCredentialsMoved()}`)
}

/** Local mode, after an owner import: Studio's runtime entry with a delegation the new owner signs. */
export async function syncRuntimeEntryAfterImport(userDataDir: string, phrase: string): Promise<string> {
  const sync = await syncStudioRuntimeEntry(handoverDeps(userDataDir), { ownerPhrase: phrase })
  return `${sync.outcome} (${sync.detail})`
}

/** Restart Studio into the backend just saved. A session-only embedded override is not carried over. */
export function relaunchStudio(reason: string): void {
  if (relaunchStarted(reason)) return
  console.log(`[Backend] Restarting Studio: ${reason}`)
  noteDevRelaunch('the backend just chosen')
  app.relaunch({ args: process.argv.slice(1).filter((arg) => arg !== SESSION_BACKEND_ARG) })
  app.quit()
}
