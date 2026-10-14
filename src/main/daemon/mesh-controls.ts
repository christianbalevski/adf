// Mesh and mesh-server switches of the daemon (networkService in
// daemon/index.ts, routes /network/mesh/enable|disable and
// /network/server/start|stop|restart), apart from the composition root so
// they can be tested.
//
// Mesh off closes the agents' WebSocket connections, as Studio's
// MESH_DISABLE does: a disabled mesh must not keep peer connections open.
// Server start/stop persist meshServerEnabled by default (the CLI's choice
// survives a restart); `persist: false` is Studio's MESH_SERVER_START/STOP,
// which change the running server only, as embedded Studio does.

export interface MeshControlDeps {
  settings: { set(key: string, value: unknown): void }
  mesh: {
    isEnabled(): boolean
    enableMesh(): void
    disableMesh(): void
    getAgentStatuses(): unknown[]
  }
  server: {
    isRunning(): boolean
    getPort(): number
    getHost(): string
    start(): Promise<void>
    stop(): Promise<void>
  }
  ws: { stopAll(): void }
  /** Register every loaded agent with the (re-enabled) mesh. */
  registerLoaded(): void
  log?: Pick<Console, 'log'>
}

export interface ServerSwitchOptions {
  /** Default true: write meshServerEnabled. */
  persist?: boolean
}

export function createMeshControls(deps: MeshControlDeps) {
  const log = deps.log ?? console
  const serverState = () => ({ running: deps.server.isRunning(), port: deps.server.getPort(), host: deps.server.getHost() })
  return {
    enableMesh: () => {
      // Persist so an explicit enable survives restart (boot auto-enables
      // unless meshEnabled === false) — parity with Studio's MESH_ENABLE IPC.
      deps.settings.set('meshEnabled', true)
      if (!deps.mesh.isEnabled()) deps.mesh.enableMesh()
      deps.registerLoaded()
      return { success: true, meshEnabled: deps.mesh.isEnabled(), agents: deps.mesh.getAgentStatuses() }
    },
    disableMesh: () => {
      // Persist first: boot auto-enables mesh when meshEnabled !== false, so
      // without this a user's disable would not survive restart.
      deps.settings.set('meshEnabled', false)
      deps.ws.stopAll()
      log.log('[Mesh] Disabled on request: WebSocket connections closed')
      deps.mesh.disableMesh()
      return { success: true, meshEnabled: deps.mesh.isEnabled(), agents: deps.mesh.getAgentStatuses() }
    },
    startServer: async (opts: ServerSwitchOptions = {}) => {
      if (opts.persist !== false) deps.settings.set('meshServerEnabled', true)
      await deps.server.start()
      return { success: deps.server.isRunning(), ...serverState() }
    },
    stopServer: async (opts: ServerSwitchOptions = {}) => {
      if (opts.persist !== false) deps.settings.set('meshServerEnabled', false)
      await deps.server.stop()
      return { success: true, ...serverState() }
    },
    restartServer: async () => {
      await deps.server.stop()
      await deps.server.start()
      return { success: deps.server.isRunning(), ...serverState() }
    },
  }
}
