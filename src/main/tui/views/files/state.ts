// Files view state (kept in the store's viewState so it survives view
// switches) and the request channel slash commands use to reach the mounted
// view — editing needs ink's suspendTerminal, which only exists in React.

import type { TuiActions, TuiStore } from '../../state/store'
import type { TuiState } from '../../state/types'

export const VIEW_ID = 'files'

export type FilesTab = 'files' | 'inbox' | 'outbox' | 'meta'
export const TABS: FilesTab[] = ['files', 'inbox', 'outbox', 'meta']

export type FilesPane = 'list' | 'viewer'

export interface AgentFilesState {
  /** Highlighted tree row key. */
  cursor?: string
  /** Target key shown in the viewer. */
  open?: string
  /** Collapsed folder paths. */
  collapsed?: string[]
}

export type FilesRequest =
  | { kind: 'open'; key: string; nonce: number }
  | { kind: 'edit'; key: string; nonce: number }
  | { kind: 'new'; path?: string; nonce: number }

export interface FilesViewState {
  tab: FilesTab
  pane: FilesPane
  agents: Record<string, AgentFilesState>
  request?: FilesRequest
}

export const INITIAL_STATE: FilesViewState = { tab: 'files', pane: 'list', agents: {} }

export function readViewState(state: TuiState): FilesViewState {
  const value = state.viewState[VIEW_ID] as FilesViewState | undefined
  return value ?? INITIAL_STATE
}

let nonce = 0

export type FilesRequestInput = FilesRequest extends infer R ? (R extends FilesRequest ? Omit<R, 'nonce'> : never) : never

/** Ask the (mounted or soon mounted) files view to open / edit / create. */
export function sendRequest(store: Pick<TuiStore, 'getState' | 'actions'>, request: FilesRequestInput, tab: FilesTab = 'files'): void {
  const current = readViewState(store.getState())
  const withNonce = { ...request, nonce: ++nonce } as FilesRequest
  store.actions.setViewState(VIEW_ID, { ...current, tab, request: withNonce })
  store.actions.setView(VIEW_ID)
}

// --- text prompt dialog -------------------------------------------------------

export interface AskTextOptions {
  title: string
  label: string
  initial?: string
  hint?: string
}

const pendingAsks = new Map<string, (value: string | null) => void>()
let askSeq = 0

/** Open the files.input dialog; resolves with the text, or null when cancelled. */
export function askText(actions: TuiActions, options: AskTextOptions): Promise<string | null> {
  const id = `files.input.${++askSeq}`
  return new Promise(resolve => {
    pendingAsks.set(id, resolve)
    actions.pushOverlay({ id, kind: 'files.input', props: { ...options } })
  })
}

export function resolveAsk(id: string, value: string | null): void {
  const resolve = pendingAsks.get(id)
  pendingAsks.delete(id)
  resolve?.(value)
}
