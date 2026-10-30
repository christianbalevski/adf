import type { RuntimeId } from '../../shared/runtime-tag'
import { isRuntimeWebsiteLink, meshWebsiteUrl, resolveRelativeWebsiteLink } from '../../shared/utils/agent-website-url'
import { runtimesOf } from '../stores/runtimes.store'
import { apiFor } from './runtime-api'

/** Resolve against the view's explicit runtime, freshly at activation time. */
export async function resolveRuntimeWebsiteLink(href: string, runtimeId: RuntimeId): Promise<string> {
  if (!isRuntimeWebsiteLink(href)) return href
  const api = apiFor(runtimeId)
  const [connections, server] = await Promise.all([
    window.adfApi.listConnections(),
    api.getMeshServerStatus(),
  ])
  const runtime = runtimesOf(connections).find((r) => r.id === runtimeId)
  if (!runtime || runtime.state !== 'connected') throw new Error('Connect to this document’s runtime to open its website.')
  if (!server?.running) throw new Error('The runtime’s website server is off. Turn it on in Settings › Networking.')
  if (runtime.kind === 'remote' && !runtime.url) throw new Error('The remote runtime address is unavailable.')
  // Browser Studio's "local" runtime is local to its server, not necessarily
  // to the browser. Reach that server using the browser's connection hostname.
  const remoteUrl = runtime.kind === 'remote' ? runtime.url : window.adfApi.platform === 'web' ? window.location.href : null
  let host = server.host
  if (remoteUrl) {
    const connection = new URL(remoteUrl)
    if (!['http:', 'https:'].includes(connection.protocol)) throw new Error('The runtime connection address is unavailable.')
    // A bind address can be a LAN IP even when this client connects over
    // Tailscale. Relative references always follow this client's connection.
    host = connection.hostname
  }
  return resolveRelativeWebsiteLink(href, meshWebsiteUrl({ ...server, host }, '/agents/'))
}

/** Keep the browser's user gesture across the asynchronous runtime lookup. */
export async function openRuntimeWebsiteLink(href: string, runtimeId: RuntimeId, isCurrent: () => boolean): Promise<void> {
  const browserTab = window.adfApi.platform === 'web' ? window.open('about:blank', '_blank') : null
  if (browserTab) browserTab.opener = null
  try {
    if (window.adfApi.platform === 'web' && !browserTab) throw new Error('Allow pop-ups to open the agent’s website.')
    const url = await resolveRuntimeWebsiteLink(href, runtimeId)
    if (!isCurrent()) { browserTab?.close(); return }
    if (browserTab) browserTab.location.replace(url)
    else window.open(url, '_blank', 'noopener,noreferrer')
  } catch (error) {
    browserTab?.close()
    throw error
  }
}
