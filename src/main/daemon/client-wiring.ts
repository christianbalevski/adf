// The daemon's client-session wiring (design daemon-backend.md D5), as the
// composition root (daemon/index.ts) builds it: the registry, every frame
// producer, open documents (W2-A) and the install-progress package services.
// One function, so tests build exactly what the daemon builds.

import type { AgentConfig } from '../../shared/types/adf-v02.types'
import type { NotificationsSnapshot } from '../../shared/types/ipc.types'
import type { RuntimeService } from '../runtime/runtime-service'
import type { UmbilicalEvent } from '../runtime/umbilical-bus'
import {
  ClientSessionRegistry,
  registerDaemonClientSessions,
  wireApprovalsToClientSessions,
  wireComputeToClientSessions,
  wireDocumentsToClientSessions,
  wireEventBusToClientSessions,
  wireMeshToClientSessions,
  wireRuntimeToClientSessions,
  wireTrackedDirWatcherToClientSessions,
  withInstallProgress,
  type ClientSessionRegistryOptions,
} from './client-sessions'

type Listener = (...args: any[]) => void
interface Emitter {
  on(event: string, listener: Listener): unknown
  off(event: string, listener: Listener): unknown
}
interface Installer { install(...args: any[]): Promise<unknown> }

export interface DaemonClientSessionDeps<Npm extends Installer, Py extends Installer, Adapter extends Installer, Sandbox extends Installer> {
  runtime: RuntimeService
  mesh: Emitter & { setConfigPersistedListener?(listener: ((filePath: string, config: AgentConfig) => void) | null): void }
  compute: Emitter
  approvals: { subscribe(listener: (snapshot: NotificationsSnapshot) => void): () => void }
  trackedDirWatcher: Emitter
  eventBus: { subscribe(listener: (envelope: { event: UmbilicalEvent }) => void): () => void }
  packages: { mcp: Npm; python: Py; adapters: Adapter; sandbox: Sandbox }
  /** Registry options (startedBy, requestShutdown; tests: expiryMs). */
  options: ClientSessionRegistryOptions
}

export interface DaemonClientSessions<Npm, Py, Adapter, Sandbox> {
  sessions: ClientSessionRegistry
  /** The admin install routes' package services: progress also goes to the client stream. */
  packages: { mcp: Npm; python: Py; adapters: Adapter; sandbox: Sandbox }
  /** Undo every wire (tests). */
  unwire(): void
}

export function createDaemonClientSessions<Npm extends Installer, Py extends Installer, Adapter extends Installer, Sandbox extends Installer>(
  deps: DaemonClientSessionDeps<Npm, Py, Adapter, Sandbox>,
): DaemonClientSessions<Npm, Py, Adapter, Sandbox> {
  const { runtime } = deps
  const sessions = new ClientSessionRegistry({
    resolveAgentId: (identifier) => runtime.getAgentOrDocument(identifier)?.id ?? null,
    ...deps.options,
  })
  const unwire = [
    wireRuntimeToClientSessions(sessions, runtime),
    // Session documents are W2-A's open documents, held by the session id;
    // the holder sweep asks the registry, so a live session's documents stay open.
    wireDocumentsToClientSessions(sessions, runtime),
    wireMeshToClientSessions(sessions, deps.mesh),
    wireComputeToClientSessions(sessions, deps.compute),
    wireApprovalsToClientSessions(sessions, deps.approvals),
    wireTrackedDirWatcherToClientSessions(sessions, deps.trackedDirWatcher as never),
    // Sessions opened with `umbilical: true` (the terminal app) get the /events envelopes too.
    wireEventBusToClientSessions(sessions, deps.eventBus),
  ]
  // The /client/* routes serve this registry (routes/client-routes.ts).
  registerDaemonClientSessions(sessions)
  return {
    sessions,
    // Agent-driven installs (the builder's resolvers) push nothing, as in Studio.
    packages: {
      mcp: withInstallProgress(deps.packages.mcp, 'mcp_install', 1, sessions),
      python: withInstallProgress(deps.packages.python, 'mcp_install', 2, sessions),
      adapters: withInstallProgress(deps.packages.adapters, 'adapter_install', 1, sessions),
      sandbox: withInstallProgress(deps.packages.sandbox, 'sandbox_install', 2, sessions),
    },
    unwire() {
      for (const fn of unwire) fn()
      registerDaemonClientSessions(null)
    },
  }
}
