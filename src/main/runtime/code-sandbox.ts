import { Worker } from 'worker_threads'

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

// Pending RPC calls
const pendingCalls = new Map();
let callIdCounter = 0;

// Tool availability config (set via 'setup' message)
let toolConfig = { enabledTools: [], hilTools: [], isAuthorized: false };

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
  // 5. Error with full list
  const all = [...Array.from(ALLOWED_MODULES), ...Array.from(stdlibModuleSet), ...Array.from(userPkgModuleSet)].sort();
  throw new Error('Module "' + mod + '" is not available in the sandbox. Available modules: ' + all.join(', '));
}

// Create the adf proxy object
function createAdfProxy() {
  return new Proxy({}, {
    get(target, prop) {
      if (typeof prop !== 'string') return undefined;

      // Return an async function for any property access
      return async function(...args) {
        const method = prop;

        // Fast-fail for unknown tools (skip for model_invoke and sys_lambda which are special)
        if (method !== 'model_invoke' && method !== 'sys_lambda') {
          if (toolConfig.enabledTools.length > 0 && !toolConfig.enabledTools.includes(method)) {
            const err = new Error('Tool "' + method + '" is not available');
            err.code = 'NOT_FOUND';
            throw err;
          }
          // Fast-fail for restricted tools (enabled + restricted = HIL from loop, authorized-only from code)
          if (toolConfig.hilTools.includes(method) && !toolConfig.isAuthorized) {
            const err = new Error('"' + method + '" can only be called from authorized code. Ask the owner to authorize the source file.');
            err.code = 'REQUIRES_AUTHORIZED_CODE';
            throw err;
          }
        }

        const callId = 'call_' + (++callIdCounter);

        // Send RPC request to main thread
        // Merge args into a single object if there's exactly one arg
        const payload = args.length === 1 ? args[0] : (args.length === 0 ? {} : args);
        parentPort.postMessage({ type: 'adf_call', callId, method, args: payload });

        // Return a Promise that resolves when main thread responds
        return new Promise((resolve, reject) => {
          pendingCalls.set(callId, { resolve, reject });
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
  __stdlibPath: stdlibBasePath,
  adf: createAdfProxy(),
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
    toolConfig = msg.toolConfig || { enabledTools: [], hilTools: [], isAuthorized: false };
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

  if (msg.type === 'fn_exec') {
    // Execute sys_lambda'd code in a fresh vm.Context (no variable leakage)
    // Same pattern as the persistent context: don't pass standard constructors,
    // let the vm create its own copies so the freeze doesn't affect worker scope.
    const fnStdout = [];
    const fnGlobals = {
      console: {
        log: (...a) => fnStdout.push(a.map(String).join(' ')),
        warn: (...a) => fnStdout.push('[warn] ' + a.map(String).join(' ')),
        error: (...a) => fnStdout.push('[error] ' + a.map(String).join(' ')),
        info: (...a) => fnStdout.push(a.map(String).join(' ')),
      },
      setTimeout, clearTimeout,
      setInterval, clearInterval,
      structuredClone,
      queueMicrotask,
      atob, btoa,
      TextEncoder, TextDecoder,
      URL, URLSearchParams,
      __require,
      __stdlibPath: stdlibBasePath,
      adf: createAdfProxy(),
      __args: msg.args || {},
      __exports: {},
      module: { exports: {} },
      exports: {},
    };
    // Link module.exports and exports to the same object
    fnGlobals.exports = fnGlobals.module.exports;

    const fnContext = vm.createContext(fnGlobals, {
      name: 'adf-fn-sandbox',
      codeGeneration: { strings: false, wasm: true },
    });

    try {
      const wrappedCode = '(async () => { ' + msg.code + ' })()';
      const result = await vm.runInContext(wrappedCode, fnContext, {
        filename: 'sys-lambda.js',
      });

      let serialized;
      if (result !== undefined) {
        try {
          serialized = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        } catch {
          serialized = String(result);
        }
      }

      parentPort.postMessage({
        type: 'fn_result',
        callId: msg.callId,
        result: serialized,
        stdout: fnStdout.join('\\n'),
      });
    } catch (err) {
      parentPort.postMessage({
        type: 'fn_result',
        callId: msg.callId,
        error: err.message || String(err),
        stdout: fnStdout.join('\\n'),
      });
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

  try {
    // Wrap user code in async IIFE with a local console that captures to its own array.
    // Also patch process.stdout/stderr.write to capture output from code using Node-style I/O.
    const wrappedCode = '(async () => { ' +
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
      msg.code + ' })()';
    const timeoutMs = msg.timeout || 10000;

    const promise = vm.runInContext(wrappedCode, context, {
      filename: 'agent-code.js',
    });

    // Race the promise against a timeout
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        const err = new Error('Execution timed out after ' + timeoutMs + 'ms');
        err.code = 'TIMEOUT';
        reject(err);
      }, timeoutMs);
    });

    const value = await Promise.race([promise, timeoutPromise]);

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

interface WorkerEntry {
  worker: Worker
  ready: boolean
  /** Number of in-flight execute() calls using this worker */
  inflight: number
  /** Whether destroy() was called while executions were still in-flight */
  pendingDestroy: boolean
}

interface AdfCallMessage {
  type: 'adf_call'
  callId: string
  method: string
  args: unknown
}

interface FnResultMessage {
  type: 'fn_result'
  callId: string
  result?: string
  error?: string
  stdout?: string
}

interface ResultMessage {
  type: 'result'
  execId?: string
  value?: string
  stdout?: string
  error?: string
  errorCode?: string
}

type WorkerMessage = AdfCallMessage | FnResultMessage | ResultMessage | { type: 'ready' }

export type OnAdfCallFn = (method: string, args: unknown) => Promise<AdfCallResult>

/**
 * Manages per-agent Worker Threads with sandboxed vm.Contexts for code execution.
 * Each agent gets its own persistent sandbox — variables and functions defined in
 * one call carry over to the next. Workers are lazily created on first execute().
 *
 * Supports an RPC bridge for adf_call requests from sandbox code to the main thread,
 * enabling tools, model_invoke, and sys_lambda from within executed code.
 */
export class CodeSandboxService {
  private workers: Map<string, WorkerEntry> = new Map()
  private execCounter = 0
  /** Tracks adf_call IDs currently being processed to prevent duplicate execution
   *  when multiple execute() handlers are registered on the same worker. */
  private handledAdfCalls: Set<string> = new Set()
  private stdlibBasePath: string | null = null
  private stdlibModules: string[] = []
  private userPkgBasePath: string | null = null
  private userPkgModules: string[] = []

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
   * Execute code in the agent's sandbox. Creates a worker on first call.
   * @param onAdfCall - Optional RPC handler for adf.* calls from sandbox code.
   * @param toolConfig - Optional tool availability config for fast-fail in proxy.
   */
  async execute(
    agentId: string,
    code: string,
    timeout?: number,
    onAdfCall?: OnAdfCallFn,
    toolConfig?: ToolConfig
  ): Promise<CodeResult> {
    const effectiveTimeout = Math.min(timeout ?? DEFAULT_TIMEOUT, MAX_TIMEOUT)

    // Transform imports and exports before sending to worker
    let transformedCode = transformImports(code)
    transformedCode = transformExports(transformedCode)

    let entry = this.workers.get(agentId)
    if (!entry || !entry.worker) {
      entry = await this.createWorker(agentId)
    }

    // Send tool config, stdlib paths, and user package paths
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
    entry.inflight++

    const result = await new Promise<CodeResult>((resolve) => {
      const worker = entry!.worker

      // Worker-level timeout guard
      const timer = setTimeout(() => {
        console.warn(`[CodeSandbox] Worker timeout for agent ${agentId}, terminating worker`)
        this.destroyWorker(agentId)
        resolve({
          stdout: '',
          error: `Execution timed out after ${effectiveTimeout}ms`,
          errorCode: 'TIMEOUT'
        })
      }, effectiveTimeout + 2000) // Extra buffer for async RPC round-trips

      const handler = async (msg: WorkerMessage): Promise<void> => {
        if (msg.type === 'adf_call') {
          // RPC bridge: route adf.* calls to the handler
          // Deduplicate: when multiple execute() handlers are registered on the same
          // worker, only one should process each adf_call to avoid running tools twice.
          const adfMsg = msg as AdfCallMessage
          if (this.handledAdfCalls.has(adfMsg.callId)) return
          this.handledAdfCalls.add(adfMsg.callId)
          if (!onAdfCall) {
            worker.postMessage({
              type: 'adf_result',
              callId: adfMsg.callId,
              error: 'No adf handler configured — tools are not available in this sandbox',
              errorCode: 'NOT_FOUND'
            })
            return
          }

          try {
            const result = await onAdfCall(adfMsg.method, adfMsg.args)
            this.handledAdfCalls.delete(adfMsg.callId)
            worker.postMessage({
              type: 'adf_result',
              callId: adfMsg.callId,
              result: result.result,
              error: result.error,
              errorCode: result.errorCode,
              raw: result.raw || false
            })
          } catch (err) {
            this.handledAdfCalls.delete(adfMsg.callId)
            worker.postMessage({
              type: 'adf_result',
              callId: adfMsg.callId,
              error: err instanceof Error ? err.message : String(err),
              errorCode: 'INTERNAL_ERROR'
            })
          }
          return
        }

        if (msg.type === 'fn_result') {
          // fn_result messages are handled by the sys_lambda flow via adf_call
          // They should be routed back as adf_result to resolve the pending sys_lambda promise
          const fnMsg = msg as FnResultMessage
          if (fnMsg.error) {
            worker.postMessage({
              type: 'adf_result',
              callId: fnMsg.callId,
              error: fnMsg.error,
              errorCode: 'FN_ERROR'
            })
          } else {
            worker.postMessage({
              type: 'adf_result',
              callId: fnMsg.callId,
              result: fnMsg.result
            })
          }
          return
        }

        if (msg.type !== 'result') return

        // Only handle results matching our execId to prevent concurrent executions
        // from stealing each other's results
        const resultMsg = msg as ResultMessage
        if (resultMsg.execId && resultMsg.execId !== execId) return

        clearTimeout(timer)
        worker.off('message', handler)
        worker.off('error', errorHandler)

        if (resultMsg.error) {
          resolve({
            stdout: resultMsg.stdout ?? '',
            error: resultMsg.error,
            errorCode: resultMsg.errorCode
          })
        } else {
          resolve({ result: resultMsg.value, stdout: resultMsg.stdout ?? '' })
        }
      }

      const errorHandler = (err: Error): void => {
        clearTimeout(timer)
        worker.off('message', handler)
        worker.off('error', errorHandler)
        this.destroyWorker(agentId)
        resolve({ stdout: '', error: `Worker error: ${err.message}` })
      }

      worker.on('message', handler)
      worker.on('error', errorHandler)

      worker.postMessage({ type: 'execute', code: transformedCode, timeout: effectiveTimeout, execId })
    })

    // Decrement inflight count and destroy if deferred
    const currentEntry = this.workers.get(agentId)
    if (currentEntry) {
      currentEntry.inflight--
      if (currentEntry.pendingDestroy && currentEntry.inflight <= 0) {
        this.destroyWorker(agentId)
      }
    }

    return result
  }

  /**
   * Execute sys_lambda code in the worker's fresh context.
   * Used by SysLambdaTool when sys_lambda is invoked from within sandbox code.
   */
  async executeFnCall(
    agentId: string,
    callId: string,
    code: string,
    args: Record<string, unknown>
  ): Promise<{ result?: string; error?: string; stdout?: string }> {
    const entry = this.workers.get(agentId)
    if (!entry || !entry.worker) {
      return { error: 'No active worker for sys_lambda execution' }
    }

    return new Promise((resolve) => {
      const worker = entry.worker

      const handler = (msg: WorkerMessage): void => {
        if (msg.type === 'fn_result' && (msg as FnResultMessage).callId === callId) {
          worker.off('message', handler)
          const fnMsg = msg as FnResultMessage
          resolve({
            result: fnMsg.result,
            error: fnMsg.error,
            stdout: fnMsg.stdout
          })
        }
      }

      worker.on('message', handler)
      worker.postMessage({ type: 'fn_exec', callId, code, args })
    })
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
   * Terminate all workers. Called on app shutdown or mesh disable.
   */
  destroyAll(): void {
    for (const agentId of this.workers.keys()) {
      this.destroyWorker(agentId)
    }
  }

  private async createWorker(agentId: string): Promise<WorkerEntry> {
    const worker = new Worker(WORKER_SCRIPT, { eval: true })

    const entry: WorkerEntry = { worker, ready: false, inflight: 0, pendingDestroy: false }
    this.workers.set(agentId, entry)

    // Wait for the worker to signal ready
    await new Promise<void>((resolve) => {
      const onMessage = (msg: { type: string }): void => {
        if (msg.type === 'ready') {
          entry.ready = true
          worker.off('message', onMessage)
          resolve()
        }
      }
      worker.on('message', onMessage)
    })

    // Handle unexpected worker exit — remove from map so it gets recreated
    worker.on('exit', () => {
      this.workers.delete(agentId)
    })

    return entry
  }

  private destroyWorker(agentId: string): void {
    const entry = this.workers.get(agentId)
    if (entry) {
      entry.worker.terminate()
      this.workers.delete(agentId)
    }
  }
}
