import { create } from 'zustand'

export interface NodeActivity {
  id: string
  toolName: string
  args?: string
  timestamp: number
  type: 'tool_start' | 'tool_result' | 'message_sent' | 'message_recv' | 'ask' | 'approval'
  isError?: boolean
}

export interface PendingInteraction {
  type: 'ask' | 'approval'
  requestId: string
  question?: string
  toolName?: string
  input?: unknown
}

interface EdgeAnimation {
  id: string
  from: string
  to: string
  channel?: string
  timestamp: number
}

const MAX_ACTIVITIES = 5
const ANIMATION_DURATION_MS = 1500
const CLEANUP_INTERVAL_MS = 3000

/**
 * Store state uses plain arrays/objects instead of Set/Map to avoid
 * referential instability with Zustand selectors.
 *
 * All nodes are always expanded at a fixed height.
 */
interface MeshGraphState {
  nodeActivities: Record<string, NodeActivity[]>
  pendingInteractions: Record<string, PendingInteraction>

  // Edge animation state
  activeAnimations: EdgeAnimation[]
  activeAnimationIndex: Record<string, EdgeAnimation>

  // Live message routes (filePath pairs) — ensures edges exist when animation fires
  liveRoutes: Record<string, { from: string; to: string }>

  // View state
  showLogDrawer: boolean

  // Actions
  seedActivities: (data: Record<string, NodeActivity[]>) => void
  addActivity: (filePath: string, activity: NodeActivity) => void
  resolveActivity: (filePath: string, toolName: string, isError: boolean) => void
  setPendingInteraction: (filePath: string, interaction: PendingInteraction | null) => void
  triggerEdgeAnimation: (from: string, to: string[], channel?: string) => void
  cleanupAnimations: () => void
  setShowLogDrawer: (show: boolean) => void
  reset: () => void
}

let activityCounter = 0

export const useMeshGraphStore = create<MeshGraphState>((set) => ({
  nodeActivities: {},
  pendingInteractions: {},
  activeAnimations: [],
  activeAnimationIndex: {},
  liveRoutes: {},
  showLogDrawer: false,

  seedActivities: (data) =>
    set((s) => {
      const merged = { ...s.nodeActivities }
      for (const [filePath, activities] of Object.entries(data)) {
        // Only seed if no real-time activities have arrived yet
        if (!merged[filePath] || merged[filePath].length === 0) {
          merged[filePath] = activities.slice(-MAX_ACTIVITIES)
        }
      }
      return { nodeActivities: merged }
    }),

  addActivity: (filePath, activity) =>
    set((s) => {
      const existing = s.nodeActivities[filePath] ?? []
      return {
        nodeActivities: { ...s.nodeActivities, [filePath]: [...existing, activity].slice(-MAX_ACTIVITIES) }
      }
    }),

  // Update the most recent tool_start for this tool with its result status
  resolveActivity: (filePath, toolName, isError) =>
    set((s) => {
      const activities = s.nodeActivities[filePath]
      if (!activities) return s
      // Find the last unresolved tool_start matching this tool name
      const idx = activities.findLastIndex(
        (a) => a.type === 'tool_start' && a.toolName === toolName && a.isError === undefined
      )
      if (idx === -1) return s
      const updated = [...activities]
      updated[idx] = { ...updated[idx], isError }
      return { nodeActivities: { ...s.nodeActivities, [filePath]: updated } }
    }),

  setPendingInteraction: (filePath, interaction) =>
    set((s) => {
      if (interaction) {
        return { pendingInteractions: { ...s.pendingInteractions, [filePath]: interaction } }
      } else {
        const { [filePath]: _, ...rest } = s.pendingInteractions
        return { pendingInteractions: rest }
      }
    }),

  triggerEdgeAnimation: (from, to, channel) =>
    set((s) => {
      const now = Date.now()
      const newAnimations = to.map((t) => ({
        id: `anim-${++activityCounter}`,
        from,
        to: t,
        channel,
        timestamp: now
      }))
      const allAnimations = [...s.activeAnimations, ...newAnimations]
      const index = { ...s.activeAnimationIndex }
      const routes = { ...s.liveRoutes }
      for (const a of newAnimations) {
        index[`${a.from}|${a.to}`] = a
        const routeKey = `${a.from}|${a.to}`
        routes[routeKey] = { from: a.from, to: a.to }
      }
      return { activeAnimations: allAnimations, activeAnimationIndex: index, liveRoutes: routes }
    }),

  cleanupAnimations: () =>
    set((s) => {
      const now = Date.now()
      const active = s.activeAnimations.filter((a) => now - a.timestamp < ANIMATION_DURATION_MS)
      if (active.length === s.activeAnimations.length) return s
      const index: Record<string, EdgeAnimation> = {}
      for (const a of active) {
        index[`${a.from}|${a.to}`] = a
      }
      return { activeAnimations: active, activeAnimationIndex: index }
    }),

  setShowLogDrawer: (show) => set({ showLogDrawer: show }),

  reset: () =>
    set({
      nodeActivities: {},
      pendingInteractions: {},
      activeAnimations: [],
      activeAnimationIndex: {},
      liveRoutes: {},
      showLogDrawer: false
    })
}))

export { CLEANUP_INTERVAL_MS, ANIMATION_DURATION_MS }
