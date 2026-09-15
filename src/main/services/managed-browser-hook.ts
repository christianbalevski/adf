/**
 * Lets the container MCP transport ask for the managed browser before it
 * spawns a server that attaches over CDP — without importing the Podman
 * service (which imports the transport). The service registers itself here.
 */
export type ManagedBrowserEnsurer = (containerName: string) => Promise<void>

let ensurer: ManagedBrowserEnsurer | null = null

export function setManagedBrowserEnsurer(fn: ManagedBrowserEnsurer | null): void {
  ensurer = fn
}

/** Resolves immediately when nothing is registered (tests, daemon without compute). */
export function ensureManagedBrowserForSpawn(containerName: string): Promise<void> {
  return ensurer ? ensurer(containerName) : Promise.resolve()
}
