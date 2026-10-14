import type { IpcMainInvokeEvent } from 'electron'
import type { StudioBackendMode } from '../../../shared/types/backend.types'
import type { DaemonClient } from '../../../shared/daemon-client'
import { DaemonError } from '../../../shared/daemon-client'
import type { MappedChannel } from '../channel-map'
import type { ApprovalsUi } from './approvals-ui'
import type { DaemonConnection } from './connection'
import type { EventBridge } from './event-bridge'
import type { SharedMnemonicStore } from '../../services/owner-secret-store'
import type { DaemonModeSession } from './session'
import type { ClientSettingsStore } from './settings'
import type { InstallProgressRelay } from './mcp/install-progress'

/**
 * What every daemon-mode handler gets. Handlers hold no state of their own:
 * client state is in `session` (D3), settings in `clientSettings` and the
 * daemon (§4.2), everything else in the daemon.
 */
export interface DaemonModeContext {
  mode: Exclude<StudioBackendMode, 'embedded'>
  connection: DaemonConnection
  session: DaemonModeSession
  bridge: EventBridge
  clientSettings: ClientSettingsStore
  approvals: ApprovalsUi
  /** Install progress pushes the client stream cannot deliver (W3-C, mcp/install-progress.ts). */
  installs: InstallProgressRelay
  /** The client once connected and the session started; rejects when there is no daemon. */
  ready(): Promise<DaemonClient>
  /** The running agent at `filePath` (GET /files/agent), or null. */
  runningAgentAt(filePath: string): Promise<string | null>
  /** A raw (non-JSON) request to the daemon: the token is added for its origin only. */
  raw(path: string, query?: Record<string, string | number | undefined>): Promise<Response>
  /** The owner-phrase entry Studio and the daemon share in the OS keychain (§5.4), or null when no keychain is usable. */
  sharedMnemonic(): SharedMnemonicStore | null
  /** Records a recent file (menu Open Recent + OS list), in the client settings. */
  recordRecentFile(filePath: string): void
  hooks: { showMainWindow?: () => Electron.BrowserWindow | null; openFile?: (filePath: string) => void }
  /**
   * Local mode, after an owner import in the daemon (§5.3.1): rewrite the
   * `studio-runtime:<scope>` entry with a delegation the new owner signs
   * (handover.ts syncStudioRuntimeEntry). Returns a line for the log.
   */
  afterOwnerImport?: (phrase: string) => Promise<string>
  log: Pick<Console, 'log' | 'warn' | 'error'>
}

export type DaemonInvokeHandler = (ctx: DaemonModeContext, event: IpcMainInvokeEvent, ...args: any[]) => unknown

export type DaemonHandlerTable = Partial<Record<MappedChannel, DaemonInvokeHandler>>

/** A `send` channel's handler (renderer `ipcRenderer.send`): no answer. */
export type DaemonSendHandler = (ctx: DaemonModeContext, event: Electron.IpcMainEvent, ...args: any[]) => void

export type DaemonSendHandlerTable = Partial<Record<MappedChannel, DaemonSendHandler>>

/** True for the daemon's 404 (unknown agent, unknown file). */
export function isNotFound(err: unknown): boolean {
  return err instanceof DaemonError && err.status === 404
}

/** The agent running at `filePath`: GET /files/agent (W1-E, the daemon's own path → id rule), else null. */
export async function findRunningAgent(client: DaemonClient, filePath: string): Promise<string | null> {
  try {
    const info = await client.request<{ agentId: string | null; loaded: boolean }>('GET', '/files/agent', { query: { path: filePath } })
    return info.loaded ? info.agentId : null
  } catch (err) {
    if (err instanceof DaemonError && (err.status === 404 || err.status === 400)) return null
    throw err
  }
}

export const enc = encodeURIComponent
