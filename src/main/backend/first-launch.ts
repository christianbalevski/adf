import { dialog, shell, type BrowserWindow } from 'electron'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import type { BackendDefaultSwitch, StudioBackendMode } from '../../shared/types/backend.types'
import { guideUrl } from '../../shared/constants/docs-links'
import { writeJsonAtomicAsync } from '../utils/atomic-json'
import { persistDefaultBackend, type BootBackend } from './backend-config'
import { REPLACED_TOKEN_MAX_AGE_DAYS, type HandoverItemResult, type HandoverReport, type SessionChoice, type SessionConflict } from './handover'
import { showHandoverSummary } from './mode-switch'

/**
 * The first launch of the release that made Local daemon the default (owner
 * decision 2026-10-16, design §14), and the accounts question at boot.
 *
 * - An install with no `studio-backend.json` boots Local daemon. The boot
 *   handover (handover.ts) moves what Studio held into the daemon, as a
 *   switch in Settings → Backend does. Afterwards the resolved mode is saved
 *   to `studio-backend.json`, and on an install that had run Embedded (it has
 *   an `adf-settings.json`) one notice says what happened, once, over the
 *   main window. `studio-default-switch.json` records it for Settings →
 *   Backend. A fresh install has nothing to move and sees no dialog.
 * - An accounts conflict (Studio and the daemon signed in to one provider
 *   with different accounts) is never asked before the window exists: at
 *   that launch it is deferred, both sessions stay where they are, and the
 *   question is asked over the window. The answer is saved in
 *   `studio-session-choice.json` and applied by the next start's handover.
 *   A conflict still unanswered is deferred again at every start.
 *
 * Every step is logged; every dialog has the main window as its parent.
 */

/** What the first launch on the new default did; Settings → Backend shows it. */
export const DEFAULT_SWITCH_FILE = 'studio-default-switch.json'
/** Accounts conflicts asked over the window, and their answers, until a start applies them. */
export const SESSION_CHOICE_FILE = 'studio-session-choice.json'
/** The guide section the notice links to. */
export const UPGRADE_GUIDE_URL = guideUrl('studio-backend', 'upgrading-from-07x')

const SETTINGS_FILE = 'adf-settings.json'
const CHOICE_MAX_AGE_MS = REPLACED_TOKEN_MAX_AGE_DAYS * 24 * 60 * 60 * 1000

type Log = (line: string) => void
const defaultLog: Log = (line) => console.log(line)

interface ChoiceEntry {
  provider: string
  studio: string
  daemon: string
  /** null: asked (or about to be), not answered yet. */
  keep: 'studio' | 'daemon' | null
  at: string
}

interface ChoiceFile { v: 1; conflicts: ChoiceEntry[] }

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse((await fsp.readFile(path, 'utf-8')).replace(/^﻿/, '')) as unknown
  } catch {
    return null
  }
}

async function readChoices(userDataDir: string, now = Date.now()): Promise<ChoiceFile> {
  const raw = await readJson(join(userDataDir, SESSION_CHOICE_FILE)) as Partial<ChoiceFile> | null
  const conflicts = Array.isArray(raw?.conflicts) ? raw.conflicts : []
  return {
    v: 1,
    conflicts: conflicts.filter((e): e is ChoiceEntry => !!e && typeof e === 'object'
      && typeof e.provider === 'string' && typeof e.studio === 'string' && typeof e.daemon === 'string'
      && (e.keep === null || e.keep === 'studio' || e.keep === 'daemon')
      && now - Date.parse(e.at) <= CHOICE_MAX_AGE_MS),
  }
}

async function writeChoices(userDataDir: string, file: ChoiceFile): Promise<void> {
  await fsp.mkdir(userDataDir, { recursive: true })
  await writeJsonAtomicAsync(join(userDataDir, SESSION_CHOICE_FILE), file)
}

const sameConflict = (entry: ChoiceEntry, conflict: SessionConflict): boolean =>
  entry.provider === conflict.provider && entry.studio === conflict.studio.account && entry.daemon === conflict.daemon.account

/**
 * The boot handover's first answer to an accounts conflict
 * (runBootHandover `chooseSession`): the answer given over the window after
 * an earlier start, or 'defer' when `defer` is set (the first launch on the
 * new default) or the conflict was deferred before and is still unanswered.
 * Null otherwise: the accounts dialog asks, as before.
 */
export function bootSessionChooser(userDataDir: string, opts: { defer: boolean; log?: Log }): (conflict: SessionConflict) => Promise<SessionChoice | null> {
  const log = opts.log ?? defaultLog
  return async (conflict) => {
    const file = await readChoices(userDataDir)
    const index = file.conflicts.findIndex((e) => sameConflict(e, conflict))
    const entry = index >= 0 ? file.conflicts[index] : null
    if (entry?.keep) {
      file.conflicts.splice(index, 1)
      await writeChoices(userDataDir, file).catch((err) => log(`[Handover] Could not update ${SESSION_CHOICE_FILE}: ${err instanceof Error ? err.message : String(err)}`))
      log(`[Handover] ${conflict.label}: keeping the ${entry.keep === 'studio' ? `Studio session (${conflict.studio.account})` : `daemon session (${conflict.daemon.account})`}, as chosen after an earlier start`)
      return entry.keep
    }
    if (!entry && !opts.defer) return null
    if (!entry) {
      file.conflicts.push({ provider: conflict.provider, studio: conflict.studio.account, daemon: conflict.daemon.account, keep: null, at: new Date().toISOString() })
      await writeChoices(userDataDir, file).catch((err) => log(`[Handover] Could not update ${SESSION_CHOICE_FILE}: ${err instanceof Error ? err.message : String(err)}`))
    }
    log(`[Handover] ${conflict.label}: Studio (${conflict.studio.account}) and the daemon (${conflict.daemon.account}) are signed in with different accounts; both sessions stay where they are, and Studio asks which to keep once its window is open`)
    return 'defer'
  }
}

/** Save the answer to a deferred conflict; the next start's handover applies it. */
export async function saveSessionChoice(userDataDir: string, conflict: SessionConflict, keep: 'studio' | 'daemon' | null): Promise<void> {
  const file = await readChoices(userDataDir)
  const rest = file.conflicts.filter((e) => !sameConflict(e, conflict))
  rest.push({ provider: conflict.provider, studio: conflict.studio.account, daemon: conflict.daemon.account, keep, at: new Date().toISOString() })
  await writeChoices(userDataDir, { v: 1, conflicts: rest })
}

const deferredConflicts = (report: HandoverReport | null): SessionConflict[] =>
  (report?.items ?? []).flatMap((item) => (item.conflict ? [item.conflict] : []))

/** The first launch on the new default: what the notice says, built from the boot handover. */
export interface FirstLaunchNotice {
  record: BackendDefaultSwitch
  /** Items left with Studio on purpose (no keychain the daemon can read), with their reason. */
  kept: HandoverItemResult[]
  conflicts: SessionConflict[]
  /** Studio had a runtime identity the daemon could not adopt (design K12). */
  identityNotShared: boolean
  /** The runtime key went into the keychain: macOS asks once whether the daemon may read it. */
  keychainWritten: boolean
}

function readDefaultSwitch(raw: unknown): BackendDefaultSwitch | null {
  const r = raw as Partial<BackendDefaultSwitch> | null
  if (!r || typeof r.at !== 'string' || !Array.isArray(r.moved) || !Array.isArray(r.notDone)) return null
  return { at: r.at, version: typeof r.version === 'string' ? r.version : '', moved: r.moved.filter((m) => typeof m === 'string'), notDone: r.notDone.filter((m) => typeof m === 'string') }
}

/**
 * After the boot handover, before the daemon starts: on a launch that
 * resolved the default (no `studio-backend.json`), save it to the file, and
 * on an install that had run Embedded record what the handover did and
 * return the notice to show once the window is up. Sets
 * `boot.defaultSwitch` for Settings → Backend on every launch that has a
 * record. Null on a fresh install, an explicit file and an override launch.
 * Never throws.
 */
export async function settleDefaultBackend(
  boot: BootBackend,
  userDataDir: string,
  report: HandoverReport | null,
  opts: { version: string; log?: Log },
): Promise<FirstLaunchNotice | null> {
  const log = opts.log ?? defaultLog
  const recordPath = join(userDataDir, DEFAULT_SWITCH_FILE)
  const existing = readDefaultSwitch(await readJson(recordPath))
  boot.defaultSwitch = existing
  if (boot.source !== 'default') return null
  await persistDefaultBackend(boot, { log, warn: log })
  const settings = await readJson(join(userDataDir, SETTINGS_FILE)) as Record<string, unknown> | null
  // An install that ran Embedded has Studio's settings file; a fresh one has nothing to move and gets no dialog.
  if (!settings && !report?.changed) {
    log(`[Backend] First launch of this install: ${boot.mode} (the default); nothing to move`)
    return null
  }
  if (existing) {
    log(`[Backend] ${DEFAULT_SWITCH_FILE} says an earlier launch switched this install to the default already (${existing.at}); not shown again`)
    return null
  }
  const items = report?.items ?? []
  const record: BackendDefaultSwitch = {
    at: new Date().toISOString(),
    version: opts.version,
    moved: items.filter((i) => i.outcome === 'moved' || i.outcome === 'written' || i.outcome === 'deleted').map((i) => i.label),
    notDone: items.filter((i) => (i.outcome === 'failed' || i.pending) && !i.conflict).map((i) => `${i.label}: ${i.detail}`),
  }
  if (!report) record.notDone.push('The handover could not run; Studio retries at the next start. Details are in the main log.')
  try {
    await writeJsonAtomicAsync(recordPath, { v: 1, from: 'embedded', to: boot.mode, ...record })
  } catch (err) {
    log(`[Backend] Could not write ${recordPath}: ${err instanceof Error ? err.message : String(err)}`)
  }
  boot.defaultSwitch = record
  const kept = items.filter((i) => i.outcome === 'kept' && !i.pending && (i.id === 'runtime-identity' || i.id === 'mcp-oauth'))
  log(`[Backend] Switched this install from Embedded to the default, ${boot.mode}: moved ${record.moved.join(', ') || 'nothing'}${record.notDone.length ? `; not done: ${record.notDone.length} item(s)` : ''}`)
  return {
    record,
    kept,
    conflicts: deferredConflicts(report),
    identityNotShared: typeof settings?.runtimeDid === 'string' && items.some((i) => i.id === 'runtime-identity' && i.outcome === 'kept'),
    keychainWritten: items.some((i) => i.id === 'runtime-identity' && i.outcome === 'written'),
  }
}

/** The notice's dialog options (pure, for tests). */
export function firstLaunchNoticeOptions(notice: FirstLaunchNotice, platform: NodeJS.Platform = process.platform) {
  const { record } = notice
  const parts: string[] = []
  parts.push(record.moved.length > 0 ? `Moved: ${record.moved.join(', ')}.` : 'Moved: nothing; Studio held no settings or sign-ins the daemon keeps.')
  if (notice.kept.length > 0) {
    parts.push(`Stays in Studio: ${notice.kept.map((i) => `${i.label} (${i.detail.replace(/\.$/, '')})`).join('; ')}.`)
  }
  if (notice.identityNotShared) {
    parts.push('The daemon runs as its own runtime: files it stamps show as "recognized" in Studio\'s review, and agents made in Studio unlock in the daemon only with the owner phrase (adf identity restore) or after adf identity trust-daemon.')
  }
  if (record.notDone.length > 0) parts.push(`Not done yet, retried at the next start:\n${record.notDone.map((line) => `• ${line}`).join('\n')}`)
  if (notice.conflicts.length > 0) {
    parts.push(`Two accounts: ${notice.conflicts.map((c) => `${c.label} (Studio: ${c.studio.account}, daemon: ${c.daemon.account})`).join('; ')}. Both stay signed in where they are; Studio asks next which one to keep.`)
  }
  parts.push('Agents set to start automatically now start in the daemon, as they started in Studio before.')
  if (notice.keychainWritten && platform === 'darwin') {
    parts.push('macOS asks once whether the ADF daemon may read Studio\'s runtime key from the keychain. "Always Allow" grants that to the Electron binary that runs the daemon.')
  }
  parts.push('Embedded stays in Settings → Backend for this release only, as a fallback; switching to it moves your sign-ins back into Studio.')
  parts.push('Settings → Backend has the details.')
  return {
    type: (record.notDone.length > 0 ? 'warning' : 'info') as 'warning' | 'info',
    title: 'Backend: Local daemon',
    message: 'Studio now runs agents in the ADF daemon.',
    detail: parts.join('\n\n'),
    buttons: ['OK', 'Open the Guide'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  }
}

/** The accounts question asked over the window (pure, for tests). */
export function deferredConflictOptions(conflict: SessionConflict) {
  const provider = conflict.label.replace(/ session$/, '')
  return {
    type: 'question' as const,
    title: `${conflict.label}: two accounts`,
    message: `Studio and the ADF daemon are signed in to ${provider} with different accounts.`,
    detail: `Studio: ${conflict.studio.account}\nDaemon: ${conflict.daemon.account}\n\nUntil you choose, the daemon uses ${conflict.daemon.account} and Studio keeps ${conflict.studio.account}, unused. Only one session can move with the backend: its refresh token is renewed on use, so a copy left behind stops working. The account you do not keep is signed out here and saved, encrypted, in ${conflict.replacedDir} as auth.replaced.<time>.json for ${REPLACED_TOKEN_MAX_AGE_DAYS} days. Studio applies your choice at its next start.`,
    buttons: [`Keep ${conflict.studio.account} (Studio)`, `Keep ${conflict.daemon.account} (daemon)`, 'Decide Later'],
    defaultId: 2,
    cancelId: 2,
    noLink: true,
  }
}

/** Ask each deferred conflict over `window` and save the answers. Logged; never throws. */
export async function askDeferredConflicts(report: HandoverReport | null, window: BrowserWindow, userDataDir: string, log: Log = defaultLog): Promise<void> {
  for (const conflict of deferredConflicts(report)) {
    try {
      const { response } = await dialog.showMessageBox(window, deferredConflictOptions(conflict))
      const keep = response === 0 ? 'studio' : response === 1 ? 'daemon' : null
      await saveSessionChoice(userDataDir, conflict, keep)
      log(keep
        ? `[Handover] ${conflict.label}: the user chose the ${keep === 'studio' ? `Studio session (${conflict.studio.account})` : `daemon session (${conflict.daemon.account})`}; applied at the next start`
        : `[Handover] ${conflict.label}: the user decides later; both sessions stay where they are, and Studio asks again after the next start`)
    } catch (err) {
      log(`[Handover] ${conflict.label}: the accounts question could not be shown or saved (${err instanceof Error ? err.message : String(err)}); asked again after the next start`)
    }
  }
}

/**
 * Once the main window is ready: the first-launch notice (else the handover
 * summary, without the deferred conflicts), then the deferred accounts
 * questions. Every dialog is parented to `window`.
 */
export async function showBootNotices(opts: {
  report: HandoverReport | null
  mode: StudioBackendMode
  notice: FirstLaunchNotice | null
  window: BrowserWindow
  userDataDir: string
  log?: Log
}): Promise<void> {
  const log = opts.log ?? defaultLog
  const { report, window } = opts
  if (opts.notice) {
    try {
      const { response } = await dialog.showMessageBox(window, firstLaunchNoticeOptions(opts.notice))
      if (response === 1) await shell.openExternal(UPGRADE_GUIDE_URL)
    } catch (err) {
      log(`[Backend] The first-launch notice could not be shown: ${err instanceof Error ? err.message : String(err)}`)
    }
    await askDeferredConflicts(report, window, opts.userDataDir, log)
    return
  }
  await askDeferredConflicts(report, window, opts.userDataDir, log)
  if (!report) return
  // The summary of the rest; a deferred conflict was just asked about, not reported as a failure.
  const items = report.items.filter((i) => !i.conflict)
  showHandoverSummary({
    ...report,
    items,
    changed: items.some((i) => i.outcome === 'moved' || i.outcome === 'written' || i.outcome === 'deleted'),
    failed: items.some((i) => i.outcome === 'failed' || i.pending === true),
  }, opts.mode, window)
}
