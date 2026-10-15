/**
 * The daemon-side picker (remote mode, design §9.4). Studio main asks for a
 * pick when a native dialog would choose a path on this computer, which a
 * remote daemon cannot open: an agent to open, a folder (track, upload, the
 * agents folder), or a folder plus a name for a new agent. The listing comes
 * from the daemon's GET /fs/browse: folders and .adf files inside its
 * browse roots, never other files.
 *
 * Keyboard: arrow keys move through the list, Enter opens a folder or picks
 * an .adf (open), Backspace goes up. A typed folder path opens on Enter.
 *
 * Mounted once at the app root; it shows nothing until main asks.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Dialog } from './Dialog'
import { Button, TextInput } from '../ui'
import type { RemoteBrowseListing, RemotePickAnswer, RemotePickRequest } from '../../../shared/types/backend.types'

type Root = RemoteBrowseListing['roots'][number]
type Entry = RemoteBrowseListing['entries'][number]

const ROOT_LABELS: Record<Root['kind'], string> = {
  home: 'Home folder',
  tracked: 'Tracked folder',
  agents: 'Agents folder',
  configured: 'Daemon browse root',
}

const INVALID_NAME = /[<>:"/\\|?*\u0000-\u001f]/

function nameProblem(name: string, what: 'agent' | 'folder'): string | null {
  const n = what === 'agent' ? name.trim().replace(/\.adf$/i, '') : name.trim()
  if (!n) return 'Enter a name.'
  if (n.length > (what === 'agent' ? 64 : 255)) return `The name is longer than ${what === 'agent' ? 64 : 255} characters.`
  if (n === '.' || n === '..' || INVALID_NAME.test(n) || n.endsWith('.') || n.endsWith(' ')) return 'The name contains characters not allowed in file names.'
  return null
}

/** Is `child` `parent` or inside it? Paths as the daemon writes them (either separator; case-insensitive for a drive path). */
function inside(parent: string, child: string): boolean {
  const norm = (p: string) => {
    const s = p.replace(/\\/g, '/').replace(/\/+$/, '')
    return /^[A-Za-z]:/.test(s) ? s.toLowerCase() : s
  }
  const a = norm(parent)
  const b = norm(child)
  return b === a || b.startsWith(`${a}/`)
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  )
}

function FileIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  )
}

function UpIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="18 15 12 9 6 15" />
    </svg>
  )
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
  /** Index into the visible rows (roots or entries) for the keyboard. */
  const [cursor, setCursor] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const [name, setName] = useState(request.defaultName ?? '')
  const [confirmReplace, setConfirmReplace] = useState(false)
  /** The folder field: shows the listed folder; a typed or pasted daemon path opens on Enter. */
  const [pathDraft, setPathDraft] = useState('')
  const [newFolder, setNewFolder] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  /** Only the newest browse may set the listing: a slow answer for an older folder is dropped. */
  const browseSeq = useRef(0)
  const listRef = useRef<HTMLDivElement>(null)

  const browse = useCallback(async (path: string | null) => {
    const seq = ++browseSeq.current
    setLoading(true)
    setError(null)
    setSelected(null)
    setConfirmReplace(false)
    setCursor(0)
    try {
      const result = await window.adfApi.browseRemoteFolder({ ...(path ? { path } : {}), showHidden })
      if (seq !== browseSeq.current) return
      if ('error' in result) {
        // Nothing stays listed, so Choose cannot answer the previous folder.
        setListing(null)
        setError(result.error)
      } else {
        setListing(result)
        setPathDraft(result.path ?? '')
      }
    } catch (err) {
      if (seq !== browseSeq.current) return
      setListing(null)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (seq === browseSeq.current) setLoading(false)
    }
  }, [showHidden])

  useEffect(() => { void browse(listing?.path ?? null) }, [showHidden]) // eslint-disable-line react-hooks/exhaustive-deps

  const importOnly = request.within === 'import'
  const importRoots = (listing?.roots ?? []).filter((r) => r.kind === 'tracked' || r.kind === 'agents')
  const folder = listing?.path ?? null
  const roots = importOnly ? importRoots : (listing?.roots ?? [])
  const entries = (listing?.entries ?? []).filter((e) => request.kind !== 'folder' || e.kind === 'directory')
  const rows: Array<{ kind: 'root'; root: Root } | { kind: 'entry'; entry: Entry }> = folder === null
    ? roots.map((root) => ({ kind: 'root' as const, root }))
    : entries.map((entry) => ({ kind: 'entry' as const, entry }))
  const folderAllowed = folder !== null && (!importOnly || importRoots.some((r) => inside(r.path, folder)))
  const fileName = `${name.trim().replace(/\.adf$/i, '')}.adf`
  const exists = request.kind === 'save-adf' && entries.some((e) => e.kind === 'adf' && e.name.toLowerCase() === fileName.toLowerCase())
  const problem = request.kind === 'save-adf' ? nameProblem(name, 'agent') : null
  const ready = !loading && !error && listing !== null

  const choose = () => {
    if (!ready) return
    if (request.kind === 'open-adf') {
      if (selected) onDone({ path: selected })
      return
    }
    if (!folder || !folderAllowed) return
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

  const activate = (row: (typeof rows)[number] | undefined, viaKeyboard: boolean) => {
    if (!row) return
    if (row.kind === 'root') { void browse(row.root.path); return }
    const entry = row.entry
    if (entry.kind === 'directory') { void browse(entry.path); return }
    if (request.kind === 'open-adf') {
      if (viaKeyboard || selected === entry.path) onDone({ path: entry.path })
      else setSelected(entry.path)
    } else if (request.kind === 'save-adf') {
      setName(entry.name.replace(/\.adf$/i, ''))
      setConfirmReplace(false)
    }
  }

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const next = Math.max(0, Math.min(rows.length - 1, cursor + (e.key === 'ArrowDown' ? 1 : -1)))
      setCursor(next)
      const row = rows[next]
      if (row?.kind === 'entry' && row.entry.kind === 'adf' && request.kind === 'open-adf') setSelected(row.entry.path)
      listRef.current?.querySelector<HTMLElement>(`[data-row="${next}"]`)?.scrollIntoView({ block: 'nearest' })
    } else if (e.key === 'Enter') {
      e.preventDefault()
      activate(rows[cursor], true)
    } else if (e.key === 'Backspace' && listing?.parent !== undefined) {
      e.preventDefault()
      void browse(listing?.parent ?? null)
    }
  }

  const createFolder = async () => {
    if (!folder || newFolder === null) return
    const why = nameProblem(newFolder, 'folder')
    if (why) { setError(why); return }
    setCreating(true)
    try {
      const made = await window.adfApi.createRemoteFolder({ parent: folder, name: newFolder.trim() })
      if ('error' in made) setError(made.error)
      else { setNewFolder(null); await browse(made.path) }
    } finally {
      setCreating(false)
    }
  }

  const actionLabel = request.kind === 'open-adf' ? 'Open' : request.kind === 'folder' ? 'Choose this folder' : confirmReplace ? 'Replace' : 'Create'
  const canChoose = ready && (request.kind === 'open-adf' ? !!selected : request.kind === 'folder' ? folderAllowed : folderAllowed && !problem)

  return (
    <Dialog open onClose={() => onDone(null)} title={request.title} wide lightDismiss={false}>
      <p className="mb-2 text-[12px] text-[var(--adf-ui-text-muted)]">
        Folders on <span className="font-medium text-[var(--adf-ui-text)]">{request.host}</span>, where the ADF daemon runs.
        {importOnly && ' The daemon takes uploads into its tracked folders and its agents folder.'}
      </p>

      <div className="mb-2 flex items-center gap-2">
        <Button size="compact" disabled={loading || !folder} onClick={() => void browse(listing?.parent ?? null)} aria-label="Up one folder">
          <UpIcon />
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
        <label className="flex shrink-0 items-center gap-1.5 text-[12px] text-[var(--adf-ui-text-muted)]">
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} className="rounded accent-[var(--adf-ui-accent)]" />
          Hidden
        </label>
      </div>

      <div
        ref={listRef}
        tabIndex={0}
        onKeyDown={onListKey}
        className="mb-2 h-72 overflow-y-auto rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] outline-none focus-visible:border-[var(--adf-ui-accent)]"
        role="listbox"
        aria-label={`Folders on ${request.host}`}
        aria-activedescendant={rows.length ? `remote-picker-row-${cursor}` : undefined}
      >
        {loading && <p className="p-3 text-[12px] text-[var(--adf-ui-text-muted)]">Loading…</p>}
        {!loading && error && <p className="p-3 text-[12px] text-[var(--adf-ui-danger)]">{error}</p>}
        {ready && (
          <>
            {folder === null && importOnly && rows.length === 0 && (
              <p className="p-3 text-[12px] text-[var(--adf-ui-text-muted)]">The daemon has no tracked folder or agents folder to upload into.</p>
            )}
            {folder !== null && rows.length === 0 && (
              <p className="p-3 text-[12px] text-[var(--adf-ui-text-muted)]">{request.kind === 'folder' ? 'No subfolders.' : 'No folders or agent files here.'}</p>
            )}
            {rows.map((row, i) => {
              const path = row.kind === 'root' ? row.root.path : row.entry.path
              const isDir = row.kind === 'root' || row.entry.kind === 'directory'
              const isSelected = row.kind === 'entry' && selected === row.entry.path
              return (
                <div
                  key={path}
                  id={`remote-picker-row-${i}`}
                  data-row={i}
                  role="option"
                  aria-selected={isSelected || i === cursor}
                  onClick={() => { setCursor(i); activate(row, false) }}
                  className={`flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[12px] ${isSelected ? 'bg-[var(--adf-ui-accent-subtle)]' : i === cursor ? 'bg-[var(--adf-ui-surface-hover)]' : 'hover:bg-[var(--adf-ui-surface-hover)]'}`}
                >
                  <span className="shrink-0 text-[var(--adf-ui-text-muted)]">{isDir ? <FolderIcon /> : <FileIcon />}</span>
                  <span className={`min-w-0 flex-1 truncate ${row.kind === 'root' ? 'font-mono' : ''}`}>{row.kind === 'root' ? row.root.path : row.entry.name}</span>
                  {row.kind === 'root' && <span className="text-[var(--adf-ui-text-subtle)]">{ROOT_LABELS[row.root.kind]}</span>}
                </div>
              )
            })}
            {listing?.truncated && (
              <p className="px-3 py-1.5 text-[11px] text-[var(--adf-ui-text-subtle)]">This folder has more entries than the daemon lists; type a path above to reach one that is not shown.</p>
            )}
          </>
        )}
      </div>

      <div className="mb-3 flex items-center gap-2">
        {newFolder === null ? (
          <Button size="compact" disabled={!folder || loading} onClick={() => setNewFolder('')}>New folder</Button>
        ) : (
          <>
            <TextInput
              autoFocus
              value={newFolder}
              onChange={(e) => setNewFolder(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void createFolder(); if (e.key === 'Escape') { e.stopPropagation(); setNewFolder(null) } }}
              placeholder="Folder name"
              aria-label="New folder name"
              spellCheck={false}
            />
            <Button size="compact" variant="primary" loading={creating} disabled={!newFolder.trim()} onClick={() => void createFolder()}>Create folder</Button>
            <Button size="compact" onClick={() => setNewFolder(null)}>Cancel</Button>
          </>
        )}
        {importOnly && folder !== null && !folderAllowed && (
          <span className="text-[12px] text-[var(--adf-ui-danger)]">Choose a tracked folder or the agents folder, or a folder inside one.</span>
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
        <Button variant={confirmReplace ? 'danger' : 'primary'} disabled={!canChoose} onClick={choose}>
          {actionLabel}
        </Button>
      </div>
    </Dialog>
  )
}
