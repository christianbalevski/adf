// The TUI side of subscription sign-in: the shared flows from cli/auth-flow.ts
// (the same code `adf auth login` runs) over the TUI's daemon client.

import * as authFlowNs from '../../cli/auth-flow'
import { cjs } from '../interop'
import type { DaemonClient } from '../api/client'
import type { SubscriptionProvider } from '../api/types'
import type { AuthCallbackServer, AuthOutcome, ChatGptStartInfo, GrokStartInfo } from '../../cli/auth-flow'

const { loginChatGpt, loginGrok, openBrowser } = cjs(authFlowNs)

export type { AuthOutcome, ChatGptStartInfo, GrokStartInfo }

interface Seams {
  openBrowser: (url: string) => void
  sleep?: (ms: number) => Promise<void>
  startCallbackServer?: () => Promise<AuthCallbackServer>
}

let seams: Seams = { openBrowser }

/** Tests: no real browser, fast polling, a fake callback server. `null` restores the defaults. */
export function setAuthFlowSeams(next: Partial<Seams> | null): void {
  seams = next ? { openBrowser, ...next } : { openBrowser }
}

/** Open `url` in the default browser (cli/auth-flow's opener: rundll32 on Windows, never cmd). Best effort. */
export function openUrl(url: string): void {
  seams.openBrowser(url)
}

export interface SignInHandlers {
  onChatGpt?: (info: ChatGptStartInfo) => void
  onGrok?: (info: GrokStartInfo) => void
}

/** Run one sign-in. Abort `signal` to cancel (outcome `cancelled`). Never throws. */
export async function signIn(client: DaemonClient, provider: SubscriptionProvider, signal: AbortSignal, handlers: SignInHandlers): Promise<AuthOutcome> {
  const deps = {
    request: (method: 'GET' | 'POST', path: string, body?: Record<string, unknown>) => client.request<unknown>(method, path, body === undefined ? {} : { body }),
    signal,
    openBrowser: seams.openBrowser,
    sleep: seams.sleep,
    startCallbackServer: seams.startCallbackServer,
  }
  try {
    return provider === 'chatgpt'
      ? await loginChatGpt(deps, { daemonUrl: client.baseUrl, onStart: info => handlers.onChatGpt?.(info) })
      : await loginGrok(deps, { onStart: info => handlers.onGrok?.(info) })
  } catch (err) {
    if (signal.aborted) return { ok: false, error: 'Sign-in cancelled', cancelled: true }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
