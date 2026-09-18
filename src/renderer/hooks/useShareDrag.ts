import { useCallback, useRef } from 'react'

/** Fired on `window` after the first drag-out of the session, so the home screen's step can flip without polling. */
export const SHARE_MARKED_EVENT = 'adf-share-marked'

let markedThisSession = false

/**
 * Record the first drag-out. The drop target is unknowable from inside the
 * app, so the gesture is what counts. Read-then-write so a value written by
 * another window is never clobbered.
 */
async function markSharedOnce(): Promise<void> {
  if (markedThisSession) return
  markedThisSession = true
  try {
    const settings = await window.adfApi.getSettings()
    if (!settings.onboardingSharedAt) {
      await window.adfApi.setSettings({ onboardingSharedAt: Date.now() })
    }
    window.dispatchEvent(new Event(SHARE_MARKED_EVENT))
  } catch {
    markedThisSession = false
  }
}

/**
 * Native drag-out of an agent file. Spread the returned props onto any
 * element; dragging it into Finder, a message, or another app drops a
 * consistent snapshot of the .adf, named after the agent.
 *
 * The snapshot is built on dragstart and nowhere else — preparing it on
 * pointerdown would copy the whole database on every click of a sidebar row.
 * `preventDefault` on dragstart is what cancels the HTML5 drag in favour of
 * the native one, exactly as Electron documents. On dragend the token is
 * discarded so an abandoned drag leaves no temp file behind; main owns the
 * file once the drag has started and tolerates an unknown token.
 */
export function useShareDrag(filePath: string | null) {
  // The token arrives after dragstart returns, and `preventDefault` makes
  // dragend fire almost immediately — so dragend waits on the same promise
  // rather than reading a token that may not be there yet.
  const issued = useRef<Promise<string | null> | null>(null)

  const onDragStart = useCallback((e: React.DragEvent) => {
    if (!filePath) return
    e.preventDefault()
    const token = window.adfApi.prepareShareFile(filePath)
      .then((r) => (r.success && r.token ? r.token : null))
      .catch(() => null)
    issued.current = token
    void token.then((t) => {
      if (!t) return
      window.adfApi.startShareDrag(t)
      void markSharedOnce()
    })
  }, [filePath])

  const onDragEnd = useCallback(() => {
    const pending = issued.current
    if (!pending) return
    issued.current = null
    void pending.then((t) => (t ? window.adfApi.discardShareFile(t) : undefined)).catch(() => {})
  }, [])

  return {
    draggable: !!filePath,
    onDragStart,
    onDragEnd,
  }
}
