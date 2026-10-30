/** Browser links use the remote runtime's host, while keeping the mesh port and protocol. */
export function agentWebsiteUrl(url: string, remoteRuntimeUrl?: string | null): string {
  if (!remoteRuntimeUrl) return url
  try {
    const site = new URL(url)
    const runtime = new URL(remoteRuntimeUrl)
    if (!['http:', 'https:'].includes(site.protocol) || !['http:', 'https:'].includes(runtime.protocol)) return url
    // Only the built-in mesh namespace on a local bind address is canonical.
    // Custom domains, LAN addresses and unrelated local websites stay verbatim.
    if (!/^\/agents(?:\/|$)/.test(site.pathname) || !isLocalHost(site.hostname)) return url
    if (site.username || site.password) return url
    site.hostname = runtime.hostname
    return site.href
  } catch {
    return url
  }
}

function isLocalHost(host: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]', '0.0.0.0', '[::]'].includes(host) || /^127\.\d+\.\d+\.\d+$/.test(host)
}

/** Build a link without changing the server's reported bind address. */
export function meshWebsiteUrl(server: { host: string; port: number }, path: string, remoteRuntimeUrl?: string | null): string {
  let host = server.host
  if (!host || ['0.0.0.0', '::', '[::]'].includes(host)) host = '127.0.0.1'
  if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`
  return agentWebsiteUrl(`http://${host}:${server.port}${path}`, remoteRuntimeUrl)
}

/** Only this root-relative namespace has ADF runtime semantics. */
export function isRuntimeWebsiteLink(href: string): boolean {
  return /^\/agents(?:[/?#]|$)/.test(href)
}

/** Resolve display/navigation links only; never rewrite stored Markdown or absolute URLs. */
export function resolveRelativeWebsiteLink(href: string, websiteBase: string): string {
  if (!isRuntimeWebsiteLink(href)) return href
  const base = new URL(websiteBase)
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
    throw new Error('The runtime website address is unavailable.')
  }
  const target = new URL(href, base)
  // URL parsing normalizes dot segments. Do not turn a website reference into
  // a different origin or an unrelated runtime/control endpoint.
  if (/[\\\u0000-\u0020]/.test(href) || target.origin !== base.origin || !/^\/agents(?:\/|$)/.test(target.pathname)) {
    throw new Error('The agent website link is invalid.')
  }
  return target.href
}
