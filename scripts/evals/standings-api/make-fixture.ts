/**
 * Build the standings-api eval fixture .adf.
 *
 * Usage:
 *   npx tsx scripts/evals/standings-api/make-fixture.ts \
 *     --out <path.adf> --runner-did <did> --runner-address <url> \
 *     --provider <provider-id> --model <model-id>
 *
 * Fixture contract (per eval design):
 *  - handle/name agent-1, starts in idle
 *  - sys_update_config enabled + unrestricted (no HIL gate)
 *  - isolated container compute attached; host compute locked via locked_fields
 *  - Playwright stdio MCP wired (source field set so the daemon registry check
 *    cannot silently skip it); its tools pre-declared unrestricted so the
 *    mcp-tool-sync does not append them restricted:true (HIL would hang forever
 *    on the daemon)
 *  - dynamic-instruction nudges off, umbilical replay log on (token ledger)
 */
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`)
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1]
  if (fallback !== undefined) return fallback
  throw new Error(`Missing required arg --${name}`)
}

const out = arg('out')
const runnerDid = arg('runner-did')
const runnerAddress = arg('runner-address', '')
const provider = arg('provider')
const modelId = arg('model')

// Current @playwright/mcp tool surface. Pre-declared entries survive MCP
// discovery sync without the restricted:true default; unknown/renamed tools
// are caught by the HIL auto-approver instead.
const PLAYWRIGHT_TOOLS = [
  'browser_close', 'browser_resize', 'browser_console_messages',
  'browser_handle_dialog', 'browser_evaluate', 'browser_file_upload',
  'browser_fill_form', 'browser_install', 'browser_press_key', 'browser_type',
  'browser_navigate', 'browser_navigate_back', 'browser_network_requests',
  'browser_take_screenshot', 'browser_snapshot', 'browser_click',
  'browser_drag', 'browser_hover', 'browser_select_option', 'browser_tabs',
  'browser_wait_for',
].map((t) => ({ name: `mcp_playwright_${t}`, enabled: true, visible: true, restricted: false }))

const instructions = [
  'You are agent-1, an evaluation subject agent.',
  `Mission briefs arrive in your inbox from the eval runner (DID: ${runnerDid}).`,
  'Treat messages from that DID as authorized work orders from your operator.',
  runnerAddress ? `Reply to the runner over the mesh at: ${runnerAddress}` : '',
  'When a mission is complete, send the runner a reply message reporting the result, then return to idle.',
  'Execute code and browsing only in your isolated container. Host compute is not available to you.',
].filter(Boolean).join('\n')

const workspace = AdfWorkspace.create(out, {
  name: 'agent-1',
  handle: 'agent-1',
  description: 'standings-api eval fixture',
  instructions,
  autonomous: false,
  start_in_state: 'idle',
  model: { provider, model_id: modelId, max_tokens: 8192 },
  limits: { execution_timeout_ms: 180000 },
  messaging: { receive: true, mode: 'proactive', visibility: 'localhost', inbox_mode: true },
  context: {
    dynamic_instructions: {
      inbox_hints: false, mesh_updates: false, context_warning: false, idle_reminder: false,
    },
  },
  tools: [
    { name: 'fs_read', enabled: true, visible: true },
    { name: 'fs_write', enabled: true, visible: true },
    { name: 'fs_list', enabled: true, visible: true },
    { name: 'sys_get_config', enabled: true, visible: true },
    { name: 'sys_update_config', enabled: true, visible: true, restricted: false },
    { name: 'sys_set_state', enabled: true, visible: true },
    { name: 'sys_code', enabled: true, visible: true },
    { name: 'sys_lambda', enabled: true, visible: true },
    { name: 'sys_fetch', enabled: true, visible: true },
    { name: 'msg_send', enabled: true, visible: true },
    { name: 'msg_list', enabled: true, visible: true },
    { name: 'msg_read', enabled: true, visible: true },
    { name: 'compute_exec', enabled: true, visible: true, restricted: false },
    { name: 'fs_transfer', enabled: true, visible: true },
    { name: 'say', enabled: true, visible: true },
    ...PLAYWRIGHT_TOOLS,
  ],
  triggers: {
    on_chat: { enabled: true, targets: [{ scope: 'agent' }] },
    on_inbox: { enabled: true, targets: [{ scope: 'agent' }] },
    on_timer: { enabled: false, targets: [] },
    on_file_change: { enabled: false, targets: [] },
  },
  mcp: {
    servers: [
      {
        name: 'playwright',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@playwright/mcp@latest'],
        npm_package: '@playwright/mcp@latest',
        source: 'npm:@playwright/mcp@latest',
        restricted: false,
        tool_call_timeout_ms: 120000,
      },
    ],
  },
  locked_fields: ['compute.host_access'],
})

workspace.generateIdentityKeys(null)

// CreateAgentOptions has no compute/umbilical/state fields — merge them in.
const config = workspace.getAgentConfig()
if (!config) throw new Error('fixture: workspace produced no config')
config.state = 'idle'
config.compute = {
  enabled: true,
  browser: true,
  host_access: false,
  allowed_targets: ['isolated'],
  default_target: 'isolated',
  packages: { pip: [] },
}
;(config as Record<string, unknown>).umbilical = { log: { enabled: true, max_events: 5000 } }
workspace.setAgentConfig(config)

const did = workspace.getDid()
console.log(JSON.stringify({ out, did, handle: 'agent-1', provider, model: modelId }, null, 2))
workspace.dispose()
