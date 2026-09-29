// Fleet operations. Every one reports its outcome twice: a toast, and a
// notice in the agent's main transcript (so the chat of that agent shows what
// the owner did to it). Destructive ones ask first.

import { DaemonError, MAIN_LOOP, type AgentRef } from '../../api/types'
import { transcriptKey, type AgentEntry, type ToastLevel } from '../../state/types'
import type { TuiStore } from '../../state/store'
import { findTracked, isTrackedKey } from '../../state/tracked'
import { agentName, describeAgent } from './model'
import { refreshFleetData } from './data'

function labelOf(store: TuiStore, agentId: string): string {
  const agent = store.getState().agents[agentId]
  return agent ? agentName(agent) : agentId
}

/** Toast + a notice item in (agent, loop)'s transcript. */
export function report(store: TuiStore, agentId: string | null, text: string, level: ToastLevel = 'info', loop = MAIN_LOOP) {
  store.actions.toast(text, level)
  if (agentId) store.actions.notice(agentId, loop, text, level === 'error' || level === 'warn' ? 'warn' : 'info')
}

function failure(store: TuiStore, agentId: string | null, verb: string, err: unknown) {
  if (err instanceof DaemonError && err.unreachable) store.dispatch({ type: 'daemon/reachable', reachable: false })
  report(store, agentId, `${verb} failed: ${err instanceof Error ? err.message : String(err)}`, 'error')
}

export async function startAgent(store: TuiStore, agentId: string): Promise<boolean> {
  // A tracked agent that is not loaded: load it, then start it (or review it first).
  if (isTrackedKey(agentId)) return (await store.actions.startTracked(agentId)) !== null
  const name = labelOf(store, agentId)
  try {
    const result = await store.client.start(agentId)
    report(store, agentId, `Started ${name}${result.startupTriggered ? ' (startup turn running)' : ''}${result.loaded ? ' (loaded from disk)' : ''}`, 'success')
    await store.actions.refreshAgent(agentId)
    return true
  } catch (err) {
    failure(store, agentId, `Start ${name}`, err)
    return false
  }
}

export async function stopAgent(store: TuiStore, agentId: string, options: { confirm?: boolean } = {}): Promise<boolean> {
  if (isTrackedKey(agentId)) {
    store.actions.toast(`${findTracked(store.getState(), agentId)?.agent.name ?? 'That agent'} is not running`, 'info', 2000)
    return false
  }
  const name = labelOf(store, agentId)
  const agent = store.getState().agents[agentId]
  const running = agent ? describeAgent(agent).runningLoops : []
  if (options.confirm !== false) {
    const ok = await store.actions.confirm({
      title: 'Stop agent',
      message: `Stop and unload ${name}? All its loops stop${running.length ? ` — running now: ${running.join(', ')}` : ''}. The .adf file is kept; load it again any time.`,
      confirmLabel: 'Stop',
      danger: true,
    })
    if (!ok) { store.actions.toast(`Kept ${name} running`, 'info', 2000); return false }
  }
  try {
    await store.client.stop(agentId)
    report(store, agentId, `Stopped and unloaded ${name}`, 'success')
    await store.actions.refreshAgents()
    void store.actions.refreshTracked()
    return true
  } catch (err) {
    failure(store, agentId, `Stop ${name}`, err)
    return false
  }
}

/**
 * Interrupt one loop's turn, or (no loop) every loop of the agent that is
 * running now. Each loop goes idle and keeps accepting work.
 */
export async function interruptAgent(store: TuiStore, agentId: string, loop?: string, options: { confirm?: boolean } = {}): Promise<boolean> {
  const name = labelOf(store, agentId)
  const agent = store.getState().agents[agentId]
  const targets = loop ? [loop] : agent ? describeAgent(agent).runningLoops : []
  if (targets.length === 0) { store.actions.toast(`${name} has no running turn`, 'info', 2500); return false }
  if (options.confirm !== false) {
    const ok = await store.actions.confirm({
      title: 'Interrupt turn',
      message: `Interrupt the running turn of ${name} in ${targets.map(t => `loop ${t}`).join(', ')}? Work in progress in that turn is dropped; the loop goes idle and keeps accepting chats, timers and triggers.`,
      confirmLabel: 'Interrupt',
      danger: true,
    })
    if (!ok) return false
  }
  let all = true
  for (const target of targets) {
    try {
      const result = await store.client.interrupt(agentId, target)
      store.dispatch({ type: 'transcript/idle', key: transcriptKey(agentId, target) })
      if (result.interrupted === false) store.actions.toast(`${name} ${target} was not running`, 'info', 2500)
      else report(store, agentId, `Turn interrupted by you (${name} ${target})`, 'warn', target)
    } catch (err) {
      all = false
      failure(store, agentId, `Interrupt ${name} ${target}`, err)
    }
  }
  return all
}

/**
 * Hard abort (daemon POST /abort): the loop's executor is left stopped and
 * runs nothing more (no chats, timers, triggers) until the agent is reloaded.
 */
export async function abortAgent(store: TuiStore, agentId: string, loop?: string, options: { confirm?: boolean } = {}): Promise<boolean> {
  const name = labelOf(store, agentId)
  const agent = store.getState().agents[agentId]
  const targets = loop ? [loop] : agent ? describeAgent(agent).runningLoops : []
  if (targets.length === 0) { store.actions.toast(`${name} has no running turn`, 'info', 2500); return false }
  if (options.confirm !== false) {
    const ok = await store.actions.confirm({
      title: 'Hard abort',
      message: `Hard-abort ${name} in ${targets.map(t => `loop ${t}`).join(', ')}? The turn is dropped AND that loop stops: it runs no chats, timers or triggers until the agent is stopped and loaded again. To just end the turn, use interrupt (a / Esc).`,
      confirmLabel: 'Hard abort',
      danger: true,
    })
    if (!ok) return false
  }
  let all = true
  for (const target of targets) {
    try {
      await store.client.abort(agentId, target)
      store.dispatch({ type: 'transcript/idle', key: transcriptKey(agentId, target) })
      report(store, agentId, `Turn aborted by you (${name} ${target}); loop stopped until the agent is reloaded`, 'warn', target)
    } catch (err) {
      all = false
      failure(store, agentId, `Abort ${name} ${target}`, err)
    }
  }
  return all
}

export interface LoadOptions {
  requireReview?: boolean
  start?: boolean
}

/**
 * Load an .adf. With `requireReview` an unreviewed file is shown to the owner
 * (name, path) and only loaded if they accept the review.
 */
export async function loadAgent(store: TuiStore, filePath: string, options: LoadOptions = {}): Promise<AgentRef | null> {
  let ref: AgentRef
  try {
    ref = await store.client.load(filePath, options.requireReview === true)
  } catch (err) {
    if (err instanceof DaemonError && err.status === 403 && isReviewRequired(err.body)) {
      const accepted = await reviewAndAccept(store, filePath)
      if (!accepted) return null
      return loadAgent(store, filePath, { ...options, requireReview: true })
    }
    failure(store, null, `Load ${filePath}`, err)
    return null
  }
  const name = ref.config?.handle || ref.config?.name || ref.id
  report(store, ref.id, `Loaded ${name} from ${ref.filePath ?? filePath}${options.requireReview ? ' (review checked)' : ''}`, 'success')
  await store.actions.refreshAgents()
  void store.actions.refreshTracked()
  store.actions.selectAgent(ref.id)
  if (options.start) await startAgent(store, ref.id)
  return ref
}

function isReviewRequired(body: unknown): boolean {
  return !!body && typeof body === 'object' && (body as { code?: unknown }).code === 'AGENT_REVIEW_REQUIRED'
}

async function reviewAndAccept(store: TuiStore, filePath: string): Promise<boolean> {
  let summary = ''
  try {
    const info = await store.client.review(filePath)
    const s = info.summary as unknown as Record<string, unknown>
    const bits = [s?.name, s?.description].filter(v => typeof v === 'string' && v).join(' — ')
    summary = bits ? `\n${bits}` : ''
  } catch {
    // The confirm still names the file.
  }
  const ok = await store.actions.confirm({
    title: 'Review required',
    message: `${filePath} has not been reviewed on this daemon.${summary}\nAccept the review and load it?`,
    confirmLabel: 'Accept + load',
    danger: true,
  })
  if (!ok) { store.actions.toast('Not loaded (review declined)', 'warn'); return false }
  try {
    await store.client.acceptReview(filePath)
    store.actions.toast(`Review accepted for ${filePath}`, 'success')
    return true
  } catch (err) {
    failure(store, null, 'Accept review', err)
    return false
  }
}

/** Scan the daemon's tracked directories and start every eligible autostart agent. */
export async function runAutostart(store: TuiStore, dirs?: string[]): Promise<boolean> {
  let trackedDirs = dirs
  if (!trackedDirs || trackedDirs.length === 0) {
    try {
      trackedDirs = (await store.client.runtimeSettings()).trackedDirectories
    } catch (err) {
      failure(store, null, 'Autostart (reading tracked directories)', err)
      return false
    }
  }
  if (!trackedDirs.length) { store.actions.toast('No tracked directories in the daemon settings — /autostart <dir>', 'warn'); return false }
  const ok = await store.actions.confirm({
    title: 'Autostart',
    message: `Scan ${trackedDirs.join(', ')} and start every reviewed agent configured for autostart?`,
    confirmLabel: 'Scan + start',
  })
  if (!ok) return false
  try {
    const result = await store.client.autostart(trackedDirs)
    for (const s of result.started) report(store, s.agentId, `Autostarted ${s.name}${s.startupTriggered ? ' (startup turn running)' : ''}`, 'success')
    const skipped = result.skipped.filter(s => s.reason !== 'already_loaded' && s.reason !== 'not_autostart')
    const tail = [
      skipped.length ? `skipped ${skipped.map(s => `${s.name} (${s.reason})`).join(', ')}` : '',
      result.failed.length ? `failed ${result.failed.map(f => `${f.name}: ${f.error}`).join('; ')}` : '',
    ].filter(Boolean).join(' · ')
    store.actions.toast(`Autostart: scanned ${result.scanned}, started ${result.started.length}${tail ? ` · ${tail}` : ''}`, result.failed.length ? 'warn' : 'success', 8000)
    await store.actions.refreshAgents()
    await store.actions.refreshTracked()
    return true
  } catch (err) {
    failure(store, null, 'Autostart', err)
    return false
  }
}

export async function refreshFleet(store: TuiStore): Promise<void> {
  await store.actions.refreshAgents()
  await store.actions.refreshTracked()
  await refreshFleetData(store)
  store.actions.toast('Fleet refreshed', 'info', 1500)
}

/** Open (agent, loop) in the Chat view with the prompt focused. */
export function openChat(store: TuiStore, agentId: string, loop = MAIN_LOOP) {
  if (store.getState().selectedAgentId !== agentId) store.actions.selectAgent(agentId)
  if (!isTrackedKey(agentId)) store.actions.selectLoop(agentId, loop)
  store.actions.setView('chat')
  store.actions.setFocus('input')
}

export function selectedEntry(store: TuiStore): AgentEntry | undefined {
  const id = store.getState().selectedAgentId
  return id ? store.getState().agents[id] : undefined
}
