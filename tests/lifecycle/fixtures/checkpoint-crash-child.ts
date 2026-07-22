import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import type {
  CreateMessageOptions,
  LLMProvider,
} from '../../../src/main/providers/provider.interface'
import { createHeadlessAgent } from '../../../src/main/runtime/headless'
import { createDispatch, createEvent } from '../../../src/shared/types/adf-event.types'
import type { LLMResponse } from '../../../src/shared/types/provider.types'

const CHECKPOINT_KEY = 'adf_runtime_turn_checkpoint'
const filePath = process.argv[2]

if (!filePath) throw new Error('Expected a destination .adf path')

let workspace: AdfWorkspace | null = null
let keepAlive: ReturnType<typeof setInterval> | null = null

class CrashBoundaryProvider implements LLMProvider {
  readonly name = 'checkpoint-crash-boundary'
  readonly modelId = 'checkpoint-crash-boundary-v1'

  async createMessage(_options: CreateMessageOptions): Promise<LLMResponse> {
    const raw = workspace?.getMeta(CHECKPOINT_KEY)
    const checkpoint = raw ? JSON.parse(raw) as { status?: string; id?: string } : null
    if (checkpoint?.status !== 'in_progress') {
      throw new Error(`Expected an in-progress checkpoint, received ${raw ?? 'nothing'}`)
    }

    // The parent kills this process only after the executor has durably written
    // the checkpoint and the provider has observed it. Keep an active handle so
    // Node cannot exit merely because this promise never settles.
    keepAlive = setInterval(() => {}, 1_000)
    process.stdout.write(`CHECKPOINT_READY ${checkpoint.id ?? 'unknown'}\n`)
    return new Promise<LLMResponse>(() => {})
  }

  async validateConfig(): Promise<{ valid: boolean; error?: string }> {
    return { valid: true }
  }
}

const agent = createHeadlessAgent({
  filePath,
  name: 'checkpoint-crash-child',
  provider: new CrashBoundaryProvider(),
  profile: 'benchmark',
  createOptions: {
    autonomous: false,
    start_in_state: 'active',
  },
})
workspace = agent.workspace

await agent.start()
await agent.dispatch(createDispatch(
  createEvent({
    type: 'chat',
    source: 'test:lifecycle:crash-child',
    data: {
      message: {
        seq: 0,
        role: 'user',
        content_json: [{ type: 'text', text: 'turn interrupted by process crash' }],
        created_at: Date.now(),
      },
    },
  }),
  { scope: 'agent' },
))

if (keepAlive) clearInterval(keepAlive)
