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
 *   `uninstall()`. The parity harness does this for every run. Writes are
 *   allowed inside `writeRoots` (default: `root`), which children inherit,
 *   and `ownWriteRoots`, which they do not.
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
const fsPromises = require('node:fs/promises')
const path = require('node:path')
const { tmpdir } = require('node:os')
const { fileURLToPath } = require('node:url')
const Module = require('node:module')
const rawFs = { ...fs }
const ISOLATED_DIRECTORY_PARENT = tmpdir()
const { promisify } = require('node:util')
const { syncBuiltinESMExports } = require('node:module')

/** Always refused, whatever the allow list says: the owner's real daemon. */
const FORBIDDEN_PORTS = new Set([7385])
const FORBIDDEN_BINARY = /^(podman|wsl)(\.exe|\.cmd|\.bat)?$/i
// 127.0.0.2 (::1 on macOS): the remote-mode OAuth relay listens there, as on another computer's loopback (W4-B, harness/relay-host.ts).
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '127.0.0.2', '::1', '[::1]', 'localhost'])

let state = null

function record(kind, detail) {
  const entry = { kind, detail, pid: process.pid }
  if (state) {
    state.violations.push(entry)
    let descriptor
    try {
      descriptor = rawFs.openSync(state.logFile, 'a', 0o600)
      rawFs.writeSync(descriptor, JSON.stringify(entry) + '\n')
    } catch {
      state.loggingFailed = true
      // A caught refusal cannot erase its audit trail by breaking the logger.
      // Children also exit nonzero if their log could not reach the parent.
      process.exitCode = 1
    } finally {
      if (descriptor !== undefined) try { rawFs.closeSync(descriptor) } catch { /* already closed */ }
    }
  }
  const err = new Error(`parity fence: refused ${kind}: ${detail}`)
  err.code = 'PARITY_FENCE'
  return err
}

// --- filesystem -----------------------------------------------------------

function canonical(input) {
  if (input instanceof URL) input = fileURLToPath(input)
  if (Buffer.isBuffer(input)) input = input.toString()
  const absolute = path.resolve(String(input))
  try { return rawFs.realpathSync.native(absolute) } catch {
    const parent = path.dirname(absolute)
    return parent === absolute ? absolute : path.join(canonical(parent), path.basename(absolute))
  }
}

function inside(root, target) {
  const rel = path.relative(root, target)
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`))
}

function checkWrite(operation, target) {
  if (!state) return
  if (target && typeof target === 'object' && typeof target.fd === 'number') target = target.fd
  if (typeof target === 'number') {
    if (target === 1 || target === 2) return // process output, never an inherited file handle
    const known = state.fds.get(target)
    if (!known) throw record('filesystem', `${operation}: untracked fd ${target}`)
    return checkWrite(operation, known)
  }
  const resolved = canonical(target)
  const audit = canonical(state.logFile)
  const removesAuditParent = /^(rm|rmdir|rename|chmod|chown)(Sync)?$/.test(operation) && inside(resolved, audit)
  if (resolved === audit || removesAuditParent) throw record('filesystem', `${operation}: fence audit log is read-only`)
  if (![...state.writeRoots, ...state.ownWriteRoots].some(root => inside(root, resolved))) throw record('filesystem', `${operation}: ${resolved}`)
  try {
    const entry = rawFs.statSync(resolved)
    if (entry.isFile() && entry.nlink > 1) throw record('filesystem', `${operation}: multiply linked file ${resolved}`)
  } catch (err) { if (err.code === 'PARITY_FENCE') throw err }
}

function writable(flags) {
  return typeof flags === 'number'
    ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) !== 0
    : /[wa+]/.test(flags === undefined ? 'r' : String(flags))
}

function installFilesystem(patch) {
  const single = ['appendFile', 'writeFile', 'truncate', 'unlink', 'rm', 'rmdir', 'mkdir', 'mkdtemp', 'chmod', 'chown', 'lchmod', 'lchown', 'utimes', 'lutimes']
  const fd = ['write', 'writev', 'ftruncate', 'fchmod', 'fchown', 'futimes', 'fsync', 'fdatasync']
  for (const name of [...single, ...fd]) {
    for (const suffix of ['', 'Sync']) {
      const method = name + suffix
      if (typeof fs[method] !== 'function') continue
      const original = fs[method]
      patch(fs, method, function (...args) { checkWrite(method, args[0]); return original.apply(this, args) })
    }
    if (typeof fsPromises[name] === 'function') {
      const original = fsPromises[name]
      patch(fsPromises, name, async function (...args) { checkWrite(name, args[0]); return original.apply(this, args) })
    }
  }
  // A rename changes both paths; a link must not become a writable alias.
  // copyFile reads its source and mutates only the checked destination.
  for (const name of ['rename', 'copyFile', 'cp', 'link', 'symlink']) {
    const check = args => {
      if (name === 'cp') throw record('filesystem', 'cp: recursive copies require individually guarded copyFile operations')
      const source = name === 'symlink' && !path.isAbsolute(String(args[0])) ? path.resolve(path.dirname(String(args[1])), String(args[0])) : args[0]
      if (name !== 'copyFile') checkWrite(name, source)
      checkWrite(name, args[1])
    }
    for (const suffix of ['', 'Sync']) {
      const method = name + suffix
      if (typeof fs[method] !== 'function') continue
      const original = fs[method]
      patch(fs, method, function (...args) { check(args); return original.apply(this, args) })
    }
    if (typeof fsPromises[name] === 'function') {
      const original = fsPromises[name]
      patch(fsPromises, name, async function (...args) { check(args); return original.apply(this, args) })
    }
  }
  const originalOpen = fs.open
  patch(fs, 'open', function (...args) {
    const target = canonical(args[0])
    if (writable(args[1])) checkWrite('open', target)
    const callback = args.pop()
    args.push(function (err, descriptor) {
      if (!err && state) state.fds.set(descriptor, target)
      callback(err, descriptor)
    })
    return originalOpen.apply(this, args)
  })
  const originalOpenSync = fs.openSync
  patch(fs, 'openSync', function (target, flags, ...args) {
    const resolved = canonical(target)
    if (writable(flags)) checkWrite('openSync', resolved)
    const descriptor = originalOpenSync.call(this, target, flags, ...args)
    if (state) state.fds.set(descriptor, resolved)
    return descriptor
  })
  const originalCloseSync = fs.closeSync
  patch(fs, 'closeSync', function (fd) {
    const result = originalCloseSync.call(this, fd)
    if (state) state.fds.delete(fd)
    return result
  })
  const originalClose = fs.close
  patch(fs, 'close', function (fd, callback) {
    return originalClose.call(this, fd, err => { if (!err && state) state.fds.delete(fd); callback(err) })
  })
  const originalPromiseOpen = fsPromises.open
  patch(fsPromises, 'open', async function (target, flags, ...args) {
    const resolved = canonical(target)
    if (writable(flags)) checkWrite('open', resolved)
    const handle = await originalPromiseOpen.call(this, target, flags, ...args)
    if (state) state.fds.set(handle.fd, resolved)
    for (const name of ['appendFile', 'writeFile', 'write', 'writev', 'truncate', 'chmod', 'chown', 'utimes', 'sync', 'datasync', 'createWriteStream']) {
      if (typeof handle[name] !== 'function') continue
      const original = handle[name]
      handle[name] = function (...values) { checkWrite(`FileHandle.${name}`, resolved); return original.apply(this, values) }
    }
    const close = handle.close
    handle.close = async function () {
      const descriptor = handle.fd
      const result = await close.call(this)
      if (state) state.fds.delete(descriptor)
      return result
    }
    return handle
  })
  const originalStream = fs.createWriteStream
  patch(fs, 'createWriteStream', function (target, options) {
    checkWrite('createWriteStream', options && options.fd !== undefined ? options.fd : target)
    return originalStream.apply(this, arguments)
  })
}

// The native addon's constructor is checked as well as the JS wrapper.
// Cached/imported-before-fence better-sqlite3 constructors retain this same
// addon object, so they cannot bypass the guard with a saved JS reference.
function installSqliteGuard(patch) {
  let trustedVec
  const patched = new WeakSet()
  const guardAddon = addon => {
    if (!addon || typeof addon.Database !== 'function' || patched.has(addon)) return
    patched.add(addon)
    const Original = addon.Database
    patch(addon, 'Database', new Proxy(Original, { construct(target, args, newTarget) {
      if (!args[2]) checkWrite('sqlite open', args[0]) // anonymous in-memory DBs write no file
      return Reflect.construct(target, args, newTarget)
    } }))
    for (const name of ['prepare', 'exec', 'backup', 'close', 'loadExtension']) {
      const original = Original.prototype[name]
      if (typeof original !== 'function') continue
      patch(Original.prototype, name, function (...args) {
        if (!this.memory) checkWrite(`sqlite ${name}`, this.name)
        if (name === 'backup') checkWrite('sqlite backup', args[2])
        if (name === 'loadExtension') {
          trustedVec ??= canonical(require('sqlite-vec').getLoadablePath())
          if (canonical(args[0]) !== trustedVec) throw record('filesystem', 'sqlite loadExtension is forbidden except the bundled sqlite-vec')
        }
        if ((name === 'prepare' || name === 'exec') && /\bATTACH\b|\bVACUUM\b[\s\S]*?\bINTO\b|\bload_extension\s*\(/i.test(String(args[0]))) {
          throw record('filesystem', 'sqlite SQL file access (ATTACH, VACUUM INTO or load_extension) is forbidden')
        }
        return original.apply(this, args)
      })
    }
    // Statements can outlive a run boundary too. Patch the shared native
    // statement prototype, so a prepared-before-fence write stays guarded.
    const Database = require('better-sqlite3')
    const memory = new Database(':memory:')
    try {
      const prototype = Object.getPrototypeOf(memory.prepare('SELECT 1'))
      if (!patched.has(prototype)) {
        patched.add(prototype)
        for (const name of ['run', 'get', 'all', 'iterate']) {
          const original = prototype[name]
          patch(prototype, name, function (...args) {
            if (!this.database.memory) checkWrite(`sqlite statement ${name}`, this.database.name)
            if (/\bATTACH\b|\bVACUUM\b[\s\S]*?\bINTO\b|\bload_extension\s*\(/i.test(this.source)) {
              throw record('filesystem', 'sqlite SQL file access (ATTACH, VACUUM INTO or load_extension) is forbidden')
            }
            return original.apply(this, args)
          })
        }
      }
    } finally { memory.close() }

  }
  for (const [filename, cached] of Object.entries(require.cache)) if (/better_sqlite3\.node$/.test(filename)) guardAddon(cached.exports)
  const originalLoad = Module._load
  patch(Module, '_load', function (request, ...rest) {
    const result = originalLoad.call(this, request, ...rest)
    if (/better_sqlite3\.node$/.test(String(request))) guardAddon(result)
    return result
  })
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

/**
 * True when `binary` runs `%SystemRoot%\System32\<name>.exe`: that absolute
 * path, or a bare `name` / `name.exe` that libuv resolves to it. libuv looks
 * in the spawn's cwd first, then each PATH entry, trying `.com` then `.exe`
 * for a name without an extension; the first file found is run. A bare name
 * whose first hit is anywhere else (a planted icacls.exe in the cwd or an
 * earlier PATH entry) is not the system tool.
 */
function systemTool(binary, name, options) {
  const system32 = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', `${name}.exe`).toLowerCase()
  const value = String(binary)
  if (path.win32.isAbsolute(value)) return path.win32.normalize(value).toLowerCase() === system32
  const lower = value.toLowerCase()
  if (lower !== name && lower !== `${name}.exe`) return false
  const env = options.env && typeof options.env === 'object' ? options.env : process.env
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH')
  const dirs = [options.cwd ? String(options.cwd) : process.cwd(), ...String(pathKey ? env[pathKey] : '').split(';').filter(Boolean)]
  const candidates = lower === name ? [`${value}.com`, `${value}.exe`] : [value]
  for (const dir of dirs) {
    for (const candidate of candidates) {
      const full = path.win32.resolve(dir.replace(/^"(.*)"$/, '$1'), candidate)
      let file = false
      try { file = rawFs.statSync(full).isFile() } catch { /* not here */ }
      if (file) return canonical(full).toLowerCase() === canonical(system32).toLowerCase()
    }
  }
  return false
}

/** daemon/file-ops.ts findDocumentsDir: the Documents shell folder. */
const DOCUMENTS_KEY = ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', '/v', 'Personal']

function currentWindowsUser() {
  return process.env.USERDOMAIN && process.env.USERNAME
    ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
    : require('node:os').userInfo().username
}

/**
 * Windows subprocesses of production code the fence lets through, by exact
 * argv shape (win32 only, never through a shell):
 * - icacls restricting a secret file inside a write root to the current
 *   user (utils/secret-file.ts restrictToCurrentUserWindows: the daemon's
 *   local proof, token, encryption key, edit-recovery copies);
 * - reg reading the Documents shell folder (daemon/file-ops.ts
 *   findDocumentsDir), a read of one value of one key.
 */
function allowedWindowsTool(binary, values, options) {
  if (process.platform !== 'win32' || typeof binary !== 'string') return false
  const argv = values.map(String)
  if (systemTool(binary, 'icacls', options)) {
    return argv.length === 4 && argv[1] === '/inheritance:r' && argv[2] === '/grant:r' && argv[3] === `${currentWindowsUser()}:F`
      && path.isAbsolute(argv[0]) && state.writeRoots.some(root => inside(root, canonical(argv[0])))
  }
  if (systemTool(binary, 'reg', options)) return argv.length === DOCUMENTS_KEY.length && argv.every((value, i) => value === DOCUMENTS_KEY[i])
  return false
}

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
    out[1] = ['--permission', `--allow-fs-read=${__filename}`, `--allow-fs-write=${state.logFile}`, ...out[1].filter((a) => a !== '--permission')]
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
        PARITY_FENCE_WRITE_ROOTS: JSON.stringify(state.writeRoots),
        NODE_OPTIONS: [REQUIRE_SELF, nodeOptions.replaceAll(REQUIRE_SELF, '').trim()].filter(Boolean).join(' '),
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
    const options = (Array.isArray(args[1]) ? args[2] : args[1]) || {}
    const binary = name === 'fork' ? options.execPath || process.execPath : args[0]
    const isOwnNode = typeof binary === 'string' && canonical(binary) === canonical(process.execPath)
    const values = Array.isArray(args[1]) ? args[1] : []
    const pidAt = values.findIndex(value => String(value).toUpperCase() === '/PID')
    const ownTaskkill = process.platform === 'win32' && /^taskkill(?:\.exe)?$/i.test(String(binary))
      && values.length === 4 && values.some(value => String(value).toUpperCase() === '/T')
      && values.some(value => String(value).toUpperCase() === '/F') && pidAt >= 0 && state.children.has(Number(values[pidAt + 1]))
    const productionTool = (name === 'execFile' || name === 'execFileSync' || name === 'spawn' || name === 'spawnSync') && allowedWindowsTool(binary, values, options)
    if (name === 'exec' || name === 'execSync' || options.shell || (!isOwnNode && !ownTaskkill && !productionTool)) {
      throw record('spawn', `${name}: unfenced executable ${binary}`)
    }
  }
  const fenced = function (...args) {
    check(args)
    const child = original.apply(this, withFenceEnv(args))
    if (child && child.pid && state) state.children.add(child.pid)
    return child
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
      const execArgv = ['--require', self, ...(options.execArgv ?? process.execArgv)]
      // A worker with its own env object would not see the fence settings.
      const env = options.env && typeof options.env === 'object'
        ? { ...options.env, PARITY_FENCE_LOG: state.logFile, PARITY_FENCE_ROOT: state.root ?? '', PARITY_FENCE_PORTS: [...state.ports].join(','), PARITY_FENCE_WRITE_ROOTS: JSON.stringify(state.writeRoots) }
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
    writeRoots: (options.writeRoots || (options.root ? [options.root] : [])).map(canonical),
    // Writable by this process only: never handed to children or workers
    // (PARITY_FENCE_WRITE_ROOTS carries writeRoots alone).
    ownWriteRoots: (options.ownWriteRoots || []).map(canonical),
    fds: new Map(),
    children: new Set(),
    ports: new Set((options.ports || []).map(Number)),
    violations: [],
    loggingFailed: false,
    saved,
  }
  // The mark the daemon's fenced-only test seams check (src/main/daemon/remote-access/test-probes.ts).
  patch(globalThis, Symbol.for('adf.parity.fence'), true)
  installFilesystem(patch)
  installSqliteGuard(patch)
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

function createIsolatedDirectory(label) {
  if (!state || !/^[a-z0-9-]+$/i.test(label)) throw new Error('parity fence: invalid isolated-directory label')
  const root = canonical(rawFs.mkdtempSync(path.join(ISOLATED_DIRECTORY_PARENT, `adf-parity-${label}-`)))
  state.writeRoots.push(root)
  return root
}

function allowPort(port) {
  if (state) state.ports.add(Number(port))
}

function violations() {
  return state ? [...state.violations, ...(state.loggingFailed ? [{ kind: 'audit', detail: 'fence violation log could not be written', pid: process.pid }] : [])] : []
}

const api = { install, uninstall, allowPort, createIsolatedDirectory, violations, FORBIDDEN_PORTS }
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
    writeRoots: process.env.PARITY_FENCE_WRITE_ROOTS ? JSON.parse(process.env.PARITY_FENCE_WRITE_ROOTS) : undefined,
    ports: (process.env.PARITY_FENCE_PORTS || '').split(',').filter(Boolean),
  })
  installKeyringTripwire()
}
