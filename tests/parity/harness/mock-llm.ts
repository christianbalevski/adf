import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'

/**
 * Deterministic, scripted LLM: an OpenAI-compatible `/v1/chat/completions`
 * endpoint on a loopback port. Agents reach it through a normal
 * `openai-compatible` provider entry, so both backends run their real
 * provider code (preflight, streaming, tool-call parsing, usage) and the
 * harness also sees which request each backend sends.
 *
 * Replies are chosen by a script from the request content, never from call
 * order, so an extra or missing request on one backend shows up as a
 * difference in the recorded requests instead of shifting every later reply.
 * Streamed text arrives in three slices written `gapMs` apart (default
 * 200 ms, four times the executor's 50 ms batch window), as a real model
 * streams; `streams` records when each slice was written.
 */

export interface LlmToolCall {
  name: string
  arguments: Record<string, unknown>
}

export interface LlmReply {
  text?: string
  toolCalls?: LlmToolCall[]
  usage?: { prompt: number; completion: number }
}

export interface LlmMessageView {
  role: string
  /** Text content (string parts joined). */
  text: string
  toolCalls?: { name: string; arguments: string }[]
  toolCallId?: string
}

export interface LlmRequestView {
  model: string
  stream: boolean
  tools: string[]
  /** System prompt (all system messages, joined). */
  system: string
  /** Non-system messages in order. */
  messages: LlmMessageView[]
  /** The AiSdkProvider.validateConfig() probe: `prompt: 'hi'`, no tools. */
  isPreflight: boolean
  /** The last non-system message. */
  last: LlmMessageView | undefined
}

export type LlmScript = (request: LlmRequestView) => LlmReply

export const MOCK_MODEL_ID = 'parity-model'

/** Preflight gets 'ok'; anything else gets one fixed sentence. */
export const defaultScript: LlmScript = (req) =>
  req.isPreflight ? { text: 'ok' } : { text: 'Parity reply.' }

/** What the recording keeps of a request: everything the backend sent that the model would see. */
export interface RecordedLlmRequest {
  model: string
  stream: boolean
  tools: string[]
  system: string
  messages: LlmMessageView[]
}

export function recordedRequest(view: LlmRequestView): RecordedLlmRequest {
  return { model: view.model, stream: view.stream, tools: view.tools, system: view.system, messages: view.messages }
}

export interface MockLlm {
  /** Base URL for the provider entry, e.g. http://127.0.0.1:1234/v1 */
  readonly baseUrl: string
  /** Every request received, in arrival order. */
  readonly requests: LlmRequestView[]
  /** One entry per streamed reply. */
  readonly streams: StreamTiming[]
  script: LlmScript
  close(): Promise<void>
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text
        : `[${(part as { type?: string })?.type ?? 'part'}]`))
      .join('')
  }
  return ''
}

function viewOf(body: Record<string, unknown>): LlmRequestView {
  const raw = Array.isArray(body.messages) ? (body.messages as Record<string, unknown>[]) : []
  const system = raw.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n')
  const messages: LlmMessageView[] = raw.filter((m) => m.role !== 'system').map((m) => {
    const view: LlmMessageView = { role: String(m.role), text: textOf(m.content) }
    if (Array.isArray(m.tool_calls)) {
      view.toolCalls = (m.tool_calls as { function?: { name?: string; arguments?: string } }[]).map((c) => ({
        name: c.function?.name ?? '',
        arguments: c.function?.arguments ?? '',
      }))
    }
    if (typeof m.tool_call_id === 'string') view.toolCallId = m.tool_call_id
    return view
  })
  const tools = Array.isArray(body.tools)
    ? (body.tools as { function?: { name?: string } }[]).map((t) => t.function?.name ?? '')
    : []
  const last = messages[messages.length - 1]
  return {
    model: String(body.model ?? ''),
    stream: body.stream === true,
    tools,
    system,
    messages,
    isPreflight: tools.length === 0 && messages.length === 1 && last?.role === 'user' && last.text === 'hi',
    last,
  }
}

/**
 * Wall-clock text in a request (the runtime stamps chat messages with the
 * time) is masked before hashing, so ids depend on what was asked, not when.
 */
function contentHash(view: LlmRequestView): string {
  const mask = (t: string) => t
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?( UTC|Z)?/g, '<time>')
    .replace(/(?<!\d)\d{13}(?!\d)/g, '<ms>')
  const material = JSON.stringify({
    model: view.model,
    tools: view.tools,
    system: mask(view.system),
    messages: view.messages.map((m) => ({ ...m, text: mask(m.text) })),
  })
  return createHash('sha256').update(material).digest('hex').slice(0, 12)
}

/** Timing of one streamed reply, for the latency and batching checks. */
export interface StreamTiming {
  /** Index into `requests`. */
  request: number
  /** Run-relative ms at which each text slice was written. */
  textWrites: number[]
}

/**
 * Ids are derived from a hash of the request content, so an extra or missing
 * request on one backend does not renumber every later id.
 */
async function respond(
  res: ServerResponse,
  view: LlmRequestView,
  reply: LlmReply,
  opts: { gapMs: number; now: () => number; timing: StreamTiming },
): Promise<void> {
  const hash = contentHash(view)
  const id = `chatcmpl-${hash}`
  const created = 1_700_000_000
  const usage = {
    prompt_tokens: reply.usage?.prompt ?? 100,
    completion_tokens: reply.usage?.completion ?? 10,
    total_tokens: (reply.usage?.prompt ?? 100) + (reply.usage?.completion ?? 10),
  }
  const toolCalls = (reply.toolCalls ?? []).map((call, i) => ({
    id: `call_${hash}_${i + 1}`,
    type: 'function' as const,
    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
  }))
  const finish = toolCalls.length > 0 ? 'tool_calls' : 'stop'

  if (!view.stream) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      id, object: 'chat.completion', created, model: view.model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: reply.text ?? null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
        finish_reason: finish,
      }],
      usage,
    }))
    return
  }

  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
    `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: view.model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`
  const text = reply.text ?? ''
  const slices: string[] = []
  // Three slices, written gapMs apart: longer than the executor's 50 ms delta
  // batch window, so each slice is its own text_delta_batch (real streaming).
  if (text) {
    const step = Math.max(1, Math.ceil(text.length / 3))
    for (let i = 0; i < text.length; i += step) slices.push(text.slice(i, i + step))
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  let head = chunk({ role: 'assistant', content: '' })
  for (let i = 0; i < slices.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, opts.gapMs))
    res.write((i === 0 ? head : '') + chunk({ content: slices[i] }))
    opts.timing.textWrites.push(opts.now())
    head = ''
  }
  let tail = head
  toolCalls.forEach((call, index) => {
    tail += chunk({ tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments } }] })
  })
  if (slices.length) await new Promise((r) => setTimeout(r, opts.gapMs))
  tail += chunk({}, finish)
  tail += `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: view.model, choices: [], usage })}\n\n`
  tail += 'data: [DONE]\n\n'
  res.end(tail)
}

async function readBody(req: IncomingMessage): Promise<string> {
  const parts: Buffer[] = []
  for await (const part of req) parts.push(part as Buffer)
  return Buffer.concat(parts).toString('utf-8')
}

export async function startMockLlm(
  script: LlmScript = defaultScript,
  opts: { gapMs?: number; now?: () => number } = {},
): Promise<MockLlm> {
  const requests: LlmRequestView[] = []
  const streams: StreamTiming[] = []
  const gapMs = opts.gapMs ?? 200
  const now = opts.now ?? Date.now
  const state = { script }
  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        const url = req.url ?? ''
        if (req.method === 'GET' && url.endsWith('/models')) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ object: 'list', data: [{ id: MOCK_MODEL_ID, object: 'model', owned_by: 'parity' }] }))
          return
        }
        if (req.method === 'POST' && url.endsWith('/chat/completions')) {
          const view = viewOf(JSON.parse(await readBody(req)) as Record<string, unknown>)
          requests.push(view)
          const timing: StreamTiming = { request: requests.length - 1, textWrites: [] }
          if (view.stream) streams.push(timing)
          await respond(res, view, state.script(view), { gapMs, now, timing })
          return
        }
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `mock LLM: no route ${req.method} ${url}` } }))
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `mock LLM: ${err instanceof Error ? err.message : String(err)}` } }))
      }
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    streams,
    get script() { return state.script },
    set script(next: LlmScript) { state.script = next },
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections?.()
      server.close(() => resolve())
    }),
  }
}
