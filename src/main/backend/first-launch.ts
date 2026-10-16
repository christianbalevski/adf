import { app, dialog, shell, type BrowserWindow, type MessageBoxOptions, type MessageBoxReturnValue } from 'electron'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import type { BackendDefaultSwitch, StudioBackendMode } from '../../shared/types/backend.types'
import { guideUrl } from '../../shared/constants/docs-links'
import { writeJsonAtomicAsync } from '../utils/atomic-json'
import { showWindowlessMessageBox } from '../utils/windowless-dialog'
import { CLIENT_API_VERSION } from '../daemon/routes/meta-routes'
import { persistDefaultBackend, type BootBackend } from './backend-config'
import { DaemonProcessController, decideAttach, type DaemonDetection } from './daemon-process'
import type { HandoverItemResult, HandoverReport } from './handover'
import { showHandoverSummary } from './mode-switch'

/**
 * The first launch of the release that made Local daemon the default (owner
 * decision 2026-10-16, design §4.4), and the boot cases where the saved or
 * default backend cannot simply be used.
 *
 * Before the handover (guardBoot):
 * - A `studio-backend.json` that exists but cannot be used (unreadable,
 *   corrupt, an unknown mode): Studio asks which backend to use, over the
 *   boot window (utils/windowless-dialog.ts), before anything moves, and
 *   saves the answer. When the file cannot be rewritten (`writeBlocked`), the
 *   dialog names the path, the error and the fix, and the answer applies to
 *   this launch only (session-only: no credential moves).
 * - First launch on the default with a daemon on the port that Studio cannot
 *   identify, or of an older client API (a 0.7.x `adf` from npm): no
 *   handover, the default is not saved, this launch runs Embedded without
 *   the boot autostart (that daemon runs those agents, and holds no lease),
 *   and a dialog over the main window says what to do.
 *
 * After the handover (settleDefaultBackend): on a launch that resolved the
 * default, save it; on an install that ran Embedded, keep the notice in
 * `studio-default-switch.pending.json` until it has been shown.
 *
 * Once the main window is ready (showBootNotices): the guard's dialog; the
 * notice, once the daemon connected (or what happened when it did not),
 * after which `studio-default-switch.json` records it as shown; else the
 * handover summary. Every dialog is parented to a visible window.
 */

/** Written once the first-launch notice was shown; Settings → Backend shows it as "Default changed". */
export const DEFAULT_SWITCH_FILE = 'studio-default-switch.json'
/** The first-launch notice not shown yet (Studio quit or crashed before): shown at the next launch. */
export const PENDING_NOTICE_FILE = 'studio-default-switch.pending.json'
/** The guide section the notice links to. */
export const UPGRADE_GUIDE_URL = guideUrl('studio-backend', 'upgrading-from-07x')

const SETTINGS_FILE = 'adf-settings.json'

type Log = (line: string) => void
const defaultLog: Log = (line) => console.log(line)

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse((await fsp.readFile(path, 'utf-8')).replace(/^\uFEFF/, '')) as unknown
  } catch {
    return null
  }
}

// --- before the handover ------------------------------------------------------------

/** A dialog for the main window once it is ready. */
export interface GuardNotice { type: 'warning' | 'info'; title: string; message: string; detail: string }

export interface BootGuard {
  /** Run no handover this launch. */
  skipHandover: boolean
  /** Embedded this launch: skip the boot autostart of tracked folders, for this reason (logged). */
  skipAutostart: string | null
  /** Shown over the main window once it is ready. */
  notice: GuardNotice | null
}

export interface BootGuardDeps {
  /** §8.2 step 1 on Studio's settings (default: DaemonProcessController.detect). */
  detectDaemon?: () => Promise<DaemonDetection>
  /** A dialog before the main window exists (default: the boot window, utils/windowless-dialog.ts). */
  ask?: (waitingOn: string, options: MessageBoxOptions) => Promise<Pick<MessageBoxReturnValue, 'response'>>
  log?: Log
}

const NO_GUARD: BootGuard = { skipHandover: false, skipAutostart: null, notice: null }

/** The file-problem question (pure, for tests). */
export function fileProblemOptions(boot: BootBackend): MessageBoxOptions {
  const blocked = !!boot.writeBlocked
  return {
    type: 'warning',
    title: 'Backend settings',
    message: blocked ? 'Studio cannot use or replace its backend settings file.' : 'Studio cannot use its backend settings file.',
    detail: blocked
      ? `${boot.configPath}: ${boot.fileProblem}.\n\n${boot.writeBlocked}\n\nUntil then Studio asks at each launch. The backend you choose now applies to this launch only, and no sign-in moves.`
      : `${boot.configPath}: ${boot.fileProblem}.\n\nChoose where Studio runs agents. Studio saves your choice and then moves your sign-ins to that side, as a switch in Settings → Backend does. Embedded is the legacy backend, removed in the next release.`,
    buttons: blocked
      ? ['Use Local Daemon for This Launch', 'Use Embedded for This Launch']
      : ['Use Local Daemon (Recommended)', 'Use Embedded'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  }
}

/** A daemon on the port that a first launch must not hand over to: why, or null. */
export function oldDaemonProblem(detection: DaemonDetection, settingsPath: string, port: number): string | null {
  if (detection.state === 'unidentified') {
    return `An ADF daemon that Studio cannot identify is running on port ${port} (${detection.message}). If it is an older ADF daemon started by the npm CLI, it uses the same settings.`
  }
  if (detection.state !== 'running') return null
  const decision = decideAttach(detection.info, { settingsPath })
  if (decision.kind !== 'version-mismatch' || detection.info.clientApiVersion >= CLIENT_API_VERSION) return null
  const by = detection.info.startedBy === 'cli' ? 'started by the npm CLI' : detection.info.startedBy === 'service' ? 'started by a service manager' : 'started by ADF Studio'
  return `An older ADF daemon (adf ${detection.info.version}, ${by}) is running and uses the same settings.`
}

/**
 * Before the boot handover. May change `boot` (mode, source `session`,
 * sessionReason, config.mode). Logged; never throws.
 */
export async function guardBoot(boot: BootBackend, userDataDir: string, deps: BootGuardDeps = {}): Promise<BootGuard> {
  const log = deps.log ?? defaultLog
  const ask = deps.ask ?? showWindowlessMessageBox
  try {
    if (boot.fileProblem && boot.source === 'file') {
      log(`[Backend] ${boot.configPath} cannot be used (${boot.fileProblem}); asking which backend to use before anything moves`)
      const { response } = await ask(`which backend to use (${boot.configPath} cannot be used)`, fileProblemOptions(boot))
      const mode: StudioBackendMode = response === 1 ? 'embedded' : 'local'
      boot.mode = mode
      if (boot.writeBlocked) {
        boot.source = 'session'
        boot.sessionReason = `${boot.configPath} cannot be used or replaced (${boot.fileProblem}). Fix it, then restart Studio.`
        log(`[Backend] The user chose ${mode} for this launch only: ${boot.configPath} cannot be rewritten; no sign-in moves`)
        return NO_GUARD
      }
      boot.config = { ...boot.config, mode }
      await fsp.mkdir(userDataDir, { recursive: true })
      await writeJsonAtomicAsync(boot.configPath, boot.config)
      boot.fileProblem = null
      log(`[Backend] The user chose ${mode}; saved it to ${boot.configPath}`)
      return NO_GUARD
    }
    if (boot.source !== 'default' || boot.mode !== 'local') return NO_GUARD
    const settingsPath = join(userDataDir, SETTINGS_FILE)
    const controller = new DaemonProcessController({ settingsPath, userDataDir, daemonEntry: '', execPath: process.execPath }, { log })
    const detection = await (deps.detectDaemon ?? (() => controller.detect()))()
    const problem = oldDaemonProblem(detection, settingsPath, controller.port)
    if (!problem) return NO_GUARD
    boot.mode = 'embedded'
    boot.source = 'session'
    boot.sessionReason = `${problem} Stop it with adf daemon stop, update the CLI, then restart Studio.`
    const reason = 'an older ADF daemon runs the agents of these settings, and it takes no agent lease'
    log(`[Backend] First launch on the default, but ${problem} No handover, the default is not saved, and this launch runs Embedded without the boot autostart (${reason})`)
    return {
      skipHandover: true,
      skipAutostart: reason,
      notice: {
        type: 'warning',
        title: 'ADF daemon',
        message: problem,
        detail: 'Stop it with `adf daemon stop`, update the CLI (`npm i -g @agentdocumentformat/cli@latest`), then restart Studio.\n\nUntil then Studio runs agents itself for this launch only (Embedded), and nothing moved. Studio did not start your agents set to start automatically, because that daemon may be running them and they would run twice. To run one here now: stop it in that daemon (`adf stop <name>`, or `adf daemon stop` for all), then open it in Studio and press Start.',
      },
    }
  } catch (err) {
    log(`[Backend] The boot check failed (${errorText(err)}); this launch runs Embedded for this session, and nothing moves`)
    boot.mode = 'embedded'
    boot.source = 'session'
    boot.sessionReason = `the boot check failed (${errorText(err)}); details are in the main log`
    return { skipHandover: true, skipAutostart: null, notice: null }
  }
}

// --- after the handover --------------------------------------------------------------

let quitTracked = false
let quitSeen = false

/**
 * Note when Studio starts to quit or restart (a switch, "Use Embedded Mode
 * for This Session" after a version mismatch, which can come before the
 * main window is ready): the first-launch notice then waits for a launch
 * that stays. Called from settleDefaultBackend, early in boot.
 */
function trackQuit(): void {
  if (quitTracked) return
  quitTracked = true
  try {
    app.once('before-quit', () => { quitSeen = true })
  } catch { /* no app (tests without it): never quitting */ }
}

/** The first-launch notice: what the handover of the switch to the default did. */
export interface FirstLaunchNotice {
  record: BackendDefaultSwitch
  /** Items left with Studio on purpose (no keychain the daemon can read), with their reason. */
  kept: Array<Pick<HandoverItemResult, 'label' | 'detail'>>
  /** Studio had a runtime identity the daemon could not adopt (design K12). */
  identityNotShared: boolean
  /** The runtime key went into the keychain: macOS asks once whether the daemon may read it. */
  keychainWritten: boolean
}

function parseRecord(raw: unknown): BackendDefaultSwitch | null {
  const r = raw as Partial<BackendDefaultSwitch> | null
  if (!r || typeof r.at !== 'string' || !Array.isArray(r.moved) || !Array.isArray(r.notDone)) return null
  return { at: r.at, version: typeof r.version === 'string' ? r.version : '', moved: r.moved.filter((m) => typeof m === 'string'), notDone: r.notDone.filter((m) => typeof m === 'string') }
}

function parsePending(raw: unknown): FirstLaunchNotice | null {
  const r = raw as Partial<FirstLaunchNotice> | null
  const record = parseRecord(r?.record)
  if (!r || !record) return null
  return {
    record,
    kept: Array.isArray(r.kept) ? r.kept.filter((k) => k && typeof k.label === 'string' && typeof k.detail === 'string') : [],
    identityNotShared: r.identityNotShared === true,
    keychainWritten: r.keychainWritten === true,
  }
}

/**
 * The notice from this launch's handover, merged into one still pending from
 * an earlier launch: moved is the union, and what is not done is this
 * launch's (the current state; an earlier failure that this launch fixed is
 * gone). Exported for tests.
 */
export function mergeNotice(pending: FirstLaunchNotice | null, report: HandoverReport | null, settings: Record<string, unknown> | null, version: string): FirstLaunchNotice {
  const items = report?.items ?? []
  const moved = items.filter((i) => i.outcome === 'moved' || i.outcome === 'written' || i.outcome === 'deleted').map((i) => i.label)
  const notDone = items.filter((i) => i.outcome === 'failed' || i.pending).map((i) => `${i.label}: ${i.detail}`)
  if (!report) notDone.push('The handover could not run; Studio retries at the next start. Details are in the main log.')
  const kept = items.filter((i) => i.outcome === 'kept' && !i.pending && (i.id === 'runtime-identity' || i.id === 'mcp-oauth')).map((i) => ({ label: i.label, detail: i.detail }))
  return {
    record: { at: pending?.record.at ?? new Date().toISOString(), version, moved: [...new Set([...(pending?.record.moved ?? []), ...moved])], notDone },
    kept: pending && pending.kept.length > 0 ? pending.kept : kept,
    identityNotShared: (pending?.identityNotShared ?? false) || (typeof settings?.runtimeDid === 'string' && items.some((i) => i.id === 'runtime-identity' && i.outcome === 'kept')),
    keychainWritten: (pending?.keychainWritten ?? false) || items.some((i) => i.id === 'runtime-identity' && i.outcome === 'written'),
  }
}

/**
 * After the boot handover, before the daemon starts. On a launch that
 * resolved the default: save it; on an install that ran Embedded, keep the
 * notice in PENDING_NOTICE_FILE. On a later launch a notice still pending
 * is returned again, merged with that launch's handover (mergeNotice), so
 * it stands in for that launch's summary. Sets `boot.defaultSwitch` for
 * Settings → Backend. Null on a fresh install and when there is nothing to
 * show. Never throws.
 */
export async function settleDefaultBackend(
  boot: BootBackend,
  userDataDir: string,
  report: HandoverReport | null,
  opts: { version: string; log?: Log },
): Promise<FirstLaunchNotice | null> {
  trackQuit()
  const log = opts.log ?? defaultLog
  const shown = parseRecord(await readJson(join(userDataDir, DEFAULT_SWITCH_FILE)))
  let pending = parsePending(await readJson(join(userDataDir, PENDING_NOTICE_FILE)))
  boot.defaultSwitch = shown ?? pending?.record ?? null
  if (boot.source === 'default' && boot.mode === 'local' && !shown) {
    await persistDefaultBackend(boot, { log, warn: log })
    const settings = await readJson(join(userDataDir, SETTINGS_FILE)) as Record<string, unknown> | null
    // An install that ran Embedded has Studio's settings file; a fresh one has nothing to move and gets no dialog.
    if (!settings && !report?.changed) {
      log(`[Backend] First launch of this install: ${boot.mode} (the default); nothing to move`)
      return pending
    }
    // A pending notice from a launch that quit before showing it keeps what that launch moved.
    pending = await savePending(userDataDir, mergeNotice(pending, report, settings, opts.version), log)
    boot.defaultSwitch = pending.record
    log(`[Backend] Switched this install from Embedded to the default, ${boot.mode}: moved ${pending.record.moved.join(', ') || 'nothing'}${pending.record.notDone.length ? `; not done: ${pending.record.notDone.length} item(s)` : ''}; the notice is shown once the daemon connected`)
    return pending
  }
  // A notice an earlier launch could not show: again, while this launch runs the daemon, with this launch's handover merged in.
  if (shown || !pending || boot.mode !== 'local' || boot.source === 'session') return null
  const settings = await readJson(join(userDataDir, SETTINGS_FILE)) as Record<string, unknown> | null
  pending = await savePending(userDataDir, mergeNotice(pending, report, settings, opts.version), log)
  boot.defaultSwitch = pending.record
  log(`[Backend] The first-launch notice of an earlier launch is still to be shown; this launch's handover is merged into it (not done now: ${pending.record.notDone.length} item(s))`)
  return pending
}

async function savePending(userDataDir: string, notice: FirstLaunchNotice, log: Log): Promise<FirstLaunchNotice> {
  try {
    await writeJsonAtomicAsync(join(userDataDir, PENDING_NOTICE_FILE), { v: 1, ...notice })
  } catch (err) {
    log(`[Backend] Could not write ${PENDING_NOTICE_FILE}: ${errorText(err)}`)
  }
  return notice
}

/** Record the notice as shown: Settings → Backend's "Default changed", and no notice at later launches. */
async function markNoticeShown(userDataDir: string, notice: FirstLaunchNotice, log: Log): Promise<void> {
  try {
    await writeJsonAtomicAsync(join(userDataDir, DEFAULT_SWITCH_FILE), { v: 1, from: 'embedded', to: 'local', ...notice.record, shownAt: new Date().toISOString() })
    await fsp.rm(join(userDataDir, PENDING_NOTICE_FILE), { force: true })
  } catch (err) {
    log(`[Backend] Could not record the first-launch notice as shown (${errorText(err)}); it is shown again at the next launch`)
  }
}

/** The notice's dialog options (pure, for tests). `connected`: the daemon answered. */
export function firstLaunchNoticeOptions(notice: FirstLaunchNotice, connected: boolean, platform: NodeJS.Platform = process.platform): MessageBoxOptions {
  const { record } = notice
  const parts: string[] = []
  parts.push(record.moved.length > 0 ? `Moved: ${record.moved.join(', ')}.` : 'Moved: nothing; Studio held no settings or sign-ins the daemon keeps.')
  if (notice.kept.length > 0) parts.push(`Stays in Studio: ${notice.kept.map((i) => `${i.label} (${i.detail.replace(/\.$/, '')})`).join('; ')}.`)
  if (notice.identityNotShared) {
    parts.push('The daemon runs as its own runtime: files it stamps show as "recognized" in Studio\'s review, and agents made in Studio unlock in the daemon only with the owner phrase (adf identity restore) or after adf identity trust-daemon.')
  }
  if (record.notDone.length > 0) parts.push(`Not done yet, retried at the next start:\n${record.notDone.map((line) => `• ${line}`).join('\n')}`)
  parts.push(connected
    ? 'Agents set to start automatically now start in the daemon, as they started in Studio before.'
    : 'Studio could not connect to the ADF daemon, so no agent runs yet. The connection dialog says why; Reconnect tries again, and the agents set to start automatically start once the daemon runs.')
  if (notice.keychainWritten && platform === 'darwin') {
    parts.push('macOS asks once whether the ADF daemon may read Studio\'s runtime key from the keychain. "Always Allow" grants that to the Electron binary that runs the daemon.')
  }
  parts.push('Embedded stays in Settings → Backend for this release only, as a fallback; switching to it moves your sign-ins back into Studio.')
  parts.push('Settings → Backend has the details.')
  return {
    type: record.notDone.length > 0 || !connected ? 'warning' : 'info',
    title: 'Backend: Local daemon',
    message: connected ? 'Studio now runs agents in the ADF daemon.' : 'Studio now runs agents in the ADF daemon, but could not connect to it.',
    detail: parts.join('\n\n'),
    buttons: ['OK', 'Open the Guide'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  }
}

/**
 * Once the main window is ready: the guard's dialog, then the first-launch
 * notice (after `ready`, the daemon connection, settles) and its record, or
 * the handover summary. Every dialog is parented to `window`. Never throws.
 */
export async function showBootNotices(opts: {
  report: HandoverReport | null
  mode: StudioBackendMode
  notice: FirstLaunchNotice | null
  guard: GuardNotice | null
  window: BrowserWindow
  /** Daemon mode: resolves true once connected, false when no daemon could be reached. */
  ready?: Promise<boolean>
  userDataDir: string
  log?: Log
  /** Studio is quitting or restarting (default: app 'before-quit' seen since boot, trackQuit). */
  quitting?: () => boolean
}): Promise<void> {
  trackQuit()
  const log = opts.log ?? defaultLog
  const { window } = opts
  const quitting = opts.quitting ?? (() => quitSeen)
  if (opts.guard) {
    await dialog.showMessageBox(window, { ...opts.guard, buttons: ['OK'], noLink: true }).catch((err) => log(`[Backend] The boot dialog could not be shown: ${errorText(err)}`))
  }
  if (opts.notice) {
    const connected = opts.ready ? await opts.ready.catch(() => false) : true
    if (quitting() || window.isDestroyed()) {
      log('[Backend] Studio is quitting or restarting: the first-launch notice is not shown and stays pending for the next launch')
      return
    }
    try {
      const { response } = await dialog.showMessageBox(window, firstLaunchNoticeOptions(opts.notice, connected))
      await markNoticeShown(opts.userDataDir, opts.notice, log)
      log(`[Backend] First-launch notice shown${connected ? '' : ' (the daemon could not be reached)'}`)
      if (response === 1) await shell.openExternal(UPGRADE_GUIDE_URL)
    } catch (err) {
      log(`[Backend] The first-launch notice could not be shown (${errorText(err)}); it is shown at the next launch`)
    }
    return
  }
  if (opts.report) showHandoverSummary(opts.report, opts.mode, window)
}

