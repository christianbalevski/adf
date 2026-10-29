import { BrowserWindow, dialog, shell } from '../platform'
import { DaemonError } from '../../../../shared/daemon-client'
import type { McpRegistrationTestResult } from '../../../../shared/types/ipc.types'
import { enc, type DaemonModeContext } from '../context'
import { errorText } from './common'
import { awaitDaemonJob, startDaemonJob } from './jobs'

/**
 * MCP_REGISTRATION_TEST (Settings → MCP "Connect") on the daemon: W1-D's job
 * (POST /admin/mcp/registration-test) and its interactive steps, which the
 * daemon hands to the client because it cannot open a browser or a dialog:
 *
 * - `open_url` (an OAuth authorization page, or the URL the stdio auth
 *   preflight found): opened with shell.openExternal, as embedded Studio's
 *   OAuth IO and preflight do, then acknowledged;
 * - `confirm` (the stdio auth preflight's "complete authorization in your
 *   browser, then Continue"): the same native dialog as embedded
 *   (ipc/index.ts studioMcpAuthPreflight), answered when the user clicks
 *   Continue.
 *
 * The renderer awaits one promise; it resolves with the job's result, which
 * is the embedded handler's McpRegistrationTestResult. An OAuth sign-in waits
 * up to 5 minutes for its callback, so the wait allows TEST_DEADLINE_MS.
 */

const TEST_DEADLINE_MS = 30 * 60_000
const POLL_MS = 300

interface McpInteraction {
  id: string
  kind: 'open_url' | 'confirm'
  state: 'pending' | 'timed_out'
  serverName?: string
  url?: string
  authUrlOpened?: boolean
}

/** Only a web page is opened. */
function isWebUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

/** A failed result when the daemon could not tell how the test ended (location as the embedded validation exit derives it). */
function failedResult(rawArgs: unknown, error: string): McpRegistrationTestResult {
  const reg = (rawArgs as { registration?: { url?: unknown; type?: unknown; runLocation?: unknown } } | null | undefined)?.registration
  const location: McpRegistrationTestResult['location'] =
    reg?.type === 'http' || typeof reg?.url === 'string' ? 'remote http' : reg?.runLocation === 'host' ? 'host' : 'shared container'
  return { success: false, tools: [], error, location, authRan: false, notes: [] } as McpRegistrationTestResult
}

/** The embedded preflight's Continue dialog, word for word. */
async function showContinueDialog(serverName: string, authUrlOpened: boolean): Promise<void> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? undefined
  await dialog.showMessageBox({
    ...(win ? { window: win } : {}),
    type: 'info',
    title: `MCP Authorization — ${serverName}`,
    message: 'Complete authorization in your browser, then click Continue.',
    detail: authUrlOpened
      ? `An authorization page has been opened in your browser for "${serverName}". Complete the authorization flow, then click Continue.`
      : `The "${serverName}" MCP server is running for interactive authorization. If a browser window opened, complete the flow and click Continue. If no browser opened, check the logs for an authorization URL.`,
    buttons: ['Continue'],
    defaultId: 0,
  } as Electron.MessageBoxOptions)
}

/** The page opened, but its callback is not relayed (a port in use here): said where the user started the sign-in. */
async function showRelayWarning(serverName: string, reason: string): Promise<void> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? undefined
  await dialog.showMessageBox({
    ...(win ? { window: win } : {}),
    type: 'warning',
    title: `MCP Authorization — ${serverName}`,
    message: 'The sign-in may not reach the ADF daemon.',
    detail: reason,
    buttons: ['OK'],
  } as Electron.MessageBoxOptions).catch(() => {})
}

export async function runRegistrationTest(ctx: DaemonModeContext, rawArgs: unknown): Promise<McpRegistrationTestResult> {
  let jobId: string
  try {
    jobId = (await startDaemonJob(await ctx.ready(), '/admin/mcp/registration-test', rawArgs ?? {})).jobId
  } catch (err) {
    // Refused (429 too many jobs) or unreachable: a failed result, as every other ending.
    return failedResult(rawArgs, errorText(err))
  }
  const handled = new Set<string>()
  /** Remote mode: the sign-in page was not opened; the test is cancelled and ends with this reason. */
  let stoppedBecause: string | null = null

  const answer = async (id: string): Promise<void> => {
    try {
      await (await ctx.ready()).request('POST', `/admin/mcp/interactions/${enc(id)}/continue`)
    } catch (err) {
      // Timed out, or the test ended meanwhile: nothing waits for the answer any more.
      if (!(err instanceof DaemonError && err.status === 404)) ctx.log.warn(`[MCP] Could not answer an interactive step of the connect test: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const step = async (entry: McpInteraction): Promise<void> => {
    if (entry.kind === 'open_url') {
      // Remote mode: the page's loopback callback is on the daemon's machine;
      // the relay takes it on this computer and hands it over (§9.3, W4-B).
      if (ctx.mode === 'remote' && ctx.remote) {
        const label = `Connect test for "${entry.serverName ?? 'server'}"`
        let result: { opened: boolean; relaying?: boolean; reason?: string }
        try {
          result = await ctx.remote.oauth.open(entry.url ?? '', label)
        } catch (err) {
          result = { opened: false, reason: `Studio could not open the sign-in page: ${err instanceof Error ? err.message : String(err)}` }
        }
        if (!result.opened) {
          // Shown where the user started it: the test ends now with the reason, instead of waiting out the sign-in.
          ctx.log.warn(`[MCP] ${label}: the authorization page was not opened: ${result.reason ?? 'refused'}`)
          stoppedBecause = result.reason ?? 'The sign-in page was not opened.'
          try { await (await ctx.ready()).request('POST', `/jobs/${enc(jobId)}/cancel`) } catch { /* ended meanwhile */ }
          return
        }
        if (result.reason) void showRelayWarning(entry.serverName ?? 'server', result.reason)
        await answer(entry.id)
        return
      }
      if (entry.url && isWebUrl(entry.url)) {
        ctx.log.log(`[MCP] Connect test for "${entry.serverName ?? 'server'}": opening its authorization page in the browser`)
        try { await shell.openExternal(entry.url) } catch (err) {
          ctx.log.warn(`[MCP] Could not open the authorization page: ${err instanceof Error ? err.message : String(err)}`)
        }
      } else {
        ctx.log.warn(`[MCP] Connect test for "${entry.serverName ?? 'server'}": the authorization URL is not a web page; not opened`)
      }
      await answer(entry.id)
      return
    }
    await showContinueDialog(entry.serverName ?? 'server', entry.authUrlOpened === true)
    await answer(entry.id)
  }

  const outcome = await awaitDaemonJob(() => ctx.ready(), jobId, {
    what: 'the MCP connect test',
    deadlineMs: TEST_DEADLINE_MS,
    // Started without a key: nobody else waits on this test.
    cancelOnDeadline: true,
    pollMs: POLL_MS,
    log: ctx.log,
    onPoll: async (job) => {
      if (job.state !== 'running') return
      let list: { interactions: McpInteraction[] }
      try {
        list = await (await ctx.ready()).request<{ interactions: McpInteraction[] }>('GET', '/admin/mcp/interactions', { query: { jobId } })
      } catch {
        return // the next poll tries again; the job poll reports a lost daemon
      }
      for (const entry of list.interactions) {
        if (entry.state !== 'pending' || handled.has(entry.id)) continue
        handled.add(entry.id)
        // A dialog waits for the user; the job keeps being polled meanwhile.
        void step(entry)
      }
    },
  })
  if (stoppedBecause) return failedResult(rawArgs, stoppedBecause)
  if (outcome.kind === 'lost') return failedResult(rawArgs, outcome.reason)
  const { job } = outcome
  if (job.state === 'succeeded') return job.result as McpRegistrationTestResult
  return failedResult(rawArgs, job.error ?? `The connect test ${job.state}`)
}
