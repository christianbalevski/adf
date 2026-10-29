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
  // machineExists is also false when `podman machine list` failed or timed
  // out (after sleep, a hung gvproxy): the setup's init step treats an
  // existing machine as done, so the sheet still recovers either way.
  if (a.machineRequired && a.machineExists === false) return "Podman's machine is not set up or not responding"
  if (a.machineRequired && !a.machineRunning) return "Podman's machine is not running"
  return null
}

export function needsComputeMessage(serverName: string, gap: string, detail?: string): string {
  return `MCP server "${serverName}" runs in a container, and the compute environment is not ready: ${gap}${detail ? ` (${detail.replace(/\.$/, '')})` : ''}. ` +
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
    const detail = err instanceof Error ? err.message : String(err)
    let gap: string | null = null
    try { gap = computeGap(await availability()) } catch { /* unknown: report the container error */ }
    if (gap) throw new ComputeUnavailableError(needsComputeMessage(serverName, gap, detail))
    throw new Error(`MCP container for "${serverName}" is not ready: ${detail} Once the compute environment is fixed, call mcp_restart("${serverName}") to reconnect.`)
  }
  const bin = await podman.findPodman()
  if (!bin) throw new ComputeUnavailableError(needsComputeMessage(serverName, 'Podman is not installed'))
  return bin
}
