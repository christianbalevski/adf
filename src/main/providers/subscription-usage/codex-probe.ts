import { fromCodexUsage, type UsageReport } from './adapters'

/** Codex's own usage endpoint. Unofficial: any change surfaces as a plain error. */
export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
export const CODEX_PROBE_TIMEOUT_MS = 8000

export interface CodexProbeAuth {
  getValidAccessToken: () => Promise<string>
  getAccountId: () => string | undefined
}

/** One GET of the usage endpoint with the headers the Codex client sends. Throws plain-language Errors. */
export async function probeCodexUsage(auth: CodexProbeAuth, fetchImpl: typeof fetch = fetch, now: () => number = Date.now): Promise<UsageReport> {
  let token: string
  try {
    token = await auth.getValidAccessToken()
  } catch (err) {
    throw new Error(`ChatGPT sign-in could not be used: ${err instanceof Error ? err.message : String(err)}`)
  }
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, originator: 'codex_cli_rs', Accept: 'application/json' }
  const accountId = auth.getAccountId()
  if (accountId) headers['ChatGPT-Account-ID'] = accountId

  let response: Response
  try {
    response = await fetchImpl(CODEX_USAGE_URL, { headers, signal: AbortSignal.timeout(CODEX_PROBE_TIMEOUT_MS) })
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new Error(`Codex usage endpoint did not answer within ${CODEX_PROBE_TIMEOUT_MS / 1000} s`)
    }
    throw new Error(`Codex usage endpoint could not be reached: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!response.ok) throw new Error(`Codex usage endpoint returned HTTP ${response.status}`)
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new Error('Codex usage endpoint returned a response that is not JSON')
  }
  const report = fromCodexUsage(body, now())
  if (!report) throw new Error('Codex usage endpoint returned no usage figures ADF can read')
  return report
}
