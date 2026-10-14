import { parityCases } from '../harness/parity-cases'
import { SETTINGS_EMBEDDED_ONLY, SETTINGS_SCENARIOS } from './scenarios'

/**
 * Parity: settings, providers and subscription sign-in (tracker W3-B).
 * Provider add/edit with redacted keys round-trips: the daemon side reads
 * `__redacted__` and writes it back, and the persisted keys equal embedded's.
 */
parityCases('settings', SETTINGS_SCENARIOS, SETTINGS_EMBEDDED_ONLY)
