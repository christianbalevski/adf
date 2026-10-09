/**
 * Cached orbital avatar bitmaps as object URLs. Lookup order: memory, then
 * the disk cache in main (userData/orbitals), then a render in the worker,
 * whose PNG is written back to disk. Concurrent requests for the same image
 * share one promise. URLs are never revoked: one static and at most one
 * strip per agent and theme.
 */

import type { OrbitalCacheRequest } from '../../../shared/utils/orbital-cache-key'
import type { OrbitalRenderReply, OrbitalRenderRequest } from './orbital-render.worker'
import { renderOrbitalPng } from './orbital-render'

const urls = new Map<string, string>()
const inflight = new Map<string, Promise<string | null>>()

const keyOf = (req: OrbitalCacheRequest): string => `${req.theme}|${req.kind}|${req.seed}`

let worker: Worker | null = null
/** Set when the worker cannot load at all; rendering then runs on this thread. */
let workerUnavailable = false
let nextId = 1
const pending = new Map<number, { resolve: (png: ArrayBuffer) => void; reject: (err: Error) => void }>()

function failAll(err: Error): void {
  for (const p of pending.values()) p.reject(err)
  pending.clear()
}

function getWorker(): Worker {
  if (worker) return worker
  const w = new Worker(new URL('./orbital-render.worker.ts', import.meta.url), { type: 'module' })
  w.onmessage = (e: MessageEvent<OrbitalRenderReply>) => {
    const reply = e.data
    const p = pending.get(reply.id)
    if (!p) return
    pending.delete(reply.id)
    if (reply.ok) p.resolve(reply.png)
    else p.reject(new Error(reply.error))
  }
  // A crashed worker fails what it held; the next request starts a new one.
  w.onerror = (e) => {
    // An error with no message before any reply means the script never loaded.
    if (!e.message) workerUnavailable = true
    failAll(new Error(e.message || 'orbital worker failed'))
    w.terminate()
    if (worker === w) worker = null
  }
  worker = w
  return w
}

function renderInWorker(req: OrbitalCacheRequest): Promise<ArrayBuffer> {
  if (typeof OffscreenCanvas === 'undefined') {
    return Promise.reject(new Error('orbital rendering needs OffscreenCanvas'))
  }
  if (workerUnavailable || typeof Worker === 'undefined') return renderOrbitalPng(req)
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    const msg: OrbitalRenderRequest = { id, seed: req.seed, theme: req.theme, kind: req.kind }
    getWorker().postMessage(msg)
  })
}

async function load(req: OrbitalCacheRequest): Promise<string | null> {
  const api = typeof window !== 'undefined' ? window.adfApi : undefined
  let bytes: Uint8Array | null = null
  try {
    bytes = (await api?.orbitalCacheGet?.(req)) ?? null
  } catch {
    bytes = null
  }
  if (!bytes) {
    const png = await renderInWorker(req).catch((err) => {
      if (!workerUnavailable) throw err
      return renderOrbitalPng(req)
    })
    bytes = new Uint8Array(png)
    api?.orbitalCachePut?.(req, bytes).catch(() => {})
  }
  return URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/png' }))
}

/** The object URL if it is already in memory, else null. */
export function peekOrbitalImage(req: OrbitalCacheRequest): string | null {
  return urls.get(keyOf(req)) ?? null
}

/** Resolves to an object URL for the PNG, or null when it could not be produced. */
export function loadOrbitalImage(req: OrbitalCacheRequest): Promise<string | null> {
  const key = keyOf(req)
  const hit = urls.get(key)
  if (hit) return Promise.resolve(hit)
  const running = inflight.get(key)
  if (running) return running
  const p = load(req).then(
    (url) => {
      if (url) urls.set(key, url)
      return url
    },
    (err) => {
      console.warn('[orbital] render failed:', err)
      return null
    }
  ).finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}
