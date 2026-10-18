import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/main/runtime/emit-umbilical', () => ({
  emitUmbilicalEvent: vi.fn(),
  registerDaemonEventBus: vi.fn(),
}))

import { WsConnectionManager } from '../../../src/main/services/ws-connection-manager'
import { CodeSandboxService } from '../../../src/main/runtime/code-sandbox'

/**
 * A WS lambda's HIL tool calls are gated by the sandbox worker on
 * `toolConfig.isAuthorized`, the same as an API-route lambda's. The WS path
 * handed the worker the delegate's `{ enabledTools, hilTools }` without
 * `isAuthorized`, so the worker refused every HIL tool with
 * REQUIRES_AUTHORIZED_CODE even when the lambda's file was authorized.
 * Runs a real sandbox worker: the gate under test lives inside it.
 */

const AGENT_PATH = '/agents/ws-agent.adf'
const LAMBDA_FILE = 'lib/ws.ts'
const sandbox = new CodeSandboxService()
afterAll(() => sandbox.destroy(`${AGENT_PATH}:ws`))

async function dispatchCallingHilTool(fileAuthorized: boolean) {
  const handleCall = vi.fn(async () => ({ result: JSON.stringify({ deleted: true }) }))
  const logs: Array<{ level: string; message: string }> = []
  const workspace = {
    getAgentConfig: () => ({ id: 'ws-agent', limits: { execution_timeout_ms: 20_000 } }),
    insertLog: (level: string, _origin: string, _event: string, _target: unknown, message: string) => {
      logs.push({ level, message })
    },
    readFile: (p: string) => p === LAMBDA_FILE
      ? 'export async function onMessage(event) { return await adf.fs_delete({ path: "scratch.txt" }) }'
      : null,
    isFileAuthorized: (p: string) => p === LAMBDA_FILE && fileAuthorized,
  }
  const delegate = {
    getAgentDid: () => null,
    getPrivateKey: () => null,
    getPublicKey: () => null,
    processIngressMessage: async () => ({}),
    getCodeSandbox: () => sandbox,
    getAdfCallHandler: () => ({ handleCall }),
    getWorkspace: () => workspace,
    getToolConfig: () => ({ enabledTools: ['fs_delete'], hilTools: ['fs_delete'] }),
    getAllowUnsigned: () => true,
  } as unknown as ConstructorParameters<typeof WsConnectionManager>[0]

  const manager = new WsConnectionManager(delegate)
  const conn = {
    id: 'conn-1',
    agentFilePath: AGENT_PATH,
    agentId: 'ws-agent',
    direction: 'inbound',
    lambdaRef: `${LAMBDA_FILE}:onMessage`,
  }
  // White-box: dispatchToLambda is the frame → lambda hot path; driving it
  // directly skips a real socket handshake that adds nothing here.
  await (manager as unknown as {
    dispatchToLambda: (c: unknown, e: unknown) => Promise<void>
  }).dispatchToLambda(conn, { type: 'message', connection_id: 'conn-1', data: 'hi' })
  return { handleCall, logs }
}

describe('WS lambda authorization', () => {
  it('lets a lambda in an authorized file call a HIL tool', async () => {
    const { handleCall, logs } = await dispatchCallingHilTool(true)
    expect(logs.map((l) => l.message).join('\n')).not.toContain('authorized code')
    expect(handleCall).toHaveBeenCalledWith('fs_delete', expect.objectContaining({ path: 'scratch.txt' }))
  }, 30_000)

  it('still refuses a HIL tool from an unauthorized file', async () => {
    const { handleCall, logs } = await dispatchCallingHilTool(false)
    expect(handleCall).not.toHaveBeenCalled()
    expect(logs.map((l) => l.message).join('\n')).toContain('authorized code')
  }, 30_000)
})
