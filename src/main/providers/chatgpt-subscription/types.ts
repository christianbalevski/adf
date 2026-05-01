export interface TokenSet {
  access_token: string
  refresh_token: string
  expires_at: number      // ms since epoch
  account_id: string      // JWT 'sub' claim
}

export type AuthStatus =
  | { authenticated: false }
  | { authenticated: true; email?: string; expiresAt: number }
