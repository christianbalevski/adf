import { parityCases } from '../harness/parity-cases'
import { INTERRUPT_SCENARIOS } from './scenarios'

/**
 * Parity: the composer's Stop (the turn interrupt) answers and pushes the
 * same in embedded and daemon mode.
 */
parityCases('turn interrupt', INTERRUPT_SCENARIOS)
