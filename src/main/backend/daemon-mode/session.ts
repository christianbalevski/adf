import { resolve } from 'node:path'
import type { ClientSession } from './client-stream'
import { DaemonModeUnavailableError } from './errors'

/**
 * Studio's client state in daemon mode (design D3): what embedded mode keeps
 * in the module globals `currentFilePath`, `currentWorkspace`,
 * `derivedKeyCache` of ipc/index.ts. The daemon has no current file; it has
 * client sessions that hold documents and a focus (D5).
 *
 * - **Current file**: the path the renderer opened (FILE_OPEN) until
 *   FILE_CLOSE or the next FILE_OPEN. `agentId` is its agent in the daemon
 *   once known: the open document's id (W2-B hold) or the id of the running
 *   agent at that path.
 * - **Focus**: the current file's agent. The client stream carries text and
 *   thinking deltas for it only; the event bridge routes its frames to
 *   AGENT_EVENT and every other agent's to the background batch.
 * - **Derived-key cache**: embedded keeps the derived key of every
 *   password-protected file unlocked in this Studio run (`derivedKeyCache`),
 *   so switching back to a file does not prompt again. In daemon mode the key
 *   lives in the daemon (§5.4) for as long as the document stays open, so the
 *   session keeps holding each file it saw unlocked when the user switches
 *   away, and releases those holds when the session ends. A file the daemon
 *   reports locked again is dropped from the set, as embedded drops a stale
 *   key.
 */

export interface SessionFile {
  filePath: string
  agentId: string | null
  /** The session holds the file as an open document (W2-B). */
  held: boolean
}

type Log = Pick<Console, 'log' | 'warn'>

/** Canonical form for comparing paths: Windows and macOS file systems are case-insensitive. */
export function pathKey(filePath: string): string {
  const r = resolve(filePath)
  return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r
}

export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && pathKey(a) === pathKey(b)
}

export class DaemonModeSession {
  private file: SessionFile | null = null
  /** Files unlocked this session whose documents stay held: path key → agent id. */
  private readonly unlocked = new Map<string, string>()
  private focus: string | null = null
  private readonly focusListeners = new Set<(agentId: string | null) => void>()
  private holdUnavailableLogged = false

  constructor(private client: ClientSession | null, private readonly log: Log = console) {}

  /** The client session, once connected (the stream starts after the connector). */
  attach(client: ClientSession): void {
    this.client = client
    void this.pushFocus()
  }

  get filePath(): string | null {
    return this.file?.filePath ?? null
  }

  get agentId(): string | null {
    return this.file?.agentId ?? null
  }

  get current(): Readonly<SessionFile> | null {
    return this.file
  }

  get focusAgentId(): string | null {
    return this.focus
  }

  /** Whether a frame's agent is the focused one: by id, or by path before the id is known. */
  isFocused(agentId: string | null | undefined, filePath: string | null | undefined): boolean {
    if (!this.file) return false
    if (agentId && this.file.agentId) return agentId === this.file.agentId
    return samePath(filePath, this.file.filePath)
  }

  onFocusChange(listener: (agentId: string | null) => void): () => void {
    this.focusListeners.add(listener)
    return () => { this.focusListeners.delete(listener) }
  }

  /**
   * Make `filePath` the current file. The previous file's document is
   * released unless it is kept for its derived key. The new file is held as
   * an open document; until W2-B that refuses, and `resolveRunning` supplies
   * the id of an agent already running at that path.
   */
  async openFile(filePath: string, resolveRunning: (filePath: string) => Promise<string | null>): Promise<SessionFile> {
    await this.leaveCurrent()
    let agentId: string | null = null
    let held = false
    try {
      if (!this.client) throw new Error('no client session')
      agentId = (await this.client.holdDocument(filePath)).agentId
      held = true
    } catch (err) {
      if (!(err instanceof DaemonModeUnavailableError)) throw err
      if (!this.holdUnavailableLogged) {
        this.holdUnavailableLogged = true
        this.log.warn(`[Backend] ${err.message}. Files that are not running in the daemon open without their contents until then.`)
      }
      agentId = await resolveRunning(filePath)
    }
    this.file = { filePath, agentId, held }
    this.setFocus(agentId)
    return this.file
  }

  /** FILE_CLOSE. */
  async closeFile(): Promise<void> {
    await this.leaveCurrent()
    this.file = null
    this.setFocus(null)
  }

  /** The current file's agent became known (a start loaded it) or went away (null). */
  noteAgent(filePath: string, agentId: string | null): void {
    if (!this.file || !samePath(this.file.filePath, filePath)) return
    if (this.file.agentId === agentId) return
    this.file = { ...this.file, agentId }
    this.setFocus(agentId)
  }

  /** A file moved on disk (FILE_RENAMED). */
  rekey(oldPath: string, newPath: string): void {
    if (this.file && samePath(this.file.filePath, oldPath)) this.file = { ...this.file, filePath: newPath }
    const id = this.unlocked.get(pathKey(oldPath))
    if (id !== undefined) {
      this.unlocked.delete(pathKey(oldPath))
      this.unlocked.set(pathKey(newPath), id)
    }
  }

  /** The user unlocked `filePath` in this session (IDENTITY_PASSWORD_UNLOCK). */
  noteUnlocked(filePath: string, agentId: string): void {
    this.unlocked.set(pathKey(filePath), agentId)
  }

  /** The daemon reports `filePath` locked: forget it, as embedded drops a stale cached key. */
  forgetUnlocked(filePath: string): void {
    this.unlocked.delete(pathKey(filePath))
  }

  isUnlocked(filePath: string): boolean {
    return this.unlocked.has(pathKey(filePath))
  }

  /** Session end: release every document still held, kept ones included. */
  async releaseAll(): Promise<void> {
    const ids = new Set<string>(this.unlocked.values())
    if (this.file?.held && this.file.agentId) ids.add(this.file.agentId)
    this.unlocked.clear()
    this.file = null
    this.setFocus(null)
    for (const id of ids) await this.release(id)
  }

  private async leaveCurrent(): Promise<void> {
    const prev = this.file
    if (!prev?.held || !prev.agentId) return
    // Kept for its derived key (see the class comment).
    if (this.unlocked.has(pathKey(prev.filePath))) return
    await this.release(prev.agentId)
  }

  private async release(agentId: string): Promise<void> {
    try {
      await this.client?.releaseDocument(agentId)
    } catch (err) {
      this.log.warn(`[Backend] Could not release the open document ${agentId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private setFocus(agentId: string | null): void {
    if (this.focus === agentId) return
    this.focus = agentId
    for (const listener of this.focusListeners) {
      try { listener(agentId) } catch (err) { this.log.warn('[Backend] Focus listener failed:', err) }
    }
    void this.pushFocus()
  }

  private async pushFocus(): Promise<void> {
    try {
      await this.client?.setFocus(this.focus)
    } catch (err) {
      this.log.warn(`[Backend] Could not set the session focus: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
