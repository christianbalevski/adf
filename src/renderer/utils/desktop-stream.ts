/**
 * Browser Studio's address for a container's VNC stream. Unset in the
 * desktop app, which shows the container's own noVNC page in a <webview>.
 * The web entry sets it (src/web/main.tsx), as it does the media resolver.
 */
let resolver: ((containerName: string) => string) | null = null
export function setDesktopStreamResolver(next: (containerName: string) => string): void { resolver = next }
export function desktopStreamUrl(containerName: string): string | null { return resolver ? resolver(containerName) : null }
