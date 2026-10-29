import { spawn } from 'node:child_process'
import { daemonSettingsDir, readDaemonToken } from '../daemon/daemon-token'
import { readLocalProof } from '../daemon/local-access'
import { localBrowserOrigin, validatedBrowserLaunch } from '../services/studio-browser-launch'
import { browserLaunchCommand } from './auth-flow'
import { DEFAULT_DAEMON_PORT, isLocalDaemonUrl } from './daemon-url'

export const WEB_USAGE = `Usage: adf web [--port <n> | --url <local-daemon-url>] [--no-daemon]

Open Browser Studio already signed in. Starts this computer's daemon if needed.
No desktop Studio installation or token copying is required.
--no-daemon (or ADF_NO_AUTOSTART=1) disables automatic daemon startup.

On a headless host or for another device:
  adf daemon remote on
  adf daemon remote allow-network
  adf daemon pair
Open the displayed /studio/ address, enter the code, and approve in the terminal.
Remote access uses only the networks you allow.\n`

export interface WebCliIo {
  fetch: typeof fetch
  stdout(text: string): void
  stderr(text: string): void
  env?: NodeJS.ProcessEnv
  ensureDaemon?: (url: string, env: NodeJS.ProcessEnv) => Promise<unknown>
  openBrowser?: (url: string) => void | Promise<void>
}

/** Unlike OAuth's best-effort launcher, report failure without printing the ticket. */
export function openWebBrowser(url: string, deps: { spawn?: typeof spawn } = {}): Promise<void> {
  const { command, args } = browserLaunchCommand(url)
  return new Promise((resolve, reject) => {
    const child = (deps.spawn ?? spawn)(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
    // Some Linux launchers stay alive for the browser's lifetime. Dispatch is
    // enough; still report immediate missing-launcher and nonzero-exit errors.
    const timer = setTimeout(() => { child.unref(); resolve() }, 10_000)
    child.once('error', () => { clearTimeout(timer); reject(new Error('Browser launcher unavailable.')) })
    child.once('exit', code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error('Browser launch failed.')) })
  })
}

export async function runWebCommand(args: string[], io: WebCliIo): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { io.stdout(WEB_USAGE); return 0 }
  const env = { ...(io.env ?? process.env) }
  let explicitUrl: string | undefined
  let port: string | undefined
  let noDaemon = env.ADF_NO_AUTOSTART === '1'
  try {
    for (let i = 0; i < args.length; i++) {
      const [flag, inline] = args[i].split(/=(.*)/s)
      if (flag === '--no-daemon' && inline === undefined) { noDaemon = true; continue }
      const value = inline ?? args[++i]
      if (!value || value.startsWith('-')) throw new Error('Missing value.')
      if (flag === '--port' || flag === '-p') port = value
      else if (flag === '--url' || flag === '-u') explicitUrl = value
      else throw new Error('Unknown option.')
    }
    if (explicitUrl && port) throw new Error('Choose --port or --url.')
    if (port !== undefined && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) throw new Error('Invalid port.')
  } catch { io.stderr(WEB_USAGE); return 2 }
  // --port explicitly selects a local daemon; a saved default remote is never used.
  if (port) env.ADF_DAEMON_PORT = port
  const configuredPort = port ?? env.ADF_DAEMON_PORT
  const address = explicitUrl ?? (configuredPort ? `http://127.0.0.1:${configuredPort}` : env.ADF_DAEMON_URL ?? `http://127.0.0.1:${DEFAULT_DAEMON_PORT}`)
  let base: URL
  try { base = localBrowserOrigin(address) } catch {
    io.stderr('adf web signs in only to this computer’s daemon. On another host, use adf daemon pair and open its /studio/ address.\n')
    return 2
  }
  const origin = base.origin
  if (!isLocalDaemonUrl(origin, env)) {
    io.stderr('That address is not a known local daemon port. For a local daemon, select it with --port; for a tunnel or another host, use browser pairing.\n')
    return 2
  }
  try { if (!noDaemon) await io.ensureDaemon?.(origin, env) } catch {
    io.stderr('Could not start the local daemon. Run adf daemon start for details.\n'); return 1
  }
  const daemonPort = Number(base.port) || (base.protocol === 'https:' ? 443 : 80)
  const dataDir = daemonSettingsDir(env)
  const token = env.ADF_DAEMON_TOKEN || readDaemonToken(dataDir)
  const proof = readLocalProof(dataDir, daemonPort)
  if (!token || !proof) {
    io.stderr('The local daemon is not ready for browser sign-in. Start it with adf daemon start, or update it if it is already running.\n'); return 1
  }
  let target: string
  try {
    const response = await io.fetch(`${origin}/web/launch`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, 'X-ADF-Local-Proof': proof },
    })
    if (!response.ok) {
      io.stderr(response.status === 404
        ? 'This daemon does not support Browser Studio yet. Update adf and restart the daemon when you are ready.\n'
        : `Browser sign-in was refused (${response.status}). Check that this is the local daemon and run adf daemon status.\n`)
      return 1
    }
    const body = await response.json() as { url?: unknown } | null
    target = validatedBrowserLaunch(origin, body?.url)
  } catch {
    io.stderr('Could not get a valid browser sign-in link from the local daemon. Check adf daemon status and update adf if needed.\n'); return 1
  }
  try { await (io.openBrowser ?? openWebBrowser)(target) } catch {
    io.stderr('Could not open a browser on this computer. On a headless host, run adf daemon pair and open the displayed address on another device.\n'); return 1
  }
  io.stdout(`Opened Browser Studio at ${origin}/studio/ and requested automatic sign-in.\n`)
  return 0
}
