/**
 * Built-in Google OAuth client for the Gmail catalog server (see
 * shared/utils/gmail-oauth-client.ts). When the build embedded one and the
 * host has no client file yet, the registration test and host materialization
 * write it to ~/.gmail-mcp/gcp-oauth.keys.json (0600, write-if-absent). A
 * client file the user chose, or one already on the host, always wins; the
 * token file (~/.gmail-mcp/credentials.json) is never touched, and when it
 * already exists the client is not written either (those tokens may belong
 * to another client) — unless materialization knows the tokens are the
 * agent's own, sealed without a client. Agent write-back never stores the built-in client.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { basename, dirname, join } from 'path'
import { GMAIL_BUNDLED_CLIENT_NPM_PACKAGE, GMAIL_BUNDLED_CLIENT_PATH, GMAIL_BUNDLED_TOKEN_PATH } from '../../shared/utils/gmail-oauth-client'

// Defined by electron.vite.config.ts in the Studio main and daemon builds
// (undefined when the build had no client). Builds that do not define it at
// all (npm CLI, tests) read it as undefined via typeof.
declare const __ADF_GMAIL_OAUTH_CLIENT__: string | undefined

/** The client JSON compiled into this build, if any. */
export function compiledGmailOAuthClient(): string | undefined {
  return typeof __ADF_GMAIL_OAUTH_CLIENT__ === 'string' ? __ADF_GMAIL_OAUTH_CLIENT__ : undefined
}

/** Declared credential files this build can fill itself (MCP_REGISTRY_GET's `bundledCredentialFiles`). */
export function bundledCredentialFiles(client = compiledGmailOAuthClient()): { npmPackage: string; path: string }[] {
  return client ? [{ npmPackage: GMAIL_BUNDLED_CLIENT_NPM_PACKAGE, path: GMAIL_BUNDLED_CLIENT_PATH }] : []
}

/**
 * Whether the built-in client applies to this server and declared file:
 * exactly the Gmail catalog package and its client-file path.
 */
export function bundledClientApplies(npmPackage: string | undefined, path: string, client = compiledGmailOAuthClient()): boolean {
  return !!client && npmPackage === GMAIL_BUNDLED_CLIENT_NPM_PACKAGE && path === GMAIL_BUNDLED_CLIENT_PATH
}

/**
 * Whether `content` (a captured copy of `path`) is exactly the built-in
 * client this build would write. Write-back skips it: agents must not carry
 * the built-in client into containers or back over a host file later.
 */
export function isBundledClientContent(
  npmPackage: string | undefined,
  path: string,
  content: Buffer,
  client = compiledGmailOAuthClient(),
): boolean {
  return !!client && bundledClientApplies(npmPackage, path, client) && content.equals(Buffer.from(client))
}

/** Host path of the server's token file, given the host path of its client file. */
export function bundledTokenFileFor(dest: string): string {
  return join(dirname(dest), basename(GMAIL_BUNDLED_TOKEN_PATH))
}

/**
 * Whether materialization should keep the host's Gmail token file instead of
 * writing the agent's sealed one at `tokenDest`. With no client sealed beside
 * them, the agent's tokens were minted with the built-in client; next to a
 * different client file on the host they cannot refresh, and writing them
 * would also replace the host's own working sign-in. Kept, the server uses the
 * host's sign-in and write-back captures that pair for the agent.
 */
export function keepHostTokensOverSealed(
  npmPackage: string | undefined,
  path: string,
  tokenDest: string,
  clientSealed: () => boolean,
  client = compiledGmailOAuthClient(),
): boolean {
  if (npmPackage !== GMAIL_BUNDLED_CLIENT_NPM_PACKAGE || path !== GMAIL_BUNDLED_TOKEN_PATH) return false
  const clientDest = join(dirname(tokenDest), basename(GMAIL_BUNDLED_CLIENT_PATH))
  if (!existsSync(clientDest) || clientSealed()) return false
  return !client || !readFileSync(clientDest).equals(Buffer.from(client))
}

/**
 * Write the built-in client to `dest` (the host expansion of `path`) if it
 * applies, the file is absent and the server has no token file yet (tokens
 * minted by another client would not refresh with this one). Returns whether
 * it wrote.
 *
 * `ignoreTokenFile`: only for materialization when the token file is the
 * agent's own (sealed in its keystore with no sealed client beside it, so it
 * was minted with the built-in client).
 */
export function writeBundledClientIfAbsent(
  npmPackage: string | undefined,
  path: string,
  dest: string,
  client = compiledGmailOAuthClient(),
  opts: { ignoreTokenFile?: boolean } = {},
): boolean {
  if (!client || !bundledClientApplies(npmPackage, path, client)) return false
  if (existsSync(dest)) return false
  if (!opts.ignoreTokenFile && existsSync(bundledTokenFileFor(dest))) return false
  mkdirSync(dirname(dest), { recursive: true })
  // 'wx': never replace a file that appeared since the check.
  try {
    writeFileSync(dest, client, { mode: 0o600, flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  }
  return true
}
