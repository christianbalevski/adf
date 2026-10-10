/**
 * The agent's surfaces as chips on their own line under the badges: its website
 * (opens in the browser) and its computer (opens the desktop tab). A chip
 * shows only when the agent has that surface; one that can't open right now
 * stays, muted, with the reason in its tooltip.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAgentStore } from '../../../stores/agent.store'
import { useDocumentStore } from '../../../stores/document.store'
import { useEditorTabsStore } from '../../../stores/editor-tabs.store'
import { Tooltip } from '../../common/Tooltip'

/** Every card-face chip (Public, Verified owner, Website, Computer) is this box, so they share one height. */
export const CHIP = 'inline-flex h-5 items-center gap-1 rounded border border-[var(--rule)] px-1.5 text-[11px] leading-none'
const CHIP_LIVE = `${CHIP} text-[var(--ink)] hover:border-[var(--ink-muted)] cursor-pointer`
const CHIP_MUTED = `${CHIP} text-[var(--ink-faint)] cursor-default`
/** Icon tint on a chip that opens: the accent blue, softened. Muted chips keep their grey. */
const ICON_LIVE = 'text-[var(--adf-ui-accent)] opacity-75'

export interface AgentSurfaces {
  website: { url: string | null; why: string } | null
  computer: { live: boolean; opening: boolean; open: () => void } | null
}

export function useAgentSurfaces(): AgentSurfaces {
  const filePath = useDocumentStore((s) => s.filePath)
  const config = useAgentStore((s) => s.config)
  const agentState = useAgentStore((s) => s.state)
  const agentOn = agentState !== 'off'

  const isServing = !!(
    config?.serving?.public?.enabled ||
    config?.serving?.shared?.enabled ||
    (config?.serving?.api && config.serving.api.length > 0)
  )
  const [mesh, setMesh] = useState<{ running: boolean; port: number; host: string } | null>(null)
  useEffect(() => {
    if (!isServing) return
    window.adfApi?.getMeshServerStatus().then((s) => setMesh(s ?? null)).catch(() => setMesh(null))
  }, [isServing, agentState])

  const servingUrl = useMemo(() => {
    if (!isServing || !mesh?.running) return null
    const handle = config?.handle || (filePath
      ? filePath
          .replace(/.*[\\/]/, '')
          .replace(/\.adf$/, '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
      : 'agent')
    const host = mesh.host === '0.0.0.0' ? '127.0.0.1' : mesh.host
    return `http://${host}:${mesh.port}/agents/${handle}/`
  }, [isServing, mesh, config?.handle, filePath])

  const hasComputer = !!config?.compute?.enabled && config.compute.browser !== false
  const [opening, setOpening] = useState(false)
  const open = useCallback(async () => {
    if (!agentOn || opening || !config || !filePath) return
    setOpening(true)
    try {
      const info = await window.adfApi?.getBrowserSessionInfo({ agentName: config.name, agentId: config.id })
      // The tab opens in every phase: a container that is provisioning,
      // stopped, or failed shows that instead of a blank viewer.
      if (info) {
        useEditorTabsStore.getState().openBrowserTab({
          agentFilePath: filePath,
          containerName: info.containerName,
          agentId: config.id,
          agentName: config.name,
          hostPort: info.hostPort,
          phase: info.phase,
          detail: info.detail,
        })
      }
    } catch { /* viewer is best-effort */ } finally {
      setOpening(false)
    }
  }, [agentOn, opening, config, filePath])

  return {
    website: isServing
      ? {
          url: agentOn ? servingUrl : null,
          why: !agentOn ? 'Opens while the agent is running.' : 'The mesh server is off. Turn it on in Settings › Networking.'
        }
      : null,
    computer: hasComputer ? { live: agentOn, opening, open } : null
  }
}

export function SurfaceChips({ surfaces }: { surfaces: AgentSurfaces }) {
  const { website, computer } = surfaces
  return (
    <>
      {website && (
        website.url ? (
          <Tooltip tip={`Open the agent's site in your browser.\n${website.url}`}>
            <a href={website.url} target="_blank" rel="noopener noreferrer" className={CHIP_LIVE}>
              <GlobeIcon className={ICON_LIVE} />Website
            </a>
          </Tooltip>
        ) : (
          <Tooltip tip={website.why}><span className={CHIP_MUTED}><GlobeIcon />Website</span></Tooltip>
        )
      )}
      {computer && (
        computer.live ? (
          <Tooltip tip="Open the agent's desktop in a tab.">
            <button type="button" onClick={computer.open} disabled={computer.opening} className={`${CHIP_LIVE} ${computer.opening ? 'animate-pulse' : ''}`}>
              <MonitorIcon className={ICON_LIVE} />Computer
            </button>
          </Tooltip>
        ) : (
          <Tooltip tip="Opens while the agent is running."><span className={CHIP_MUTED}><MonitorIcon />Computer</span></Tooltip>
        )
      )}
    </>
  )
}

function GlobeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  )
}

function MonitorIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  )
}
