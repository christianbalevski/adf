/**
 * Which Studio window this page is (docs/design/agent-windows.md). Main
 * loads the page with a query: `window=agent&file=<path>` for an agent
 * window; `agentWindows=1` on the main window when Open in new window is
 * available (daemon mode). Read once: a reload keeps the query.
 */

const params = typeof window !== 'undefined' && window.location ? new URLSearchParams(window.location.search) : new URLSearchParams()

/** This window shows one agent: its chat and panels, no sidebar. */
export const isAgentWindow = params.get('window') === 'agent'

/** The agent file an agent window was opened for; null in the main window. */
export const agentWindowFile: string | null = isAgentWindow ? params.get('file') : null

/** Open in new window is offered (daemon mode, main window). */
export const agentWindowsAvailable = !isAgentWindow && params.get('agentWindows') === '1'

/** Open in new window: opens the agent's window, or focuses it when it has one. */
export function openAgentWindow(request: { filePath: string; agentId?: string | null; name?: string }): void {
  window.adfApi?.openAgentWindow(request).then((result) => {
    if (!result.success) console.error('[AgentWindow] Open in new window failed:', result.error)
  }).catch((err: unknown) => console.error('[AgentWindow] Open in new window failed:', err))
}

/** Close this agent window (Close Agent, a cancelled open). */
export function closeAgentWindow(): void {
  window.adfApi?.closeAgentWindow().catch((err: unknown) => console.error('[AgentWindow] Close window failed:', err))
}

/** Settings live in the main window: focus it and open them there, at `section`. */
export function openMainSettings(section?: string, anchor?: string): void {
  window.adfApi?.openMainSettings({ ...(section ? { section } : {}), ...(anchor ? { anchor } : {}) })
    .catch((err: unknown) => console.error('[AgentWindow] Opening Settings in the main window failed:', err))
}
