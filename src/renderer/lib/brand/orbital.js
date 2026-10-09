/*
 * VENDORED from adf-org/brand/orbital.js. Do not edit here.
 * Regenerate: node scripts/check-brand-tokens.mjs --write
 * Check:      node scripts/check-brand-tokens.mjs  (ADF_ORG_DIR overrides the sibling ../adf-org)
 * After a re-vendor, bump ORBITAL_RENDER_REV (src/shared/utils/orbital-cache-key.ts).
 * ---- vendored content below; do not edit ---- */
// @ts-check
/**
 * ADF orbitals: per-agent creatures and ava, the canonical one.
 * Standalone, dependency-free ES module (browser or Electron renderer).
 *
 * Ported from src/components/home/orbital.ts (agentdocumentformat.org). The math
 * is identical: same hash, same PRNG, same hydrogen orbitals, same sampling,
 * same contour and colours, so a seed draws the same shape here as on the site.
 * Keep the two in sync; do not change one without the other.
 *
 *   import { orbitalFromSeed, AVA, drawOrbital } from './orbital.js';
 *   const spec = orbitalFromSeed(agentPublicKeyOrDid);
 *   drawOrbital(ctx, spec, { size: 64, theme: 'dark' });          // static
 *   drawOrbital(ctx, AVA, { size: 240, theme: 'light', t: secs }); // animated frame
 *
 * A spec is a real hydrogen orbital or a small superposition of 2-3 of them
 * (n <= 4), viewed from a given elevation, with a tint and a dot density.
 * Drawing is honest: dots are rejection samples of |psi|^2, the fill is |psi|^2
 * integrated along the line of sight, and the boundary is the contour of that
 * projection enclosing CONTOUR_P (90%) of the probability. Every orbital has a
 * soft glowing core at its nucleus, tinted toward its hue. ava ('ava.adf') is
 * the 3d_z2 orbital seen at 35 degrees, drawn with its outer loop only and a
 * white core.
 */

/** @typedef {[number, number, number]} V3 */
/** @typedef {{ n: number, l: number, m: number, c: number }} Term  One real hydrogen orbital |n l m> with an amplitude. */
/**
 * @typedef {object} OrbitalSpec
 * @property {string} seed
 * @property {number} salt
 * @property {boolean} canonical   true for ava
 * @property {Term[]} terms
 * @property {number} elev         viewing elevation above the orbital's equator (rad)
 * @property {number} tilt         in-plane tilt of the axis from vertical (rad)
 * @property {number} phaseSpeed   turns per second of the global phase (two-tone shading)
 * @property {number} hue
 * @property {boolean} accent      rare (about 5%) warm accent instead of a blue
 * @property {number} density      dot density multiplier
 * @property {number} L            half extent of the sampling box (Bohr radii)
 * @property {number} [tries]
 * @property {string[]} [rejected]
 */
/** @typedef {{ b: number[], n: number[], rim: number[], core: number[] }} OrbitalColors */
/**
 * @typedef {object} DrawOptions
 * @property {number} size              box size in CSS px; the shape fills about 84% of it
 * @property {'light'|'dark'} [theme]   default 'light'
 * @property {number} [t]               seconds of animated time (phase shading); default 0
 * @property {number} [spin]            rotation about the orbital axis (rad); default t * 0.4
 * @property {number} [cx]              centre x in the context's units; default size / 2
 * @property {number} [cy]              centre y; default size / 2
 * @property {number} [alpha]           overall opacity 0..1; default 1
 * @property {[number, number]} [gaze]  where the core looks, -1..1 each; default [0, 0] (at the nucleus)
 */

/** Fraction of the projected probability inside the drawn boundary. */
export const CONTOUR_P = 0.9;

/** @param {V3} v @returns {V3} */
const norm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
/** @param {V3} a @param {V3} b @returns {V3} */
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** ava's resting orientation: upright, tilted 35 degrees toward the viewer. */
export const TILT = (35 * Math.PI) / 180;
/** @type {V3} */
export const AXIS0 = norm([0.08, Math.cos(TILT), Math.sin(TILT)]);

/** Orthonormal frame whose third vector is the axis. World: x right, y up, z toward the viewer. @param {V3} axis */
function frame(axis) {
  const e3 = norm(axis);
  const e1 = norm(cross([0, 0, 1], e3));
  const e2 = cross(e3, e1);
  return { e1, e2, e3 };
}

/** cyrb53: a small 53-bit string hash (bryc, public domain). Not cryptographic; it only spreads bits. */
export function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
/** @param {number} a */
function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** @param {number} k */
const fact = (k) => {
  let f = 1;
  for (let i = 2; i <= k; i++) f *= i;
  return f;
};
/** Generalized Laguerre polynomial L_k^(a)(x) by recurrence. */
function laguerre(k, a, x) {
  if (k === 0) return 1;
  let l0 = 1;
  let l1 = 1 + a - x;
  for (let j = 1; j < k; j++) {
    const l2 = ((2 * j + 1 + a - x) * l1 - (j + a) * l0) / (j + 1);
    l0 = l1;
    l1 = l2;
  }
  return l1;
}
/** Normalized hydrogen radial function R_nl(r), r in Bohr radii. */
function radial(n, l) {
  const N = Math.sqrt((2 / n) ** 3 * (fact(n - l - 1) / (2 * n * fact(n + l))));
  return (/** @type {number} */ r) => {
    const rho = (2 * r) / n;
    return N * Math.exp(-r / n) * rho ** l * laguerre(n - l - 1, 2 * l + 1, rho);
  };
}
/**
 * Normalized real spherical harmonics, l <= 3, of a unit vector.
 * @returns {(x: number, y: number, z: number) => number}
 */
function realY(l, m) {
  if (l === 0) return () => 0.282095;
  if (l === 1) return m === 0 ? (_x, _y, z) => 0.488603 * z : m > 0 ? (x) => 0.488603 * x : (_x, y) => 0.488603 * y;
  if (l === 2) {
    if (m === 0) return (_x, _y, z) => 0.315392 * (3 * z * z - 1);
    if (m === 1) return (x, _y, z) => 1.092548 * x * z;
    if (m === -1) return (_x, y, z) => 1.092548 * y * z;
    if (m === 2) return (x, y) => 0.546274 * (x * x - y * y);
    return (x, y) => 1.092548 * x * y;
  }
  if (m === 0) return (_x, _y, z) => 0.373176 * z * (5 * z * z - 3);
  if (m === 1) return (x, _y, z) => 0.457046 * x * (5 * z * z - 1);
  if (m === -1) return (_x, y, z) => 0.457046 * y * (5 * z * z - 1);
  if (m === 2) return (x, y, z) => 1.445306 * z * (x * x - y * y);
  if (m === -2) return (x, y, z) => 2.890611 * x * y * z;
  if (m === 3) return (x, y) => 0.590044 * x * (x * x - 3 * y * y);
  return (x, y) => 0.590044 * y * (3 * x * x - y * y);
}
/** psi(x, y, z) in the orbital's own frame (z is its axis), Bohr radii. @param {OrbitalSpec} spec */
export function psiOf(spec) {
  const parts = spec.terms.map((t) => ({ R: radial(t.n, t.l), Y: realY(t.l, t.m), c: t.c }));
  return (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ z) => {
    const r = Math.sqrt(x * x + y * y + z * z);
    const ux = r ? x / r : 0;
    const uy = r ? y / r : 0;
    const uz = r ? z / r : 1;
    let v = 0;
    for (const p of parts) v += p.c * p.R(r) * p.Y(ux, uy, uz);
    return v;
  };
}
/** @param {OrbitalSpec} spec @returns {V3} */
export function specAxis(spec) {
  return norm([Math.sin(spec.tilt) * Math.cos(spec.elev), Math.cos(spec.tilt) * Math.cos(spec.elev), Math.sin(spec.elev)]);
}
/** The orbital's frame for an axis, turned by `spin` about that axis. @param {V3} axis */
function spinFrame(axis, spin) {
  const f = frame(axis);
  const c = Math.cos(spin);
  const s = Math.sin(spin);
  /** @type {V3} */ const e1 = [f.e1[0] * c + f.e2[0] * s, f.e1[1] * c + f.e2[1] * s, f.e1[2] * c + f.e2[2] * s];
  /** @type {V3} */ const e2 = [f.e2[0] * c - f.e1[0] * s, f.e2[1] * c - f.e1[1] * s, f.e2[2] * c - f.e1[2] * s];
  return { e1, e2, e3: f.e3 };
}

/** @typedef {{ FN: number, L: number, plus: Float32Array, minus: Float32Array, tot: Float32Array, max: number, sum: number }} Grid */
/** |psi|^2 integrated along the line of sight (world z) on an FN x FN grid over [-L, L]^2, split by sign. @returns {Grid} */
function projectGrid(psi, axis, spin, L, FN, ZS) {
  const { e1, e2, e3 } = spinFrame(axis, spin);
  const N2 = FN * FN;
  const plus = new Float32Array(N2);
  const minus = new Float32Array(N2);
  const tot = new Float32Array(N2);
  const d = (2 * L) / FN;
  const dz = (2 * L) / ZS;
  let max = 0;
  let sum = 0;
  for (let j = 0; j < FN; j++) {
    const Y = L - (j + 0.5) * d;
    for (let i = 0; i < FN; i++) {
      const X = (i + 0.5) * d - L;
      let sp = 0;
      let sm = 0;
      for (let k = 0; k < ZS; k++) {
        const Z = (k + 0.5) * dz - L;
        const v = psi(X * e1[0] + Y * e1[1] + Z * e1[2], X * e2[0] + Y * e2[1] + Z * e2[2], X * e3[0] + Y * e3[1] + Z * e3[2]);
        const v2 = v * v;
        if (v >= 0) sp += v2;
        else sm += v2;
      }
      const q = j * FN + i;
      plus[q] = sp;
      minus[q] = sm;
      tot[q] = sp + sm;
      sum += sp + sm;
      if (sp + sm > max) max = sp + sm;
    }
  }
  return { FN, L, plus, minus, tot, max: max || 1, sum: sum || 1 };
}

/** The level whose superlevel set holds CONTOUR_P of the total. @param {Float32Array} tot @param {number} sum */
function levelFor(tot, sum) {
  const sorted = Float32Array.from(tot).sort().reverse();
  let acc = 0;
  for (let q = 0; q < sorted.length; q++) {
    acc += sorted[q];
    if (acc >= CONTOUR_P * sum) return sorted[q];
  }
  return 0;
}
/**
 * Every loop of the CONTOUR_P contour (Bohr, screen axes: y down), largest first, with signed areas.
 * @param {Grid} g @param {number} T
 * @returns {{ pts: Float32Array, area: number, closed: boolean }[]}
 */
function contourLoops(g, T) {
  const { FN, L, tot } = g;
  const d = (2 * L) / FN;
  const X = (/** @type {number} */ i) => (i + 0.5) * d - L;
  /** @type {number[]} */ const seg = [];
  const le = (/** @type {number} */ a, /** @type {number} */ b) => (T - a) / (b - a || 1e-12);
  for (let j = 0; j < FN - 1; j++)
    for (let i = 0; i < FN - 1; i++) {
      const a = tot[j * FN + i];
      const b = tot[j * FN + i + 1];
      const c = tot[(j + 1) * FN + i + 1];
      const e = tot[(j + 1) * FN + i];
      const k = (a > T ? 8 : 0) | (b > T ? 4 : 0) | (c > T ? 2 : 0) | (e > T ? 1 : 0);
      if (k === 0 || k === 15) continue;
      const top = [X(i + le(a, b)), X(j)];
      const right = [X(i + 1), X(j + le(b, c))];
      const bottom = [X(i + le(e, c)), X(j + 1)];
      const left = [X(i), X(j + le(a, e))];
      const add = (/** @type {number[]} */ p, /** @type {number[]} */ q) => seg.push(p[0], p[1], q[0], q[1]);
      switch (k) {
        case 1: case 14: add(left, bottom); break;
        case 2: case 13: add(bottom, right); break;
        case 3: case 12: add(left, right); break;
        case 4: case 11: add(top, right); break;
        case 6: case 9: add(top, bottom); break;
        case 7: case 8: add(left, top); break;
        case 5: add(left, top); add(bottom, right); break;
        case 10: add(top, right); add(left, bottom); break;
      }
    }
  const key = (/** @type {number} */ x, /** @type {number} */ y) => `${x},${y}`;
  /** @type {Map<string, number[]>} */ const adj = new Map();
  for (let q = 0; q < seg.length; q += 4)
    for (const [a, b] of [[q, q + 2], [q + 2, q]]) {
      const k = key(seg[a], seg[a + 1]);
      let list = adj.get(k);
      if (!list) adj.set(k, (list = []));
      list.push(b);
    }
  const used = new Uint8Array(seg.length / 4);
  /** @type {{ pts: Float32Array, area: number, closed: boolean }[]} */ const loops = [];
  for (let q = 0; q < seg.length; q += 4) {
    if (used[q / 4]) continue;
    used[q / 4] = 1;
    const loop = [seg[q], seg[q + 1], seg[q + 2], seg[q + 3]];
    let cx = seg[q + 2];
    let cy = seg[q + 3];
    for (let guard = 0; guard < seg.length; guard++) {
      const next = (adj.get(key(cx, cy)) ?? []).find((b) => !used[Math.floor(b / 4)]);
      if (next === undefined) break;
      used[Math.floor(next / 4)] = 1;
      cx = seg[next];
      cy = seg[next + 1];
      loop.push(cx, cy);
    }
    let area = 0;
    for (let i = 0; i < loop.length - 2; i += 2) area += loop[i] * loop[i + 3] - loop[i + 2] * loop[i + 1];
    const n = loop.length;
    const closed = n >= 8 && loop[0] === loop[n - 2] && loop[1] === loop[n - 1];
    if (n >= 8) loops.push({ pts: Float32Array.from(loop), area: area / 2, closed });
  }
  return loops.sort((p, q) => Math.abs(q.area) - Math.abs(p.area));
}

/** Can this spec be drawn? Some density, and a contour whose loops all close inside the box. @param {Grid} g */
function degenerate(g) {
  if (!Number.isFinite(g.sum) || !Number.isFinite(g.max) || g.sum <= 0) return 'no density';
  const loops = contourLoops(g, levelFor(g.tot, g.sum));
  if (!loops.length) return 'no contour';
  if (loops.some((l) => !l.closed)) return 'open contour';
  return null;
}

/** @type {Omit<OrbitalSpec, 'seed'>} */
const CANON = {
  salt: 0,
  canonical: true,
  terms: [{ n: 3, l: 2, m: 0, c: 1 }],
  elev: Math.asin(AXIS0[2]),
  tilt: Math.atan2(AXIS0[0], AXIS0[1]),
  phaseSpeed: 1 / 24,
  hue: 226,
  accent: false,
  density: 1,
  L: 23,
};
const BLUES = [210, 216, 222, 228, 234, 240, 246, 252, 260];
/** @type {Record<number, number>} */
const REACH = { 1: 8, 2: 15, 3: 25, 4: 40 };

/** @param {string} seed @param {number} salt @returns {OrbitalSpec} */
function rawSpec(seed, salt) {
  const r = mulberry32(cyrb53(`${seed}#${salt}`));
  /** @template T @param {[T, number][]} opts @returns {T} */
  const choose = (opts) => {
    const tot = opts.reduce((s, o) => s + o[1], 0);
    let x = r() * tot;
    for (const [v, w] of opts) if ((x -= w) <= 0) return v;
    return opts[opts.length - 1][0];
  };
  // A base orbital, axially symmetric so it stands upright.
  /** @type {[number, number, number]} */
  const base = choose(/** @type {[[number, number, number], number][]} */ ([
    [[3, 2, 0], 16], [[4, 3, 0], 12], [[4, 2, 0], 10], [[3, 1, 0], 8], [[2, 1, 0], 8],
    [[4, 1, 0], 6], [[3, 0, 0], 2], [[4, 0, 0], 1],
  ]));
  /** @type {Term[]} */
  const terms = [{ n: base[0], l: base[1], m: base[2], c: 1 }];
  const extra = (/** @type {number} */ lo, /** @type {number} */ hi) => {
    const kind = choose(/** @type {[string, number][]} */ ([['s', 16], ['p', 30], ['d', 26], ['f', 8], ['m', 10]]));
    const l = kind === 's' ? 0 : kind === 'p' ? 1 : kind === 'd' ? 2 : kind === 'f' ? 3 : 1 + Math.floor(r() * 2);
    const n = Math.max(l + 1, 2 + Math.floor(r() * 3));
    const m = kind === 'm' ? (r() < 0.5 ? -1 : 1) * (1 + Math.floor(r() * l)) : 0;
    const c = (lo + r() * (hi - lo)) * (r() < 0.5 ? -1 : 1);
    const same = terms.find((t) => t.n === n && t.l === l && t.m === m);
    if (same) same.c += c;
    else terms.push({ n: Math.min(4, n), l, m, c });
  };
  if (r() < 0.75) extra(0.35, 0.95);
  if (r() < 0.2) extra(0.2, 0.45);
  const norm2 = Math.sqrt(terms.reduce((s, t) => s + t.c * t.c, 0)) || 1;
  terms.forEach((t) => (t.c /= norm2));
  const accent = r() < 0.05;
  const deg = Math.PI / 180;
  return {
    seed,
    salt,
    canonical: false,
    terms,
    elev: (18 + r() * 26) * deg,
    tilt: (r() * 2 - 1) * 20 * deg,
    phaseSpeed: 1 / (12 + r() * 18),
    hue: accent ? 28 : BLUES[Math.floor(r() * BLUES.length)],
    accent,
    density: 0.8 + r() * 0.45,
    L: Math.max(...terms.map((t) => REACH[t.n])),
  };
}

/** @type {Map<string, OrbitalSpec>} */
const specCache = new Map();
/**
 * Deterministic spec for a seed (the agent's public key or DID). Same seed, same shape.
 * 'ava.adf' (or { canonical: true }) gives ava's own shape.
 * @param {string} seed
 * @param {{ canonical?: boolean }} [opts]
 * @returns {OrbitalSpec}
 */
export function orbitalFromSeed(seed, opts = {}) {
  if (opts.canonical || seed === 'ava.adf') return { ...CANON, seed, tries: 1, rejected: [] };
  const hit = specCache.get(seed);
  if (hit) return hit;
  /** @type {string[]} */ const rejected = [];
  let spec = rawSpec(seed, 0);
  for (let salt = 0; salt < 40; salt++) {
    spec = rawSpec(seed, salt);
    const g = projectGrid(psiOf(spec), specAxis(spec), 0, spec.L, 40, 20);
    const why = degenerate(g);
    if (!why) break;
    rejected.push(why);
  }
  const out = { ...spec, tries: rejected.length + 1, rejected };
  specCache.set(seed, out);
  return out;
}

/** ava: the canonical orbital (hydrogen 3d_z2 at 35 degrees). */
export const AVA = Object.freeze(orbitalFromSeed('ava.adf'));

/** @returns {number[]} */
const hsl = (h, s, l) => {
  s /= 100;
  l /= 100;
  const k = (/** @type {number} */ n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (/** @type {number} */ n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [Math.round(255 * f(0)), Math.round(255 * f(8)), Math.round(255 * f(4))];
};
/**
 * Colours for a spec on light or dark paper. ava keeps the brand blue
 * (--particle, --particle-2, --buddy-rim, --buddy-core).
 * @param {OrbitalSpec} spec @param {boolean} dark @returns {OrbitalColors}
 */
export function tintColors(spec, dark) {
  if (spec.canonical)
    return dark
      ? { b: [127, 157, 255], n: [178, 186, 206], rim: [196, 210, 255], core: [255, 255, 255] }
      : { b: [47, 91, 234], n: [104, 112, 132], rim: [47, 91, 234], core: [255, 255, 255] };
  const h = spec.hue;
  const s = spec.accent ? 72 : 80;
  return dark
    ? { b: hsl(h, 95, 75), n: hsl(h, 18, 76), rim: hsl(h, 100, 86), core: [255, 255, 255] }
    : { b: hsl(h, s, 55), n: hsl(h, 12, 48), rim: hsl(h, s, 50), core: [255, 255, 255] };
}

/** @param {number[]} c @param {number} a */
const rgba = (c, a) => `rgb(${c[0]} ${c[1]} ${c[2]} / ${Math.max(0, a).toFixed(3)})`;

/** Dot style: depth 0..1 (far..near), sign of psi, phase weights. */
function dotStyle(depth, sign, wPlus, wMinus, /** @type {OrbitalColors} */ col) {
  const pw = sign > 0 ? wPlus : wMinus;
  const cc = col.n.map((v, j) => Math.round(v + (col.b[j] - v) * pw));
  return { r: 0.85 + 0.55 * depth, a: 0.34 + 0.46 * depth, c: cc };
}


/**
 * The core: one drawing for every orbital, ava and generated alike; only the hue
 * differs (ava: the brand blue). `width` is the shape's drawn width; the core
 * is ~12% of it when small and proportionally less when large. On light paper it
 * is a saturated dot in the hue with a halo of the same hue and a small highlight
 * (like the logo's dot); on dark paper the same dot burns near-white.
 */
/** @param {number} width */
export function coreRadius(width) {
  return Math.max(1.9, Math.min(width * 0.072, 2 + width * 0.0215));
}
/**
 * @param {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} c
 * @param {number} x
 * @param {number} y
 * @param {number} width
 * @param {number[]} hue
 * @param {number} alpha
 * @param {boolean} dark
 */
export function drawCore(c, x, y, width, hue, alpha, dark) {
  if (alpha < 0.005) return;
  const r = coreRadius(width);
  const H = r * 2.8;
  const hot = dark ? hue.map((v) => Math.round(255 + (v - 255) * 0.12)) : hue;
  const col = (/** @type {number[]} */ q, /** @type {number} */ a) => `rgb(${q[0]} ${q[1]} ${q[2]} / ${Math.max(0, a * alpha).toFixed(3)})`;
  const g = c.createRadialGradient(x, y, 0, x, y, H);
  g.addColorStop(0, col(hot, 1));
  g.addColorStop(0.22, col(hot, 0.96));
  g.addColorStop(0.36, col(hue, dark ? 0.5 : 0.9));
  g.addColorStop(0.44, col(hue, dark ? 0.3 : 0.34));
  g.addColorStop(1, col(hue, 0));
  c.fillStyle = g;
  c.beginPath();
  c.arc(x, y, H, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = col([255, 255, 255], 0.75);
  c.beginPath();
  c.arc(x - r * 0.28, y - r * 0.28, r * 0.32, 0, Math.PI * 2);
  c.fill();
}

/** A small offscreen canvas for the fill. */
function makeCanvas() {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(1, 1);
  return document.createElement('canvas');
}

/**
 * Draws a spec. Caches samples and the projected grid; the grid is recomputed
 * only when the spin or resolution changes (static drawings compute it once).
 * Same algorithm as Creature in the site's orbital.ts.
 */
export class Creature {
  /** @param {OrbitalSpec} spec */
  constructor(spec) {
    this.spec = spec;
    this.psi = psiOf(spec);
    this.axis = specAxis(spec);
    /** @type {{ x: number, y: number, z: number, s: number }[]} */
    this.dots = [];
    /** @type {{ key: string, g: Grid, T: number, loops: Float32Array[], bb: number[], pieces: number, holes: number } | null} */
    this.grid = null;
    this.fill = makeCanvas();
    // Rejection samples of |psi|^2 in the orbital's frame.
    const L = spec.L;
    const r = mulberry32(cyrb53(`${spec.seed}~dots`));
    let m = 0;
    for (let i = 0; i < 4000; i++) {
      const v = this.psi((r() * 2 - 1) * L, (r() * 2 - 1) * L, (r() * 2 - 1) * L) ** 2;
      if (v > m) m = v;
    }
    m *= 1.6;
    for (let tries = 0; this.dots.length < 520 && tries < 400000; tries++) {
      const x = (r() * 2 - 1) * L;
      const y = (r() * 2 - 1) * L;
      const z = (r() * 2 - 1) * L;
      const v = this.psi(x, y, z);
      if (r() * m < v * v) this.dots.push({ x, y, z, s: v >= 0 ? 1 : -1 });
    }
  }
  /** @param {number} spin @param {number} FN @param {number} ZS */
  gridFor(spin, FN, ZS) {
    const key = `${spin.toFixed(3)}|${FN}`;
    if (this.grid?.key === key) return this.grid;
    const g = projectGrid(this.psi, this.axis, spin, this.spec.L, FN, ZS);
    const T = levelFor(g.tot, g.sum);
    const all = contourLoops(g, T);
    // ava keeps only its outer loop; generated orbitals show every piece and hole.
    const kept = this.spec.canonical ? all.slice(0, 1) : all;
    const inside = (/** @type {number} */ x, /** @type {number} */ y, /** @type {Float32Array} */ p) => {
      let c = false;
      for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2)
        if (p[i + 1] > y !== p[j + 1] > y && x < ((p[j] - p[i]) * (y - p[i + 1])) / (p[j + 1] - p[i + 1]) + p[i]) c = !c;
      return c;
    };
    const holes = all.filter((l, i) => all.filter((o, j) => j !== i && inside(l.pts[0], l.pts[1], o.pts)).length % 2 === 1).length;
    const pieces = all.length - holes;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const l of kept)
      for (let i = 0; i < l.pts.length; i += 2) {
        x0 = Math.min(x0, l.pts[i]);
        x1 = Math.max(x1, l.pts[i]);
        y0 = Math.min(y0, l.pts[i + 1]);
        y1 = Math.max(y1, l.pts[i + 1]);
      }
    if (!Number.isFinite(x0)) [x0, y0, x1, y1] = [-g.L, -g.L, g.L, g.L];
    this.grid = { key, g, T, loops: kept.map((l) => l.pts), bb: [x0, y0, x1, y1], pieces, holes };
    return this.grid;
  }
  /** Separate pieces and holes in the 90% contour, at rest. */
  shapeInfo() {
    const G = this.gridFor(0, 40, 18);
    return { pieces: G.pieces, holes: G.holes };
  }
  /**
   * Draw centred in a box of `size` CSS px at (cx, cy).
   * @param {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} c
   * @param {{ cx: number, cy: number, size: number, spin?: number, time?: number, dark: boolean, alpha?: number, gaze?: [number, number] }} o
   */
  draw(c, o) {
    const { size, dark } = o;
    const alpha = o.alpha ?? 1;
    const spin = o.spin ?? 0;
    const small = Math.max(0, Math.min(1, (110 - size) / 70));
    const FN = size < 90 ? 40 : 96;
    const G = this.gridFor(spin, FN, size < 90 ? 18 : 28);
    const { g, loops, bb } = G;
    const col = tintColors(this.spec, dark);
    const w = Math.max(bb[2] - bb[0], bb[3] - bb[1]) || 1;
    const s = (size * 0.84) / w;
    const ox = o.cx - ((bb[0] + bb[2]) / 2) * s;
    const oy = o.cy - ((bb[1] + bb[3]) / 2) * s;
    const ph = Math.cos((o.time ?? 0) * this.spec.phaseSpeed * 2 * Math.PI);
    const wPlus = (1 + ph) / 2;
    const wMinus = (1 - ph) / 2;
    // Fill.
    const f = this.fill;
    if (f.width !== g.FN) f.width = f.height = g.FN;
    const fc = /** @type {CanvasRenderingContext2D} */ (f.getContext('2d'));
    const img = fc.createImageData(g.FN, g.FN);
    for (let q = 0; q < g.FN * g.FN; q++) {
      const tot = g.tot[q];
      if (tot <= 0) continue;
      const wq = (g.plus[q] * wPlus + g.minus[q] * wMinus) / tot;
      img.data[q * 4] = col.n[0] + (col.b[0] - col.n[0]) * wq;
      img.data[q * 4 + 1] = col.n[1] + (col.b[1] - col.n[1]) * wq;
      img.data[q * 4 + 2] = col.n[2] + (col.b[2] - col.n[2]) * wq;
      img.data[q * 4 + 3] = 255 * Math.min(1, Math.pow(tot / g.max, 0.55)) * (0.44 + 0.22 * small) * alpha;
    }
    fc.putImageData(img, 0, 0);
    c.save();
    c.translate(ox, oy);
    c.imageSmoothingEnabled = true;
    c.drawImage(f, -g.L * s, -g.L * s, 2 * g.L * s, 2 * g.L * s);
    // Boundary: every loop of the contour (ava: its outer loop only).
    if (loops.length) {
      c.beginPath();
      for (const loop of loops) {
        const n = loop.length / 2;
        for (let i = 0; i <= n; i++) {
          const x0 = loop[(i % n) * 2] * s;
          const y0 = loop[(i % n) * 2 + 1] * s;
          const x1 = loop[((i + 1) % n) * 2] * s;
          const y1 = loop[((i + 1) % n) * 2 + 1] * s;
          if (i === 0) c.moveTo((x0 + x1) / 2, (y0 + y1) / 2);
          else c.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
        }
        c.closePath();
      }
      const lw = 1.1 + 0.9 * small;
      c.lineJoin = 'round';
      c.strokeStyle = rgba(col.rim, 0.14 * alpha);
      c.lineWidth = lw * 4;
      c.stroke();
      c.strokeStyle = rgba(col.rim, 0.85 * alpha);
      c.lineWidth = lw;
      c.stroke();
    }
    // Dots.
    const { e1, e2, e3 } = spinFrame(this.axis, spin);
    const nd = Math.min(this.dots.length, Math.round((40 + size * 1.1) * this.spec.density));
    for (let i = 0; i < nd; i++) {
      const d = this.dots[i];
      const X = d.x * e1[0] + d.y * e2[0] + d.z * e3[0];
      const Y = d.x * e1[1] + d.y * e2[1] + d.z * e3[1];
      const Z = d.x * e1[2] + d.y * e2[2] + d.z * e3[2];
      const st = dotStyle((Z / this.spec.L + 1) / 2, d.s, wPlus, wMinus, col);
      c.fillStyle = rgba(st.c, st.a * alpha);
      c.beginPath();
      c.arc(X * s, -Y * s, st.r * (size < 90 ? 0.85 : 1.05), 0, Math.PI * 2);
      c.fill();
    }
    // Core at the nucleus (the projected origin), kept there even where the density
    // is low (nodes, holes). The same core as ava's (drawCore); `gaze` (-1..1)
    // lets it drift a little toward what it looks at.
    const gz = o.gaze ?? [0, 0];
    const wd = size * 0.84;
    drawCore(c, gz[0] * wd * 0.08, gz[1] * wd * 0.08, wd, col.b, alpha, dark);
    c.restore();
  }
}

/** @type {WeakMap<OrbitalSpec, Creature>} */
const creatures = new WeakMap();

/**
 * Draw an orbital into a 2D context. The context's transform is respected
 * (scale it by devicePixelRatio first for crisp output). Does not clear.
 * Static: omit `t`. Animated: pass seconds in `t` each frame; the shape turns
 * at 0.4 rad/s and its two-tone phase cycles at spec.phaseSpeed.
 * Honour prefers-reduced-motion by drawing once with t = 0.
 * @param {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} ctx
 * @param {OrbitalSpec} spec
 * @param {DrawOptions} opts
 */
export function drawOrbital(ctx, spec, opts) {
  let cr = creatures.get(spec);
  if (!cr) creatures.set(spec, (cr = new Creature(spec)));
  const t = opts.t ?? 0;
  cr.draw(ctx, {
    cx: opts.cx ?? opts.size / 2,
    cy: opts.cy ?? opts.size / 2,
    size: opts.size,
    spin: opts.spin ?? t * 0.4,
    time: t,
    dark: opts.theme === 'dark',
    alpha: opts.alpha,
    gaze: opts.gaze,
  });
}
