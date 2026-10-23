import { expect } from 'vitest'
import { IPC } from '../../../src/shared/constants/ipc-channels'
import type { ParityScenario } from '../harness/scenario'

type CommandReply = { success: boolean; status?: string; code?: string }
type Event = { type?: string; payload?: { category?: string; content?: string; state?: string } }

export const agentCommandScenario: ParityScenario = {
  name: 'agent-command',
  description: 'Owner commands run without a model turn, deny restricted config writes until elevated, and replay all three outcomes as user text at the next chat.',
  fixtures: [{ name: 'agent-1', commands: [
    { name: 'echo', description: 'Echo args', lambda: 'lib/commands.ts:echo' },
    { name: 'cfg', description: 'Update description', lambda: 'lib/commands.ts:cfg' },
  ], files: { 'lib/commands.ts': `export function echo({ args }) { return args }
export async function cfg() { return await adf.sys_update_config({ path: 'description', value: 'Command updated description' }) }` } }],
  quietMs: 1000,
  llm: req => {
    if (req.isPreflight) return { text: 'ok' }
    const records = req.messages.filter(m => m.text.includes('[Owner command] '))
    expect(records, JSON.stringify(req.messages)).toHaveLength(3)
    expect(records.every(m => m.role === 'user' && !m.toolCalls && !m.toolCallId)).toBe(true)
    return { text: 'I can see all three command outcomes.' }
  },
  async run(ctx) {
    const { filePath } = ctx.agent('agent-1')
    await ctx.invoke(IPC.FILE_OPEN, { filePath })
    await ctx.invoke(IPC.DOC_GET_BATCH)
    await ctx.invoke(IPC.AGENT_START, { filePath, hasUserMessage: true })
    for (const [name, authorize, requestId, status] of [
      ['echo', false, 'echo-1', 'ok'], ['cfg', false, 'cfg-1', 'denied'], ['cfg', true, 'cfg-2', 'ok'],
    ] as const) {
      const res = await ctx.invoke<CommandReply>(IPC.AGENT_RUN_COMMAND, { filePath, loop: 'main', name, args: name === 'echo' ? 'hi' : '', authorize, requestId })
      expect(res).toMatchObject({ success: true, status })
      await ctx.waitForPush(IPC.AGENT_EVENT, `${requestId} recorded`, p => {
        const event = p as Event
        return event.type === 'context_injected' && event.payload?.content?.includes(`"id":"${requestId}"`) === true
      })
    }
    expect(await ctx.invoke(IPC.AGENT_RUN_COMMAND, { filePath, name: 'nope', args: '', authorize: false, requestId: 'nope-1' })).toMatchObject({ success: false, code: 'command_not_found' })
    await ctx.invoke(IPC.AGENT_INVOKE, { filePath, userMessage: 'What happened? /echo !authorize is just chat text.' })
    await ctx.waitForPush(IPC.AGENT_EVENT, 'chat complete', p => (p as Event).type === 'turn_complete')
    await ctx.waitForPush(IPC.AGENT_EVENT, 'idle', p => (p as Event).type === 'state_changed' && (p as Event).payload?.state === 'idle')
    await ctx.invoke(IPC.DOC_GET_CHAT, {})
    await ctx.invoke(IPC.AGENT_STOP)
  },
}
export const COMMAND_SCENARIOS = [agentCommandScenario]
