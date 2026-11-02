/**
 * Built-in Google OAuth client for the Gmail catalog server (see
 * shared/utils/gmail-oauth-client.ts). When the build embedded one and the
 * host has no client file yet, the registration test and host materialization
 * write it to ~/.gmail-mcp/gcp-oauth.keys.json (0600, write-if-absent). A
 * client file the user chose, or one already on the host, always wins; the
 * token file (~/.gmail-mcp/credentials.json) is never touched, and when it
 * already exists the client is not written either (those tokens may belong
 * to another client). Agent write-back never stores the built-in client.
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs'
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
 * Write the built-in client to `dest` (the host expansion of `path`) if it
 * applies, the file is absent and the server has no token file yet (tokens
 * minted by another client would not refresh with this one). Returns whether
 * it wrote.
 */
export function writeBundledClientIfAbsent(
  npmPackage: string | undefined,
  path: string,
  dest: string,
  client = compiledGmailOAuthClient(),
): boolean {
  if (!client || !bundledClientApplies(npmPackage, path, client)) return false
  if (existsSync(dest) || existsSync(bundledTokenFileFor(dest))) return false
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
