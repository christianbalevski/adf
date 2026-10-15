import { app, dialog, Notification, safeStorage, type BrowserWindow } from 'electron'
import { promises as fsp } from 'node:fs'
import { basename, join } from 'node:path'
import type { StudioBackendMode } from '../../shared/types/backend.types'
import { decryptCredential, encryptCredential } from '../utils/credential-cipher'
import { writeJsonAtomicAsync } from '../utils/atomic-json'
import { DaemonProcessController, decideAttach, type AttachDecision } from './daemon-process'
import type { DaemonVersionInfo } from '../daemon/routes/meta-routes'
import { openDaemonSecrets } from './daemon-secrets'
import { BACKEND_ENV_OVERRIDE } from './backend-config'
import type { VersionMismatchChoice } from './daemon-mode/connectors'
import {
  syncStudioRuntimeEntry,
  handoverNeedsKeychain,
  planHandover,
  runHandover,
  REPLACED_TOKEN_FILE,
  type HandoverDeps,
  type HandoverReport,
  type HandoverTarget,
  type SessionConflict,
  type StudioSecretCodec,
} from './handover'

/**
 * Studio main's side of a backend switch (design D9, §8.2, §11, §11.1): the
 * switch dialog, the restart, the handover at the next boot and its summary,
 * resuming the agents that ran before the switch, the accounts-conflict
 * dialog and the version-mismatch choice. The moves themselves are
 * handover.ts (Electron-free, tested there).
 *
 * Every step is logged, and shown where the user started it: the switch
 * dialog in Settings → Backend, the summary and the resumed agents when the
 * window opens after the restart.
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

/** The agents that ran before a switch, started again on the other side after it (§11.1). */
export const SWITCH_RESUME_FILE = 'studio-switch-resume.json'
/** A resume record older than this is not acted on (Studio did not come back right after the switch). */
const RESUME_MAX_AGE_MS = 30 * 60_000
/** "Wait for them to finish": the longest wait before the switch gives up and asks again. */
const WAIT_FOR_TURNS_MAX_MS = 30 * 60_000

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
  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: `${conflict.label}: two accounts`,
    message: `Studio and the ADF daemon are signed in to ${conflict.label.replace(/ session$/, '')} with different accounts.`,
    detail: `Studio: ${conflict.studio.account}\nDaemon: ${conflict.daemon.account}\n\nOnly one session can move with the backend: its refresh token is renewed on use, so a copy left behind stops working. The other account is signed out here and saved once, encrypted, as ${conflict.replacedFile}; to use it in the daemon instead, stop the daemon and rename that file to ${REPLACED_TOKEN_FILE.replace('replaced', 'daemon')}.`,
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
export async function runBootHandover(mode: StudioBackendMode, userDataDir: string, opts: { sessionOnly?: boolean } = {}): Promise<HandoverReport | null> {
  try {
    const keychain = await handoverNeedsKeychain(mode as HandoverTarget, userDataDir, opts)
    return await runHandover(mode as HandoverTarget, handoverDeps(userDataDir, {}, { keychain }), opts)
  } catch (err) {
    console.error('[Handover] The handover at boot failed; every source is kept and the next start retries:', err)
    return null
  }
}

/** After a handover that moved something or needs attention: one dialog, in the window the switch restarted into. */
export function showHandoverSummary(report: HandoverReport | null, mode: StudioBackendMode, window: BrowserWindow | null): void {
  if (!report || (!report.changed && !report.failed)) return
  const lines = report.items
    .filter((item) => item.outcome !== 'unchanged')
    .map((item) => `• ${item.label}: ${item.outcome}${item.pending ? ', retried at the next start' : ''} (${item.detail})`)
  const options = {
    type: (report.failed ? 'warning' : 'info') as 'warning' | 'info',
    title: `Backend: ${MODE_LABELS[mode]}`,
    message: report.failed ? `Studio runs ${MODE_LABELS[mode]}, but part of the handover is not done.` : `Studio now runs ${MODE_LABELS[mode]}.`,
    detail: `${lines.join('\n')}${report.failed ? '\n\nWhat is not done was left where it was; Studio retries at the next start. Details are in the main log.' : ''}`,
    buttons: ['OK'],
    noLink: true,
  }
  void (window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options)).catch(() => {})
}

export interface SwitchContext {
  activeMode: StudioBackendMode
  userDataDir: string
  /** The agents running now and whether a turn is in flight (embedded: this process; daemon mode: the daemon). */
  agentActivity: () => Array<{ filePath: string; busy: boolean }>
  /** studio-backend.json `keepDaemonRunning` now. */
  keepDaemonRunning: () => boolean
  /** Local mode: who started the daemon Studio uses (GET /version). */
  daemonStartedBy: () => string | null
  window: () => BrowserWindow | null
  /** Restart Studio now (the quit runs the usual cleanup). */
  relaunch: (target: StudioBackendMode) => void
  /** The saved remote daemon URL, named in a switch to Remote daemon. */
  remoteUrl?: () => string | null
}

/**
 * F9 across machines (W4-B): agents are resumed after a switch only between
 * Studio and a daemon on this computer. A remote daemon runs its own agents:
 * the agents running here are not started on it, and its agents keep running
 * there and are not started here.
 */
export function resumesAgents(from: StudioBackendMode, to: StudioBackendMode): boolean {
  return from !== 'remote' && to !== 'remote'
}

/** Agent names for the dialogs, from agent file paths. */
export function agentNames(paths: readonly string[]): string[] {
  return paths.map((p) => basename(p).replace(/\.adf$/i, ''))
}

interface ResumeRecord { v: 1; from: StudioBackendMode; to: StudioBackendMode; agents: string[]; at: string }

/**
 * Settings → Backend's switch (§11, §11.1): `confirm` shows the dialog,
 * `apply` (after the mode is saved) records the running agents for the
 * other side and restarts, now or once the turns in flight finished.
 */
export function createModeSwitcher(ctx: SwitchContext) {
  let choice: { target: StudioBackendMode; wait: boolean; agents: string[] } | null = null
  let pending: { target: StudioBackendMode; gaveUp: boolean; waitingFor: () => string[]; finish: () => void; cancel: () => void } | null = null

  const confirm = async (target: StudioBackendMode): Promise<boolean> => {
    const plan = await planHandover(target as HandoverTarget, handoverDeps(ctx.userDataDir, { chooseSession: undefined }), ctx.activeMode)
      .catch((err) => [{ id: 'client-settings' as const, label: 'Handover', detail: `could not be planned: ${err instanceof Error ? err.message : String(err)}` }])
    const activity = ctx.agentActivity()
    const running = activity.map((a) => a.filePath)
    // A local daemon that keeps running after Studio quits (CLI-started, or "keep running" on) keeps its agents.
    const localDaemonStays = ctx.activeMode === 'local' && (ctx.keepDaemonRunning() || ctx.daemonStartedBy() !== 'studio')
    // Turns Studio's restart does not interrupt (on a remote daemon, or a local one that stays): nothing to wait for (DMN-02).
    const busy = ctx.activeMode === 'remote' || localDaemonStays ? [] : activity.filter((a) => a.busy).map((a) => a.filePath)
    const remoteUrl = ctx.remoteUrl?.() ?? null
    const lines: string[] = []
    lines.push(target === 'embedded'
      ? 'Studio restarts and runs agents itself.'
      : target === 'local'
        ? 'Studio restarts and runs agents in an ADF daemon on this computer, with the same settings and agent files.'
        : `Studio restarts and uses the ADF daemon at ${remoteUrl ?? 'the remote URL'}.`)
    if (plan.length > 0) {
      // "Back to Studio" only for credentials that come back (from this computer's daemon stores), not for client keys alone.
      lines.push('', target === 'embedded' && plan.some((item) => item.id !== 'client-settings') ? 'Moves back to Studio at the restart:' : 'Moves at the restart:')
      for (const item of plan) lines.push(`• ${item.label}: ${item.detail}`)
    }
    if (target === 'remote') {
      lines.push('', 'Stays on this computer: ChatGPT, Grok and MCP sign-ins, provider keys, the owner phrase and the runtime identity. The remote daemon uses its own; nothing is sent to it.')
    } else if (ctx.activeMode === 'remote') {
      lines.push('', 'Nothing comes from the remote daemon: its agents, sign-ins and keys stay on it.')
    }
    lines.push('')
    const names = agentNames(running).join(', ')
    if (running.length === 0) {
      lines.push('No agent runs now.')
    } else if (ctx.activeMode === 'remote') {
      lines.push(`The remote daemon keeps running its agents (${names}). Studio does not start them ${target === 'embedded' ? 'itself' : 'in the local daemon'}.`)
    } else if (localDaemonStays && target !== 'local') {
      const startedBy = ctx.daemonStartedBy()
      lines.push(`The ADF daemon on this computer keeps running (${startedBy && startedBy !== 'studio' ? `started by ${startedBy}` : '"Keep the daemon running" is on'}), and so do its agents (${names}) there. ${target === 'embedded'
        ? 'Studio does not start an agent the daemon runs; stop it there first (adf daemon stop) to run it in Studio.'
        : 'They are not started on the remote daemon.'}`)
    } else if (target === 'remote') {
      lines.push(`Running agents stop: ${names} stop here and are not started on the remote daemon, which runs its own agents.`)
    } else {
      lines.push(`Running agents keep running: ${names} stop here and Studio starts them ${target === 'embedded' ? 'itself' : 'in the daemon'} after the restart.`)
    }
    if (busy.length > 0) {
      lines.push('', `A turn is in flight in: ${agentNames(busy).join(', ')}. "Wait for Them to Finish" restarts once those turns are done; "Stop Them Now" interrupts them.`)
    }
    if (target === 'local' && process.platform === 'darwin') {
      lines.push('', 'macOS asks once whether the ADF daemon may read Studio\'s runtime key from the keychain. "Always Allow" grants that to the Electron binary that runs the daemon, and to any script it runs.')
    }
    if (process.env[BACKEND_ENV_OVERRIDE]) {
      lines.push('', `${BACKEND_ENV_OVERRIDE} is set in this environment and overrides this choice until it is removed.`)
    }
    const buttons = busy.length > 0 ? ['Wait for Them to Finish', 'Stop Them Now', 'Cancel'] : ['Switch and Restart', 'Cancel']
    const options = {
      type: 'question' as const,
      title: `Switch to ${MODE_LABELS[target]}`,
      message: `Switch the backend from ${MODE_LABELS[ctx.activeMode]} to ${MODE_LABELS[target]}?`,
      detail: lines.join('\n'),
      buttons,
      defaultId: buttons.length - 1,
      cancelId: buttons.length - 1,
      noLink: true,
    }
    const win = ctx.window()
    const { response } = await (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options))
    const confirmed = response < buttons.length - 1
    const wait = confirmed && busy.length > 0 && response === 0
    choice = confirmed ? { target, wait, agents: resumesAgents(ctx.activeMode, target) ? running : [] } : null
    console.log(`[Backend] Switch dialog ${MODE_LABELS[ctx.activeMode]} → ${MODE_LABELS[target]}: ${confirmed ? (wait ? 'confirmed, after the turns in flight' : busy.length > 0 ? 'confirmed, turns in flight stopped' : 'confirmed') : 'cancelled'} (${plan.map((p) => p.label).join(', ') || 'nothing to move'}${names ? `; running: ${names}` : ''})`)
    return confirmed
  }

  const apply = (target: StudioBackendMode): string => {
    const chosen = choice?.target === target ? choice : { target, wait: false, agents: resumesAgents(ctx.activeMode, target) ? ctx.agentActivity().map((a) => a.filePath) : [] }
    choice = null
    const record: ResumeRecord = { v: 1, from: ctx.activeMode, to: target, agents: chosen.agents, at: new Date().toISOString() }
    const restart = async (): Promise<void> => {
      try {
        await writeJsonAtomicAsync(join(ctx.userDataDir, SWITCH_RESUME_FILE), record)
      } catch (err) {
        console.warn('[Backend] Could not record the running agents for the switch; they are not started after it:', err)
      }
      ctx.relaunch(target)
    }
    if (!chosen.wait) {
      void restart()
      return 'Studio restarts now.'
    }
    const busyNames = () => agentNames(ctx.agentActivity().filter((a) => a.busy).map((a) => a.filePath))
    console.log(`[Backend] Switch to ${target}: waiting for the turns in flight (${busyNames().join(', ')}) to finish`)
    const deadline = Date.now() + WAIT_FOR_TURNS_MAX_MS
    const poll = setInterval(() => {
      const still = busyNames()
      if (still.length === 0) {
        console.log(`[Backend] Switch to ${target}: the turns finished; restarting`)
        finish()
      } else if (pending && !pending.gaveUp && Date.now() > deadline) {
        // Waiting stops here; Settings → Backend offers "Finish Switch Now" and "Cancel Switch" (the mode is already saved).
        clearInterval(poll)
        pending.gaveUp = true
        console.warn(`[Backend] Switch to ${target}: ${still.join(', ')} still busy after ${WAIT_FOR_TURNS_MAX_MS / 60_000} min; not restarting until the user finishes or cancels the switch`)
        notify(`The switch to ${MODE_LABELS[target]} is waiting: ${still.join(', ')} still has a turn in flight. Settings → Backend: Finish Switch Now (stops the turns) or Cancel Switch.`)
      }
    }, 1000)
    const finish = (): void => {
      clearInterval(poll)
      pending = null
      void restart()
    }
    pending = { target, gaveUp: false, waitingFor: busyNames, finish, cancel: () => { clearInterval(poll); pending = null } }
    return `Studio restarts once the turns in flight finish (${busyNames().join(', ')}).`
  }

  /** A switch waiting for turns in flight (Settings → Backend shows it with its two buttons). */
  const pendingSwitch = (): { target: StudioBackendMode; waitingFor: string[]; gaveUp: boolean } | null =>
    pending ? { target: pending.target, waitingFor: pending.waitingFor(), gaveUp: pending.gaveUp } : null

  /** "Finish Switch Now": restart now; the quit interrupts the turns still in flight. */
  const finishNow = (): string | null => {
    if (!pending) return null
    console.log(`[Backend] Switch to ${pending.target}: finished now by the user (turns in flight are interrupted)`)
    pending.finish()
    return 'Studio restarts now.'
  }

  /** "Cancel Switch": stop waiting. The caller saves the running mode again. */
  const cancel = (): StudioBackendMode | null => {
    if (!pending) return null
    const target = pending.target
    console.log(`[Backend] Switch to ${target} cancelled by the user; this mode stays`)
    pending.cancel()
    return target
  }

  return { confirm, apply, pendingSwitch, finishNow, cancel }
}

function notify(body: string): void {
  try {
    if (Notification.isSupported()) new Notification({ title: 'ADF Studio', body }).show()
  } catch { /* no notifications */ }
}

/**
 * After the restart of a switch (§11.1): start the agents that ran before it,
 * on this side. `start` is the gated background start of this mode. An agent
 * already running (autostart, or still in a daemon that kept running) is
 * left as it is. Logged, and shown as one notification.
 */
export async function resumeSwitchedAgents(
  mode: StudioBackendMode,
  userDataDir: string,
  start: (filePath: string) => Promise<{ success: boolean; error?: string }>,
  opts: { ready?: Promise<unknown> } = {},
): Promise<void> {
  const file = join(userDataDir, SWITCH_RESUME_FILE)
  let record: ResumeRecord | null = null
  try {
    record = JSON.parse(await fsp.readFile(file, 'utf-8')) as ResumeRecord
  } catch {
    return
  }
  const stale = !record || record.v !== 1 || !Array.isArray(record.agents) || !(Date.now() - Date.parse(record.at) <= RESUME_MAX_AGE_MS)
  // A launch in another mode (a session-only override) leaves the record for the switch's own launch.
  if (!stale && record!.to !== mode) return
  await fsp.unlink(file).catch(() => {})
  if (!record || stale) {
    console.log(`[Backend] Not resuming the agents of a switch: the record ${file} is malformed or older than ${RESUME_MAX_AGE_MS / 60_000} min`)
    return
  }
  // The backend's own boot (embedded: the mesh) finishes first, as autostart waits for it.
  await opts.ready?.catch(() => {})
  const started: string[] = []
  const failed: string[] = []
  for (const filePath of record.agents) {
    const result = await start(filePath).catch((err) => ({ success: false, error: err instanceof Error ? err.message : String(err) }))
    const name = agentNames([filePath])[0]
    if (result.success) started.push(name)
    else failed.push(`${name} (${result.error ?? 'failed'})`)
  }
  console.log(`[Backend] After the switch to ${mode}: started ${started.join(', ') || 'none'}${failed.length ? `; not started: ${failed.join(', ')}` : ''}`)
  if (started.length || failed.length) {
    notify(`${started.length ? `Running again after the switch: ${started.join(', ')}.` : ''}${failed.length ? ` Not started: ${failed.join(', ')}.` : ''}`.trim())
  }
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
  if (running.startedBy !== 'studio') warnings.push(`This daemon was started by ${running.startedBy === 'cli' ? 'the ADF CLI (adf daemon start)' : 'a service manager'}, not Studio. Restarting replaces it; the new one counts as started by ${running.startedBy} too, so Studio's quit never stops it.`)
  if (others.length > 0) warnings.push(`Connected to it now: ${others.map((c) => `${c.client} ${c.version}`).join(', ')}. A restart disconnects them.`)
  if (clients === null) warnings.push('Studio cannot tell which other clients use it (an older daemon).')
  const risky = warnings.length > 0
  const buttons = [risky ? 'Restart It Anyway' : 'Restart the Daemon with Studio\'s Version', 'Use Embedded Mode for This Session']
  const options = {
    type: 'warning' as const,
    title: 'ADF daemon version',
    message: `The running ADF daemon is version ${running.version}; this Studio is ${app.getVersion()}.`,
    detail: `${decision.message}\n\nRestarting stops that daemon (pid ${running.pid}) and its agents, then starts this Studio's daemon, which starts the agents set to autostart.${risky ? `\n\n${warnings.join('\n')}` : ''}\n\nEmbedded mode for this session leaves that daemon, its agents and its sign-ins as they are; Studio does not start an agent it runs, and nothing moves between them.`,
    buttons,
    defaultId: risky ? 1 : 0,
    cancelId: 1,
    noLink: true,
  }
  const win = window()
  const { response } = await (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options))
  if (response === 0) return 'restart'
  relaunchEmbeddedForSession('daemon version mismatch')
  return 'embedded'
}

let relaunching = false

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
 * Restart Studio in embedded mode for this launch only (SESSION_BACKEND_ARG):
 * after a daemon version mismatch, or a launch whose daemon could not be
 * reached. The saved mode, the daemon, its agents and its sign-ins stay as
 * they are; credentials do not move (session-only handover).
 */
export function relaunchEmbeddedForSession(reason: string): void {
  if (relaunchStarted(reason)) return
  console.log(`[Backend] Restarting Studio in embedded mode for this session (${reason}); credentials stay where the saved mode keeps them`)
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
  app.relaunch({ args: process.argv.slice(1).filter((arg) => arg !== SESSION_BACKEND_ARG) })
  app.quit()
}
