import { parityCases } from '../harness/parity-cases'
import { CONFLICT_SCENARIOS } from './scenarios'

/**
 * Parity: multi-client write conflicts (tracker W3-F). The same refusal and
 * the same Keep-mine save in both backends.
 */
parityCases('conflicts', CONFLICT_SCENARIOS)
