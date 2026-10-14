/**
 * Claude sign-in status as reported by the user's Claude Code install.
 * ADF holds no Claude credentials; see auth-manager.ts.
 */
export type ClaudeAuthStatus =
  | {
      authenticated: false
      /** Claude Code is not installed — sign-in is impossible until it is. */
      installed: false
      installUrl: string
    }
  | {
      authenticated: false
      installed: true
      version: string
      /** Oldest Claude Code this ADF runtime supports. */
      minVersion: string
      /** The installed Claude Code is older than `minVersion`. */
      updateRequired?: boolean
      flowPending?: boolean
      /** Sign-in URL to open manually when Claude Code could not open a browser. */
      flowUrl?: string
      flowError?: string
    }
  | {
      authenticated: true
      installed: true
      version: string
      minVersion: string
      /** A re-sign-in is running; the account below is the one signed in before it. */
      flowPending?: boolean
      flowUrl?: string
      /**
       * The last re-sign-in failed (cleared when a new one starts); the
       * account below is still the one signed in before it.
       */
      flowError?: string
      email?: string
      /** Claude plan, e.g. `pro`, `max`, `team`. */
      plan?: string
    }

export interface ClaudeAuthFlow {
  /** Sign-in URL (Claude Code also opens it in the browser itself). */
  url?: string
  completion: Promise<void>
}
