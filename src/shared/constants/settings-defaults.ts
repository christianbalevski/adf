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
    // "Agent template": overrides only; empty = code defaults
    // (DEFAULT_AGENT_CONFIG). See src/shared/utils/agent-template.ts.
    agentTemplate: {},
    theme: 'light',
    // Interface typeface preset + free-text family for 'custom'; see
    // UI_FONT_STACKS in the renderer's app.store.
    uiFont: 'system',
    uiFontCustom: '',
    // Electron zoom factor for the whole window (1 = 100%).
    uiScale: 1,
    globalSystemPrompt: DEFAULT_BASE_PROMPT,
    // Dynamic instruction templates share the toolPrompts record (dyn_ keys)
    // so they ride the existing settings→executor plumbing.
    toolPrompts: { ...DEFAULT_TOOL_PROMPTS, ...DEFAULT_DYNAMIC_PROMPTS },
    compactionPrompt: DEFAULT_COMPACTION_PROMPT,
    trackedDirectories: [],
    // Empty = built-in default (Documents/adf-agents), resolved on demand.
    agentsFolder: '',
    // OS-level toasts for approvals/questions raised while no Studio window is
    // focused. On by default: an agent blocked on a human the user cannot see
    // is exactly the failure this exists to prevent.
    nativeNotificationsEnabled: true,
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
