import React, { createContext, useContext } from 'react'
import type { AdfApi } from '../../../preload/api'
import type { RuntimeId } from '../../../shared/runtime-tag'
import { apiFor } from '../../utils/runtime-api'
import { useRuntimes } from '../../stores/runtimes.store'
import { RemoteMark } from '../common/RemoteMark'

/**
 * The runtime the Settings picker shows (docs/design/multi-runtime.md §6.3).
 * Every runtime page, and the panels it renders (providers, MCP servers,
 * channels, templates, usage), calls `useSettingsApi()`: the picked
 * runtime's surface. Outside Settings there is no picker, and the surface is
 * `window.adfApi`, as before. With This computer only, that is always the
 * surface.
 */
const SettingsRuntimeContext = createContext<RuntimeId | null>(null)

export function SettingsRuntimeProvider({ runtimeId, children }: { runtimeId: RuntimeId; children: React.ReactNode }) {
  return <SettingsRuntimeContext.Provider value={runtimeId}>{children}</SettingsRuntimeContext.Provider>
}

/** The surface of the runtime the Settings picker shows; `window.adfApi` outside Settings. */
export function useSettingsApi(): AdfApi {
  const runtimeId = useContext(SettingsRuntimeContext)
  // No window (static rendering in tests): no surface; calls happen in effects and handlers.
  if (typeof window === 'undefined') return undefined as unknown as AdfApi
  return runtimeId === null ? window.adfApi : apiFor(runtimeId)
}

/** The picked runtime's id; null outside Settings. */
export function useSettingsRuntimeId(): RuntimeId | null {
  return useContext(SettingsRuntimeContext)
}

/**
 * Above every runtime page while more than one runtime is in the set
 * (multi-runtime.md §6.3): the picked runtime's name, with the remote icon
 * for a remote. Nothing with one runtime, and nothing outside Settings.
 */
export function SettingsRuntimeBanner() {
  const runtimeId = useSettingsRuntimeId()
  const runtimes = useRuntimes()
  const runtime = runtimeId === null || runtimes.length < 2 ? null : runtimes.find((r) => r.id === runtimeId)
  if (!runtime) return null
  return (
    <div
      className="mb-5 flex items-center gap-1.5 rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-separator)] bg-[var(--adf-ui-surface)] px-3 py-1.5 text-[12px] font-medium text-[var(--adf-ui-text)]"
      data-runtime-banner={runtime.id}
    >
      {runtime.kind === 'remote' && <RemoteMark />}
      <span className="truncate">{runtime.name}</span>
    </div>
  )
}
