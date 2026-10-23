import { useEditorTabsStore } from '../stores/editor-tabs.store'
import { useAppStore } from '../stores/app.store'
import { openApi } from './runtime-api'

const ADF_FILE_PREFIX = 'adf-file://'

export function isAdfFileUrl(href: string): boolean {
  return href.startsWith(ADF_FILE_PREFIX)
}

export function extractAdfFilePath(href: string): string {
  return decodeURIComponent(
    href.slice(ADF_FILE_PREFIX.length).split('?')[0].split('#')[0].replace(/\/+$/, '')
  )
}

export async function openAdfFileLink(href: string): Promise<void> {
  const filePath = extractAdfFilePath(href)

  // If tab is already open, just activate it
  const existing = useEditorTabsStore.getState().tabs.find(t => t.path === filePath)
  if (existing) {
    useEditorTabsStore.getState().setActiveTab(filePath)
    // Loops can cover the editor while this file is still its active tab.
    // Reveal it explicitly even when the selected path has not changed.
    useAppStore.getState().setCenterChatTabActive(false)
    return
  }

  const result = await openApi()?.readInternalFile(filePath)
  if (result?.content != null) {
    useEditorTabsStore.getState().openTab(filePath, result.binary ? '' : result.content, result.binary, result.mimeType, result.revision)
    useAppStore.getState().setCenterChatTabActive(false)
  }
}
