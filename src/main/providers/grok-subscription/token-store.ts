import { createSubscriptionTokenStore } from '../subscription-token-store'
import type { TokenSet } from './types'

const store = createSubscriptionTokenStore<TokenSet>('grok-subscription')

export function readTokens(): TokenSet | null {
  return store.readTokens()
}

export function writeTokens(tokens: TokenSet): void {
  store.writeTokens(tokens)
}

export function clearTokens(): void {
  store.clearTokens()
}

/** A sign-in to `accountId` succeeded: drop the session set aside for it (auth.replaced.json). */
export function noteSignIn(accountId: string | undefined): void {
  store.signedIn(accountId)
}
