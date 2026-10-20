/**
 * Settings → Prompts editors. A prompt reaches every agent, so a keystroke
 * never does: the text is a draft until Save, and Revert puts the saved text
 * back. Reset shows only while the saved prompt differs from the default; it
 * saves the default at once and offers Undo.
 */
import { Button, Textarea } from '../ui'

export interface PromptEditorProps {
  /** Accessible name of the text field. */
  label: string
  /** The saved text. */
  value: string
  defaultValue: string
  /** The unsaved text, or undefined when there is none. */
  draft: string | undefined
  onDraft: (next: string | undefined) => void
  /** Write the text; resolves true once saved. */
  onSave: (next: string) => Promise<boolean>
  /** Reset to the default (the caller saves it and offers Undo). */
  onReset: () => void
  rows: number
}

/** The editor's state: an unsaved draft, and a saved text that is not the default. */
export function promptEditorState(value: string, defaultValue: string, draft: string | undefined): { dirty: boolean; modified: boolean } {
  return { dirty: draft !== undefined && draft !== value, modified: value !== defaultValue }
}

export function PromptEditor({ label, value, defaultValue, draft, onDraft, onSave, onReset, rows }: PromptEditorProps) {
  const { dirty, modified } = promptEditorState(value, defaultValue, draft)
  const shown = draft ?? value
  return (
    <div>
      <Textarea
        aria-label={label}
        value={shown}
        onChange={(e) => onDraft(e.target.value === value ? undefined : e.target.value)}
        rows={rows}
        className="font-mono text-xs resize-y"
      />
      <div className="mt-1.5 flex min-h-[26px] items-center gap-2">
        {dirty && <span className="text-[11px] text-[var(--adf-ui-text-subtle)]">Unsaved</span>}
        <span className="flex-1" />
        {modified && !dirty && (
          <Button onClick={onReset} variant="ghost" size="compact">Reset</Button>
        )}
        {dirty && (
          <>
            <Button onClick={() => onDraft(undefined)} variant="ghost" size="compact">Revert</Button>
            <Button onClick={() => { void onSave(shown).then((saved) => { if (saved) onDraft(undefined) }) }} variant="primary" size="compact">Save</Button>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * Collapsible prompt rows, shared by the Tool instructions and Dynamic
 * instructions groups. Both read and write the same `toolPrompts` record —
 * they differ only in which default/label/condition tables drive the rows.
 */
export function PromptSectionRows({ defaults, labels, conditions, values, drafts, onDraft, onSave, onReset, expandedKey, onToggle }: {
  defaults: Record<string, string>
  labels: Record<string, string>
  conditions: Record<string, string>
  values: Record<string, string>
  drafts: Record<string, string>
  onDraft: (key: string, next: string | undefined) => void
  onSave: (key: string, next: string) => Promise<boolean>
  onReset: (key: string) => void
  expandedKey: string | null
  onToggle: (key: string | null) => void
}) {
  return (
    <div className="space-y-1">
      {Object.keys(defaults).map((key) => {
        const label = labels[key] ?? key
        const condition = conditions[key]
        const isExpanded = expandedKey === key
        const value = values[key] ?? defaults[key] ?? ''
        const { dirty, modified } = promptEditorState(value, defaults[key] ?? '', drafts[key])

        return (
          <div key={key} className="overflow-hidden rounded-lg border border-[var(--adf-ui-border)]">
            <button
              onClick={() => onToggle(isExpanded ? null : key)}
              aria-expanded={isExpanded}
              className="flex w-full items-center justify-between px-3 py-2 text-left transition-colors hover:bg-[var(--adf-ui-surface-hover)]"
            >
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-[var(--adf-ui-text-subtle)]">{isExpanded ? '▼' : '▶'}</span>
                <span className="text-xs font-medium text-[var(--adf-ui-text)]">{label}</span>
                {modified && (
                  <span className="rounded bg-[var(--adf-ui-warning-subtle)] px-1 py-0.5 text-[11px] text-[var(--adf-ui-warning)]">Modified</span>
                )}
                {dirty && (
                  <span className="rounded bg-[var(--adf-ui-surface-hover)] px-1 py-0.5 text-[11px] text-[var(--adf-ui-text-muted)]">Unsaved</span>
                )}
              </div>
            </button>
            {isExpanded && (
              <div className="border-t border-[var(--adf-ui-separator)] px-3 pb-3">
                {condition && <p className="mt-2 text-[11px] italic text-[var(--adf-ui-text-subtle)]">{condition}</p>}
                <div className="mt-2">
                  <PromptEditor
                    label={`${label} instruction`}
                    value={value}
                    defaultValue={defaults[key] ?? ''}
                    draft={drafts[key]}
                    onDraft={(next) => onDraft(key, next)}
                    onSave={(next) => onSave(key, next)}
                    onReset={() => onReset(key)}
                    rows={10}
                  />
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
