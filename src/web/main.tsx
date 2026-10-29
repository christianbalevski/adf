import { preserveBrowserEdits, preserveBrowserQueues } from './recovery'
import { takeLaunchTicket, readBrowserSession, redeemLaunchTicket, startBrowserPairing, pollBrowserPairing, type BrowserSession, type BrowserPairing, BrowserSessionRenewal } from './login'
import { browserMediaUrl } from './media-url'
import { claimBrowserClient, readStored } from './browser-storage'
import { setMediaUrlResolver } from '../renderer/utils/media-url'
import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createAdfApi } from '../shared/adf-api'
import { createRuntimeIpc, onAnyRuntime } from '../shared/runtime-ipc'
import { IPC } from '../shared/constants/ipc-channels'
import { RUNTIME_PUSH_CHANNELS } from '../shared/constants/runtime-push-channels'
import { STUDIO_CALL_CHANNELS } from '../shared/constants/studio-call-channels'
import type { AdfApi } from '../preload/api'
import { WebTransport, type WebConnectionState } from './transport'
import { browserIpc } from './browser-ipc'
import { Wordmark } from '../renderer/components/common/Wordmark'
import '@fontsource-variable/inter-tight/wght.css'
import '../renderer/styles/globals.css'
import './web.css'

// A bfcache restore resumes stale streams/leases; rebuild the same tab session.
window.addEventListener('pageshow', (event) => { if (event.persisted) location.reload() })

const params = new URLSearchParams(location.search)
const launchTicket = takeLaunchTicket(location, history)
const tabKey = `adf.web.client.${params.get('tab') || 'main'}`
const clientClaim = claimBrowserClient(tabKey)
let transport: WebTransport | null = null
let mounted = false

async function mountStudio(storageScope: string, recoveryScope: string, onState: (state: WebConnectionState) => void): Promise<void> {
  if (mounted) { location.reload(); return }
  mounted = true
  const clientId = await clientClaim
  transport = new WebTransport(clientId, storageScope, onState)
  const ipc = browserIpc(transport, storageScope, recoveryScope)
  const resumeKey = `adf.web.resume.${storageScope}.${clientId}`
  let resumePath: string | null = null
  try {
    const pendingResume = readStored<{ filePath?: string } | null>(sessionStorage, resumeKey, null)
    resumePath = typeof pendingResume?.filePath === 'string' ? pendingResume.filePath : null
    sessionStorage.removeItem(resumeKey)
  } catch { /* storage is optional until a reconnect needs to preserve focus */ }
  const surfaces = new Map<string, AdfApi>()
  const knownChannels = new Set<string>(Object.values(IPC))
  const apiFor = (runtimeId: string): AdfApi => {
    const id = runtimeId || 'local'
    let api = surfaces.get(id)
    if (!api) {
      api = {
        ...createAdfApi(createRuntimeIpc(ipc, id, new Set(RUNTIME_PUSH_CHANNELS), new Set(STUDIO_CALL_CHANNELS)), {
          platform: 'web', setZoomFactor: (factor) => { document.documentElement.style.zoom = String(factor) },
        }),
        runtimeId: id, runtime: apiFor,
        getPendingOpenFile: async () => {
          if (!resumePath) return { filePath: null }
          const filePath = resumePath; resumePath = null
          return { filePath, runtimeId: 'local' }
        },
        onAnyRuntime: (channel, callback) => {
          if (!knownChannels.has(channel)) throw new Error(`Unknown IPC channel: ${channel}`)
          return onAnyRuntime(ipc, channel, callback)
        },
      }
      surfaces.set(id, api)
    }
    return api
  }
  window.adfApi = apiFor(params.get('runtime') || 'local')
  const { useDocumentStore } = await import('../renderer/stores/document.store')
  setMediaUrlResolver((url) => browserMediaUrl(url, {
    clientId, storageScope, runtime: params.get('runtime') || 'local',
    view: useDocumentStore.getState().viewGeneration, filePath: useDocumentStore.getState().filePath,
  }))
  transport.connect()
  // Renderer modules read adfApi during initialization: load only after the
  // shared facade exists, exactly as Electron's preload runs before the page.
  await import('../renderer/main')
}

function WebSession() {
  const [checking, setChecking] = useState(true)
  const [authenticated, setAuthenticated] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pairing, setPairing] = useState<Extract<BrowserPairing, { state: 'pending' }> | null>(null)
  const [state, setState] = useState<WebConnectionState>('connecting')
  const renewal = useRef(new BrowserSessionRenewal())
  const signingOut = useRef(false)
  const preserveEdits = async (includeQueues = true) => {
    const { stashUnsavedEditors } = await import('../renderer/utils/edit-recovery')
    await preserveBrowserEdits(stashUnsavedEditors, (entry) => window.adfApi.recoveryStash(entry))
    if (!includeQueues) return
    const [{ useMessageQueueStore }, { useDocumentStore }, { queueEntries }] = await Promise.all([
      import('../renderer/stores/message-queue.store'), import('../renderer/stores/document.store'), import('../renderer/utils/agent-window'),
    ])
    if (transport) {
      let storage: Storage | null = null
      try { storage = localStorage } catch { /* live queues can still be preserved, or surface a save error */ }
      await preserveBrowserQueues(queueEntries(useMessageQueueStore.getState().queues, useDocumentStore.getState().filePath), storage,
        transport.storageScope, transport.clientId, (entry) => window.adfApi.recoveryStash(entry))
    }
  }
  const recoveryFailure = (cause: unknown) => setError(`Your edits or pending messages could not be saved for recovery. Keep this tab open and copy your edits before reloading. ${cause instanceof Error ? cause.message : String(cause)}`)
  const reset = async () => {
    try {
      await preserveEdits(false)
      const { useDocumentStore } = await import('../renderer/stores/document.store')
      if (signingOut.current) return
      const filePath = useDocumentStore.getState().filePath
      if (filePath && transport) sessionStorage.setItem(`adf.web.resume.${transport.storageScope}.${transport.clientId}`, JSON.stringify({ filePath }))
      location.reload()
    } catch (cause) {
      recoveryFailure(cause)
    }
  }
  const onState = (next: WebConnectionState) => {
    if (signingOut.current) return
    setState(next)
    if (next === 'reset') { void reset(); return }
    if (next === 'unauthorized') {
      void renewal.current.run(preserveEdits, async (signal) => {
        // Never replay the failed call. Only refresh authentication after all
        // edits and pending messages have a manual-review recovery copy.
        try { return await readBrowserSession(signal) }
        catch { return null }
      }, (renewed) => {
        if (renewed) { location.reload(); return }
        setAuthenticated(false)
        document.getElementById('root')!.hidden = true
        setError('Your session has expired. Sign in again to reconnect. Unsaved edits and pending messages were kept in recovery storage.')
      }).catch(recoveryFailure)
    }
  }
  const acceptSession = async (session: BrowserSession) => {
    await mountStudio(session.storageScope, session.recoveryScope, onState)
    setAuthenticated(true)
  }
  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      const session = launchTicket !== null
        ? await redeemLaunchTicket(launchTicket, controller.signal)
        : await readBrowserSession(controller.signal)
      if (controller.signal.aborted) return
      if (session) await acceptSession(session)
      else {
        // A reload while waiting for approval keeps the pending claim in its
        // HttpOnly cookie. Never submit the same pairing code a second time.
        try {
          const pending = await pollBrowserPairing(controller.signal)
          if (controller.signal.aborted) return
          if (pending.state === 'approved') await acceptSession(pending)
          else if (pending.state === 'pending') setPairing(pending)
        } catch (cause) {
          if ((cause as { status?: number }).status !== 404) throw cause
        }
      }
    })().catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)) })
      .finally(() => { if (!controller.signal.aborted) setChecking(false) })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!pairing) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const result = await pollBrowserPairing(controller.signal)
        if (controller.signal.aborted) return
        if (result.state === 'approved') { setPairing(null); await acceptSession(result); return }
        if (result.state === 'denied') { setPairing(null); setError('The connection was declined by the host. Ask the host to open a new pairing code to try again.'); return }
        if (Date.parse(result.expiresAt) <= Date.now()) {
          setPairing(null); setError('This pairing code expired. Open a new code on the host and try again.'); return
        }
        timer = setTimeout(() => void poll(), 2000)
      } catch (cause) {
        if (!controller.signal.aborted) { setPairing(null); setError(cause instanceof Error ? cause.message : String(cause)) }
      }
    }
    timer = setTimeout(() => void poll(), 1000)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [pairing])

  const pair = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setError('')
    const input = event.currentTarget.elements.namedItem('code') as HTMLInputElement
    const deviceName = (event.currentTarget.elements.namedItem('deviceName') as HTMLInputElement).value
    const code = input.value
    input.value = ''
    try {
      setPairing(await startBrowserPairing(code, deviceName))
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const logout = async () => {
    if (signingOut.current) return
    signingOut.current = true
    renewal.current.stop()
    setBusy(true)
    try {
      await preserveEdits()
      transport?.close()
      const response = await fetch('/web/session', { method: 'DELETE', credentials: 'same-origin' })
      if (!response.ok) throw new Error('Sign out failed. Please try again.')
      location.reload()
    } catch (cause) { signingOut.current = false; setError(cause instanceof Error ? cause.message : String(cause)); setBusy(false) }
  }
  if (authenticated) return <div className="web-session-bar">
    <span role="status">{state === 'connected' ? 'Studio Web' : state === 'reset' ? 'Restoring Studio connection…' : 'Reconnecting to daemon…'}</span>
    {error && <span role="alert">{error}</span>}
    <button type="button" onClick={() => void logout()} disabled={busy}>Sign out</button>
  </div>
  return <main className="web-login">
    <form onSubmit={(event) => void pair(event)} className="web-login-card">
      <Wordmark height={56} />
      <h1>Studio in your browser</h1>
      <p>Connect to Studio to work with your agents.</p>
      <div className="web-login-host">{location.host}</div>
      {checking ? <p role="status">{launchTicket !== null ? 'Signing you in…' : 'Checking your session…'}</p> : pairing ? <>
        <h2>Approve on the host computer</h2>
        <p role="status">Waiting for approval. Approve this browser in the host terminal running adf daemon pair, or in Studio. This page will open automatically.</p>
      </> : <>
        <div className="web-login-local">
          <h2>On the same computer?</h2>
          <p>Run <code>adf web</code> on this computer to sign in automatically. Or use <strong>Open in browser</strong> in desktop Studio’s Settings → Studio → Connections.</p>
        </div>
        <h2>Connect another device</h2>
        <p className="web-login-help">On the host, run adf daemon remote on, then adf daemon pair. Enter its six-digit code here, then approve in that terminal. Studio’s Share settings also support pairing.</p>
        <label htmlFor="pairing-code">Pairing code</label>
        <input id="pairing-code" name="code" type="text" inputMode="numeric" autoComplete="one-time-code" required autoFocus maxLength={12} placeholder="123456" disabled={busy} />
        <label htmlFor="browser-name">Name this browser</label>
        <input id="browser-name" name="deviceName" type="text" required maxLength={64} defaultValue="My browser" autoComplete="off" disabled={busy} />
        {error && <p role="alert" className="web-login-error">{error}</p>}
        <button type="submit" disabled={busy}>{busy ? 'Connecting…' : 'Pair this browser'}</button>
        <p className="web-login-help">This browser is remembered for 30 days. You can revoke its access from the host’s CLI or Studio at any time.</p>
      </>}
    </form>
  </main>
}

createRoot(document.getElementById('web-session')!).render(<WebSession />)
