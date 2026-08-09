import { findAdapterRegistryEntry } from '../../../shared/constants/adapter-registry'

/**
 * Append the adapter's setup-guide link to an error message.
 *
 * Adapter error strings flow verbatim into the agent's tool result — the
 * agent uses them to walk the user through a fix. Every actionable adapter
 * error should state what happened, the concrete fix, and end with the
 * guide link this helper appends.
 */
export function withSetupGuide(adapterType: string, message: string): string {
  const url = findAdapterRegistryEntry(adapterType)?.docsUrl
  return url ? `${message} Setup guide: ${url}` : message
}
