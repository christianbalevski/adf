import { create } from 'zustand'

/** A request to show the compute sheet for the open agent's servers (ComputeSetupDialog). */
interface ComputeSetupStore {
  request: { filePath: string; servers: string[] } | null
  open: (filePath: string, servers: string[]) => void
  close: () => void
}

export const useComputeSetupStore = create<ComputeSetupStore>((set) => ({
  request: null,
  open: (filePath, servers) => set({ request: { filePath, servers } }),
  close: () => set({ request: null }),
}))
