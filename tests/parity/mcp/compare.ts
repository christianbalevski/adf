import { IPC } from '../../../src/shared/constants/ipc-channels'
import type { ComparableRecording, StepRecord } from '../harness/recording'

/**
 * What the W3-C scenarios compare between the backends: every step
 * (channel, arguments, answer or rejection, and the pushes each wait
 * matched), the pushes of the W3-C channels in order, the native calls a
 * W3-C flow makes (browser, dialogs), and per fixture file its config and
 * the names of its credential rows. The rest of a recording (leases, the
 * daemon's own files, identity rows written on open, the Help menu) is the
 * core scenarios' business (harness/gaps.ts); including it here would
 * repeat those differences, not test W3-C.
 *
 * Step push watermarks are left out: they count pushes on every channel,
 * and the daemon side sends other channels' pushes (resyncs, settings) at
 * other moments. Order within the W3-C channels is compared.
 */

export const W3C_PUSH_CHANNELS: readonly string[] = [
  IPC.MCP_INSTALL_PROGRESS,
  IPC.ADAPTER_INSTALL_PROGRESS,
  IPC.SANDBOX_INSTALL_PROGRESS,
  IPC.MCP_SERVER_STATUS_CHANGED,
  IPC.ADAPTER_STATUS_CHANGED,
]

const W3C_LOCAL = /^(shell\.openExternal|dialog\.)/

export interface W3cView {
  steps: unknown[]
  pushes: Record<string, unknown[]>
  local: unknown[]
  /** Per fixture file: `mcp` and `adapters` of its config, and its MCP and adapter credential rows (names). */
  files: Record<string, { config: unknown; credentialRows: string[] }>
}

function step(s: StepRecord): unknown {
  switch (s.kind) {
    case 'invoke': return { invoke: s.channel, args: s.args, result: s.result }
    case 'invoke-error': return { invoke: s.channel, args: s.args, rejected: s.error }
    case 'wait': return { wait: s.channel, description: s.description }
    case 'wait-timeout': return { waitTimedOut: s.channel, description: s.description }
    case 'send': return { send: s.channel, args: s.args }
    case 'shutdown': return { shutdown: true }
  }
}

function parse(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}

/** Key-sorted, so two configs written in another key order compare equal. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sorted((value as Record<string, unknown>)[k])]))
  return value
}

/**
 * An OAuth authorization URL opened in the browser: its per-flow values
 * (state, PKCE challenge, the loopback callback's port) become placeholders,
 * the rest (endpoint, client, method, resource) is compared.
 */
function authorizationUrl(value: unknown): unknown {
  // Text, not URL parsing: the normalizer has already put placeholders where the ports were.
  if (typeof value !== 'string' || !/[?&]code_challenge=/.test(value)) return value
  return value
    .replace(/([?&])(state|code_challenge)=[^&]*/g, (_m, sep: string, key: string) => `${sep}${key}=<${key}>`)
    .replace(/([?&]redirect_uri=[^&]*?127\.0\.0\.1)(%3A|:)\d+/i, (_m, head: string, colon: string) => `${head}${colon}<callback-port>`)
    // The resource is the fake server's URL, URL-encoded (the normalizer replaces the plain port only).
    .replace(/([?&]resource=[^&]*?127\.0\.0\.1)(%3A|:)\d+/i, (_m, head: string, colon: string) => `${head}${colon}<FAKE_MCP_PORT>`)
}

export function w3cView(rec: ComparableRecording): W3cView {
  const files: W3cView['files'] = {}
  for (const [file, dump] of Object.entries(rec.state.adf)) {
    const configRow = (dump.tables.adf_config?.rows?.[0] ?? {}) as Record<string, unknown>
    const identityRows = (dump.tables.adf_identity?.rows ?? []) as Array<Record<string, unknown>>
    const config = (parse(configRow.config_json) ?? {}) as { mcp?: unknown; adapters?: unknown }
    files[file] = {
      // The parts of the config the W3-C flows write.
      config: sorted({ mcp: config.mcp, adapters: config.adapters }),
      credentialRows: identityRows.map((r) => String(r.purpose)).filter((p) => /^(mcp|adapter):/.test(p)).sort(),
    }
  }
  return {
    steps: rec.steps.filter((s) => s.kind !== 'shutdown').map(step),
    pushes: Object.fromEntries(W3C_PUSH_CHANNELS.filter((c) => rec.pushes[c]?.length).map((c) => [c, rec.pushes[c]])),
    local: rec.local.filter((c) => W3C_LOCAL.test(c.api)).map((c) => (c.api === 'shell.openExternal' ? { ...c, args: c.args.map(authorizationUrl) } : c)),
    files,
  }
}

export function renderView(view: W3cView): string {
  return `${JSON.stringify(view, null, 2)}\n`
}

// --- the W3-C differences, by design --------------------------------------------

/**
 * Credential values never leave the daemon (design §5: no route returns a
 * secret). MCP_CREDENTIAL_GET answers `__redacted__` for each value embedded
 * answers in the clear (the password fields show dots either way, and
 * saving the placeholder keeps the stored value); ADAPTER_CREDENTIAL_GET
 * answers no values and names every stored key, which the channel dialog
 * shows as "stored". Each entry checks that the daemon shows exactly that,
 * then puts embedded's answer in its place. Applied to the daemon side only.
 */
export interface W3cGap {
  id: string
  ws: 'mode'
  what: string
  apply(daemon: W3cView, embedded: W3cView): number
}

type Invoke = { invoke?: string; result?: Record<string, unknown> }

export const W3C_GAPS: readonly W3cGap[] = [
  {
    id: 'mode:mcp-credential-values',
    ws: 'mode',
    what: 'MCP_CREDENTIAL_GET answers __redacted__ for each value embedded answers in the clear.',
    apply(d, e) {
      let n = 0
      d.steps.forEach((s, i) => {
        const ds = s as Invoke
        const es = e.steps[i] as Invoke
        if (ds.invoke !== IPC.MCP_CREDENTIAL_GET || es?.invoke !== IPC.MCP_CREDENTIAL_GET) return
        const dc = (ds.result?.credentials ?? {}) as Record<string, unknown>
        const ec = (es.result?.credentials ?? {}) as Record<string, unknown>
        const keys = Object.keys(ec)
        if (keys.length === 0 || JSON.stringify(Object.keys(dc).sort()) !== JSON.stringify(keys.sort())) return
        if (!Object.values(dc).every((v) => v === '__redacted__')) return
        ds.result = { ...ds.result, credentials: { ...ec } }
        n++
      })
      return n
    },
  },
  {
    id: 'mode:adapter-credential-values',
    ws: 'mode',
    what: 'ADAPTER_CREDENTIAL_GET answers no values; storedKeys names every stored key, as embedded names them.',
    apply(d, e) {
      let n = 0
      d.steps.forEach((s, i) => {
        const ds = s as Invoke
        const es = e.steps[i] as Invoke
        if (ds.invoke !== IPC.ADAPTER_CREDENTIAL_GET || es?.invoke !== IPC.ADAPTER_CREDENTIAL_GET) return
        const ec = (es.result?.credentials ?? {}) as Record<string, unknown>
        if (Object.keys(ec).length === 0) return
        if (Object.keys((ds.result?.credentials ?? {}) as object).length !== 0) return
        if (JSON.stringify(ds.result?.storedKeys) !== JSON.stringify(es.result?.storedKeys)) return
        ds.result = { ...ds.result, credentials: { ...ec } }
        n++
      })
      return n
    },
  },
]
