import { parityCases } from '../harness/parity-cases'
import { IDENTITY_SCENARIOS } from './scenarios'

/**
 * Parity: owner identity and an agent's keystore (tracker W3-B). The seed
 * phrase is revealed from the shared keychain entry in daemon mode (§5.4);
 * stored values reach the Identity panel through the daemon's local-only
 * reveal route.
 */
parityCases('identity', IDENTITY_SCENARIOS)
