import { DEFAULT_BASE_PROMPT, DEFAULT_TOOL_PROMPTS, DEFAULT_DYNAMIC_PROMPTS, DEFAULT_COMPACTION_PROMPT } from './adf-defaults'
import { withBuiltInAdapterRegistrations } from './adapter-registry'
import { cloneComputeDefaults } from './compute-defaults'

/**
 * Full default settings store, shared by SettingsService (Studio) and
 * FileSettingsStore (daemon). Electron-free.
 *
 * Returns a fresh object on every call so callers can safely mutate nested
 * values (migrations do) without corrupting a shared module-level constant.
 */
export function createSettingsDefaults(): Record<string, unknown> {
  return {
    providers: [],
    theme: 'light',
    globalSystemPrompt: DEFAULT_BASE_PROMPT,
    // Dynamic instruction templates share the toolPrompts record (dyn_ keys)
    // so they ride the existing settings→executor plumbing.
    toolPrompts: { ...DEFAULT_TOOL_PROMPTS, ...DEFAULT_DYNAMIC_PROMPTS },
    compactionPrompt: DEFAULT_COMPACTION_PROMPT,
    trackedDirectories: [],
    // Empty = built-in default (Documents/adf-agents), resolved on demand.
    agentsFolder: '',
    meshEnabled: true,
    meshLan: false,
    meshPort: 7295,
    maxDirectoryScanDepth: 5,
    autoCompactThreshold: 100000,
    // Global sandbox worker ceiling. 0 = automatic (half the CPU cores,
    // clamped to 4..32) — see CodeSandboxService.setMaxWorkers.
    sandboxMaxWorkers: 0,
    mcpServers: [],
    adapters: withBuiltInAdapterRegistrations(),
    reviewedAgents: [] as string[],
    sandboxPackages: [],
    compute: cloneComputeDefaults(),
  }
}
