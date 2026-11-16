import { parityCases } from '../harness/parity-cases'
import { FILE_BATCH_SCENARIOS } from './scenarios'

/** Parity: one atomic multi-file write (the skill install path), the same in both backends. */
parityCases('file-batch', FILE_BATCH_SCENARIOS)
