import { useEffect } from 'react'
import { useAppStore } from '../../stores/app.store'

export function ShutdownOverlay() {
  const shuttingDown = useAppStore((s) => s.shuttingDown)
  const setShuttingDown = useAppStore((s) => s.setShuttingDown)

  useEffect(() => {
    return window.adfApi.onShuttingDown(() => setShuttingDown(true))
  }, [setShuttingDown])

  if (!shuttingDown) return null

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-white/80 dark:bg-neutral-900/85 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-4">
        <svg
          className="h-8 w-8 animate-spin text-neutral-400 dark:text-neutral-500"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
          />
        </svg>
        <span className="text-sm font-medium text-neutral-500 dark:text-neutral-400">
          Shutting down...
        </span>
      </div>
    </div>
  )
}
