import { createContext, useContext } from 'react'
import type { CommandRegistry } from '../commands/registry'
import type { ViewDefinition } from '../views/types'

export interface ShellContextValue {
  views: ViewDefinition[]
  registry: CommandRegistry
  /** Leave the TUI (agents keep running in the daemon). */
  exit: () => void
  /** Terminal rows left unused at the bottom (1 on Windows consoles: see index.tsx). */
  reserveRows?: number
  /** Terminal columns left unused on the right (1 with incremental rendering: see index.tsx). */
  reserveColumns?: number
}

export const ShellContext = createContext<ShellContextValue | null>(null)

export function useShell(): ShellContextValue {
  const value = useContext(ShellContext)
  if (!value) throw new Error('useShell must be used inside the TUI shell')
  return value
}

export function useView(id: string): ViewDefinition | undefined {
  return useShell().views.find(view => view.id === id)
}
