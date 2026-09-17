import { useMemo, useState } from 'react'
import { Dialog } from './Dialog'
import { useAppStore } from '../../stores/app.store'
import { useTrackedDirsStore } from '../../stores/tracked-dirs.store'
import { useAgentStore } from '../../stores/agent.store'
import { useShareDrag } from '../../hooks/useShareDrag'
import { Button } from '../ui'
import type { TrackedDirEntry } from '../../../shared/types/ipc.types'

function flatten(entries: TrackedDirEntry[], out: TrackedDirEntry[] = []): TrackedDirEntry[] {
  for (const e of entries) {
    if (e.isDirectory) flatten(e.children ?? [], out)
    else out.push(e)
  }
  return out
}

function stem(file: TrackedDirEntry): string {
  return file.agentName ?? file.fileName.replace(/\.adf$/i, '')
}

/**
 * Share = send someone a copy of the file, the way you would a PDF. The
 * dialog shows the file to grab, a drawing of where it can go, and a save
 * button for the keyboard. What the copy contains is behind a disclosure:
 * the app enforces it, so most people never need to read it.
 */
export function ShareAgentDialog() {
  const target = useAppStore((s) => s.shareDialogFilePath)
  const closeShareDialog = useAppStore((s) => s.closeShareDialog)
  const filesByDir = useTrackedDirsStore((s) => s.filesByDir)
  const openIcon = useAgentStore((s) => s.config?.icon)
  const openPath = useAppStore((s) => s.shareDialogFilePath)
  const [saved, setSaved] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const agents = useMemo(() => flatten(Object.values(filesByDir).flat()), [filesByDir])
  const featured = useMemo(() => (target ? agents.find((a) => a.filePath === target) ?? null : null), [agents, target])
  const others = useMemo(() => (featured ? agents.filter((a) => a.filePath !== featured.filePath) : agents), [agents, featured])

  const saveCopy = async (filePath: string) => {
    setSaving(true)
    setSaved(null)
    setSaveError(null)
    try {
      const r = await window.adfApi.saveShareCopy(filePath)
      if (r.success && r.filePath) setSaved(r.filePath)
      else if (r.error) setSaveError(r.error)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const name = featured ? stem(featured) : 'agent'
  const icon = featured && featured.filePath === openPath ? openIcon : undefined

  return (
    <Dialog open={target !== null} onClose={closeShareDialog} title="Share" wide>
      <div className="space-y-5">
        <p className="text-[13px] leading-relaxed text-[var(--adf-ui-text-muted)]">
          Drag the file into Messages, Mail, Slack, or a folder. They get their own copy,
          like a PDF you sent. Yours stays here and does not change.
        </p>

        <ShareIllustration name={name} icon={icon} />

        {featured ? (
          <div className="flex items-center gap-3">
            <FileTile file={featured} icon={icon} />
            <div className="min-w-0 flex-1 text-[12px] text-[var(--adf-ui-text-subtle)]">
              Grab this and drop it anywhere.
            </div>
            <Button size="compact" onClick={() => saveCopy(featured.filePath)} loading={saving}>
              Save copy…
            </Button>
          </div>
        ) : null}

        {others.length > 0 && (
          <div>
            {featured && (
              <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--adf-ui-text-subtle)]">
                Other agents
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {others.map((a) => (
                <SmallChip key={a.filePath} file={a} onSave={() => saveCopy(a.filePath)} />
              ))}
            </div>
          </div>
        )}
        {agents.length === 0 && (
          <p className="text-[12px] text-[var(--adf-ui-text-subtle)]">No agents.</p>
        )}

        {saved && <p className="text-[12px] text-[var(--adf-ui-text-muted)]">Saved to {saved}</p>}
        {saveError && <p className="text-[12px] text-[var(--adf-ui-danger)]">{saveError}</p>}

        <details className="group text-[12px]">
          <summary className="cursor-pointer select-none text-[var(--adf-ui-text-subtle)] hover:text-[var(--adf-ui-text)]">
            What's in the copy
          </summary>
          <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <TravelColumn
              title="Included"
              tone="ok"
              items={[
                'Config and agent instructions',
                'README, memory and files',
                'Loop history',
                'Lambdas, skills and tool settings',
                'Provider names and base URLs (no keys)',
              ]}
            />
            <TravelColumn
              title="Left out"
              tone="muted"
              items={[
                'Identity keys. The receiver claims a new identity',
                'Provider keys and sign-ins kept in app settings',
                'Credentials sealed to you, unless you set a share password; then they travel sealed and open only with it',
              ]}
            />
          </div>
        </details>
      </div>
    </Dialog>
  )
}

/** The draggable file, drawn like a document so it reads as "a file", not a button. */
function FileTile({ file, icon }: { file: TrackedDirEntry; icon?: string }) {
  const drag = useShareDrag(file.filePath)
  return (
    <div
      {...drag}
      className="flex cursor-grab select-none items-center gap-3 rounded-xl border border-[var(--adf-ui-border)] bg-[var(--adf-ui-surface-raised)] py-2 pl-2 pr-4 hover:border-[var(--adf-ui-accent)] active:cursor-grabbing"
    >
      <DocGlyph icon={icon} size={40} />
      <div className="min-w-0">
        <div className="text-[13px] font-semibold text-[var(--adf-ui-text)]">{stem(file)}</div>
        <div className="font-mono text-[10.5px] text-[var(--adf-ui-text-subtle)]">{file.fileName}</div>
      </div>
    </div>
  )
}

function SmallChip({ file, onSave }: { file: TrackedDirEntry; onSave: () => void }) {
  const drag = useShareDrag(file.filePath)
  return (
    <div
      {...drag}
      className="flex cursor-grab select-none items-center gap-1.5 rounded-lg border border-[var(--adf-ui-border)] bg-[var(--adf-ui-surface-raised)] py-1 pl-1.5 pr-1 text-[12px] hover:border-[var(--adf-ui-accent)] active:cursor-grabbing"
    >
      <DocGlyph size={20} />
      <span className="font-medium text-[var(--adf-ui-text)]">{stem(file)}</span>
      <button
        type="button"
        draggable={false}
        onDragStart={(e) => { e.preventDefault(); e.stopPropagation() }}
        onClick={onSave}
        className="ml-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--adf-ui-accent)] hover:bg-[var(--adf-ui-accent-subtle)]"
      >
        Save…
      </button>
    </div>
  )
}

/** A document icon with the agent's emoji on it, in the app's accent. */
function DocGlyph({ icon, size }: { icon?: string; size: number }) {
  return (
    <span className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }} aria-hidden>
      <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" className="text-[var(--adf-ui-accent)]">
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" fill="color-mix(in srgb, var(--adf-ui-accent) 12%, transparent)" />
        <path d="M14 3v5h5" />
      </svg>
      {icon && (
        <span className="absolute" style={{ fontSize: size * 0.42, bottom: size * 0.14 }}>{icon}</span>
      )}
    </span>
  )
}

/**
 * The gesture, drawn: the file on the left, a dashed path, a chat window on
 * the right with the file arriving as an attachment. Generic chat, no brand.
 */
function ShareIllustration({ name, icon }: { name: string; icon?: string }) {
  const label = `${name}.adf`
  return (
    <div className="relative overflow-hidden rounded-xl border border-[var(--adf-ui-border)] bg-[var(--adf-ui-canvas)] px-6 py-5" aria-hidden>
      <div className="flex items-center gap-4">
        {/* the file */}
        <div className="flex w-24 shrink-0 flex-col items-center gap-1.5">
          <DocGlyph icon={icon} size={52} />
          <span className="max-w-full truncate font-mono text-[10.5px] text-[var(--adf-ui-text-muted)]">{label}</span>
        </div>

        {/* the path */}
        <svg className="h-10 flex-1 text-[var(--adf-ui-text-subtle)]" viewBox="0 0 160 40" fill="none" preserveAspectRatio="none">
          <path d="M4 32 C 50 32, 70 8, 150 8" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 5" strokeLinecap="round" />
          <path d="M143 3 l8 5 -8 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>

        {/* the chat window */}
        <div className="w-56 shrink-0 overflow-hidden rounded-lg border border-[var(--adf-ui-border)] bg-[var(--adf-ui-surface)] shadow-sm">
          <div className="flex items-center gap-1.5 border-b border-[var(--adf-ui-separator)] px-2.5 py-1.5">
            <span className="h-2 w-2 rounded-full bg-[#ff5f57]" />
            <span className="h-2 w-2 rounded-full bg-[#febc2e]" />
            <span className="h-2 w-2 rounded-full bg-[#28c840]" />
            <span className="ml-2 h-2 w-16 rounded bg-[var(--adf-ui-separator)]" />
          </div>
          <div className="space-y-1.5 px-2.5 py-2.5">
            <div className="h-5 w-28 rounded-2xl rounded-bl-sm bg-[var(--adf-ui-separator)]" />
            <div className="ml-auto flex w-fit items-center gap-1.5 rounded-2xl rounded-br-sm bg-[var(--adf-ui-accent)] px-2 py-1 text-[10.5px] font-medium text-white dark:text-neutral-950">
              <DocGlyph size={14} />
              <span className="max-w-[110px] truncate">{label}</span>
            </div>
            <div className="h-5 w-20 rounded-2xl rounded-bl-sm bg-[var(--adf-ui-separator)]" />
          </div>
        </div>
      </div>
    </div>
  )
}

function TravelColumn({ title, items, tone }: { title: string; items: string[]; tone: 'ok' | 'muted' }) {
  return (
    <div className="rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] bg-[var(--adf-ui-canvas)] p-3">
      <div className={`mb-1.5 text-[11px] font-medium uppercase tracking-wide ${tone === 'ok' ? 'text-green-600 dark:text-green-400' : 'text-[var(--adf-ui-text-subtle)]'}`}>
        {title}
      </div>
      <ul className="space-y-1 text-[12px] text-[var(--adf-ui-text-muted)]">
        {items.map((item) => (
          <li key={item} className="flex gap-1.5">
            <span aria-hidden>{tone === 'ok' ? '✓' : '–'}</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
