import { create } from 'zustand'

/** A start, stop or folder action that failed, shown until it is dismissed. */
export interface FailureNotice {
  id: string
  text: string
}

/** At most this many on screen; the oldest goes first. */
export const MAX_FAILURE_NOTICES = 3

interface FailureNoticesState {
  notices: FailureNotice[]
  push: (text: string) => void
  dismiss: (id: string) => void
}

let nextId = 0

export const useFailureNoticesStore = create<FailureNoticesState>((set) => ({
  notices: [],
  push: (text) =>
    set((s) => {
      // The same failure twice in a row (a batch, a double click) is one notice.
      const rest = s.notices.filter((n) => n.text !== text)
      return { notices: [...rest, { id: `failure-${++nextId}`, text }].slice(-MAX_FAILURE_NOTICES) }
    }),
  dismiss: (id) => set((s) => ({ notices: s.notices.filter((n) => n.id !== id) })),
}))

/** The reason in an IPC rejection, without Electron's "Error invoking remote method" wrapper. */
export function failureReason(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : err == null ? '' : String(err)
  return raw.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^Error:\s*/, '').trim()
}

/** An agent's display name from its file path: the file name without `.adf`. */
export function agentNameOf(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? filePath
  return base.replace(/\.adf$/i, '')
}

/**
 * Show a failure: "`what`: reason", or `what` alone when there is no reason.
 * Also logged, so the console keeps the full error.
 */
export function reportFailure(what: string, err?: unknown): void {
  const reason = err === undefined ? '' : failureReason(err)
  console.warn(`[failure] ${what}${reason ? `: ${reason}` : ''}`, err ?? '')
  useFailureNoticesStore.getState().push(reason ? `${what}: ${reason}` : what)
}
