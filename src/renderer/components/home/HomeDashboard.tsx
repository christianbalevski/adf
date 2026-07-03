import { useMemo } from 'react'
import { useAppStore } from '../../stores/app.store'
import { useBackgroundAgentsStore } from '../../stores/background-agents.store'
import { DashboardTile, type TileStatus } from './DashboardTile'
import { useDashboardData } from './useDashboardData'
import { GettingStarted } from './GettingStarted'

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/**
 * Compact dashboard tile grid shown on the home screen when no .adf is open.
 *
 * Each tile is driven by its own data slice and renders a loading skeleton
 * independently. The slowest slice (typically the .adf peek scan or the
 * podman probe at cold-start) no longer blocks the rest of the grid.
 *
 * Live composition:
 *  - Mesh on/off comes from the live mesh store.
 *  - "Agents running" comes from the global background-agents store so the
 *    count updates as agents start/stop without re-fetching.
 *
 * Clicking most tiles deep-links into the matching Settings tab via
 * `useAppStore.openSettingsAt`.
 */
export function HomeDashboard() {
  const { quick, providerTests, containers, agentStats, loading, refresh } = useDashboardData()
  const openSettingsAt = useAppStore((s) => s.openSettingsAt)
  const backgroundAgents = useBackgroundAgentsStore((s) => s.agents)

  // "Running" = anywhere the runtime considers the agent loaded and live.
  // `off` and `not_participating` are the only states that mean "not running".
  const runningCount = useMemo(
    () => backgroundAgents.filter((a) => a.state !== 'off' && a.state !== 'not_participating').length,
    [backgroundAgents]
  )

  // --- Providers ---
  // Need both quick stats (total) and provider tests (ok/failed/unconfigured).
  // Loading until BOTH slices land.
  const providersLoading = loading.quick || loading.providerTests
  const providerStatus: TileStatus = !quick || !providerTests
    ? 'idle'
    : quick.providers.total === 0
      ? 'idle'
      : providerTests.failed > 0
        ? 'warn'
        : providerTests.ok === quick.providers.total
          ? 'ok'
          : 'warn'
  const providerValue = quick && providerTests
    ? quick.providers.total === 0 ? '0' : `${providerTests.ok}/${quick.providers.total}`
    : ''
  const providerSub = quick && providerTests
    ? quick.providers.total === 0
      ? 'Add a provider'
      : providerTests.failed > 0
        ? `${providerTests.failed} failed`
        : providerTests.unconfigured > 0
          ? `${providerTests.unconfigured} unconfigured`
          : 'All connected'
    : ''

  // --- Tokens ---
  const todayTotal = quick ? quick.tokens.today.input + quick.tokens.today.output : 0
  const allTimeTotal = quick ? quick.tokens.allTime.input + quick.tokens.allTime.output : 0
  const tokenSub = quick
    ? quick.tokens.topModel
      ? `${formatTokens(allTimeTotal)} all-time · ${quick.tokens.topModel.model}`
      : `${formatTokens(allTimeTotal)} all-time`
    : ''

  // --- Host Access ---
  // Global toggle comes from quick; per-agent count from agentStats.
  const hostAccessLoading = loading.quick || loading.agentStats
  const hostAccessGlobal = quick?.hostAccess.enabledGlobally ?? false
  const hostAccessAgents = agentStats?.hostAccessAgents ?? 0
  const hostAccessStatus: TileStatus = hostAccessGlobal
    ? hostAccessAgents > 0 ? 'warn' : 'ok'
    : 'idle'

  return (
    <>
      <GettingStarted
        quick={quick}
        providerTests={providerTests}
        agentStats={agentStats}
      />

      <div className="w-full max-w-3xl px-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400 font-medium">
          Status
        </h3>
        <button
          onClick={() => refresh()}
          disabled={loading.any}
          title="Refresh"
          className="text-xs text-neutral-500 hover:text-blue-500 disabled:opacity-50"
        >
          {loading.any ? '…' : '↻'}
        </button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
        {/* Row 1 — provider stack */}
        <DashboardTile
          icon="🤖"
          label="Providers"
          value={providerValue}
          subValue={providerSub}
          status={providerStatus}
          loading={providersLoading}
          onClick={() => openSettingsAt('providers')}
        />
        <DashboardTile
          icon="🔌"
          label="MCP Servers"
          value={quick?.mcp.configured ?? 0}
          subValue={quick && quick.mcp.configured === 0 ? 'None installed' : 'configured'}
          status={(quick?.mcp.configured ?? 0) > 0 ? 'ok' : 'idle'}
          loading={loading.quick}
          onClick={() => openSettingsAt('mcps')}
        />
        <DashboardTile
          icon="📡"
          label="Channels"
          value={quick?.adapters.configured ?? 0}
          subValue={
            quick && quick.adapters.types.length > 0
              ? quick.adapters.types.join(' · ')
              : 'None'
          }
          status={(quick?.adapters.configured ?? 0) > 0 ? 'ok' : 'idle'}
          loading={loading.quick}
          onClick={() => openSettingsAt('channels')}
        />
        <DashboardTile
          icon="📦"
          label="Packages"
          value={quick?.packages.total ?? 0}
          subValue={
            quick && quick.packages.total === 0 ? 'None installed' : 'sandbox total'
          }
          status={(quick?.packages.total ?? 0) > 0 ? 'ok' : 'idle'}
          loading={loading.quick}
          onClick={() => openSettingsAt('packages')}
        />

        {/* Row 2 — compute + mesh */}
        <DashboardTile
          icon="🐳"
          label="Containers"
          value={
            !containers
              ? ''
              : containers.total === 0 ? '0' : `${containers.running}/${containers.total}`
          }
          subValue={containers ? (containers.total === 0 ? 'None' : 'running') : ''}
          status={
            !containers ? 'idle'
            : containers.total === 0 ? 'idle'
            : containers.running > 0 ? 'ok'
            : 'warn'
          }
          loading={loading.containers}
          onClick={() => openSettingsAt('compute')}
        />
        <DashboardTile
          icon="🔓"
          label="Host Access"
          value={hostAccessLoading ? '' : hostAccessGlobal ? 'On' : 'Off'}
          subValue={
            hostAccessLoading
              ? ''
              : hostAccessAgents > 0
                ? `${hostAccessAgents} agent${hostAccessAgents === 1 ? '' : 's'}`
                : 'No agents'
          }
          status={hostAccessStatus}
          loading={hostAccessLoading}
          onClick={() => openSettingsAt('compute')}
        />
        <DashboardTile
          icon="👥"
          label="Agents"
          value={agentStats?.total ?? 0}
          subValue={
            agentStats
              ? agentStats.total === 0 ? 'No tracked .adfs' : 'across tracked dirs'
              : ''
          }
          status={(agentStats?.total ?? 0) > 0 ? 'ok' : 'idle'}
          loading={loading.agentStats}
        />

        {/* Row 3 — agent activity + tokens */}
        <DashboardTile
          icon="▶"
          label="Running"
          value={runningCount}
          subValue={runningCount === 0 ? 'None active' : 'in background'}
          status={runningCount > 0 ? 'ok' : 'idle'}
        />
        <DashboardTile
          icon="⚡"
          label="Auto-start"
          value={agentStats?.autostart ?? 0}
          subValue={agentStats ? `${agentStats.autonomous} autonomous` : ''}
          status={(agentStats?.autostart ?? 0) > 0 ? 'ok' : 'idle'}
          loading={loading.agentStats}
        />
        <DashboardTile
          icon="💬"
          label="Tokens today"
          value={formatTokens(todayTotal)}
          subValue={tokenSub}
          status={todayTotal > 0 ? 'ok' : 'idle'}
          loading={loading.quick}
        />
      </div>
      </div>
    </>
  )
}
