import { IPC } from '../../../src/shared/constants/ipc-channels'
import type { ParityScenario, ScenarioContext } from '../harness/scenario'

/**
 * Atomic multi-file writes of the open agent (DOC_WRITE_INTERNAL_FILES):
 * the skill browser's install path. The same answers, revisions and final
 * state in both backends:
 *
 * - a batch names the file it means; another open file writes nothing;
 * - every file carries mustNotExist or the revision read; one stale or
 *   existing path refuses the whole batch and leaves every file as it was;
 * - binary bytes arrive exactly, and a binary read carries its revision;
 * - a malformed batch (traversal, no precondition) is refused before any write.
 */

type Answer = { success?: boolean; code?: string; revisions?: Record<string, number>; revision?: number; content?: string | null }

async function openAgent(ctx: ScenarioContext, filePath: string): Promise<void> {
  await ctx.invoke(IPC.FILE_OPEN, { filePath })
  await ctx.invoke(IPC.DOC_GET_BATCH)
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 25))

const MANIFEST = '---\nname: alpha\ndescription: Does alpha.\n---\n\n# Alpha\n'
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10]).toString('base64')

export const fileBatchScenario: ParityScenario = {
  name: 'skills-file-batch',
  description:
    'Install a package as one batch into agent-1; a batch naming agent-1 while agent-2 is open writes nothing; reinstall over the revisions read; a stale revision and an existing path refuse the whole batch; malformed batches are refused.',
  fixtures: [{ name: 'agent-1' }, { name: 'agent-2' }],
  quietMs: 800,
  llm: () => ({ text: 'ok' }),
  async run(ctx) {
    const one = ctx.agent('agent-1')
    const two = ctx.agent('agent-2')
    await openAgent(ctx, one.filePath)

    // Fresh install: resources first, SKILL.md last, every path must not exist.
    const installed = await ctx.invoke<Answer>(IPC.DOC_WRITE_INTERNAL_FILES, {
      expectFilePath: one.filePath,
      files: [
        { path: 'skills/alpha/ref.md', content: '# ref v1', mustNotExist: true },
        { path: 'skills/alpha/assets/logo.png', contentBase64: PNG, mustNotExist: true },
        { path: 'skills/alpha/SKILL.md', content: MANIFEST, mustNotExist: true },
      ],
    })
    const manifest = await ctx.invoke<Answer>(IPC.DOC_READ_INTERNAL_FILE, { path: 'skills/alpha/SKILL.md', binaryContent: false })
    const logo = await ctx.invoke<Answer>(IPC.DOC_READ_INTERNAL_FILE, { path: 'skills/alpha/assets/logo.png', binaryContent: true })
    const ref = await ctx.invoke<Answer>(IPC.DOC_READ_INTERNAL_FILE, { path: 'skills/alpha/ref.md', binaryContent: false })

    // The same create again: SKILL.md exists, so nothing at all is written.
    await ctx.invoke(IPC.DOC_WRITE_INTERNAL_FILES, {
      expectFilePath: one.filePath,
      files: [
        { path: 'skills/alpha/new.md', content: 'new', mustNotExist: true },
        { path: 'skills/alpha/SKILL.md', content: MANIFEST, mustNotExist: true },
      ],
    })

    // Another agent in the foreground: a batch naming agent-1 writes to neither.
    // First let the coalesced WORKSPACE_DATA_CHANGED hint of the install (250 ms)
    // land while agent-1 is still open: daemon mode delivers it for the open
    // file only, embedded mode to the window whatever is open.
    await new Promise((resolve) => setTimeout(resolve, 400))
    await openAgent(ctx, two.filePath)
    await ctx.invoke(IPC.DOC_WRITE_INTERNAL_FILES, {
      expectFilePath: one.filePath,
      files: [{ path: 'skills/alpha/elsewhere.md', content: 'x', mustNotExist: true }],
    })

    // Back on agent-1: reinstall over the revisions read before the switch.
    // (The pauses keep a refusal's revision strictly before its step in the
    // recording's time normalization; they change nothing being tested.)
    await openAgent(ctx, one.filePath)
    await pause()
    await ctx.invoke(IPC.DOC_WRITE_INTERNAL_FILES, {
      expectFilePath: one.filePath,
      files: [
        { path: 'skills/alpha/ref.md', content: '# ref v2', baseRevision: ref?.revision },
        { path: 'skills/alpha/assets/logo.png', contentBase64: PNG, baseRevision: logo?.revision },
        { path: 'skills/alpha/SKILL.md', content: MANIFEST.replace('# Alpha', '# Alpha v2'), baseRevision: manifest?.revision },
      ],
    })

    // The same revisions again are stale now: refused, v2 stays.
    await pause()
    await ctx.invoke(IPC.DOC_WRITE_INTERNAL_FILES, {
      expectFilePath: one.filePath,
      files: [
        { path: 'skills/alpha/ref.md', content: '# ref v3', baseRevision: ref?.revision },
        { path: 'skills/alpha/SKILL.md', content: MANIFEST, baseRevision: manifest?.revision },
      ],
    })

    // Malformed: traversal, and a file with no precondition.
    await ctx.invoke(IPC.DOC_WRITE_INTERNAL_FILES, { expectFilePath: one.filePath, files: [{ path: 'skills/../x.md', content: 'x', mustNotExist: true }] })
    await ctx.invoke(IPC.DOC_WRITE_INTERNAL_FILES, { expectFilePath: one.filePath, files: [{ path: 'skills/alpha/y.md', content: 'y' }] })

    await ctx.invoke(IPC.DOC_READ_INTERNAL_FILE, { path: 'skills/alpha/ref.md', binaryContent: false })
    await ctx.invoke(IPC.DOC_READ_INTERNAL_FILE, { path: 'skills/alpha/SKILL.md', binaryContent: false })
    void installed
  },
}

export const FILE_BATCH_SCENARIOS: readonly ParityScenario[] = [fileBatchScenario]
