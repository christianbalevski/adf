import { createSubscriptionTokenStore } from '../subscription-token-store'
import type { TokenSet } from './types'

const store = createSubscriptionTokenStore<TokenSet>('chatgpt-subscription')

export function readTokens(): TokenSet | null {
  return store.readTokens()
}

export function writeTokens(tokens: TokenSet): void {
  store.writeTokens(tokens)
}

export function clearTokens(): void {
  store.clearTokens()
}
