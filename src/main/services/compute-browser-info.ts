/**
 * The Computer tab's container lookup: the agent's isolated container, its
 * phase and, once ready, the noVNC host port (COMPUTE_BROWSER_INFO in Studio,
 * GET /compute/browser-info in the daemon).
 *
 * The tab opens in any phase and shows it; only a ready container gets the
 * (slow) browser bring-up awaited, so the viewer never lands on
 * connection-refused right after a restart.
 */

import { isolatedContainerName } from './podman.service'

export interface BrowserInfoPodman {
  containerPhase(containerName: string): Promise<{ phase: string; detail?: string }>
  browserReady(containerName: string): Promise<unknown>
  getNovncHostPort(containerName: string): Promise<number | null>
}

export async function getComputeBrowserInfo(podman: BrowserInfoPodman, args: { agentName: string; agentId: string }) {
  const containerName = isolatedContainerName(args.agentName, args.agentId)
  const { phase, detail } = await podman.containerPhase(containerName)
  if (phase !== 'ready') return { containerName, hostPort: null, phase, detail }
  let browserError: string | undefined
  await podman.browserReady(containerName).catch((err) => {
    browserError = err instanceof Error ? err.message : String(err)
  })
  const hostPort = await podman.getNovncHostPort(containerName)
  return { containerName, hostPort, phase, detail: browserError }
}
