import { fromCodexUsage, fromGrokCredits, type UsageReport } from './adapters'

/**
 * On-demand usage checks against endpoints the providers' own CLIs call.
 * Unofficial: any change surfaces as a plain error naming the endpoint.
 */
export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
/** Grok Build's `/usage` (xai-org/grok-build, extensions/billing.rs). */
export const GROK_USAGE_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits'
export const PROBE_TIMEOUT_MS = 8000

export interface ProbeAuth {
  getValidAccessToken: () => Promise<string>
  getAccountId: () => string | undefined
}

interface Probe {
  /** Sign-in name, e.g. `ChatGPT`. */
  signIn: string
  /** Endpoint name, e.g. `Codex usage endpoint`. */
  endpoint: string
  url: string
  headers: (token: string, accountId: string | undefined) => Record<string, string>
  parse: (body: unknown, now: number) => UsageReport | null
}

/** One GET of a usage endpoint. Throws plain-language Errors. */
async function runProbe(probe: Probe, auth: ProbeAuth, fetchImpl: typeof fetch, now: () => number): Promise<UsageReport> {
  let token: string
  try {
    token = await auth.getValidAccessToken()
  } catch (err) {
    throw new Error(`${probe.signIn} sign-in could not be used: ${err instanceof Error ? err.message : String(err)}`)
  }
  let response: Response
  try {
    response = await fetchImpl(probe.url, { headers: probe.headers(token, auth.getAccountId()), signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new Error(`${probe.endpoint} did not answer within ${PROBE_TIMEOUT_MS / 1000} s`)
    }
    throw new Error(`${probe.endpoint} could not be reached: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!response.ok) throw new Error(`${probe.endpoint} returned HTTP ${response.status}`)
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new Error(`${probe.endpoint} returned a response that is not JSON`)
  }
  const report = probe.parse(body, now())
  if (!report) throw new Error(`${probe.endpoint} returned no usage figures ADF can read`)
  return report
}

const CODEX: Probe = {
  signIn: 'ChatGPT',
  endpoint: 'Codex usage endpoint',
  url: CODEX_USAGE_URL,
  headers: (token, accountId) => ({
    Authorization: `Bearer ${token}`,
    originator: 'codex_cli_rs',
    Accept: 'application/json',
    ...(accountId ? { 'ChatGPT-Account-ID': accountId } : {}),
  }),
  parse: fromCodexUsage,
}

const GROK: Probe = {
  signIn: 'Grok',
  endpoint: 'Grok usage endpoint',
  url: GROK_USAGE_URL,
  headers: (token, accountId) => ({
    Authorization: `Bearer ${token}`,
    'X-XAI-Token-Auth': 'xai-grok-cli',
    Accept: 'application/json',
    ...(accountId ? { 'x-userid': accountId } : {}),
  }),
  parse: fromGrokCredits,
}

export function probeCodexUsage(auth: ProbeAuth, fetchImpl: typeof fetch = fetch, now: () => number = Date.now): Promise<UsageReport> {
  return runProbe(CODEX, auth, fetchImpl, now)
}

export function probeGrokUsage(auth: ProbeAuth, fetchImpl: typeof fetch = fetch, now: () => number = Date.now): Promise<UsageReport> {
  return runProbe(GROK, auth, fetchImpl, now)
}
