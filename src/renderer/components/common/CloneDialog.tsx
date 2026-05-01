import { useState, useEffect, useCallback } from 'react'
import { Dialog } from './Dialog'

interface TableInfo {
  name: string
  row_count: number
}

interface CloneDialogProps {
  open: boolean
  onClose: () => void
  filePath: string
  dirPath: string
  onCloned: () => void
}

const REQUIRED_TABLES = new Set(['adf_config', 'adf_meta'])
const IDENTITY_TABLE = 'adf_identity'

export function CloneDialog({ open, onClose, filePath, dirPath, onCloned }: CloneDialogProps) {
  const [tables, setTables] = useState<TableInfo[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [cloning, setCloning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError(null)
    window.adfApi.listTables(filePath).then((result) => {
      if (result.error) {
        setError(result.error)
        setTables([])
      } else {
        setTables(result.tables)
        // Select all by default, except adf_identity
        setSelected(new Set(result.tables.filter((t) => t.name !== IDENTITY_TABLE).map((t) => t.name)))
      }
      setLoading(false)
    })
  }, [open, filePath])

  const toggleTable = useCallback((name: string) => {
    if (REQUIRED_TABLES.has(name)) return
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(name)) {
        next.delete(name)
      } else {
        next.add(name)
      }
      return next
    })
  }, [])

  const optionalTables = tables.filter((t) => !REQUIRED_TABLES.has(t.name))
  const allOptionalSelected = optionalTables.every((t) => selected.has(t.name))

  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (allOptionalSelected) {
        // Deselect all optional
        for (const t of optionalTables) {
          next.delete(t.name)
        }
      } else {
        // Select all
        for (const t of optionalTables) {
          next.add(t.name)
        }
      }
      return next
    })
  }, [allOptionalSelected, optionalTables])

  const handleClone = async () => {
    setCloning(true)
    setError(null)
    const result = await window.adfApi.cloneFile(filePath, Array.from(selected))
    setCloning(false)
    if (result.success) {
      onCloned()
      onClose()
    } else {
      setError(result.error ?? 'Clone failed')
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Clone ADF">
      {loading ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">Loading tables...</p>
      ) : error && tables.length === 0 ? (
        <p className="text-sm text-red-500">{error}</p>
      ) : (
        <>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-3">
            Select which tables to include in the clone.
          </p>

          {/* Select / Deselect All */}
          <label className="flex items-center gap-2 px-2 py-1.5 mb-1 text-xs font-medium text-neutral-700 dark:text-neutral-200 cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-700/50 rounded">
            <input
              type="checkbox"
              checked={allOptionalSelected}
              onChange={toggleAll}
              className="rounded border-neutral-300 dark:border-neutral-600 text-blue-600 focus:ring-blue-500"
            />
            Select / Deselect All
          </label>

          <div className="border-t border-neutral-200 dark:border-neutral-700 my-1" />

          {/* Table list */}
          <div className="max-h-64 overflow-y-auto space-y-0.5">
            {tables.map((t) => {
              const isRequired = REQUIRED_TABLES.has(t.name)
              const isIdentity = t.name === IDENTITY_TABLE
              return (
                <label
                  key={t.name}
                  className={`flex items-center gap-2 px-2 py-1.5 text-xs rounded cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-700/50 ${
                    isRequired ? 'opacity-70' : ''
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(t.name)}
                    disabled={isRequired}
                    onChange={() => toggleTable(t.name)}
                    className="rounded border-neutral-300 dark:border-neutral-600 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="flex-1 text-neutral-700 dark:text-neutral-200">
                    {t.name}
                    {isRequired && (
                      <span className="ml-1 text-neutral-400 dark:text-neutral-500">(required)</span>
                    )}
                    {isIdentity && (
                      <span className="ml-1 text-amber-500 dark:text-amber-400" title="Contains API keys and private keys">
                        &#x26A0;
                      </span>
                    )}
                  </span>
                  <span className="text-neutral-400 dark:text-neutral-500 tabular-nums">
                    {t.row_count} {t.row_count === 1 ? 'row' : 'rows'}
                  </span>
                </label>
              )
            })}
          </div>

          {/* Identity warning */}
          {selected.has(IDENTITY_TABLE) && tables.some((t) => t.name === IDENTITY_TABLE) && (
            <div className="mt-3 p-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-xs text-amber-700 dark:text-amber-300">
              <strong>Warning:</strong> The <code className="px-1 bg-amber-100 dark:bg-amber-900/40 rounded">adf_identity</code> table
              contains API keys and private keys. Including it in the clone will duplicate these secrets.
            </div>
          )}

          {error && (
            <p className="mt-2 text-xs text-red-500">{error}</p>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2 mt-4">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700 rounded-lg"
            >
              Cancel
            </button>
            <button
              onClick={handleClone}
              disabled={cloning}
              className="px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg"
            >
              {cloning ? 'Cloning...' : 'Clone'}
            </button>
          </div>
        </>
      )}
    </Dialog>
  )
}
