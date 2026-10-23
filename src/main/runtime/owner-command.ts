import { nanoid } from 'nanoid'
import type { AssembledAgent } from './assemble-agent'
import type { AgentProfileName } from './agent-capability-profiles'
import type { AgentCommandInvocation } from '../../shared/types/adf-v02.types'
import { parseLambdaRef, splitArgv } from '../../shared/utils/agent-commands'
import { formatOwnerCommandRow } from '../../shared/utils/owner-command-row'
import { MAIN_LOOP } from './loop-pool'
import { loadLambdaSource } from './ts-transpiler'
import { transformImports, transformExports } from './code-sandbox'
import { withAuthorization } from './authorization-context'
import { withSource, withLoop } from './execution-context'
import { emitUmbilicalEvent } from './emit-umbilical'

export type OwnerCommandHost = Pick<AssembledAgent<AgentProfileName>, 'workspace' | 'executor' | 'adfCallHandler' | 'codeSandboxService' | 'loopPool'>
export interface OwnerCommandRequest { name: string; args: string; loop?: string; authorize: boolean; requestId?: string }
import type { OwnerCommandResult } from '../../shared/types/owner-command.types'
export type { OwnerCommandResult } from '../../shared/types/owner-command.types'
export class OwnerCommandRefusedError extends Error {
  constructor(message: string, readonly statusCode: 400 | 404 | 409, readonly code: string) { super(message); this.name = 'OwnerCommandRefusedError' }
}

export async function runOwnerCommand(host: OwnerCommandHost, req: OwnerCommandRequest): Promise<OwnerCommandResult> {
  if (!req || typeof req.name !== 'string' || typeof req.args !== 'string' || req.args.length > 4096 || /[\r\n]/.test(req.args) ||
      typeof req.authorize !== 'boolean' || (req.loop !== undefined && typeof req.loop !== 'string') ||
      (req.requestId !== undefined && (typeof req.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(req.requestId)))) {
    throw new OwnerCommandRefusedError('Invalid command request: args must be a single line of at most 4096 characters and requestId must use 1–64 letters, digits, underscores or hyphens.', 400, 'invalid_request')
  }
  const id = req.requestId ?? 'cmd_' + nanoid(10)
  const loop = req.loop || MAIN_LOOP
  if (!host.loopPool.hasLoop(loop)) throw new OwnerCommandRefusedError(`No loop named "${loop}" on this agent.`, 404, 'loop_not_found')
  const runtime = loop === MAIN_LOOP ? null : host.loopPool.getRuntime(loop)
  const executor = loop === MAIN_LOOP ? host.executor : runtime?.executor
  const handler = loop === MAIN_LOOP ? host.adfCallHandler : runtime?.callHandler
  const workspace = loop === MAIN_LOOP ? host.workspace : runtime?.workspace
  if (!executor || !workspace) throw new OwnerCommandRefusedError(`Loop "${loop}" is not running (it is disabled or stopping). Enable it, then run the command again.`, 409, 'loop_not_running')
  if (executor.getState() === 'stopped') throw new OwnerCommandRefusedError(`Agent is off. Start it, then run /${req.name} again.`, 409, 'agent_not_running')
  const sandbox = host.codeSandboxService
  if (!sandbox || !handler) throw new OwnerCommandRefusedError('This runtime has no code sandbox, so agent commands cannot run here.', 409, 'code_execution_unavailable')
  const config = host.workspace.getAgentConfig()
  const command = Array.isArray(config.commands) ? config.commands.find(c => c && typeof c === 'object' && c.name === req.name) : undefined
  if (!command) throw new OwnerCommandRefusedError(`No command "/${req.name}" on this agent. Add it under Commands in the agent's config.`, 404, 'command_not_found')
  const lambda = typeof command.lambda === 'string' ? command.lambda : JSON.stringify(command.lambda) ?? 'undefined'
  const started = performance.now()
  let status: OwnerCommandResult['status'] = 'error'
  let authorized = false
  let body: string
  try {
    const ref = parseLambdaRef(lambda)
    if ('error' in ref) throw new Error(ref.error)
    const { file, fn } = ref
    const source = await loadLambdaSource(p => workspace.readFile(p), file)
    if (source === null) throw new Error(`Lambda file "${file}" not found. Fix commands[].lambda for /${req.name} or create the file.`)
    authorized = req.authorize === true || workspace.isFileAuthorized(file)
    const args = splitArgv(req.args).join(' ')
    const invocation: AgentCommandInvocation = { command: req.name, args, argv: splitArgv(args), invoker: 'owner', loop, authorized, id }
    const missing = `Function "${fn}" not found in "${file}". Declare it at the top level, or fix commands[].lambda for /${req.name}.`
    const wrapped = `${transformExports(transformImports(source))}\nif (typeof ${fn} === 'function') { return await ${fn}(${JSON.stringify(invocation)}); }\nthrow new Error(${JSON.stringify(missing)});`
    const sandboxId = `${config.id}:cmd:${file}:${id}:${nanoid(10)}`
    const payload = { lambda_path: file, function_name: fn, kind: 'owner_command', command: req.name, loop, authorized }
    emitUmbilicalEvent({ event_type: 'lambda.started', agentId: config.id, source: `lambda:${file}:${fn}`, payload })
    try {
      const run = () => sandbox.execute(sandboxId, wrapped, config.limits.execution_timeout_ms,
        (method, callArgs) => withAuthorization(authorized, () => handler.handleCall(method, callArgs)),
        { enabledTools: handler.getEnabledToolNames(), hilTools: handler.getHilToolNames(), isAuthorized: authorized },
        { handlerAuthorized: authorized, agent: config.id, ephemeral: true })
      const result = await withSource(`lambda:${file}:${fn}`, config.id, () => withLoop(loop, run))
      status = result.error ? (['REQUIRES_AUTHORIZED_CODE', 'REQUIRES_AUTHORIZED_CALLER', 'PROTECTION_DENIED'].includes(result.errorCode ?? '') ? 'denied' : 'error') : 'ok'
      body = result.error ?? result.result ?? '(no return value)'
      if (result.stdout) body += `\n\nOutput:\n${result.stdout}`
      emitUmbilicalEvent({ event_type: result.error ? 'lambda.failed' : 'lambda.completed', agentId: config.id, source: `lambda:${file}:${fn}`, payload: { ...payload, duration_ms: performance.now() - started, ...(result.error ? { error: result.error } : {}) } })
    } catch (error) {
      emitUmbilicalEvent({ event_type: 'lambda.failed', agentId: config.id, source: `lambda:${file}:${fn}`, payload: { ...payload, duration_ms: performance.now() - started, error: error instanceof Error ? error.message : String(error) } })
      throw error
    } finally { sandbox.destroy(sandboxId) }
  } catch (error) {
    body = error instanceof Error ? error.message : String(error)
  }
  const durationMs = +(performance.now() - started).toFixed(2)
  body = executor.boundToolResult(body!, '/' + req.name)
  const args = splitArgv(req.args).join(' ')
  const record = executor.recordOwnerCommand(formatOwnerCommandRow({ v: 1, id, command: '/' + req.name + (args ? ' ' + args : ''), lambda, authorized, status, duration_ms: durationMs }, body))
  try { workspace.insertLog(status === 'ok' ? 'info' : 'error', 'command', 'run', '/' + req.name, `${status} (${durationMs}ms)`, { status, duration_ms: durationMs, authorized, loop }) } catch { /* runtime may have closed during execution */ }
  return { id, name: req.name, loop, status, authorized, result: body, durationMs, ...record }
}
