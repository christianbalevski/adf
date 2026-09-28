// Agent website actions shared by every surface (Fleet `w`, Inspect › Status,
// Chat, the header indicator, /web /open-site /copy-site and the palette).
// Starting the web server needs no confirm; stopping asks (it takes every
// agent site / API and mesh delivery offline). Every outcome is a toast that
// shows the URL, so a missing browser never hides it.

import type { TuiStore } from '../state/store'
import { openUrl } from '../auth/flow'
import { copyToClipboard } from '../views/chat/model'
import { siteOf, type Site } from './model'

function agentLabel(store: TuiStore, agentId: string): string {
  const s = store.getState().agents[agentId]?.summary
  return s?.handle || s?.name || agentId
}

/** Start the web server (no confirm) and report it. */
export async function startWebServer(store: TuiStore): Promise<boolean> {
  return store.actions.setWebServer(true)
}

/** Stop the web server after a confirm. */
export async function stopWebServer(store: TuiStore): Promise<boolean> {
  const ok = await store.actions.confirm({
    title: 'Stop the web server',
    message: 'Every agent website and API goes offline, and agents stop receiving mesh messages over HTTP. /web on starts it again.',
    confirmLabel: 'Stop',
    danger: true,
  })
  if (!ok) return false
  return store.actions.setWebServer(false)
}

/** Header click, `w` on the tab bar, /web, the palette: flip it (stopping asks). */
export async function toggleWebServer(store: TuiStore, on?: boolean): Promise<boolean> {
  let server = store.getState().web?.server
  if (!server) server = (await store.actions.refreshWeb())?.server
  if (!server) { store.actions.toast('This daemon does not report a web server (GET /network/server)', 'warn'); return false }
  const want = on ?? !server.running
  if (want === server.running) {
    store.actions.toast(want ? `Web server already running (:${server.port})` : 'Web server already stopped', 'info')
    return true
  }
  return want ? startWebServer(store) : stopWebServer(store)
}

/**
 * The agent's site, with the server started if it was stopped. Null (after a
 * toast) when the agent serves nothing or the server cannot start.
 */
async function liveSite(store: TuiStore, agentId: string | null | undefined): Promise<Site | null> {
  if (!agentId) { store.actions.toast('No agent selected', 'warn'); return null }
  let site = siteOf(store.getState(), agentId)
  if (site && !site.server) {
    await store.actions.refreshWeb()
    site = siteOf(store.getState(), agentId)
  }
  if (!site) {
    store.actions.toast(`${agentLabel(store, agentId)} serves nothing on the web (config: serving.public / shared / api)`, 'info')
    return null
  }
  if (!site.server) { store.actions.toast('This daemon does not report a web server (GET /network/server)', 'warn'); return null }
  if (!site.url) {
    if (!await startWebServer(store)) return null
    site = siteOf(store.getState(), agentId)
    if (!site?.url) return null
  }
  return site
}

/** `w`: open the agent's site in the browser (starting the server first when it is stopped). */
export async function openSite(store: TuiStore, agentId: string | null | undefined): Promise<void> {
  const site = await liveSite(store, agentId)
  if (!site?.url) return
  openUrl(site.url)
  store.actions.toast(`Opening ${site.url}`, 'success')
}

/** `W` / /copy-site: the URL to the clipboard. */
export async function copySiteUrl(store: TuiStore, agentId: string | null | undefined): Promise<void> {
  const site = await liveSite(store, agentId)
  if (!site?.url) return
  const ok = await copyToClipboard(site.url)
  store.actions.toast(ok ? `Copied ${site.url}` : `Clipboard unavailable: ${site.url}`, ok ? 'success' : 'warn')
}
