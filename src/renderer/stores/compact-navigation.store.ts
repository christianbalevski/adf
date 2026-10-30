import { create } from 'zustand'
import type { AgentSubTab, RightPanel } from './app.store'

/** Touch navigation is session state; desktop layout preferences stay intact. */
export const useCompactNavigationStore = create<{
  panel: 'agents' | 'details' | null
  rightPanel: RightPanel
  agentSubTab: AgentSubTab
  chatTabActive: boolean
  setPanel: (panel: 'agents' | 'details' | null) => void
}>((set) => ({
  panel: null,
  rightPanel: 'overview',
  agentSubTab: 'config',
  chatTabActive: true,
  setPanel: panel => set({ panel }),
}))
