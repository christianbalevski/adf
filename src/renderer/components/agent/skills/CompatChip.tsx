import { sanitizeDisplayText } from '../../../../shared/utils/skills-panel'
import { adfCompatLabel, type AdfCompat } from '../../../../shared/utils/skill-import'

/** The label chip: shown for a package that does not declare a valid `adf` version. */
export function CompatChip({ compat, showNative = false }: { compat: AdfCompat; showNative?: boolean }) {
  const label = adfCompatLabel(compat)
  if (label.native && !showNative) return null
  return (
    <span
      title={label.title}
      className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium ${
        label.native
          ? 'bg-neutral-100 dark:bg-neutral-700/60 text-neutral-600 dark:text-neutral-300'
          : 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400'
      }`}
    >
      {sanitizeDisplayText(label.text)}
    </span>
  )
}
