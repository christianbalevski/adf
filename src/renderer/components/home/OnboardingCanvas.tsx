import { useState } from 'react'
import { useAdfFile } from '../../hooks/useAdfFile'
import { useTrackedDirs } from '../../hooks/useTrackedDirs'
import { useAppStore } from '../../stores/app.store'
import { RegistryGallery } from './RegistryGallery'

/**
 * Home until the first agent exists: the registry, then the other ways to
 * get an agent. Copying a registry agent opens it through the ordinary
 * review-then-claim flow, the same one a file from someone else goes
 * through. The dashboard takes over from the first agent on.
 */
export function OnboardingCanvas() {
  const { createFile, openFile } = useAdfFile()
  const { addDirectory } = useTrackedDirs()
  const setShowMeshGraph = useAppStore((s) => s.setShowMeshGraph)
  const [count, setCount] = useState<number | null>(null)

  return (
    <div className="relative w-full max-w-3xl px-4 pb-8">

      <header className="relative mb-6 mt-2 flex items-end justify-between gap-6">
        <div>
          <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--adf-ui-text-subtle)]">
            Agent registry{count !== null ? ` · ${count}` : ''}
          </div>
          <h1 className="text-[28px] font-semibold leading-none tracking-tight text-[var(--adf-ui-text)]">
            Pick your first agent.
          </h1>
          <p className="mt-3 text-[13px] leading-relaxed text-[var(--adf-ui-text-muted)] [text-wrap:balance]">
            Agents run locally. No account, no subscription. The only thing you add is
            your own model, cloud or local.
          </p>
        </div>
        <svg
          aria-hidden
          className="mr-2 h-14 w-14 shrink-0 text-[var(--adf-ui-accent)] opacity-25"
          viewBox="0 0 48 48"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M24 3 42 13.5v21L24 45 6 34.5v-21L24 3Z" />
          <path d="m24 12 10 6v12l-10 6-10-6V18l10-6Z" />
        </svg>
      </header>

      <div className="relative">
        <RegistryGallery limit={6} onCount={setCount} />
      </div>

      <section className="relative mt-8">
        <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--adf-ui-text-subtle)]">
          Or start from
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <StartTile
            label="New agent"
            description="A blank agent file"
            onClick={async () => { const r = await createFile('Untitled'); if (r?.success) setShowMeshGraph(false) }}
            icon={<path d="M12 5v14M5 12h14" />}
          />
          <StartTile
            label="Open .adf…"
            description="An agent file on disk"
            onClick={() => openFile()}
            icon={<><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6" /></>}
          />
          <StartTile
            label="Add directory…"
            description="A folder of agent files"
            onClick={() => addDirectory()}
            icon={<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />}
          />
        </div>
      </section>
    </div>
  )
}

function StartTile({ label, description, icon, onClick }: {
  label: string
  description: string
  icon: React.ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex items-center gap-3 rounded-xl border border-[var(--adf-ui-border)] bg-[var(--adf-ui-surface)] px-3.5 py-3 text-left transition-all hover:-translate-y-0.5 hover:border-[var(--adf-ui-accent)] hover:shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--adf-ui-focus)]"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--adf-ui-canvas)] text-[var(--adf-ui-text-muted)] transition-colors group-hover:bg-[var(--adf-ui-accent-subtle)] group-hover:text-[var(--adf-ui-accent)]">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          {icon}
        </svg>
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-[var(--adf-ui-text)]">{label}</span>
        <span className="block truncate text-[11.5px] text-[var(--adf-ui-text-subtle)]">{description}</span>
      </span>
    </button>
  )
}
