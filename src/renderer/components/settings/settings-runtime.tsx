import React, { createContext, useContext } from 'react'
import type { AdfApi } from '../../../preload/api'
import type { RuntimeId } from '../../../shared/runtime-tag'
import { apiFor } from '../../utils/runtime-api'
import { useRuntimes } from '../../stores/runtimes.store'
import { RemoteMark } from '../common/RemoteMark'
import { ServerIcon } from '../common/ServerIcons'

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
 * (multi-runtime.md §6.3): a quiet header strip, "Server", then the picked
 * server's icon and name (the remote icon for a remote). It reads as a
 * heading, not as a field. Nothing with one runtime, and nothing outside
 * Settings.
 */
export function SettingsRuntimeBanner() {
  const runtimeId = useSettingsRuntimeId()
  const runtimes = useRuntimes()
  const runtime = runtimeId === null || runtimes.length < 2 ? null : runtimes.find((r) => r.id === runtimeId)
  if (!runtime) return null
  return (
    <div
      className="mb-3 flex min-w-0 items-center gap-2 text-[12px] text-[var(--adf-ui-text-muted)]"
      data-runtime-banner={runtime.id}
    >
      <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--adf-ui-text-subtle)]">Server</span>
      <span aria-hidden="true" className="h-3 w-px bg-[var(--adf-ui-separator)]" />
      <span className="flex min-w-0 items-center gap-1.5 font-medium text-[var(--adf-ui-text)]">
        {runtime.kind === 'remote' ? <RemoteMark size={13} /> : <ServerIcon size={13} className="shrink-0 text-[var(--adf-ui-text-muted)]" />}
        <span className="truncate">{runtime.name}</span>
      </span>
    </div>
  )
}
