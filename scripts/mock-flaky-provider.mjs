#!/usr/bin/env node
/**
 * Mock openai-compatible provider for testing automatic provider-error
 * recovery (config.recovery). Starts HEALTHY so Studio's validateConfig
 * preflight passes; arm failures on demand, then trigger an agent turn.
 *
 *   node scripts/mock-flaky-provider.mjs [port]        (default 9999)
 *
 * Studio provider setup: openai-compatible, base URL http://localhost:9999/v1,
 * any model id / API key.
 *
 * Control endpoints (GET from a browser or curl):
 *   /fail?n=4&status=529&after=5   arm the next N completion calls to fail
 *                                  (status default 529, retry-after optional)
 *   /reset                         disarm + zero counters
 *   /status                        JSON view of counters and armed state
 *
 * IMPORTANT for testers:
 * - The AI SDK retries 429/5xx internally (maxRetries: 3 → up to 4 HTTP calls
 *   per executor-visible failure). n < 4 is silently absorbed and executor
 *   recovery never engages; use n=4 for one recovery cycle, n=8 for two.
 * - The provider preflight (validateConfig) also hits /chat/completions and
 *   consumes armed failures. Arm AFTER the agent has completed one healthy
 *   turn, and don't touch provider settings between arming and testing.
 */
import http from 'node:http'

const port = Number(process.argv[2] ?? 9999)
let armedFailures = 0
let failStatus = 529
let retryAfter = null
let calls = 0
let failed = 0

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args)

function completionPayload(text) {
  return {
    id: `mock-${calls}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000),
    model: 'mock-model',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 5, total_tokens: 6 },
  }
}

function sseChunk(delta, finish = null, usage = undefined) {
  const chunk = {
    id: `mock-${calls}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
    model: 'mock-model',
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  }
  return `data: ${JSON.stringify(chunk)}\n\n`
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`)

  if (url.pathname === '/fail') {
    armedFailures = Number(url.searchParams.get('n') ?? 2)
    failStatus = Number(url.searchParams.get('status') ?? 529)
    retryAfter = url.searchParams.get('after')
    log(`ARMED: next ${armedFailures} completion call(s) -> HTTP ${failStatus}${retryAfter ? ` (retry-after: ${retryAfter}s)` : ''}`)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ armed: armedFailures, status: failStatus, retry_after: retryAfter }))
    return
  }
  if (url.pathname === '/reset') {
    armedFailures = 0; calls = 0; failed = 0; retryAfter = null
    log('RESET')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }
  if (url.pathname === '/status') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ calls, failed, armed: armedFailures, fail_status: failStatus, retry_after: retryAfter }))
    return
  }
  if (url.pathname.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] }))
    return
  }

  if (!url.pathname.endsWith('/chat/completions')) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `no route: ${url.pathname}` } }))
    return
  }

  let body = ''
  req.on('data', c => { body += c })
  req.on('end', () => {
    calls++
    let parsed = {}
    try { parsed = JSON.parse(body) } catch { /* tolerate */ }

    if (armedFailures > 0) {
      armedFailures--; failed++
      log(`call #${calls}: FAIL ${failStatus} (${armedFailures} armed failure(s) left)`)
      const headers = { 'content-type': 'application/json' }
      if (retryAfter) headers['retry-after'] = retryAfter
      res.writeHead(failStatus, headers)
      res.end(JSON.stringify({ error: { message: 'Overloaded', type: 'overloaded_error' } }))
      return
    }

    const text = `recovered! (call #${calls}, ${failed} failure(s) so far)`
    if (parsed.stream) {
      log(`call #${calls}: OK (stream)`)
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      res.write(sseChunk({ role: 'assistant', content: '' }))
      res.write(sseChunk({ content: text }))
      res.write(sseChunk({}, 'stop', { prompt_tokens: 1, completion_tokens: 5, total_tokens: 6 }))
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    log(`call #${calls}: OK (json)`)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(completionPayload(text)))
  })
}).listen(port, () => {
  log(`mock flaky provider listening on http://localhost:${port}/v1`)
  log(`healthy by default — arm an outage with: curl "http://localhost:${port}/fail?n=2"`)
})
