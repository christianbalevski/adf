import { Fragment, useEffect, useMemo, useRef } from 'react'
import {
  installSlot,
  cardName,
  cardPath,
  isCatalogUrl,
  sanitizeDisplayText,
  type CatalogCard
} from '../../../../shared/utils/skills-panel'
import { importAs } from '../../../../shared/utils/skill-import'
import { renderMarkdownToSafeHtml, useMarkdownHighlightVersion } from '../../../utils/markdown'
import { elideMiddle, splitSkillDocument } from '../../../../shared/utils/skill-preview'
import { type ManifestState } from '../../../utils/skill-install'
import { CompatChip } from './CompatChip'

/**
 * Read a skill before installing it.
 *
 * The card shows a one-line description a publisher wrote about itself, while
 * SKILL.md is what actually lands in the agent's prompt. Everything here is
 * treated as hostile remote text — the frontmatter through the panel's
 * single-line sanitizer, the body through the block sanitizer that keeps line
 * breaks, and the markdown through the same marked + DOMPurify path the loop
 * renders model output with (utils/markdown.ts).
 *
 * What Install will do is stated before it is clicked: the name it installs
 * under, whether the package declares an ADF version, every file it writes,
 * and — when the description has to be adjusted for the ADF index — the
 * adjustment, with the original kept.
 */
export function SkillPreview({
  card,
  state,
  occupiedNames,
  installing,
  outcome,
  onBack,
  onInstall,
  onRetry
}: {
  card: CatalogCard
  state: ManifestState | undefined
  occupiedNames: Set<string>
  installing: boolean
  outcome?: { error?: string; notice?: string }
  onBack: () => void
  onInstall: () => void
  onRetry: () => void
}) {
  const backRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { backRef.current?.focus() }, [card.key])

  const parsed = useMemo(
    () => (state?.status === 'ready' ? splitSkillDocument(state.content) : null),
    [state]
  )
  const highlightVersion = useMarkdownHighlightVersion()
  const bodyHtml = useMemo(
    () => (parsed && parsed.body ? renderMarkdownToSafeHtml(parsed.body) : ''),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [parsed, highlightVersion]
  )
  const imported = state?.status === 'ready' ? importAs(state.import, card.kind === 'entry' ? card.entry.name : undefined) : null
  const name = cardName(card, imported?.ok ? { name: imported.name, description: imported.description } : null)
  const title = name ?? (card.kind === 'package' ? card.pkg.dir || card.source.repository : '')
  const files: Array<{ path: string; license?: boolean }> = card.kind === 'entry' ? card.entry.files ?? [] : card.pkg.files
  const slot = installSlot(name, occupiedNames)
  const problem = card.kind === 'package' ? card.pkg.problem : undefined
  const blocked = problem ?? (imported && !imported.ok ? imported.error : undefined)
  const linkable = isCatalogUrl(card.manifestUrl)

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1.5 text-[11px]">
        <button
          ref={backRef}
          onClick={onBack}
          className="shrink-0 rounded text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300 cursor-pointer"
        >
          ← Catalog
        </button>
        <span className="text-[var(--adf-ui-icon-muted)]">/</span>
        <span className="min-w-0 truncate font-mono text-neutral-600 dark:text-neutral-300">{sanitizeDisplayText(title)}</span>
      </div>

      <div className="mt-3 flex shrink-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="min-w-0 break-all text-xs font-medium font-mono text-neutral-700 dark:text-neutral-300">{sanitizeDisplayText(title)}</span>
            {imported && <CompatChip compat={imported.compat} showNative />}
            {slot.badge && (
              <span title={slot.title} className="shrink-0 rounded bg-neutral-100 dark:bg-neutral-700/60 px-1.5 py-0.5 text-[9px] font-medium text-neutral-600 dark:text-neutral-300">
                {slot.badge}
              </span>
            )}
            <span className="min-w-0 truncate rounded bg-neutral-100 dark:bg-neutral-700/60 px-1.5 py-0.5 text-[9px] text-neutral-500 dark:text-neutral-400" title={card.sourceUrl}>
              {sanitizeDisplayText(card.sourceLabel)}
            </span>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
            {sanitizeDisplayText(card.kind === 'entry' ? card.entry.description : imported?.ok ? imported.description : cardPath(card))}
          </p>
          {card.kind === 'package' && (
            <div className="mt-0.5 text-[10px] text-[var(--adf-ui-text-subtle)]">
              {sanitizeDisplayText(cardPath(card))} at commit <span className="font-mono">{card.source.sha.slice(0, 7)}</span>
              {card.source.ref !== card.source.sha && <> ({sanitizeDisplayText(card.source.ref)})</>}
            </div>
          )}
          <div className="mt-1 flex items-baseline gap-1.5 text-[10px]">
            {linkable ? (
              <a href={card.manifestUrl} target="_blank" rel="noopener noreferrer" title={card.manifestUrl} className="min-w-0 truncate font-mono text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300">
                {sanitizeDisplayText(elideMiddle(card.manifestUrl, 68))}
                <span aria-hidden> ↗</span>
              </a>
            ) : (
              <span title={card.manifestUrl} className="min-w-0 truncate font-mono text-[var(--adf-ui-text-subtle)]">
                {sanitizeDisplayText(elideMiddle(card.manifestUrl, 68))}
              </span>
            )}
          </div>
        </div>
        {!blocked && (
          <button
            onClick={onInstall}
            disabled={installing || state?.status !== 'ready'}
            title={slot.title}
            className="shrink-0 px-2.5 py-1 text-[11px] font-medium text-neutral-700 dark:text-neutral-300 border border-neutral-300 dark:border-neutral-600 rounded-lg hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            {installing ? 'Installing…' : slot.inUse ? slot.action : imported?.ok && imported.changes.length ? 'Install adjusted' : 'Install'}
          </button>
        )}
      </div>

      {blocked && (
        <p className="mt-2 shrink-0 text-[10px] text-red-600 dark:text-red-400">Can’t install: {sanitizeDisplayText(blocked)}</p>
      )}
      {outcome?.error && (
        <p className="mt-2 shrink-0 text-[10px] text-red-600 dark:text-red-400">Install failed: {sanitizeDisplayText(outcome.error)}</p>
      )}
      {outcome?.notice && (
        <p className="mt-2 shrink-0 text-[10px] text-green-600 dark:text-green-400">{sanitizeDisplayText(outcome.notice)} The Skills panel shows whether the index lists it.</p>
      )}

      {imported?.ok && imported.changes.length > 0 && (
        <div className="mt-2 shrink-0 rounded-lg border border-blue-300 dark:border-blue-700 bg-blue-50/50 dark:bg-blue-900/10 px-2.5 py-2 text-[10px] text-neutral-600 dark:text-neutral-300">
          <div className="font-medium text-blue-700 dark:text-blue-300">Adjusted on install, so the ADF skill index can read it</div>
          <ul className="mt-1 list-disc pl-4">
            {imported.changes.map((change) => <li key={change}>{sanitizeDisplayText(change)}</li>)}
          </ul>
          <div className="mt-1">Installed description: “{sanitizeDisplayText(imported.description)}”</div>
          <div className="mt-1 text-[var(--adf-ui-text-subtle)]">
            Only the frontmatter <span className="font-mono">description</span> changes. The full original description is added at the top of the body with a comment saying the file was adjusted on install and where it came from; every other line and file is installed as published.
          </div>
        </div>
      )}

      {files.length > 0 && (
        <div className="mt-2 shrink-0 rounded-lg border border-neutral-200 dark:border-neutral-700 px-2.5 py-2">
          <div className="text-[10px] text-[var(--adf-ui-text-subtle)]">
            Also installs {files.length} file{files.length !== 1 ? 's' : ''} under{' '}
            <span className="font-mono">skills/{sanitizeDisplayText(name ?? '<name>')}/</span>
            {card.kind === 'package' && ` (${Math.ceil(card.pkg.totalBytes / 1024)} KB in all)`}. Nothing is run.
          </div>
          <div className="mt-1 flex max-h-20 flex-wrap gap-x-2 gap-y-0.5 overflow-y-auto">
            {files.map((file) => (
              <span key={file.path} className="max-w-full truncate font-mono text-[10px] text-neutral-500 dark:text-neutral-400" title={file.license ? `${file.path} — license or notice file from a parent folder` : file.path}>
                {sanitizeDisplayText(file.path)}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-y-auto pr-1">
        {!state || state.status === 'loading' ? (
          <SkillPreviewSkeleton />
        ) : state.status === 'error' ? (
          <div className="m-auto py-8 text-center">
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              Could not read this skill: {sanitizeDisplayText(state.error)}
            </p>
            <button
              onClick={onRetry}
              className="mt-2 text-[11px] text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300 cursor-pointer"
            >
              Retry
            </button>
          </div>
        ) : (
          <>
            {parsed && parsed.fields.length > 0 && (
              <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg bg-neutral-50 dark:bg-neutral-800/60 px-2.5 py-2">
                {parsed.fields.map((field) => (
                  <Fragment key={field.key}>
                    <dt className="font-mono text-[10px] text-[var(--adf-ui-text-subtle)]">{sanitizeDisplayText(field.key)}</dt>
                    <dd className="min-w-0 break-words text-[11px] text-neutral-600 dark:text-neutral-300">{sanitizeDisplayText(field.value)}</dd>
                  </Fragment>
                ))}
              </dl>
            )}
            {bodyHtml ? (
              <div
                className="loop-markdown text-[12px] leading-relaxed text-neutral-700 dark:text-neutral-200"
                // Sanitized above by utils/markdown.ts — marked, then DOMPurify
                // with the loop's allowlist. Never raw remote HTML.
                dangerouslySetInnerHTML={{ __html: bodyHtml }}
              />
            ) : (
              <p className="m-auto py-6 text-center text-[11px] italic text-[var(--adf-ui-text-subtle)]">
                This SKILL.md has no body — only frontmatter.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/**
 * The shape of a SKILL.md, while one is on the wire.
 *
 * A centered "Loading…" line told the truth and looked like a bug: the pane it
 * sat in is a document, and one line of text in a document-sized space reads as
 * a failure. Standing in the frontmatter block and the first paragraphs instead
 * says what is coming, in the same pulsing-bar idiom the dashboard tiles use.
 */
function SkillPreviewSkeleton() {
  return (
    <div className="animate-pulse" role="status">
      <div className="mb-3 rounded-lg bg-neutral-50 dark:bg-neutral-800/60 px-2.5 py-2">
        <div className="flex items-center gap-3">
          <div className="h-2.5 w-10 rounded bg-neutral-200 dark:bg-neutral-700" />
          <div className="h-2.5 w-28 rounded bg-neutral-100 dark:bg-neutral-700/60" />
        </div>
        <div className="mt-2 flex items-center gap-3">
          <div className="h-2.5 w-14 rounded bg-neutral-200 dark:bg-neutral-700" />
          <div className="h-2.5 flex-1 rounded bg-neutral-100 dark:bg-neutral-700/60" />
        </div>
      </div>
      <div className="h-3.5 w-1/3 rounded bg-neutral-200 dark:bg-neutral-700" />
      <div className="mt-3 space-y-1.5">
        <div className="h-2.5 w-full rounded bg-neutral-100 dark:bg-neutral-700/60" />
        <div className="h-2.5 w-11/12 rounded bg-neutral-100 dark:bg-neutral-700/60" />
        <div className="h-2.5 w-4/5 rounded bg-neutral-100 dark:bg-neutral-700/60" />
      </div>
      <div className="mt-4 h-3 w-1/4 rounded bg-neutral-200 dark:bg-neutral-700" />
      <div className="mt-3 space-y-1.5">
        <div className="h-2.5 w-full rounded bg-neutral-100 dark:bg-neutral-700/60" />
        <div className="h-2.5 w-3/4 rounded bg-neutral-100 dark:bg-neutral-700/60" />
      </div>
      <span className="sr-only">Loading SKILL.md…</span>
    </div>
  )
}
