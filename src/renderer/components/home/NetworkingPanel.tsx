import { useEffect, useState } from 'react'
import { useAppStore } from '../../stores/app.store'
import { useMeshStore } from '../../stores/mesh.store'
import { DashboardTile, type TileStatus } from './DashboardTile'

interface MeshServerStatus {
  running: boolean
  port: number
  host: string
}

interface DiscoveredRuntime {
  runtime_id: string
  source?: 'mdns' | 'tailnet' | 'manual'
}

/**
 * Compact networking section shown below the main dashboard grid.
 * Surfaces the moving parts of the local-network/mesh stack so the user can
 * tell at a glance whether the runtime is reachable from peers.
 *
 * Data sources:
 *  - Mesh server status (`getMeshServerStatus`) — refreshed on a short
 *    interval since podman/process bring-up can take a moment after launch.
 *  - LAN exposure and tailnet discovery toggles from settings.
 *  - Discovered runtimes, split by mDNS and tailnet source.
 *
 * Clicking any tile opens Settings → Networking.
 */
export function NetworkingPanel() {
  const openSettingsAt = useAppStore((s) => s.openSettingsAt)
  const meshEnabled = useMeshStore((s) => s.enabled)
  const [serverStatus, setServerStatus] = useState<MeshServerStatus | null>(null)
  const [lanDiscovery, setLanDiscovery] = useState<boolean | null>(null)
  const [tailnetDiscovery, setTailnetDiscovery] = useState<boolean | null>(null)
  const [lanPeerCount, setLanPeerCount] = useState<number | null>(null)
  const [tailnetPeerCount, setTailnetPeerCount] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    const fetchAll = async () => {
      try {
        const [status, settings, peers] = await Promise.all([
          window.adfApi?.getMeshServerStatus(),
          window.adfApi?.getSettings(),
          window.adfApi?.getDiscoveredRuntimes(),
        ])
        if (cancelled) return
        if (status) setServerStatus(status)
        if (settings) {
          setLanDiscovery(!!settings.meshLan)
          setTailnetDiscovery(settings.tailnetDiscovery !== false)
        }
        if (peers) {
          const discovered = peers as DiscoveredRuntime[]
          setLanPeerCount(discovered.filter((peer) => (peer.source ?? 'mdns') === 'mdns').length)
          setTailnetPeerCount(discovered.filter((peer) => peer.source === 'tailnet').length)
        }
      } catch {
        // Leave previous values; tile renders "—" until something resolves.
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void fetchAll()
    // Re-poll every 4s — mesh server may start after the app and we want
    // the panel to reflect that without a manual refresh.
    const interval = setInterval(() => { void fetchAll() }, 4000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  const serverRunning = serverStatus?.running ?? false
  const serverStatusDot: TileStatus = !serverStatus
    ? 'idle'
    : !meshEnabled ? 'idle'
    : serverStatus.running ? 'ok' : 'warn'

  return (
    <div className="w-full max-w-3xl px-4 mt-2">
      <h3 className="mb-2 text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400 font-medium">
        Networking
      </h3>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <DashboardTile
          icon="🌐"
          label="Mesh"
          value={meshEnabled ? 'Enabled' : 'Disabled'}
          subValue={
            serverStatus
              ? `Port ${serverStatus.port} · ${serverStatus.running ? 'listening' : 'stopped'}`
              : ''
          }
          status={serverStatusDot}
          loading={loading && !serverStatus}
          onClick={() => openSettingsAt('networking')}
        />
        <DashboardTile
          icon="🛰"
          label="LAN Discovery"
          value={lanDiscovery === null ? '' : lanDiscovery ? 'On' : 'Off'}
          subValue={lanDiscovery ? 'Announcing via mDNS' : 'Local only'}
          status={lanDiscovery ? 'ok' : 'idle'}
          loading={loading && lanDiscovery === null}
          onClick={() => openSettingsAt('networking')}
        />
        <DashboardTile
          icon="📍"
          label="LAN Peers"
          value={lanPeerCount ?? 0}
          subValue={
            lanPeerCount === null ? ''
            : lanPeerCount === 0 ? 'No runtimes seen'
            : lanPeerCount === 1 ? 'runtime discovered'
            : 'runtimes discovered'
          }
          status={(lanPeerCount ?? 0) > 0 ? 'ok' : 'idle'}
          loading={loading && lanPeerCount === null}
          onClick={() => openSettingsAt('networking')}
        />
        <DashboardTile
          icon="🔷"
          label="Tailnet"
          value={tailnetDiscovery === null ? '' : tailnetDiscovery ? 'On' : 'Off'}
          subValue={
            tailnetPeerCount === null ? ''
            : tailnetPeerCount === 0 ? 'No peers discovered'
            : `${tailnetPeerCount} ${tailnetPeerCount === 1 ? 'peer' : 'peers'} discovered`
          }
          status={tailnetDiscovery ? 'ok' : 'idle'}
          loading={loading && (tailnetDiscovery === null || tailnetPeerCount === null)}
          onClick={() => openSettingsAt('networking')}
        />
      </div>
      {/* Subtle hint when mesh is on but server isn't running yet (boot race). */}
      {meshEnabled && serverStatus && !serverRunning && (
        <p className="mt-2 text-xs text-yellow-600 dark:text-yellow-500">
          Mesh is enabled but the server isn't listening yet — it may still be starting.
        </p>
      )}
    </div>
  )
}
