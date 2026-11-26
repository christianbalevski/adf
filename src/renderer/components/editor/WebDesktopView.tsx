import { useCallback, useState } from 'react'
import RFB from '@novnc/novnc'
import { useAppStore } from '../../stores/app.store'

/**
 * The Computer tab in browser Studio: noVNC's client from Studio's own
 * bundle, drawing the container's VNC stream (relayed by the daemon at
 * /web/desktop/:container/websockify). The container's noVNC page is never
 * loaded here: the agent can rewrite it, and on Studio's origin it would run
 * with the browser's session.
 *
 * Same screen-size rule as the desktop viewer: scaled by default, the remote
 * desktop resized to the tab with "Match tab size". noVNC's default quality:
 * this stream crosses the network, unlike the desktop app's loopback one.
 * A dropped stream reconnects every 2 s, as the desktop viewer's reconnect=1.
 *
 * One RFB client per target div: the div is keyed by url, attempt and reload,
 * so a reconnect or reload mounts a fresh div, and its ref callback owns the
 * client until the div unmounts.
 */
export default function WebDesktopView({ url, reloadNonce }: { url: string; reloadNonce?: number }) {
  const [attempt, setAttempt] = useState(0)
  const [connected, setConnected] = useState(false)

  const attach = useCallback(
    (target: HTMLDivElement) => {
      const rfb = new RFB(target, url, { wsProtocols: ['binary'] })
      rfb.background = 'var(--adf-ui-canvas)'
      const applyMatchTab = (matchTab: boolean) => {
        rfb.scaleViewport = !matchTab
        rfb.resizeSession = matchTab
      }
      applyMatchTab(useAppStore.getState().computerMatchTab)
      const unsubscribe = useAppStore.subscribe((s, prev) => {
        if (s.computerMatchTab !== prev.computerMatchTab) applyMatchTab(s.computerMatchTab)
      })
      let closed = false
      // noVNC logs an error when a disconnected client is told to disconnect.
      let dead = false
      let retry: ReturnType<typeof setTimeout> | undefined
      rfb.addEventListener('connect', () => setConnected(true))
      rfb.addEventListener('disconnect', () => {
        dead = true
        setConnected(false)
        if (!closed) retry = setTimeout(() => setAttempt((n) => n + 1), 2000)
      })
      return () => {
        closed = true
        clearTimeout(retry)
        unsubscribe()
        if (!dead) rfb.disconnect()
      }
    },
    [url],
  )

  return (
    <div className="relative h-full w-full bg-[var(--adf-ui-canvas)]">
      <div key={`${url}|${attempt}|${reloadNonce ?? 0}`} ref={attach} className="h-full w-full" />
      {!connected && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[12px] text-[var(--adf-ui-text-muted)]">
          Connecting to the display…
        </div>
      )}
    </div>
  )
}
