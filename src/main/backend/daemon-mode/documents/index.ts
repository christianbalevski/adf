import type { DaemonHandlerTable, DaemonSendHandlerTable } from '../context'
import { AGENT_HANDLERS } from './agent-handlers'
import { DOC_HANDLERS } from './doc-handlers'
import { FILE_HANDLERS, FILE_SEND_HANDLERS } from './file-handlers'
import { TEMPLATE_HANDLERS } from './template-handlers'

/**
 * W3-A's daemon-mode handlers (tracker W3-A): files, documents, agent
 * runtime, review, templates, tracked and bulk directories, identity drafts.
 * Results have the embedded handlers' shapes (src/main/ipc/index.ts), error
 * answers included.
 */
export const DOCUMENT_HANDLERS: DaemonHandlerTable = {
  ...FILE_HANDLERS,
  ...DOC_HANDLERS,
  ...AGENT_HANDLERS,
  ...TEMPLATE_HANDLERS,
}

export const DOCUMENT_SEND_HANDLERS: DaemonSendHandlerTable = {
  ...FILE_SEND_HANDLERS,
}
