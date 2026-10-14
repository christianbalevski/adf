import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readDaemonToken, daemonTokenPath } from '../../daemon/daemon-token'
import { DaemonProcessController } from '../daemon-process'
import type { DaemonConnector } from './connection'

export { remoteDaemonConnector } from './remote/connector'

/**
 * The two ways Studio finds its daemon (design §8.2, §9).
 *
 * Local: attach to the daemon on Studio's own settings file, or spawn one
 * (daemon-process.ts: same pid file and log as the CLI, detached, refuses a
 * daemon on other settings or another client API version). The token is the
 * daemon's token file in that data dir, or ADF_DAEMON_TOKEN.
 *
 * Remote: the URL and the `safe:` token from studio-backend.json, after the
 * transport rule and a version handshake (remote/connector.ts, W4-B).
 *
 * Both throw with a sentence the status dialog shows; neither message
 * contains the token.
 */

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{32,}$/

async function readTokenFile(dataDir: string): Promise<string | null> {
  try {
    const raw = (await readFile(daemonTokenPath(dataDir), 'utf-8')).trim()
    return TOKEN_SHAPE.test(raw) ? raw : null
  } catch {
    return null
  }
}

export function localDaemonConnector(opts: {
  userDataDir: string
  execPath: string
  daemonEntry: string
  env?: NodeJS.ProcessEnv
  log?: (line: string) => void
}): DaemonConnector {
  const env = opts.env ?? process.env
  // Built before it runs: the log path is known even when the start fails.
  const controller = new DaemonProcessController({
    settingsPath: join(opts.userDataDir, 'adf-settings.json'),
    userDataDir: opts.userDataDir,
    daemonEntry: opts.daemonEntry,
    execPath: opts.execPath,
    env,
  }, opts.log ? { log: opts.log } : {})
  const connect = async (progress: (text: string) => void) => {
    const result = await controller.ensure(progress)
    if (result.kind === 'refused') {
      // Version mismatch: the restart-or-embedded choice of §8.2 ships with the mode switch (W4-A).
      throw new Error(result.decision.message)
    }
    if (result.kind === 'unidentified') throw new Error(result.message)
    const { handle } = result
    const dataDir = controller.paths.dataDir
    let token = env.ADF_DAEMON_TOKEN ?? await readTokenFile(dataDir)
    return {
      baseUrl: handle.url,
      logFile: controller.paths.logFile,
      description: `the ADF daemon pid ${handle.pid} on ${handle.url} (${result.kind}; version ${handle.info.version}, started by ${handle.info.startedBy})`,
      source: {
        token: () => token ?? undefined,
        // A 401 after the daemon minted a new token: re-read the file once.
        // Synchronous, on the failure path only.
        refresh: () => {
          if (env.ADF_DAEMON_TOKEN) return false
          const fresh = readDaemonToken(dataDir)
          if (!fresh || fresh === token) return false
          token = fresh
          return true
        },
      },
    }
  }
  return Object.assign(connect, { logFile: controller.paths.logFile })
}

