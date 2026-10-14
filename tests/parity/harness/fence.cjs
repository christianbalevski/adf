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
 * https) and calls module.syncBuiltinESMExports(), so ESM named imports,
 * createRequire users and libraries such as cross-spawn (the MCP SDK's
 * StdioClientTransport) all see the fenced functions. globalThis.fetch is
 * wrapped as well.
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
const fs = require('node:fs')
const { promisify } = require('node:util')
const { syncBuiltinESMExports } = require('node:module')

/** Always refused, whatever the allow list says: the owner's real daemon. */
const FORBIDDEN_PORTS = new Set([7385])
const FORBIDDEN_BINARY = /^(podman|wsl)(\.exe|\.cmd|\.bat)?$/i
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost'])

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

function fencedSpawner(name, original) {
  const check = (args) => {
    const hit = forbiddenWord(spawnStrings(name, args).filter((s) => typeof s === 'string'))
    if (hit) throw record('spawn', `${name}: ${spawnStrings(name, args).filter((s) => typeof s === 'string').join(' ')}`)
  }
  const fenced = function (...args) {
    check(args)
    return original.apply(this, args)
  }
  // exec/execFile resolve `{ stdout, stderr }` under promisify only through this symbol.
  const custom = original[promisify.custom]
  if (typeof custom === 'function') {
    fenced[promisify.custom] = function (...args) {
      try { check(args) } catch (err) { return Promise.reject(err) }
      return custom.apply(this, args)
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

function checkTarget(kind, host, port, path) {
  if (path !== undefined && path !== null) {
    // Named pipes / unix sockets: only inside the run root.
    const p = String(path)
    if (state.root && p.startsWith(state.root)) return
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

function fencedConnect(kind, original, targetOf) {
  return function (...args) {
    const t = targetOf(args)
    checkTarget(kind, t.host, t.port, t.path)
    return original.apply(this, args)
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
  patch(net, 'connect', fencedConnect('net', net.connect, netTarget))
  patch(net, 'createConnection', fencedConnect('net', net.createConnection, netTarget))
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

if (process.env.PARITY_FENCE_LOG) {
  install({
    logFile: process.env.PARITY_FENCE_LOG,
    root: process.env.PARITY_FENCE_ROOT,
    ports: (process.env.PARITY_FENCE_PORTS || '').split(',').filter(Boolean),
  })
}
