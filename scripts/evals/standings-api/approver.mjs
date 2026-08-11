/**
 * HIL auto-responder for eval runs. The daemon blocks a restricted tool call
 * forever if no approval arrives, so every eval run needs this loop alive.
 *
 * Approves every pending/pending_approval task and answers every ask with a
 * neutral "proceed" — the eval measures the agent, not the approver.
 *
 * Usage: node scripts/evals/standings-api/approver.mjs --agent <agentId> [--daemon http://127.0.0.1:7385]
 */

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1]
  if (fallback !== undefined) return fallback
  throw new Error(`Missing --${name}`)
}

const agentId = arg('agent')
const daemon = arg('daemon', 'http://127.0.0.1:7385')
const POLL_MS = 2000

async function getJson(path) {
  const res = await fetch(`${daemon}${path}`)
  if (!res.ok) throw new Error(`${path} -> ${res.status}`)
  return res.json()
}

async function postJson(path, body) {
  const res = await fetch(`${daemon}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.text() }
}

async function tick() {
  const tasks = await getJson(`/agents/${agentId}/tasks?status=pending_approval`)
  const list = Array.isArray(tasks) ? tasks : tasks.tasks ?? []
  for (const entry of list) {
    const task = entry.task ?? entry
    const id = task.id ?? task.task_id
    if (!id) continue
    const r = await postJson(`/agents/${agentId}/tasks/${id}/resolve`, {
      action: 'approve',
      reason: 'eval auto-approver',
    })
    console.log(`[approver] task ${id} (${task.tool_name ?? task.name ?? '?'}) -> approve (${r.status})`)
  }

  const asks = await getJson(`/agents/${agentId}/asks`)
  const askList = Array.isArray(asks) ? asks : asks.asks ?? []
  for (const ask of askList) {
    const id = ask.requestId ?? ask.request_id ?? ask.id
    if (!id) continue
    const r = await postJson(`/agents/${agentId}/asks/${id}/respond`, {
      answer: 'Proceed as you see fit. Do not wait for further input.',
    })
    console.log(`[approver] ask ${id} -> answered (${r.status})`)
  }
}

console.log(`[approver] watching ${daemon} agent=${agentId} every ${POLL_MS}ms`)
// eslint-disable-next-line no-constant-condition
while (true) {
  try {
    await tick()
  } catch (err) {
    console.error(`[approver] ${err.message}`)
  }
  await new Promise((r) => setTimeout(r, POLL_MS))
}
