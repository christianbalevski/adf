import { Worker } from 'worker_threads'
import { cpus } from 'os'

export interface CodeResult {
  result?: string
  stdout: string
  error?: string
  errorCode?: string
}

export interface AdfCallResult {
  result?: string
  error?: string
  errorCode?: string
  /** When true, the proxy won't auto-parse the result as JSON (e.g. model_invoke returns raw text) */
  raw?: boolean
}

export interface ToolConfig {
  enabledTools: string[]
  hilTools: string[]
  isAuthorized: boolean
}

const DEFAULT_TIMEOUT = 10_000
const MAX_TIMEOUT = 300_000

/**
 * Transform import statements to await __require() calls.
 * Uses await so ESM-only packages (which return a Promise from __require) work
 * transparently. For CJS modules, await on a non-Promise returns the value immediately.
 * Handles: import { X } from 'mod', import X from 'mod', import * as X from 'mod'
 */
function transformImports(code: string): string {
  // import { X, Y } from 'mod'
  code = code.replace(
    /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]\s*;?/g,
    (_, names, mod) => `const {${names}} = await __require('${mod}');`
  )
  // import * as X from 'mod'
  code = code.replace(
    /import\s*\*\s*as\s+(\w+)\s+from\s*['"]([^'"]+)['"]\s*;?/g,
    (_, name, mod) => `const ${name} = await __require('${mod}');`
  )
  // import X from 'mod'
  code = code.replace(
    /import\s+(\w+)\s+from\s*['"]([^'"]+)['"]\s*;?/g,
    (_, name, mod) => `const ${name} = await __require('${mod}');`
  )
  return code
}

/**
 * Strip export keywords so functions/constants become context-accessible.
 */
function transformExports(code: string): string {
  code = code.replace(/export\s+async\s+function\s/g, 'async function ')
  code = code.replace(/export\s+function\s/g, 'function ')
  code = code.replace(/export\s+const\s/g, 'const ')
  code = code.replace(/export\s+let\s/g, 'let ')
  code = code.replace(/export\s+class\s/g, 'class ')
  // export default function → function
  code = code.replace(/export\s+default\s+function\s/g, 'function ')
  code = code.replace(/export\s+default\s+async\s+function\s/g, 'async function ')
  // export default <expr> → just the expression (as a no-op statement)
  code = code.replace(/export\s+default\s+/g, '')
  // export { foo, bar } or export { foo as bar } — remove entire line
  code = code.replace(/^export\s*\{[^}]*\}\s*;?\s*$/gm, '')
  return code
}

export { transformImports, transformExports }

/**
 * Inline worker script that creates a sandboxed vm.Context and executes
 * code sent via postMessage. Supports async execution and RPC bridge
 * for calling tools via the `adf` proxy object.
 */
const WORKER_SCRIPT = `
const { parentPort } = require('worker_threads');
const vm = require('vm');
const { createRequire } = require('module');
const nodePath = require('path');

// Kill native fetch — all network requests must go through adf.sys_fetch()
// Node 18+ exposes globalThis.fetch via undici in worker threads.
// Without this, any stdlib package calling fetch() bypasses sys_fetch and all middleware.
delete globalThis.fetch;
delete globalThis.Request;
delete globalThis.Response;
delete globalThis.Headers;

// Allowlisted Node.js built-in modules
const ALLOWED_MODULES = new Set([
  'crypto', 'buffer', 'url', 'querystring', 'path', 'util',
  'string_decoder', 'punycode', 'assert', 'events', 'stream', 'zlib'
]);

// Standard library state (set via 'setup' message)
let stdlibBasePath = null;
let stdlibModuleSet = new Set();

// User-installed packages state (set via 'setup' message)
let userPkgBasePath = null;
let userPkgModuleSet = new Set();

// Pending RPC calls. Each entry records the execution that issued the call so
// one execution's drain never waits on another's in-flight work.
const pendingCalls = new Map();
let callIdCounter = 0;

// Unique per worker. RPC ids are '<token>:<owner>:<n>' so two workers serving
// the same agent (sys_code, lambdas, middleware) can never mint the same id —
// colliding ids used to make the main thread drop one call, hanging its await.
const workerToken = require('crypto').randomUUID();

function countPendingFor(owner) {
  let n = 0;
  for (const call of pendingCalls.values()) {
    if (call.owner === owner) n++;
  }
  return n;
}

// Drain pending async work after user code settles so output produced by
// promise .then/.catch chains, short timers, and in-flight adf.* calls is
// captured before the stdout buffer is snapshotted. Without this, anything
// logged after the wrapper IIFE resolves is silently lost.
//
// The loop stops as soon as the execution is idle: QUIET_MS with no new output
// AND no adf calls of its OWN still in flight. A call that is still in flight
// keeps the drain alive — model_invoke / sys_fetch / compute_exec routinely
// answer several seconds out, and a flat 2s wall dropped everything their
// .then() chains logged, silently, while still reporting success.
//
// The only absolute bound is the execution's own budget: half the timeout,
// never below DRAIN_FLOOR_MS, and never past the deadline. Reaching that
// ceiling with calls still outstanding writes a truncation marker into stdout
// instead of dropping the tail silently — the exact failure mode this drain
// exists to prevent.
const DRAIN_QUIET_MS = 80;
const DRAIN_TICK_MS = 5;
const DRAIN_FLOOR_MS = 2000;
const DRAIN_BUDGET_FRACTION = 0.5;
async function drainPendingWork(getOutputSize, appendOutput, deadline, owner, timeoutMs) {
  const budget = Math.max(DRAIN_FLOOR_MS, Math.floor((timeoutMs || 0) * DRAIN_BUDGET_FRACTION));
  const stop = Math.min(deadline, Date.now() + budget);
  let lastSize = getOutputSize();
  let quietSince = Date.now();
  while (Date.now() < stop) {
    // One macrotask round: setImmediate flushes I/O callbacks (adf_result
    // messages), the short timeout lets queued timers fire.
    await new Promise(function(r) { setImmediate(r); });
    await new Promise(function(r) { setTimeout(r, DRAIN_TICK_MS); });
    const size = getOutputSize();
    if (size !== lastSize || countPendingFor(owner) > 0) {
      lastSize = size;
      quietSince = Date.now();
      continue;
    }
    if (Date.now() - quietSince >= DRAIN_QUIET_MS) return;
  }
  const stuck = countPendingFor(owner);
  if (stuck > 0) {
    appendOutput(
      '[adf] output truncated: ' + stuck + ' unawaited adf call(s) had not answered after ' +
      budget + 'ms of draining — anything they log after this point is lost'
    );
  }
}

// Actionable stub — a bare ReferenceError confuses agents. __require is async,
// so aliasing require to it would silently break sync require semantics.
function requireStub() {
  throw new ReferenceError(
    'require is not available in the sandbox — use import (top-level) instead, ' +
    'e.g. import { createHash } from "crypto"'
  );
}

// Tool availability config. Each execution carries its own, keyed by the id its
// adf proxy was minted with: two executions sharing a worker can hold different
// authorizations, and a single worker-global config meant the last 'setup' to
// land won for both — an authorized execution was refused REQUIRES_AUTHORIZED_CODE
// because an unauthorized one started after it. The 'setup' value stays as the
// fallback for proxies with no execution of their own (the context-global one).
let defaultToolConfig = { enabledTools: [], hilTools: [], isAuthorized: false };
const execToolConfigs = new Map();
// Stored closures keep calling with their owner's id long after it finished, so
// entries outlive the execution — bounded like the main thread's retired handlers.
const EXEC_CONFIG_RETENTION = 32;

function toolConfigFor(ownerId) {
  return execToolConfigs.get(ownerId) || defaultToolConfig;
}

function setExecToolConfig(ownerId, cfg) {
  if (!cfg) return;
  execToolConfigs.set(ownerId, cfg);
  while (execToolConfigs.size > EXEC_CONFIG_RETENTION) {
    const oldest = execToolConfigs.keys().next().value;
    if (oldest === undefined) break;
    execToolConfigs.delete(oldest);
  }
}

// ---- Cross-realm bridge for stdlib packages ----
// vm.createContext gives the sandbox its own Array, Object, etc. Stdlib packages loaded
// in worker scope use the worker's constructors, so instanceof checks fail on values
// created in the vm context (e.g. [300, 200] instanceof Array === false in worker scope).
// These helpers clone cross-realm values into the worker realm and wrap stdlib exports
// so method calls transparently bridge the gap via structuredClone at the boundary.

function deepCloneToWorkerRealm(val) {
  if (val == null) return val;
  if (typeof val === 'function') return val;
  if (typeof val !== 'object') return val;
  if (val instanceof Object) return val; // already in worker realm (includes our Proxies)
  if (Array.isArray(val)) {
    var arr = new Array(val.length);
    for (var i = 0; i < val.length; i++) arr[i] = deepCloneToWorkerRealm(val[i]);
    return arr;
  }
  var cname = val.constructor && val.constructor.name;
  if (cname === 'Uint8Array') return new Uint8Array(val);
  if (cname === 'ArrayBuffer') {
    var buf = new ArrayBuffer(val.byteLength);
    new Uint8Array(buf).set(new Uint8Array(val));
    return buf;
  }
  if (cname === 'Object' || !cname) {
    var obj = {};
    var keys = Object.keys(val);
    for (var i = 0; i < keys.length; i++) {
      obj[keys[i]] = deepCloneToWorkerRealm(val[keys[i]]);
    }
    return obj;
  }
  try { return structuredClone(val); } catch { return val; }
}

var _stdlibProxyCache = new WeakMap();
var _stdlibReverseCache = new WeakMap();
function wrapStdlibExport(val) {
  if (val == null) return val;
  var t = typeof val;
  if (t !== 'object' && t !== 'function') return val;
  if (_stdlibProxyCache.has(val)) return _stdlibProxyCache.get(val);
  if (_stdlibReverseCache.has(val)) return val; // already a proxy we created

  var proxy = new Proxy(val, {
    get: function(target, prop) {
      var v = Reflect.get(target, prop, target);
      if (typeof v === 'function') return wrapStdlibExport(v);
      if (v != null && typeof v === 'object') return wrapStdlibExport(v);
      return v;
    },
    apply: function(target, thisArg, args) {
      var a = args.map(deepCloneToWorkerRealm);
      // Unwrap proxy this-binding so the real object receives the call
      var realThis = _stdlibReverseCache.get(thisArg) || thisArg;
      var r = target.apply(realThis, a);
      if (r instanceof Promise) return r.then(wrapStdlibExport);
      if (r != null && typeof r === 'object') return wrapStdlibExport(r);
      return r;
    },
    construct: function(target, args) {
      var a = args.map(deepCloneToWorkerRealm);
      var r = Reflect.construct(target, a);
      return wrapStdlibExport(r);
    }
  });

  _stdlibProxyCache.set(val, proxy);
  _stdlibReverseCache.set(proxy, val);
  return proxy;
}

// Auto-initialize WASM packages that export an initWasm() function.
// Finds *.wasm files in the package directory and calls initWasm(buffer).
// Runs in worker scope so fs.readFileSync is available.
// Returns the wrapped module, or a Promise that resolves to the wrapped module.
var _wasmInitialized = new Set();
function autoInitWasm(mod, localRequire, modName) {
  if (!mod || typeof mod.initWasm !== 'function') {
    return wrapStdlibExport(mod);
  }
  // Skip if already initialized (e.g. second import of same package)
  if (_wasmInitialized.has(modName)) {
    return wrapStdlibExport(mod);
  }
  // Find the package directory by resolving the entry point and walking up
  // to find package.json. This avoids ERR_PACKAGE_PATH_NOT_EXPORTED from
  // packages that restrict subpath access via the "exports" field.
  var fs = require('fs');
  var pkgDir = null;
  try {
    var entryPath = localRequire.resolve(modName);
    var dir = nodePath.dirname(entryPath);
    for (var depth = 0; depth < 5; depth++) {
      if (fs.existsSync(nodePath.join(dir, 'package.json'))) {
        try {
          var pj = JSON.parse(fs.readFileSync(nodePath.join(dir, 'package.json'), 'utf-8'));
          if (pj.name === modName) { pkgDir = dir; break; }
        } catch (e) { /* ignore parse errors */ }
      }
      var parent = nodePath.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch (e) {
    return wrapStdlibExport(mod);
  }
  if (!pkgDir) return wrapStdlibExport(mod);
  // Scan package directory for .wasm files
  var wasmFiles = [];
  try {
    wasmFiles = fs.readdirSync(pkgDir).filter(function(f) { return f.endsWith('.wasm'); });
  } catch (e) { /* ignore */ }
  if (wasmFiles.length === 0) return wrapStdlibExport(mod);
  // Use the first .wasm file found (convention: index_bg.wasm for wasm-bindgen)
  var wasmPath = nodePath.join(pkgDir, wasmFiles[0]);
  var wasmBuf = fs.readFileSync(wasmPath);
  _wasmInitialized.add(modName);
  var result = mod.initWasm(wasmBuf);
  // initWasm may return a Promise (async init) or void (sync init)
  if (result && typeof result.then === 'function') {
    return result.then(function() { return wrapStdlibExport(mod); });
  }
  return wrapStdlibExport(mod);
}

// Build the __require function for allowlisted Node builtins + stdlib packages.
// Returns the module directly for CJS, or a Promise for ESM-only packages.
// Callers use await (the import transform adds await), so both cases work.
function __require(mod) {
  // 1. Node built-in allowlist
  if (ALLOWED_MODULES.has(mod)) {
    return require(mod);
  }
  // 2. Standard library packages (trusted, run in worker scope)
  if (stdlibBasePath && stdlibModuleSet.has(mod)) {
    const safeName = mod.replace(/[/@]/g, '_');
    const pkgDir = nodePath.join(stdlibBasePath, safeName);
    const localRequire = createRequire(nodePath.join(pkgDir, 'package.json'));
    try {
      return wrapStdlibExport(localRequire(mod));
    } catch (err) {
      // ESM-only package or ESM with top-level await — fall back to dynamic import
      if (err && (err.code === 'ERR_REQUIRE_ESM' || err.code === 'ERR_REQUIRE_ASYNC_MODULE')) {
        const resolved = localRequire.resolve(mod);
        return import(resolved).then(function(ns) { return wrapStdlibExport(ns.default != null ? ns.default : ns); });
      }
      throw err;
    }
  }
  // 3. User-installed packages (config-gated, native addons blocked at install time)
  if (userPkgBasePath && userPkgModuleSet.has(mod)) {
    const localRequire = createRequire(nodePath.join(userPkgBasePath, 'package.json'));
    try {
      var loaded = localRequire(mod);
      return autoInitWasm(loaded, localRequire, mod);
    } catch (err) {
      if (err && (err.code === 'ERR_REQUIRE_ESM' || err.code === 'ERR_REQUIRE_ASYNC_MODULE')) {
        const resolved = localRequire.resolve(mod);
        return import(resolved).then(function(ns) {
          var m = ns.default != null ? ns.default : ns;
          return autoInitWasm(m, localRequire, mod);
        });
      }
      throw err;
    }
  }
  // 4. Stdlib still installing — specific error instead of confusing MODULE_NOT_FOUND
  if (!stdlibBasePath && stdlibModuleSet.size === 0) {
    throw new Error('Module "' + mod + '" is not available. Standard library is still installing — try again shortly.');
  }
  // 5. Error with full list. For host-access modules, name the replacement:
  // the usual reason for reaching for fs/child_process here is workspace
  // files, which live in the VFS and are reachable through adf.* — listing
  // available modules alone leaves that dead end unexplained.
  const all = [...Array.from(ALLOWED_MODULES), ...Array.from(stdlibModuleSet), ...Array.from(userPkgModuleSet)].sort();
  const hostModules = {
    fs: 'workspace files live in the VFS — use adf.fs_read({path}) / adf.fs_write({path, content}) / adf.fs_list({prefix})',
    'fs/promises': 'workspace files live in the VFS — use adf.fs_read({path}) / adf.fs_write({path, content}) / adf.fs_list({prefix})',
    child_process: 'no host processes from the sandbox — use compute_exec for a real OS, or adf_shell for the VFS',
    os: 'no host OS access from the sandbox',
    net: 'use adf.sys_fetch({url}) for HTTP',
    http: 'use adf.sys_fetch({url}) for HTTP',
    https: 'use adf.sys_fetch({url}) for HTTP',
  };
  const hint = hostModules[mod];
  throw new Error(
    'Module "' + mod + '" is not available in the sandbox.' +
    (hint ? ' ' + hint + '.' : '') +
    ' Available modules: ' + all.join(', ')
  );
}

// Create the adf proxy object. One proxy per execution: the owner id travels
// with every RPC so the main thread can route the reply back to the execution
// that asked, and so the drain only counts calls it is actually waiting on.
function createAdfProxy(ownerId) {
  return new Proxy({}, {
    get(target, prop) {
      if (typeof prop !== 'string') return undefined;

      // Return an async function for any property access
      return async function(...args) {
        const method = prop;
        // Read the config of the execution this proxy belongs to, not whatever
        // the last 'setup' left behind.
        const cfg = toolConfigFor(ownerId);

        // Fast-fail for unknown tools (skip for model_invoke and sys_lambda which are special)
        if (method !== 'model_invoke' && method !== 'sys_lambda') {
          if (cfg.enabledTools.length > 0 && !cfg.enabledTools.includes(method)) {
            const err = new Error('Tool "' + method + '" is not available');
            err.code = 'NOT_FOUND';
            throw err;
          }
          // Fast-fail for restricted tools (enabled + restricted = HIL from loop, authorized-only from code)
          if (cfg.hilTools.includes(method) && !cfg.isAuthorized) {
            const err = new Error('"' + method + '" can only be called from authorized code. Ask the owner to authorize the source file.');
            err.code = 'REQUIRES_AUTHORIZED_CODE';
            throw err;
          }
        }

        const callId = workerToken + ':' + ownerId + ':' + (++callIdCounter);

        // Send RPC request to main thread
        // Merge args into a single object if there's exactly one arg
        const payload = args.length === 1 ? args[0] : (args.length === 0 ? {} : args);
        parentPort.postMessage({ type: 'adf_call', callId, execId: ownerId, method, args: payload });

        // Return a Promise that resolves when main thread responds
        return new Promise((resolve, reject) => {
          pendingCalls.set(callId, { resolve, reject, owner: ownerId });
        });
      };
    }
  });
}

// Minimal process shim (safe subset of Node's process object)
const processShim = {
  env: {},
  version: process.version,
  versions: process.versions,
  platform: process.platform,
  arch: process.arch,
  argv: [],
  argv0: 'node',
  cwd: () => '/',
  exit: () => { throw new Error('process.exit() is not allowed in sandbox'); },
  hrtime: process.hrtime,
  nextTick: (fn) => queueMicrotask(fn),
  stdout: { write: () => {} },
  stderr: { write: () => {} },
};

// Build safe globals whitelist.
// IMPORTANT: Do NOT pass standard ECMAScript constructors (Object, Array, String, etc.)
// here. vm.createContext creates its own copies of these. If we pass the worker's copies,
// the prototype freeze below would freeze the WORKER's prototypes, breaking all stdlib
// packages loaded via __require (they run in worker scope and need unfrozen prototypes).
// By omitting them, the freeze only affects the vm context's own isolated prototypes.
const noop = () => {};
const safeGlobals = {
  console: { log: noop, warn: noop, error: noop, info: noop },
  process: processShim,
  // Non-standard globals that vm.createContext may not provide:
  setTimeout, clearTimeout,
  setInterval, clearInterval,
  structuredClone,
  queueMicrotask,
  atob, btoa,
  TextEncoder, TextDecoder,
  URL, URLSearchParams,
  Buffer: require('buffer').Buffer,
  __require,
  require: requireStub,
  __stdlibPath: stdlibBasePath,
  __makeAdf: createAdfProxy,
  // Context-global fallback for code that runs outside an execution wrapper
  // (stored closures called by a later execution). Executions shadow this with
  // their own proxy, injected as a local in the IIFE below.
  adf: createAdfProxy('ctx'),
  module: { exports: {} },
  exports: {},
};
// Link module.exports and exports to the same object
safeGlobals.exports = safeGlobals.module.exports;

const context = vm.createContext(safeGlobals, {
  name: 'adf-sandbox',
  codeGeneration: { strings: false, wasm: true },
});

// Freeze built-in prototypes INSIDE the vm context to prevent sandbox code
// from polluting the context's prototype chain across executions.
// These are the vm context's OWN copies (not the worker's), so stdlib packages
// loaded via __require in worker scope are unaffected.
vm.runInContext(
  '[Object, Array, Function, String, Number, Boolean, RegExp, Date,' +
  ' Map, Set, WeakMap, WeakSet, Promise, Error, TypeError, RangeError,' +
  ' SyntaxError, URIError, ReferenceError, EvalError,' +
  ' ArrayBuffer, SharedArrayBuffer, DataView,' +
  ' Uint8Array, Uint16Array, Uint32Array, Uint8ClampedArray,' +
  ' Int8Array, Int16Array, Int32Array, Float32Array, Float64Array,' +
  ' BigInt64Array, BigUint64Array' +
  '].forEach(function(ctor) { if (ctor) Object.freeze(ctor.prototype); });',
  context
);

// Handle messages from main thread
parentPort.on('message', async (msg) => {
  if (msg.type === 'setup') {
    if (msg.toolConfig) defaultToolConfig = msg.toolConfig;
    if (msg.stdlibBasePath) {
      stdlibBasePath = msg.stdlibBasePath;
      stdlibModuleSet = new Set(msg.stdlibModules || []);
      // Update the context-visible stdlib path for agent code (e.g. sql.js locateFile)
      context.__stdlibPath = stdlibBasePath;
    }
    if (msg.userPkgBasePath !== undefined) {
      userPkgBasePath = msg.userPkgBasePath;
      userPkgModuleSet = new Set(msg.userPkgModules || []);
    }
    return;
  }

  if (msg.type === 'adf_result') {
    const pending = pendingCalls.get(msg.callId);
    if (pending) {
      pendingCalls.delete(msg.callId);
      if (msg.error) {
        const err = new Error(msg.error);
        if (msg.errorCode) err.code = msg.errorCode;
        pending.reject(err);
      } else {
        // Parse JSON results from tools (unless raw flag is set, e.g. model_invoke)
        let value = msg.result;
        if (!msg.raw && typeof value === 'string') {
          try { value = JSON.parse(value); } catch { /* keep as string */ }
        }
        // Auto-convert binary body from sys_fetch to Buffer
        if (value && typeof value === 'object' && value._body_encoding === 'base64' && typeof value.body === 'string') {
          value.body = Buffer.from(value.body, 'base64');
          delete value._body_encoding;
        }
        pending.resolve(value);
      }
    }
    return;
  }

  if (msg.type !== 'execute') return;

  // Each execution gets its own stdout array stored on the context under a unique key.
  // A local 'console' variable is injected inside the IIFE to shadow the global,
  // preventing concurrent executions from clobbering each other's capture arrays.
  // The execId is echoed back in the result message so the main thread can correlate
  // responses when multiple executions run concurrently on the same worker.
  const localExecId = msg.execId || ('w_' + (++callIdCounter));
  const stdoutKey = '__stdout_' + localExecId;
  context[stdoutKey] = [];
  // Per-execution tool config, read by this execution's own adf proxy.
  setExecToolConfig(localExecId, msg.toolConfig);
  const appendOutput = function(line) {
    const buf = context[stdoutKey];
    if (buf) buf.push(line);
  };

  const timeoutMs = msg.timeout || 10000;
  const deadline = Date.now() + timeoutMs;
  let timeoutHandle;

  try {
    // Auto-result: if the user code parses as a single expression, evaluate it
    // as one (return its value) so 'node -e "await adf.fs_list()"' reports the
    // value instead of undefined — REPL/node -p semantics. Compile-only check;
    // the async-arrow wrapper lets top-level await parse. Anything that is not
    // a single expression (statements, declarations, 'return x') keeps
    // statement semantics.
    let isExpression = false;
    try {
      new vm.Script('async () => (\\n' + msg.code + '\\n)');
      isExpression = true;
    } catch { /* statements */ }
    const body = isExpression ? 'return (\\n' + msg.code + '\\n);' : msg.code;

    // Wrap user code in async IIFE with a local console that captures to its own array.
    // 'adf' is shadowed the same way so every RPC this execution makes is tagged
    // with its execId — that's what keeps replies and drain accounting separate
    // when several executions share a worker.
    // Also patch process.stdout/stderr.write to capture output from code using Node-style I/O.
    const wrappedCode = '(async () => { ' +
      'const adf = __makeAdf(' + JSON.stringify(localExecId) + '); ' +
      'const console = {' +
        'log: (...a) => ' + stdoutKey + '.push(a.map(String).join(" ")),' +
        'warn: (...a) => ' + stdoutKey + '.push("[warn] " + a.map(String).join(" ")),' +
        'error: (...a) => ' + stdoutKey + '.push("[error] " + a.map(String).join(" ")),' +
        'info: (...a) => ' + stdoutKey + '.push(a.map(String).join(" "))' +
      '}; ' +
      'if (typeof process !== "undefined") {' +
        'process.stdout = { write: (s) => { var t = String(s); if (t.endsWith(String.fromCharCode(10))) t = t.slice(0, -1); ' + stdoutKey + '.push(t); return true; } };' +
        'process.stderr = { write: (s) => { var t = String(s); if (t.endsWith(String.fromCharCode(10))) t = t.slice(0, -1); ' + stdoutKey + '.push("[stderr] " + t); return true; } };' +
      '} ' +
      body + ' })()';

    const promise = vm.runInContext(wrappedCode, context, {
      filename: 'agent-code.js',
    });

    // Race the promise against a timeout
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        const err = new Error('Execution timed out after ' + timeoutMs + 'ms');
        err.code = 'TIMEOUT';
        reject(err);
      }, timeoutMs);
    });

    const value = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timeoutHandle);

    // The IIFE settled, but unawaited .then chains, short timers, and pending
    // adf.* calls may still produce output. Keep the buffer alive and drain
    // before snapshotting — this is what un-mutes 'adf.x().then(console.log)'.
    await drainPendingWork(
      function() { return (context[stdoutKey] || []).length; },
      appendOutput,
      deadline,
      localExecId,
      timeoutMs
    );

    let serialized;
    if (value !== undefined) {
      try {
        serialized = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      } catch {
        serialized = String(value);
      }
    }

    const stdoutLines = context[stdoutKey] || [];
    delete context[stdoutKey];
    parentPort.postMessage({
      type: 'result',
      execId: localExecId,
      value: serialized,
      stdout: stdoutLines.join('\\n'),
    });
  } catch (err) {
    clearTimeout(timeoutHandle);
    // Non-timeout failures still drain briefly so output logged before the
    // error is kept. On TIMEOUT, snapshot immediately — the main thread's
    // guard (timeout + 2000ms) would otherwise terminate the worker mid-drain.
    if (err && err.code !== 'TIMEOUT') {
      try {
        await drainPendingWork(
          function() { return (context[stdoutKey] || []).length; },
          appendOutput,
          Math.min(deadline, Date.now() + 500),
          localExecId,
          1000
        );
      } catch { /* best effort */ }
    }
    const stdoutLines = context[stdoutKey] || [];
    delete context[stdoutKey];
    parentPort.postMessage({
      type: 'result',
      execId: localExecId,
      error: err.message || String(err),
      errorCode: err.code || undefined,
      stdout: stdoutLines.join('\\n'),
    });
  }
});

// Catch unhandled rejections in the worker (e.g. unawaited adf.* calls that fail)
// Without this handler, unhandled rejections crash the worker and propagate to the main process.
process.on('unhandledRejection', (err) => {
  // Silently swallow — the adf_result with error was already sent.
  // These occur when lambda code calls adf.* without await.
});

// Signal ready
parentPort.postMessage({ type: 'ready' });
`

/** One in-flight execute() call, registered on its worker so the message router
 *  can dispatch to it and so worker death can settle it. */
interface PendingExec {
  onAdfCall?: OnAdfCallFn
  /** Authorization the handler was built with — travels with the owner so an
   *  orphaned call can never be answered at a level its owner didn't have. */
  isAuthorized: boolean
  /** Resolves the execute() promise. Idempotent — first settle wins. */
  settle: (result: CodeResult) => void
}

/** A finished execution's handler, kept briefly. Sandboxes are persistent, so a
 *  helper stored by execution 1 and called during execution 2 still holds
 *  execution 1's `adf` proxy — its calls must reach its own handler, at its own
 *  authorization, rather than borrow whichever execution happens to be live. */
interface RetiredExec {
  onAdfCall?: OnAdfCallFn
  isAuthorized: boolean
}

/** How many finished executions keep their handler per worker. Bounded because
 *  each retained record pins the closures its handler captured. */
const RETAINED_EXECS = 12

const ORPHANED_CALL_ERROR =
  'This adf call came from a closure stored by an execution that has already finished, ' +
  'and this sandbox has run code at more than one authorization level — answering it ' +
  'could hand the call the wrong authorization. Call adf.* from the running execution ' +
  '(or re-create the helper inside it) instead of from a stored closure.'

interface WorkerEntry {
  worker: Worker
  ready: boolean
  /** Number of in-flight execute() calls using this worker */
  inflight: number
  /** Whether destroy() was called while executions were still in-flight */
  pendingDestroy: boolean
  /** In-flight executions by execId, in registration order */
  pending: Map<string, PendingExec>
  /** Recently finished executions by execId, oldest first (bounded) */
  retired: Map<string, RetiredExec>
  /** Every authorization level this worker has executed code at. One level
   *  means an unattributable call cannot be upgraded by answering it. */
  authLevels: Set<boolean>
  /** Per-invocation sandbox (cold lambda): counted against the churn cap and
   *  never kept resident. Persistent sandboxes are counted as warm residents. */
  ephemeral: boolean
  /** When the last execution on this worker finished — drives idle eviction. */
  lastUsed: number
  /** Its admission permit has been handed back. Guards double-release when both
   *  destroyWorker() and the exit event fire for the same worker. */
  released: boolean
}

/** Failure to obtain a worker, distinguished from a failure inside one so
 *  execute() can report the right errorCode instead of a bare throw. */
class SandboxUnavailableError extends Error {
  constructor(message: string, readonly errorCode: string) {
    super(message)
    this.name = 'SandboxUnavailableError'
  }
}

/** Options for a single execute(). Separate from ToolConfig because ToolConfig
 *  is shipped into the worker and these are main-thread-only concerns. */
export interface ExecuteOptions {
  /**
   * Authorization the `onAdfCall` handler is actually bound to. This is NOT
   * `toolConfig.isAuthorized`: every call site derives that from
   * `getAuthorizationContext()`, which prefers the caller's AsyncLocalStorage
   * value, so a handler hard-bound to `withAuthorization(false)` still reported
   * `true` when invoked from inside an authorized lambda — permanently poisoning
   * the worker's authLevels. Defaults to `toolConfig.isAuthorized`.
   */
  handlerAuthorized?: boolean
  /**
   * Agent that owns this sandbox, so destroyForAgent() can reap derived ids
   * from an explicit registry instead of matching string prefixes. Defaults to
   * the sandbox id.
   */
  agent?: string
  /** True for per-invocation sandboxes torn down right after (cold lambdas). */
  ephemeral?: boolean
}

/**
 * Default ceiling on cold-lambda churn: the population that spawns a worker per
 * invocation. Worker creation is V8 isolate creation — process-wide it tops out
 * around 30/s regardless of what our script does — and measured cold-cycle
 * throughput peaks near half the core count and degrades past it (32-core box:
 * 38 cycles/s at C=16, 28/s at C=48 with 1.4s p50 and half-second event-loop
 * stalls). Clamped to [4, 32] so small machines still make progress and large
 * ones don't claim the whole box.
 */
function defaultMaxColdWorkers(): number {
  let cores = 8
  try { cores = cpus().length || 8 } catch { /* no /proc in some sandboxes */ }
  return Math.max(4, Math.min(32, Math.floor(cores / 2)))
}

/** Warm residents are idle most of their life, so they get a larger count cap
 *  than the cold concurrency cap — but a cap all the same: warm sandboxes are
 *  keyed per (agent, lambda target) and nothing evicted them, so residency
 *  scaled with triggers *declared* rather than with load. */
function warmCapFor(coldCap: number): number {
  return Math.max(16, coldCap * 3)
}

/** A warm resident idle this long is evicted. Re-spawn measured at ~16ms solo,
 *  so the trade is cheap; the parked module state is the only thing lost. */
const WARM_IDLE_TTL_MS = 5 * 60_000
/** Safety valve for a cold sandbox whose caller never destroyed it — without it
 *  a leaked worker would hold a churn permit forever. */
const COLD_IDLE_TTL_MS = 60_000
/** Longest an execution waits for a permit before failing. The per-lane dispatch
 *  queue owns drop policy; this gate blocks, and only gives up when waiting any
 *  longer would exceed the execution's own budget. */
const ADMISSION_MAX_WAIT_MS = 120_000
/** How long a worker gets to reach 'ready' before creation is failed. Generous:
 *  under a cold burst a spawn can queue behind ~30 others. */
const WORKER_BOOT_TIMEOUT_MS = 30_000
/** Throttle for the aggregate saturation warning. */
const SATURATION_LOG_INTERVAL_MS = 30_000

/** An execution parked on the admission gate. */
interface AdmissionWaiter {
  ephemeral: boolean
  resolve: () => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

interface AdfCallMessage {
  type: 'adf_call'
  callId: string
  /** Execution that issued the call — the router uses it to pick the handler */
  execId?: string
  method: string
  args: unknown
}

interface ResultMessage {
  type: 'result'
  execId?: string
  value?: string
  stdout?: string
  error?: string
  errorCode?: string
}

type WorkerMessage = AdfCallMessage | ResultMessage | { type: 'ready' }

export type OnAdfCallFn = (method: string, args: unknown) => Promise<AdfCallResult>

/**
 * Manages Worker Threads with sandboxed vm.Contexts for code execution, keyed by
 * sandbox id. Workers are lazily created on first execute() and persist, so
 * variables and functions defined in one call carry over to the next call *on
 * the same sandbox id*.
 *
 * What shares a context is decided by the caller's id, not by the agent:
 *   `<agentId>`                       sys_code — one persistent sandbox per agent
 *   `<agentId>:lambda:<file>`         warm trigger lambdas, per source file
 *   `<agentId>:lambda:<file>:<uuid>`  cold trigger lambdas, one per invocation
 *   `<agentId>:fn:<file>`             sys_lambda, per source file
 *   `<agentId>:mw` / `:api` / `:ws` / `:tap:<n>`   middleware, routes, taps
 * Warm lambdas and sys_lambda both partition per *file* so the two paths agree
 * about granularity: everything in one file shares module state, and a file is
 * also the unit of authorization, so no context ever mixes auth levels.
 *
 * Supports an RPC bridge for adf_call requests from sandbox code to the main thread,
 * enabling tools, model_invoke, and sys_lambda from within executed code.
 *
 * This service is a process-wide singleton, which makes it the only component
 * that sees every agent's sandbox demand — so it is where the global worker
 * ceiling lives (see admit()). Cold churn gets a concurrency cap, warm residents
 * get a count cap plus an idle TTL; the gate blocks with a deadline rather than
 * dropping, because the per-lane dispatch queue owns drop policy.
 */
export class CodeSandboxService {
  private workers: Map<string, WorkerEntry> = new Map()
  /** In-flight worker creations, so concurrent execute() calls share one worker
   *  instead of each building their own and the loser leaking. */
  private creating: Map<string, Promise<WorkerEntry>> = new Map()
  private execCounter = 0
  private stdlibBasePath: string | null = null
  private stdlibModules: string[] = []
  private userPkgBasePath: string | null = null
  private userPkgModules: string[] = []

  /** Sandbox ids each agent has created, so destroyForAgent() reaps exactly
   *  those. Prefix matching used to do this, but sandbox ids are absolute
   *  Windows paths — an agent whose `.adf` declares `id: "C"` made
   *  destroyForAgent('C') match the prefix `C:` and reap every path-keyed
   *  sandbox in the process. */
  private agentSandboxes: Map<string, Set<string>> = new Map()
  private sandboxOwners: Map<string, Set<string>> = new Map()

  // --- Global admission control ---
  private maxColdWorkers = defaultMaxColdWorkers()
  private maxWarmWorkers = warmCapFor(defaultMaxColdWorkers())
  /** Live + being-created workers of each population (their held permits). */
  private coldCount = 0
  private warmCount = 0
  private waiters: AdmissionWaiter[] = []
  private lastSaturationLog = 0
  private blockedSinceLastLog = 0

  /** Configure the standard library path and available module names for the sandbox. */
  setStdlib(basePath: string, modules: string[]): void {
    this.stdlibBasePath = basePath
    this.stdlibModules = modules
  }

  /** Configure user-installed package path and visible module names for the sandbox. */
  setUserPackages(basePath: string, modules: string[]): void {
    this.userPkgBasePath = basePath
    this.userPkgModules = modules
  }

  /**
   * Set the global ceiling on concurrent cold-lambda workers (user setting —
   * it decides how much of the machine the app claims). Warm residency is
   * derived from it. Undefined / non-numeric restores the CPU-derived default.
   */
  setMaxWorkers(max: number | undefined | null): void {
    const parsed = typeof max === 'number' && Number.isFinite(max) && max >= 1
      ? Math.floor(max)
      : defaultMaxColdWorkers()
    this.maxColdWorkers = parsed
    this.maxWarmWorkers = warmCapFor(parsed)
    this.pumpWaiters()
  }

  /** Live worker accounting — used by the settings UI and by tests. */
  getResourceStats(): {
    cold: number; warm: number; waiting: number; maxCold: number; maxWarm: number
  } {
    return {
      cold: this.coldCount,
      warm: this.warmCount,
      waiting: this.waiters.length,
      maxCold: this.maxColdWorkers,
      maxWarm: this.maxWarmWorkers
    }
  }

  /**
   * Execute code in the agent's sandbox. Creates a worker on first call.
   * @param onAdfCall - Optional RPC handler for adf.* calls from sandbox code.
   * @param toolConfig - Optional tool availability config for fast-fail in proxy.
   * @param options - Handler authorization, owning agent, cold/warm hint.
   */
  async execute(
    agentId: string,
    code: string,
    timeout?: number,
    onAdfCall?: OnAdfCallFn,
    toolConfig?: ToolConfig,
    options?: ExecuteOptions
  ): Promise<CodeResult> {
    const effectiveTimeout = Math.min(timeout ?? DEFAULT_TIMEOUT, MAX_TIMEOUT)
    const ephemeral = options?.ephemeral ?? false

    // Transform imports and exports before sending to worker
    let transformedCode = transformImports(code)
    transformedCode = transformExports(transformedCode)

    if (options?.agent) this.registerSandbox(options.agent, agentId)

    let entry: WorkerEntry
    try {
      entry = await this.getOrCreateWorker(agentId, ephemeral, effectiveTimeout)
    } catch (err) {
      // No worker at all — a boot failure or the global gate giving up. Report
      // it as a result rather than throwing: every caller already handles a
      // failed CodeResult, and half of them would turn a throw into a crash.
      if (!this.workers.has(agentId)) this.unregisterSandbox(agentId)
      return {
        stdout: '',
        error: err instanceof Error ? err.message : String(err),
        errorCode: err instanceof SandboxUnavailableError ? err.errorCode : 'SANDBOX_TERMINATED'
      }
    }

    // Send stdlib paths and user package paths. toolConfig rides along as the
    // worker's fallback for proxies with no execution of their own; the
    // authoritative per-execution copy travels on the 'execute' message.
    if (toolConfig || this.stdlibBasePath || this.userPkgBasePath) {
      entry.worker.postMessage({
        type: 'setup',
        toolConfig,
        stdlibBasePath: this.stdlibBasePath,
        stdlibModules: this.stdlibModules,
        userPkgBasePath: this.userPkgBasePath,
        userPkgModules: this.userPkgModules
      })
    }

    const execId = `exec_${++this.execCounter}`
    // The authorization the handler is bound to, NOT toolConfig.isAuthorized —
    // see ExecuteOptions.handlerAuthorized for why those differ.
    const isAuthorized = options?.handlerAuthorized ?? toolConfig?.isAuthorized ?? false
    entry.authLevels.add(isAuthorized)
    entry.inflight++

    const result = await new Promise<CodeResult>((resolve) => {
      let timer: NodeJS.Timeout
      const settle = (r: CodeResult): void => {
        if (!entry.pending.delete(execId)) return // already settled
        // Keep the handler reachable for calls this execution's stored closures
        // make later — see RetiredExec.
        this.retire(entry, execId, { onAdfCall, isAuthorized })
        clearTimeout(timer)
        resolve(r)
      }

      // Worker-level timeout guard. Settle first, then terminate — otherwise the
      // exit handler would relabel this execution as SANDBOX_TERMINATED.
      timer = setTimeout(() => {
        console.warn(`[CodeSandbox] Worker timeout for agent ${agentId}, terminating worker`)
        settle({
          stdout: '',
          error: `Execution timed out after ${effectiveTimeout}ms`,
          errorCode: 'TIMEOUT'
        })
        this.destroyWorker(agentId)
      }, effectiveTimeout + 2000) // Extra buffer for async RPC round-trips

      // The worker can die while we await its creation — registering on a dead
      // one would wait out the guard timer for nothing.
      if (this.workers.get(agentId) !== entry) {
        clearTimeout(timer)
        resolve({ stdout: '', error: 'Sandbox worker terminated', errorCode: 'SANDBOX_TERMINATED' })
        return
      }

      // The worker's message router (installed once in createWorker) dispatches
      // adf_call and result messages here by execId.
      entry.pending.set(execId, { onAdfCall, isAuthorized, settle })

      entry.worker.postMessage({
        type: 'execute',
        code: transformedCode,
        timeout: effectiveTimeout,
        execId,
        toolConfig
      })
    })

    // Decrement inflight count and destroy if deferred
    entry.inflight--
    entry.lastUsed = Date.now()
    if (entry.pendingDestroy && entry.inflight <= 0 && this.workers.get(agentId) === entry) {
      this.destroyWorker(agentId)
    }

    return result
  }

  /**
   * Terminate a specific agent's worker. Called on agent stop.
   * If executions are in-flight, defers destruction until they complete.
   */
  destroy(agentId: string): void {
    const entry = this.workers.get(agentId)
    if (entry && entry.inflight > 0) {
      entry.pendingDestroy = true
      return
    }
    this.destroyWorker(agentId)
  }

  /**
   * Terminate the agent's own sandbox plus every sandbox it derived
   * (`<agentId>:lambda:...`, `:mw`, `:fn:`, `:tap:`, `:ws`, ...). Cold lambdas
   * mint a fresh id per invocation, so agent teardown has to reap the derived
   * ids too or those workers outlive the agent. The ids come from an explicit
   * registry populated by execute() — never from string-prefix matching, which
   * an agent declaring `id: "C"` could aim at every `C:\...` sandbox.
   */
  destroyForAgent(agentId: string): void {
    const derived = this.agentSandboxes.get(agentId)
    if (derived) {
      for (const id of Array.from(derived)) this.destroy(id)
      this.agentSandboxes.delete(agentId)
    }
    this.destroy(agentId)
  }

  /**
   * Terminate all workers. Called on app shutdown or mesh disable.
   */
  destroyAll(): void {
    // Fail anything queued on the gate first: on shutdown or mesh disable it
    // would otherwise sit there until its own timeout for a worker that is
    // never coming.
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.reject(new SandboxUnavailableError(
        'Sandbox service shut down while waiting for a worker',
        'SANDBOX_TERMINATED'
      ))
    }
    for (const agentId of Array.from(this.workers.keys())) {
      this.destroyWorker(agentId)
    }
  }

  /** Record that `agent` owns sandbox id `sandboxId`. */
  private registerSandbox(agent: string, sandboxId: string): void {
    let set = this.agentSandboxes.get(agent)
    if (!set) {
      set = new Set()
      this.agentSandboxes.set(agent, set)
    }
    set.add(sandboxId)
    let owners = this.sandboxOwners.get(sandboxId)
    if (!owners) {
      owners = new Set()
      this.sandboxOwners.set(sandboxId, owners)
    }
    owners.add(agent)
  }

  /** Drop a destroyed sandbox from its owners' registries. */
  private unregisterSandbox(sandboxId: string): void {
    const owners = this.sandboxOwners.get(sandboxId)
    if (!owners) return
    this.sandboxOwners.delete(sandboxId)
    for (const agent of owners) {
      const set = this.agentSandboxes.get(agent)
      if (!set) continue
      set.delete(sandboxId)
      if (set.size === 0) this.agentSandboxes.delete(agent)
    }
  }

  // --- Global admission control -------------------------------------------
  // The process-wide singleton is the only component that sees every agent, so
  // the ceiling has to live here. Partitioning cold lambdas per invocation
  // removed an accidental bound (one worker per agent); measured, 20 concurrent
  // cold invocations went from 1 worker/+6.9MB to 20 workers/+88MB, and a
  // 10-agent x 3-lane x 4-concurrent burst reached 120 live workers / +585MB.

  /** Take a permit if one is free, evicting an idle warm resident if that is
   *  what it takes. Synchronous on purpose: an await between the check and the
   *  increment would let two admissions both see the last free slot. */
  private tryReserve(ephemeral: boolean): boolean {
    if (ephemeral) {
      if (this.coldCount < this.maxColdWorkers) {
        this.coldCount++
        return true
      }
      return false
    }
    if (this.warmCount < this.maxWarmWorkers) {
      this.warmCount++
      return true
    }
    if (this.evictLruWarm()) {
      this.warmCount++
      return true
    }
    return false
  }

  /** Hand a permit back. Idempotent — destroyWorker() and the exit event both
   *  land on the same entry. */
  private release(entry: WorkerEntry): void {
    if (entry.released) return
    entry.released = true
    if (entry.ephemeral) this.coldCount = Math.max(0, this.coldCount - 1)
    else this.warmCount = Math.max(0, this.warmCount - 1)
    this.pumpWaiters()
  }

  /** Wait for a permit, up to `waitMs`. Blocks rather than dropping: dropping
   *  here as well as in the dispatch queue would make loss un-attributable. */
  private admit(ephemeral: boolean, waitMs: number): Promise<void> {
    this.sweepIdle()
    if (this.tryReserve(ephemeral)) return Promise.resolve()

    return new Promise<void>((resolve, reject) => {
      const waiter: AdmissionWaiter = {
        ephemeral,
        resolve,
        reject,
        timer: setTimeout(() => {
          const i = this.waiters.indexOf(waiter)
          if (i >= 0) this.waiters.splice(i, 1)
          reject(new SandboxUnavailableError(
            `No sandbox worker available within ${waitMs}ms — the global worker ceiling ` +
            `(${ephemeral ? `${this.maxColdWorkers} concurrent lambda` : `${this.maxWarmWorkers} resident`} ` +
            'sandboxes) is saturated. Raise it in Settings › Packages if this is steady state.',
            'SANDBOX_BUSY'
          ))
        }, waitMs)
      }
      this.waiters.push(waiter)
      this.noteSaturation()
    })
  }

  /** Hand freed permits to whoever is waiting. */
  private pumpWaiters(): void {
    for (let i = 0; i < this.waiters.length;) {
      const waiter = this.waiters[i]
      if (this.tryReserve(waiter.ephemeral)) {
        this.waiters.splice(i, 1)
        clearTimeout(waiter.timer)
        waiter.resolve()
      } else {
        i++
      }
    }
  }

  /** Reap idle sandboxes past their TTL. Lazy (called from admit) rather than
   *  on a timer so the service never holds the event loop open. */
  private sweepIdle(): void {
    const now = Date.now()
    for (const [id, entry] of Array.from(this.workers)) {
      if (entry.inflight > 0) continue
      const ttl = entry.ephemeral ? COLD_IDLE_TTL_MS : WARM_IDLE_TTL_MS
      if (now - entry.lastUsed >= ttl) this.destroyWorker(id)
    }
  }

  /** Evict the least recently used idle warm resident. Returns false when every
   *  warm worker is busy — then the caller has to wait instead. */
  private evictLruWarm(): boolean {
    let oldestId: string | undefined
    let oldest = Infinity
    for (const [id, entry] of this.workers) {
      if (entry.ephemeral || entry.inflight > 0) continue
      if (entry.lastUsed < oldest) {
        oldest = entry.lastUsed
        oldestId = id
      }
    }
    if (oldestId === undefined) return false
    this.destroyWorker(oldestId)
    return true
  }

  /** One aggregate warning for the whole process. Per-agent warnings are what
   *  the old code produced: 50 agents each reporting a local timeout and none
   *  of them naming the shared cause. */
  private noteSaturation(): void {
    this.blockedSinceLastLog++
    const now = Date.now()
    if (now - this.lastSaturationLog < SATURATION_LOG_INTERVAL_MS) return
    this.lastSaturationLog = now
    console.warn(
      `[CodeSandbox] global worker ceiling is binding: ${this.coldCount}/${this.maxColdWorkers} cold, ` +
      `${this.warmCount}/${this.maxWarmWorkers} warm, ${this.waiters.length} execution(s) queued ` +
      `(${this.blockedSinceLastLog} blocked since the last report). Executions are waiting, not failing, ` +
      'until their own timeout expires.'
    )
    this.blockedSinceLastLog = 0
  }

  /**
   * Reuse the live worker, join an in-flight creation, or start one.
   *
   * Deliberately not `async`: the whole body up to `creating.set` must run in
   * one synchronous turn. Waiting for an admission permit is a suspension
   * point, and if the join entry were published after it, two concurrent first
   * executions would each build a worker — the loser silently overwritten in
   * `workers`, its permit never handed back.
   */
  private getOrCreateWorker(
    agentId: string,
    ephemeral: boolean,
    timeoutMs: number
  ): Promise<WorkerEntry> {
    const existing = this.workers.get(agentId)
    if (existing && existing.worker) return Promise.resolve(existing)

    const inflight = this.creating.get(agentId)
    if (inflight) return inflight

    // Only a genuinely new worker needs a permit; reuse and join do not.
    const creation = this.admit(ephemeral, Math.min(timeoutMs, ADMISSION_MAX_WAIT_MS))
      .then(() => this.createWorker(agentId, ephemeral))
    this.creating.set(agentId, creation)
    // Only the originator clears the join entry; joiners hold `creation` itself.
    return creation.finally(() => {
      if (this.creating.get(agentId) === creation) this.creating.delete(agentId)
    })
  }

  private async createWorker(agentId: string, ephemeral: boolean): Promise<WorkerEntry> {
    const worker = new Worker(WORKER_SCRIPT, { eval: true })

    const entry: WorkerEntry = {
      worker,
      ready: false,
      inflight: 0,
      pendingDestroy: false,
      pending: new Map(),
      retired: new Map(),
      authLevels: new Set(),
      ephemeral,
      lastUsed: Date.now(),
      released: false
    }
    this.workers.set(agentId, entry)

    // One router per worker, not one listener per execute() — N listeners both
    // tripped the MaxListeners warning and made every handler see every message.
    worker.on('message', (msg: WorkerMessage) => {
      void this.routeWorkerMessage(entry, msg)
    })

    // Boot outcome, settled by whichever lands first: 'ready', death, or the
    // timer. Registered BEFORE the ready wait — a worker that died mid-boot
    // (destroyAll() landing in the macrotask gap, ERR_WORKER_INIT_FAILED) used
    // to leave a promise that never settled, and `creating` cached it so every
    // later execute() on that id joined the dead promise permanently.
    let finishBoot: (err?: Error) => void = () => {}

    // Handle unexpected worker exit — remove from map so it gets recreated, and
    // settle whatever was running so it doesn't wait out its guard timer.
    worker.on('exit', () => {
      // Only evict our own entry: a dying old worker must not remove the newer
      // replacement already registered under the same id.
      if (this.workers.get(agentId) === entry) this.workers.delete(agentId)
      this.release(entry)
      this.settleWorkerPending(entry, 'Sandbox worker terminated')
      finishBoot(new SandboxUnavailableError(
        'Sandbox worker terminated before it became ready',
        'SANDBOX_TERMINATED'
      ))
    })

    worker.on('error', (err: Error) => {
      if (this.workers.get(agentId) === entry) this.workers.delete(agentId)
      this.release(entry)
      this.settleWorkerPending(entry, `Worker error: ${err.message}`)
      finishBoot(new SandboxUnavailableError(
        `Sandbox worker failed to start: ${err.message}`,
        'SANDBOX_TERMINATED'
      ))
      void worker.terminate()
    })

    // Wait for the worker to signal ready
    await new Promise<void>((resolve, reject) => {
      let settled = false
      let timer: NodeJS.Timeout
      const onMessage = (msg: { type: string }): void => {
        if (msg.type === 'ready') finish()
      }
      const finish = (err?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        worker.off('message', onMessage)
        if (!err) {
          entry.ready = true
          resolve()
          return
        }
        if (this.workers.get(agentId) === entry) this.workers.delete(agentId)
        this.release(entry)
        void worker.terminate()
        reject(err)
      }
      timer = setTimeout(() => {
        finish(new SandboxUnavailableError(
          `Sandbox worker did not become ready within ${WORKER_BOOT_TIMEOUT_MS}ms`,
          'SANDBOX_TERMINATED'
        ))
      }, WORKER_BOOT_TIMEOUT_MS)
      finishBoot = finish
      worker.on('message', onMessage)
    })

    return entry
  }

  /** Resolve every execution still registered on a dead/dying worker. */
  private settleWorkerPending(entry: WorkerEntry, error: string): void {
    for (const pending of Array.from(entry.pending.values())) {
      pending.settle({ stdout: '', error, errorCode: 'SANDBOX_TERMINATED' })
    }
    entry.pending.clear()
    // The context that held the stored closures died with the worker, so no
    // orphan can arrive again — dropping the retained handlers here is what
    // keeps them (and everything they capture) from outliving the worker.
    entry.retired.clear()
  }

  /** Retain a finished execution's handler, evicting the oldest past the cap. */
  private retire(entry: WorkerEntry, execId: string, rec: RetiredExec): void {
    entry.retired.set(execId, rec)
    while (entry.retired.size > RETAINED_EXECS) {
      const oldest = entry.retired.keys().next().value
      if (oldest === undefined) break
      entry.retired.delete(oldest)
    }
  }

  /**
   * Single message handler per worker. adf_call and result messages carry the
   * execId of the execution they belong to, so replies land on the right handler
   * even when several executions share a worker.
   */
  private async routeWorkerMessage(entry: WorkerEntry, msg: WorkerMessage): Promise<void> {
    const worker = entry.worker

    if (msg.type === 'adf_call') {
      const adfMsg = msg as AdfCallMessage
      // Calls whose owner already finished (stored closures, sys_lambda bodies
      // running in their own context) are answered by the owner's own retained
      // handler, so the call keeps its own authorization.
      const owner = adfMsg.execId
        ? entry.pending.get(adfMsg.execId) ?? entry.retired.get(adfMsg.execId)
        : undefined
      // Owner unrecoverable (retention evicted it, or it is the context-global
      // proxy). Borrowing the newest live handler is safe exactly when it cannot
      // upgrade the call: either the worker has only ever run one authorization
      // level, or the handler we would borrow is itself unauthorized — answering
      // through it can only downgrade. Deciding on authLevels alone refused
      // legitimate warm helpers in that second case.
      let target = owner
      if (!target) {
        const newest = this.newestPending(entry)
        if (newest && (entry.authLevels.size <= 1 || !newest.isAuthorized)) target = newest
      }
      const onAdfCall = target?.onAdfCall
      if (!onAdfCall) {
        const ambiguous = !owner && entry.authLevels.size > 1 && entry.pending.size > 0
        worker.postMessage({
          type: 'adf_result',
          callId: adfMsg.callId,
          error: ambiguous
            ? ORPHANED_CALL_ERROR
            : 'No adf handler configured — tools are not available in this sandbox',
          errorCode: ambiguous ? 'ORPHANED_CALL' : 'NOT_FOUND'
        })
        return
      }

      try {
        const result = await onAdfCall(adfMsg.method, adfMsg.args)
        worker.postMessage({
          type: 'adf_result',
          callId: adfMsg.callId,
          result: result.result,
          error: result.error,
          errorCode: result.errorCode,
          raw: result.raw || false
        })
      } catch (err) {
        worker.postMessage({
          type: 'adf_result',
          callId: adfMsg.callId,
          error: err instanceof Error ? err.message : String(err),
          errorCode: 'INTERNAL_ERROR'
        })
      }
      return
    }

    if (msg.type !== 'result') return

    const resultMsg = msg as ResultMessage
    const pending = resultMsg.execId ? entry.pending.get(resultMsg.execId) : undefined
    if (!pending) return

    if (resultMsg.error) {
      pending.settle({
        stdout: resultMsg.stdout ?? '',
        error: resultMsg.error,
        errorCode: resultMsg.errorCode
      })
    } else {
      pending.settle({ result: resultMsg.value, stdout: resultMsg.stdout ?? '' })
    }
  }

  /** Most recently registered in-flight execution (Map preserves insertion order). */
  private newestPending(entry: WorkerEntry): PendingExec | undefined {
    let last: PendingExec | undefined
    for (const pending of entry.pending.values()) last = pending
    return last
  }

  private destroyWorker(agentId: string): void {
    const entry = this.workers.get(agentId)
    if (entry) {
      this.workers.delete(agentId)
      this.unregisterSandbox(agentId)
      void entry.worker.terminate()
      // terminate() is async; settle now so nothing waits for the exit event,
      // and hand the admission permit back immediately so a queued execution
      // starts now rather than when the OS gets round to reaping the thread.
      this.release(entry)
      this.settleWorkerPending(entry, 'Sandbox worker terminated')
    }
  }
}
