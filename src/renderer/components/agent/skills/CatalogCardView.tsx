import {
  installSlot,
  cardName,
  cardPath,
  sanitizeDisplayText,
  type CatalogCard
} from '../../../../shared/utils/skills-panel'
import { type ManifestState } from '../../../utils/skill-install'
import { CompatChip } from './CompatChip'

/** One card: a catalog entry, or a discovered package that may not have loaded yet. */
export function CatalogCardView({
  card,
  state,
  occupiedNames,
  installing,
  outcome,
  onOpen,
  onInstall
}: {
  card: CatalogCard
  state: ManifestState | undefined
  occupiedNames: Set<string>
  installing: boolean
  outcome?: { error?: string; notice?: string }
  onOpen: () => void
  onInstall: () => void
}) {
  const imported = state?.status === 'ready' ? state.import : null
  const name = cardName(card, imported?.ok ? { name: imported.name, description: imported.description } : null)
  const folder = card.kind === 'package' ? (card.pkg.dir.split('/').pop() || card.source.repository) : null
  const description = card.kind === 'entry' ? card.entry.description : imported?.ok ? imported.description : null
  const path = cardPath(card)
  const slot = installSlot(name, occupiedNames)
  const problem = card.kind === 'package' ? card.pkg.problem : undefined
  const refused = imported && !imported.ok ? imported.error : undefined
  const adjusted = imported?.ok && imported.changes.length > 0
  return (
    <div
      role="button"
      tabIndex={0}
      title={`Preview ${name ?? folder ?? ''}`}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
      className={`flex cursor-pointer flex-col rounded-lg border p-3 bg-white dark:bg-neutral-800 hover:border-blue-300 dark:hover:border-blue-700 ${
        outcome?.error ? 'border-red-300 dark:border-red-700' : 'border-neutral-200 dark:border-neutral-700'
      }`}
    >
      {/* The full name on its own row (it wraps, never elides); badges below it. */}
      <div className="break-all text-xs font-medium font-mono text-neutral-700 dark:text-neutral-300">
        {name ? sanitizeDisplayText(name) : <span className="italic text-[var(--adf-ui-text-subtle)]">{sanitizeDisplayText(folder)}</span>}
      </div>
      {(imported || slot.inUse) && (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {imported && <CompatChip compat={imported.compat} />}
          {adjusted && (
            <span title="Its frontmatter description is adjusted on install; the preview shows how." className="rounded bg-blue-100 dark:bg-blue-900/30 px-1.5 py-0.5 text-[9px] font-medium text-blue-700 dark:text-blue-300">
              Adjusted on install
            </span>
          )}
          {slot.badge && (
            <span title={slot.title} className="rounded bg-neutral-100 dark:bg-neutral-700/60 px-1.5 py-0.5 text-[9px] font-medium text-neutral-600 dark:text-neutral-300">
              {slot.badge}
            </span>
          )}
        </div>
      )}

      <p className="mt-1 text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400 line-clamp-3" title={sanitizeDisplayText(description)}>
        {description !== null
          ? sanitizeDisplayText(description)
          : state?.status === 'error'
            ? <span className="italic">SKILL.md could not be read: {sanitizeDisplayText(state.error)}</span>
            : <span className="italic">Loading SKILL.md…</span>}
      </p>
      {card.kind === 'package' && path && (
        <div className="mt-1 break-all font-mono text-[10px] text-[var(--adf-ui-text-subtle)]" title={path}>{sanitizeDisplayText(path)}</div>
      )}
      {(problem || refused) && (
        <p className="mt-1.5 text-[10px] text-red-600 dark:text-red-400">Can’t install: {sanitizeDisplayText(problem ?? refused)}</p>
      )}
      {outcome?.error && (
        <p className="mt-1.5 text-[10px] text-red-600 dark:text-red-400">Install failed: {sanitizeDisplayText(outcome.error)}</p>
      )}
      {outcome?.notice && (
        <p className="mt-1.5 text-[10px] text-green-600 dark:text-green-400">{sanitizeDisplayText(outcome.notice)}</p>
      )}

      <div className="mt-auto flex items-center gap-2 pt-2.5">
        <span className="min-w-0 truncate rounded bg-neutral-100 dark:bg-neutral-700/60 px-1.5 py-0.5 text-[9px] text-neutral-500 dark:text-neutral-400" title={card.sourceUrl}>
          {sanitizeDisplayText(card.sourceLabel)}
        </span>
        <div className="flex-1" />
        {!problem && !refused && (
          <button
            onClick={(e) => { e.stopPropagation(); onInstall() }}
            disabled={installing}
            title={adjusted ? 'Opens the preview: this package is adjusted on install.' : slot.title}
            className="shrink-0 px-2.5 py-1 text-[11px] font-medium text-neutral-700 dark:text-neutral-300 border border-neutral-300 dark:border-neutral-600 rounded-lg hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            {installing ? 'Installing…' : slot.action}
          </button>
        )}
      </div>
    </div>
  )
}
