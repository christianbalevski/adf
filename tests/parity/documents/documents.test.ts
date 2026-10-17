import { parityCases } from '../harness/parity-cases'
import { DOCUMENT_SCENARIOS } from './scenarios'

/**
 * Parity: files, documents, agent runtime, review and templates (tracker
 * W3-A). Studio holds every open file as a document of its client session
 * (W2-B, W2-C2), so the daemon side reads files whether their agent runs or not.
 */
parityCases('documents', DOCUMENT_SCENARIOS)
