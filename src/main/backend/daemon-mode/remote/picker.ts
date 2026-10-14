import { randomUUID } from 'node:crypto'
import type { RemotePickAnswer, RemotePickKind, RemotePickRequest } from '../../../../shared/types/backend.types'

/**
 * The daemon-side picker (design §9.3, tracker W4-B). In remote mode a native
 * dialog would pick a path on this computer, which the daemon cannot open.
 * Instead Studio main asks the renderer (REMOTE_PICKER_REQUEST); its picker
 * dialog lists the daemon's folders through GET /fs/browse
 * (REMOTE_FS_BROWSE) and answers with a path on the daemon's machine
 * (REMOTE_PICKER_RESPOND). A pick resolves with that answer, or null when
 * the user cancels, the window goes away or nobody answers in time.
 *
 * Answers are checked for their kind's shape here; the daemon checks the
 * path itself on use (it must be inside its browse roots or tracked folders).
 */

export type { RemotePickAnswer, RemotePickKind, RemotePickRequest }

/** A pick nobody answers (renderer reloaded or crashed mid-pick) gives up after this long. */
export const PICK_TIMEOUT_MS = 30 * 60_000

const INVALID_FILENAME = /[<>:"/\\|?*\u0000-\u001f]/

export interface RemotePickerDeps {
  /** Send the request to the window that should show it; false when there is none. */
  send(request: RemotePickRequest): boolean
  /** The daemon's host, as dialogs name it. */
  host(): string
  log: Pick<Console, 'log' | 'warn'>
  timeoutMs?: number
}

interface Pending {
  kind: RemotePickKind
  resolve(answer: RemotePickAnswer | null): void
  timer: ReturnType<typeof setTimeout>
}

export class RemotePicker {
  private readonly pending = new Map<string, Pending>()

  constructor(private readonly deps: RemotePickerDeps) {}

  /** Ask for a pick. Resolves with the answer, or null (cancelled, no window, timed out). */
  pick(kind: RemotePickKind, title: string, opts: { defaultName?: string } = {}): Promise<RemotePickAnswer | null> {
    const requestId = randomUUID()
    const request: RemotePickRequest = { requestId, kind, title, host: this.deps.host(), ...(opts.defaultName ? { defaultName: opts.defaultName } : {}) }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(requestId)) return
        this.deps.log.warn(`[Remote] The picker "${title}" was not answered in ${Math.round((this.deps.timeoutMs ?? PICK_TIMEOUT_MS) / 60_000)} min; treated as cancelled`)
        resolve(null)
      }, this.deps.timeoutMs ?? PICK_TIMEOUT_MS)
      timer.unref?.()
      this.pending.set(requestId, { kind, resolve, timer })
      if (!this.deps.send(request)) {
        this.pending.delete(requestId)
        clearTimeout(timer)
        this.deps.log.warn(`[Remote] No window to show the picker "${title}"; treated as cancelled`)
        resolve(null)
      }
    })
  }

  /** The renderer's answer. False when no such pick is waiting or the answer has the wrong shape (the pick is then cancelled). */
  respond(requestId: unknown, answer: unknown): boolean {
    if (typeof requestId !== 'string') return false
    const entry = this.pending.get(requestId)
    if (!entry) return false
    this.pending.delete(requestId)
    clearTimeout(entry.timer)
    if (answer === null || answer === undefined) {
      entry.resolve(null)
      return true
    }
    const valid = validAnswer(entry.kind, answer)
    if (!valid) {
      this.deps.log.warn('[Remote] The picker answered with a value of the wrong shape; treated as cancelled')
      entry.resolve(null)
      return false
    }
    entry.resolve(valid)
    return true
  }

  /** Cancel every waiting pick (shutdown). */
  cancelAll(): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.resolve(null)
      this.pending.delete(id)
    }
  }

  get waiting(): number {
    return this.pending.size
  }
}

function validAnswer(kind: RemotePickKind, answer: unknown): RemotePickAnswer | null {
  if (!answer || typeof answer !== 'object') return null
  const a = answer as Record<string, unknown>
  const str = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && !v.includes('\0')
  if (kind === 'save-adf') {
    if (!str(a.directory) || !str(a.name)) return null
    const name = a.name.trim().replace(/\.adf$/i, '')
    if (!name || name.length > 64 || INVALID_FILENAME.test(name) || name.endsWith('.') || name.endsWith(' ')) return null
    return { directory: a.directory, name, ...(a.replace === true ? { replace: true } : {}) }
  }
  if (!str(a.path)) return null
  if (kind === 'open-adf' && !a.path.toLowerCase().endsWith('.adf')) return null
  return { path: a.path }
}
