/**
 * One save model for Settings (docs/guides/settings.md, "Saving"): a control
 * writes its value as soon as it changes, except a dialog that creates
 * something. A write that lands shows a quiet "Saved" in the page header; a
 * refused write puts the control back and shows a toast that stays until it
 * is dismissed: "Not saved: <reason>". Removals that can be taken back show an
 * Undo toast instead of a confirmation.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { saveErrorMessage } from '../providers/provider-save'
import { UndoToast } from '../agent/config-panel-parts'

export type SettingsWriteOutcome = { ok: true } | { ok: false; error: string }

/** What a setSettings answer means: `{ success: false }` and a rejection are both refusals. */
export function settingsWriteOutcome(result: unknown): SettingsWriteOutcome {
  if (result && typeof result === 'object' && (result as { success?: unknown }).success === false) {
    const error = (result as { error?: unknown }).error
    return { ok: false, error: typeof error === 'string' && error ? error : 'The settings could not be saved.' }
  }
  return { ok: true }
}

/** The toast text for a refused write. */
export function notSavedMessage(reason: string): string {
  return `Not saved: ${reason}`
}

/**
 * Write a settings patch through the preload bridge. Reached through
 * `globalThis` because the web tsconfig does not include the preload's Window
 * augmentation (same accessor pattern as approvals.store.ts).
 */
export async function writeSettings(patch: Record<string, unknown>): Promise<SettingsWriteOutcome> {
  const api = (globalThis as { adfApi?: { setSettings?: (patch: Record<string, unknown>) => Promise<unknown> } }).adfApi
  if (!api?.setSettings) return { ok: false, error: 'Studio is not connected.' }
  try {
    return settingsWriteOutcome(await api.setSettings(patch))
  } catch (err) {
    return { ok: false, error: saveErrorMessage(err) }
  }
}

export interface SettingsToast {
  id: number
  kind: 'error' | 'undo'
  message: string
  onUndo?: () => void
}

export interface SettingsSaveApi {
  /** Write `patch`. On refusal: `rollback()` and a "Not saved" toast. Resolves true once saved. */
  commit: (patch: Record<string, unknown>, rollback?: () => void) => Promise<boolean>
  /** Report a write made another way (the providers list, a backend setting): its outcome drives the header and toasts. */
  track: (write: Promise<SettingsWriteOutcome>, rollback?: () => void) => Promise<boolean>
  /** A removal that can be taken back: an Undo toast. */
  offerUndo: (message: string, onUndo: () => void) => void
}

const fallback: SettingsSaveApi = {
  commit: async (patch, rollback) => {
    const outcome = await writeSettings(patch)
    if (!outcome.ok) rollback?.()
    return outcome.ok
  },
  track: async (write, rollback) => {
    const outcome = await write
    if (!outcome.ok) rollback?.()
    return outcome.ok
  },
  offerUndo: () => {},
}

const SaveContext = createContext<SettingsSaveApi>(fallback)
const StatusContext = createContext<{ saved: boolean; toasts: SettingsToast[]; dismiss: (id: number) => void }>({ saved: false, toasts: [], dismiss: () => {} })

/** How long "Saved" stays before it fades, and how long an Undo is offered. */
const SAVED_MS = 2000
const UNDO_MS = 10_000

export function SettingsSaveProvider({ children }: { children: React.ReactNode }) {
  const [saved, setSaved] = useState(false)
  const [toasts, setToasts] = useState<SettingsToast[]>([])
  const inFlight = useRef(0)
  const nextId = useRef(1)
  const fade = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())

  useEffect(() => () => {
    clearTimeout(fade.current)
    for (const timer of timers.current.values()) clearTimeout(timer)
  }, [])

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id)
    if (timer) clearTimeout(timer)
    timers.current.delete(id)
    setToasts((list) => list.filter((t) => t.id !== id))
  }, [])

  const push = useCallback((toast: Omit<SettingsToast, 'id'>) => {
    const id = nextId.current++
    // The same refusal twice is one toast.
    setToasts((list) => [...list.filter((t) => !(t.kind === toast.kind && t.message === toast.message)), { ...toast, id }].slice(-4))
    if (toast.kind === 'undo') timers.current.set(id, setTimeout(() => dismiss(id), UNDO_MS))
  }, [dismiss])

  const track = useCallback(async (write: Promise<SettingsWriteOutcome>, rollback?: () => void) => {
    inFlight.current++
    setSaved(false)
    let outcome: SettingsWriteOutcome
    try {
      outcome = await write
    } catch (err) {
      outcome = { ok: false, error: saveErrorMessage(err) }
    } finally {
      inFlight.current--
    }
    if (!outcome.ok) {
      rollback?.()
      push({ kind: 'error', message: notSavedMessage(outcome.error) })
      return false
    }
    if (inFlight.current === 0) {
      setSaved(true)
      clearTimeout(fade.current)
      fade.current = setTimeout(() => setSaved(false), SAVED_MS)
    }
    return true
  }, [push])

  const commit = useCallback((patch: Record<string, unknown>, rollback?: () => void) => track(writeSettings(patch), rollback), [track])
  const offerUndo = useCallback((message: string, onUndo: () => void) => push({ kind: 'undo', message, onUndo }), [push])

  const api = useMemo(() => ({ commit, track, offerUndo }), [commit, track, offerUndo])
  const status = useMemo(() => ({ saved, toasts, dismiss }), [saved, toasts, dismiss])
  return (
    <SaveContext.Provider value={api}>
      <StatusContext.Provider value={status}>{children}</StatusContext.Provider>
    </SaveContext.Provider>
  )
}

export function useSettingsSave(): SettingsSaveApi {
  return useContext(SaveContext)
}

/** The page header's "Saved": fades in after a write lands, then out. */
export function SaveIndicator() {
  const { saved } = useContext(StatusContext)
  return (
    <span
      role="status"
      aria-live="polite"
      className={`text-[12px] text-[var(--adf-ui-text-subtle)] transition-opacity duration-300 ${saved ? 'opacity-100' : 'opacity-0'}`}
    >
      {saved ? 'Saved' : ''}
    </span>
  )
}

/** Refusals (they stay until dismissed) and Undo offers, bottom of the page. */
export function SettingsToasts() {
  const { toasts, dismiss } = useContext(StatusContext)
  if (toasts.length === 0) return null
  return (
    <div className="pointer-events-none fixed bottom-10 right-6 z-40 flex w-[min(420px,calc(100vw-3rem))] flex-col gap-2">
      {toasts.map((t) => t.kind === 'undo' ? (
        <div key={t.id} className="pointer-events-auto">
          <UndoToast message={t.message} onUndo={() => { dismiss(t.id); t.onUndo?.() }} onDismiss={() => dismiss(t.id)} />
        </div>
      ) : (
        // A refusal: UndoToast's look, in the danger tone, with no Undo; it stays until dismissed.
        <div
          key={t.id}
          role="alert"
          className="pointer-events-auto mx-3 flex items-center gap-2 rounded-lg border border-[var(--adf-ui-danger)]/40 bg-surface-0 px-3 py-2 text-xs text-[var(--adf-ui-danger)] shadow-lg"
        >
          <span className="min-w-0 flex-1 break-words">{t.message}</span>
          <button type="button" onClick={() => dismiss(t.id)} aria-label="Dismiss" className="shrink-0 text-[var(--adf-ui-text-subtle)] hover:text-neutral-600 dark:hover:text-neutral-200">&times;</button>
        </div>
      ))}
    </div>
  )
}
