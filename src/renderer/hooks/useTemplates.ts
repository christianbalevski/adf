import { useEffect } from 'react'
import { create } from 'zustand'
import type { AgentTemplateListResult, AgentTemplateSummary } from '../../shared/types/ipc.types'
import type { RuntimeId } from '../../shared/runtime-tag'
import { apiFor } from '../utils/runtime-api'
import { windowRuntime } from '../utils/window-kind'

/**
 * The templates folder as the renderer sees it: one list shared by the
 * Settings tab and the home composer's chip, refreshed whenever main reports
 * the folder changed (drop-in, delete, edit) and after our own writes.
 *
 * The top-level list is this window's runtime's (This computer in the main
 * window), as before. Settings showing another runtime (multi-runtime.md
 * §6.3) reads that runtime's list into `byRuntime`.
 */
interface TemplatesSlice {
  templates: AgentTemplateSummary[]
  folder: string
  defaultId: string
  migrated: { id: string } | null
  loaded: boolean
}

interface TemplatesState extends TemplatesSlice {
  byRuntime: Record<RuntimeId, TemplatesSlice>
  /** `runtimeId`: the runtime whose list is read; omitted, this window's. */
  refresh: (runtimeId?: RuntimeId | null) => Promise<void>
}

const EMPTY_SLICE: TemplatesSlice = { templates: [], folder: '', defaultId: 'standard', migrated: null, loaded: false }

/** The window's own runtime: its list is the top-level one. */
const isTop = (runtimeId?: RuntimeId | null): boolean => !runtimeId || runtimeId === windowRuntime

const inFlight = new Map<RuntimeId, Promise<void>>()

export const useTemplatesStore = create<TemplatesState>((set) => {
  const write = (runtimeId: RuntimeId | null | undefined, patch: Partial<TemplatesSlice>) =>
    set((s) => (isTop(runtimeId) ? patch : { byRuntime: { ...s.byRuntime, [runtimeId!]: { ...(s.byRuntime[runtimeId!] ?? EMPTY_SLICE), ...patch } } }))
  return {
    ...EMPTY_SLICE,
    byRuntime: {},
    refresh: (runtimeId) => {
      const key = isTop(runtimeId) ? windowRuntime : runtimeId!
      const pending = inFlight.get(key)
      if (pending) return pending
      const run: Promise<void> = (isTop(runtimeId) ? window.adfApi : apiFor(runtimeId))
        .listTemplates()
        .then((result: AgentTemplateListResult) => {
          write(runtimeId, {
            templates: result.templates,
            folder: result.folder,
            defaultId: result.defaultId,
            migrated: result.migrated ?? null,
            loaded: true
          })
        })
        .catch((err: unknown) => {
          console.error(`[templates] list failed${isTop(runtimeId) ? '' : ` on ${runtimeId}`}:`, err)
          write(runtimeId, { loaded: true })
        })
        .finally(() => {
          inFlight.delete(key)
        })
      inFlight.set(key, run)
      return run
    }
  }
})

/** The list of `runtimeId` (omitted: this window's runtime). */
export function selectTemplates(s: TemplatesState, runtimeId?: RuntimeId | null): TemplatesSlice {
  return isTop(runtimeId) ? s : s.byRuntime[runtimeId!] ?? EMPTY_SLICE
}

/**
 * Loads the list on first use and keeps it current while any subscriber is
 * mounted. `runtimeId`: the runtime whose list it is (Settings' picked one);
 * omitted, this window's.
 */
export function useTemplates(runtimeId?: RuntimeId | null): TemplatesSlice & { refresh: () => Promise<void> } {
  const top = isTop(runtimeId)
  const slice = useTemplatesStore((s) => selectTemplates(s, runtimeId))
  useEffect(() => {
    const id = top ? undefined : runtimeId
    void useTemplatesStore.getState().refresh(id)
    const off = (top ? window.adfApi : apiFor(id)).onTemplatesChanged(() => {
      void useTemplatesStore.getState().refresh(id)
    })
    return off
  }, [top, runtimeId])
  return { ...slice, refresh: () => useTemplatesStore.getState().refresh(top ? undefined : runtimeId) }
}


/** The template the composer will use: the picked one, else the default, else null while loading. */
export function resolveTemplate(templates: AgentTemplateSummary[], defaultId: string, pickedId: string | null): AgentTemplateSummary | null {
  if (pickedId) {
    const picked = templates.find((t) => t.id === pickedId)
    if (picked) return picked
  }
  return templates.find((t) => t.id === defaultId) ?? null
}
