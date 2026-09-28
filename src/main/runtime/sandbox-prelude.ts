/**
 * PRELUDE — evaluated INSIDE the sandbox vm realm, once per worker, before any
 * agent code. It builds every global agent code can see out of vm-realm values,
 * so no worker-realm (host) object or function is ever reachable from the
 * sandbox by walking `.constructor`, prototypes, thrown errors or promises.
 *
 * The script evaluates to `install(B, config)`. `B` is the only host object the
 * prelude ever holds; it is captured in this closure and never exposed. Every B
 * function returns primitives or values that already went through the host
 * membrane (vm-facing proxies), and throws only membrane-wrapped errors.
 * `install` returns the vm-realm API the host drives executions with.
 *
 * Written as String.raw source: no backticks and no "${" anywhere below.
 */
export const SANDBOX_PRELUDE = String.raw`
(function install(B, config) {
  'use strict';
  var G = globalThis;
  var ObjectDefine = Object.defineProperty;
  var ObjectFreeze = Object.freeze;
  var ObjectKeys = Object.keys;
  var ObjectCreate = Object.create;
  var GetProto = Object.getPrototypeOf;
  var ArrayIsArray = Array.isArray;
  var JSONParse = JSON.parse;
  var JSONStringify = JSON.stringify;
  var StringCtor = String;
  var MapCtor = Map;
  var PromiseCtor = Promise;
  var ErrorCtor = Error;
  var ReflectApply = Reflect.apply;
  var ArrayProtoJoin = Array.prototype.join;
  var ArrayProtoPush = Array.prototype.push;
  var ArrayProtoMap = Array.prototype.map;
  var StringProtoEndsWith = String.prototype.endsWith;
  var StringProtoSlice = String.prototype.slice;
  var PromiseResolve = function (v) { return PromiseCtor.resolve(v); };
  var PromiseThen = Promise.prototype.then;

  function join(arr, sep) { return ReflectApply(ArrayProtoJoin, arr, [sep]); }
  function push(arr, v) { ReflectApply(ArrayProtoPush, arr, [v]); }
  function toStr(v) { try { return StringCtor(v); } catch (e) { return '[unprintable]'; } }

  function defineGlobal(name, value, locked) {
    ObjectDefine(G, name, { value: value, writable: !locked, configurable: !locked, enumerable: false });
  }

  function vmError(message, code, Ctor) {
    var e = new (Ctor || ErrorCtor)(message);
    if (code) e.code = code;
    return e;
  }

  // ---- Stack-trace hook lockdown ------------------------------------------
  // Node formats vm-realm error stacks through globalThis.Error.prepareStackTrace
  // of the error's realm. A user hook there receives CallSite objects, and
  // getThis()/getFunction() on sloppy-mode host frames (npm package code) hand
  // out raw host objects. Pin both the binding and the hook.
  ObjectDefine(ErrorCtor, 'prepareStackTrace', { value: undefined, writable: false, configurable: false });
  defineGlobal('Error', ErrorCtor, true);

  // ---- Per-execution output ---------------------------------------------
  var outputs = new MapCtor();
  function outFor(id) {
    var buf = outputs.get(id);
    if (!buf) { buf = []; outputs.set(id, buf); }
    return buf;
  }
  function fmt(args) {
    var parts = [];
    for (var i = 0; i < args.length; i++) push(parts, toStr(args[i]));
    return join(parts, ' ');
  }
  function makeConsole(id) {
    var buf = outFor(id);
    return {
      log: function () { push(buf, fmt(arguments)); },
      info: function () { push(buf, fmt(arguments)); },
      debug: function () { push(buf, fmt(arguments)); },
      warn: function () { push(buf, '[warn] ' + fmt(arguments)); },
      error: function () { push(buf, '[error] ' + fmt(arguments)); },
      trace: function () { push(buf, '[trace] ' + fmt(arguments)); }
    };
  }
  function stripNl(s) {
    var t = toStr(s);
    if (ReflectApply(StringProtoEndsWith, t, ['\n'])) t = ReflectApply(StringProtoSlice, t, [0, -1]);
    return t;
  }

  // ---- adf.* proxy --------------------------------------------------------
  var pending = new MapCtor();
  function makeAdf(owner) {
    return new Proxy({}, {
      get: function (target, prop) {
        if (typeof prop !== 'string') return undefined;
        return async function () {
          var args = arguments;
          var payload = args.length === 1 ? args[0] : (args.length === 0 ? {} : Array.prototype.slice.call(args));
          // Throws (membrane-wrapped) on fast-fail or unclonable arguments.
          var callId = B.adfCall(owner, prop, payload);
          return new PromiseCtor(function (resolve, reject) {
            pending.set(callId, { resolve: resolve, reject: reject });
          });
        };
      }
    });
  }
  function deliver(callId, error, errorCode, result, raw) {
    var p = pending.get(callId);
    if (!p) return;
    pending.delete(callId);
    if (error !== undefined && error !== null && error !== '') {
      p.reject(vmError(toStr(error), errorCode));
      return;
    }
    var value = result;
    if (!raw && typeof value === 'string') {
      try { value = JSONParse(value); } catch (e) { /* keep as string */ }
    }
    if (value && typeof value === 'object' && value._body_encoding === 'base64' && typeof value.body === 'string') {
      try { value.body = B.bufferFromBase64(value.body); delete value._body_encoding; } catch (e) { /* keep base64 */ }
    }
    p.resolve(value);
  }

  // ---- Timers (host timer, vm callback) -----------------------------------
  var timers = new MapCtor();
  var timerSeq = 0;
  function Timeout(id) { this._id = id; }
  Timeout.prototype.ref = function () { return this; };
  Timeout.prototype.unref = function () { return this; };
  Timeout.prototype.hasRef = function () { return true; };
  Timeout.prototype.refresh = function () { var t = timers.get(this._id); if (t) B.timerStart(this._id, t.ms, t.repeat); return this; };
  Timeout.prototype[Symbol.toPrimitive] = function () { return this._id; };
  ObjectFreeze(Timeout.prototype);
  function startTimer(fn, ms, rest, repeat) {
    if (typeof fn !== 'function') throw vmError('The "callback" argument must be of type function', 'ERR_INVALID_ARG_TYPE', TypeError);
    var id = ++timerSeq;
    var delay = +ms;
    if (!(delay >= 1 && delay <= 2147483647)) delay = 1;
    timers.set(id, { fn: fn, args: rest, ms: delay, repeat: repeat });
    B.timerStart(id, delay, repeat);
    return new Timeout(id);
  }
  function stopTimer(t) {
    if (t === undefined || t === null) return;
    var id = typeof t === 'object' ? t._id : +t;
    if (timers.delete(id)) B.timerStop(id);
  }
  function fireTimer(id) {
    var t = timers.get(id);
    if (!t) return;
    if (!t.repeat) timers.delete(id);
    try { ReflectApply(t.fn, undefined, t.args); } catch (e) { /* an uncaught timer error must not kill the sandbox */ }
  }
  function restArgs(args, from) {
    var out = [];
    for (var i = from; i < args.length; i++) push(out, args[i]);
    return out;
  }

  // ---- Encoding helpers (pure vm) -----------------------------------------
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function btoa(input) {
    var s = toStr(input), out = '', i = 0;
    for (var k = 0; k < s.length; k++) {
      if (s.charCodeAt(k) > 255) throw vmError('Invalid character', 'ERR_INVALID_CHARACTER');
    }
    while (i < s.length) {
      var a = s.charCodeAt(i++), b = s.charCodeAt(i++), c = s.charCodeAt(i++);
      var tri = (a << 16) | ((b || 0) << 8) | (c || 0);
      out += B64.charAt((tri >> 18) & 63) + B64.charAt((tri >> 12) & 63) +
        (isNaN(b) ? '=' : B64.charAt((tri >> 6) & 63)) + (isNaN(c) ? '=' : B64.charAt(tri & 63));
    }
    return out;
  }
  function atob(input) {
    var s = toStr(input).replace(/[\t\n\f\r ]+/g, '');
    if (s.length % 4 === 0) s = s.replace(/==?$/, '');
    if (s.length % 4 === 1 || /[^+/0-9A-Za-z]/.test(s)) throw vmError('The string to be decoded is not correctly encoded.', 'ERR_INVALID_CHARACTER');
    var out = '', buf = 0, bits = 0;
    for (var i = 0; i < s.length; i++) {
      buf = (buf << 6) | B64.indexOf(s.charAt(i));
      bits += 6;
      if (bits >= 8) { bits -= 8; out += StringCtor.fromCharCode((buf >> bits) & 255); }
    }
    return out;
  }

  // ---- structuredClone (vm-side for vm values, host for membrane values) ----
  function cloneValue(v, seen) {
    if (v === null || typeof v !== 'object') {
      if (typeof v === 'function' || typeof v === 'symbol') throw vmError('could not be cloned', 'DataCloneError');
      return v;
    }
    if (B.isHostValue(v)) return B.cloneHost(v);
    if (seen.has(v)) return seen.get(v);
    var out;
    if (ArrayIsArray(v)) {
      out = []; seen.set(v, out);
      for (var i = 0; i < v.length; i++) out[i] = cloneValue(v[i], seen);
      return out;
    }
    if (v instanceof Date) { out = new Date(v.getTime()); seen.set(v, out); return out; }
    if (v instanceof RegExp) { out = new RegExp(v.source, v.flags); seen.set(v, out); return out; }
    if (v instanceof Map) { out = new Map(); seen.set(v, out); v.forEach(function (val, key) { out.set(cloneValue(key, seen), cloneValue(val, seen)); }); return out; }
    if (v instanceof Set) { out = new Set(); seen.set(v, out); v.forEach(function (val) { out.add(cloneValue(val, seen)); }); return out; }
    if (v instanceof ArrayBuffer) { out = v.slice(0); seen.set(v, out); return out; }
    if (ArrayBuffer.isView(v)) {
      if (v instanceof DataView) { out = new DataView(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)); }
      else { out = new v.constructor(v); }
      seen.set(v, out); return out;
    }
    if (v instanceof ErrorCtor) {
      out = new ErrorCtor(v.message); out.name = v.name; if (v.stack) out.stack = v.stack;
      seen.set(v, out); return out;
    }
    out = {}; seen.set(v, out);
    var keys = ObjectKeys(v);
    for (var k = 0; k < keys.length; k++) out[keys[k]] = cloneValue(v[keys[k]], seen);
    return out;
  }
  function structuredClone(v) { return cloneValue(v, new MapCtor()); }

  // ---- process shim -------------------------------------------------------
  function hrtime(prev) {
    var ns = B.hrtimeNs();
    var sec = Number(ns / 1000000000n), nsec = Number(ns % 1000000000n);
    if (prev) {
      sec -= prev[0]; nsec -= prev[1];
      if (nsec < 0) { sec -= 1; nsec += 1e9; }
    }
    return [sec, nsec];
  }
  hrtime.bigint = function () { return B.hrtimeNs(); };
  var versions = JSONParse(config.versions);
  var processShim = {
    env: {},
    version: config.version,
    versions: versions,
    platform: config.platform,
    arch: config.arch,
    argv: [],
    argv0: 'node',
    cwd: function () { return '/'; },
    exit: function () { throw vmError('process.exit() is not allowed in sandbox'); },
    hrtime: hrtime,
    nextTick: function (fn) {
      var rest = restArgs(arguments, 1);
      PromiseResolve().then(function () { ReflectApply(fn, undefined, rest); });
    },
    stdout: { write: function () { return true; } },
    stderr: { write: function () { return true; } }
  };

  // ---- Globals ------------------------------------------------------------
  function requireStub() {
    throw vmError(
      'require is not available in the sandbox — use import (top-level) instead, ' +
      'e.g. import { createHash } from "crypto"', undefined, ReferenceError);
  }
  function __require(mod) { return B.require(toStr(mod)); }

  var noop = function () {};
  defineGlobal('console', { log: noop, warn: noop, error: noop, info: noop, debug: noop, trace: noop });
  defineGlobal('process', processShim);
  defineGlobal('setTimeout', function setTimeout(fn, ms) { return startTimer(fn, ms, restArgs(arguments, 2), false); });
  defineGlobal('setInterval', function setInterval(fn, ms) { return startTimer(fn, ms, restArgs(arguments, 2), true); });
  defineGlobal('clearTimeout', function clearTimeout(t) { stopTimer(t); });
  defineGlobal('clearInterval', function clearInterval(t) { stopTimer(t); });
  defineGlobal('queueMicrotask', function queueMicrotask(fn) {
    if (typeof fn !== 'function') throw vmError('The "callback" argument must be of type function', 'ERR_INVALID_ARG_TYPE', TypeError);
    PromiseResolve().then(function () { fn(); });
  });
  defineGlobal('structuredClone', structuredClone);
  defineGlobal('atob', atob);
  defineGlobal('btoa', btoa);
  // Host classes, reachable only through the membrane (vm-facing proxies).
  // Installed by the host once it has paired intrinsics (see installHostGlobals).
  function installHostGlobals() {
    var hostGlobals = ['Buffer', 'TextEncoder', 'TextDecoder', 'URL', 'URLSearchParams'];
    for (var h = 0; h < hostGlobals.length; h++) defineGlobal(hostGlobals[h], B.hostGlobal(hostGlobals[h]));
  }
  defineGlobal('__require', __require);
  defineGlobal('require', requireStub);
  defineGlobal('__stdlibPath', config.stdlibPath || null);
  var moduleObj = { exports: {} };
  defineGlobal('module', moduleObj);
  defineGlobal('exports', moduleObj.exports);
  // Context-global fallback for code that runs outside an execution (stored
  // closures called later). Executions shadow it with their own proxy.
  defineGlobal('adf', makeAdf('ctx'));

  // Freeze the realm's built-in prototypes so one execution can't pollute the
  // next. These are the vm realm's own copies; host packages are unaffected.
  var ctors = [Object, Array, Function, String, Number, Boolean, RegExp, Date,
    Map, Set, WeakMap, WeakSet, Promise, Error, TypeError, RangeError,
    SyntaxError, URIError, ReferenceError, EvalError,
    ArrayBuffer, SharedArrayBuffer, DataView,
    Uint8Array, Uint16Array, Uint32Array, Uint8ClampedArray,
    Int8Array, Int16Array, Int32Array, Float32Array, Float64Array,
    BigInt64Array, BigUint64Array];
  for (var c = 0; c < ctors.length; c++) if (ctors[c]) ObjectFreeze(ctors[c].prototype);
  ObjectFreeze(GetProto(Uint8Array).prototype);
  ObjectFreeze(GetProto(async function () {}));
  ObjectFreeze(GetProto(function* () {}));
  ObjectFreeze(GetProto(async function* () {}));

  // ---- Intrinsics table (paired by the host with its own realm's) ----------
  function intrinsics() {
    var list = [];
    function add(name, v) { if (v !== undefined && v !== null) push(list, [name, v]); }
    var names = ['Object', 'Function', 'Array', 'Number', 'Boolean', 'String', 'Symbol', 'BigInt',
      'Date', 'RegExp', 'Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError',
      'TypeError', 'URIError', 'AggregateError', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet',
      'WeakRef', 'FinalizationRegistry', 'ArrayBuffer', 'SharedArrayBuffer', 'DataView',
      'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array',
      'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
      'Proxy', 'Reflect', 'JSON', 'Math', 'Atomics', 'Iterator'];
    for (var i = 0; i < names.length; i++) {
      var v = G[names[i]];
      add(names[i], v);
      if (v && typeof v === 'function' && v.prototype) add(names[i] + '.prototype', v.prototype);
    }
    var TA = GetProto(Uint8Array);
    add('TypedArray', TA); add('TypedArray.prototype', TA.prototype);
    var AF = GetProto(async function () {}).constructor;
    var GF = GetProto(function* () {}).constructor;
    var AGF = GetProto(async function* () {}).constructor;
    add('AsyncFunction', AF); add('AsyncFunction.prototype', AF.prototype);
    add('GeneratorFunction', GF); add('GeneratorFunction.prototype', GF.prototype);
    add('Generator.prototype', GF.prototype.prototype);
    add('AsyncGeneratorFunction', AGF); add('AsyncGeneratorFunction.prototype', AGF.prototype);
    add('AsyncGenerator.prototype', AGF.prototype.prototype);
    var ArrIt = GetProto([][Symbol.iterator]());
    add('ArrayIterator.prototype', ArrIt);
    add('Iterator.prototype', GetProto(ArrIt));
    add('AsyncIterator.prototype', GetProto(AGF.prototype.prototype));
    add('MapIterator.prototype', GetProto(new Map()[Symbol.iterator]()));
    add('SetIterator.prototype', GetProto(new Set()[Symbol.iterator]()));
    add('StringIterator.prototype', GetProto(''[Symbol.iterator]()));
    add('RegExpStringIterator.prototype', GetProto(/a/[Symbol.matchAll]('')));
    add('globalThis', G);
    if (typeof WebAssembly === 'object') {
      add('WebAssembly', WebAssembly);
      var wa = ['Module', 'Instance', 'Memory', 'Table', 'Global', 'CompileError', 'LinkError', 'RuntimeError'];
      for (var w = 0; w < wa.length; w++) {
        var wv = WebAssembly[wa[w]];
        add('WebAssembly.' + wa[w], wv);
        if (wv && wv.prototype) add('WebAssembly.' + wa[w] + '.prototype', wv.prototype);
      }
    }
    return list;
  }

  // Shadow targets for the host's vm-facing proxies. They MUST be vm-realm
  // objects: GetFunctionRealm(proxy) resolves through the target, and a host
  // shadow would let 'new' fall back to host-realm prototypes.
  function shadow(kind) {
    if (kind === 'fn') return function () {};
    if (kind === 'arrow') return () => {};
    if (kind === 'arr') return [];
    return {};
  }

  // ---- Execution driver -----------------------------------------------------
  function serialize(value) {
    if (value === undefined) return undefined;
    if (typeof value === 'string') return value;
    try {
      var s = JSONStringify(value, null, 2);
      return s === undefined ? toStr(value) : s;
    } catch (e) {
      return toStr(value);
    }
  }
  function errorInfo(err) {
    var msg, code;
    try { msg = err && err.message !== undefined ? toStr(err.message) : toStr(err); } catch (e) { msg = 'Error'; }
    try { code = err && err.code !== undefined && err.code !== null ? toStr(err.code) : undefined; } catch (e) { code = undefined; }
    return [msg, code];
  }
  function run(id, fn) {
    var buf = outFor(id);
    var con = makeConsole(id);
    processShim.stdout = { write: function (s) { push(buf, stripNl(s)); return true; } };
    processShim.stderr = { write: function (s) { push(buf, '[stderr] ' + stripNl(s)); return true; } };
    var p;
    try {
      p = fn(makeAdf(id), con);
    } catch (e) {
      p = PromiseCtor.reject(e);
    }
    ReflectApply(PromiseThen, PromiseResolve(p), [
      function (v) {
        var s;
        try { s = serialize(v); } catch (e) { s = '[unserializable]'; }
        B.settle(id, true, s, undefined);
      },
      function (e) {
        var info = errorInfo(e);
        B.settle(id, false, info[0], info[1]);
      }
    ]);
  }
  function outSize(id) { var b = outputs.get(id); return b ? b.length : 0; }
  function append(id, line) { push(outFor(id), toStr(line)); }
  function take(id) {
    var b = outputs.get(id);
    outputs.delete(id);
    return b ? join(b, '\n') : '';
  }
  function setStdlibPath(p) {
    ObjectDefine(G, '__stdlibPath', { value: p, writable: true, configurable: true, enumerable: false });
  }

  return {
    run: run, outSize: outSize, append: append, take: take, deliver: deliver,
    fireTimer: fireTimer, setStdlibPath: setStdlibPath, shadow: shadow, intrinsics: intrinsics,
    installHostGlobals: installHostGlobals
  };
})
`
