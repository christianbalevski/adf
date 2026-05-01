import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'

// Sandbox callers pass data as string (text frame) or Uint8Array (binary frame).
// LLM tool-call callers pass string only; set binary: true and the string is
// treated as base64 and decoded before dispatch.
const InputSchema = z.object({
  connection_id: z.string().describe('Target connection ID'),
  data: z.union([
    z.string(),
    z.instanceof(Uint8Array)
  ]).describe('Text (string) or binary (Uint8Array). From LLM tool calls, pass base64 string with binary: true.'),
  binary: z.boolean().optional().describe('If true and data is a string, decode it as base64 and send as a binary frame.')
})

export type WsSendFn = (
  connectionId: string,
  data: string | Uint8Array
) => Promise<{ success: boolean; error?: string }>

export class WsSendTool implements Tool {
  readonly name = 'ws_send'
  readonly description = 'Send text or binary data over an active WebSocket connection. Awaits socket drain when buffered bytes exceed the connection high-water mark.'
  readonly inputSchema = InputSchema
  readonly category = 'communication' as const

  private sendFn: WsSendFn

  constructor(sendFn: WsSendFn) {
    this.sendFn = sendFn
  }

  async execute(input: unknown, _workspace: AdfWorkspace): Promise<ToolResult> {
    const parsed = input as z.infer<typeof InputSchema>

    let payload: string | Uint8Array
    if (parsed.binary === true && typeof parsed.data === 'string') {
      try {
        payload = Buffer.from(parsed.data, 'base64')
      } catch (err) {
        return { content: `Invalid base64 data: ${err}`, isError: true }
      }
    } else {
      payload = parsed.data
    }

    const result = await this.sendFn(parsed.connection_id, payload)
    if (!result.success) {
      return { content: result.error ?? 'Failed to send.', isError: true }
    }

    return { content: 'Sent.', isError: false }
  }

  toProviderFormat(): ToolProviderFormat {
    return {
      name: this.name,
      description: this.description,
      input_schema: zodToJsonSchema(this.inputSchema) as Record<string, unknown>
    }
  }
}
