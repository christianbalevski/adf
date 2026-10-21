/**
 * Which Studio window this page is (docs/design/agent-windows.md). Main
 * loads the page with a query: `window=agent&file=<path>` for an agent
 * window; `agentWindows=1` on the main window when Open in new window is
 * available (daemon mode). Read once: a reload keeps the query.
 */

import { reportFailure } from '../stores/failure-notices.store'

const params = typeof window !== 'undefined' && window.location ? new URLSearchParams(window.location.search) : new URLSearchParams()

/** This window shows one agent: its chat and panels, no sidebar. */
export const isAgentWindow = params.get('window') === 'agent'

/**
 * The runtime an agent window's agent lives on (`runtime=<id>`, set by main
 * for a runtime other than This computer; docs/design/multi-runtime.md
 * §5.5). The main window, and an agent window of This computer: `local`.
 */
export const windowRuntime: string = (isAgentWindow && params.get('runtime')) || 'local'

/** The agent file an agent window was opened for; null in the main window. */
export const agentWindowFile: string | null = isAgentWindow ? params.get('file') : null

/** Open in new window is offered (daemon mode, main window). */
export const agentWindowsAvailable = !isAgentWindow && params.get('agentWindows') === '1'

/** Open in new window: opens the agent's window, or focuses it when it has one. */
export function openAgentWindow(request: { filePath: string; agentId?: string | null; name?: string; runtimeId?: string }): void {
  // This computer's agent: the request is the one sent before (multi-runtime.md §4.6).
  if (request.runtimeId === 'local') { const { runtimeId: _local, ...rest } = request; request = rest }
  // A refusal is said where the user asked (bottom right), not only in the console.
  window.adfApi?.openAgentWindow(request).then((result) => {
    if (!result.success) reportFailure('Open in new window failed', result.error ?? undefined)
  }).catch((err: unknown) => reportFailure('Open in new window failed', err))
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
