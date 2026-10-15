import { parityCases } from '../harness/parity-cases'
import { WRITE_SOURCE_SCENARIOS } from './scenarios'

/** Parity: the origin of Studio's own writes, as a source-filtered trigger sees it (W5-D2). */
parityCases('write-source', WRITE_SOURCE_SCENARIOS)
