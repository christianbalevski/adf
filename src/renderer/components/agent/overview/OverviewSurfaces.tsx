/**
 * The card face's surfaces line: the agent's website and its computer, as
 * literal links ("Website ↗ · Computer"). One 18 px line, absent when the
 * agent has neither. A surface that can't open right now stays on the line,
 * muted, with the reason in its tooltip.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAgentStore } from '../../../stores/agent.store'
import { useDocumentStore } from '../../../stores/document.store'
import { useEditorTabsStore } from '../../../stores/editor-tabs.store'
import { Tooltip } from '../../common/Tooltip'

const LINK = 'text-[var(--ink)] underline decoration-[var(--ink-faint)] underline-offset-2 hover:decoration-[var(--ink)]'
const MUTED = 'text-[var(--ink-faint)] cursor-default'

export function OverviewSurfaces() {
  const filePath = useDocumentStore((s) => s.filePath)
  const config = useAgentStore((s) => s.config)
  const agentState = useAgentStore((s) => s.state)
  const agentOn = agentState !== 'off'

  const isServing = !!(
    config?.serving?.public?.enabled ||
    config?.serving?.shared?.enabled ||
    (config?.serving?.api && config.serving.api.length > 0)
  )
  const [mesh, setMesh] = useState<{ running: boolean; port: number; host: string }>({ running: false, port: 7295, host: '127.0.0.1' })
  useEffect(() => {
    if (isServing) window.adfApi?.getMeshServerStatus().then(setMesh)
  }, [isServing, agentState])

  const servingUrl = useMemo(() => {
    if (!isServing || !mesh.running) return null
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
  const openComputer = useCallback(async () => {
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

  if (!isServing && !hasComputer) return null

  const websiteLive = agentOn && servingUrl !== null
  const websiteWhy = !agentOn ? 'Opens while the agent is running.' : 'The mesh server is off. Turn it on in Settings › Networking.'

  return (
    <p className="mt-0.5 text-[12px] leading-[18px]">
      {isServing && (
        websiteLive ? (
          <Tooltip tip={servingUrl!}>
            <a href={servingUrl!} target="_blank" rel="noopener noreferrer" className={LINK}>Website ↗</a>
          </Tooltip>
        ) : (
          <Tooltip tip={websiteWhy}><span className={MUTED}>Website</span></Tooltip>
        )
      )}
      {isServing && hasComputer && <span className="text-[var(--ink-muted)]"> · </span>}
      {hasComputer && (
        agentOn ? (
          <Tooltip tip="Open the agent's desktop in a tab.">
            <button type="button" onClick={openComputer} disabled={opening} className={`${LINK} ${opening ? 'animate-pulse' : ''}`}>
              Computer
            </button>
          </Tooltip>
        ) : (
          <Tooltip tip="Opens while the agent is running."><span className={MUTED}>Computer</span></Tooltip>
        )
      )}
    </p>
  )
}
