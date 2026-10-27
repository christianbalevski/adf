/**
 * Refuses to run on a runtime whose Brotli decoder has CVE-2026-111497: an
 * invalid block switch was reported as "needs more input" instead of a format
 * error, so a streaming decoder kept appending attacker bytes to an 8-byte
 * internal buffer (out-of-bounds write). Fixed upstream in google/brotli
 * 0ed4268a (1.0.10 / 1.1.1 / 1.2.1).
 *
 * ADF decodes Brotli it did not produce: `Content-Encoding: br` responses
 * (utils/guarded-fetch.ts), adf_audit blobs from imported .adf files
 * (adf-workspace readAudit, the v28 migration in adf-database), and sandbox
 * code may call zlib itself. A try/catch or a size cap does not stop memory
 * corruption inside the decoder, so the only fix is a fixed decoder, and the
 * only defence for a stale install is to stop before any of that runs.
 *
 * Which decoder a process links decides, not `process.versions.brotli` (it
 * stays "1.2.0" / "1.1.0" on fixed Node builds):
 *  - Node.js: its vendored deps/brotli. Fixed in 22.23.4, 24.22.1 and 26.12.1;
 *    the same releases export zlib.constants.BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH,
 *    which is required as well. 23.x and 25.x are end-of-life and never got
 *    the fix. Later majors have it but are refused until they are tested
 *    (better-sqlite3 and the release smoke tests stop at 26.x).
 *  - Electron: Node's zlib is linked against Chromium's //third_party/brotli
 *    (Electron's node GN patch), whatever Node version Electron reports.
 *    Chromium's copy has the fix from 148.0.7751.0 (brotli rolled to
 *    cfa184a9); M146 (Electron 41) and the early M148 builds 148.0.7733.0 to
 *    148.0.7741.0 (Electron 42 alphas, 43 nightlies) do not. Every stable
 *    Electron from 42.0.0 (148.0.7778.96) on was checked to link a fixed copy.
 *    Electron's Node (24.22.0 in Electron 43-45) is NOT judged by the Node.js
 *    rule, and it lacks the new constant.
 * Prereleases (Node nightlies/rcs, Electron alpha/beta/nightly) are refused:
 * their decoder is not tied to a version that was checked, and the engines
 * range excludes them too. Anything else (Deno, Bun) is unverified and
 * refused.
 *
 * No override: there is deliberately no env var or flag that admits a
 * vulnerable runtime.
 */

import { constants as zlibConstants } from 'node:zlib'
import { compareVersions } from './version-compare'

/** The engines range in package.json / packages/cli/package.json. */
export const SAFE_NODE_RANGE = '^22.23.4 || ^24.22.1 || ^26.12.1'

/** First fixed release per Node.js line; lines not listed are refused. */
const NODE_FLOORS: Readonly<Record<number, string>> = {
  22: '22.23.4',
  24: '24.22.1',
  26: '26.12.1',
}
/** The newest line tested; later majors are refused until they are. */
const LAST_TESTED_NODE_MAJOR = 26

const ELECTRON_FLOOR = '42.0.0'
/** First Chromium build with the fixed decoder (M148 branch builds before it lack it). */
const CHROMIUM_FLOOR = '148.0.7751.0'

/** BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH, new in the fixed decoder. */
const BLOCK_SWITCH_ERRNO = -17

export interface BrotliRuntimeFacts {
  /** process.versions */
  versions: Readonly<Record<string, string | undefined>>
  /** zlib.constants.BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH */
  blockSwitchErrno: number | undefined
}

export type BrotliRuntimeVerdict =
  | { safe: true; runtime: string }
  | { safe: false; runtime: string; reason: string; remedy: string }

const NODE_REMEDY = `Install Node.js 22.23.4+, 24.22.1+ or 26.12.1+ (${SAFE_NODE_RANGE}) from https://nodejs.org and run adf again.`
const ELECTRON_REMEDY = 'Update ADF Studio to the latest release; from source, run `npm ci` so node_modules has the locked Electron.'

/** "22.23.4" of "v22.23.4-rc.1+build", and whether it is a prerelease. */
function parseVersion(text: string | undefined): { v: string; major: number; pre: boolean } | null {
  const m = /^v?((\d+)\.\d+\.\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.exec(text ?? '')
  if (!m) return null
  return { v: m[1], major: Number(m[2]), pre: m[3] !== undefined }
}

/** a >= floor, where a prerelease of the floor itself counts as older than it. */
function atLeast(a: { v: string; pre: boolean }, floor: string): boolean {
  const d = compareVersions(a.v, floor)
  return d > 0 || (d === 0 && !a.pre)
}

function chromiumAtLeastFloor(text: string | undefined): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(text ?? '') && compareVersions(text!, CHROMIUM_FLOOR) >= 0
}

/** Pure decision, for tests and for the error text. */
export function evaluateBrotliRuntime(facts: BrotliRuntimeFacts): BrotliRuntimeVerdict {
  const { versions } = facts
  if (versions.electron !== undefined) {
    const runtime = `Electron ${versions.electron} (Chromium ${versions.chrome ?? 'unknown'})`
    const electron = parseVersion(versions.electron)
    if (!electron || electron.pre || !atLeast(electron, ELECTRON_FLOOR) || !chromiumAtLeastFloor(versions.chrome)) {
      return { safe: false, runtime, reason: `its Chromium Brotli decoder is not one verified to have the CVE-2026-111497 fix (needs a stable Electron ${ELECTRON_FLOOR}+ on Chromium ${CHROMIUM_FLOOR}+)`, remedy: ELECTRON_REMEDY }
    }
    return { safe: true, runtime }
  }
  if (versions.bun !== undefined || versions.deno !== undefined) {
    const runtime = versions.bun !== undefined ? `Bun ${versions.bun}` : `Deno ${versions.deno}`
    return { safe: false, runtime, reason: 'its Brotli decoder has not been verified against CVE-2026-111497', remedy: NODE_REMEDY }
  }
  const runtime = `Node.js ${versions.node ?? 'unknown'}`
  const node = parseVersion(versions.node)
  if (!node) return { safe: false, runtime, reason: 'its version could not be read', remedy: NODE_REMEDY }
  if (node.pre) return { safe: false, runtime, reason: 'it is a prerelease build, which is not verified against CVE-2026-111497', remedy: NODE_REMEDY }
  const { major } = node
  if (major > LAST_TESTED_NODE_MAJOR) {
    return { safe: false, runtime, reason: `ADF is not tested on Node.js ${major}.x yet`, remedy: NODE_REMEDY }
  }
  const floor = NODE_FLOORS[major]
  if (!floor || !atLeast(node, floor)) {
    const why = floor
      ? `the Brotli decoder in Node.js ${major}.x is fixed from ${floor} on`
      : `Node.js ${major}.x never received the fix`
    return { safe: false, runtime, reason: `it is vulnerable to CVE-2026-111497 (Brotli decoder out-of-bounds write): ${why}`, remedy: NODE_REMEDY }
  }
  if (facts.blockSwitchErrno !== BLOCK_SWITCH_ERRNO) {
    return { safe: false, runtime, reason: 'its zlib lacks the fixed Brotli decoder (no BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH), so it is not an official fixed build', remedy: NODE_REMEDY }
  }
  return { safe: true, runtime }
}

function currentFacts(): BrotliRuntimeFacts {
  const constants = zlibConstants as unknown as Record<string, number | undefined>
  return { versions: process.versions, blockSwitchErrno: constants.BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH }
}

export function refusalMessage(verdict: Extract<BrotliRuntimeVerdict, { safe: false }>): string {
  return `ADF refuses to run on ${verdict.runtime}: ${verdict.reason}. ${verdict.remedy}`
}

export class UnsafeBrotliRuntimeError extends Error {
  readonly code = 'ADF_UNSAFE_BROTLI_RUNTIME'
}

let cached: BrotliRuntimeVerdict | undefined

/** The verdict for this process (computed once; versions cannot change). */
export function brotliRuntimeVerdict(): BrotliRuntimeVerdict {
  return (cached ??= evaluateBrotliRuntime(currentFacts()))
}

/**
 * Throws before a decode on a vulnerable runtime. Called at each place ADF
 * decodes untrusted Brotli, behind the entrypoint check below, so library
 * use (tests, scripts, embedders) that skips the entrypoints still stops.
 */
export function assertSafeBrotliRuntime(): void {
  const verdict = brotliRuntimeVerdict()
  if (!verdict.safe) throw new UnsafeBrotliRuntimeError(refusalMessage(verdict))
}

/**
 * Entrypoint check: prints the refusal and exits 1. In Studio's main process
 * it also shows a native error box (allowed before app ready).
 */
export function exitIfUnsafeBrotliRuntime(): void {
  const verdict = brotliRuntimeVerdict()
  if (verdict.safe) return
  const message = refusalMessage(verdict)
  process.stderr.write(`${message}\n`)
  if (process.versions.electron !== undefined && process.type === 'browser') {
    try {
      // Guarded require: the npm bundle must never import electron statically.
      const electron = require('electron') as { dialog?: { showErrorBox(title: string, content: string): void } }
      electron.dialog?.showErrorBox('ADF Studio cannot start', message)
    } catch { /* stderr already has it */ }
  }
  process.exit(1)
}
