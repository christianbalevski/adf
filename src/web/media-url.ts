/** Include the open-view generation: the same file name in another agent is
 * different media even when React reuses the image element. */
export function browserMediaUrl(url: string, context: { clientId: string; storageScope: string; runtime: string; view: number; filePath: string | null }): string {
  if (!url.startsWith('adf-file://')) return url
  try {
    const path = decodeURIComponent(url.slice('adf-file://'.length).split('?')[0].split('#')[0])
    return `/web/file?${new URLSearchParams({ clientId: context.clientId, storageScope: context.storageScope, path, runtime: context.runtime, view: String(context.view), ...(context.filePath ? { filePath: context.filePath } : {}) })}`
  } catch { return url }
}
