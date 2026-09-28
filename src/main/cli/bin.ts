#!/usr/bin/env node
// `adf`: the one executable (npm package agent-document-format, and
// `npm run adf` from source).
//   adf                                 interactive TUI (starts the daemon if needed)
//   adf <command> ...                   one-shot CLI (see `adf help`)
//   adf daemon [--port N] [--host H]    run the daemon in the foreground
//   adf daemon start|status|stop|restart|logs
//   adf --version                       print the package version
// Dev: `npm run adf -- ...` (tsx src/main/cli/bin.ts). The bundle
// (scripts/build-npm.mjs) defines __ADF_VERSION__.

declare const __ADF_VERSION__: string | undefined

const MIN_NODE_MAJOR = 22

function version(): string {
  if (typeof __ADF_VERSION__ === 'string') return __ADF_VERSION__
  return process.env.npm_package_version ?? 'dev'
}

const DAEMON_HELP = `Usage: adf daemon [--port <n>] [--host <h>] [--settings <file>]
       adf daemon start [--port <n>] [--force]
       adf daemon status | stop | restart [--port <n>]
       adf daemon logs [-f] [-n <lines>] [--port <n>]

Without a subcommand the daemon runs in the foreground (Ctrl+C stops it).
start runs it in the background, like adf does on its own when it needs one;
the log goes to <data dir>/logs/adf-daemon.log. stop is graceful: agents are
unloaded and compute containers stopped.

Environment: ADF_DAEMON_PORT, ADF_DAEMON_HOST, ADF_DAEMON_SETTINGS,
ADF_USER_DATA_DIR, ADF_DAEMON_PIDFILE`

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

const DAEMON_SUBCOMMANDS = new Set(['start', 'status', 'stop', 'restart', 'logs'])

async function daemonSubcommand(sub: string, args: string[]): Promise<number> {
  const control = await import('./daemon-control')
  const out = (text: string) => { process.stdout.write(text) }
  const { url, rest } = control.daemonUrlFrom(args)
  const target = control.daemonTarget(url)
  const force = rest.includes('--force')
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
  const major = Number(process.versions.node.split('.')[0])
  if (major < MIN_NODE_MAJOR) {
    process.stderr.write(`adf needs Node.js ${MIN_NODE_MAJOR} or newer (this is ${process.version}).\n`)
    return 1
  }
  // --no-daemon: never start a daemon on our own (also ADF_NO_AUTOSTART=1).
  const noDaemon = argv.includes('--no-daemon')
  if (noDaemon) argv = argv.filter(a => a !== '--no-daemon')
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
