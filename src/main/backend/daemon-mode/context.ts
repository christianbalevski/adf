import type { IpcMainInvokeEvent } from 'electron'
import type { StudioBackendMode } from '../../../shared/types/backend.types'
import type { AgentSummary, DaemonClient } from '../../../shared/daemon-client'
import { DaemonError } from '../../../shared/daemon-client'
import type { MappedChannel } from '../channel-map'
import type { ApprovalsUi } from './approvals-ui'
import type { DaemonConnection } from './connection'
import type { EventBridge } from './event-bridge'
import type { DaemonModeSession } from './session'
import { samePath } from './session'
import type { ClientSettingsStore } from './settings'

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
  /** The client once connected and the session started; rejects when there is no daemon. */
  ready(): Promise<DaemonClient>
  /** The running agent at `filePath` (GET /agents), or null. */
  runningAgentAt(filePath: string): Promise<string | null>
  /** Records a recent file (menu Open Recent + OS list), in the client settings. */
  recordRecentFile(filePath: string): void
  hooks: { showMainWindow?: () => Electron.BrowserWindow | null; openFile?: (filePath: string) => void }
  log: Pick<Console, 'log' | 'warn' | 'error'>
}

export type DaemonInvokeHandler = (ctx: DaemonModeContext, event: IpcMainInvokeEvent, ...args: any[]) => unknown

export type DaemonHandlerTable = Partial<Record<MappedChannel, DaemonInvokeHandler>>

/** True for the daemon's 404 (unknown agent, unknown file). */
export function isNotFound(err: unknown): boolean {
  return err instanceof DaemonError && err.status === 404
}

/** GET /agents, then the agent whose file is `filePath`. */
export async function findRunningAgent(client: DaemonClient, filePath: string): Promise<string | null> {
  const agents = await client.request<AgentSummary[]>('GET', '/agents')
  return agents.find((a) => samePath(a.filePath, filePath))?.id ?? null
}

export const enc = encodeURIComponent
