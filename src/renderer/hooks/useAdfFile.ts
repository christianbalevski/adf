import { useCallback } from 'react'
import { useDocumentStore } from '../stores/document.store'
import { useAgentStore, MAIN_LOOP } from '../stores/agent.store'
import { useAppStore } from '../stores/app.store'
import { useBackgroundAgentsStore } from '../stores/background-agents.store'
import { useEditorTabsStore, beginAgentSwitch, endAgentSwitch } from '../stores/editor-tabs.store'
import { nanoid } from 'nanoid'
import { toDisplayState } from './useAgent'
import { deliverSettledQueues } from '../utils/queued-delivery'
import { loadOpenTabs, saveOpenTabs, suspendTabPersistence, resumeTabPersistence } from '../utils/editor-tab-persistence'
import type { ApprovalMeta } from '../../shared/types/ipc.types'
import { fileOperationDetachedForeground, reportFileOperationError } from '../utils/file-operation-errors'
import { confirmDiscardConflicts } from '../utils/edit-conflict'
import { closeAgentWindow, isAgentWindow, openAgentWindow, windowRuntime } from '../utils/window-kind'
import { apiFor, openApi, windowAgentKey } from '../utils/runtime-api'
import { selectBackgroundAgents } from '../stores/background-agents.store'
import { agentKey } from '../../shared/types/agent-ref'
import type { RuntimeId } from '../../shared/runtime-tag'
import type { AdfApi } from '../../preload/api'

/**
 * The key an agent's saved editor tabs are kept under (localStorage, shared
 * by every window): its path on This computer, as before; runtime and path
 * on another runtime.
 */
export function tabsKey(runtimeId: RuntimeId, filePath: string): string {
  return agentKey({ runtimeId, filePath })
}

/** The open agent's tabs key, or null. */
export function openTabsKey(): string | null {
  const { filePath, runtimeId } = useDocumentStore.getState()
  return filePath ? tabsKey(runtimeId, filePath) : null
}

/**
 * Main window: before an agent of `target` opens, the open agent of another
 * runtime is closed on its runtime (docs/design/multi-runtime.md §4.3), as an
 * open within one runtime replaces the open file. True when one was closed.
 */
async function leaveOtherRuntime(target: RuntimeId): Promise<boolean> {
  if (isAgentWindow) return false
  const { filePath, runtimeId } = useDocumentStore.getState()
  if (!filePath || runtimeId === target) return false
  console.log(`[useAdfFile] Closing ${filePath} on ${runtimeId}: an agent on ${target} opens`)
  await apiFor(runtimeId).closeFile()
  return true
}

/** W3-F: what an agent switch answers when the user kept unsaved text under a "changed elsewhere" notice. */
const KEPT_UNSAVED = { success: false, error: 'Kept your unsaved changes open; the agent was not switched.' } as const

/**
 * Files opened in the editor when an agent has no saved tab set: its document,
 * its private memory, and its voice. Also what EditorPanel's "Open core files"
 * button opens — closing every tab is a sticky choice, so that button is the
 * way back, and both paths must agree on the set.
 */
export const DEFAULT_OPEN_TABS = ['README.md', 'mind.md', 'soul.md'] as const

// window.adfApi is untyped in the web project, so the batch is too.
type FileBatch = Awaited<ReturnType<typeof window.adfApi.getBatch>>
type TabFile = { content: string; binary?: boolean; mimeType?: string; revision?: number }

/** Everything an agent switch shows, read before any store changes. */
export interface FileContents {
  batch: FileBatch
  /** Saved or default tab files by path; missing when the file is gone. */
  tabFiles: Map<string, TabFile>
}

/**
 * Read the open workspace's batch and the files its editor tabs will show,
 * in parallel, without touching any store. `agentFilePath` picks the saved
 * tab set; main must already have this agent as its workspace.
 */
export async function fetchFileContents(agentFilePath: string | null, api: AdfApi = openApi(), runtimeId: RuntimeId = useDocumentStore.getState().runtimeId): Promise<FileContents> {
  const t0 = performance.now()
  const saved = agentFilePath ? loadOpenTabs(tabsKey(runtimeId, agentFilePath)) : null
  const paths = (saved ? saved.paths : [...DEFAULT_OPEN_TABS])
    .filter((p) => p !== 'README.md' && !p.startsWith('browser://'))
  const [batch, files] = await Promise.all([
    api.getBatch() as Promise<FileBatch>,
    Promise.all(paths.map(async (path) => {
      try {
        const file = await api.readInternalFile(path)
        return file?.content != null ? [path, file as TabFile] as const : null
      } catch {
        return null // file gone since last session — skip
      }
    }))
  ])
  console.log(`[PERF:renderer] fetchFileContents: ${(performance.now() - t0).toFixed(1)}ms`)
  return { batch, tabFiles: new Map(files.filter((f): f is readonly [string, TabFile] => f !== null)) }
}

/**
 * Apply AGENT_START's answer for an agent that was already running (the
 * re-attach): its executor state, pending approvals and asks. A failed
 * re-attach is said in the status line: the agent still runs in main.
 */
function applyReattach(startResult: Awaited<ReturnType<typeof window.adfApi.startAgent>>, filePath: string | null): void {
  if (startResult.success) {
    // Use the actual executor state (may be mid-turn: thinking/tool_use)
    const reattachedState = toDisplayState(startResult.agentState ?? 'idle')
    useAgentStore.getState().setState(reattachedState)
    // Inner loops keep running across a switch: show their real
    // states, not the reset default (idle).
    const loopStates: Record<string, string> = { [MAIN_LOOP]: reattachedState }
    for (const [loop, state] of Object.entries(startResult.loopStates ?? {})) {
      const displayState = toDisplayState(state)
      loopStates[loop] = displayState
      useAgentStore.getState().setState(displayState, loop)
    }
    // A turn that ended during the switch reported its idle to neither
    // the background list nor this view: send what was queued for
    // every loop that is idle now.
    if (filePath) deliverSettledQueues(windowAgentKey(useDocumentStore.getState().runtimeId, filePath), loopStates, reattachedState)

    // Restore pending HIL approvals so the user can still approve/reject
    const pending = (startResult as { pendingApprovals?: Array<{ requestId: string; name: string; input: unknown } & Partial<ApprovalMeta>> }).pendingApprovals
    if (pending && pending.length > 0) {
      const store = useAgentStore.getState()
      for (const approval of pending) {
        const meta: Partial<ApprovalMeta> = {
          reason: approval.reason,
          protection: approval.protection,
          canAlwaysApprove: approval.canAlwaysApprove,
          alwaysApproveBlockedReason: approval.alwaysApproveBlockedReason
        }
        // Find the matching tool_call log entry by tool name (search from end)
        const log = store.log
        let matched = false
        for (let i = log.length - 1; i >= 0; i--) {
          const entry = log[i]
          if (entry.type === 'tool_call' && entry.metadata?.name === approval.name) {
            store.addPendingApproval(entry.id, approval.requestId, meta)
            matched = true
            break
          }
        }
        // If no matching log entry found (e.g. log was truncated), synthesize one
        if (!matched) {
          const entryId = nanoid()
          store.addLogEntry({
            id: entryId,
            type: 'tool_call',
            content: `Calling ${approval.name}`,
            timestamp: Date.now(),
            metadata: { name: approval.name, input: approval.input }
          })
          store.addPendingApproval(entryId, approval.requestId, meta)
        }
      }
    }

    // Restore pending ask requests so the reply box reappears after navigation
    const pendingAsks = (startResult as { pendingAsks?: Array<{ requestId: string; question: string }> }).pendingAsks
    if (pendingAsks && pendingAsks.length > 0) {
      const store = useAgentStore.getState()
      for (const ask of pendingAsks) {
        // Find the matching ask tool_call log entry (search from end)
        const log = store.log
        let matched = false
        for (let i = log.length - 1; i >= 0; i--) {
          const entry = log[i]
          if (entry.type === 'tool_call' && entry.metadata?.name === 'ask') {
            store.addPendingAsk(entry.id, ask.requestId, ask.question)
            matched = true
            break
          }
        }
        // If no matching log entry found, synthesize one
        if (!matched) {
          const entryId = nanoid()
          store.addLogEntry({
            id: entryId,
            type: 'tool_call',
            content: `Calling ask`,
            timestamp: Date.now(),
            metadata: { name: 'ask', input: { question: ask.question } }
          })
          store.addPendingAsk(entryId, ask.requestId, ask.question)
        }
      }
    }
  } else {
    // The executor is still running in main with no host attached.
    // Never fail silently: the default reset state reads as "off".
    console.error('[useAdfFile] Foreground re-attach of running agent failed:', startResult.error)
    useAgentStore.getState().setStatusText(`Agent is running but could not attach: ${startResult.error ?? 'unknown error'}`)
  }
}

/**
 * Files an openFile is switching to right now. main extracts a running
 * background agent for the foreground attach and reports it `agent_stopped`
 * while the renderer is still fetching it; the background event handler
 * keeps such a file's starting mark instead of dropping it.
 */
export const openingFilePaths = new Set<string>()

/**
 * Daemon mode: a file whose agent runs, opened behind the password prompt
 * (FILE_OPEN answered needsPassword with agentWasRunning; the daemon keeps
 * it running on its stub provider). The unlock rebuilds the real provider in
 * place, and completeFileOpen re-attaches it instead of showing it stopped.
 * Embedded never answers both: it stops such an agent before the prompt.
 */
const reattachAfterUnlock = new Set<string>()

/**
 * The latest openFile of this page and its runtime. An open that a later one
 * overtook applies nothing: what it opened on another runtime than the
 * latest's is closed there (on the same runtime, the later open replaced it).
 */
let openGeneration = 0
let latestOpenRuntime: RuntimeId | null = null

/**
 * Hook for managing ADF file operations.
 */
export function useAdfFile() {
  const setDocumentContent = useDocumentStore((s) => s.setDocumentContent)
  const setFilePath = useDocumentStore((s) => s.setFilePath)
  const setDirty = useDocumentStore((s) => s.setDirty)
  const setConfig = useAgentStore((s) => s.setConfig)
  const setStatusText = useAgentStore((s) => s.setStatusText)
  const setLog = useAgentStore((s) => s.setLog)
  const clearLog = useAgentStore((s) => s.clearLog)
  const setTokenUsage = useAgentStore((s) => s.setTokenUsage)
  const resetDocument = useDocumentStore((s) => s.reset)
  const resetAgent = useAgentStore((s) => s.reset)
  const setShowSettings = useAppStore((s) => s.setShowSettings)

  /**
   * Apply fetched contents to the stores, synchronously. Nothing in here
   * awaits, so the whole switch lands in one React render: no frame shows the
   * cleared stores, and the editor tabs appear together instead of one by one.
   */
  const applyFileContents = useCallback((contents: FileContents) => {
    const { batch, tabFiles } = contents
    const t1 = performance.now()
    // W3-F: the revisions the README tab and the config panel save over.
    setDocumentContent(batch.document, { revision: batch.documentRevision, writer: null })
    useAgentStore.getState().setConfigRevision(batch.configRevision)
    setConfig(batch.agentConfig)
    setStatusText(batch.statusText ?? '')
    setDirty(false)

    // Restore loop (conversation history) if present
    if (batch.chat && batch.chat.uiLog.length > 0) {
      setLog(batch.chat.uiLog, batch.chat.earlierCount ?? 0)
      console.log(`[PERF:renderer] loadFileContents.setStores: ${(performance.now() - t1).toFixed(1)}ms (logEntries=${batch.chat.uiLog.length})`)
    } else {
      clearLog()
      console.log(`[PERF:renderer] loadFileContents.setStores: ${(performance.now() - t1).toFixed(1)}ms (empty log)`)
    }

    // Restore the context gauge from the persisted baseline — the same
    // number the live path settles on, so reload and live agree:
    //   - exact baseline (last call completed): tokenUsage = the last row's
    //     full breakdown (same call, keeps cache/cost for the modal),
    //     estimate cleared → gauge shows the exact percentage;
    //   - estimated baseline (compaction/clear was the last thing to
    //     happen): estimate = baseline, usage zeroed → gauge shows "~%";
    //   - no baseline (file predates it): the pre-baseline behaviour, the
    //     last assistant row's usage.
    // Any live pre-flight estimate belonged to the previous agent.
    const lastTokens = batch.lastTokens
      ? { ...batch.lastTokens, input: batch.lastTokens.input ?? 0, output: batch.lastTokens.output ?? 0 }
      : null
    const baseline = batch.contextBaseline ?? null
    if (baseline?.estimated) {
      setTokenUsage({ input: 0, output: 0 })
      useAgentStore.getState().setTokenEstimate(baseline.tokens)
    } else {
      if (baseline) setTokenUsage(lastTokens ?? { input: baseline.tokens, output: 0 })
      else if (lastTokens) setTokenUsage(lastTokens)
      useAgentStore.getState().setTokenEstimate(null)
    }

    // Restore this agent's previously open editor tabs. Falls back to the
    // core set (README + mind + soul) when nothing restorable is saved —
    // those three are the agent's own document, memory, and voice, so they
    // are the default view rather than bespoke panels.
    const agentFilePath = openTabsKey()
    const saved = agentFilePath ? loadOpenTabs(agentFilePath) : null
    const tabStore = useEditorTabsStore.getState()
    tabStore.reset()

    // README.md content came down in the batch; the rest was read up front
    // by fetchFileContents. False for files that no longer exist.
    const openWorkspaceFile = (path: string): boolean => {
      if (path === 'README.md') {
        tabStore.openTab('README.md', batch.document, false, undefined, batch.documentRevision)
        return true
      }
      const file = tabFiles.get(path)
      if (!file) return false
      tabStore.openTab(path, file.binary ? '' : file.content, !!file.binary, file.mimeType, file.revision)
      return true
    }

    let restoredAny = false
    for (const path of saved?.paths ?? []) {
      if (openWorkspaceFile(path)) restoredAny = true
    }
    if (!restoredAny && !saved) {
      // Only seed the defaults for an agent we have never opened. A saved
      // entry — even an empty one — is the user's own choice: closing every
      // tab persists `{paths: []}`, and resurrecting three files they just
      // dismissed (and re-saving them) would make that state impossible to
      // keep.
      for (const path of DEFAULT_OPEN_TABS) openWorkspaceFile(path)
      // README is the landing tab — the others opened after it, and openTab
      // focuses whatever it opened last.
      tabStore.setActiveTab('README.md')
    } else if (!restoredAny && saved && saved.paths.length > 0) {
      // Every saved file is gone. Fall back to the document rather than
      // leaving a blank editor.
      tabStore.openTab('README.md', batch.document, false, undefined, batch.documentRevision)
    } else if (saved?.active && useEditorTabsStore.getState().tabs.some((t) => t.path === saved.active)) {
      tabStore.setActiveTab(saved.active)
    }

    // Persist the restored state now that the switch is complete (the
    // subscriber was suspended for everything above).
    resumeTabPersistence()
    if (agentFilePath) {
      const state = useEditorTabsStore.getState()
      saveOpenTabs(
        agentFilePath,
        state.tabs.filter((t) => t.kind === 'file').map((t) => t.path),
        state.activeTabPath
      )
    }
  }, [setDocumentContent, setConfig, setStatusText, setDirty, setLog, clearLog, setTokenUsage])

  /**
   * Load the open file's contents into the stores. `prefetched` (from
   * fetchFileContents) skips the reads, so a caller that fetched before
   * resetting the stores gets the reset and the new contents in one render.
   */
  const loadFileContents = useCallback(async (prefetched?: FileContents) => {
    // Suspend tab persistence for the whole switch: setDocumentContent below
    // triggers EditorPanel's README content-sync into the tab store while the
    // OLD agent's tabs are still present and filePath already points at the
    // NEW agent — an unsuspended save would clobber the new agent's saved
    // tab list before the restore below reads it.
    suspendTabPersistence()
    // Also freeze the save layer: reset() below unmounts the old agent's editor,
    // whose teardown flush would otherwise schedule a write that main delivers
    // into the incoming agent's workspace.
    beginAgentSwitch()
    try {
      const t0 = performance.now()
      const contents = prefetched ?? await fetchFileContents(useDocumentStore.getState().filePath)
      applyFileContents(contents)
      console.log(`[PERF:renderer] loadFileContents total: ${(performance.now() - t0).toFixed(1)}ms`)
    } catch (error) {
      console.error('[useAdfFile] Error loading file contents:', error)
      throw error
    } finally {
      resumeTabPersistence()
      endAgentSwitch()
    }
  }, [applyFileContents])

  /**
   * `reattach: false`: the gate was passed without the agent's key (Wipe All
   * Keys); a daemon agent still on its stub provider is not re-attached.
   */
  const completeFileOpen = useCallback(async (opts: { reattach?: boolean } = {}) => {
    setShowSettings(false)
    useAppStore.getState().setShowHome(false)
    resetAgent()
    // Review state belongs to the previous file until main re-checks below.
    useAppStore.getState().resetAgentReview()
    await loadFileContents()

    const filePath = useDocumentStore.getState().filePath
    const openKey = filePath ? windowAgentKey(useDocumentStore.getState().runtimeId, filePath) : null
    if (filePath && openKey && reattachAfterUnlock.delete(openKey) && opts.reattach !== false) {
      // A running agent skips the review check, as openFile's re-attach does.
      useAppStore.getState().addStartingFilePath(openKey)
      const startResult = await openApi().startAgent().finally(() => useAppStore.getState().removeStartingFilePath(openKey))
      applyReattach(startResult, filePath)
      return
    }

    // Check if review is needed (replaces MCP server check)
    try {
      const review = await openApi().checkAgentReview()
      if (review.needsReview) {
        useAppStore.getState().setAgentReviewDialog(true, review.configSummary)
        return
      }
    } catch {
      // Non-fatal — skip review check
    }
  }, [setShowSettings, resetAgent, loadFileContents])

  /**
   * `runtimeId`: the agent's runtime (docs/design/multi-runtime.md §5.2);
   * omitted, this window's own (This computer in the main window).
   */
  const openFile = useCallback(async (filePath?: string, runtimeId: RuntimeId = windowRuntime) => {
    // An agent window keeps its agent (agent-windows.md): another agent opens in its own window.
    if (isAgentWindow) {
      const current = useDocumentStore.getState().filePath
      if (current && (filePath !== current || runtimeId !== windowRuntime)) {
        if (filePath) openAgentWindow({ filePath, runtimeId })
        return
      }
    }
    const api = isAgentWindow ? window.adfApi : apiFor(runtimeId)
    const keyOf = (fp: string) => windowAgentKey(runtimeId, fp)
    const tTotal = performance.now()
    // W3-F: unsaved text under a "changed elsewhere" notice is not dropped without asking.
    if (!confirmDiscardConflicts()) return
    const generation = ++openGeneration
    latestOpenRuntime = runtimeId
    /**
     * A later open overtook this one: it applies nothing, and what it opened
     * on another runtime than the later one's is closed there.
     */
    const overtaken = async (opened: boolean): Promise<boolean> => {
      if (generation === openGeneration) return false
      console.log(`[useAdfFile] The open of ${filePath} on ${runtimeId} was overtaken by a later open; nothing of it is shown`)
      if (opened && latestOpenRuntime !== runtimeId) {
        await api.closeFile().catch((err: unknown) => console.warn(`[useAdfFile] Closing the overtaken ${filePath} on ${runtimeId} failed:`, err))
      }
      return true
    }

    // Loop history is persisted via the adf_loop table by AgentSession.
    // No need to send the UI log back — DOC_SET_CHAT is a no-op in v0.2.

    // main swaps its workspace inside the openFile IPC, and the switch is not
    // over until loadFileContents has the incoming tabs. Freeze the save layer
    // across the whole span: writeInternalFile carries no agent identity, so a
    // write delivered inside it lands in the wrong file (see beginAgentSwitch).
    beginAgentSwitch()
    // A running agent stays "running" through the whole switch. main moves it
    // off the background list inside the openFile IPC, and the reset below
    // drops the foreground state to 'off', so without a starting mark its
    // sidebar row and rail avatar would leave and come back. Marked before
    // the IPC; the re-attach's startAgent clears it, or the finally does.
    const marked = new Set<string>()
    const markStarting = (fp: string) => {
      const key = keyOf(fp)
      marked.add(key)
      openingFilePaths.add(key)
      useAppStore.getState().addStartingFilePath(key)
    }
    let startHandedOff = false
    if (filePath && selectBackgroundAgents(useBackgroundAgentsStore.getState(), isAgentWindow ? undefined : runtimeId).some((a) => a.filePath === filePath)) {
      markStarting(filePath)
    }
    let switchOpen = true
    const endSwitch = () => {
      if (!switchOpen) return
      switchOpen = false
      endAgentSwitch()
    }

    reattachAfterUnlock.clear()
    try {
      let t1 = performance.now()
      // An agent of another runtime than the open one: the open one is closed on its runtime first (§4.3).
      const leftOther = await leaveOtherRuntime(runtimeId)
      const result = await api.openFile(filePath)
      console.log(`[PERF:renderer] openFile.openFile IPC: ${(performance.now() - t1).toFixed(1)}ms`)
      if (await overtaken(!!result.success)) return result

      if (result.success && result.filePath) {
        // Blank the previous agent's UI before parking on a gate dialog
        // (password / owner mismatch): main has already swapped its workspace,
        // so leaving the old agent's name, document, and log visible behind
        // the modal shows stale data. Mirrors closeFile's store resets WITHOUT
        // closing the file in main. Order matters: resetDocument nulls
        // filePath first so the tab-store reset can't persist an empty tab set
        // under either agent's key (the subscriber skips null filePath), then
        // filePath is set to the incoming file so the title shows its name.
        const parkOnGate = () => {
          resetAgent()
          resetDocument()
          useEditorTabsStore.getState().reset()
          setFilePath(result.filePath!, runtimeId)
          // Previous file's review banner must not linger behind the modal.
          useAppStore.getState().resetAgentReview()
        }

        // Check if password is needed
        if (result.needsPassword) {
          parkOnGate()
          if (result.agentWasRunning) reattachAfterUnlock.add(keyOf(result.filePath))
          useAppStore.getState().setPasswordDialogOpen(true, result.filePath)
          return result
        }

        // Check if owner mismatch
        if (result.ownerMismatch) {
          parkOnGate()
          useAppStore.getState().setOwnerMismatchDialogOpen(true, result.fileOwnerDid)
          return result
        }

        // Close settings if it's open
        setShowSettings(false)
        useAppStore.getState().setShowHome(false)

        if (result.agentWasRunning) markStarting(result.filePath)

        // Read the incoming agent before touching any store, so the old agent
        // stays on screen until the new one can replace it in a single render
        // (no blank frame, no tabs arriving one at a time).
        t1 = performance.now()
        const contents = await fetchFileContents(result.filePath, api, runtimeId)
        console.log(`[PERF:renderer] openFile.fetchFileContents: ${(performance.now() - t1).toFixed(1)}ms`)
        if (await overtaken(true)) return result

        // Reset agent state and update filePath, then apply the contents, all
        // in this one synchronous stretch. filePath still changes before any
        // further await, so in-flight handlers from the previous agent see it
        // has changed (their stillViewing checks fail as before).
        t1 = performance.now()
        resetAgent()
        setFilePath(result.filePath, runtimeId)
        // Review state belongs to the previous file until main re-checks below.
        useAppStore.getState().resetAgentReview()
        await loadFileContents(contents)
        console.log(`[PERF:renderer] openFile.reset+apply: ${(performance.now() - t1).toFixed(1)}ms`)

        // The incoming agent is fully loaded — saves are safe to deliver again.
        endSwitch()

        // Check if agent review is needed (first open or config changed)
        if (!result.agentWasRunning) {
          try {
            const review = await api.checkAgentReview()
            if (review.needsReview) {
              useAppStore.getState().setAgentReviewDialog(true, review.configSummary)
            }
          } catch {
            // Non-fatal — skip review check
          }
        }

        // If the agent was running in the background, auto-start it
        if (result.agentWasRunning) {
          t1 = performance.now()
          // The re-attach is NOT instant: an executor that was in error/stopped
          // is rebuilt from scratch (container + MCP + adapters, seconds). The
          // reset above left the store at its default 'off', so without this the
          // whole window reads as "the agent turned itself off". Marking the file
          // as starting makes every indicator (title bar, agent panel, sidebar
          // row) show "Starting…" until the real state arrives. That mark went
          // on above, before the reset.
          startHandedOff = true
          const startResult = await api.startAgent().finally(() => {
            // Clears on both outcomes — including the re-attach failure below,
            // whose message must not be hidden behind a stuck spinner.
            for (const fp of marked) useAppStore.getState().removeStartingFilePath(fp)
          })
          console.log(`[PERF:renderer] openFile.startAgent IPC: ${(performance.now() - t1).toFixed(1)}ms`)
          applyReattach(startResult, result.filePath)
        }

        console.log(`[PERF:renderer] openFile total: ${(performance.now() - tTotal).toFixed(1)}ms`)
      } else {
        console.error('[useAdfFile] Failed to open file:', result.error)
        // The open agent of the other runtime was closed for this open: its view goes too.
        if (leftOther) {
          resetDocument()
          resetAgent()
          useAppStore.getState().resetAgentReview()
          useEditorTabsStore.getState().reset()
        }
        // Show errors to the user, but keep the historical migration-specific copy.
        if (result.error?.includes('old ZIP format')) {
          alert(
            'Cannot open this file\n\n' +
            'This ADF file uses the old ZIP format (pre-v0.1).\n\n' +
            'The format has been upgraded to SQLite for better performance and reliability.\n\n' +
            'Please delete this file and create a new one with the same name.'
          )
        } else {
          reportFileOperationError('open', result, alert)
        }
      }
      return result
    } finally {
      // Every way out short of the re-attach (gate, error, not running) clears it here.
      if (!startHandedOff) for (const fp of marked) useAppStore.getState().removeStartingFilePath(fp)
      for (const fp of marked) openingFilePaths.delete(fp)
      endSwitch()
    }
  }, [setShowSettings, resetAgent, resetDocument, loadFileContents, setFilePath])

  /**
   * Main cleared its foreground aliases after a create's cleanup rejected.
   * Clear the renderer too, rather than leaving the old agent looking usable.
   */
  const clearDetachedForeground = useCallback(() => {
    resetDocument()
    resetAgent()
    useAppStore.getState().resetAgentReview()
    useEditorTabsStore.getState().reset()
    setStatusText('No file is open in the foreground after an incomplete file transition.')
  }, [resetDocument, resetAgent, setStatusText])

  /**
   * The home composer's create: a generated name in the agents folder, no
   * dialog. `firstMessage` is parked in the app store before the file
   * becomes the open one, so the loop panel finds it on mount and sends it.
   */
  const createQuickAgent = useCallback(async (firstMessage?: string, options?: { providerId?: string; modelId?: string; templateId?: string; folder?: string; name?: string; identityDraftId?: string; files?: File[] }) => {
    if (!confirmDiscardConflicts()) return { ...KEPT_UNSAVED }
    // An open still on its way is overtaken by the new agent.
    openGeneration++
    latestOpenRuntime = windowRuntime
    beginAgentSwitch()
    try {
      const { files, ...createOptions } = options ?? {}
      await leaveOtherRuntime(windowRuntime)
      const result = await window.adfApi.createQuickAgent(createOptions)
      if (result.success && result.filePath) {
        setShowSettings(false)
        useAppStore.getState().setShowHome(false)
        resetAgent()
        if (firstMessage) useAppStore.getState().setPendingFirstMessage({ filePath: result.filePath, text: firstMessage, files })
        setFilePath(result.filePath, windowRuntime)
        useAppStore.getState().resetAgentReview()
        await loadFileContents()
      } else if (fileOperationDetachedForeground(result)) {
        // The composer shows result.error; the stale agent still has to go.
        clearDetachedForeground()
      }
      return result
    } finally {
      endAgentSwitch()
    }
  }, [setShowSettings, resetAgent, setFilePath, loadFileContents, clearDetachedForeground])

  const createFile = useCallback(async (name: string) => {
    if (!confirmDiscardConflicts()) return { ...KEPT_UNSAVED }
    // An open still on its way is overtaken by the new agent.
    openGeneration++
    latestOpenRuntime = windowRuntime
    // Swaps main's workspace exactly like openFile does — same guard.
    beginAgentSwitch()
    try {
      await leaveOtherRuntime(windowRuntime)
      const result = await window.adfApi.createFile(name)
      if (result.success && result.filePath) {
        // Close settings if it's open
        setShowSettings(false)
        useAppStore.getState().setShowHome(false)

        setFilePath(result.filePath, windowRuntime)
        // A fresh file never inherits the previous file's review state.
        useAppStore.getState().resetAgentReview()
        await loadFileContents()
      } else {
        if (fileOperationDetachedForeground(result)) {
          clearDetachedForeground()
          reportFileOperationError('create', result, alert)
        } else {
          // Collision/I/O failures occur before old cleanup and preserve the
          // current renderer state.
          reportFileOperationError('create', result, alert)
        }
      }
      return result
    } finally {
      endAgentSwitch()
    }
  }, [setShowSettings, setFilePath, loadFileContents, clearDetachedForeground])

  const saveFile = useCallback(async () => {
    const result = await openApi().saveFile()
    if (result.success) {
      setDirty(false)
    }
    return result
  }, [setDirty])

  const closeFile = useCallback(async () => {
    if (!confirmDiscardConflicts()) return
    // An agent window shows one agent: closing it (Close Agent, a cancelled password,
    // owner or review dialog) closes the window. Its queued messages go to the main window.
    if (isAgentWindow) {
      closeAgentWindow()
      return
    }
    // The password prompt was cancelled (or the file closed): nothing to re-attach after an unlock.
    reattachAfterUnlock.clear()
    // Its queued messages stay: a running agent moves to the background, where
    // they go at its turn's end; a stopped one keeps them until it is started,
    // shown in its chat when it is opened again.
    await openApi().closeFile()
    resetDocument()
    resetAgent()
    useAppStore.getState().resetAgentReview()
    useEditorTabsStore.getState().reset()
  }, [resetDocument, resetAgent])

  return { openFile, createFile, createQuickAgent, saveFile, closeFile, loadFileContents, completeFileOpen }
}
