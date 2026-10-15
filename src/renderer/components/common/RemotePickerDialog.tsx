/**
 * The daemon-side picker (remote mode, design §9.3). Studio main asks for a
 * pick when a native dialog would choose a path on this computer, which a
 * remote daemon cannot open: an agent to open, a folder (track, upload, the
 * agents folder), or a folder plus a name for a new agent. The listing comes
 * from the daemon's GET /fs/browse: folders and .adf files inside its
 * browse roots, never other files.
 *
 * Mounted once at the app root; it shows nothing until main asks.
 */

import { useCallback, useEffect, useState } from 'react'
import { Dialog } from './Dialog'
import { Button, TextInput } from '../ui'
import type { RemoteBrowseListing, RemotePickAnswer, RemotePickRequest } from '../../../shared/types/backend.types'

const ROOT_LABELS: Record<RemoteBrowseListing['roots'][number]['kind'], string> = {
  home: 'Home folder',
  tracked: 'Tracked folder',
  agents: 'Agents folder',
  configured: 'Daemon browse root',
}

const INVALID_NAME = /[<>:"/\\|?*\u0000-\u001f]/

function nameProblem(name: string): string | null {
  const n = name.trim().replace(/\.adf$/i, '')
  if (!n) return 'Enter a name.'
  if (n.length > 64) return 'The name is longer than 64 characters.'
  if (INVALID_NAME.test(n) || n.endsWith('.') || n.endsWith(' ')) return 'The name contains characters not allowed in file names.'
  return null
}

export function RemotePickerHost() {
  const [queue, setQueue] = useState<RemotePickRequest[]>([])
  const request = queue[0] ?? null

  useEffect(() => window.adfApi?.onRemotePickerRequest?.((next) => setQueue((q) => [...q, next])), [])

  const finish = useCallback((answer: RemotePickAnswer | null) => {
    if (!request) return
    void window.adfApi.respondRemotePicker(request.requestId, answer).catch(() => {})
    setQueue((q) => q.slice(1))
  }, [request])

  if (!request) return null
  return <RemotePickerDialog key={request.requestId} request={request} onDone={finish} />
}

function RemotePickerDialog({ request, onDone }: { request: RemotePickRequest; onDone: (answer: RemotePickAnswer | null) => void }) {
  const [listing, setListing] = useState<RemoteBrowseListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const [name, setName] = useState(request.defaultName ?? '')
  const [confirmReplace, setConfirmReplace] = useState(false)
  /** The folder field: shows the listed folder; a typed or pasted daemon path opens on Enter. */
  const [pathDraft, setPathDraft] = useState('')

  const browse = useCallback(async (path: string | null) => {
    setLoading(true)
    setError(null)
    setSelected(null)
    setConfirmReplace(false)
    try {
      const result = await window.adfApi.browseRemoteFolder({ ...(path ? { path } : {}), showHidden })
      if ('error' in result) setError(result.error)
      else {
        setListing(result)
        setPathDraft(result.path ?? '')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [showHidden])

  useEffect(() => { void browse(listing?.path ?? null) }, [showHidden]) // eslint-disable-line react-hooks/exhaustive-deps

  const folder = listing?.path ?? null
  const entries = (listing?.entries ?? []).filter((e) => request.kind !== 'folder' || e.kind === 'directory')
  const fileName = `${name.trim().replace(/\.adf$/i, '')}.adf`
  const exists = request.kind === 'save-adf' && entries.some((e) => e.kind === 'adf' && e.name.toLowerCase() === fileName.toLowerCase())
  const problem = request.kind === 'save-adf' ? nameProblem(name) : null

  const choose = () => {
    if (request.kind === 'open-adf') {
      if (selected) onDone({ path: selected })
      return
    }
    if (!folder) return
    if (request.kind === 'folder') {
      onDone({ path: folder })
      return
    }
    if (problem) return
    if (exists && !confirmReplace) {
      setConfirmReplace(true)
      return
    }
    onDone({ directory: folder, name: name.trim().replace(/\.adf$/i, ''), ...(exists ? { replace: true } : {}) })
  }

  const actionLabel = request.kind === 'open-adf' ? 'Open' : request.kind === 'folder' ? 'Choose this folder' : confirmReplace ? 'Replace' : 'Create'
  const canChoose = request.kind === 'open-adf' ? !!selected : request.kind === 'folder' ? !!folder : !!folder && !problem

  return (
    <Dialog open onClose={() => onDone(null)} title={request.title} wide lightDismiss={false}>
      <p className="mb-2 text-[12px] text-[var(--adf-ui-text-muted)]">
        Folders on <span className="font-medium text-[var(--adf-ui-text)]">{request.host}</span>, where the ADF daemon runs.
      </p>

      <div className="mb-2 flex items-center gap-2">
        <Button size="compact" disabled={loading || !folder} onClick={() => void browse(listing?.parent ?? null)} aria-label="Up one folder">
          ↑ Up
        </Button>
        <TextInput
          value={pathDraft}
          onChange={(e) => setPathDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && pathDraft.trim()) void browse(pathDraft.trim()) }}
          placeholder="Locations (type a folder path on the daemon host and press Enter)"
          aria-label={`Folder on ${request.host}`}
          spellCheck={false}
          className="font-mono"
        />
        <label className="flex items-center gap-1.5 text-[12px] text-[var(--adf-ui-text-muted)]">
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} className="rounded accent-[var(--adf-ui-accent)]" />
          Hidden
        </label>
      </div>

      <div className="mb-3 h-72 overflow-y-auto rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)]" role="listbox" aria-label={`Folders on ${request.host}`}>
        {loading && <p className="p-3 text-[12px] text-[var(--adf-ui-text-muted)]">Loading…</p>}
        {!loading && error && <p className="p-3 text-[12px] text-[var(--adf-ui-danger)]">{error}</p>}
        {!loading && !error && listing && (
          <>
            {folder === null && listing.roots.map((root) => (
              <button
                key={root.path}
                type="button"
                onClick={() => void browse(root.path)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-[var(--adf-ui-surface-hover)]"
              >
                <span aria-hidden>📁</span>
                <span className="min-w-0 flex-1 truncate font-mono">{root.path}</span>
                <span className="text-[var(--adf-ui-text-subtle)]">{ROOT_LABELS[root.kind]}</span>
              </button>
            ))}
            {folder !== null && entries.length === 0 && (
              <p className="p-3 text-[12px] text-[var(--adf-ui-text-muted)]">{request.kind === 'folder' ? 'No subfolders.' : 'No folders or agent files here.'}</p>
            )}
            {folder !== null && entries.map((entry) => {
              const isSelected = selected === entry.path
              return (
                <button
                  key={entry.path}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => {
                    if (entry.kind === 'directory') void browse(entry.path)
                    else if (request.kind === 'open-adf') setSelected(entry.path)
                    else if (request.kind === 'save-adf') { setName(entry.name.replace(/\.adf$/i, '')); setConfirmReplace(false) }
                  }}
                  onDoubleClick={() => { if (entry.kind === 'adf' && request.kind === 'open-adf') onDone({ path: entry.path }) }}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] ${isSelected ? 'bg-[var(--adf-ui-accent-subtle)]' : 'hover:bg-[var(--adf-ui-surface-hover)]'}`}
                >
                  <span aria-hidden>{entry.kind === 'directory' ? '📁' : '📄'}</span>
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                </button>
              )
            })}
            {listing.truncated && (
              <p className="px-3 py-1.5 text-[11px] text-[var(--adf-ui-text-subtle)]">This folder has more entries than the daemon lists; only the first ones are shown.</p>
            )}
          </>
        )}
      </div>

      {request.kind === 'save-adf' && (
        <div className="mb-3">
          <TextInput
            value={name}
            onChange={(e) => { setName(e.target.value); setConfirmReplace(false) }}
            placeholder="Agent name"
            aria-label="Agent name"
            spellCheck={false}
            onKeyDown={(e) => { if (e.key === 'Enter') choose() }}
          />
          {problem && name.trim() !== '' && <p className="mt-1 text-[12px] text-[var(--adf-ui-danger)]">{problem}</p>}
          {confirmReplace && <p className="mt-1 text-[12px] text-[var(--adf-ui-danger)]">{fileName} already exists in this folder. Replace it?</p>}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button onClick={() => onDone(null)}>Cancel</Button>
        <Button variant={confirmReplace ? 'danger' : 'primary'} disabled={!canChoose || loading} onClick={choose}>
          {actionLabel}
        </Button>
      </div>
    </Dialog>
  )
}
