/**
 * Draws orbital avatars off the main thread. Building a Creature takes up to
 * 400k rejection samples, so a sidebar of agents drawn on the main thread
 * would stall the window. Replies with PNG bytes (transferred).
 */

import { renderOrbitalPng } from './orbital-render'
import type { OrbitalImageKind, OrbitalTheme } from '../../../shared/utils/orbital-cache-key'

export interface OrbitalRenderRequest {
  id: number
  seed: string
  theme: OrbitalTheme
  kind: OrbitalImageKind
}

export type OrbitalRenderReply =
  | { id: number; ok: true; png: ArrayBuffer }
  | { id: number; ok: false; error: string }

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<OrbitalRenderRequest>) => void) | null
  postMessage: (msg: OrbitalRenderReply, transfer?: Transferable[]) => void
}

scope.onmessage = (e) => {
  const req = e.data
  renderOrbitalPng(req).then(
    (png) => scope.postMessage({ id: req.id, ok: true, png }, [png]),
    (err) => scope.postMessage({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) })
  )
}
