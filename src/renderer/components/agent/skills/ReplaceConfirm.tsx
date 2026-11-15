import { useEffect, useRef } from 'react'
import { sanitizeDisplayText } from '../../../../shared/utils/skills-panel'
import { type PreparedInstall } from '../../../utils/skill-install'

/**
 * Installing into a slot that already has files is an explicit replacement:
 * the files it replaces and the files it keeps are both listed. Only the
 * replaced files were read for their revision before this was shown; a change
 * to any of them before Replace refuses the whole write. Kept files are not
 * written, so they are not checked.
 */
export function ReplaceConfirm({ prepared, onCancel, onReplace }: { prepared: PreparedInstall; onCancel: () => void; onReplace: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { cancelRef.current?.focus() }, [prepared])
  const created = prepared.files.length - prepared.replaces.length
  const list = (paths: string[]) => (
    <ul className="mt-1 max-h-24 overflow-y-auto font-mono text-[10px] text-neutral-500 dark:text-neutral-400">
      {paths.map((path) => <li key={path} className="break-all">{sanitizeDisplayText(path)}</li>)}
    </ul>
  )
  return (
    <div className="m-auto w-full max-w-lg rounded-lg border border-amber-300 dark:border-amber-600 bg-amber-50/50 dark:bg-amber-900/10 p-4">
      <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
        {prepared.replaces.length > 0 ? 'Replace existing files in' : 'Install into'} <span className="font-mono">skills/{sanitizeDisplayText(prepared.name)}/</span>{prepared.replaces.length > 0 ? '' : ', which already has files'}?
      </p>
      <p className="mt-1 text-[11px] text-neutral-600 dark:text-neutral-300">
        That folder already has files. Nothing records which package wrote them, so they may be from another
        package with the same name, another version, or local edits.
        {prepared.replaces.length > 0
          ? ` This replaces ${prepared.replaces.length} file${prepared.replaces.length !== 1 ? 's' : ''}${created > 0 ? ` and writes ${created} new` : ''}. If any file it replaces changes before you confirm, nothing is written.`
          : ` Nothing there is overwritten: this writes ${created} new file${created !== 1 ? 's' : ''} beside them.`}
      </p>
      {prepared.replaces.length > 0 && (
        <>
          <div className="mt-2 text-[10px] font-medium text-neutral-600 dark:text-neutral-300">Replaced</div>
          {list(prepared.replaces)}
        </>
      )}
      {prepared.keeps.length > 0 && (
        <>
          <div className="mt-2 text-[10px] font-medium text-neutral-600 dark:text-neutral-300">Kept as they are (not part of this package)</div>
          {list(prepared.keeps)}
        </>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <button
          ref={cancelRef}
          onClick={onCancel}
          className="px-3 py-1.5 text-xs font-medium text-neutral-700 dark:text-neutral-300 border border-neutral-300 dark:border-neutral-600 rounded-lg hover:bg-neutral-50 dark:hover:bg-neutral-800 cursor-pointer"
        >
          Cancel
        </button>
        <button
          onClick={onReplace}
          className="px-3 py-1.5 text-xs font-medium bg-amber-600 text-white hover:bg-amber-700 rounded-lg cursor-pointer"
        >
          {prepared.replaces.length > 0 ? 'Replace files' : 'Install beside them'}
        </button>
      </div>
    </div>
  )
}
