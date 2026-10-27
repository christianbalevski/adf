#!/usr/bin/env node
// `adf`: the one executable (npm package @agentdocumentformat/cli, and
// `npm run adf` from source).
//   adf                                 the terminal app (starts the daemon if needed)
//   adf <command> ...                   one-shot CLI (see `adf help`)
//   adf daemon [--port N] [--host H]    run the daemon in the foreground
//   adf daemon start|status|stop|restart|logs
//   adf --version                       print the package version
// Dev: `npm run adf -- ...` (tsx src/main/cli/bin.ts). The bundle
// (scripts/build-npm.mjs) defines __ADF_VERSION__.

// The only static import, and it runs first: on a runtime with the
// CVE-2026-111497 Brotli decoder (Node.js below 22.23.4 / 24.22.1 / 26.12.1,
// 23.x, 25.x) adf exits here, before any command, daemon or TUI code loads.
import '../utils/brotli-runtime-check'

declare const __ADF_VERSION__: string | undefined

function version(): string {
  if (typeof __ADF_VERSION__ === 'string') return __ADF_VERSION__
  return process.env.npm_package_version ?? 'dev'
}

const DAEMON_HELP = `Usage: adf daemon [--port <n>] [--host <h>] [--settings <file>]
       adf daemon start [--port <n>] [--force]
       adf daemon status | stop | restart [--port <n>]
       adf daemon logs [-f] [-n <lines>] [--port <n>]
       adf daemon token
       adf daemon remote on [--name <name>] | off | status | trust | untrust | serve on|off
       adf daemon devices [list | add <label> | revoke <id|label>]
       adf daemon pair

Without a subcommand the daemon runs in the foreground (Ctrl+C stops it).
start runs it in the background, like adf does on its own when it needs one;
the log goes to <data dir>/logs/adf-daemon.log. stop is graceful: agents are
unloaded and compute containers stopped.

Every request but GET /health needs the daemon's access token. adf reads it
on this machine by itself (<data dir>/daemon-token, created on first start);
token prints it for a client elsewhere (--token or ADF_DAEMON_TOKEN there).
ADF_DAEMON_TOKEN overrides the file, and is required with a non-loopback
--host (plus ADF_DAEMON_ALLOWED_HOSTS for host names clients use).
Behind a reverse proxy on this host set ADF_DAEMON_BEHIND_PROXY=1: identity
secrets and stop then work only from adf on this host, against its loopback port.

remote on (remote access) does this without any of that: the daemon
listens on this computer's private-network and Tailscale addresses too (no
restart), and each other computer gets its own device token (pair, or
devices add). A device token is as powerful as your owner seed phrase.
See adf daemon remote --help.

Environment: ADF_DAEMON_PORT, ADF_DAEMON_HOST, ADF_DAEMON_SETTINGS,
ADF_USER_DATA_DIR, ADF_DAEMON_PIDFILE, ADF_DAEMON_TOKEN,
ADF_DAEMON_ALLOWED_HOSTS, ADF_DAEMON_BEHIND_PROXY`

/** Maps `adf daemon` flags onto the env the daemon reads at boot. */
export function applyDaemonArgs(args: string[], env: NodeJS.ProcessEnv = process.env): void {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined]
    const value = (): string => {
      const v = inline ?? args[++i]
      if (v === undefined) throw new Error(`${flag} requires a value`)
      return v
    }
    if (flag === '--port' || flag === '-p') env.ADF_DAEMON_PORT = value()
    else if (flag === '--host') env.ADF_DAEMON_HOST = value()
    else if (flag === '--settings') env.ADF_DAEMON_SETTINGS = value()
    else throw new Error(`Unknown daemon option: ${arg}\n\n${DAEMON_HELP}`)
  }
}

const DAEMON_SUBCOMMANDS = new Set(['start', 'status', 'stop', 'restart', 'logs', 'token', 'remote', 'devices', 'pair'])

async function daemonSubcommand(sub: string, args: string[]): Promise<number> {
  const control = await import('./daemon-control')
  const out = (text: string) => { process.stdout.write(text) }
  const { url, rest } = control.daemonUrlFrom(args)
  const target = control.daemonTarget(url)
  const force = rest.includes('--force')
  // Host management is this computer's (F3): no other computer gets this machine's token, its proof or a saved device token.
  const refusal = sub === 'logs' || sub === 'token' ? null : control.hostOnlyRefusal(sub, target)
  if (refusal) {
    process.stderr.write(`${refusal}\n`)
    return 2
  }
  const start = async (): Promise<number> => {
    if (await control.isHealthy(target.url)) { out(`The ADF daemon is already running at ${target.url}.\n`); return 0 }
    try {
      await control.startDaemon(target, { force })
      return 0
    } catch (err) {
      const advice = (err as { advice?: string }).advice
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n${advice ? `${advice}\n` : ''}`)
      return 1
    }
  }
  switch (sub) {
    case 'start':
      return await start()
    case 'status': {
      const { running, lines } = await control.daemonStatus(target)
      out(`${lines.join('\n')}\n`)
      return running ? 0 : 3
    }
    case 'stop': {
      out(`Stopping the ADF daemon at ${target.url}…\n`)
      const result = await control.stopDaemon(target)
      out(`${result.message}\n`)
      return result.stopped ? 0 : 1
    }
    case 'restart': {
      if (await control.isHealthy(target.url)) {
        out(`Stopping the ADF daemon at ${target.url}…\n`)
        const result = await control.stopDaemon(target)
        out(`${result.message}\n`)
        if (!result.stopped) return 1
      }
      return await start()
    }
    case 'token': {
      // stdout carries only the token (pipeable); where it came from goes to stderr.
      if (process.env.ADF_DAEMON_TOKEN) {
        process.stderr.write('(from ADF_DAEMON_TOKEN)\n')
        out(`${process.env.ADF_DAEMON_TOKEN}\n`)
        return 0
      }
      const { ensureDaemonToken } = await import('../daemon/daemon-token')
      const { token, path } = ensureDaemonToken(control.daemonPaths(target.port).dataDir)
      process.stderr.write(`(${path})\n`)
      out(`${token}\n`)
      return 0
    }
    case 'remote':
    case 'devices':
    case 'pair': {
      // Remote access works only while the daemon runs: `remote on` starts it, the rest say so.
      const turningOn = sub === 'remote' && rest[0] === 'on'
      const help = rest.includes('--help') || rest.includes('-h')
      if (!help && !(await control.isHealthy(target.url))) {
        if (!turningOn) {
          process.stderr.write(`The ADF daemon is not running at ${target.url}; remote access works only while it runs. Start it with: adf daemon start\n`)
          return 3
        }
        if ((await start()) !== 0) return 1
      }
      const [{ runHostRemoteCommand }, { stdinPrompt }] = await Promise.all([import('./remote-access-cli'), import('./prompt')])
      const prompt = stdinPrompt()
      try {
        return await runHostRemoteCommand(sub as 'remote' | 'devices' | 'pair', rest, {
          fetch: globalThis.fetch.bind(globalThis),
          stdout: out,
          stderr: (text) => { process.stderr.write(text) },
          prompt: (q) => prompt.ask(q),
          onInterrupt: (fn) => {
            process.on('SIGINT', fn)
            return () => { process.off('SIGINT', fn) }
          },
        }, { url: target.url, port: target.port, dataDir: control.daemonPaths(target.port).dataDir })
      } finally {
        prompt.close()
      }
    }
    case 'logs': {
      const follow = rest.includes('-f') || rest.includes('--follow')
      const at = rest.findIndex(a => a === '-n' || a === '--lines')
      const lines = at >= 0 ? Number(rest[at + 1]) || 50 : 50
      const file = control.daemonPaths(target.port).logFile
      if (!follow) {
        const tail = control.tailLines(file, lines)
        out(tail ? `${tail}\n` : `No log yet at ${file} (it is written by a daemon adf started in the background).\n`)
        return 0
      }
      out(`${file} (Ctrl+C stops following)\n`)
      await control.followLog(file, { lines, follow: true, write: out })
      return 0
    }
  }
  return 2
}

async function main(argv: string[]): Promise<number> {
  // --no-daemon: never start a daemon on our own (also ADF_NO_AUTOSTART=1).
  const noDaemon = argv.includes('--no-daemon')
  if (noDaemon) argv = argv.filter(a => a !== '--no-daemon')
  // --remote <name>: a daemon saved by adf pair, for this invocation (remotes.ts).
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--remote' || arg.startsWith('--remote=')) {
      const value = arg === '--remote' ? argv[i + 1] : arg.slice('--remote='.length)
      if (!value) {
        process.stderr.write('--remote requires a name (adf remotes lists them)\n')
        return 2
      }
      process.env.ADF_REMOTE = value
      argv = [...argv.slice(0, i), ...argv.slice(i + (arg === '--remote' ? 2 : 1))]
      break
    }
  }
  const [command, ...rest] = argv
  if (command === '--version' || command === '-v' || command === 'version') {
    process.stdout.write(`${version()}\n`)
    return 0
  }
  if (command === 'daemon') {
    if (rest.includes('--help') || rest.includes('-h')) {
      process.stdout.write(`${DAEMON_HELP}\n`)
      return 0
    }
    if (rest[0] && DAEMON_SUBCOMMANDS.has(rest[0])) return await daemonSubcommand(rest[0], rest.slice(1))
    try {
      applyDaemonArgs(rest)
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
      return 2
    }
    // A pid file lets `adf daemon status|stop` find this daemon too.
    if (!process.env.ADF_DAEMON_PIDFILE) {
      const { daemonPaths } = await import('./daemon-control')
      process.env.ADF_DAEMON_PIDFILE = daemonPaths(Number(process.env.ADF_DAEMON_PORT ?? 7385)).pidFile
    }
    // The daemon module boots on import and owns the process from here on
    // (signal handlers, exit codes).
    await import('../daemon/index')
    return -1
  }
  const [{ runCli, tuiInvocation }, control] = await Promise.all([import('./index'), import('./daemon-control')])
  // The TUI renders with React's production build (the development build is
  // several times slower). It must be chosen before React first loads, which
  // in the bundle can be as soon as the TUI chunk does. Marked, so a daemon
  // started from here does not inherit it.
  if (tuiInvocation(argv) && process.env.NODE_ENV === undefined) {
    process.env.NODE_ENV = 'production'
    process.env.ADF_NODE_ENV_DEFAULTED = '1'
  }
  return await runCli(argv, {
    fetch: globalThis.fetch.bind(globalThis),
    stdout: text => process.stdout.write(text),
    stderr: text => process.stderr.write(text),
    ensureDaemon: url => control.ensureDaemon(url, { disabled: noDaemon }),
  })
}

main(process.argv.slice(2)).then(
  (code) => { if (code >= 0) process.exitCode = code },
  (err) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
    process.exitCode = 1
  },
)
