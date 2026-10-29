import { browserId, readStored } from './browser-storage'
import { splitRuntimeTag } from '../shared/runtime-tag'
import { IPC } from '../shared/constants/ipc-channels'
import type { IpcRendererLike } from '../shared/runtime-ipc'
import type { QueueHandoverEntry } from '../shared/types/ipc.types'
import type { WebTransport } from './transport'

type Recovery = { agentFilePath: string; path: string; content: string | null; runtimeId?: string; kept?: string; modifiedAt: number; browserClientId?: string }
// Matches the daemon's JSON request ceiling after number[] encoding overhead.
const UPLOAD_MAX_BYTES = 24 * 1024 * 1024
const TAB_STALE_MS = 12_000
type TabState = { clientId: string; filePath: string; agentId: string | null; runtimeId: string; seen: number; closed?: boolean; tabId?: string; queue: QueueHandoverEntry[] }

function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url; link.download = name; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function download(name: string, data: string, type = 'application/json'): void {
  downloadBlob(name, new Blob([data], { type }))
}

async function downloadRemote(endpoint: string, query: Record<string, string>, name: string): Promise<void> {
  const response = await fetch(`${endpoint}?${new URLSearchParams(query)}`, { credentials: 'same-origin' })
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(body.error || `Download failed (${response.status})`)
  }
  downloadBlob(name, await response.blob())
}

function pickFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'; input.multiple = true
    input.onchange = () => { resolve(Array.from(input.files ?? [])); input.remove() }
    input.addEventListener('cancel', () => { resolve([]); input.remove() }, { once: true })
    input.hidden = true; document.body.append(input); input.click()
  })
}

/** Browser-only behavior; all runtime calls continue through the shared API. */
export function browserIpc(transport: WebTransport, storageScope: string, recoveryScope: string): IpcRendererLike {
  // Separate pending messages and unsaved edits across browser sign-ins. The
  // server supplies a non-authenticating identifier, never the session cookie.
  if (![storageScope, recoveryScope].every(scope => /^[a-zA-Z0-9_-]{16,128}$/.test(scope))) throw new Error('Invalid browser storage scope. Sign in again.')
  const prefix = `adf.web.session.${storageScope}.`
  const RECOVERY_KEY = `adf.web.recovery.${recoveryScope}`
  const TAB_PREFIX = prefix + 'tab.'
  const tabs = new Map<string, { window: Window; filePath: string; agentId: string | null; runtimeId?: string; tabId: string; clientId?: string }>()
  const queueKey = `${prefix}queue.${transport.clientId}`
  const tabKey = TAB_PREFIX + transport.clientId
  const params = new URLSearchParams(location.search)
  const isAgent = params.get('window') === 'agent'
  const storedTabs = (): Array<[string, TabState]> => {
    const entries: Array<[string, TabState]> = []
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (!key?.startsWith(TAB_PREFIX)) continue
        const entry = readStored<TabState | null>(localStorage, key, null)
        if (entry && typeof entry.filePath === 'string' && Array.isArray(entry.queue)) entries.push([key, entry])
      }
    } catch { /* storage is optional until there are edits/queued messages */ }
    return entries
  }
  const storedQueue = (): QueueHandoverEntry[] => {
    const entry = readStored<TabState | null>(localStorage, tabKey, null)
    const rows = entry?.queue ?? readStored<QueueHandoverEntry[]>(sessionStorage, queueKey, [])
    return Array.isArray(rows) ? rows : []
  }
  const heartbeat = () => {
    if (!isAgent) return
    localStorage.setItem(tabKey, JSON.stringify({
      clientId: transport.clientId, filePath: params.get('file') || '', agentId: null,
      runtimeId: params.get('runtime') || 'local', seen: Date.now(), closed: false, tabId: params.get('tab') || undefined,
      queue: storedQueue(),
    } satisfies TabState))
  }
  const recoveryEntriesPrefix = RECOVERY_KEY + '.entry.'
  const recoveryIdentity = (item: Recovery) => JSON.stringify([item.agentFilePath, item.path, item.runtimeId, item.kept])
  const recoveryEntries = (): Array<[string, string]> => {
    const entries: Array<[string, string]> = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key?.startsWith(recoveryEntriesPrefix)) continue
      const raw = localStorage.getItem(key)
      if (raw !== null) entries.push([key, raw])
    }
    return entries
  }
  const recoveries = (): Recovery[] => {
    const rows = readStored<Recovery[]>(localStorage, RECOVERY_KEY, [])
    const valid = (row: Recovery): boolean => !!row && typeof row.path === 'string' && typeof row.agentFilePath === 'string'
    const collected = new Map<string, Recovery>()
    // Read old aggregate storage without rewriting it. Per-entry tombstones
    // prevent a cleared legacy copy from reappearing on the next reload.
    if (Array.isArray(rows)) for (const row of rows) if (valid(row)) collected.set('legacy:' + recoveryIdentity(row), row)
    for (const [key, raw] of recoveryEntries()) {
      let row: Recovery
      try { row = JSON.parse(raw) } catch { continue }
      if (!valid(row)) continue
      collected.delete('legacy:' + recoveryIdentity(row))
      collected.set(key, row)
    }
    return [...collected.values()].filter(row => row.content !== null)
  }
  try { heartbeat() } catch { /* writes will report storage errors when needed */ }
  const publishWindows = () => {
    for (const [key, tab] of tabs) {
      if (!tab.window.closed) {
        // Read the particular window's claim, not its URL tab id: duplicating
        // a tab copies that URL but intentionally gets another client id.
        try { tab.clientId = tab.window.sessionStorage.getItem(`adf.web.client.${tab.tabId}`) || tab.clientId } catch { /* navigating or storage unavailable */ }
        continue
      }
      // A crashed tab may not deliver pagehide. Only a positive closed-window
      // signal allows handover; background timer throttling is not closure.
      for (const [storedKey, entry] of storedTabs()) {
        if (tab.clientId && entry.clientId === tab.clientId && !entry.closed) {
          localStorage.setItem(storedKey, JSON.stringify({ ...entry, closed: true, seen: 0 }))
        }
      }
      tabs.delete(key)
    }
    const open = new Map(storedTabs().filter(([, entry]) => !entry.closed).map(([, entry]) => [entry.runtimeId + ':' + entry.filePath, { filePath: entry.filePath, agentId: entry.agentId, runtimeId: entry.runtimeId }]))
    for (const [key, { window: _window, tabId: _tabId, clientId: _clientId, ...entry }] of tabs) open.set(key, { ...entry, runtimeId: entry.runtimeId || 'local' })
    return { windows: [...open.values()] }
  }
  const notifyTabs = () => {
    transport.emit(IPC.WINDOW_AGENTS_CHANGED, publishWindows())
    if (!isAgent && storedTabs().some(([, tab]) => tab.closed && tab.queue.length > 0 && Date.now() - tab.seen >= TAB_STALE_MS)) transport.emit(IPC.QUEUE_HANDOVER_READY)
  }
  const timer = window.setInterval(() => { try { heartbeat(); notifyTabs() } catch (error) { console.error('[Studio Web storage]', error) } }, 4000)
  window.addEventListener('storage', (event) => { if (event.key?.startsWith(TAB_PREFIX)) notifyTabs() })
  window.addEventListener('pagehide', () => {
    window.clearInterval(timer)
    if (isAgent) {
      const entry = readStored<TabState | null>(localStorage, tabKey, null)
      if (entry) localStorage.setItem(tabKey, JSON.stringify({ ...entry, closed: true, seen: Date.now() }))
    }
  }, { once: true })
  document.addEventListener('fullscreenchange', () => transport.emit(IPC.APP_FULLSCREEN_CHANGED, !!document.fullscreenElement))
  return {
    on: (channel, callback) => transport.on(channel, callback),
    removeListener: (channel, callback) => transport.removeListener(channel, callback),
    send(channel, ...args) { void this.invoke(channel, ...args).catch((error) => console.error('[Studio Web]', error)) },
    async invoke(channel, ...rawArgs) {
      const { runtimeId, args } = splitRuntimeTag(rawArgs)
      if (runtimeId && runtimeId !== 'local') throw new Error('Open the other daemon’s Studio URL to use that runtime.')
      switch (channel) {
        case IPC.APP_GET_FULLSCREEN: return !!document.fullscreenElement
        case IPC.APP_SET_FULLSCREEN:
          if (args[0] && !document.fullscreenElement) await document.documentElement.requestFullscreen()
          else if (!args[0] && document.fullscreenElement) await document.exitFullscreen()
          return
        case IPC.APP_SET_BADGE_COUNT: {
          const badge = navigator as Navigator & { setAppBadge?: (count: number) => Promise<void>; clearAppBadge?: () => Promise<void> }
          if (Number(args[0]) > 0) await badge.setAppBadge?.(Number(args[0]))
          else await badge.clearAppBadge?.()
          return
        }
        case IPC.APP_UPDATE_GET_STATE: return { status: 'idle' }
        case IPC.APP_UPDATE_CHECK:
        case IPC.SPELLCHECK_DOWNLOAD: return { outcome: 'unsupported' }
        case IPC.APP_UPDATE_DOWNLOAD:
        case IPC.APP_UPDATE_INSTALL: throw new Error('Update the ADF daemon on its host, then reload Studio in your browser.')
        case IPC.ORBITAL_CACHE_GET: return null
        case IPC.ORBITAL_CACHE_PUT: return false
        case IPC.OPEN_FILE_GET_PENDING: return null
        case IPC.APPROVALS_GET_PENDING_REVEAL: return null
        case IPC.MENU_ACTION_TAKE_PENDING: return []
        case IPC.TOKEN_USAGE_EXPORT: download('adf-token-usage.json', String(args[0])); return { success: true }
        case IPC.FILE_SHARE_DRAG_START: throw new Error('Native file dragging is available in the desktop app. Use Download in the browser.')
        case IPC.DOC_DOWNLOAD_INTERNAL_FILE: {
          const { path } = args[0] as { path: string }
          const { useDocumentStore } = await import('../renderer/stores/document.store')
          const filePath = useDocumentStore.getState().filePath
          await downloadRemote('/web/file', { clientId: transport.clientId, storageScope, path, runtime: 'local', ...(filePath ? { filePath } : {}) }, path.split('/').pop() || 'download')
          return { success: true }
        }
        case IPC.FILE_SHARE_SAVE_AS: {
          const { filePath } = args[0] as { filePath: string }
          await downloadRemote('/web/snapshot', { clientId: transport.clientId, storageScope, path: filePath, runtime: 'local', mode: 'share' }, filePath.split(/[\\/]/).pop() || 'agent.adf')
          return { success: true }
        }
        case IPC.FILE_REVEAL: {
          const { filePath } = args[0] as { filePath: string }
          try { await navigator.clipboard.writeText(filePath) }
          catch { window.prompt('Copy path on daemon', filePath) }
          return
        }
        case IPC.DOC_UPLOAD_FILE: {
          const upload = args[0] as { data?: unknown[] }
          if ((upload?.data?.length ?? 0) > UPLOAD_MAX_BYTES) throw new Error('This file exceeds the browser upload limit of 24 MiB.')
          return transport.invoke(channel, ...args)
        }
        case IPC.DOC_PICK_AND_IMPORT: {
          const files = await pickFiles()
          let count = 0
          const oversized = files.find((file) => file.size > UPLOAD_MAX_BYTES)
          if (oversized) throw new Error(`${oversized.name} exceeds the browser upload limit of 24 MiB.`)
          for (const file of files) {
            const result = await transport.invoke(IPC.DOC_UPLOAD_FILE, {
              path: file.name, data: Array.from(new Uint8Array(await file.arrayBuffer())), mimeType: file.type, unique: true,
            })
            if (!result?.success) throw new Error(result?.error || `Could not upload ${file.name}`)
            count++
          }
          return { success: true, count }
        }
        case IPC.WINDOW_OPEN_AGENT: {
          const request = args[0] as { filePath: string; agentId?: string | null; runtimeId?: string }
          const key = `${request.runtimeId || 'local'}:${request.filePath}`
          const existing = tabs.get(key)
          if (existing && !existing.window.closed) { existing.window.focus(); return { success: true, created: false } }
          const url = new URL(location.href)
          const tabId = browserId()
          url.search = new URLSearchParams({ window: 'agent', file: request.filePath, runtime: request.runtimeId || 'local', tab: tabId }).toString()
          const opened = window.open(url, '_blank')
          if (!opened) return { success: false, error: 'Your browser blocked the new tab. Allow pop-ups for Studio and try again.' }
          opened.opener = null
          tabs.set(key, { window: opened, filePath: request.filePath, agentId: request.agentId ?? null, runtimeId: request.runtimeId, tabId })
          transport.emit(IPC.WINDOW_AGENTS_CHANGED, publishWindows())
          return { success: true, created: true }
        }
        case IPC.WINDOW_CLOSE: {
          window.close()
          if (!window.closed) return { success: false }
          const entry = readStored<TabState | null>(localStorage, tabKey, null)
          if (entry) localStorage.setItem(tabKey, JSON.stringify({ ...entry, closed: true, seen: 0 }))
          return { success: true }
        }
        case IPC.WINDOW_OPEN_FAILED:
        case IPC.WINDOW_STASH_DONE: return
        case IPC.WINDOW_OPEN_SETTINGS: {
          const { section, anchor } = (args[0] ?? {}) as { section?: string; anchor?: string }
          const { useAppStore } = await import('../renderer/stores/app.store')
          useAppStore.getState().setShowSettings(true)
          if (section) useAppStore.getState().openSettingsAt(section as Parameters<ReturnType<typeof useAppStore.getState>['openSettingsAt']>[0], anchor)
          if (anchor) document.getElementById(anchor)?.scrollIntoView()
          return
        }
        case IPC.WINDOW_LIST_AGENTS: return publishWindows()
        case IPC.WINDOW_QUEUE_SYNC: {
          sessionStorage.setItem(queueKey, JSON.stringify(args[0]))
          heartbeat()
          const entry = readStored<TabState | null>(localStorage, tabKey, null)
          if (entry) localStorage.setItem(tabKey, JSON.stringify({ ...entry, queue: args[0] }))
          return
        }
        case IPC.WINDOW_QUEUE_GET: return storedQueue()
        case IPC.QUEUE_HANDOVER_TAKE: {
          const take = () => {
            const queue: QueueHandoverEntry[] = []
            for (const [key, entry] of storedTabs()) {
              if (!entry.closed || Date.now() - entry.seen < TAB_STALE_MS) continue
              queue.push(...entry.queue)
              localStorage.setItem(key, JSON.stringify({ ...entry, queue: [] }))
            }
            return queue
          }
          // An uncoordinated read/delete can hand the same messages to two
          // main tabs, executing them twice. Keep the text until a secure
          // browser context can serialize its transfer with Web Locks.
          if (!navigator.locks) {
            if (storedTabs().some(([, entry]) => entry.closed && entry.queue.length > 0)) {
              throw new Error('Queued messages remain saved in this browser, but automatic handover is unavailable because this origin does not support Web Locks. Copy pending text from the agent tab before closing it; use HTTPS or localhost for future sessions.')
            }
            return []
          }
          return navigator.locks.request(prefix + 'queue-handover', take)
        }
        case IPC.RECOVERY_STASH: {
          const entry = { ...(args[0] as Recovery), modifiedAt: Date.now(), browserClientId: transport.clientId }
          // Each tab owns separate keys, even when two tabs edit the same
          // file. A single atomic set cannot overwrite another tab's copies.
          const key = recoveryEntriesPrefix + encodeURIComponent(JSON.stringify([transport.clientId, recoveryIdentity(entry)]))
          localStorage.setItem(key, JSON.stringify(entry))
          return { success: true }
        }
        case IPC.RECOVERY_LIST: return {
          root: 'Browser recovery storage',
          files: recoveries().map((entry) => ({ agent: entry.agentFilePath.split(/[\\/]/).pop() || 'Agent', folder: entry.agentFilePath, path: entry.path, file: entry.path, modifiedAt: entry.modifiedAt, runtimeId: entry.runtimeId, kept: !!entry.kept })),
        }
        case IPC.RECOVERY_REVEAL: download('adf-recovered-edits.json', JSON.stringify(recoveries(), null, 2)); return { success: true }
        case IPC.RECOVERY_ARCHIVE: {
          const entries = recoveryEntries()
          const legacy = localStorage.getItem(RECOVERY_KEY)
          const rows = recoveries()
          if (rows.length) localStorage.setItem(`${RECOVERY_KEY}.archive.${Date.now()}.${browserId()}`, JSON.stringify(rows))
          // A tab can save another edit while this list is being dismissed.
          // Remove only the entries included in this archive snapshot.
          if (localStorage.getItem(RECOVERY_KEY) === legacy) localStorage.removeItem(RECOVERY_KEY)
          for (const [key, raw] of entries) if (localStorage.getItem(key) === raw) localStorage.removeItem(key)
          return { moved: rows.length }
        }
        default: return transport.invoke(channel, ...args)
      }
    },
  }
}
