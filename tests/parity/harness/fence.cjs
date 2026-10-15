'use strict'
/**
 * Parity-harness fence: refuses process spawns of podman/wsl and network
 * connections outside the run's own loopback ports, and records every refusal.
 *
 * Why: a graceful Studio or daemon shutdown reaches PodmanService.stopAll,
 * which stops EVERY running adf-* container on the machine (incident
 * 2026-10-14); and the owner's real daemon listens on 7385.
 *
 * It patches the built-in module objects (child_process, net, tls, http,
 * https, worker_threads), net.Socket.prototype.connect and the dgram socket
 * prototype, then calls module.syncBuiltinESMExports(), so ESM named
 * imports, createRequire users and libraries such as cross-spawn (the MCP
 * SDK's StdioClientTransport) all see the fenced functions.
 * globalThis.fetch is wrapped as well.
 *
 * Propagation: every worker_threads Worker gets `--require <this file>` in
 * its execArgv, and the harness puts `--require "<this file>"` in
 * NODE_OPTIONS for the run, so Node and Electron-as-Node children and
 * grandchildren install the fence too (it installs itself when
 * PARITY_FENCE_LOG is set). A spawn with its own `env` object gets the
 * fence variables added to it (withFenceEnv), so a child spawned with a
 * clean env is fenced as well.
 *
 * Two ways to use it:
 * - In process: `require('./fence.cjs').install({ logFile, ports })`, then
 *   `uninstall()`. The parity harness does this for every run.
 * - In a child process: `electron.exe -r <abs path>/fence.cjs …` with
 *   PARITY_FENCE_LOG=<root>/violations.log and PARITY_FENCE_PORTS=1234,5678.
 *   It installs itself on load when PARITY_FENCE_LOG is set.
 *
 * Every refusal is appended to the log file as one JSON line and thrown at
 * the caller. The harness fails a run whose log is not empty.
 */

const childProcess = require('node:child_process')
const net = require('node:net')
const tls = require('node:tls')
const http = require('node:http')
const https = require('node:https')
const dgram = require('node:dgram')
const workerThreads = require('node:worker_threads')
const fs = require('node:fs')
const { promisify } = require('node:util')
const { syncBuiltinESMExports } = require('node:module')

/** Always refused, whatever the allow list says: the owner's real daemon. */
const FORBIDDEN_PORTS = new Set([7385])
const FORBIDDEN_BINARY = /^(podman|wsl)(\.exe|\.cmd|\.bat)?$/i
// 127.0.0.2: the remote-mode OAuth relay listens there, as on another computer's loopback (W4-B).
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '127.0.0.2', '::1', '[::1]', 'localhost'])

let state = null

function record(kind, detail) {
  const entry = { kind, detail, pid: process.pid }
  if (state) {
    state.violations.push(entry)
    try { fs.appendFileSync(state.logFile, JSON.stringify(entry) + '\n') } catch { /* log dir gone */ }
  }
  const err = new Error(`parity fence: refused ${kind}: ${detail}`)
  err.code = 'PARITY_FENCE'
  return err
}

// --- spawn ----------------------------------------------------------------

/** Every word of every string, split as a shell would roughly split it. */
function words(value) {
  if (typeof value !== 'string') return []
  return value.split(/[\s;&|()<>`"'=,]+/).filter(Boolean)
}

function forbiddenWord(strings) {
  for (const s of strings) {
    for (const w of words(s)) {
      const base = w.split(/[\\/]/).pop() || ''
      if (FORBIDDEN_BINARY.test(base)) return w
    }
  }
  return null
}

/** All strings a spawn call hands to the OS: file, argv, shell line, and argv0. */
function spawnStrings(name, args) {
  const out = []
  const [first, second, third] = args
  out.push(first)
  if (Array.isArray(second)) out.push(...second)
  const options = Array.isArray(second) ? third : second
  if (options && typeof options === 'object') {
    if (typeof options.shell === 'string') out.push(options.shell)
    if (typeof options.argv0 === 'string') out.push(options.argv0)
  }
  return out
}

const SPAWNERS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']

/** `--require "<this file>"`, forward slashes: NODE_OPTIONS unescapes backslashes inside quotes. */
const REQUIRE_SELF = `--require "${__filename.split('\\').join('/')}"`

/**
 * A spawn that passes its own `env` object would drop the run's
 * NODE_OPTIONS and PARITY_FENCE_* (a "clean env" child, e.g. an MCP server
 * whose env is built from scratch), and run unfenced. Put them back into
 * every explicit env, so Node and Electron-as-Node children load the fence
 * whatever env their parent built.
 */
function withFenceEnv(args) {
  if (!state) return args
  const out = [...args]
  // A child under Node's permission model (the code sandbox host,
  // runtime/sandbox-host.ts) may read only what it allows: the fence it is
  // given through NODE_OPTIONS is added to its read allowlist, or it could
  // not load the fence and would exit at once.
  if (Array.isArray(out[1]) && out[1].includes('--permission')) {
    out[1] = ['--permission', `--allow-fs-read=${__filename}`, ...out[1].filter((a) => a !== '--permission')]
  }
  for (let i = 1; i < out.length; i++) {
    const a = out[i]
    if (!a || typeof a !== 'object' || Array.isArray(a)) continue
    if (!a.env || typeof a.env !== 'object') return args
    const nodeOptions = typeof a.env.NODE_OPTIONS === 'string' ? a.env.NODE_OPTIONS : ''
    out[i] = {
      ...a,
      env: {
        ...a.env,
        PARITY_FENCE_LOG: state.logFile,
        PARITY_FENCE_ROOT: state.root ?? '',
        PARITY_FENCE_PORTS: [...state.ports].join(','),
        NODE_OPTIONS: nodeOptions.includes(REQUIRE_SELF) ? nodeOptions : [nodeOptions, REQUIRE_SELF].filter(Boolean).join(' '),
      },
    }
    return out
  }
  return args
}

function fencedSpawner(name, original) {
  const check = (args) => {
    const hit = forbiddenWord(spawnStrings(name, args).filter((s) => typeof s === 'string'))
    if (hit) throw record('spawn', `${name}: ${spawnStrings(name, args).filter((s) => typeof s === 'string').join(' ')}`)
  }
  const fenced = function (...args) {
    check(args)
    return original.apply(this, withFenceEnv(args))
  }
  // exec/execFile resolve `{ stdout, stderr }` under promisify only through this symbol.
  const custom = original[promisify.custom]
  if (typeof custom === 'function') {
    fenced[promisify.custom] = function (...args) {
      try { check(args) } catch (err) { return Promise.reject(err) }
      return custom.apply(this, withFenceEnv(args))
    }
  }
  return fenced
}

// --- network --------------------------------------------------------------

function allowed(host, port) {
  const p = Number(port)
  if (FORBIDDEN_PORTS.has(p)) return false
  const h = host === undefined || host === null || host === '' ? 'localhost' : String(host).toLowerCase()
  return LOOPBACK_HOSTS.has(h) && state.ports.has(p)
}

/**
 * Windows named pipes live outside the file system, so "inside the run root"
 * cannot apply to them. A runtime host's lease endpoint
 * (a named pipe adf-runtime-<id>, agent-lease.ts) is allowed when a record
 * in the run's own lease registry (`<root>/leases/{hosts,clients}`) names it:
 * those are this run's processes. Any other pipe, the owner's Studio
 * included, stays refused.
 */
function runLeaseEndpoint(p) {
  if (!state.root || !/^\\\\[.?]\\pipe\\adf-runtime-[0-9a-f]{16}$/i.test(p)) return false
  for (const sub of ['hosts', 'clients']) {
    const dir = require('node:path').join(state.root, 'leases', sub)
    let names = []
    try { names = fs.readdirSync(dir) } catch { continue }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      try {
        const record = JSON.parse(fs.readFileSync(require('node:path').join(dir, name), 'utf-8'))
        if (record && record.endpoint === p) return true
      } catch { /* being written */ }
    }
  }
  return false
}

function checkTarget(kind, host, port, path) {
  if (path !== undefined && path !== null) {
    // Named pipes / unix sockets: only inside the run root (or this run's lease endpoints).
    const p = String(path)
    if (state.root && p.startsWith(state.root)) return
    if (runLeaseEndpoint(p)) return
    throw record(kind, `pipe ${p}`)
  }
  if (!allowed(host, port)) throw record(kind, `${host ?? 'localhost'}:${port}`)
}

/** net.connect(options | port[, host] | path) */
function netTarget(args) {
  const [a, b] = args
  if (a && typeof a === 'object') return { host: a.host, port: a.port, path: a.path }
  if (typeof a === 'string' && !/^\d+$/.test(a)) return { path: a }
  return { host: typeof b === 'string' ? b : undefined, port: a }
}

/** http.request(url | options[, options]) */
function httpTarget(args, defaultPort) {
  let [a, b] = args
  let url = null
  if (typeof a === 'string') url = new URL(a)
  else if (a instanceof URL) url = a
  if (url) {
    const opts = b && typeof b === 'object' && typeof b !== 'function' ? b : {}
    return {
      host: opts.hostname ?? opts.host ?? url.hostname,
      port: opts.port ?? (url.port || defaultPort),
      path: opts.socketPath,
    }
  }
  const o = a || {}
  return { host: o.hostname ?? (o.host ? String(o.host).replace(/:\d+$/, '') : undefined), port: o.port ?? defaultPort, path: o.socketPath }
}

/** dgram send(msg[, offset, length], port[, address][, cb]); a connected socket passes no port. */
function dgramTarget(args) {
  if (typeof args[1] === 'number' && typeof args[2] === 'number' && typeof args[3] === 'number') return { port: args[3], host: args[4] }
  if (typeof args[1] === 'number') return { port: args[1], host: typeof args[2] === 'string' ? args[2] : undefined }
  return null
}

/** `targetOf` returning null = nothing to check (e.g. a send on a connected UDP socket). */
function fencedConnect(kind, original, targetOf) {
  return function (...args) {
    const t = targetOf(args)
    if (t) checkTarget(kind, t.host, t.port, t.path)
    return original.apply(this, args)
  }
}

function fencedWorkerClass(Original) {
  const self = __filename
  return class FencedWorker extends Original {
    constructor(file, options = {}) {
      const execArgv = [...(options.execArgv ?? process.execArgv), '--require', self]
      // A worker with its own env object would not see the fence settings.
      const env = options.env && typeof options.env === 'object'
        ? { ...options.env, PARITY_FENCE_LOG: state.logFile, PARITY_FENCE_ROOT: state.root ?? '', PARITY_FENCE_PORTS: [...state.ports].join(',') }
        : options.env
      super(file, { ...options, execArgv, ...(env !== undefined ? { env } : {}) })
    }
  }
}

// --- install --------------------------------------------------------------

function install(options) {
  if (state) uninstall()
  const saved = []
  const patch = (obj, key, value) => {
    saved.push([obj, key, obj[key]])
    obj[key] = value
  }
  state = {
    logFile: options.logFile,
    root: options.root,
    ports: new Set((options.ports || []).map(Number)),
    violations: [],
    saved,
  }
  for (const name of SPAWNERS) {
    if (typeof childProcess[name] === 'function') patch(childProcess, name, fencedSpawner(name, childProcess[name]))
  }
  // Socket.prototype.connect covers `new net.Socket().connect()` and every
  // path that builds its own socket (http Agent, tls). Internal callers pass
  // the normalized [options, cb] array.
  patch(net.Socket.prototype, 'connect', fencedConnect('net', net.Socket.prototype.connect, (args) =>
    netTarget(Array.isArray(args[0]) ? args[0] : args)))
  patch(net, 'connect', fencedConnect('net', net.connect, netTarget))
  patch(net, 'createConnection', fencedConnect('net', net.createConnection, netTarget))
  // A server this process listens on is one of its own ports: connecting to
  // it stays in the process (the daemon delivering a relayed OAuth callback
  // to its own loopback callback server, W4-B). Loopback rules still apply.
  const originalListen = net.Server.prototype.listen
  patch(net.Server.prototype, 'listen', function (...args) {
    this.once('listening', () => {
      const address = this.address()
      if (state && address && typeof address === 'object') state.ports.add(Number(address.port))
    })
    return originalListen.apply(this, args)
  })
  // UDP: only to the run's loopback ports; no multicast (mDNS) at all.
  const udp = dgram.Socket.prototype
  patch(udp, 'send', fencedConnect('dgram', udp.send, (args) => dgramTarget(args)))
  patch(udp, 'connect', fencedConnect('dgram', udp.connect, (args) => ({ port: args[0], host: typeof args[1] === 'string' ? args[1] : undefined })))
  patch(udp, 'addMembership', function (group) { throw record('dgram', `multicast ${group}`) })
  // Workers have their own copies of the built-ins: each loads this fence first.
  patch(workerThreads, 'Worker', fencedWorkerClass(workerThreads.Worker))
  patch(tls, 'connect', fencedConnect('tls', tls.connect, netTarget))
  for (const [mod, port] of [[http, 80], [https, 443]]) {
    patch(mod, 'request', fencedConnect('http', mod.request, (args) => httpTarget(args, port)))
    patch(mod, 'get', fencedConnect('http', mod.get, (args) => httpTarget(args, port)))
  }
  if (typeof globalThis.fetch === 'function') {
    const originalFetch = globalThis.fetch
    patch(globalThis, 'fetch', function (input, init) {
      try {
        const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url)
        checkTarget('fetch', url.hostname, url.port || (url.protocol === 'https:' ? 443 : 80))
      } catch (err) {
        return Promise.reject(err)
      }
      return originalFetch.call(this, input, init)
    })
  }
  syncBuiltinESMExports()
  return api
}

function uninstall() {
  if (!state) return
  for (const [obj, key, value] of state.saved.reverse()) obj[key] = value
  syncBuiltinESMExports()
  state = null
}

function allowPort(port) {
  if (state) state.ports.add(Number(port))
}

function violations() {
  return state ? state.violations.slice() : []
}

const api = { install, uninstall, allowPort, violations, FORBIDDEN_PORTS }
module.exports = api

/**
 * Child processes only (the harness process has its own tripwire, env.ts):
 * refuse and record any load of the OS keychain addon. A fenced daemon reads
 * the test keychain file (ADF_TEST_KEYCHAIN_FILE) and must never fall
 * through to the real keychain.
 */
function installKeyringTripwire() {
  const Module = require('node:module')
  const original = Module._load
  Module._load = function fencedLoad(request, ...rest) {
    if (request === '@napi-rs/keyring' || String(request).startsWith('@napi-rs/keyring-')) {
      throw record('keychain', `load of ${request}`)
    }
    return original.call(this, request, ...rest)
  }
}

if (process.env.PARITY_FENCE_LOG) {
  install({
    logFile: process.env.PARITY_FENCE_LOG,
    root: process.env.PARITY_FENCE_ROOT,
    ports: (process.env.PARITY_FENCE_PORTS || '').split(',').filter(Boolean),
  })
  installKeyringTripwire()
}
