import { IPC } from '../../../src/shared/constants/ipc-channels'
import type { ParityScenario } from '../harness/scenario'

/**
 * W5-D2: Studio's own file writes carry the origin `system:studio` in both
 * backends (embedded: the IPC handlers' withSource; daemon: the write of
 * Studio's client session). A system-scope on_file_change lambda that acts
 * only on writes whose `event.source` is `system:studio` fires the same way
 * in both: it records what it saw in seen/by-studio.txt.
 */

const LAMBDA = `export async function onChange(event) {
  if (event.source !== 'system:studio') return
  await adf.fs_write({ mode: 'write', path: 'seen/by-studio.txt', content: event.data.path + ' from ' + event.source })
}
`

type AgentEvent = { type?: string; payload?: { path?: string } }
const fileUpdated = (path: string) => (p: unknown) => (p as AgentEvent)?.type === 'file_updated' && (p as AgentEvent).payload?.path === path

export const studioWriteSourceScenario: ParityScenario = {
  name: 'w5d2-studio-write-source',
  description:
    'A system lambda on notes/* that acts only on writes from system:studio: Studio writes notes/a.md, the lambda records the write in seen/by-studio.txt, and Studio reads it.',
  fixtures: [{
    name: 'agent-1',
    triggers: { on_file_change: { enabled: true, targets: [{ scope: 'system', filter: { watch: 'notes/*' }, lambda: 'lib/watch.ts:onChange' }] } },
  }],
  quietMs: 1000,
  llm: () => ({ text: 'ok' }),
  async run(ctx) {
    const agent = ctx.agent('agent-1')
    await ctx.invoke(IPC.FILE_OPEN, { filePath: agent.filePath })
    await ctx.invoke(IPC.DOC_WRITE_INTERNAL_FILE, { path: 'lib/watch.ts', content: LAMBDA })
    await ctx.invoke(IPC.AGENT_START, { filePath: agent.filePath })
    await ctx.invoke(IPC.DOC_WRITE_INTERNAL_FILE, { path: 'notes/a.md', content: 'from Studio' })
    await ctx.waitForPush(IPC.AGENT_EVENT, 'the lambda\'s write', fileUpdated('seen/by-studio.txt'), 30_000)
    await ctx.invoke(IPC.DOC_READ_INTERNAL_FILE, { path: 'seen/by-studio.txt', binaryContent: false })
    await ctx.invoke(IPC.AGENT_STOP)
  },
}

export const WRITE_SOURCE_SCENARIOS: readonly ParityScenario[] = [studioWriteSourceScenario]
