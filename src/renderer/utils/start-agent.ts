import { useAppStore } from '../stores/app.store'
import { useDocumentStore } from '../stores/document.store'
import { useAgentStore } from '../stores/agent.store'
import { toDisplayState } from '../hooks/useAgent'

export interface StartForegroundOptions {
  /** Passed through to main: the start is a prelude to a user message. */
  hasUserMessage?: boolean
  /** The caller already ran the review gate (sidebar toggle, review dialog). */
  skipReviewGate?: boolean
  /** Log "Agent started" on success. Off for chat-initiated starts, where the message itself is the event. */
  announce?: boolean
}

export interface StartForegroundOutcome {
  success: boolean
  /** Why it did not start — already logged to the loop unless the user cancelled provider setup. */
  error?: string
  cancelled?: boolean
}

/**
 * Start the foreground agent the way every Start control does: review gate,
 * spinner, IPC, mirror the result into the agent store. One place, so the
 * provider-at-the-moment-of-need flow exists everywhere a start can begin.
 *
 * When main answers with a provider code ('provider_missing' /
 * 'provider_unconfigured'), the provider setup sheet opens; if it connects
 * a provider, the start is retried once. Cancelling the sheet is not an
 * error — the loop gets no red entry, the caller gets `cancelled`.
 */
export async function startForegroundAgent(options: StartForegroundOptions = {}): Promise<StartForegroundOutcome> {
  const { hasUserMessage, skipReviewGate, announce = true } = options
  const appStore = useAppStore.getState()
  const agentStore = useAgentStore.getState()

  if (!skipReviewGate) {
    try {
      const review = await window.adfApi?.checkAgentReview()
      if (review?.needsReview) {
        appStore.setAgentReviewDialog(true, review.configSummary)
        return { success: false, error: 'Agent needs review', cancelled: true }
      }
    } catch {
      // Review failures must not keep the user from starting the agent.
    }
  }

  const filePath = useDocumentStore.getState().filePath
  if (filePath) appStore.addStartingFilePath(filePath)
  try {
    let result = await window.adfApi?.startAgent(filePath ?? undefined, hasUserMessage)
    if (result && !result.success && (result.code === 'provider_missing' || result.code === 'provider_unconfigured')) {
      const connected = await useAppStore.getState().requestProviderSetup(result.code, filePath)
      if (!connected) return { success: false, error: result.error, cancelled: true }
      // The sheet is modal but slow: the user can still have switched agents
      // by the time it closes. Retrying with the captured path would start
      // whichever agent they left, so the retry is abandoned instead — and
      // said out loud, since the switched-away loop would otherwise get
      // nothing at all.
      if (useDocumentStore.getState().filePath !== filePath) {
        const error = 'Agent file changed — start it again'
        agentStore.addLogEntry({
          id: `error-${Date.now()}`,
          type: 'error',
          content: error,
          timestamp: Date.now()
        })
        return { success: false, error }
      }
      result = await window.adfApi?.startAgent(filePath ?? undefined, hasUserMessage)
    }

    // Only touch the store if the user is still looking at this agent.
    const stillViewing = useDocumentStore.getState().filePath === filePath
    if (result?.success) {
      if (stillViewing) {
        agentStore.setState(toDisplayState(result.agentState ?? 'idle'))
        agentStore.setSessionId(result.sessionId ?? null)
        if (announce) {
          agentStore.addLogEntry({
            id: `system-${Date.now()}`,
            type: 'system',
            content: 'Agent started',
            timestamp: Date.now()
          })
        }
      }
      return { success: true }
    }

    const error = result?.error ?? 'Unknown error'
    if (stillViewing) {
      agentStore.addLogEntry({
        id: `error-${Date.now()}`,
        type: 'error',
        content: error,
        timestamp: Date.now()
      })
    }
    // A credential failure main did not classify (an expired subscription,
    // a revoked key) has no setup sheet to open — send the user to the one
    // screen that can fix it, the way the Start buttons used to.
    if (!result?.code && (/API key/i.test(error) || /\b401\b/.test(error))) {
      useAppStore.getState().openSettingsAt('providers')
    }
    return { success: false, error }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    agentStore.addLogEntry({
      id: `error-${Date.now()}`,
      type: 'error',
      content: error,
      timestamp: Date.now()
    })
    return { success: false, error }
  } finally {
    if (filePath) useAppStore.getState().removeStartingFilePath(filePath)
  }
}
