/** Suppress the right-button menu delivered after a pan, including over the dock. */
export function suppressPanContextMenu(target: EventTarget): () => void {
  const controller = new AbortController()
  const { signal } = controller
  const cancel = () => controller.abort()
  const inputOptions = { capture: true, signal }
  target.addEventListener('contextmenu', (event) => {
    if ((event as MouseEvent).button !== 2) return
    event.preventDefault()
    cancel()
  }, inputOptions)
  // A new gesture or keyboard shortcut owns its own menu.
  target.addEventListener('pointerdown', cancel, inputOptions)
  target.addEventListener('keydown', cancel, inputOptions)
  target.addEventListener('blur', cancel, { signal })
  return cancel
}
