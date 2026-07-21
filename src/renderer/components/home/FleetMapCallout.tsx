import { useAppStore } from '../../stores/app.store'

export function FleetMapCallout() {
  const setShowMeshGraph = useAppStore((s) => s.setShowMeshGraph)
  const setShowSettings = useAppStore((s) => s.setShowSettings)

  return (
    <div className="w-full max-w-3xl px-4">
      <button
        type="button"
        onClick={() => {
          setShowSettings(false)
          setShowMeshGraph(true)
        }}
        className="group relative w-full overflow-hidden rounded-xl border border-blue-200/80 dark:border-blue-800/70 bg-gradient-to-r from-blue-50 via-white to-emerald-50 dark:from-blue-950/40 dark:via-neutral-900 dark:to-emerald-950/30 px-4 py-3.5 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-blue-300 dark:hover:border-blue-700 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-blue-500/50"
      >
        <svg
          aria-hidden="true"
          className="absolute -right-5 -top-8 h-28 w-28 text-blue-500/[0.06] dark:text-blue-300/[0.06] transition-transform duration-300 group-hover:scale-105 group-hover:-rotate-3"
          viewBox="0 0 48 48"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M24 3 42 13.5v21L24 45 6 34.5v-21L24 3Z" />
          <path d="m24 12 10 6v12l-10 6-10-6V18l10-6Z" />
        </svg>

        <span className="relative flex items-center gap-3.5">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-blue-200/80 bg-white/80 text-blue-600 shadow-sm dark:border-blue-700/70 dark:bg-blue-950/60 dark:text-blue-300">
            <svg aria-hidden="true" width="32" height="32" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M24 3 42 13.5v21L24 45 6 34.5v-21L24 3Z" />
              <path d="m15 29 9-10 9 10" />
              <circle cx="15" cy="29" r="2.5" fill="currentColor" stroke="none" />
              <circle cx="24" cy="19" r="2.5" fill="currentColor" stroke="none" />
              <circle cx="33" cy="29" r="2.5" fill="currentColor" stroke="none" />
            </svg>
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-neutral-800 dark:text-neutral-100">
              Manage your fleet in Age of Agents
            </span>
            <span className="mt-0.5 block text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
              Open the live fleet map of agents to monitor activity and coordinate work across runtimes.
            </span>
          </span>
          <span className="shrink-0 text-neutral-400 transition-transform group-hover:translate-x-1 group-hover:text-blue-500 dark:text-neutral-500 dark:group-hover:text-blue-400" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m9 18 6-6-6-6" />
            </svg>
          </span>
        </span>
      </button>
    </div>
  )
}
