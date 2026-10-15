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
  /** A start or stop on request (createMeshServerBinder.serverSwitched). */
  onServerSwitch?(state: 'started' | 'stopped'): void
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
      deps.onServerSwitch?.('started')
      await deps.server.start()
      return { success: deps.server.isRunning(), ...serverState() }
    },
    stopServer: async (opts: ServerSwitchOptions = {}) => {
      if (opts.persist !== false) deps.settings.set('meshServerEnabled', false)
      deps.onServerSwitch?.('stopped')
      await deps.server.stop()
      return { success: true, ...serverState() }
    },
    restartServer: async () => {
      deps.onServerSwitch?.('started')
      await deps.server.stop()
      await deps.server.start()
      return { success: deps.server.isRunning(), ...serverState() }
    },
  }
}

export interface MeshServerBinderDeps {
  settings: { get(key: string): unknown }
  mesh: { hasAnyReachableAgent(): boolean; hasAgentOfTier(tier: 'lan' | 'public'): boolean }
  server: { isRunning(): boolean; getHost(): string; start(): Promise<void>; stop(): Promise<void> }
  /** Default 500 ms. */
  debounceMs?: number
  log?: Pick<Console, 'log' | 'error'>
}

/**
 * When the daemon (re)binds its mesh server (daemon/index.ts). The server
 * serves agent web/API routes and mesh delivery and is on by default (Studio
 * parity); MeshServer.start() skips while no reachable agent is registered,
 * so `ensure()` runs as agents register.
 *
 * - First bind: at once outside autostart. Until it lands the mesh names the
 *   default port 7295 in reply_to, return_path and cards, so a message sent
 *   in that window could reach another runtime on 7295 (Studio binds at
 *   boot). During autostart (`autostartSettling(true)`) it waits for the
 *   burst to settle, so the host (loopback vs LAN) is decided once and the
 *   server is not bound to loopback and then rebound to 0.0.0.0.
 * - Later checks are debounced; a LAN/public agent arriving while bound to
 *   loopback rebinds to all interfaces.
 * - A stop on request (POST /network/server/stop, Studio's MESH_SERVER_STOP
 *   with persist=0) holds for this daemon run: registrations do not restart
 *   it; a start on request clears it.
 */
export function createMeshServerBinder(deps: MeshServerBinderDeps) {
  const log = deps.log ?? console
  const debounceMs = deps.debounceMs ?? 500
  let timer: ReturnType<typeof setTimeout> | null = null
  let firstStart: Promise<void> | null = null
  let settling = false
  let stoppedOnRequest = false

  const blocked = () => deps.settings.get('meshServerEnabled') === false || stoppedOnRequest
  const ensure = (): void => {
    if (blocked()) {
      if (timer) { clearTimeout(timer); timer = null }
      return
    }
    if (!settling && !deps.server.isRunning() && !firstStart && deps.mesh.hasAnyReachableAgent()) {
      firstStart = deps.server.start()
        .catch(err => log.error('[MeshServer] Failed to start:', err))
        .finally(() => { firstStart = null })
    }
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      if (settling || blocked()) return
      if (firstStart) { ensure(); return }
      const wantsLan = !process.env.MESH_HOST && (deps.mesh.hasAgentOfTier('lan') || deps.mesh.hasAgentOfTier('public'))
      const rebind = deps.server.isRunning() && wantsLan && deps.server.getHost() === '127.0.0.1'
      if (deps.server.isRunning() && !rebind) return
      const run = rebind ? deps.server.stop().then(() => deps.server.start()) : deps.server.start()
      run.catch(err => log.error('[MeshServer] Failed to start:', err))
    }, debounceMs)
    timer.unref?.()
  }

  return {
    ensure,
    /** Autostart running (true) or settled (false: binds now if agents registered meanwhile). */
    autostartSettling(value: boolean): void {
      settling = value
      if (!value) ensure()
    },
    /** A stop or start on request (mesh-controls `onServerSwitch`). */
    serverSwitched(state: 'started' | 'stopped'): void {
      stoppedOnRequest = state === 'stopped'
      if (stoppedOnRequest) {
        if (timer) { clearTimeout(timer); timer = null }
        log.log('[MeshServer] Stopped on request: agent registrations do not restart it until it is started again')
      }
    },
    get stoppedOnRequest(): boolean { return stoppedOnRequest },
    dispose(): void { if (timer) clearTimeout(timer); timer = null },
  }
}
