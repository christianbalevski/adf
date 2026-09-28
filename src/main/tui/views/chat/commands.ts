// Chat commands. All target the selected agent + loop.

import { MAIN_LOOP } from '../../api/types'
import type { CommandContext, CommandContribution, CommandScope } from '../../commands/types'
import { transcriptKey } from '../../state/types'
import { oneLine, truncate } from '../../ui/text'
import { CHAT_VIEW, INITIAL_CHAT_STATE, copyToClipboard, loopTabs, cycleLoop, type ChatState } from './model'

/** Dispatchable ADF event types (docs/daemon/http-api.md, POST /agents/:id/trigger). */
export const TRIGGER_TYPES = ['startup', 'timer', 'inbox', 'outbox', 'file_change', 'chat', 'tool_call', 'task_create', 'task_complete', 'log_entry', 'llm_call']

export function readChatState(scope: Pick<CommandScope, 'state'>): ChatState {
  return (scope.state().viewState[CHAT_VIEW] as ChatState | undefined) ?? INITIAL_CHAT_STATE
}

const hasAgent = (scope: CommandScope) => !!scope.agentId

function toggleThinking(ctx: CommandContext) {
  const current = readChatState(ctx)
  ctx.actions.setViewState(CHAT_VIEW, { ...current, showThinking: !current.showThinking })
  ctx.print(current.showThinking ? 'Thinking collapsed' : 'Thinking expanded', 'info')
}

async function copyReply(ctx: CommandContext) {
  if (!ctx.agentId) return
  const items = ctx.state().transcripts[transcriptKey(ctx.agentId, ctx.loop)]?.items ?? []
  const back = Math.max(1, Number.parseInt(ctx.args[0] ?? '1', 10) || 1)
  const replies = items.filter(item => item.kind === 'assistant' && item.text.trim())
  const reply = replies[replies.length - back]
  if (!reply || reply.kind !== 'assistant') { ctx.print(`No reply in ${ctx.loop} to copy`, 'warn'); return }
  const ok = await copyToClipboard(reply.text)
  if (ok) ctx.print(`Copied ${back === 1 ? 'last reply' : `reply -${back}`} from ${ctx.loop} (${reply.text.length} chars)`, 'success')
  else ctx.print(`Clipboard unavailable. Reply: ${truncate(oneLine(reply.text), 300)}`, 'warn')
}

async function fireTrigger(ctx: CommandContext) {
  const agentId = ctx.agentId
  if (!agentId) return
  const [type] = ctx.args
  if (!type) { ctx.print(`Usage: /trigger <type> [json-data] — ${TRIGGER_TYPES.join(', ')}`, 'warn'); return }
  const raw = ctx.rest.trim().slice(type.length).trim()
  let data: unknown
  if (raw) {
    try { data = JSON.parse(raw) } catch { ctx.print('Trigger data must be JSON', 'warn'); return }
  }
  const body = { type, ...(data !== undefined ? { data } : {}), target: { scope: 'agent', ...(ctx.loop !== MAIN_LOOP ? { loop: ctx.loop } : {}) } }
  const result = await ctx.actions.run('Trigger', c => c.trigger(agentId, body))
  if (result) ctx.print(`Trigger ${type} queued for ${ctx.loop} (${result.turnId})`, 'success')
}

function stepLoop(ctx: CommandContext, delta: number) {
  if (!ctx.agentId) return
  const tabs = loopTabs(ctx.state().agents[ctx.agentId])
  ctx.actions.selectLoop(ctx.agentId, cycleLoop(tabs, ctx.loop, delta))
}

export const chatCommands: CommandContribution = {
  commands: [
    {
      name: 'interrupt',
      aliases: ['abort'],
      description: 'End the selected loop’s running turn; the loop goes idle and keeps working (Esc)',
      available: hasAgent,
      run: ctx => ctx.actions.interrupt(ctx.agentId ?? undefined, ctx.loop),
    },
    {
      name: 'clear',
      description: 'Clear the selected loop’s history (archived per the agent’s audit settings)',
      available: hasAgent,
      run: async ctx => {
        if (!ctx.agentId) return
        const ok = await ctx.actions.confirm({ title: 'Clear history', message: `Clear the "${ctx.loop}" loop's history? Other loops are not touched.`, confirmLabel: 'Clear', danger: true })
        if (ok) await ctx.actions.clearLoopHistory(ctx.agentId, ctx.loop)
      },
    },
    {
      name: 'compact',
      description: 'Summarize the selected loop’s history now to free context (not while it is mid-turn)',
      available: hasAgent,
      run: async ctx => {
        if (!ctx.agentId) return
        await ctx.actions.compactLoop(ctx.agentId, ctx.loop)
      },
    },
    {
      name: 'trigger',
      args: '<type> [json-data]',
      description: 'Fire an ADF event into the selected loop (bypasses trigger config)',
      available: hasAgent,
      complete: partial => TRIGGER_TYPES.filter(t => t.startsWith(partial.trim())),
      run: fireTrigger,
    },
    {
      name: 'copy',
      args: '[n]',
      description: 'Copy the last (or n-th last) reply of the selected loop to the clipboard',
      available: hasAgent,
      run: copyReply,
    },
    {
      name: 'thinking',
      description: 'Expand or collapse thinking blocks in chat (t)',
      run: toggleThinking,
    },
  ],
  actions: [
    { id: 'chat.abort', title: 'Interrupt running turn', group: 'Chat', shortcut: 'esc', available: hasAgent, run: ctx => ctx.actions.interrupt(ctx.agentId ?? undefined, ctx.loop) },
    { id: 'chat.next-loop', title: 'Next loop', group: 'Chat', shortcut: 'shift+right', keywords: ['loop', 'tab'], available: hasAgent, run: ctx => stepLoop(ctx, 1) },
    { id: 'chat.prev-loop', title: 'Previous loop', group: 'Chat', shortcut: 'shift+left', keywords: ['loop', 'tab'], available: hasAgent, run: ctx => stepLoop(ctx, -1) },
    { id: 'chat.thinking', title: 'Toggle thinking blocks', group: 'Chat', shortcut: 't', run: toggleThinking },
    { id: 'chat.copy', title: 'Copy last reply', group: 'Chat', shortcut: 'c', available: hasAgent, run: ctx => copyReply({ ...ctx, args: [] }) },
    { id: 'chat.trigger', title: 'Fire a trigger into this loop…', group: 'Chat', available: hasAgent, run: ctx => ctx.actions.prefillPrompt('/trigger ') },
    { id: 'chat.compact', title: 'Compact this loop’s history now', group: 'Chat', keywords: ['summarize', 'context', 'tokens'], available: hasAgent, run: async ctx => { if (ctx.agentId) await ctx.actions.compactLoop(ctx.agentId, ctx.loop) } },
    { id: 'chat.clear', title: 'Clear this loop’s history…', group: 'Chat', available: hasAgent, run: ctx => ctx.actions.prefillPrompt('/clear') },
  ],
}
