/**
 * Linux spell-check dictionaries, downloaded only when the owner asks.
 *
 * Windows and macOS use the OS spell checker and download nothing. On Linux,
 * Electron's built-in Hunspell checker fetches any missing dictionary from
 * Google's CDN the first time a text field needs one. Until the owner clicks
 * Download in Settings → General → Privacy (`spellcheckDownloadsEnabled`),
 * the downloader points at a closed loopback port instead, so a missing
 * dictionary fails locally and nothing leaves the machine. Dictionaries
 * already on disk (userData) load either way.
 */

import { ipcMain, session } from 'electron'
import { IPC } from '../../shared/constants/ipc-channels'
import type { SpellcheckDownloadResult } from '../../shared/types/ipc.types'

/** Chromium's default Hunspell dictionary host (what Electron uses unset). */
const GOOGLE_DICTIONARY_URL = 'https://redirector.gvt1.com/edgedl/chrome/dict/'
/** Loopback discard port: the download fails without a network request. */
const BLOCKED_DICTIONARY_URL = 'http://127.0.0.1:9/'
const DOWNLOAD_TIMEOUT_MS = 60_000

export interface SpellcheckDictionaryHooks {
  isAllowed: () => boolean
  /** Persist the owner's opt-in so later launches may fetch new languages. */
  allow: () => void
}

/** Must run before the first window is created. */
export function initSpellcheckDictionaries(hooks: SpellcheckDictionaryHooks): void {
  const ses = session.defaultSession

  if (process.platform !== 'linux') {
    ipcMain.handle(IPC.SPELLCHECK_DOWNLOAD, (): SpellcheckDownloadResult => ({ outcome: 'unsupported' }))
    return
  }

  if (!hooks.isAllowed()) ses.setSpellCheckerDictionaryDownloadURL(BLOCKED_DICTIONARY_URL)

  let inFlight: Promise<SpellcheckDownloadResult> | null = null

  ipcMain.handle(IPC.SPELLCHECK_DOWNLOAD, () => {
    inFlight ??= download().finally(() => {
      inFlight = null
    })
    return inFlight
  })

  async function download(): Promise<SpellcheckDownloadResult> {
    hooks.allow()
    ses.setSpellCheckerDictionaryDownloadURL(GOOGLE_DICTIONARY_URL)

    const languages = ses.getSpellCheckerLanguages()
    if (languages.length === 0) {
      return { outcome: 'failed', message: 'No spell-check language is configured.' }
    }

    // A dictionary that failed while blocked is not retried on its own.
    // Changing the language list reloads every dictionary, which downloads
    // the missing ones; one already on disk just reports "initialized".
    const pending = new Set(languages)
    const failed: string[] = []
    let resolveSettled: () => void = () => {}
    const settled = new Promise<void>((r) => (resolveSettled = r))
    const done = (lang: string, ok: boolean): void => {
      if (!pending.delete(lang)) return
      if (!ok) failed.push(lang)
      if (pending.size === 0) resolveSettled()
    }
    const onOk = (_e: Electron.Event, lang: string): void => done(lang, true)
    const onFail = (_e: Electron.Event, lang: string): void => done(lang, false)
    ses.on('spellcheck-dictionary-initialized', onOk)
    ses.on('spellcheck-dictionary-download-success', onOk)
    ses.on('spellcheck-dictionary-download-failure', onFail)
    const timer = setTimeout(resolveSettled, DOWNLOAD_TIMEOUT_MS)

    try {
      ses.setSpellCheckerLanguages([])
      ses.setSpellCheckerLanguages(languages)
      await settled
    } finally {
      clearTimeout(timer)
      ses.off('spellcheck-dictionary-initialized', onOk)
      ses.off('spellcheck-dictionary-download-success', onOk)
      ses.off('spellcheck-dictionary-download-failure', onFail)
    }

    // Anything still pending timed out.
    failed.push(...pending)
    return failed.length === 0
      ? { outcome: 'downloaded', languages }
      : { outcome: 'failed', message: `Could not download: ${failed.join(', ')}` }
  }
}
