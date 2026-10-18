import { parityCases } from '../harness/parity-cases'
import { QUEUE_SCENARIOS } from './scenarios'

/**
 * Parity: a queued message across an agent switch (each loop's own turn end
 * in the background, the loop states a re-attach answers), a failed send,
 * and the context breakdown after a call (tracker W5-L).
 */
parityCases('queue and context', QUEUE_SCENARIOS)
