import { useAppStore } from '../stores/app.store'

/**
 * Open the agent Config tab on `section` (a Section title): the section
 * expands, scrolls into view and takes focus (pendingConfigSection). A
 * request no Section picks up is dropped, so it cannot fire later when the
 * user opens Config by hand.
 */
export function openConfigSection(section: string): void {
  const app = useAppStore.getState()
  app.expandRightPanelToTab('agent', 'config')
  app.setPendingConfigSection(section)
  setTimeout(() => {
    if (useAppStore.getState().pendingConfigSection === section) useAppStore.getState().setPendingConfigSection(null)
  }, 2000)
}

/**
 * Open the Loops section with `loop`'s card expanded and scrolled into view
 * (pendingConfigLoop, consumed by that LoopCard). Dropped like a section
 * request if no card picks it up.
 */
export function openConfigLoop(loop: string): void {
  openConfigSection('Loops')
  useAppStore.getState().setPendingConfigLoop(loop)
  setTimeout(() => {
    if (useAppStore.getState().pendingConfigLoop === loop) useAppStore.getState().setPendingConfigLoop(null)
  }, 2000)
}
