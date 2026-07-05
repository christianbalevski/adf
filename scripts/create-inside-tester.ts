import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { AdfWorkspace } from '../src/main/adf/adf-workspace'

const filePath = 'C:/Users/Christian/Documents/Agent2/inside-tester.adf'
mkdirSync(dirname(filePath), { recursive: true })

const instructions = `You are inside-tester, a headless ADF test agent running on Instance 2.

Role:
- Act as an inside tester for the ADF runtime and agent workflows.
- Respond to test requests from Christian/aom.
- Keep reports concise and structured.
- Prefer isolated compute for coding/testing. Do not request or assume host access unless explicitly authorized.
- When doing command-line work, prefer rtk-prefixed commands when available for compact output.

Startup behavior:
- On startup, report that you are online if you receive a startup/chat prompt asking for status.
- Do not proactively message external parties except Christian/aom for assigned test reporting.

Security:
- Localhost visibility only.
- Minimal durable memory.
- Do not store credentials.
- Do not share private user details with peers.

Standard result format:
RESULT: <short status>
- What I tested:
- Evidence:
- Blockers:
- Next recommended action:`

const ws = AdfWorkspace.create(filePath, {
  name: 'inside-tester',
  handle: 'inside-tester',
  icon: '🧪',
  description: 'Headless localhost-only tester agent for ADF Instance 2.',
  instructions,
  autonomous: true,
  autostart: true,
  start_in_state: 'idle',
  model: { provider: 'custom:ap5ycc', model_id: 'gpt-5.4', temperature: 0.2, max_tokens: 4096 },
  messaging: { receive: true, mode: 'respond_only', visibility: 'localhost' },
  tools: [
    { name: 'fs_read', enabled: true, visible: true },
    { name: 'fs_write', enabled: true, visible: true },
    { name: 'fs_list', enabled: true, visible: true },
    { name: 'msg_send', enabled: true, visible: true },
    { name: 'msg_list', enabled: true, visible: true },
    { name: 'msg_read', enabled: true, visible: true },
    { name: 'msg_update', enabled: true, visible: true },
    { name: 'agent_discover', enabled: true, visible: true },
    { name: 'sys_get_config', enabled: true, visible: true },
    { name: 'sys_set_state', enabled: true, visible: true },
    { name: 'sys_get_meta', enabled: true, visible: true },
    { name: 'sys_set_meta', enabled: true, visible: true },
    { name: 'say', enabled: true, visible: true },
    { name: 'ask', enabled: true, visible: true },
    { name: 'sys_code', enabled: true, visible: false },
    { name: 'sys_lambda', enabled: true, visible: false },
    { name: 'db_query', enabled: true, visible: false },
    { name: 'db_execute', enabled: true, visible: false },
    { name: 'compute_exec', enabled: true, visible: true, restricted: true }
  ],
  code_execution: { enabled: true, allowed_modules: [], allowed_packages: [] },
  context: { audit: { loop: true, inbox: true, outbox: true, files: false } },
  limits: { execution_timeout_ms: 300000, max_active_turns: 1 },
  triggers: {
    on_inbox: { enabled: true, targets: [{ scope: 'agent', interval_ms: 30000 }] },
    on_chat: { enabled: true, targets: [{ scope: 'agent' }] },
    on_timer: { enabled: true, targets: [{ scope: 'system' }, { scope: 'agent' }] },
    on_startup: { enabled: false, targets: [] }
  }
})
const did = ws.generateIdentityKeys(null).did
ws.writeDocument(`# inside-tester\n\nHeadless localhost-only tester for ADF Instance 2.\n\n- Visibility: localhost\n- Role: runtime/workflow testing\n- Host access: not assumed\n- Maintainer/orchestrator: aom / Christian\n`)
ws.writeMind(`# inside-tester private state\n\nCreated as an ephemeral test harness agent for Instance 2. Keep memory minimal; report findings to aom/Christian.\n`)
ws.dispose()
console.log(JSON.stringify({ filePath, did }, null, 2))
