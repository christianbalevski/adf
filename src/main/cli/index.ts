#!/usr/bin/env node

const DEFAULT_DAEMON_URL = 'http://127.0.0.1:7385'

export interface CliIo {
  fetch: typeof fetch
  stdout: (text: string) => void
  stderr: (text: string) => void
}

interface CliOptions {
  daemonUrl: string
  json: boolean
}

interface ParsedArgs {
  command: string
  args: string[]
  options: CliOptions
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

const defaultIo: CliIo = {
  fetch: globalThis.fetch.bind(globalThis),
  stdout: text => process.stdout.write(text),
  stderr: text => process.stderr.write(text),
}

export async function runCli(argv = process.argv.slice(2), io: CliIo = defaultIo): Promise<number> {
  let parsed: ParsedArgs
  try {
    parsed = parseArgs(argv)
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n\n${usage()}\n`)
    return 2
  }

  const { command, args, options } = parsed

  try {
    switch (command) {
      case 'help':
      case '--help':
      case '-h':
        io.stdout(`${usage()}\n`)
        return 0
      case 'agents':
        return await printGet(io, options, '/agents', formatAgents)
      case 'status':
        return await withAgent(args, io, async agent => printGet(io, options, `/agents/${enc(agent)}/status`, formatStatus))
      case 'start':
        return await controlAgent(io, options, args, 'start')
      case 'stop':
      case 'unload':
        return await controlAgent(io, options, args, 'stop')
      case 'abort':
        return await controlAgent(io, options, args, 'abort')
      case 'config':
        return await withAgent(args, io, async agent => printGet(io, options, `/agents/${enc(agent)}/config`, formatJsonPretty))
      case 'providers':
        return await printGet(io, options, '/runtime/providers', formatProviders)
      case 'auth':
        return await printGet(io, options, '/runtime/auth', formatAuth)
      case 'settings':
        return await printGet(io, options, '/runtime/settings', formatJsonPretty)
      case 'network':
        if (args[0]) return await networkAdmin(io, options, args)
        return await printGet(io, options, '/runtime/network', formatNetwork)
      case 'usage':
        if (!args[0]) return await printGet(io, options, '/runtime/usage', formatUsage)
        return await withAgent(args, io, async agent => printGet(io, options, `/agents/${enc(agent)}/usage`, formatUsage))
      case 'files':
        return await withAgent(args, io, async agent => printGet(io, options, `/agents/${enc(agent)}/files`, formatFiles))
      case 'file':
        return await withAgentAndValue(args, 'file path', io, async (agent, path) => {
          const data = await requestJson(io, options, `/agents/${enc(agent)}/files/content?path=${enc(path)}`)
          if (options.json) io.stdout(`${JSON.stringify(data, null, 2)}\n`)
          else if (isRecord(data) && data.encoding === 'utf-8' && typeof data.content === 'string') io.stdout(data.content)
          else if (isRecord(data) && typeof data.content_base64 === 'string') io.stdout(`${data.content_base64}\n`)
          else io.stdout(`${JSON.stringify(data, null, 2)}\n`)
          return 0
        })
      case 'inbox':
        return await withAgent(args, io, async agent => printGet(io, options, `/agents/${enc(agent)}/inbox`, formatMessages('inbox')))
      case 'outbox':
        return await withAgent(args, io, async agent => printGet(io, options, `/agents/${enc(agent)}/outbox`, formatMessages('outbox')))
      case 'timers':
        return await withAgent(args, io, async agent => printGet(io, options, `/agents/${enc(agent)}/timers`, formatTimers))
      case 'tasks':
        return await withAgent(args, io, async agent => printGet(io, options, `/agents/${enc(agent)}/tasks`, formatTasks))
      case 'task':
        return await withAgentAndValue(args, 'task id', io, async (agent, taskId) => printGet(io, options, `/agents/${enc(agent)}/tasks/${enc(taskId)}`, formatJsonPretty))
      case 'approve':
        return await resolveTask(io, options, args, 'approve')
      case 'deny':
        return await resolveTask(io, options, args, 'deny')
      case 'asks':
        return await withAgent(args, io, async agent => printGet(io, options, `/agents/${enc(agent)}/asks`, formatAsks))
      case 'answer':
        return await answerAsk(io, options, args)
      case 'identities':
        return await withAgent(args, io, async agent => printGet(io, options, `/agents/${enc(agent)}/identities`, formatIdentities))
      case 'runtime':
        if (!args[0]) return await printGet(io, options, '/runtime', formatJsonPretty)
        return await withAgent(args, io, async agent => printGet(io, options, `/agents/${enc(agent)}/runtime`, formatJsonPretty))
      case 'mcp':
        if (!args[0]) return await printGet(io, options, '/runtime/mcp', formatGlobalMcp)
        return await withAgent(args, io, async agent => printGet(io, options, `/agents/${enc(agent)}/runtime/mcp`, formatMcp))
      case 'adapters':
        if (!args[0]) return await printGet(io, options, '/runtime/adapters', formatGlobalAdapters)
        return await withAgent(args, io, async agent => printGet(io, options, `/agents/${enc(agent)}/runtime/adapters`, formatAdapters))
      case 'events':
        return await streamEvents(io, options, args)
      case 'chat':
        return await sendChat(io, options, args)
      default:
        io.stderr(`Unknown command: ${command}\n\n${usage()}\n`)
        return 2
    }
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = [...argv]
  let daemonUrl = process.env.ADF_DAEMON_URL ?? DEFAULT_DAEMON_URL
  let json = false
  const positional: string[] = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--json') {
      json = true
    } else if (arg === '--url' || arg === '-u') {
      const value = args[++i]
      if (!value) throw new Error(`${arg} requires a daemon URL`)
      daemonUrl = value
    } else if (arg.startsWith('--url=')) {
      daemonUrl = arg.slice('--url='.length)
    } else {
      positional.push(arg)
    }
  }

  return {
    command: positional[0] ?? 'help',
    args: positional.slice(1),
    options: {
      daemonUrl: daemonUrl.replace(/\/+$/, ''),
      json,
    },
  }
}

async function printGet(
  io: CliIo,
  options: CliOptions,
  path: string,
  formatter: (value: JsonValue) => string,
): Promise<number> {
  const data = await requestJson(io, options, path)
  io.stdout(options.json ? `${JSON.stringify(data, null, 2)}\n` : formatter(data))
  return 0
}

async function requestJson(io: CliIo, options: CliOptions, path: string, init?: RequestInit): Promise<JsonValue> {
  const response = await io.fetch(`${options.daemonUrl}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Accept: 'application/json',
    },
  })
  const text = await response.text()
  let body: JsonValue = null
  if (text.trim()) {
    try { body = JSON.parse(text) as JsonValue } catch { body = text }
  }
  if (!response.ok) {
    const message = isRecord(body) && typeof body.error === 'string'
      ? body.error
      : `HTTP ${response.status} ${response.statusText}`
    throw new Error(message)
  }
  return body
}

async function sendChat(io: CliIo, options: CliOptions, args: string[]): Promise<number> {
  const agent = args[0]
  const text = args.slice(1).join(' ')
  if (!agent || !text) throw new Error('Usage: adf chat <agent> <message>')
  const data = await requestJson(io, options, `/agents/${enc(agent)}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  io.stdout(options.json ? `${JSON.stringify(data, null, 2)}\n` : formatChatAck(data))
  return 0
}

async function resolveTask(
  io: CliIo,
  options: CliOptions,
  args: string[],
  action: 'approve' | 'deny',
): Promise<number> {
  const agent = args[0]
  const taskId = args[1]
  const reason = action === 'deny' ? args.slice(2).join(' ') : undefined
  if (!agent || !taskId) throw new Error(`Usage: adf ${action} <agent> <taskId>${action === 'deny' ? ' [reason]' : ''}`)
  const data = await requestJson(io, options, `/agents/${enc(agent)}/tasks/${enc(taskId)}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...(reason ? { reason } : {}) }),
  })
  io.stdout(options.json ? `${JSON.stringify(data, null, 2)}\n` : formatTaskResolution(action, taskId, data))
  return 0
}

async function answerAsk(io: CliIo, options: CliOptions, args: string[]): Promise<number> {
  const agent = args[0]
  const requestId = args[1]
  const answer = args.slice(2).join(' ')
  if (!agent || !requestId || !answer) throw new Error('Usage: adf answer <agent> <requestId> <answer>')
  const data = await requestJson(io, options, `/agents/${enc(agent)}/asks/${enc(requestId)}/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer }),
  })
  io.stdout(options.json ? `${JSON.stringify(data, null, 2)}\n` : `Answered ${requestId}\n`)
  return 0
}

async function controlAgent(
  io: CliIo,
  options: CliOptions,
  args: string[],
  action: 'start' | 'stop' | 'abort',
): Promise<number> {
  const agent = args[0]
  if (!agent) throw new Error(`Usage: adf ${action} <agent>`)
  const data = await requestJson(io, options, `/agents/${enc(agent)}/${action}`, { method: 'POST' })
  io.stdout(options.json ? `${JSON.stringify(data, null, 2)}\n` : formatAgentControl(action, agent, data))
  return 0
}

async function networkAdmin(io: CliIo, options: CliOptions, args: string[]): Promise<number> {
  const area = args[0]
  const action = args[1]
  if (area === 'mesh') {
    if (action === 'enable' || action === 'disable') {
      return await postAndPrint(io, options, `/network/mesh/${action}`, formatJsonPretty)
    }
    if (!action || action === 'status') return await printGet(io, options, '/network/mesh', formatJsonPretty)
  }
  if (area === 'server') {
    if (action === 'start' || action === 'stop' || action === 'restart') {
      return await postAndPrint(io, options, `/network/server/${action}`, formatJsonPretty)
    }
    if (!action || action === 'status') return await printGet(io, options, '/network/server', formatJsonPretty)
  }
  if (area === 'tools') return await printGet(io, options, '/network/mesh/recent-tools', formatJsonPretty)
  if (area === 'lan') return await printGet(io, options, '/network/mesh/lan-addresses', formatJsonPretty)
  if (area === 'runtimes') return await printGet(io, options, '/network/mesh/discovered-runtimes', formatJsonPretty)
  throw new Error('Usage: adf network [mesh [status|enable|disable] | server [status|start|stop|restart] | tools | lan | runtimes]')
}

async function postAndPrint(
  io: CliIo,
  options: CliOptions,
  path: string,
  formatter: (value: JsonValue) => string,
): Promise<number> {
  const data = await requestJson(io, options, path, { method: 'POST' })
  io.stdout(options.json ? `${JSON.stringify(data, null, 2)}\n` : formatter(data))
  return 0
}

async function streamEvents(io: CliIo, options: CliOptions, args: string[]): Promise<number> {
  const agent = args[0]
  const path = agent ? `/events?agentId=${enc(agent)}` : '/events'
  const response = await io.fetch(`${options.daemonUrl}${path}`, {
    headers: { Accept: 'text/event-stream' },
  })
  if (!response.ok || !response.body) {
    throw new Error(`Event stream failed: HTTP ${response.status} ${response.statusText}`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split(/\n\n/)
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      const dataLine = part.split(/\n/).find(line => line.startsWith('data: '))
      if (!dataLine) continue
      const payload = dataLine.slice('data: '.length)
      if (options.json) io.stdout(`${payload}\n`)
      else {
        try { io.stdout(`${formatEvent(JSON.parse(payload) as JsonValue)}\n`) }
        catch { io.stdout(`${payload}\n`) }
      }
    }
  }
  return 0
}

async function withAgent(
  args: string[],
  io: CliIo,
  run: (agent: string) => Promise<number>,
): Promise<number> {
  const agent = args[0]
  if (!agent) {
    io.stderr('Missing agent id or handle.\n')
    return 2
  }
  return await run(agent)
}

async function withAgentAndValue(
  args: string[],
  label: string,
  io: CliIo,
  run: (agent: string, value: string) => Promise<number>,
): Promise<number> {
  const agent = args[0]
  const value = args[1]
  if (!agent || !value) {
    io.stderr(`Missing agent id/handle or ${label}.\n`)
    return 2
  }
  return await run(agent, value)
}

function formatAgents(value: JsonValue): string {
  const rows = Array.isArray(value) ? value.filter(isRecord) : []
  if (rows.length === 0) return 'No agents loaded.\n'
  return table(['id', 'handle', 'name', 'autostart'], rows.map(row => [
    String(row.id ?? ''),
    String(row.handle ?? ''),
    String(row.name ?? ''),
    String(row.autostart ?? false),
  ]))
}

function formatStatus(value: JsonValue): string {
  if (!isRecord(value)) return formatJsonPretty(value)
  return table(['field', 'value'], [
    ['id', String(value.id ?? '')],
    ['handle', String(value.handle ?? '')],
    ['name', String(value.name ?? '')],
    ['runtimeState', String(value.runtimeState ?? '')],
    ['targetState', String(value.targetState ?? '')],
    ['loopCount', String(value.loopCount ?? '')],
    ['filePath', String(value.filePath ?? '')],
  ])
}

function formatFiles(value: JsonValue): string {
  const files = isRecord(value) && Array.isArray(value.files) ? value.files.filter(isRecord) : []
  if (files.length === 0) return 'No files.\n'
  return table(['path', 'size', 'mime', 'protection'], files.map(file => [
    String(file.path ?? ''),
    String(file.size ?? ''),
    String(file.mime_type ?? ''),
    String(file.protection ?? ''),
  ]))
}

function formatProviders(value: JsonValue): string {
  if (!isRecord(value)) return formatJsonPretty(value)
  const providers = Array.isArray(value.providers) ? value.providers.filter(isRecord) : []
  const usage = Array.isArray(value.agentUsage) ? value.agentUsage.filter(isRecord) : []
  const providerTable = providers.length === 0
    ? 'Providers: none\n'
    : `Providers:\n${table(['id', 'type', 'name', 'model', 'key'], providers.map(provider => [
      String(provider.id ?? ''),
      String(provider.type ?? ''),
      String(provider.name ?? ''),
      String(provider.defaultModel ?? ''),
      String(provider.hasApiKey ?? false),
    ]))}`
  const usageTable = usage.length === 0
    ? 'Agent usage: none\n'
    : `Agent usage:\n${table(['agent', 'provider', 'model', 'source'], usage.map(row => [
      String(row.handle ?? row.agentId ?? ''),
      String(row.providerId ?? ''),
      String(row.modelId ?? ''),
      String(row.source ?? ''),
    ]))}`
  return `${providerTable}\n${usageTable}`
}

function formatAuth(value: JsonValue): string {
  if (!isRecord(value)) return formatJsonPretty(value)
  const chatgpt = isRecord(value.chatgpt) ? value.chatgpt : {}
  const providers = Array.isArray(value.providers) ? value.providers.filter(isRecord) : []
  const chatgptTable = `ChatGPT:\n${table(['field', 'value'], [
    ['authenticated', String(chatgpt.authenticated ?? false)],
    ['accountId', String(chatgpt.accountId ?? '')],
  ])}`
  const providersTable = providers.length === 0
    ? 'Provider credentials: none\n'
    : `Provider credentials:\n${table(['id', 'type', 'storage', 'apiKey'], providers.map(provider => [
      String(provider.id ?? ''),
      String(provider.type ?? ''),
      String(provider.credentialStorage ?? ''),
      String(provider.hasApiKey ?? false),
    ]))}`
  return `${chatgptTable}\n${providersTable}`
}

function formatNetwork(value: JsonValue): string {
  if (!isRecord(value)) return formatJsonPretty(value)
  const mesh = isRecord(value.mesh) ? value.mesh : {}
  const websocket = isRecord(value.websocket) ? value.websocket : {}
  const agents = Array.isArray(value.agents) ? value.agents.filter(isRecord) : []
  const summary = table(['field', 'value'], [
    ['meshEnabledSetting', String(mesh.enabledSetting ?? '')],
    ['meshLan', String(mesh.lan ?? '')],
    ['meshPort', String(mesh.port ?? '')],
    ['wsActive', String(websocket.activeConnections ?? 0)],
    ['wsInbound', String(websocket.inboundConnections ?? 0)],
    ['wsOutbound', String(websocket.outboundConnections ?? 0)],
  ])
  const agentTable = agents.length === 0
    ? 'Network agents: none\n'
    : `Network agents:\n${table(['agent', 'receive', 'mode', 'ws', 'routes'], agents.map(agent => [
      String(agent.handle ?? agent.agentId ?? ''),
      String(agent.receive ?? false),
      String(agent.sendMode ?? ''),
      String(agent.wsConnectionsConfigured ?? 0),
      String(agent.servingRoutes ?? 0),
    ]))}`
  return `${summary}\n${agentTable}`
}

function formatUsage(value: JsonValue): string {
  if (!isRecord(value)) return formatJsonPretty(value)
  const totals = isRecord(value.totals) ? value.totals : {}
  const summaryRows = [
    ['source', String(value.source ?? '')],
    ['input', formatNumber(totals.input)],
    ['output', formatNumber(totals.output)],
    ['cacheRead', formatNumber(totals.cacheRead)],
    ['cacheWrite', formatNumber(totals.cacheWrite)],
    ['total', formatNumber(totals.total)],
  ]
  if (value.agentId) summaryRows.unshift(['agentId', String(value.agentId)])
  if (typeof value.loopRows === 'number') summaryRows.push(['loopRows', formatNumber(value.loopRows)])
  if (typeof value.usageRows === 'number') summaryRows.push(['usageRows', formatNumber(value.usageRows)])

  const rows = Array.isArray(value.byModel)
    ? value.byModel.filter(isRecord).map(row => [
      String(row.provider ?? ''),
      String(row.model ?? ''),
      formatNumber(row.input),
      formatNumber(row.output),
      formatNumber(row.cacheRead),
      formatNumber(row.cacheWrite),
      formatNumber(row.total),
      formatNumber(row.rows ?? row.days),
    ])
    : []
  const modelTable = rows.length === 0
    ? 'Models: none\n'
    : `Models:\n${table(['provider', 'model', 'input', 'output', 'cacheRead', 'cacheWrite', 'total', 'rows/days'], rows)}`
  return `${table(['field', 'value'], summaryRows)}\n${modelTable}`
}

function formatMessages(label: 'inbox' | 'outbox'): (value: JsonValue) => string {
  return value => {
    const messages = isRecord(value) && Array.isArray(value.messages) ? value.messages.filter(isRecord) : []
    if (messages.length === 0) return `No ${label} messages.\n`
    return table(['id', 'status', label === 'inbox' ? 'from' : 'to', 'content'], messages.map(message => [
      String(message.id ?? ''),
      String(message.status ?? ''),
      String(label === 'inbox' ? message.from ?? '' : message.to ?? ''),
      truncate(String(message.content ?? ''), 80),
    ]))
  }
}

function formatTimers(value: JsonValue): string {
  const timers = isRecord(value) && Array.isArray(value.timers) ? value.timers.filter(isRecord) : []
  if (timers.length === 0) return 'No timers.\n'
  return table(['id', 'next_wake_at', 'runs', 'payload'], timers.map(timer => [
    String(timer.id ?? ''),
    typeof timer.next_wake_at === 'number' ? new Date(timer.next_wake_at).toISOString() : String(timer.next_wake_at ?? ''),
    String(timer.run_count ?? ''),
    truncate(String(timer.payload ?? ''), 80),
  ]))
}

function formatTasks(value: JsonValue): string {
  const tasks = isRecord(value) && Array.isArray(value.tasks) ? value.tasks.filter(isRecord) : []
  if (tasks.length === 0) return 'No tasks.\n'
  return table(['id', 'status', 'tool', 'origin', 'auth'], tasks.map(task => [
    String(task.id ?? ''),
    String(task.status ?? ''),
    String(task.tool ?? ''),
    truncate(String(task.origin ?? ''), 32),
    String(task.requires_authorization ?? false),
  ]))
}

function formatAsks(value: JsonValue): string {
  const asks = isRecord(value) && Array.isArray(value.asks) ? value.asks.filter(isRecord) : []
  if (asks.length === 0) return 'No pending asks.\n'
  return table(['requestId', 'question'], asks.map(ask => [
    String(ask.requestId ?? ''),
    truncate(String(ask.question ?? ''), 100),
  ]))
}

function formatIdentities(value: JsonValue): string {
  const identities = isRecord(value) && Array.isArray(value.identities) ? value.identities.filter(isRecord) : []
  if (identities.length === 0) return 'No identities.\n'
  return table(['purpose', 'encrypted', 'code_access'], identities.map(identity => [
    String(identity.purpose ?? ''),
    String(identity.encrypted ?? false),
    String(identity.code_access ?? false),
  ]))
}

function formatMcp(value: JsonValue): string {
  if (!isRecord(value)) return formatJsonPretty(value)
  const configured = Array.isArray(value.configured) ? value.configured.filter(isRecord) : []
  const states = Array.isArray(value.states) ? value.states.filter(isRecord) : []
  const configuredTable = configured.length === 0
    ? 'Configured MCP: none\n'
    : `Configured MCP:\n${table(['name', 'transport', 'tools'], configured.map(server => [
      String(server.name ?? ''),
      String(server.transport ?? ''),
      String(server.toolCount ?? ''),
    ]))}`
  const stateTable = states.length === 0
    ? 'Runtime MCP: none\n'
    : `Runtime MCP:\n${table(['name', 'status', 'tools', 'error'], states.map(state => [
      String(state.name ?? ''),
      String(state.status ?? ''),
      String(state.toolCount ?? ''),
      truncate(String(state.error ?? ''), 80),
    ]))}`
  return `${configuredTable}\n${stateTable}`
}

function formatGlobalMcp(value: JsonValue): string {
  const servers = isRecord(value) && Array.isArray(value.servers) ? value.servers.filter(isRecord) : []
  if (servers.length === 0) return 'No daemon MCP servers registered.\n'
  return table(['id', 'name', 'type', 'package', 'storage', 'env'], servers.map(server => [
    String(server.id ?? ''),
    String(server.name ?? ''),
    String(server.type ?? ''),
    String(server.npmPackage ?? server.pypiPackage ?? server.command ?? server.url ?? ''),
    String(server.credentialStorage ?? ''),
    Array.isArray(server.env) ? String(server.env.length) : '0',
  ]))
}

function formatAdapters(value: JsonValue): string {
  if (!isRecord(value)) return formatJsonPretty(value)
  const configured = Array.isArray(value.configured) ? value.configured.filter(isRecord) : []
  const states = Array.isArray(value.states) ? value.states.filter(isRecord) : []
  const configuredTable = configured.length === 0
    ? 'Configured adapters: none\n'
    : `Configured adapters:\n${table(['type', 'enabled'], configured.map(adapter => [
      String(adapter.type ?? ''),
      String(adapter.enabled ?? false),
    ]))}`
  const stateTable = states.length === 0
    ? 'Runtime adapters: none\n'
    : `Runtime adapters:\n${table(['type', 'status', 'error'], states.map(state => [
      String(state.type ?? ''),
      String(state.status ?? ''),
      truncate(String(state.error ?? ''), 80),
    ]))}`
  return `${configuredTable}\n${stateTable}`
}

function formatGlobalAdapters(value: JsonValue): string {
  const adapters = isRecord(value) && Array.isArray(value.adapters) ? value.adapters.filter(isRecord) : []
  if (adapters.length === 0) return 'No daemon adapters registered.\n'
  return table(['id', 'type', 'package', 'storage', 'env'], adapters.map(adapter => [
    String(adapter.id ?? ''),
    String(adapter.type ?? ''),
    String(adapter.npmPackage ?? ''),
    String(adapter.credentialStorage ?? ''),
    Array.isArray(adapter.env) ? String(adapter.env.length) : '0',
  ]))
}

function formatChatAck(value: JsonValue): string {
  if (!isRecord(value)) return formatJsonPretty(value)
  return value.accepted
    ? `Accepted turn ${String(value.turnId ?? '')}\n`
    : `${JSON.stringify(value, null, 2)}\n`
}

function formatAgentControl(action: 'start' | 'stop' | 'abort', agent: string, value: JsonValue): string {
  if (!isRecord(value)) return formatJsonPretty(value)
  if (value.success !== true) return `${JSON.stringify(value, null, 2)}\n`
  if (action === 'start') {
    const details = [
      value.loaded === true ? 'loaded' : '',
      value.startupTriggered === false ? 'no startup trigger fired' : '',
    ].filter(Boolean)
    return `Started ${agent}${details.length > 0 ? ` (${details.join(', ')})` : ''}\n`
  }
  if (action === 'abort') return `Aborted current turn for ${agent}\n`
  return `Stopped ${agent}\n`
}

function formatTaskResolution(action: 'approve' | 'deny', taskId: string, value: JsonValue): string {
  if (!isRecord(value)) return formatJsonPretty(value)
  const task = isRecord(value.task) ? value.task : {}
  const status = typeof task.status === 'string' ? task.status : action === 'approve' ? 'approved' : 'denied'
  return `${action === 'approve' ? 'Approved' : 'Denied'} ${taskId} (${status})\n`
}

function formatEvent(value: JsonValue): string {
  if (!isRecord(value)) return JSON.stringify(value)
  const seq = String(value.seq ?? '')
  const type = String(value.type ?? '')
  const agent = value.agentId ? ` ${String(value.agentId)}` : ''
  const payload = isRecord(value.payload) ? value.payload : {}
  const detail = typeof payload.message === 'string'
    ? payload.message
    : typeof payload.type === 'string'
      ? payload.type
      : ''
  return `[${seq}] ${type}${agent}${detail ? ` ${detail}` : ''}`
}

function formatJsonPretty(value: JsonValue): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, i) => Math.max(header.length, ...rows.map(row => (row[i] ?? '').length)))
  const renderRow = (row: string[]) => row.map((cell, i) => cell.padEnd(widths[i])).join('  ')
  return `${renderRow(headers)}\n${widths.map(width => '-'.repeat(width)).join('  ')}\n${rows.map(renderRow).join('\n')}\n`
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`
}

function formatNumber(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : ''
}

function enc(value: string): string {
  return encodeURIComponent(value)
}

function isRecord(value: JsonValue | unknown): value is Record<string, JsonValue> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function usage(): string {
  return `Usage: adf [--url <daemon-url>] [--json] <command>

Commands:
  agents                         List loaded agents
  status <agent>                 Show runtime status
  start <agent>                  Start an agent and fire startup when applicable
  stop <agent>                   Stop and unload an agent
  unload <agent>                 Alias for stop
  abort <agent>                  Abort an agent's current turn without unloading
  runtime [agent]                Show daemon or agent runtime diagnostics
  providers                      Show provider configuration and agent resolution
  auth                           Show auth and credential presence
  settings                       Show sanitized daemon runtime settings
  network                        Show mesh and WebSocket diagnostics
  network mesh [enable|disable]  Control daemon mesh registration
  network server [start|stop|restart]
                                  Control the mesh HTTP server
  network tools|lan|runtimes     Show mesh tools, LAN addresses, or peers
  usage [agent]                  Show runtime or agent token usage
  config <agent>                 Show agent config
  files <agent>                  List agent files
  file <agent> <path>            Print one agent file
  inbox <agent>                  List inbox messages
  outbox <agent>                 List outbox messages
  timers <agent>                 List timers
  tasks <agent>                  List tasks and pending approvals
  task <agent> <taskId>          Show one task
  approve <agent> <taskId>       Approve a pending task
  deny <agent> <taskId> [reason] Deny a pending task
  asks <agent>                   List pending ask requests
  answer <agent> <requestId> <answer>
                                  Answer a pending ask request
  identities <agent>             List identity metadata without secret values
  mcp [agent]                    Show daemon MCP registrations or agent MCP state
  adapters [agent]               Show daemon adapter registrations or agent adapter state
  events [agent]                 Follow daemon SSE events
  chat <agent> <message>         Send chat and print the accepted turn id

Environment:
  ADF_DAEMON_URL                 Defaults to ${DEFAULT_DAEMON_URL}`
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli().then(code => { process.exitCode = code })
}
