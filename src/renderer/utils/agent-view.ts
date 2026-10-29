import { useDocumentStore } from '../stores/document.store'
import { isAgentSwitching } from '../stores/editor-tabs.store'

/** Identity of one foreground view, not merely a file name. */
export function captureAgentView() {
  const { filePath, runtimeId, viewGeneration } = useDocumentStore.getState()
  return { filePath, runtimeId, viewGeneration }
}

export type AgentView = ReturnType<typeof captureAgentView>

export function isCurrentAgentView(view: AgentView): boolean {
  const now = useDocumentStore.getState()
  return !isAgentSwitching() && view.filePath === now.filePath
    && view.runtimeId === now.runtimeId && view.viewGeneration === now.viewGeneration
}
