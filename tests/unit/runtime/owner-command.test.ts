import { describe, it, expect, vi } from 'vitest'
import { runOwnerCommand, type OwnerCommandHost } from '../../../src/main/runtime/owner-command'
import { AdfCallHandler } from '../../../src/main/runtime/adf-call-handler'
import { SysLambdaTool } from '../../../src/main/tools/built-in/sys-lambda.tool'
import { CodeSandboxService } from '../../../src/main/runtime/code-sandbox'

function fixture(source = 'export function run(x) { return x }', fileAuthorized = false) {
  const record = vi.fn((_text: string) => ({ deferred: false, seq: 4 }))
  const handler = { getEnabledToolNames: () => ['sys_update_config'], getHilToolNames: () => ['sys_update_config'], setAuthorizationContext: vi.fn(), handleCall: vi.fn(async () => ({ result: 'updated' })) }
  const workspace = { getAgentConfig: () => ({ id: 'command-test', commands: [{ name: 'test', lambda: 'lib/cmd.ts:run' }], limits: { execution_timeout_ms: 3000 } }), readFile: () => source, isFileAuthorized: () => fileAuthorized, insertLog: vi.fn() }
  const sandbox = new CodeSandboxService()
  const executor = { getState: () => 'idle', recordOwnerCommand: record, boundToolResult: (s: string) => s }
  const host = { workspace, executor, adfCallHandler: handler, codeSandboxService: sandbox, loopPool: { hasLoop: (s: string) => s === 'main', getRuntime: () => null } } as unknown as OwnerCommandHost
  return { host, sandbox, handler, record }
}
const req = { name: 'test', args: 'hello world', authorize: false, requestId: 'one' }

describe('owner commands', () => {
  it('refuses malformed requests and missing runtime resources without writing', async () => {
    const f = fixture()
    for (const patch of [{ args: 'x\ny' }, { args: 'x'.repeat(4097) }, { requestId: '../x' }, { loop: 'missing' }, { name: 'missing' }]) {
      await expect(runOwnerCommand(f.host, { ...req, ...patch })).rejects.toMatchObject({ name: 'OwnerCommandRefusedError' })
    }
    expect(f.record).not.toHaveBeenCalled()
  })
  it.each([
    ['export function run() { return "verbatim" }', 'verbatim'],
    ['export function run() { return {a: 1} }', '{\n  "a": 1\n}'],
    ['export function run() {}', '(no return value)'],
    ['export function run() { console.log("hello"); return "done" }', 'done\n\nOutput:\nhello'],
  ])('serializes sandbox return and stdout', async (source, expected) => {
    const f = fixture(source)
    const result = await runOwnerCommand(f.host, req)
    expect(result).toMatchObject({ status: 'ok', result: expected, seq: 4 })
    expect(f.record.mock.calls[0][0]).toContain(expected)
    expect(f.handler.setAuthorizationContext).not.toHaveBeenCalled()
    expect((f.sandbox as any).workers.size).toBe(0)
  })
  it('elevates only one invocation and destroys its worker', async () => {
    const f = fixture('export async function run() { return await adf.sys_update_config({}) }')
    expect((await runOwnerCommand(f.host, req)).status).toBe('denied')
    expect((await runOwnerCommand(f.host, { ...req, authorize: true })).status).toBe('ok')
    expect((await runOwnerCommand(f.host, req)).status).toBe('denied')
    expect(f.handler.handleCall).toHaveBeenCalledTimes(1)
    expect(f.handler.setAuthorizationContext).not.toHaveBeenCalled()
    expect((f.sandbox as any).workers.size).toBe(0)
  })
  it('honors existing file authorization and records missing functions as errors', async () => {
    const f = fixture('export function missing() {}', true)
    const result = await runOwnerCommand(f.host, req)
    expect(result).toMatchObject({ status: 'error', authorized: true })
    expect(result.result).toContain('Declare it at the top level, or fix commands[].lambda for /test.')
  })
  it('nested sys_lambda attenuates an elevated caller to the nested file authority', async () => {
    const f = fixture('export async function run() { return await adf.sys_lambda({source: "inner.ts:run"}) }')
    const workspace = f.host.workspace as any
    const outerRead = workspace.readFile
    workspace.readFile = (p: string) => p === 'inner.ts' ? 'export async function run() { try { await adf.sys_update_config({}) } catch(e) { return "nested denied: " + e.message } }' : outerRead(p)
    const config = { ...workspace.getAgentConfig(), tools: [{ name: 'sys_update_config', enabled: true, restricted: true }, { name: 'sys_lambda', enabled: true }] }
    let lambda: SysLambdaTool
    const handler = new AdfCallHandler({ workspace, config, provider: {} as never, toolRegistry: { get: (name: string) => name === 'sys_lambda' ? lambda : undefined, executeTool: vi.fn() } as never })
    lambda = new SysLambdaTool(f.sandbox, handler, 'command-test')
    f.host.adfCallHandler = handler
    const result = await runOwnerCommand(f.host, { ...req, authorize: true })
    expect(result.status).toBe('ok')
    expect(result.result).toContain('nested denied')
    expect(result.result).toContain('authorized')
    f.sandbox.destroyAll()
  })
  it.each(['loop_manage', 'sys_update_config'])('inner loop refuses %s even when elevated and records there', async method => {
    const f = fixture(`export async function run() { return await adf.${method}({}) }`)
    const workspace = f.host.workspace
    const handler = new AdfCallHandler({ workspace, config: { ...workspace.getAgentConfig(), metadata: { loop_name: 'side' }, tools: [] }, provider: {} as never, toolRegistry: { get: () => ({ name: method }), executeTool: vi.fn() } as never })
    const innerRecord = vi.fn((_text: string) => ({ deferred: false, seq: 8 }))
    f.host.loopPool = { hasLoop: () => true, getRuntime: () => ({ workspace, callHandler: handler, executor: { ...f.host.executor, getState: () => 'idle', boundToolResult: (s: string) => s, recordOwnerCommand: innerRecord } }) } as any
    const result = await runOwnerCommand(f.host, { ...req, loop: 'side', authorize: true })
    expect(result.status).toBe('error')
    expect(innerRecord).toHaveBeenCalledOnce()
    expect(f.record).not.toHaveBeenCalled()
  })

  it.each([['export function run(){ throw new Error("broken") }', 'broken'], ['export function run(){ return new Promise(() => {}) }', 'timed out']])('records runtime errors including timeout', async (source, message) => {
    const f = fixture(source)
    const result = await runOwnerCommand(f.host, req)
    expect(result.status).toBe('error')
    expect(result.result.toLowerCase()).toContain(message)
    expect(f.record).toHaveBeenCalledOnce()
  })
  it('records a missing file and malformed lambda instead of refusing', async () => {
    const f = fixture()
    ;(f.host.workspace as any).readFile = () => null
    expect((await runOwnerCommand(f.host, req)).result).toContain('Fix commands[].lambda for /test or create the file.')
    const config = f.host.workspace.getAgentConfig()
    config.commands![0].lambda = 'lib/cmd.ts:evil;bad'
    ;(f.host.workspace as any).getAgentConfig = () => config
    expect((await runOwnerCommand(f.host, req)).status).toBe('error')
    expect(f.record).toHaveBeenCalledTimes(2)
  })
  it('denies restricted methods through the real call handler', async () => {
    const f = fixture('export async function run(){ return await adf.get_identity({purpose: "test"}) }')
    const workspace = f.host.workspace
    f.host.adfCallHandler = new AdfCallHandler({ workspace, config: { ...workspace.getAgentConfig(), tools: [], code_execution: { restricted_methods: ['get_identity'] } as any }, provider: {} as never, toolRegistry: {} as never })
    expect((await runOwnerCommand(f.host, req)).status).toBe('denied')
  })

})

it('skips malformed raw entries when looking up a valid command', async () => {
  const f = fixture('export function run(){ return "valid" }')
  const config = f.host.workspace.getAgentConfig()
  ;(config as any).commands = [null, 7, ...config.commands!]
  vi.spyOn(f.host.workspace, 'getAgentConfig').mockReturnValue(config)
  expect(await runOwnerCommand(f.host, req)).toMatchObject({ status: 'ok', result: 'valid' })
})
it.each([null, {}, 'bad'])('refuses non-array command config safely: %j', async commands => {
  const f = fixture()
  vi.spyOn(f.host.workspace, 'getAgentConfig').mockReturnValue({ ...f.host.workspace.getAgentConfig(), commands } as any)
  await expect(runOwnerCommand(f.host, req)).rejects.toMatchObject({ code: 'command_not_found' })
  expect(f.record).not.toHaveBeenCalled()
})

it.each([undefined, null, {}])('records malformed raw lambda values as parseable command errors: %j', async lambda => {
  const f = fixture()
  const config = f.host.workspace.getAgentConfig()
  ;(config.commands![0] as any).lambda = lambda
  vi.spyOn(f.host.workspace, 'getAgentConfig').mockReturnValue(config)
  expect(await runOwnerCommand(f.host, req)).toMatchObject({ status: 'error', result: expect.stringContaining('Lambda must be') })
  const text = f.record.mock.calls[0][0]
  const header = JSON.parse(text.slice(text.indexOf('{'), text.indexOf('\n')))
  expect(typeof header.lambda).toBe('string')
})
