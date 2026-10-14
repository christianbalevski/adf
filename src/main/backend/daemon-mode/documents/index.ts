import type { DaemonHandlerTable, DaemonSendHandlerTable } from '../context'

/**
 * W3-A's daemon-mode handlers (tracker W3-A): files, documents, agent
 * runtime, review, templates, tracked and bulk directories, identity drafts.
 * Results have the embedded handlers' shapes (src/main/ipc/index.ts), error
 * answers included.
 */
export const DOCUMENT_HANDLERS: DaemonHandlerTable = {
}

export const DOCUMENT_SEND_HANDLERS: DaemonSendHandlerTable = {
}
