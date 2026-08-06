export interface TokenSet {
  access_token: string
  refresh_token: string
  expires_at: number      // ms since epoch
  account_id: string      // JWT 'sub' claim
}

export type AuthStatus =
  | { authenticated: false; flowPending?: boolean; flowError?: string }
  | { authenticated: true; email?: string; expiresAt: number }

/** RFC 8628 device authorization response from auth.x.ai. */
export interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  expires_in?: number
  interval?: number
}
