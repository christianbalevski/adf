import { nanoid } from 'nanoid'
import { parseAuthorizeToken } from '../../shared/utils/agent-commands'
import { useAgentStore, selectLoopSlice } from '../stores/agent.store'
import { useDocumentStore } from '../stores/document.store'
import type { AdfApi } from '../../preload/api'

/** Composer submission, shared by every loop; result events settle the local card. */
export async function submitOwnerCommand({ filePath, loop, name, args, run, say }: {
  filePath?: string; loop: string; name: string; args: string
  run: AdfApi['runAgentCommand']; say: (text: string) => void
}) {
  const parsed = parseAuthorizeToken(args)
  const requestId = nanoid()
  const store = useAgentStore.getState()
  const document = useDocumentStore.getState()
  let stillCurrent = true
  const unsubscribe = useDocumentStore.subscribe((next) => {
    if (next.filePath !== document.filePath || next.runtimeId !== document.runtimeId) stillCurrent = false
  })
  store.addLogEntry({ id: nanoid(), type: 'context', content: '', timestamp: Date.now(), metadata: {
    category: 'owner_command', ownerCommand: { id: requestId, command: '/' + name + (parsed.args ? ' ' + parsed.args : ''), authorized: parsed.authorize, status: 'running' }
  } }, loop)
  try {
    const res = await run({ filePath, loop, name, args: parsed.args, authorize: parsed.authorize, requestId })
    if (!stillCurrent) return
    if (!res?.success) {
      store.removePendingOwnerCommand(requestId, loop)
      say('/' + name + ' — ' + (res?.error ?? 'Command could not be run.'))
    } else if (res.deferred || res.seq === undefined) {
      const slice = selectLoopSlice(useAgentStore.getState(), loop)
      const index = slice.log.findIndex((entry) => typeof entry.metadata?.seq !== 'number' && (entry.metadata?.ownerCommand as { id?: string } | undefined)?.id === requestId)
      if (index >= 0) store.updateEntryAt(index, (entry) => {
        entry.content = res.result
        entry.metadata = { ...entry.metadata, deferred: res.deferred, unrecorded: !res.deferred, ownerCommand: { ...(entry.metadata?.ownerCommand as object), status: res.status, authorized: res.authorized } }
      }, loop)
    }
  } catch (error) {
    if (!stillCurrent) return
    store.removePendingOwnerCommand(requestId, loop)
    say('/' + name + ' — ' + (error instanceof Error ? error.message : String(error)))
  } finally {
    unsubscribe()
  }
}
