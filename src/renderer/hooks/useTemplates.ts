import { useEffect } from 'react'
import { create } from 'zustand'
import type { AgentTemplateListResult, AgentTemplateSummary } from '../../shared/types/ipc.types'

/**
 * The templates folder as the renderer sees it: one list shared by the
 * Settings tab and the home composer's chip, refreshed whenever main reports
 * the folder changed (drop-in, delete, edit) and after our own writes.
 */
interface TemplatesState {
  templates: AgentTemplateSummary[]
  folder: string
  defaultId: string
  migrated: { id: string } | null
  loaded: boolean
  refresh: () => Promise<void>
}

let inFlight: Promise<void> | null = null

export const useTemplatesStore = create<TemplatesState>((set) => ({
  templates: [],
  folder: '',
  defaultId: 'standard',
  migrated: null,
  loaded: false,
  refresh: () => {
    if (inFlight) return inFlight
    const run: Promise<void> = window.adfApi
      .listTemplates()
      .then((result: AgentTemplateListResult) => {
        set({
          templates: result.templates,
          folder: result.folder,
          defaultId: result.defaultId,
          migrated: result.migrated ?? null,
          loaded: true
        })
      })
      .catch((err: unknown) => {
        console.error('[templates] list failed:', err)
        set({ loaded: true })
      })
      .finally(() => {
        inFlight = null
      })
    inFlight = run
    return run
  }
}))

/** Loads the list on first use and keeps it current while any subscriber is mounted. */
export function useTemplates(): TemplatesState {
  const state = useTemplatesStore()
  useEffect(() => {
    void useTemplatesStore.getState().refresh()
    const off = window.adfApi.onTemplatesChanged(() => {
      void useTemplatesStore.getState().refresh()
    })
    return off
  }, [])
  return state
}

/** The template the composer will use: the picked one, else the default, else null while loading. */
export function resolveTemplate(templates: AgentTemplateSummary[], defaultId: string, pickedId: string | null): AgentTemplateSummary | null {
  if (pickedId) {
    const picked = templates.find((t) => t.id === pickedId)
    if (picked) return picked
  }
  return templates.find((t) => t.id === defaultId) ?? null
}
