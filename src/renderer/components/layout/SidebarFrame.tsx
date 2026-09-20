import { useLayoutEffect, type ReactNode } from 'react'
import {
  useAppStore,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_MAX_VW
} from '../../stores/app.store'
import { useDragResize } from '../../hooks/useDragResize'
import { SIDEBAR_WIDTH_KEY, saveStoredSize } from '../../utils/stored-size'

/**
 * The sidebar's width as a CSS variable. The frame and TitleBar's left pane
 * both size from it, so a drag moves the two together by writing one property
 * and re-renders nothing.
 */
export const SIDEBAR_WIDTH_VAR = '--adf-sidebar-width'

function paintSidebarWidth(width: number): void {
  document.documentElement.style.setProperty(SIDEBAR_WIDTH_VAR, `${width}px`)
}

/**
 * Sizes the sidebar and owns its drag handle. The sidebar is passed as
 * `children`, so committing a new width re-renders this wrapper and not the
 * whole agent tree.
 */
export function SidebarFrame({ children }: { children: ReactNode }) {
  const collapsed = useAppStore((s) => s.sidebarCollapsed)
  const width = useAppStore((s) => s.sidebarWidth)
  const setWidth = useAppStore((s) => s.setSidebarWidth)

  // Before paint, so the first frame is already at the stored width.
  useLayoutEffect(() => paintSidebarWidth(width), [width])

  const handleMouseDown = useDragResize({
    axis: 'x',
    grow: 1,
    min: SIDEBAR_WIDTH_MIN,
    max: () => Math.min(SIDEBAR_WIDTH_MAX, Math.round(window.innerWidth * SIDEBAR_MAX_VW / 100)),
    getStart: () => width,
    onDrag: paintSidebarWidth,
    onCommit: (w) => {
      setWidth(w)
      saveStoredSize(SIDEBAR_WIDTH_KEY, w)
    }
  })

  const resetWidth = () => {
    setWidth(SIDEBAR_WIDTH_DEFAULT)
    saveStoredSize(SIDEBAR_WIDTH_KEY, SIDEBAR_WIDTH_DEFAULT)
  }

  // The collapsed rail sizes itself and has nothing to drag. Same wrapper
  // either way, so collapsing never remounts the sidebar (search, scroll).
  return (
    <div
      className="relative shrink-0 flex"
      style={collapsed ? undefined : { width: `var(${SIDEBAR_WIDTH_VAR})`, maxWidth: `${SIDEBAR_MAX_VW}vw` }}
    >
      {children}
      {/* Straddles the edge instead of sitting in the flow, so the sidebar and
          the stage still meet with no gap between them. */}
      {!collapsed && (
        <div
          onMouseDown={handleMouseDown}
          onDoubleClick={resetWidth}
          className="absolute inset-y-0 -right-0.5 z-10 w-1 cursor-col-resize hover:bg-blue-300 active:bg-blue-400 transition-colors bg-transparent"
        />
      )}
    </div>
  )
}
