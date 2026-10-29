/** Resolve display-only media addresses without changing saved documents. */
let resolver: ((url: string) => string) | null = null
export function setMediaUrlResolver(next: (url: string) => string): void { resolver = next }
export function mediaUrl(url: string): string { return resolver ? resolver(url) : url }

/** Only src attributes change. Links retain adf-file:// for editor navigation. */
export function resolveHtmlMediaUrls(html: string): string {
  if (!resolver || !html.includes('adf-file://')) return html
  return html.replace(/(<(?:img|audio|video|source)\b[^>]*\bsrc=")([^"]*)(")/gi,
    (_match, before: string, url: string, after: string) => {
      const next = mediaUrl(url.replace(/&amp;/g, '&'))
      return before + next.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;') + after
    })
}
