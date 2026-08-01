import { useEffect, useRef } from 'react'

interface Props {
  hostPort: number
  /** Bump to reload the viewer (wired to the tab-strip reload button). */
  reloadNonce?: number
}

interface WebviewElement extends HTMLElement {
  reload: () => void
}

/**
 * Live view of an agent's container browser: a <webview> hosting the noVNC
 * page published on host loopback. The user watches and interacts with the
 * same X display (:99) the agent's automation drives.
 *
 * resize=remote — Xtigervnc supports dynamic desktop resize, so the container
 * desktop always matches the viewer tab exactly (no letterboxing); matchbox
 * keeps browser windows maximized to it. reconnect=1 retries every 2s while
 * the container/stack is down, so a restart reattaches by itself.
 */
export function BrowserViewer({ hostPort, reloadNonce }: Props) {
  const webviewRef = useRef<WebviewElement | null>(null)
  const src = `http://127.0.0.1:${hostPort}/vnc.html?autoconnect=1&resize=remote&reconnect=1&reconnect_delay=2000`

  useEffect(() => {
    if (reloadNonce) webviewRef.current?.reload()
  }, [reloadNonce])

  return (
    <webview
      key={hostPort}
      ref={webviewRef}
      src={src}
      partition="agent-browser"
      className="h-full w-full"
    />
  )
}
