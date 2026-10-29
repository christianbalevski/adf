import type { AdfApi } from '../preload/api'

type Save = AdfApi['recoveryStash']
type Stasher = (api: { recoveryStash: (entry: Parameters<Save>[0]) => Promise<unknown> }) => Promise<number>

/** The shared stasher keeps going after individual failures. Browser reloads
 * must surface any such failure before destroying the only remaining copy. */
export async function preserveBrowserEdits(stash: Stasher, save: Save): Promise<void> {
  let failure: unknown
  let failed = false
  await stash({ recoveryStash: async (entry) => {
    try {
      const result = await save(entry)
      if (!result.success) throw new Error('Recovery storage refused an edit.')
      return result
    } catch (cause) { failed = true; failure = cause; throw cause }
  } })
  if (failed) throw failure
}

/** Keep pending messages as a downloadable review copy, never as a new
 * session's send queue. Old tab records remain intact until this succeeds. */
export async function preserveBrowserQueues(
  entries: import('../shared/types/ipc.types').QueueHandoverEntry[],
  storage: Storage | null,
  scope: string,
  clientId: string,
  save: Save,
): Promise<void> {
  const all = [...entries]
  if (storage) {
    const prefix = `adf.web.session.${scope}.tab.`
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)
      if (!key?.startsWith(prefix)) continue
      const raw = storage.getItem(key)
      if (!raw) continue
      let row: { queue?: unknown }
      try { row = JSON.parse(raw) } catch { continue }
      if (Array.isArray(row?.queue)) all.push(...row.queue)
    }
  }
  const groups = new Map<string, import('../shared/types/ipc.types').QueueHandoverEntry[]>()
  const seen = new Set<string>()
  for (const entry of all) {
    if (!entry || typeof entry.filePath !== 'string' || typeof entry.loop !== 'string' || !Array.isArray(entry.messages)) continue
    const messages = entry.messages.filter(message => {
      if (!message || typeof message.text !== 'string') return false
      const key = JSON.stringify([entry.runtimeId, entry.filePath, entry.loop, message.id])
      if (seen.has(key)) return false
      seen.add(key); return true
    }).map(({ id, text, content, error, failures }) => ({ id, text, ...(content ? { content } : {}), ...(error ? { error } : {}), ...(failures ? { failures } : {}) }))
    if (!messages.length) continue
    const key = JSON.stringify([entry.runtimeId, entry.filePath])
    const rows = groups.get(key) ?? []
    rows.push({ ...entry, messages }); groups.set(key, rows)
  }
  for (const rows of groups.values()) {
    const result = await save({
      agentFilePath: rows[0].filePath,
      ...(rows[0].runtimeId ? { runtimeId: rows[0].runtimeId } : {}),
      path: 'queued-messages.json', kept: `browser-queue-${scope}-${clientId}`,
      content: JSON.stringify({ instructions: 'Review these pending messages before sending them manually. They were not replayed. Check the conversation first: an interrupted request may already have been accepted.', entries: rows }, null, 2),
    })
    if (!result.success) throw new Error('Recovery storage refused pending messages.')
  }
}
