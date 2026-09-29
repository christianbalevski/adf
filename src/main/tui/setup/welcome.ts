// Welcome screen: what ADF is, and a getting-started checklist whose steps
// tick themselves off from the daemon's state. Shown over the normal UI on
// the first WELCOME_LAUNCHES launches (until "don't show again"); /welcome
// reopens it any time. Pure helpers here; the dialog is WelcomeDialog.tsx.

import type { TuiState } from '../state/types'
import { getPrefs, savePrefs } from '../app/prefs'

export const WELCOME_OVERLAY = 'welcome'
export const WELCOME_LAUNCHES = 3

export const WELCOME_TITLE = 'Welcome to ADF'
export const WELCOME_INTRO = [
  'ADF agents are a new kind of agent: portable and self-contained. Each is a single .adf file that carries its own mind, memory, files and history. Move it anywhere and it picks up where it left off.',
  'Agents work in their own virtual files. They only touch your machine if you give them host access (compute_exec) or MCP tools that do.',
]

export type WelcomeStepId = 'identity' | 'model' | 'agent' | 'messaging' | 'tasks'

export interface WelcomeFacts {
  /** null: the daemon reports no owner identity (older daemon): the step is left out. */
  identityReady: boolean | null
  modelReady: boolean
  agentLoaded: boolean
  messagingConnected: boolean
  tasksGiven: boolean
}

export interface WelcomeStep {
  id: WelcomeStepId
  label: string
  /** What the row shows after the label: the command, with a word on what it does. */
  shown: string
  /** What Enter runs. */
  run: string
  done: boolean
}

export function welcomeSteps(facts: WelcomeFacts): WelcomeStep[] {
  const steps: WelcomeStep[] = []
  if (facts.identityReady === false) steps.push({ id: 'identity', label: 'Set up your identity', shown: '/identity', run: '/identity', done: false })
  steps.push(
    { id: 'model', label: 'Connect a model', shown: '/login chatgpt · /provider add', run: '/provider add', done: facts.modelReady },
    { id: 'agent', label: 'Create an agent', shown: '/new', run: '/new', done: facts.agentLoaded },
    { id: 'messaging', label: 'Connect a channel', shown: '/channels add  Telegram · Discord · Slack · Email · WhatsApp', run: '/channels add', done: facts.messagingConnected },
    { id: 'tasks', label: 'Give it tasks', shown: 'chat with it, or schedule a loop  /loop new', run: '/loop new', done: facts.tasksGiven },
  )
  return steps
}

/** Index of the first step not done yet (the last step when all are done). */
export function nextStepIndex(steps: WelcomeStep[]): number {
  const at = steps.findIndex(s => !s.done)
  return at >= 0 ? at : Math.max(0, steps.length - 1)
}

/** Extra facts the state does not hold: agent configs and timers, read once by the dialog. */
export interface WelcomeExtras {
  /** agentId → configured adapter types (enabled). */
  adapters: Record<string, string[]>
  /** agentId → timer count. */
  timers: Record<string, number>
}

const EMPTY_EXTRAS: WelcomeExtras = { adapters: {}, timers: {} }

export function enabledAdapters(config: { adapters?: Record<string, { enabled?: boolean } | undefined> } | undefined): string[] {
  return Object.entries(config?.adapters ?? {}).filter(([, c]) => c?.enabled !== false).map(([type]) => type)
}

export function welcomeFacts(state: Pick<TuiState, 'identity' | 'auth' | 'agents' | 'agentOrder'>, extras: WelcomeExtras = EMPTY_EXTRAS): WelcomeFacts {
  const auth = state.auth
  const signedIn = !!(auth?.chatgpt as { authenticated?: boolean } | undefined)?.authenticated || !!(auth?.grok as { authenticated?: boolean } | undefined)?.authenticated
  const keyed = (auth?.providers ?? []).some(p => (p as { hasApiKey?: boolean }).hasApiKey === true)
  const ids = state.agentOrder.filter(id => state.agents[id])
  const messaging = ids.some(id => enabledAdapters(state.agents[id]?.config as never).length > 0 || (extras.adapters[id]?.length ?? 0) > 0)
  const tasks = ids.some(id => {
    const loops = state.agents[id]?.loops ?? []
    if (loops.some(l => l.info.name !== 'main')) return true
    if (loops.some(l => l.info.name === 'main' && ((l.info as { entryCount?: number }).entryCount ?? 0) > 0)) return true
    return (extras.timers[id] ?? 0) > 0
  })
  return {
    identityReady: state.identity ? state.identity.status === 'ready' : null,
    modelReady: signedIn || keyed,
    agentLoaded: ids.length > 0,
    messagingConnected: messaging,
    tasksGiven: tasks,
  }
}

/**
 * Count this launch; true when the welcome should open (one of the first
 * WELCOME_LAUNCHES launches and not dismissed for good).
 */
export function recordWelcomeLaunch(): boolean {
  const welcome = getPrefs().welcome ?? {}
  if (welcome.dismissed) return false
  const launches = (welcome.launches ?? 0) + 1
  savePrefs({ welcome: { launches } })
  return launches <= WELCOME_LAUNCHES
}

/** "Don't show again". */
export function dismissWelcome(): void {
  savePrefs({ welcome: { dismissed: true } })
}
