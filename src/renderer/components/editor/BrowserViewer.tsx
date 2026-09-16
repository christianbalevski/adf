import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '../../stores/app.store'
import type { BrowserTabMeta } from '../../stores/editor-tabs.store'
import type { ContainerPhase, ContainerPhaseEvent } from '../../../shared/types/compute.types'

interface Props {
  meta: BrowserTabMeta
  /** Bump to reload the viewer (wired to the tab-strip reload button). */
  reloadNonce?: number
}

interface WebviewElement extends HTMLElement {
  reload: () => void
}

interface ViewerState {
  phase: ContainerPhase
  detail?: string
  hostPort: number | null
}

/**
 * Live view of an agent's container desktop (the Computer tab): a <webview>
 * hosting the noVNC page published on host loopback. The user watches and
 * interacts with the same X display (:99) the agent's automation drives —
 * Openbox/tint2 desktop, managed Chromium, and whatever else the agent launches.
 *
 * The webview mounts only once the container is ready and its port is known.
 * Until then the tab explains the container's phase (provisioning, stopped,
 * failed) and follows live phase events, so a rebuild started in Settings or
 * an agent start turns into the desktop without reopening the tab.
 *
 * resize=remote — Xtigervnc supports dynamic desktop resize, so the container
 * desktop always matches the viewer tab exactly (no letterboxing); Openbox
 * re-fits maximized windows on each resize. reconnect=1 retries every 2s
 * while the display stack is down, so a restart reattaches by itself.
 */
export function BrowserViewer({ meta, reloadNonce }: Props) {
  const [state, setState] = useState<ViewerState>(() => ({
    phase: meta.phase ?? (meta.hostPort != null ? 'ready' : 'absent'),
    detail: meta.detail,
    hostPort: meta.hostPort,
  }))

  // Re-query the port when the container becomes ready: the phase event does
  // not carry it, and the browser stack bring-up is awaited by the query.
  const fetchPort = useCallback(async () => {
    const info = await window.adfApi?.getBrowserSessionInfo({ agentName: meta.agentName, agentId: meta.agentId })
    if (!info) return
    setState({ phase: info.phase, detail: info.detail, hostPort: info.hostPort })
  }, [meta.agentName, meta.agentId])

  useEffect(() => {
    setState({
      phase: meta.phase ?? (meta.hostPort != null ? 'ready' : 'absent'),
      detail: meta.detail,
      hostPort: meta.hostPort,
    })
    if (meta.phase === 'ready' && meta.hostPort == null) void fetchPort()
  }, [meta.phase, meta.detail, meta.hostPort, fetchPort])

  useEffect(() => {
    if (!window.adfApi?.onContainerPhase) return
    return window.adfApi.onContainerPhase((event: ContainerPhaseEvent) => {
      if (event.containerName !== meta.containerName) return
      if (event.phase === 'ready') {
        setState((s) => ({ ...s, phase: 'ready', detail: undefined }))
        void fetchPort()
      } else {
        setState({ phase: event.phase, detail: event.detail, hostPort: null })
      }
    })
  }, [meta.containerName, fetchPort])

  if (state.phase === 'ready' && state.hostPort != null) {
    return <DesktopWebview hostPort={state.hostPort} reloadNonce={reloadNonce} />
  }
  return <PhasePlaceholder agentName={meta.agentName} state={state} onRetry={fetchPort} />
}

function DesktopWebview({ hostPort, reloadNonce }: { hostPort: number; reloadNonce?: number }) {
  const webviewRef = useRef<WebviewElement | null>(null)
  // reload() throws until the webview is attached and dom-ready has fired
  // (e.g. on StrictMode remount, or a reload click during initial load —
  // skipping is fine there, a fresh load is already in progress).
  const domReadyRef = useRef(false)
  const src = `http://127.0.0.1:${hostPort}/vnc.html?autoconnect=1&resize=remote&reconnect=1&reconnect_delay=2000`

  useEffect(() => {
    const webview = webviewRef.current
    if (!webview) return
    domReadyRef.current = false
    const onDomReady = () => { domReadyRef.current = true }
    webview.addEventListener('dom-ready', onDomReady)
    return () => {
      domReadyRef.current = false
      webview.removeEventListener('dom-ready', onDomReady)
    }
  }, [hostPort])

  useEffect(() => {
    if (reloadNonce && domReadyRef.current) webviewRef.current?.reload()
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

function PhasePlaceholder({ agentName, state, onRetry }: { agentName: string; state: ViewerState; onRetry: () => void }) {
  const openSettingsAt = useAppStore((s) => s.openSettingsAt)
  const { phase, detail } = state
  const busy = phase === 'provisioning' || phase === 'starting'
  const failed = phase === 'failed'

  const title = failed
    ? `${agentName}'s computer could not be set up`
    : phase === 'provisioning'
      ? `Setting up ${agentName}'s computer`
      : phase === 'starting'
        ? `Starting ${agentName}'s computer`
        : phase === 'stopped'
          ? `${agentName}'s computer is stopped`
          : phase === 'ready'
            ? `${agentName}'s display is not up yet`
            : `${agentName} has no computer yet`

  const body = failed
    ? 'Nothing is left of the container. Rebuild it from Settings › Compute; the error is shown there too.'
    : phase === 'provisioning'
      ? `${detail ?? 'Installing packages'}. This takes a minute or two on first setup; the desktop appears here when it is ready.`
      : phase === 'starting'
        ? 'The container is starting; the desktop appears here in a few seconds.'
        : phase === 'stopped'
          ? 'The container starts with the agent. Start the agent, or start the container from Settings › Compute.'
          : phase === 'ready'
            ? detail ?? 'The container is running but its display did not answer yet.'
            : 'The container is created the first time the agent starts.'

  return (
    <div className="flex h-full w-full items-center justify-center bg-[var(--adf-ui-canvas)] p-6">
      <div className="max-w-md text-center">
        <div className={`mx-auto mb-4 flex size-10 items-center justify-center rounded-full ${failed ? 'bg-[var(--adf-ui-danger-subtle)] text-[var(--adf-ui-danger)]' : 'bg-[var(--adf-ui-surface)] text-[var(--adf-ui-text-muted)]'} ${busy ? 'animate-pulse' : ''}`}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4.5 7.7 7.5 4.2 7.5-4.2M12 12v9"/></svg>
        </div>
        <h3 className="text-sm font-semibold text-[var(--adf-ui-text)]">{title}</h3>
        <p className="mt-2 text-[12px] text-[var(--adf-ui-text-muted)]">{body}</p>
        {failed && detail && (
          <p className="mt-3 rounded-[var(--adf-ui-control-radius)] bg-[var(--adf-ui-danger-subtle)] p-3 text-left font-mono text-[10px] text-[var(--adf-ui-text)] break-words">{detail}</p>
        )}
        <div className="mt-4 flex justify-center gap-2">
          {(failed || phase === 'stopped') && (
            <button
              className="rounded-[var(--adf-ui-control-radius)] bg-[var(--adf-ui-accent)] px-3 py-1.5 text-[11px] font-medium text-white hover:bg-[var(--adf-ui-accent-hover)] dark:text-neutral-950"
              onClick={() => openSettingsAt('compute')}
            >
              Open Settings › Compute
            </button>
          )}
          {!busy && (
            <button
              className="rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] px-3 py-1.5 text-[11px] text-[var(--adf-ui-text)] hover:bg-[var(--adf-ui-surface-hover)]"
              onClick={onRetry}
            >
              Check again
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
