/**
 * WORKER_SCRIPT — runs as a worker thread inside the sandbox host process
 * (see sandbox-host.ts), which itself runs under Node's permission model.
 * One worker per sandbox id. Agent code runs in a vm realm inside it.
 *
 * Isolation layers, innermost first:
 *   1. vm realm: every sandbox global is built in-realm by the prelude
 *      (sandbox-prelude.ts); codegen from strings is off; no dynamic import.
 *   2. Membrane: host (worker-realm) values — Buffer, URL, TextEncoder, builtin
 *      modules, stdlib and user npm packages — are only ever seen through
 *      proxies whose shadow targets live in the vm realm. Host intrinsics map
 *      to their vm twins (host Function -> vm Function, which cannot compile
 *      strings), so '<anything>.constructor.constructor' never yields a host
 *      Function. vm values going the other way are deep-copied (plain data) or
 *      wrapped, so host code never receives a raw vm function it could hand
 *      host objects to.
 *   3. Worker-realm hardening: the Function-family '.constructor' links are
 *      replaced with inert stand-ins, the global 'require' is removed, network
 *      primitives (net/tls/dgram/dns/http/https/http2, fetch, WebSocket) throw,
 *      fd-level fs I/O is limited to fds this worker opened itself,
 *      process.kill/_linkedBinding are gone and process.env is empty.
 *   4. Process: the host process runs with --permission (no fs writes, fs reads
 *      only of the package directories, no child processes, no native addons,
 *      no WASI, no inspector) and a minimal environment.
 *
 * Written as String.raw source: no backticks and no "${" anywhere below.
 */
export const SANDBOX_WORKER_SCRIPT = String.raw`
'use strict';
// Eval'd workers get a global require. Keep a private handle and remove the
// global (harden() below) so nothing that reaches this realm's globals gets it.
const nodeRequire = require;
const { parentPort, workerData } = nodeRequire('worker_threads');
const vm = nodeRequire('vm');
const { createRequire } = nodeRequire('module');
const nodePath = nodeRequire('path');
const nodeFs = nodeRequire('fs');
const nodeUtil = nodeRequire('util');
const nodeCrypto = nodeRequire('crypto');
const { Buffer: HostBuffer } = nodeRequire('buffer');

const PRELUDE = workerData && workerData.prelude;
const ReflectApply = Reflect.apply;
const ReflectConstruct = Reflect.construct;
const ReflectGet = Reflect.get;
const ReflectSet = Reflect.set;
const ReflectHas = Reflect.has;
const ReflectOwnKeys = Reflect.ownKeys;
const ReflectGetOwnPropertyDescriptor = Reflect.getOwnPropertyDescriptor;
const ReflectDefineProperty = Reflect.defineProperty;
const ReflectDeleteProperty = Reflect.deleteProperty;
const ReflectGetPrototypeOf = Reflect.getPrototypeOf;
const ReflectIsExtensible = Reflect.isExtensible;
const ObjectDefine = Object.defineProperty;
const ObjectHasOwn = Object.prototype.hasOwnProperty;
const ArrayIsArray = Array.isArray;
const isAsyncFunction = nodeUtil.types.isAsyncFunction;
const isProxy = nodeUtil.types.isProxy;
// [realFunctionCtor, standIn] pairs installed by harden().
const STAND_INS = [];

// Allowlisted Node.js built-in modules
const ALLOWED_MODULES = new Set([
  'crypto', 'buffer', 'url', 'querystring', 'path', 'util',
  'string_decoder', 'punycode', 'assert', 'events', 'stream', 'zlib'
]);

// =====================================================================
// Layer 3: worker-realm hardening. Runs before any package code loads.
// =====================================================================
(function harden() {
  // Function-family constructors. Package code keeps the global Function
  // (some libraries compile expressions with it), but no object handed around
  // leads back to it: '.constructor' on every function prototype becomes an
  // inert stand-in that keeps its name and instanceof behaviour.
  const families = [
    Function.prototype,
    Object.getPrototypeOf(async function () {}),
    Object.getPrototypeOf(function* () {}),
    Object.getPrototypeOf(async function* () {})
  ];
  for (const proto of families) {
    const real = proto.constructor;
    const name = real.name;
    const standIn = function () {
      throw new EvalError('Code generation from strings is disabled in the sandbox');
    };
    ObjectDefine(standIn, 'name', { value: name });
    ObjectDefine(standIn, 'prototype', { value: proto });
    // An accessor, not a read-only data property: libraries assign
    // 'fn.constructor = X' on their own functions, and an inherited read-only
    // property would make that throw (the "override mistake"). The setter gives
    // the receiver its own property; the prototype's link stays the stand-in.
    ObjectDefine(proto, 'constructor', {
      get: function () { return standIn; },
      set: function (v) {
        if (this === proto || this === null || this === undefined) return;
        ObjectDefine(this, 'constructor', { value: v, writable: true, configurable: true, enumerable: true });
      },
      configurable: false,
      enumerable: false
    });
    STAND_INS.push([real, standIn]);
  }

  delete globalThis.require;
  for (const k of ['fetch', 'Request', 'Response', 'Headers', 'WebSocket', 'EventSource']) {
    try { delete globalThis[k]; } catch (e) { /* ignore */ }
  }

  function deny(what) {
    return function () {
      const err = new Error(what + ' is not available in the sandbox — use adf.sys_fetch({url}) for network access');
      err.code = 'ERR_SANDBOX_NETWORK';
      throw err;
    };
  }
  function lock(obj, key, value) {
    try { ObjectDefine(obj, key, { value: value, writable: false, configurable: false, enumerable: false }); } catch (e) { /* ignore */ }
  }
  function lockAll(obj, keys, label) {
    if (!obj) return;
    for (const k of keys) if (k in obj) lock(obj, k, deny(label + '.' + k));
  }
  const net = nodeRequire('net');
  lockAll(net, ['connect', 'createConnection', 'createServer'], 'net');
  lockAll(net.Socket.prototype, ['connect', 'write', '_write', '_writev', '_writeGeneric', '_read', 'end'], 'net.Socket');
  lockAll(net.Server.prototype, ['listen'], 'net.Server');
  const tls = nodeRequire('tls');
  lockAll(tls, ['connect', 'createServer', 'createSecurePair'], 'tls');
  const dgram = nodeRequire('dgram');
  lockAll(dgram, ['createSocket'], 'dgram');
  lockAll(dgram.Socket.prototype, ['bind', 'send', 'connect'], 'dgram.Socket');
  const dns = nodeRequire('dns');
  const dnsFns = ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa',
    'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv',
    'resolveTxt', 'reverse'];
  lockAll(dns, dnsFns, 'dns');
  lockAll(dns.Resolver && dns.Resolver.prototype, dnsFns, 'dns.Resolver');
  lockAll(dns.promises, dnsFns, 'dns.promises');
  lockAll(dns.promises && dns.promises.Resolver && dns.promises.Resolver.prototype, dnsFns, 'dns.promises.Resolver');
  for (const m of ['http', 'https']) {
    const mod = nodeRequire(m);
    lockAll(mod, ['request', 'get', 'createServer'], m);
  }
  lockAll(nodeRequire('http2'), ['connect', 'createServer', 'createSecureServer'], 'http2');

  // fd-level fs I/O bypasses the permission model, and the host's IPC pipe is
  // an fd in this process. Only fds this worker opened itself are usable.
  const ownFds = new Set();
  function guardFd(name) {
    const orig = nodeFs[name];
    if (typeof orig !== 'function') return;
    lock(nodeFs, name, function (fd) {
      if (!ownFds.has(fd)) {
        const err = new Error('EBADF: file descriptor ' + fd + ' is not available in the sandbox');
        err.code = 'EBADF';
        throw err;
      }
      return ReflectApply(orig, this, arguments);
    });
  }
  const openSync = nodeFs.openSync;
  const open = nodeFs.open;
  const closeSync = nodeFs.closeSync;
  const close = nodeFs.close;
  lock(nodeFs, 'openSync', function () {
    const fd = ReflectApply(openSync, this, arguments);
    ownFds.add(fd);
    return fd;
  });
  lock(nodeFs, 'open', function () {
    const args = Array.prototype.slice.call(arguments);
    const cb = args[args.length - 1];
    if (typeof cb === 'function') {
      args[args.length - 1] = function (err, fd) { if (!err) ownFds.add(fd); return cb(err, fd); };
    }
    return ReflectApply(open, this, args);
  });
  for (const name of ['read', 'readSync', 'readv', 'readvSync', 'write', 'writeSync', 'writev', 'writevSync',
    'fsync', 'fsyncSync', 'fdatasync', 'fdatasyncSync', 'ftruncate', 'ftruncateSync', 'fstat', 'fstatSync',
    'fchmod', 'fchmodSync', 'fchown', 'fchownSync', 'futimes', 'futimesSync']) guardFd(name);
  lock(nodeFs, 'closeSync', function (fd) {
    if (!ownFds.has(fd)) { const e = new Error('EBADF: bad file descriptor'); e.code = 'EBADF'; throw e; }
    ownFds.delete(fd);
    return ReflectApply(closeSync, this, arguments);
  });
  lock(nodeFs, 'close', function (fd, cb) {
    if (!ownFds.has(fd)) { const e = new Error('EBADF: bad file descriptor'); e.code = 'EBADF'; if (typeof cb === 'function') return cb(e); throw e; }
    ownFds.delete(fd);
    return ReflectApply(close, this, arguments);
  });

  for (const k of ['kill', '_linkedBinding', 'dlopen', 'binding', 'reallyExit', 'abort', 'chdir', 'setuid', 'setgid',
    'seteuid', 'setegid', 'setgroups', 'initgroups']) {
    try { lock(process, k, function () { throw new Error('process.' + k + ' is not available in the sandbox'); }); } catch (e) { /* ignore */ }
  }
})();

// =====================================================================
// vm realm + prelude
// =====================================================================
const context = vm.createContext(vm.constants.DONT_CONTEXTIFY, {
  name: 'adf-sandbox',
  codeGeneration: { strings: false, wasm: true }
});
const installPrelude = new vm.Script(PRELUDE, { filename: 'adf-sandbox-prelude.js' }).runInContext(context);

// =====================================================================
// Layer 2: the membrane
// =====================================================================
const intrH2V = new Map(); // host intrinsic -> vm intrinsic
const intrV2H = new Map(); // vm intrinsic -> host intrinsic
const vmProxyOf = new WeakMap(); // host object -> vm-facing proxy
const vmProxyTarget = new WeakMap(); // vm-facing proxy -> host object
const hostViewOf = new WeakMap(); // vm object -> host-facing view
const hostViewTarget = new WeakMap(); // host-facing view -> vm object
let vmApi = null; // filled after install

function isPrimitive(x) {
  return x === null || (typeof x !== 'object' && typeof x !== 'function');
}

// host -> vm
function toVm(h) {
  if (isPrimitive(h)) return h;
  let v = intrH2V.get(h);
  if (v !== undefined) return v;
  v = hostViewTarget.get(h);
  if (v !== undefined) return v;
  v = vmProxyOf.get(h);
  if (v !== undefined) return v;
  // A vm value on its way back (e.g. an error a vm getter threw while its
  // owner was being copied host-side) stays as it is.
  if (isVmRealm(h)) return h;
  return makeVmProxy(h);
}

let vmObjectProto = null;
function isVmRealm(x) {
  if (vmObjectProto === null) return false;
  try {
    let p = x;
    for (let i = 0; i < 64 && p !== null; i++) {
      p = ReflectGetPrototypeOf(p);
      if (p === vmObjectProto) return true;
      if (vmProxyTarget.has(p)) return true;
    }
  } catch (e) { /* revoked proxy etc. */ }
  return false;
}

// vm -> host
function toHost(v, seen) {
  if (isPrimitive(v)) return v;
  let h = vmProxyTarget.get(v);
  if (h !== undefined) return h;
  h = intrV2H.get(v);
  if (h !== undefined) return h;
  h = hostViewOf.get(v);
  if (h !== undefined) return h;
  if (typeof v === 'function') return makeHostFn(v);
  return copyToHost(v, seen || new Map());
}

function throwToVm(e) {
  throw toVm(e);
}

// Plain vm data is deep-copied into the host realm so package code sees its
// own Array/Object/Uint8Array (instanceof checks inside packages keep working).
// Anything else — class instances, promises, errors — becomes a host view.
function copyToHost(v, seen) {
  const prior = seen.get(v);
  if (prior !== undefined) return prior;
  const proto = ReflectGetPrototypeOf(v);
  const pname = proto === null ? 'null' : vmProtoName.get(proto);
  let out;
  if (ArrayIsArray(v) && (pname === 'Array.prototype' || isProxy(v))) {
    out = [];
    seen.set(v, out);
    const n = v.length;
    for (let i = 0; i < n; i++) out[i] = toHost(v[i], seen);
    return out;
  }
  if (pname === 'Object.prototype' || pname === 'null') {
    out = pname === 'null' ? Object.create(null) : {};
    seen.set(v, out);
    const keys = Object.keys(v);
    for (let i = 0; i < keys.length; i++) out[keys[i]] = toHost(v[keys[i]], seen);
    return out;
  }
  if (pname === 'ArrayBuffer.prototype') {
    out = new Uint8Array(new Uint8Array(v)).buffer;
    seen.set(v, out);
    return out;
  }
  if (pname && TYPED_ARRAYS.has(pname)) {
    const Ctor = globalThis[TYPED_ARRAYS.get(pname)];
    out = new Ctor(v);
    seen.set(v, out);
    return out;
  }
  if (pname === 'DataView.prototype') {
    const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    out = new DataView(new Uint8Array(bytes).buffer);
    seen.set(v, out);
    return out;
  }
  if (pname === 'Date.prototype') {
    out = new Date(ReflectApply(Date.prototype.getTime, v, []));
    seen.set(v, out);
    return out;
  }
  if (pname === 'RegExp.prototype') {
    out = new RegExp(ReflectApply(Object.getOwnPropertyDescriptor(RegExp.prototype, 'source').get, v, []),
      ReflectApply(Object.getOwnPropertyDescriptor(RegExp.prototype, 'flags').get, v, []));
    seen.set(v, out);
    return out;
  }
  if (pname === 'Map.prototype') {
    out = new Map();
    seen.set(v, out);
    ReflectApply(Map.prototype.forEach, v, [function (val, key) { out.set(toHost(key, seen), toHost(val, seen)); }]);
    return out;
  }
  if (pname === 'Set.prototype') {
    out = new Set();
    seen.set(v, out);
    ReflectApply(Set.prototype.forEach, v, [function (val) { out.add(toHost(val, seen)); }]);
    return out;
  }
  return makeHostView(v);
}

const TYPED_ARRAYS = new Map([
  ['Int8Array.prototype', 'Int8Array'], ['Uint8Array.prototype', 'Uint8Array'],
  ['Uint8ClampedArray.prototype', 'Uint8ClampedArray'], ['Int16Array.prototype', 'Int16Array'],
  ['Uint16Array.prototype', 'Uint16Array'], ['Int32Array.prototype', 'Int32Array'],
  ['Uint32Array.prototype', 'Uint32Array'], ['Float32Array.prototype', 'Float32Array'],
  ['Float64Array.prototype', 'Float64Array'], ['BigInt64Array.prototype', 'BigInt64Array'],
  ['BigUint64Array.prototype', 'BigUint64Array']
]);
const vmProtoName = new Map(); // vm intrinsic -> name

// A real host function standing in for a vm function (not a proxy, so
// util.types.isAsyncFunction and friends still classify it correctly).
function makeHostFn(vf) {
  let w;
  if (isAsyncFunction(vf)) {
    w = async function () { return callVm(vf, this, arguments); };
  } else {
    w = function () {
      if (new.target !== undefined) {
        try {
          return toHost(ReflectConstruct(vf, mapArgs(arguments, toVm), toVm(new.target)));
        } catch (e) { throw toHost(e); }
      }
      return callVm(vf, this, arguments);
    };
  }
  try {
    const n = vf.name;
    if (typeof n === 'string') ObjectDefine(w, 'name', { value: n });
  } catch (e) { /* ignore */ }
  try {
    const l = vf.length;
    if (typeof l === 'number') ObjectDefine(w, 'length', { value: l });
  } catch (e) { /* ignore */ }
  hostViewOf.set(vf, w);
  hostViewTarget.set(w, vf);
  // 'new' through the wrapper (a vm class extending a host class reaches the
  // host constructor with the wrapper as new.target) must give instances the
  // vm class's prototype — as a view, never a copy.
  try {
    const d = ReflectGetOwnPropertyDescriptor(vf, 'prototype');
    if (d && 'value' in d && d.value !== null && typeof d.value === 'object') {
      const vp = d.value;
      const hp = vmProxyTarget.get(vp) || intrV2H.get(vp) || hostViewOf.get(vp) || makeHostView(vp);
      w.prototype = hp;
    }
  } catch (e) { /* ignore */ }
  return w;
}

function callVm(vf, self, args) {
  try {
    return toHost(ReflectApply(vf, toVm(self), mapArgs(args, toVm)));
  } catch (e) {
    throw toHost(e);
  }
}

function mapArgs(args, fn) {
  const out = [];
  for (let i = 0; i < args.length; i++) out.push(fn(args[i]));
  return out;
}

// Generic proxy handler over a real target living on the other side.
//   into:  converts values arriving from the proxy's user side to the target side
//   outof: converts target-side values to the user side
//   fail:  converts a thrown target-side value for the user side
function membraneHandler(real, into, outof) {
  function guard(fn) {
    try { return fn(); } catch (e) { throw outof(e); }
  }
  return {
    get(shadow, key) {
      return guard(() => outof(ReflectGet(real, key)));
    },
    set(shadow, key, value) {
      return guard(() => ReflectSet(real, key, into(value)));
    },
    has(shadow, key) {
      return guard(() => ReflectHas(real, key));
    },
    deleteProperty(shadow, key) {
      return guard(() => ReflectDeleteProperty(real, key));
    },
    ownKeys(shadow) {
      return guard(() => {
        const keys = ReflectOwnKeys(real);
        // Keep proxy invariants: non-configurable shadow keys must be listed.
        const sk = ReflectOwnKeys(shadow);
        for (let i = 0; i < sk.length; i++) {
          const d = ReflectGetOwnPropertyDescriptor(shadow, sk[i]);
          if (d && !d.configurable && keys.indexOf(sk[i]) < 0) keys.push(sk[i]);
        }
        return keys;
      });
    },
    getOwnPropertyDescriptor(shadow, key) {
      return guard(() => {
        const d = ReflectGetOwnPropertyDescriptor(real, key);
        if (!d) {
          const sd = ReflectGetOwnPropertyDescriptor(shadow, key);
          if (sd && !sd.configurable) return sd;
          return undefined;
        }
        const out = { configurable: d.configurable, enumerable: d.enumerable };
        if ('value' in d) { out.value = outof(d.value); out.writable = d.writable; }
        else { out.get = outof(d.get); out.set = outof(d.set); }
        if (!d.configurable) {
          // Mirror onto the shadow so the non-configurable report is legal.
          ReflectDefineProperty(shadow, key, out);
        }
        return out;
      });
    },
    defineProperty(shadow, key, desc) {
      return guard(() => {
        const d = {};
        if ('configurable' in desc) d.configurable = desc.configurable;
        if ('enumerable' in desc) d.enumerable = desc.enumerable;
        if ('writable' in desc) d.writable = desc.writable;
        if ('value' in desc) d.value = into(desc.value);
        if ('get' in desc) d.get = into(desc.get);
        if ('set' in desc) d.set = into(desc.set);
        const ok = ReflectDefineProperty(real, key, d);
        if (ok && desc.configurable === false) ReflectDefineProperty(shadow, key, desc);
        return ok;
      });
    },
    getPrototypeOf(shadow) {
      return guard(() => outof(ReflectGetPrototypeOf(real)));
    },
    setPrototypeOf() {
      return false;
    },
    isExtensible(shadow) {
      return ReflectIsExtensible(shadow);
    },
    preventExtensions() {
      return false;
    },
    apply(shadow, self, args) {
      return guard(() => outof(ReflectApply(real, into(self), mapArgs(args, into))));
    },
    construct(shadow, args, newTarget) {
      return guard(() => {
        const nt = newTarget === undefined ? real : into(newTarget);
        return outof(ReflectConstruct(real, mapArgs(args, into), nt));
      });
    }
  };
}

function shadowKind(x) {
  if (typeof x === 'function') {
    return ReflectGetOwnPropertyDescriptor(x, 'prototype') ? 'fn' : 'arrow';
  }
  try { if (ArrayIsArray(x)) return 'arr'; } catch (e) { /* revoked proxy */ }
  return 'obj';
}

function makeVmProxy(h) {
  const shadow = vmApi.shadow(shadowKind(h));
  const p = new Proxy(shadow, membraneHandler(h, toHost, toVm));
  vmProxyOf.set(h, p);
  vmProxyTarget.set(p, h);
  return p;
}

function makeHostView(v) {
  const kind = shadowKind(v);
  const shadow = kind === 'fn' ? function () {} : kind === 'arrow' ? () => {} : kind === 'arr' ? [] : {};
  const p = new Proxy(shadow, membraneHandler(v, toVm, toHost));
  hostViewOf.set(v, p);
  hostViewTarget.set(p, v);
  return p;
}

// =====================================================================
// Standard library / user packages (host realm, under --permission)
// =====================================================================
let stdlibBasePath = null;
let stdlibModuleSet = new Set();
let userPkgBasePath = null;
let userPkgModuleSet = new Set();

// Auto-initialize WASM packages that export an initWasm() function.
const _wasmInitialized = new Set();
function autoInitWasm(mod, localRequire, modName) {
  if (!mod || typeof mod.initWasm !== 'function') return mod;
  if (_wasmInitialized.has(modName)) return mod;
  let pkgDir = null;
  try {
    const entryPath = localRequire.resolve(modName);
    let dir = nodePath.dirname(entryPath);
    for (let depth = 0; depth < 5; depth++) {
      if (nodeFs.existsSync(nodePath.join(dir, 'package.json'))) {
        try {
          const pj = JSON.parse(nodeFs.readFileSync(nodePath.join(dir, 'package.json'), 'utf-8'));
          if (pj.name === modName) { pkgDir = dir; break; }
        } catch (e) { /* ignore parse errors */ }
      }
      const parent = nodePath.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch (e) {
    return mod;
  }
  if (!pkgDir) return mod;
  let wasmFiles = [];
  try {
    wasmFiles = nodeFs.readdirSync(pkgDir).filter(function (f) { return f.endsWith('.wasm'); });
  } catch (e) { /* ignore */ }
  if (wasmFiles.length === 0) return mod;
  const wasmBuf = nodeFs.readFileSync(nodePath.join(pkgDir, wasmFiles[0]));
  _wasmInitialized.add(modName);
  const result = mod.initWasm(wasmBuf);
  if (result && typeof result.then === 'function') {
    return result.then(function () { return mod; });
  }
  return mod;
}

function loadPackage(localRequire, mod, init) {
  try {
    return init(localRequire(mod));
  } catch (err) {
    if (err && (err.code === 'ERR_REQUIRE_ESM' || err.code === 'ERR_REQUIRE_ASYNC_MODULE')) {
      const resolved = localRequire.resolve(mod);
      return import(nodeRequire('url').pathToFileURL(resolved).href).then(function (ns) {
        return init(ns.default != null ? ns.default : ns);
      });
    }
    throw err;
  }
}

// Returns the module (host value; the caller wraps it) or a Promise of it.
function requireModule(mod) {
  if (ALLOWED_MODULES.has(mod)) return nodeRequire(mod);
  if (stdlibBasePath && stdlibModuleSet.has(mod)) {
    const safeName = mod.replace(/[/@]/g, '_');
    const localRequire = createRequire(nodePath.join(stdlibBasePath, safeName, 'package.json'));
    return loadPackage(localRequire, mod, function (m) { return m; });
  }
  if (userPkgBasePath && userPkgModuleSet.has(mod)) {
    const localRequire = createRequire(nodePath.join(userPkgBasePath, 'package.json'));
    return loadPackage(localRequire, mod, function (m) { return autoInitWasm(m, localRequire, mod); });
  }
  if (!stdlibBasePath && stdlibModuleSet.size === 0) {
    throw new Error('Module "' + mod + '" is not available. Standard library is still installing — try again shortly.');
  }
  const all = [...Array.from(ALLOWED_MODULES), ...Array.from(stdlibModuleSet), ...Array.from(userPkgModuleSet)].sort();
  const hostModules = {
    fs: 'workspace files live in the VFS — use adf.fs_read({path}) / adf.fs_write({path, content}) / adf.fs_list({prefix})',
    'fs/promises': 'workspace files live in the VFS — use adf.fs_read({path}) / adf.fs_write({path, content}) / adf.fs_list({prefix})',
    child_process: 'no host processes from the sandbox — use compute_exec for a real OS, or adf_shell for the VFS',
    os: 'no host OS access from the sandbox',
    net: 'use adf.sys_fetch({url}) for HTTP',
    http: 'use adf.sys_fetch({url}) for HTTP',
    https: 'use adf.sys_fetch({url}) for HTTP'
  };
  const hint = hostModules[mod];
  throw new Error(
    'Module "' + mod + '" is not available in the sandbox.' +
    (hint ? ' ' + hint + '.' : '') +
    ' Available modules: ' + all.join(', ')
  );
}

// =====================================================================
// Tool config, RPC bookkeeping, drain
// =====================================================================
let defaultToolConfig = { enabledTools: [], hilTools: [], isAuthorized: false };
const execToolConfigs = new Map();
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

// callId -> owner. RPC ids are '<token>:<owner>:<n>' so two workers serving
// the same agent can never mint the same id.
const pendingCalls = new Map();
let callIdCounter = 0;
const workerToken = nodeCrypto.randomUUID();
function countPendingFor(owner) {
  let n = 0;
  for (const o of pendingCalls.values()) if (o === owner) n++;
  return n;
}

const DRAIN_QUIET_MS = 80;
const DRAIN_TICK_MS = 5;
const DRAIN_FLOOR_MS = 2000;
const DRAIN_BUDGET_FRACTION = 0.5;
async function drainPendingWork(execId, deadline, timeoutMs) {
  const budget = Math.max(DRAIN_FLOOR_MS, Math.floor((timeoutMs || 0) * DRAIN_BUDGET_FRACTION));
  const stop = Math.min(deadline, Date.now() + budget);
  let lastSize = vmApi.outSize(execId);
  let quietSince = Date.now();
  while (Date.now() < stop) {
    await new Promise(function (r) { setImmediate(r); });
    await new Promise(function (r) { setTimeout(r, DRAIN_TICK_MS); });
    const size = vmApi.outSize(execId);
    if (size !== lastSize || countPendingFor(execId) > 0) {
      lastSize = size;
      quietSince = Date.now();
      continue;
    }
    if (Date.now() - quietSince >= DRAIN_QUIET_MS) return;
  }
  const stuck = countPendingFor(execId);
  if (stuck > 0) {
    vmApi.append(execId,
      '[adf] output truncated: ' + stuck + ' unawaited adf call(s) had not answered after ' +
      budget + 'ms of draining — anything they log after this point is lost');
  }
}

// =====================================================================
// Bridge handed to the prelude. Every entry point converts its result with
// toVm and rethrows failures through toVm — nothing raw crosses.
// =====================================================================
const hostTimers = new Map();
const settleWaiters = new Map();

function bridged(fn) {
  return function () {
    try { return fn.apply(null, arguments); } catch (e) { throwToVm(e); }
  };
}

const B = {
  require: bridged(function (mod) {
    return toVm(requireModule(String(mod)));
  }),
  adfCall: bridged(function (owner, method, payload) {
    owner = String(owner);
    method = String(method);
    const cfg = toolConfigFor(owner);
    if (method !== 'model_invoke' && method !== 'sys_lambda') {
      if (cfg.enabledTools.length > 0 && !cfg.enabledTools.includes(method)) {
        const err = new Error('Tool "' + method + '" is not available');
        err.code = 'NOT_FOUND';
        throw err;
      }
      if (cfg.hilTools.includes(method) && !cfg.isAuthorized) {
        const err = new Error('"' + method + '" can only be called from authorized code. Ask the owner to authorize the source file.');
        err.code = 'REQUIRES_AUTHORIZED_CODE';
        throw err;
      }
    }
    const args = toHost(payload);
    const callId = workerToken + ':' + owner + ':' + (++callIdCounter);
    parentPort.postMessage({ type: 'adf_call', callId: callId, execId: owner, method: method, args: args });
    pendingCalls.set(callId, owner);
    return callId;
  }),
  bufferFromBase64: bridged(function (s) {
    return toVm(HostBuffer.from(String(s), 'base64'));
  }),
  timerStart: bridged(function (id, ms, repeat) {
    const prev = hostTimers.get(id);
    if (prev) clearTimeout(prev);
    const fire = function () {
      if (!repeat) hostTimers.delete(id);
      try { vmApi.fireTimer(id); } catch (e) { /* swallowed in the prelude already */ }
    };
    hostTimers.set(id, repeat ? setInterval(fire, ms) : setTimeout(fire, ms));
  }),
  timerStop: bridged(function (id) {
    const t = hostTimers.get(id);
    if (t) { clearTimeout(t); hostTimers.delete(id); }
  }),
  hrtimeNs: bridged(function () { return process.hrtime.bigint(); }),
  isHostValue: function (v) { return vmProxyTarget.has(v); },
  cloneHost: bridged(function (v) { return toVm(structuredClone(vmProxyTarget.get(v))); }),
  hostGlobal: bridged(function (name) {
    switch (String(name)) {
      case 'Buffer': return toVm(HostBuffer);
      case 'TextEncoder': return toVm(TextEncoder);
      case 'TextDecoder': return toVm(TextDecoder);
      case 'URL': return toVm(URL);
      case 'URLSearchParams': return toVm(URLSearchParams);
      default: return undefined;
    }
  }),
  settle: function (id, ok, a, b) {
    const w = settleWaiters.get(String(id));
    if (!w) return;
    settleWaiters.delete(String(id));
    w({
      ok: !!ok,
      value: typeof a === 'string' ? a : undefined,
      code: typeof b === 'string' ? b : undefined
    });
  }
};

vmApi = installPrelude(B, {
  versions: JSON.stringify(process.versions),
  version: process.version,
  platform: process.platform,
  arch: process.arch,
  stdlibPath: null
});
(function pairIntrinsics() {
  const hostList = (function () {
    const G = globalThis;
    const out = new Map();
    const add = function (name, v) { if (v !== undefined && v !== null) out.set(name, v); };
    const names = ['Object', 'Function', 'Array', 'Number', 'Boolean', 'String', 'Symbol', 'BigInt',
      'Date', 'RegExp', 'Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError',
      'TypeError', 'URIError', 'AggregateError', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet',
      'WeakRef', 'FinalizationRegistry', 'ArrayBuffer', 'SharedArrayBuffer', 'DataView',
      'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array',
      'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
      'Proxy', 'Reflect', 'JSON', 'Math', 'Atomics', 'Iterator'];
    for (const n of names) {
      const v = G[n];
      add(n, v);
      if (v && typeof v === 'function' && v.prototype) add(n + '.prototype', v.prototype);
    }
    const TA = Object.getPrototypeOf(Uint8Array);
    add('TypedArray', TA); add('TypedArray.prototype', TA.prototype);
    const AFp = Object.getPrototypeOf(async function () {});
    const GFp = Object.getPrototypeOf(function* () {});
    const AGFp = Object.getPrototypeOf(async function* () {});
    // '.constructor' on these is a stand-in now; recover the real ones.
    const real = new Map();
    for (const pair of STAND_INS) real.set(pair[1].prototype, pair[0]);
    add('AsyncFunction', real.get(AFp)); add('AsyncFunction.prototype', AFp);
    add('GeneratorFunction', real.get(GFp)); add('GeneratorFunction.prototype', GFp);
    add('Generator.prototype', GFp.prototype);
    add('AsyncGeneratorFunction', real.get(AGFp)); add('AsyncGeneratorFunction.prototype', AGFp);
    add('AsyncGenerator.prototype', AGFp.prototype);
    const ArrIt = Object.getPrototypeOf([][Symbol.iterator]());
    add('ArrayIterator.prototype', ArrIt);
    add('Iterator.prototype', Object.getPrototypeOf(ArrIt));
    add('AsyncIterator.prototype', Object.getPrototypeOf(AGFp.prototype));
    add('MapIterator.prototype', Object.getPrototypeOf(new Map()[Symbol.iterator]()));
    add('SetIterator.prototype', Object.getPrototypeOf(new Set()[Symbol.iterator]()));
    add('StringIterator.prototype', Object.getPrototypeOf(''[Symbol.iterator]()));
    add('RegExpStringIterator.prototype', Object.getPrototypeOf(/a/[Symbol.matchAll]('')));
    add('globalThis', G);
    if (typeof WebAssembly === 'object') {
      add('WebAssembly', WebAssembly);
      for (const w of ['Module', 'Instance', 'Memory', 'Table', 'Global', 'CompileError', 'LinkError', 'RuntimeError']) {
        const wv = WebAssembly[w];
        add('WebAssembly.' + w, wv);
        if (wv && wv.prototype) add('WebAssembly.' + w + '.prototype', wv.prototype);
      }
    }
    return out;
  })();
  const vmList = vmApi.intrinsics();
  for (let i = 0; i < vmList.length; i++) {
    const name = vmList[i][0];
    const vmValue = vmList[i][1];
    vmProtoName.set(vmValue, name);
    const hostValue = hostList.get(name);
    if (hostValue === undefined) continue;
    intrH2V.set(hostValue, vmValue);
    intrV2H.set(vmValue, hostValue);
  }
  vmObjectProto = vmList.find(function (e) { return e[0] === 'Object.prototype'; })[1];
  // Host stand-ins map to the vm realm's (codegen-disabled) constructors.
  for (const pair of STAND_INS) {
    const vmCtor = intrH2V.get(pair[0]);
    if (vmCtor !== undefined) intrH2V.set(pair[1], vmCtor);
  }
})();
// Only now can host values be wrapped: define the membrane-backed globals.
vmApi.installHostGlobals();

// =====================================================================
// Message loop
// =====================================================================
parentPort.on('message', async (msg) => {
  if (msg.type === 'setup') {
    if (msg.toolConfig) defaultToolConfig = msg.toolConfig;
    if (msg.stdlibBasePath) {
      stdlibBasePath = msg.stdlibBasePath;
      stdlibModuleSet = new Set(msg.stdlibModules || []);
      vmApi.setStdlibPath(stdlibBasePath);
    }
    if (msg.userPkgBasePath !== undefined) {
      userPkgBasePath = msg.userPkgBasePath;
      userPkgModuleSet = new Set(msg.userPkgModules || []);
    }
    return;
  }

  if (msg.type === 'adf_result') {
    if (!pendingCalls.has(msg.callId)) return;
    pendingCalls.delete(msg.callId);
    try {
      vmApi.deliver(
        msg.callId,
        msg.error ? String(msg.error) : undefined,
        msg.errorCode ? String(msg.errorCode) : undefined,
        typeof msg.result === 'string' || msg.result === undefined ? msg.result : toVm(msg.result),
        !!msg.raw
      );
    } catch (e) { /* the prelude never throws here; belt and braces */ }
    return;
  }

  if (msg.type !== 'execute') return;

  const localExecId = String(msg.execId || ('w_' + (++callIdCounter)));
  setExecToolConfig(localExecId, msg.toolConfig);
  const timeoutMs = msg.timeout || 10000;
  const deadline = Date.now() + timeoutMs;
  let timeoutHandle;

  const post = function (outcome) {
    const stdout = vmApi.take(localExecId);
    if (outcome.error !== undefined) {
      parentPort.postMessage({ type: 'result', execId: localExecId, error: outcome.error, errorCode: outcome.errorCode, stdout: stdout });
    } else {
      parentPort.postMessage({ type: 'result', execId: localExecId, value: outcome.value, stdout: stdout });
    }
  };

  let fn;
  try {
    // Auto-result: a single expression is evaluated as one (REPL semantics).
    let isExpression = false;
    try {
      new vm.Script('async () => (\n' + msg.code + '\n)');
      isExpression = true;
    } catch (e) { /* statements */ }
    const body = isExpression ? 'return (\n' + msg.code + '\n);' : msg.code;
    fn = new vm.Script('(async function (adf, console) { ' + body + '\n})', { filename: 'agent-code.js' })
      .runInContext(context);
  } catch (err) {
    post({ error: (err && err.message) || String(err), errorCode: (err && err.code) || undefined });
    return;
  }

  const settled = new Promise(function (resolve) { settleWaiters.set(localExecId, resolve); });
  try {
    vmApi.run(localExecId, fn);
  } catch (e) {
    settleWaiters.delete(localExecId);
    post({ error: 'Sandbox failed to start the execution', errorCode: 'INTERNAL_ERROR' });
    return;
  }

  const timeoutPromise = new Promise(function (resolve) {
    timeoutHandle = setTimeout(function () {
      resolve({ ok: false, value: 'Execution timed out after ' + timeoutMs + 'ms', code: 'TIMEOUT' });
    }, timeoutMs);
  });

  const outcome = await Promise.race([settled, timeoutPromise]);
  clearTimeout(timeoutHandle);
  settleWaiters.delete(localExecId);

  if (outcome.ok) {
    // Unawaited .then chains, short timers and in-flight adf.* calls may still
    // produce output. Drain before snapshotting.
    await drainPendingWork(localExecId, deadline, timeoutMs);
    post({ value: outcome.value });
    return;
  }
  // Non-timeout failures still drain briefly so output logged before the
  // error is kept. On TIMEOUT, snapshot immediately.
  if (outcome.code !== 'TIMEOUT') {
    try { await drainPendingWork(localExecId, Math.min(deadline, Date.now() + 500), 1000); } catch (e) { /* best effort */ }
  }
  post({ error: outcome.value === undefined ? 'Error' : outcome.value, errorCode: outcome.code });
});

// Unawaited adf.* rejections must not kill the worker.
process.on('unhandledRejection', function () {});

parentPort.postMessage({ type: 'ready' });
`
