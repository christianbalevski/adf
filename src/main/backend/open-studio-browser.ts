import type { RuntimeConnection } from './daemon-mode/runtime-connection'
import { localBrowserOrigin, validatedBrowserLaunch } from '../services/studio-browser-launch'

type LocalRuntime = Pick<RuntimeConnection, 'kind' | 'client'> & {
  connection: Pick<RuntimeConnection['connection'], 'baseUrl'>
}

/** Native-only launch: neither a token, ticket nor destination comes from the renderer. */
export async function openStudioInBrowser(
  runtime: LocalRuntime | null,
  openExternal: (url: string) => Promise<unknown>,
): Promise<{ success: true } | { success: false; error: string }> {
  if (!runtime || runtime.kind !== 'local') {
    return { success: false, error: 'Browser Studio needs this computer’s local server. Select Local server in Connections and restart Studio, then try again.' }
  }
  try {
    const client = await runtime.client()
    const baseUrl = runtime.connection.baseUrl
    if (!baseUrl) return { success: false, error: 'The local server is still connecting. Try again when it is connected.' }
    try { localBrowserOrigin(baseUrl) } catch {
      return { success: false, error: 'The local server must use a loopback address to open Browser Studio.' }
    }
    // Local runtime clients supply the master bearer and this daemon run's
    // proof on local-only routes. Remote runtime clients are never used here.
    const result = await client.request<{ url: string }>('POST', '/web/launch')
    let target: string
    try { target = validatedBrowserLaunch(baseUrl, result.url) } catch {
      return { success: false, error: 'The local server returned an invalid browser launch address. Update the daemon and try again.' }
    }
    await openExternal(target)
    return { success: true }
  } catch (error) {
    // Do not return native shell errors: they can include the single-use URL.
    if ((error as { status?: number })?.status === 404) {
      return { success: false, error: 'This daemon does not support Browser Studio yet. Update the local daemon, then try again.' }
    }
    return { success: false, error: 'Studio could not open the browser. Check that the local daemon is connected and Browser Studio is built, then try again.' }
  }
}
