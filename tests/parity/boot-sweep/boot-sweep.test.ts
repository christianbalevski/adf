import { parityCases, remoteParityCases } from '../harness/parity-cases'
import { bootEnvelopeSweepScenario } from './scenarios'

/**
 * Parity: the boot envelope sweep (W5-G). Embedded Studio and the daemon
 * provision the same agents and skip the same ones; local and remote daemon
 * mode are compared with embedded.
 */
parityCases('boot-sweep', [bootEnvelopeSweepScenario])
remoteParityCases('boot-sweep', [bootEnvelopeSweepScenario])
