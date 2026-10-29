/**
 * Getting an MCP server's container ready, and saying plainly why it can't be.
 *
 * Every connect path (daemon runtime builder, Studio foreground and background)
 * starts the server's container the same way. When the reason it can't start
 * is that the compute environment itself is missing — Podman not installed,
 * a prerequisite missing, its machine not set up or not running — the failure
 * is a ComputeUnavailableError: the server's status becomes `needs_compute`,
 * and Studio offers to set compute up or to run the server on the host. Any
 * other container failure stays a plain error. Neither ever falls back to
 * running the server on the host.
 */
import type { PodmanAvailability } from '../../shared/types/compute.types'
import { checkPodmanAvailability } from './podman-bootstrap'

export class ComputeUnavailableError extends Error {
  readonly code = 'compute_unavailable'
}

/** What is missing from the compute environment, or null when it is all there. */
export function computeGap(a: PodmanAvailability): string | null {
  if (!a.available) return 'Podman is not installed'
  const missing = a.prerequisites.find((p) => !p.installed)
  if (missing) return `${missing.name} is not installed`
  if (a.machineRequired && a.machineExists === false) return "Podman's machine is not set up"
  if (a.machineRequired && !a.machineRunning) return "Podman's machine is not running"
  return null
}

export function needsComputeMessage(serverName: string, gap: string): string {
  return `MCP server "${serverName}" runs in a container, and the compute environment is not ready: ${gap}. ` +
    `The owner can set it up, or let this server run on the host, in ADF Studio; then call mcp_restart("${serverName}") to reconnect.`
}

/**
 * Start the container (`start`) and return the podman binary. Throws
 * ComputeUnavailableError when the compute environment is missing, a plain
 * Error for any other container failure.
 */
export async function prepareMcpContainer(
  podman: { findPodman(): Promise<string | null> },
  serverName: string,
  start: () => Promise<unknown>,
  availability: () => Promise<PodmanAvailability> = checkPodmanAvailability,
): Promise<string> {
  try {
    await start()
  } catch (err) {
    let gap: string | null = null
    try { gap = computeGap(await availability()) } catch { /* unknown: report the container error */ }
    if (gap) throw new ComputeUnavailableError(needsComputeMessage(serverName, gap))
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`MCP container for "${serverName}" is not ready: ${detail} Once the compute environment is fixed, call mcp_restart("${serverName}") to reconnect.`)
  }
  const bin = await podman.findPodman()
  if (!bin) throw new ComputeUnavailableError(needsComputeMessage(serverName, 'Podman is not installed'))
  return bin
}
