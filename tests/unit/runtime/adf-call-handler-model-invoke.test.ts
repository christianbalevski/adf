/**
 * model_invoke input shapes — pins the `prompt`/`system` shorthand.
 *
 * The sys_code tool description documents `adf.model_invoke({ prompt: "..." })`,
 * so the handler must accept that shape (converted to a single user message),
 * not just the canonical `messages` array.
 */

import { describe, expect, it, vi } from 'vitest'
import { AdfCallHandler } from '../../../src/main/runtime/adf-call-handler'
import type { AgentConfig } from '../../../src/shared/types/adf-v02.types'
import type { CreateMessageOptions } from '../../../src/main/providers/provider.interface'

vi.mock('../../../src/main/services/token-usage.service', () => ({
  getTokenUsageService: () => ({ recordUsage: () => { /* noop */ } }),
}))
vi.mock('../../../src/main/runtime/emit-umbilical', () => ({
  emitUmbilicalEvent: () => { /* noop */ },
}))

function makeHandler() {
  const providerCalls: CreateMessageOptions[] = []
  const provider = {
    providerId: 'test',
    name: 'test',
    modelId: 'test-model',
    createMessage: async (options: CreateMessageOptions) => {
      providerCalls.push(options)
      return {
        content: [{ type: 'text', text: 'model says hi' }],
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: 'end_turn',
      }
    },
  }

  const workspace = {
    insertLog: () => { /* noop */ },
  }

  const config = {
    name: 'test-agent',
    id: 'test-agent',
    tools: [],
    model: { model_id: 'test-model' },
    code_execution: { model_invoke: true } as AgentConfig['code_execution'],
  } as unknown as AgentConfig

  const handler = new AdfCallHandler({
    toolRegistry: { get: () => null, executeTool: async () => ({ content: '', isError: false }) } as never,
    workspace: workspace as never,
    config,
    provider: provider as never,
  })

  return { handler, providerCalls }
}

describe('model_invoke input shapes', () => {
  it('accepts the canonical messages array', async () => {
    const { handler, providerCalls } = makeHandler()
    const result = await handler.handleCall('model_invoke', {
      messages: [{ role: 'user', content: 'hello' }],
    })
    expect(result.error).toBeUndefined()
    expect(result.result).toBe('model says hi')
    expect(providerCalls[0].messages).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('accepts the prompt shorthand as a single user message', async () => {
    const { handler, providerCalls } = makeHandler()
    const result = await handler.handleCall('model_invoke', { prompt: 'hello' })
    expect(result.error).toBeUndefined()
    expect(result.result).toBe('model says hi')
    expect(providerCalls[0].messages).toEqual([{ role: 'user', content: 'hello' }])
    expect(providerCalls[0].system).toBe('')
  })

  it('prepends the system shorthand when prompt is used', async () => {
    const { handler, providerCalls } = makeHandler()
    const result = await handler.handleCall('model_invoke', { prompt: 'hello', system: 'be brief' })
    expect(result.error).toBeUndefined()
    expect(providerCalls[0].system).toBe('be brief')
    expect(providerCalls[0].messages).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('ignores prompt when a non-empty messages array is given', async () => {
    const { handler, providerCalls } = makeHandler()
    const result = await handler.handleCall('model_invoke', {
      prompt: 'ignored',
      messages: [{ role: 'user', content: 'from messages' }],
    })
    expect(result.error).toBeUndefined()
    expect(providerCalls[0].messages).toEqual([{ role: 'user', content: 'from messages' }])
  })

  it('rejects a call with neither messages nor prompt, with a self-explanatory error', async () => {
    const { handler } = makeHandler()
    const result = await handler.handleCall('model_invoke', {})
    expect(result.errorCode).toBe('INVALID_INPUT')
    expect(result.error).toContain('prompt')
    expect(result.error).toContain('messages')
  })

  it('rejects an empty prompt string', async () => {
    const { handler } = makeHandler()
    const result = await handler.handleCall('model_invoke', { prompt: '' })
    expect(result.errorCode).toBe('INVALID_INPUT')
  })
})
